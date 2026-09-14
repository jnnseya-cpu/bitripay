import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useStore } from '../lib/store';
import { Screen, Card, Button, Input, Alert, T, KV, Row, Qr, useAsync, AmountInput, Chip } from '../components/ui';
import { Header } from '../components/Header';
import { offlineDevice, offlineQueue, PENDING_CONFIRMATION_TEXT, type OfflineQr } from '../lib/offline';

/** Offline kit: set the phone up with its own signing key, keep merchant codes ready, show a code without network, and sync queued payments. */
export function Offline() {
  const { user, toast, money, config } = useStore();
  const status = useAsync(() => offlineDevice.status(), []);
  const queue = useAsync(() => offlineQueue.list(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(config?.baseCurrency ?? 'USD');
  const [reference, setReference] = useState('');
  const [shown, setShown] = useState<OfflineQr | null>(null);
  const [result, setResult] = useState<any>(null);
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast(ok, 'success');
      status.reload();
      queue.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    status.reload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = status.data;
  const isMerchant = user?.role === 'merchant';
  return (
    <Screen>
      <Header title="Offline payments" />
      <T muted>
        Pay and get paid when the network is down. Each promise is signed on this phone and settled, in order, the moment you are back online. The server refuses replays and empties; a payment that
        cannot settle restores your balance.
      </T>
      <Card>
        <T bold>This phone</T>
        {s?.deviceId ? (
          <>
            <KV k="Device" v={s.deviceId} />
            <KV k="Key valid until" v={s.keyNotAfter ? new Date(s.keyNotAfter).toLocaleDateString() : '—'} />
            <KV k="Queued payments" v={String(s.queued)} />
            <KV k="Last sync" v={s.lastSync ? new Date(s.lastSync).toLocaleString() : 'never'} />
          </>
        ) : (
          <Alert kind="info" text="Not set up yet. Provisioning creates a signing key on this phone and registers only its public half." />
        )}
        <Button
          title={s?.deviceId ? 'Renew key' : 'Set up this phone'}
          loading={busy === 'prov'}
          onPress={() => run('prov', () => offlineDevice.provision(`${user?.fullName ?? 'phone'} · mobile`), 'Phone ready for offline payments')}
        />
      </Card>
      {isMerchant && (
        <Card>
          <T bold>Show a code without network</T>
          <KV k="Codes ready" v={String(s?.nonces ?? 0)} />
          <Button
            title="Fetch 20 codes (online)"
            variant="secondary"
            small
            loading={busy === 'nonce'}
            onPress={() => run('nonce', () => offlineDevice.prefetchNonces(20), 'Codes stored on this phone')}
          />
          <AmountInput amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} currencies={(config?.currencies ?? []).map((c: any) => c.code)} />
          <Input label="Reference (optional)" value={reference} onChangeText={setReference} />
          <Button
            title="Show offline code"
            disabled={!amount}
            loading={busy === 'qr'}
            onPress={() =>
              run(
                'qr',
                async () =>
                  setShown(
                    await offlineDevice.localOfflineQr({
                      merchantCode: user!.tag,
                      merchantName: user!.businessName || user!.fullName,
                      country: user!.country ?? 'CD',
                      currency: cur,
                      amount,
                      reference: reference || null,
                    }),
                  ),
                'Code ready',
              )
            }
          />
          {shown && (
            <View style={{ alignItems: 'center', gap: 6 }}>
              <Qr value={shown.payload} size={230} />
              <T muted size={12}>
                Valid until {new Date(shown.expiresAt).toLocaleTimeString()} · nonce {shown.nonce.slice(0, 8)}…
              </T>
              <Chip label="OFFLINE_CREATED" />
              <T muted size={12}>
                {PENDING_CONFIRMATION_TEXT}
              </T>
            </View>
          )}
        </Card>
      )}
      <Card>
        <Row between>
          <T bold>Queued payments</T>
          <Button title="Sync now" small loading={busy === 'sync'} disabled={!queue.data?.length} onPress={() => run('sync', async () => setResult(await offlineQueue.sync()), 'Synced')} />
        </Row>
        {(queue.data ?? []).length === 0 && <T muted>Nothing waiting.</T>}
        {(queue.data ?? []).map((q) => (
          <Row key={q.hash} between>
            <View>
              <T>{q.merchantName}</T>
              <T muted size={12}>
                {new Date(q.queuedAt).toLocaleString()} · {q.state.replace(/_/g, ' ').toLowerCase()}
              </T>
              <T muted size={12}>
                {q.receiptText}
              </T>
            </View>
            <T bold>{money(q.amountMinor, q.currency)}</T>
          </Row>
        ))}
        {result && (
          <View style={{ gap: 4 }}>
            <Row style={{ gap: 6 }}>
              <Chip label={`${result.settled} confirmed`} kind="success" />
              {result.rejected > 0 && <Chip label={`${result.rejected} rejected`} kind="danger" />}
              {result.duplicates > 0 && <Chip label={`${result.duplicates} duplicates`} />}
            </Row>
            {result.results
              .filter((r: any) => r.state === 'REJECTED' || r.counterGap)
              .map((r: any, i: number) => (
                <T key={i} size={13} color={r.state === 'REJECTED' ? '#b91c1c' : '#92400e'}>
                  {r.lifecycle}
                  {r.reason ? ` · ${r.reason}` : ''}
                  {r.restoreMinor ? ` · ${money(r.restoreMinor, r.currency ?? cur)} restored` : ''}
                  {r.counterGap ? ` · counter gap (expected ${r.counterGap.expected}, got ${r.counterGap.received})` : ''}
                </T>
              ))}
          </View>
        )}
      </Card>
    </Screen>
  );
}
