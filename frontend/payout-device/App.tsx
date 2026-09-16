/**
 * BitriPay payout device & SMS forwarder.
 *
 * One phone + one merchant SIM = one payout device. The app
 *   1. enrols once (agent signs in, picks the payout account it operates, the device generates an Ed25519 key in the secure store
 *      and registers its public key + SIM identity) – the agent token is discarded afterwards;
 *   2. polls its queue with device-signed requests, claims a payout and dials the operator USSD menu;
 *   3. signs every operator confirmation SMS the instant it arrives and forwards it as evidence – settlement happens only when
 *      the server verifies reference, amount, currency, recipient, SIM and timing.
 * The private key never leaves the device; the app never decides that money has arrived.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, Vibration, View, useColorScheme } from 'react-native';
import { Audio } from 'expo-av';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import * as LocalAuthentication from 'expo-local-authentication';
import QRCode from 'react-native-qrcode-svg';
import { agentCall, deviceCall, ApiError } from './src/api';
import { createKeys } from './src/crypto';
import { appendLog, loadEnrolment, loadLog, loadPending, loadSmsSender, saveEnrolment, savePending, saveSmsSender, secure, type Enrolment, type LogEntry, type PendingEvidence } from './src/store';
import { flushPending, forwardSms, matchesFilters, type IncomingSms } from './src/forwarder';
import * as Sms from './modules/sms-receiver/src';

// ---------- types mirrored from the API ----------
interface PayoutAccount {
  id: string;
  label: string;
  rail: string;
  operatorId: string | null;
  operatorName: string | null;
  country: string;
  currency: string;
  msisdn: string | null;
  simIccid: string | null;
  deviceId: string | null;
  status: string;
}
interface Payout {
  id: string;
  reference: string;
  stage: string;
  amount: number;
  currency: string;
  recipientMsisdn: string | null;
  recipientMasked: string | null;
  recipientName: string | null;
  operatorId: string | null;
  operatorName: string | null;
  claimedByDeviceId: string | null;
  expiresAt: string | null;
  error: string | null;
  instructions: { ussd: string | null; steps: string[] } | null;
  riskFlags: string[];
}

const DEFAULT_API = process.env.EXPO_PUBLIC_API_URL || (Constants.expoConfig?.extra as any)?.apiUrl || 'http://10.0.2.2:4000';
const POLL_MS = 10_000;

/** Very loud alarm + long vibration when a new payout instruction lands on this device (operators must not miss one). */
let alarm: Audio.Sound | null = null;
async function ringLoud() {
  try {
    Vibration.vibrate([0, 600, 150, 600, 150, 900, 300, 600, 150, 600], false);
  } catch {
    /* no vibration */
  }
  try {
    if (!alarm) {
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, shouldDuckAndroid: false });
      alarm = (await Audio.Sound.createAsync(require('./assets/loud_alert.wav'), { volume: 1 })).sound;
    }
    await alarm.setPositionAsync(0);
    await alarm.playAsync();
  } catch {
    /* no audio */
  }
}

const fmt = (minor: number, currency: string) => `${(minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

// ---------- theme ----------
function useTheme() {
  const dark = useColorScheme() === 'dark';
  return useMemo(
    () => ({
      dark,
      bg: dark ? '#0b1220' : '#f3f5f9',
      card: dark ? '#141d2e' : '#ffffff',
      text: dark ? '#e6ebf5' : '#0f172a',
      muted: dark ? '#8b96ad' : '#5b6478',
      line: dark ? '#22304a' : '#e2e6ee',
      primary: '#2563eb',
      ok: '#16a34a',
      warn: '#d97706',
      danger: '#dc2626',
      chip: dark ? '#1f2a40' : '#eef2ff',
    }),
    [dark],
  );
}
type Theme = ReturnType<typeof useTheme>;

function Button({ title, onPress, kind = 'primary', disabled, t }: { title: string; onPress: () => void; kind?: 'primary' | 'ghost' | 'danger' | 'ok'; disabled?: boolean; t: Theme }) {
  const bg = kind === 'primary' ? t.primary : kind === 'danger' ? t.danger : kind === 'ok' ? t.ok : 'transparent';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, borderColor: kind === 'ghost' ? t.line : bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }]}
    >
      <Text style={[s.btnText, { color: kind === 'ghost' ? t.text : '#fff' }]}>{title}</Text>
    </Pressable>
  );
}
function Field({ label, t, ...props }: { label: string; t: Theme } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={[s.label, { color: t.muted }]}>{label}</Text>
      <TextInput placeholderTextColor={t.muted} {...props} style={[s.input, { color: t.text, borderColor: t.line, backgroundColor: t.card }]} />
    </View>
  );
}
function Card({ children, t, style }: { children: React.ReactNode; t: Theme; style?: object }) {
  return <View style={[s.card, { backgroundColor: t.card, borderColor: t.line }, style]}>{children}</View>;
}
function Chip({ text, color, t }: { text: string; color?: string; t: Theme }) {
  return (
    <View style={[s.chip, { backgroundColor: t.chip }]}>
      <Text style={{ color: color ?? t.text, fontSize: 12, fontWeight: '600' }}>{text}</Text>
    </View>
  );
}
const stageColor = (stage: string, t: Theme) =>
  stage === 'SETTLED'
    ? t.ok
    : ['FAILED', 'MISMATCHED', 'DUPLICATE', 'EXPIRED', 'CANCELLED'].includes(stage)
      ? t.danger
      : ['IN_PROGRESS', 'VERIFYING', 'EVIDENCE_RECEIVED'].includes(stage)
        ? t.warn
        : t.primary;

// =====================================================================================
// Setup + enrolment
// =====================================================================================
function Enrol({ t, onDone }: { t: Theme; onDone: (e: Enrolment) => void }) {
  const [apiUrl, setApiUrl] = useState(DEFAULT_API);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [accounts, setAccounts] = useState<PayoutAccount[]>([]);
  const [kind, setKind] = useState<'payout' | 'collection'>('payout');
  const [accountId, setAccountId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [msisdn, setMsisdn] = useState('');
  const [iccid, setIccid] = useState('');
  const [operatorIds, setOperatorIds] = useState('');
  const [filters, setFilters] = useState('');
  const [sims, setSims] = useState<Sms.SimInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = apiUrl.trim().replace(/\/+$/, '');

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const r: any = needsCode
        ? await agentCall(base, token!, 'POST', '/api/auth/2fa/verify', { code })
        : await agentCall(base, '', 'POST', '/api/auth/login', { identifier: identifier.trim(), password });
      if (r.requiresTwoFactor) {
        setToken(r.token);
        setNeedsCode(true);
        return;
      }
      if (!['agent', 'admin'].includes(r.user?.role)) throw new Error('Only agents (or administrators) can enrol a payout device');
      setToken(r.token);
      setNeedsCode(false);
      const list: any = await agentCall(base, r.token, 'GET', '/api/payouts/agent/accounts');
      setAccounts(list.items ?? []);
      setName(`${r.user.name ?? 'Agent'} – ${Platform.OS} payout device`);
      await Sms.requestPermissions();
      const info = Sms.getSimInfo();
      setSims(info);
      if (info[0]?.msisdn) setMsisdn(info[0].msisdn);
      if (info[0]?.iccid) setIccid(info[0].iccid);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chosen = accounts.find((a) => a.id === accountId) ?? null;
  useEffect(() => {
    if (chosen) {
      if (chosen.msisdn && !msisdn) setMsisdn(chosen.msisdn);
      if (chosen.simIccid && !iccid) setIccid(chosen.simIccid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const enrol = async () => {
    setError(null);
    if (kind === 'payout' && !chosen) return setError('Choose the payout account this phone and SIM operate');
    if (kind === 'payout' && !msisdn.trim() && !iccid.trim()) return setError('Enter the SIM number (MSISDN) or ICCID – the server only accepts confirmations from the registered SIM');
    if (chosen && chosen.msisdn && msisdn.trim() && chosen.msisdn.replace(/\D/g, '') !== msisdn.replace(/\D/g, ''))
      return setError(`The SIM in this phone (${msisdn}) is not the SIM of ${chosen.label} (${chosen.msisdn})`);
    setBusy(true);
    try {
      const keys = createKeys();
      const ops =
        kind === 'payout'
          ? chosen?.operatorId
            ? [chosen.operatorId]
            : []
          : operatorIds
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean);
      const r: any = await agentCall(base, token!, 'POST', '/api/evidence/devices', {
        name: name.trim() || 'Payout device',
        publicKey: keys.publicKeyPem,
        operatorIds: ops,
        kind,
        simMsisdn: msisdn.trim() || null,
        simIccid: iccid.trim() || null,
        payoutAccountId: kind === 'payout' ? chosen!.id : null,
      });
      await secure.setPrivateKey(keys.privateKeyHex);
      const e: Enrolment = {
        apiUrl: base,
        deviceId: r.device.id,
        deviceName: r.device.name,
        kind,
        payoutAccountId: chosen?.id ?? null,
        payoutAccountLabel: chosen ? `${chosen.label} · ${chosen.operatorName ?? chosen.rail} ${chosen.currency}` : null,
        operatorId: chosen?.operatorId ?? ops[0] ?? null,
        simMsisdn: msisdn.trim() || null,
        simIccid: iccid.trim() || null,
        senderFilters: filters
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        enrolledAt: new Date().toISOString(),
      };
      await saveEnrolment(e);
      await appendLog({ level: 'ok', text: `Enrolled as ${e.deviceName} (${e.deviceId.slice(0, 8)}…) on ${e.apiUrl}` });
      setToken(null); // the agent session is not needed any more – the device key authenticates from here on
      onDone(e);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
      <Text style={[s.h1, { color: t.text }]}>Enrol this device</Text>
      <Text style={{ color: t.muted, marginBottom: 16 }}>
        Sign in as the agent who operates the payout SIM. The sign-in is used once to register this phone's key; afterwards the phone authenticates with its own key only.
      </Text>
      {!token || needsCode ? (
        <Card t={t}>
          <Field t={t} label="API URL" value={apiUrl} onChangeText={setApiUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
          {!needsCode ? (
            <>
              <Field t={t} label="Agent email or phone" value={identifier} onChangeText={setIdentifier} autoCapitalize="none" autoCorrect={false} />
              <Field t={t} label="Password" value={password} onChangeText={setPassword} secureTextEntry />
            </>
          ) : (
            <Field t={t} label="Two-factor code" value={code} onChangeText={setCode} keyboardType="number-pad" />
          )}
          {error && <Text style={{ color: t.danger, marginBottom: 8 }}>{error}</Text>}
          <Button t={t} title={busy ? 'Signing in…' : needsCode ? 'Verify code' : 'Sign in'} onPress={signIn} disabled={busy} />
        </Card>
      ) : (
        <Card t={t}>
          <Text style={[s.label, { color: t.muted }]}>Device role</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
            <Button t={t} title="Payout device" kind={kind === 'payout' ? 'primary' : 'ghost'} onPress={() => setKind('payout')} />
            <Button t={t} title="SMS collector" kind={kind === 'collection' ? 'primary' : 'ghost'} onPress={() => setKind('collection')} />
          </View>
          {kind === 'payout' ? (
            <>
              <Text style={[s.label, { color: t.muted }]}>Payout account (the SIM in this phone)</Text>
              {accounts.length === 0 && (
                <Text style={{ color: t.warn, marginBottom: 8 }}>No payout accounts are assigned to you. An administrator must create a prefunded payout account with you as its agent first.</Text>
              )}
              {accounts.map((a) => (
                <Pressable key={a.id} onPress={() => setAccountId(a.id)} style={[s.option, { borderColor: accountId === a.id ? t.primary : t.line }]}>
                  <Text style={{ color: t.text, fontWeight: '600' }}>{a.label}</Text>
                  <Text style={{ color: t.muted, fontSize: 12 }}>
                    {a.operatorName ?? a.rail} · {a.currency} · SIM {a.msisdn ?? a.simIccid ?? '—'}
                    {a.deviceId ? ' · already has a device (this will replace it)' : ''}
                    {a.status !== 'active' ? ` · ${a.status}` : ''}
                  </Text>
                </Pressable>
              ))}
            </>
          ) : (
            <Field t={t} label="Operator ids this SIM receives confirmations from (comma-separated, e.g. mpesa_ke)" value={operatorIds} onChangeText={setOperatorIds} autoCapitalize="none" />
          )}
          <Field t={t} label="Device name" value={name} onChangeText={setName} />
          {sims.length > 0 && (
            <View style={{ marginBottom: 12 }}>
              <Text style={[s.label, { color: t.muted }]}>SIMs detected</Text>
              {sims.map((si) => (
                <Pressable
                  key={si.subscriptionId}
                  onPress={() => {
                    if (si.msisdn) setMsisdn(si.msisdn);
                    if (si.iccid) setIccid(si.iccid);
                  }}
                  style={[s.option, { borderColor: t.line }]}
                >
                  <Text style={{ color: t.text }}>
                    Slot {si.simSlot + 1} · {si.carrier ?? si.displayName ?? 'SIM'}
                  </Text>
                  <Text style={{ color: t.muted, fontSize: 12 }}>
                    {si.msisdn ?? 'number not readable'} · {si.iccid ?? 'ICCID not readable'}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          <Field t={t} label="SIM number (MSISDN, international format)" value={msisdn} onChangeText={setMsisdn} keyboardType="phone-pad" placeholder="+243…" />
          <Field t={t} label="SIM ICCID (optional)" value={iccid} onChangeText={setIccid} keyboardType="number-pad" />
          <Field t={t} label="Only forward SMS from these senders (comma-separated; empty = all)" value={filters} onChangeText={setFilters} autoCapitalize="none" placeholder="OrangeMoney, MPESA" />
          {!Sms.isNativeAvailable() && (
            <Text style={{ color: t.warn, marginBottom: 8 }}>
              Native SMS receiver not available in this build (Expo Go / iOS). Build the Android app with `expo run:android` for automatic forwarding.
            </Text>
          )}
          {error && <Text style={{ color: t.danger, marginBottom: 8 }}>{error}</Text>}
          <Button t={t} title={busy ? 'Generating key & registering…' : 'Generate key and enrol'} onPress={enrol} disabled={busy} />
        </Card>
      )}
    </ScrollView>
  );
}

// =====================================================================================
// Device home: queue, active payout, SMS forwarding
// =====================================================================================
function Home({ t, enrolment, privateKey, onUnenrol }: { t: Theme; enrolment: Enrolment; privateKey: string; onUnenrol: () => void }) {
  const [tab, setTab] = useState<'queue' | 'log' | 'device'>('queue');
  const [queue, setQueue] = useState<Payout[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState<PendingEvidence[]>([]);
  const [lastSms, setLastSms] = useState<string | null>(null);
  const [manualFrom, setManualFrom] = useState('');
  const [manualText, setManualText] = useState('');
  const [permissions, setPermissions] = useState(Sms.hasPermissions());
  const [smsSender, setSmsSender] = useState(false);
  const smsSenderRef = useRef(false);
  useEffect(() => {
    loadSmsSender().then((on) => {
      setSmsSender(on);
      smsSenderRef.current = on;
    });
  }, []);
  // Outbound SMS from this SIM: take the queued messages, send each, report the outcome (the server retries failures).
  const drainOutbox = useCallback(async () => {
    if (!smsSenderRef.current) return;
    try {
      const r: any = await deviceCall(enrolment.apiUrl, privateKey, enrolment.deviceId, 'GET', '/api/payouts/device/sms-outbox?limit=10');
      for (const m of r.items ?? []) {
        let ok = false;
        let error: string | null = null;
        try {
          ok = Sms.sendSms(m.to, m.body, -1);
        } catch (err) {
          error = (err as Error).message;
        }
        await deviceCall(enrolment.apiUrl, privateKey, enrolment.deviceId, 'POST', `/api/payouts/device/sms-outbox/${m.id}`, { ok, error });
        await appendLog({ level: ok ? 'info' : 'warn', text: ok ? `Sent SMS to ${m.to}` : `Could not send SMS to ${m.to}: ${error}` });
      }
    } catch (err) {
      await appendLog({ level: 'warn', text: `SMS outbox: ${(err as Error).message}` });
    }
  }, [enrolment, privateKey]);
  const activeRef = useRef<string | null>(null);
  const knownRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);

  const active = queue.find((p) => p.stage === 'IN_PROGRESS' && p.claimedByDeviceId === enrolment.deviceId) ?? null;
  activeRef.current = active?.id ?? null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r: any = await deviceCall(enrolment.apiUrl, privateKey, enrolment.deviceId, 'GET', '/api/payouts/device/queue');
      const items: Payout[] = r.items ?? [];
      // Alarm for every payout we have not seen yet (first load only primes the set).
      const fresh = items.filter((p) => p.stage === 'QUEUED' && !knownRef.current.has(p.id));
      items.forEach((p) => knownRef.current.add(p.id));
      if (primedRef.current && fresh.length) {
        void ringLoud();
        await appendLog({ level: 'info', text: `${fresh.length} new payout instruction(s) queued` });
      }
      primedRef.current = true;
      setQueue(items);
      setError(null);
    } catch (err) {
      const e = err as ApiError;
      setError(e.code === 'device_revoked' ? 'This device has been revoked by an administrator. Re-enrol to continue.' : e.message);
    } finally {
      setLoading(false);
    }
    setLog(await loadLog());
    setPending(await loadPending());
  }, [enrolment, privateKey]);

  // SMS → signed evidence, immediately.
  const handleSms = useCallback(
    async (sms: Sms.ReceivedSms | IncomingSms) => {
      if (!matchesFilters(sms.from, enrolment.senderFilters)) {
        await appendLog({ level: 'info', text: `Ignored SMS from ${sms.from} (not an operator sender)` });
        setLog(await loadLog());
        return;
      }
      setLastSms(`${sms.from}: ${sms.text.slice(0, 80)}`);
      await forwardSms({ enrolment, privateKeyHex: privateKey, activePayoutId: activeRef.current }, { id: sms.id, from: sms.from, text: sms.text, receivedAt: sms.receivedAt });
      Sms.acknowledge([sms.id]);
      await refresh();
    },
    [enrolment, privateKey, refresh],
  );

  useEffect(() => {
    Sms.requestPermissions().then((ok) => setPermissions(ok || Sms.hasPermissions()));
    refresh();
    // Messages received while the app was closed are still in the native store.
    (async () => {
      for (const m of Sms.drainPending()) await handleSms(m);
    })();
    const off = Sms.onSms((m) => {
      handleSms(m);
    });
    const timer = setInterval(async () => {
      if (AppState.currentState !== 'active') return;
      await refresh();
      await drainOutbox();
      const f = await flushPending(enrolment.apiUrl);
      if (f.delivered) setPending(await loadPending());
    }, POLL_MS);
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        refresh();
        setPermissions(Sms.hasPermissions());
      }
    });
    return () => {
      off();
      clearInterval(timer);
      sub.remove();
    };
  }, [refresh, handleSms, enrolment.apiUrl]);

  const claim = async (p: Payout) => {
    try {
      await deviceCall(enrolment.apiUrl, privateKey, enrolment.deviceId, 'POST', `/api/payouts/device/${p.id}/claim`);
      await appendLog({ level: 'info', text: `Claimed payout ${p.reference} – ${fmt(p.amount, p.currency)} to ${p.recipientMasked}` });
      await refresh();
    } catch (err) {
      Alert.alert('Could not claim', (err as Error).message);
    }
  };
  const release = (p: Payout) => {
    Alert.alert('Return to queue', 'Give this payout back to the queue? Do this only if the operator transfer did NOT go through.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Return',
        style: 'destructive',
        onPress: async () => {
          try {
            await deviceCall(enrolment.apiUrl, privateKey, enrolment.deviceId, 'POST', `/api/payouts/device/${p.id}/release`, {
              reason: 'Released from payout device: operator transfer not completed',
            });
            await appendLog({ level: 'warn', text: `Released payout ${p.reference} back to the queue` });
            await refresh();
          } catch (err) {
            Alert.alert('Could not release', (err as Error).message);
          }
        },
      },
    ]);
  };
  const dial = async (p: Payout) => {
    const ussd = p.instructions?.ussd;
    if (!ussd) return Alert.alert('No USSD code', 'Open the operator app / menu on the payout SIM and follow the steps.');
    const url = `tel:${encodeURIComponent(ussd)}`;
    if (!(await Linking.canOpenURL(url))) return Alert.alert('Cannot dial', `Dial ${ussd} manually on the payout SIM.`);
    await Linking.openURL(url);
  };
  const submitManual = async () => {
    if (!manualFrom.trim() || manualText.trim().length < 5) return;
    await handleSms({ id: `manual-${Date.now()}`, from: manualFrom.trim(), text: manualText.trim(), receivedAt: Date.now() });
    setManualText('');
  };

  const unenrol = () =>
    Alert.alert('Remove enrolment', 'This deletes the device key from this phone. Ask an administrator to revoke the device on the server too.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await secure.clearPrivateKey();
          await saveEnrolment(null);
          await savePending([]);
          onUnenrol();
        },
      },
    ]);

  const renderPayout = ({ item: p }: { item: Payout }) => {
    const mine = p.claimedByDeviceId === enrolment.deviceId;
    return (
      <Card t={t} style={{ marginBottom: 10 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: t.text, fontWeight: '700', fontSize: 18 }}>{fmt(p.amount, p.currency)}</Text>
          <Chip t={t} text={p.stage.replace(/_/g, ' ')} color={stageColor(p.stage, t)} />
        </View>
        <Text style={{ color: t.muted, marginTop: 4 }}>
          {p.operatorName ?? p.operatorId} · ref {p.reference}
        </Text>
        <Text style={{ color: t.text, marginTop: 4 }}>
          To {mine && p.recipientMsisdn ? p.recipientMsisdn : p.recipientMasked}
          {p.recipientName ? ` (${p.recipientName})` : ''}
        </Text>
        {p.riskFlags?.length > 0 && <Text style={{ color: t.warn, fontSize: 12, marginTop: 4 }}>Flags: {p.riskFlags.join(', ')}</Text>}
        {p.stage === 'QUEUED' && (
          <View style={{ marginTop: 10 }}>
            <Button t={t} title="Claim and pay" onPress={() => claim(p)} />
          </View>
        )}
        {p.stage === 'IN_PROGRESS' && mine && (
          <View style={{ marginTop: 10 }}>
            {p.instructions?.steps.map((step, i) => (
              <Text key={i} style={{ color: t.text, marginBottom: 4 }}>
                {i + 1}. {step}
              </Text>
            ))}
            {p.expiresAt && <Text style={{ color: t.muted, fontSize: 12 }}>Claim expires {new Date(p.expiresAt).toLocaleTimeString()}</Text>}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Button t={t} title={p.instructions?.ussd ? `Dial ${p.instructions.ussd}` : 'Open operator menu'} onPress={() => dial(p)} kind="ok" />
              <Button t={t} title="Return" onPress={() => release(p)} kind="ghost" />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <ActivityIndicator color={t.warn} />
              <Text style={{ color: t.muted, flex: 1 }}>Waiting for the operator confirmation SMS – it is signed and forwarded automatically. Do not delete it.</Text>
            </View>
          </View>
        )}
        {p.stage === 'IN_PROGRESS' && !mine && <Text style={{ color: t.muted, marginTop: 8 }}>Claimed by another device / agent.</Text>}
      </Card>
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={[s.header, { borderColor: t.line }]}>
        <View style={{ flex: 1 }}>
          <Text style={[s.h1, { color: t.text, marginBottom: 0 }]}>{enrolment.deviceName}</Text>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            {enrolment.payoutAccountLabel ?? 'SMS collector'} · SIM {enrolment.simMsisdn ?? enrolment.simIccid}
          </Text>
        </View>
        <Chip
          t={t}
          text={error ? 'offline' : Sms.isNativeAvailable() ? (permissions ? 'listening' : 'no SMS permission') : 'manual'}
          color={error || (Sms.isNativeAvailable() && !permissions) ? t.danger : t.ok}
        />
      </View>
      <View style={[s.tabs, { borderColor: t.line }]}>
        {(['queue', 'log', 'device'] as const).map((k) => (
          <Pressable key={k} onPress={() => setTab(k)} style={[s.tab, tab === k && { borderBottomColor: t.primary, borderBottomWidth: 2 }]}>
            <Text style={{ color: tab === k ? t.primary : t.muted, fontWeight: '600' }}>
              {k === 'queue' ? `Queue (${queue.length})` : k === 'log' ? `Log${pending.length ? ` · ${pending.length} pending` : ''}` : 'Device'}
            </Text>
          </Pressable>
        ))}
      </View>
      {error && <Text style={{ color: t.danger, padding: 12 }}>{error}</Text>}
      {tab === 'queue' && (
        <FlatList
          data={queue}
          keyExtractor={(p) => p.id}
          renderItem={renderPayout}
          contentContainerStyle={{ padding: 16 }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={t.muted} />}
          ListHeaderComponent={lastSms ? <Text style={{ color: t.muted, fontSize: 12, marginBottom: 8 }}>Last SMS: {lastSms}</Text> : null}
          ListEmptyComponent={
            <Text style={{ color: t.muted, textAlign: 'center', marginTop: 40 }}>
              {enrolment.kind === 'payout' ? 'No payouts queued for this SIM. New instructions appear here automatically.' : 'This device forwards operator SMS as evidence; nothing to do here.'}
            </Text>
          }
          ListFooterComponent={
            !Sms.isNativeAvailable() ? (
              <Card t={t} style={{ marginTop: 12 }}>
                <Text style={{ color: t.warn, fontWeight: '600', marginBottom: 6 }}>Development mode – native SMS receiver unavailable</Text>
                <Text style={{ color: t.muted, fontSize: 12, marginBottom: 8 }}>
                  Paste the operator SMS to sign and forward it. Production devices must run the native Android build so evidence comes only from real received messages.
                </Text>
                <Field t={t} label="Sender" value={manualFrom} onChangeText={setManualFrom} placeholder="OrangeMoney" />
                <Field t={t} label="Message" value={manualText} onChangeText={setManualText} multiline />
                <Button t={t} title="Sign and forward" onPress={submitManual} kind="ghost" />
              </Card>
            ) : null
          }
        />
      )}
      {tab === 'log' && (
        <FlatList
          data={log}
          keyExtractor={(l, i) => `${l.at}-${i}`}
          contentContainerStyle={{ padding: 16 }}
          ListHeaderComponent={
            pending.length ? (
              <Card t={t} style={{ marginBottom: 10 }}>
                <Text style={{ color: t.warn, fontWeight: '600' }}>{pending.length} signed confirmation(s) waiting for connectivity</Text>
                <Text style={{ color: t.muted, fontSize: 12 }}>
                  They are retried every {POLL_MS / 1000}s and delivered once. Last error: {pending[0].lastError}
                </Text>
                <View style={{ marginTop: 8 }}>
                  <Button
                    t={t}
                    title="Retry now"
                    kind="ghost"
                    onPress={async () => {
                      await flushPending(enrolment.apiUrl);
                      await refresh();
                    }}
                  />
                </View>
              </Card>
            ) : null
          }
          renderItem={({ item }) => (
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
              <Text style={{ color: item.level === 'ok' ? t.ok : item.level === 'warn' ? t.warn : item.level === 'error' ? t.danger : t.muted, fontSize: 12, width: 62 }}>
                {new Date(item.at).toLocaleTimeString()}
              </Text>
              <Text style={{ color: t.text, flex: 1, fontSize: 13 }}>{item.text}</Text>
            </View>
          )}
          ListEmptyComponent={<Text style={{ color: t.muted, textAlign: 'center', marginTop: 40 }}>No activity yet.</Text>}
        />
      )}
      {tab === 'device' && (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <Card t={t}>
            <Text style={[s.label, { color: t.muted }]}>Device id</Text>
            <Text selectable style={{ color: t.text, marginBottom: 12 }}>
              {enrolment.deviceId}
            </Text>
            <View style={{ alignItems: 'center', marginBottom: 12 }}>
              <QRCode value={enrolment.deviceId} size={140} backgroundColor="transparent" color={t.text} />
            </View>
            <Text style={{ color: t.muted, fontSize: 12 }}>
              API {enrolment.apiUrl}
              {'\n'}Enrolled {new Date(enrolment.enrolledAt).toLocaleString()}
              {'\n'}Role {enrolment.kind}
              {enrolment.operatorId ? ` · operator ${enrolment.operatorId}` : ''}
              {'\n'}Sender filters: {enrolment.senderFilters.length ? enrolment.senderFilters.join(', ') : 'all senders'}
            </Text>
          </Card>
          <Card t={t} style={{ marginTop: 12 }}>
            <Text style={{ color: t.text, fontWeight: '600', marginBottom: 6 }}>Send BitriPay SMS from this SIM</Text>
            <Text style={{ color: t.muted, fontSize: 13, marginBottom: 8 }}>
              With the SMS provider set to "Enrolled phone SIM" in the console, verification codes, receipts and notices are queued on the server and this phone sends them from its own SIM. No SMS
              API, no key. Each send is reported back; the server retries failures up to three times.
            </Text>
            <Button
              t={t}
              title={smsSender ? 'Sending is ON – switch off' : 'Switch on SMS sending'}
              kind={smsSender ? 'ghost' : 'ok'}
              onPress={async () => {
                const next = !smsSender;
                if (next && !(await Sms.requestPermissions())) return Alert.alert('Permission needed', 'Allow SMS sending for this app in Android settings.');
                setSmsSender(next);
                smsSenderRef.current = next;
                await saveSmsSender(next);
              }}
            />
          </Card>
          <Card t={t} style={{ marginTop: 12 }}>
            <Text style={{ color: t.text, fontWeight: '600', marginBottom: 6 }}>How this device is trusted</Text>
            <Text style={{ color: t.muted, fontSize: 13 }}>
              • The Ed25519 private key was generated on this phone and is stored in the Android keystore-backed secure store. It cannot be exported.{'\n'}• Every request and every forwarded SMS is
              signed; the server refuses replays, wrong SIMs and altered text.{'\n'}• Nothing settles because of this app: the server verifies each confirmation against the payout it queued.{'\n'}• If
              the phone or SIM is lost, an administrator revokes the device and its evidence stops being accepted.
            </Text>
          </Card>
          <View style={{ marginTop: 16 }}>
            <Button t={t} title="Remove enrolment from this phone" kind="danger" onPress={unenrol} />
          </View>
        </ScrollView>
      )}
    </View>
  );
}

// =====================================================================================
// Root: load enrolment, biometric unlock
// =====================================================================================
export default function App() {
  const t = useTheme();
  const [state, setState] = useState<'loading' | 'enrol' | 'locked' | 'home'>('loading');
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const unlock = useCallback(async () => {
    setUnlockError(null);
    const hw = await LocalAuthentication.hasHardwareAsync().catch(() => false);
    const enrolled = hw && (await LocalAuthentication.isEnrolledAsync().catch(() => false));
    if (enrolled) {
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock the payout device', fallbackLabel: 'Use device passcode' });
      if (!r.success) {
        setUnlockError('Unlock failed');
        return;
      }
    }
    const key = await secure.getPrivateKey();
    if (!key) {
      setUnlockError('Device key missing – re-enrol');
      await saveEnrolment(null);
      setEnrolment(null);
      setState('enrol');
      return;
    }
    setPrivateKey(key);
    setState('home');
  }, []);

  useEffect(() => {
    (async () => {
      const e = await loadEnrolment();
      setEnrolment(e);
      setState(e ? 'locked' : 'enrol');
    })();
  }, []);
  useEffect(() => {
    if (state === 'locked') unlock();
  }, [state, unlock]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
        <StatusBar style={t.dark ? 'light' : 'dark'} />
        {state === 'loading' && <ActivityIndicator style={{ marginTop: 80 }} color={t.primary} />}
        {state === 'enrol' && (
          <Enrol
            t={t}
            onDone={(e) => {
              setEnrolment(e);
              setState('locked');
            }}
          />
        )}
        {state === 'locked' && (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
            <Text style={[s.h1, { color: t.text }]}>BitriPay payout device</Text>
            <Text style={{ color: t.muted, textAlign: 'center', marginBottom: 16 }}>
              {enrolment?.deviceName}
              {'\n'}Unlock with your fingerprint or face to start executing payouts.
            </Text>
            {unlockError && <Text style={{ color: t.danger, marginBottom: 12 }}>{unlockError}</Text>}
            <Button t={t} title="Unlock" onPress={unlock} />
          </View>
        )}
        {state === 'home' && enrolment && privateKey && (
          <Home
            t={t}
            enrolment={enrolment}
            privateKey={privateKey}
            onUnenrol={() => {
              setPrivateKey(null);
              setEnrolment(null);
              setState('enrol');
            }}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  h1: { fontSize: 22, fontWeight: '700', marginBottom: 6 },
  label: { fontSize: 12, fontWeight: '600', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  card: { borderWidth: 1, borderRadius: 14, padding: 14 },
  btn: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 10, borderWidth: 1, alignItems: 'center', flexShrink: 1 },
  btnText: { fontWeight: '600', fontSize: 15 },
  chip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  option: { borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 8 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  tabs: { flexDirection: 'row', borderBottomWidth: 1 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10 },
});
