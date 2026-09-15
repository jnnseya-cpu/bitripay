import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, Share, Switch as RNSwitch, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Screen, Card, Button, Input, Alert, T, KV, Row, Status, Tabs, Empty, useAsync, TxRow, Select, Qr, Sheet, Chip, useTheme, Avatar } from '../components/ui';
import { Header } from '../components/Header';
import { useNav, type ScreenProps } from '../navigation';
import { ringLoud, setLoudEnabled } from '../lib/alerts';
import { TRANSACTION_TYPE_LABELS, type Transaction, type User, currencyLabel } from '@bitripay/shared';

export function Activity() {
  const { t } = useStore();
  const nav = useNav();
  const [direction, setDirection] = useState('');
  const [page, setPage] = useState(1);
  const data = useAsync(() => api.get<{ items: Transaction[]; total: number }>(`/api/wallets/transactions${qs({ direction, page, pageSize: 25 })}`), [direction, page]);
  return (
    <Screen title={t('nav.transactions')}>
      <Tabs
        tabs={[
          { id: '', label: t('common.all') },
          { id: 'in', label: t('tx.in') },
          { id: 'out', label: t('tx.out') },
        ]}
        value={direction}
        onChange={(v) => {
          setDirection(v);
          setPage(1);
        }}
      />
      <Card>
        {data.data?.items.length === 0 && <Empty icon="📜" />}
        {data.data?.items.map((tx) => (
          <TxRow key={tx.id} tx={tx} onPress={() => nav.navigate('TxDetail', { id: tx.id })} />
        ))}
        <Row between>
          <Button title="←" small variant="secondary" disabled={page <= 1} onPress={() => setPage(page - 1)} />
          <T muted size={12}>
            {page} / {Math.max(1, Math.ceil((data.data?.total ?? 0) / 25))}
          </T>
          <Button title="→" small variant="secondary" disabled={page * 25 >= (data.data?.total ?? 0)} onPress={() => setPage(page + 1)} />
        </Row>
      </Card>
    </Screen>
  );
}

export function TxDetail({ route }: ScreenProps<'TxDetail'>) {
  const { money } = useStore();
  const th = useTheme();
  const nav = useNav();
  const data = useAsync(() => api.get<any>(`/api/wallets/transactions/${route.params.id}`), [route.params.id]);
  const d = data.data;
  if (!d)
    return (
      <Screen>
        <Header title="Transaction" />
      </Screen>
    );
  const tx: Transaction = d.transaction;
  const meta = tx.metadata as any;
  const isIn = tx.direction === 'in';
  return (
    <Screen>
      <Header title={TRANSACTION_TYPE_LABELS[tx.type]} />
      <Card style={{ alignItems: 'center' }}>
        <T bold size={32} color={isIn ? th.success : th.text}>
          {isIn ? '+' : tx.direction === 'out' ? '-' : ''}
          {money(isIn ? (tx.receiveAmount ?? tx.amount) : tx.amount, isIn ? (tx.receiveCurrency ?? tx.currency) : tx.currency)}
        </T>
        <Status status={tx.status} />
        <T muted size={12}>
          {new Date(tx.createdAt).toLocaleString()}
        </T>
      </Card>
      <Card>
        {d.sender && <KV k="From" v={`${d.sender.businessName || d.sender.fullName} (@${d.sender.tag})`} />}
        {d.receiver && <KV k="To" v={`${d.receiver.businessName || d.receiver.fullName} (@${d.receiver.tag})`} />}
        <KV k="Amount" v={money(tx.amount, tx.currency)} />
        {tx.receiveCurrency && tx.receiveCurrency !== tx.currency && <KV k="Received" v={money(tx.receiveAmount ?? 0, tx.receiveCurrency)} />}
        <KV k="Fee" v={money(tx.fee, tx.currency)} />
        {tx.note && <KV k="Note" v={tx.note} />}
        {meta?.method && <KV k="Method" v={String(meta.method).replace('_', ' ')} />}
        {meta?.receiptNo && <KV k="Receipt" v={String(meta.receiptNo)} />}
        <KV k="Reference" v={tx.reference} />
      </Card>
      <Row>
        <Button
          title="Share receipt"
          variant="secondary"
          onPress={() => Share.share({ message: `BitriPay ${TRANSACTION_TYPE_LABELS[tx.type]} ${tx.reference}: ${money(tx.amount, tx.currency)} · ${tx.status}` })}
        />
        {d.receiver && tx.direction === 'out' && <Button title="Send again" variant="ghost" onPress={() => nav.navigate('Send', { to: d.receiver.tag })} />}
      </Row>
    </Screen>
  );
}

export function Settings() {
  const { t, user, setUser, toast, config, lang, setLang, dark, setDark } = useStore();
  const nav = useNav();
  const [form, setForm] = useState({ fullName: user?.fullName ?? '', tag: user?.tag ?? '', country: user?.country ?? '', businessName: user?.businessName ?? '' });
  const save = async () => {
    try {
      const r = await api.patch<{ user: User }>('/api/account/profile', { ...form, country: form.country || null, businessName: form.businessName || null });
      setUser(r.user);
      toast('Profile updated', 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Screen>
      <Header title={t('nav.settings')} />
      <Card>
        <Row>
          <Avatar user={user} size={52} />
          <View>
            <T bold size={18}>
              {user?.fullName}
            </T>
            <T muted>
              @{user?.tag} · {user?.role}
            </T>
          </View>
        </Row>
        <Input label={t('auth.fullName')} value={form.fullName} onChangeText={(v) => setForm({ ...form, fullName: v })} />
        <Input label="@tag" value={form.tag} onChangeText={(v) => setForm({ ...form, tag: v })} autoCapitalize="none" />
        {user?.role !== 'user' && <Input label="Business name" value={form.businessName} onChangeText={(v) => setForm({ ...form, businessName: v })} />}
        <Select
          label={t('auth.country')}
          value={form.country}
          onChange={(v) => setForm({ ...form, country: v })}
          options={[{ value: '', label: '—' }, ...(config?.countries ?? []).map((c: any) => ({ value: c.code, label: c.name }))]}
        />
        <Button title={t('common.save')} onPress={save} />
      </Card>
      <WalletPreferencesCard />
      <Card>
        <Select
          label={t('settings.language')}
          value={lang}
          onChange={setLang}
          options={(config?.languages ?? [{ code: 'en', nativeName: 'English', name: 'English' }]).map((l: any) => ({ value: l.code, label: `${l.nativeName} (${l.name})` }))}
        />
        <Row between>
          <T>{t('settings.theme')}</T>
          <RNSwitch value={dark} onValueChange={setDark} />
        </Row>
        <Row between>
          <View style={{ flex: 1 }}>
            <T>🔔 Loud alerts</T>
            <T muted size={12}>
              Alarm sound and long vibration when money arrives, a payout completes or something needs you
            </T>
          </View>
          <RNSwitch
            value={user?.loudAlerts !== false}
            onValueChange={(v) => {
              setLoudEnabled(v);
              api
                .patch<{ user: User }>('/api/account/profile', { loudAlerts: v })
                .then((r) => setUser(r.user))
                .catch((e) => toast(e.message, 'error'));
            }}
          />
        </Row>
        {user?.loudAlerts !== false && <Button title="Test alert" small variant="secondary" onPress={() => ringLoud()} />}
        <Button title="Account statements" variant="secondary" onPress={() => nav.navigate('Statements')} />
      </Card>
      <Card>
        <KV
          k={t('auth.email')}
          v={
            <Row>
              {user?.email ? <T>{user.email}</T> : <T muted>—</T>}
              {user?.email && (user.emailVerified ? <Chip label="verified" kind="success" /> : <Button title="Verify" small variant="secondary" onPress={() => nav.navigate('Security')} />)}
            </Row>
          }
        />
        <KV
          k={t('auth.phone')}
          v={
            <Row>
              {user?.phone ? <T>{user.phone}</T> : <T muted>—</T>}
              {user?.phone && (user.phoneVerified ? <Chip label="verified" kind="success" /> : <Button title="Verify" small variant="secondary" onPress={() => nav.navigate('Security')} />)}
            </Row>
          }
        />
        <Button title={t('settings.security')} variant="secondary" onPress={() => nav.navigate('Security')} />
        <Button title={t('settings.kyc')} variant="secondary" onPress={() => nav.navigate('Kyc')} />
      </Card>
    </Screen>
  );
}

export function Security() {
  const { t, user, toast, refresh, biometrics, setBiometrics, biometricsAvailable, setUser } = useStore();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [pin, setPin] = useState({ pin: '', currentPin: '' });
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [otp, setOtp] = useState<{ channel: 'email' | 'sms'; info: string } | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [bioPinOpen, setBioPinOpen] = useState(false);
  const [bioPin, setBioPin] = useState('');
  const run = (p: Promise<unknown>, msg: string) =>
    p
      .then(() => {
        toast(msg, 'success');
        refresh();
      })
      .catch((e) => toast(e.message, 'error'));
  return (
    <Screen>
      <Header title={t('settings.security')} />
      {biometricsAvailable && (
        <Card>
          <Row between>
            <View style={{ flex: 1 }}>
              <T bold>Biometric login & payments</T>
              <T muted size={12}>
                Unlock BitriPay and confirm payments with fingerprint or face instead of your PIN
              </T>
            </View>
            <RNSwitch value={biometrics} onValueChange={(v) => (v ? setBioPinOpen(true) : setBiometrics(false))} />
          </Row>
        </Card>
      )}
      <Sheet open={bioPinOpen} onClose={() => setBioPinOpen(false)} title="Enable biometrics">
        <T muted size={13}>
          Enter your transaction PIN once. It is stored in the device's secure enclave and released only after a successful biometric check.
        </T>
        <Input label={t('common.pin')} value={bioPin} onChangeText={(v) => setBioPin(v.replace(/\D/g, ''))} secureTextEntry keyboardType="number-pad" maxLength={6} />
        <Button
          title="Enable"
          disabled={bioPin.length < 4}
          onPress={() =>
            api
              .post('/api/account/pin/verify', { pin: bioPin })
              .then(() => setBiometrics(true, bioPin))
              .then(() => {
                setBioPinOpen(false);
                setBioPin('');
                toast('Biometric login enabled', 'success');
              })
              .catch((e) => toast(e.message, 'error'))
          }
        />
      </Sheet>
      <Card>
        <T bold>{t('settings.pin')}</T>
        {user?.hasPin && <Input label="Current PIN" value={pin.currentPin} onChangeText={(v) => setPin({ ...pin, currentPin: v })} secureTextEntry keyboardType="number-pad" maxLength={6} />}
        <Input
          label={user?.hasPin ? 'New PIN' : 'Choose a 4–6 digit PIN'}
          value={pin.pin}
          onChangeText={(v) => setPin({ ...pin, pin: v.replace(/\D/g, '') })}
          secureTextEntry
          keyboardType="number-pad"
          maxLength={6}
        />
        <Button
          title={t('common.save')}
          disabled={pin.pin.length < 4}
          onPress={() => run(api.post('/api/account/pin', { pin: pin.pin, currentPin: pin.currentPin || undefined }), 'PIN saved').then(() => setPin({ pin: '', currentPin: '' }))}
        />
      </Card>
      <Card>
        <T bold>{t('settings.password')}</T>
        <Input label="Current password" value={pw.currentPassword} onChangeText={(v) => setPw({ ...pw, currentPassword: v })} secureTextEntry />
        <Input label="New password" value={pw.newPassword} onChangeText={(v) => setPw({ ...pw, newPassword: v })} secureTextEntry />
        <Button
          title={t('common.save')}
          disabled={pw.newPassword.length < 8}
          onPress={() => run(api.post('/api/account/password', pw), 'Password changed').then(() => setPw({ currentPassword: '', newPassword: '' }))}
        />
      </Card>
      <Card>
        <Row between>
          <T bold>{t('settings.2fa')}</T>
          {user?.twoFactorEnabled ? <Chip label="Enabled" kind="success" /> : <Chip label="Disabled" />}
        </Row>
        {!user?.twoFactorEnabled && !setup && <Button title="Set up 2FA" onPress={() => api.post<{ qr: string; secret: string }>('/api/account/2fa/setup').then(setSetup)} />}
        {setup && (
          <>
            <Qr value={`otpauth://totp/BitriPay:${user?.email ?? user?.tag}?secret=${setup.secret}&issuer=BitriPay`} size={160} />
            <T mono size={12} center>
              {setup.secret}
            </T>
            <Button title="Copy secret" small variant="secondary" onPress={() => Clipboard.setStringAsync(setup.secret)} />
            <Input label="Code from authenticator" value={code} onChangeText={setCode} keyboardType="number-pad" />
            <Button title="Enable" onPress={() => run(api.post('/api/account/2fa/enable', { code }), '2FA enabled').then(() => setSetup(null))} />
          </>
        )}
        {user?.twoFactorEnabled && (
          <>
            <Input label="Code from authenticator" value={code} onChangeText={setCode} keyboardType="number-pad" />
            <Button title="Disable 2FA" variant="danger" onPress={() => run(api.post('/api/account/2fa/disable', { code }), '2FA disabled')} />
          </>
        )}
      </Card>
      <Card>
        <T bold>Verification</T>
        {user?.email && !user.emailVerified && (
          <Button
            title="Verify email"
            variant="secondary"
            onPress={() =>
              api
                .post<{ devCode?: string }>('/api/account/verify/request', { channel: 'email' })
                .then((r) => setOtp({ channel: 'email', info: r.devCode ? `Code sent (sandbox: ${r.devCode})` : 'Code sent' }))
            }
          />
        )}
        {user?.phone && !user.phoneVerified && (
          <Button
            title="Verify phone"
            variant="secondary"
            onPress={() =>
              api
                .post<{ devCode?: string }>('/api/account/verify/request', { channel: 'sms' })
                .then((r) => setOtp({ channel: 'sms', info: r.devCode ? `Code sent (sandbox: ${r.devCode})` : 'Code sent' }))
            }
          />
        )}
        {user?.emailVerified && user?.phoneVerified && <T muted>All verified ✓</T>}
      </Card>
      <Sheet open={!!otp} onClose={() => setOtp(null)} title="Enter code">
        {otp && (
          <>
            <Alert text={otp.info} />
            <Input value={otpCode} onChangeText={setOtpCode} keyboardType="number-pad" />
            <Button
              title={t('common.confirm')}
              onPress={() =>
                api
                  .post<{ user: User }>('/api/account/verify/confirm', { channel: otp.channel, code: otpCode })
                  .then((r) => {
                    setUser(r.user);
                    setOtp(null);
                    toast('Verified', 'success');
                  })
                  .catch((e) => toast(e.message, 'error'))
              }
            />
          </>
        )}
      </Sheet>
    </Screen>
  );
}

export function Kyc() {
  const { t, user, toast, refresh } = useStore();
  const kyc = useAsync(() => api.get<any>('/api/kyc'), []);
  const [form, setForm] = useState({ docType: 'passport', docNumber: '', fullName: user?.fullName ?? '', dob: '', address: '' });
  const status = user?.kycStatus ?? 'none';
  const submit = () =>
    api
      .post('/api/kyc', form)
      .then(() => {
        toast('Submitted for review', 'success');
        refresh();
        kyc.reload();
      })
      .catch((e) => toast(e.message, 'error'));
  return (
    <Screen>
      <Header title={t('settings.kyc')} right={<Status status={status} />} />
      {status === 'verified' && <Alert kind="success" text="Your identity is verified. Higher limits are active." />}
      {status === 'pending' && <Alert text="Your documents are under review." />}
      {status === 'rejected' && <Alert kind="error" text={`Rejected${kyc.data?.submission?.note ? `: ${kyc.data.submission.note}` : ''}. Please submit again.`} />}
      {(status === 'none' || status === 'rejected') && (
        <Card>
          <Select
            label="Document type"
            value={form.docType}
            onChange={(v) => setForm({ ...form, docType: v })}
            options={[
              { value: 'passport', label: 'Passport' },
              { value: 'national_id', label: 'National ID' },
              { value: 'drivers_license', label: "Driver's license" },
              { value: 'voter_card', label: 'Voter card' },
            ]}
          />
          <Input label="Document number" value={form.docNumber} onChangeText={(v) => setForm({ ...form, docNumber: v })} />
          <Input label="Full legal name" value={form.fullName} onChangeText={(v) => setForm({ ...form, fullName: v })} />
          <Input label="Date of birth (YYYY-MM-DD)" value={form.dob} onChangeText={(v) => setForm({ ...form, dob: v })} />
          <Input label="Address" value={form.address} onChangeText={(v) => setForm({ ...form, address: v })} multiline />
          <T muted size={12}>
            Document photos and selfie can be uploaded from the web app; details submitted here are reviewed by our team.
          </T>
          <Button title="Submit for verification" onPress={submit} disabled={form.docNumber.length < 3} />
        </Card>
      )}
    </Screen>
  );
}

export function Referrals() {
  const { t, user, money, config } = useStore();
  const stats = useAsync(() => api.get<any>('/api/account/referrals'), []);
  const link = `${config?.webUrl}/register?ref=${user?.referralCode}`;
  const s = stats.data;
  return (
    <Screen>
      <Header title={t('nav.referrals')} />
      <Card style={{ alignItems: 'center' }}>
        <Qr value={link} size={160} />
        <T bold size={22} mono>
          {user?.referralCode}
        </T>
        <Row>
          <Button title="Copy link" small variant="secondary" onPress={() => Clipboard.setStringAsync(link)} />
          <Button title={t('common.share')} small onPress={() => Share.share({ message: `Join me on BitriPay: ${link}` })} />
        </Row>
      </Card>
      <Card>
        <KV k="Friends referred" v={String(s?.referredCount ?? 0)} />
        <KV k="Total earned" v={s ? money(s.totalEarned, s.currency) : '—'} />
        <Row style={{ flexWrap: 'wrap' }}>
          {(s?.settings?.rewards ?? []).map((r: number, i: number) => (
            <Chip key={i} label={`Level ${i + 1}: ${money(r, s.currency)}`} kind="primary" />
          ))}
        </Row>
      </Card>
      {(s?.referred ?? []).map((r: any) => (
        <Card key={r.id}>
          <T bold>{r.fullName}</T>
          <T muted size={12}>
            @{r.tag} · joined {new Date(r.joinedAt).toLocaleDateString()}
          </T>
        </Card>
      ))}
    </Screen>
  );
}

export function Support() {
  const { t, user, config } = useStore();
  const [tab, setTab] = useState<'chat' | 'tickets'>(config?.modules?.liveChat !== false ? 'chat' : 'tickets');
  const [msgs, setMsgs] = useState<any[]>([]);
  const [text, setText] = useState('');
  const tickets = useAsync(() => api.get<{ items: any[] }>('/api/support/tickets'), [tab]);
  const [sel, setSel] = useState<any>(null);
  const [reply, setReply] = useState('');
  const [create, setCreate] = useState(false);
  const [form, setForm] = useState({ subject: '', body: '' });
  const th = useTheme();
  const scroll = useRef<ScrollView>(null);
  const load = async (since?: string) => {
    const r = await api.get<{ items: any[] }>(`/api/support/chat${since ? `?since=${encodeURIComponent(since)}` : ''}`);
    if (r.items.length) setMsgs((m) => (since ? [...m, ...r.items.filter((x) => !m.some((y) => y.id === x.id))] : r.items));
  };
  useEffect(() => {
    if (tab === 'chat') load();
  }, [tab]);
  useEffect(() => {
    if (tab !== 'chat') return;
    const id = setInterval(() => load(msgs[msgs.length - 1]?.createdAt), 4000);
    return () => clearInterval(id);
  }, [msgs, tab]);
  const send = async () => {
    if (!text.trim()) return;
    const r = await api.post<{ message: any }>('/api/support/chat', { body: text });
    setMsgs((m) => [...m, r.message]);
    setText('');
  };
  return (
    <Screen scroll={tab !== 'chat'}>
      <Header title={t('nav.support')} />
      <Tabs tabs={[...(config?.modules?.liveChat !== false ? [{ id: 'chat', label: 'Live chat' }] : []), { id: 'tickets', label: 'Tickets' }]} value={tab} onChange={(v) => setTab(v as any)} />
      {tab === 'chat' ? (
        <View style={{ flex: 1 }}>
          <ScrollView ref={scroll} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} contentContainerStyle={{ gap: 8, paddingVertical: 8 }}>
            {msgs.length === 0 && <Empty icon="💬" text="Start a conversation with our support team" />}
            {msgs.map((m) => (
              <View key={m.id} style={{ alignSelf: m.isAdmin ? 'flex-start' : 'flex-end', backgroundColor: m.isAdmin ? th.soft : th.primary, padding: 10, borderRadius: 12, maxWidth: '80%' }}>
                <T color={m.isAdmin ? th.text : '#fff'} size={14}>
                  {m.body}
                </T>
                <T color={m.isAdmin ? th.muted : 'rgba(255,255,255,0.7)'} size={10}>
                  {m.isAdmin ? 'Support' : user?.fullName} · {new Date(m.createdAt).toLocaleTimeString()}
                </T>
              </View>
            ))}
          </ScrollView>
          <Row>
            <View style={{ flex: 1 }}>
              <Input value={text} onChangeText={setText} placeholder="Type a message…" />
            </View>
            <Button title="Send" small onPress={send} />
          </Row>
        </View>
      ) : (
        <>
          <Button title="+ New ticket" small onPress={() => setCreate(true)} />
          {tickets.data?.items.length === 0 && <Empty icon="🎫" />}
          {tickets.data?.items.map((tk) => (
            <Card key={tk.id}>
              <Row between>
                <T bold>{tk.subject}</T>
                <Status status={tk.status} />
              </Row>
              <Button title="Open" small variant="secondary" onPress={() => api.get<{ ticket: any }>(`/api/support/tickets/${tk.id}`).then((r) => setSel(r.ticket))} />
            </Card>
          ))}
          <Sheet open={!!sel} onClose={() => setSel(null)} title={sel?.subject}>
            <ScrollView style={{ maxHeight: 300 }} contentContainerStyle={{ gap: 8 }}>
              {sel?.messages?.map((m: any) => (
                <Card key={m.id} soft>
                  <T bold size={12}>
                    {m.isAdmin ? 'Support' : 'You'}
                  </T>
                  <T size={14}>{m.body}</T>
                </Card>
              ))}
            </ScrollView>
            {sel?.status !== 'closed' && (
              <>
                <Input value={reply} onChangeText={setReply} placeholder="Reply…" />
                <Button
                  title="Reply"
                  disabled={!reply.trim()}
                  onPress={() =>
                    api.post<{ ticket: any }>(`/api/support/tickets/${sel.id}/reply`, { body: reply }).then((r) => {
                      setSel(r.ticket);
                      setReply('');
                      tickets.reload();
                    })
                  }
                />
              </>
            )}
          </Sheet>
          <Sheet open={create} onClose={() => setCreate(false)} title="New ticket">
            <Input label="Subject" value={form.subject} onChangeText={(v) => setForm({ ...form, subject: v })} />
            <Input label="Describe the issue" value={form.body} onChangeText={(v) => setForm({ ...form, body: v })} multiline />
            <Button
              title="Submit"
              disabled={form.subject.length < 3 || form.body.length < 3}
              onPress={() =>
                api.post('/api/support/tickets', form).then(() => {
                  setCreate(false);
                  setForm({ subject: '', body: '' });
                  tickets.reload();
                })
              }
            />
          </Sheet>
        </>
      )}
    </Screen>
  );
}

/** Bank-grade statement: opening / closing balance, every ledger posting with running balance, statement number and hash. */
export function Statements() {
  const { wallets, money, toast } = useStore();
  const today = new Date().toISOString().slice(0, 10);
  const [currency, setCurrency] = useState(wallets[0]?.currency ?? 'USD');
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [st, setSt] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const generate = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ statement: any }>(`/api/wallets/statement${qs({ currency, from, to })}`);
      setSt(r.statement);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };
  const shareCsv = async () => {
    if (!st) return;
    const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      `# BitriPay statement ${st.number} · ${st.account.iban} · ${st.period.from} to ${st.period.to} · hash ${st.hash}`,
      'Date,Reference,Description,Counterparty,Status,Debit,Credit,Balance',
      ...st.lines.map((l: any) => [l.date, l.reference, q(l.description), q(l.counterparty), l.status, l.debit || '', l.credit || '', l.balance].join(',')),
    ].join('\n');
    try {
      await Share.share({ title: `BitriPay statement ${st.number}`, message: csv });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Screen>
      <Header title="Account statements" />
      <Card>
        <Select label="Account" value={currency} onChange={setCurrency} options={wallets.map((w) => ({ value: w.currency, label: `${w.currency} · ${money(w.balance, w.currency)}` }))} />
        <Input label="From (YYYY-MM-DD)" value={from} onChangeText={setFrom} autoCapitalize="none" />
        <Input label="To (YYYY-MM-DD)" value={to} onChangeText={setTo} autoCapitalize="none" />
        <Button title="Generate statement" onPress={generate} loading={loading} />
      </Card>
      {st && (
        <Card>
          <KV k="Statement" v={<T bold>{st.number}</T>} />
          <KV
            k="Account"
            v={
              <T mono size={12}>
                {st.account.iban}
              </T>
            }
          />
          <KV k="Period" v={`${st.period.from} → ${st.period.to}`} />
          <KV k="Opening" v={money(st.opening, currency)} />
          <KV k="Credits" v={money(st.totalCredits, currency)} />
          <KV k="Debits" v={money(st.totalDebits, currency)} />
          <KV k="Closing" v={<T bold>{money(st.closing, currency)}</T>} />
          <T muted size={11}>
            {st.account.classification} · hash {String(st.hash).slice(0, 16)}…
          </T>
          {st.disclaimer?.includes('SANDBOX') && <Alert kind="warning" text={st.disclaimer} />}
          <Button title="Share as CSV" variant="secondary" onPress={shareCsv} />
          {st.lines.length === 0 && <Empty text="No transactions in this period." />}
          {st.lines.map((l: any, i: number) => (
            <Row key={i} between>
              <View style={{ flex: 1 }}>
                <T size={13}>{l.description}</T>
                <T muted size={11}>
                  {new Date(l.date).toLocaleString()} · {l.reference}
                  {l.counterparty ? ` · ${l.counterparty}` : ''}
                </T>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <T bold color={l.credit ? '#16a34a' : undefined}>
                  {l.credit ? `+${money(l.credit, currency)}` : `-${money(l.debit, currency)}`}
                </T>
                <T muted size={11}>
                  {money(l.balance, currency)}
                </T>
              </View>
            </Row>
          ))}
          {(st.promo.movements.length > 0 || st.promo.closing > 0) && (
            <>
              <T bold size={13}>
                Promotional credit (not money – covers fees only)
              </T>
              <KV k="Balance" v={money(st.promo.closing, currency)} />
            </>
          )}
        </Card>
      )}
    </Screen>
  );
}

/** Main and alternative wallets: what pays by default and the second choice; both change at any time. */
function WalletPreferencesCard() {
  const { t, user, wallets, config, setUser, refreshWallets, toast } = useStore();
  const codes = Array.from(new Set([...wallets.map((w) => w.currency), ...((config?.currencies ?? []) as { code: string }[]).map((c) => c.code)]));
  const options = [{ value: '', label: '—' }, ...codes.map((c) => ({ value: c, label: currencyLabel(c) }))];
  const save = async (patch: { main?: string | null; alternative?: string | null }) => {
    try {
      const r = await api.put<{ user: User }>('/api/wallets/preferences', patch);
      setUser(r.user);
      await refreshWallets();
      toast(t('wallet.prefsSaved'), 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Card>
      <T bold size={16}>
        {t('wallet.main')} / {t('wallet.alternative')}
      </T>
      <T muted size={12}>
        {t('wallet.prefsHint')}
      </T>
      <Select label={t('wallet.main')} value={user?.mainCurrency ?? ''} onChange={(v) => save({ main: v || null })} options={options} />
      <Select label={t('wallet.alternative')} value={user?.alternativeCurrency ?? ''} onChange={(v) => save({ alternative: v || null })} options={options} />
    </Card>
  );
}
