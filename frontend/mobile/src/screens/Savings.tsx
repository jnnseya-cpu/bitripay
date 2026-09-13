import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Screen, Card, Button, Input, Alert, T, KV, Row, Select, Sheet, Chip, Empty, useAsync, AmountInput } from '../components/ui';
import { Header } from '../components/Header';

/** Savings & goals: ring-fenced goals, the 10% anchor, round-ups and the live-within-means monitor. */
export function Savings() {
  const { money, toast, wallets, refreshWallets, config } = useStore();
  const view = useAsync(() => api.get<any>('/api/savings'), []);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [cur, setCur] = useState(wallets[0]?.currency ?? config?.baseCurrency ?? 'USD');
  const [move, setMove] = useState<{ goal: any; dir: 'contribute' | 'withdraw' } | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const err = (e: any) => toast(e.message, 'error');
  const s = view.data?.settings;
  const wb = view.data?.wellbeing;
  const save = (patch: Record<string, unknown>) => api.put('/api/savings/settings', patch).then(() => { view.reload(); toast('Saved', 'success'); }).catch(err);
  const create = () => api.post('/api/savings/goals', { name, currency: cur, target: target || null }).then(() => { setName(''); setTarget(''); view.reload(); toast('Goal created', 'success'); }).catch(err);
  const submit = () => { if (!move) return; setBusy(true); api.post(`/api/savings/goals/${move.goal.id}/${move.dir}`, { amount }).then(() => { setMove(null); setAmount(''); view.reload(); refreshWallets(); toast(move.dir === 'contribute' ? 'Set aside' : 'Released', 'success'); }).catch(err).finally(() => setBusy(false)); };
  const kind = (st: string) => (st === 'green' ? 'success' : st === 'amber' ? 'warning' : 'danger');
  return (
    <Screen>
      <Header title="Savings & goals" />
      {wb && (
        <Card>
          <Row between><T bold>Living within your means</T><Chip label={wb.overall === 'green' ? 'on track' : wb.overall === 'amber' ? 'watch' : 'overspending'} kind={kind(wb.overall)} /></Row>
          {wb.currencies.map((c: any) => (
            <View key={c.currency} style={{ gap: 2 }}>
              <KV k={`${c.currency} received / spent (30 days)`} v={`${money(c.incomeMinor, c.currency)} / ${money(c.spendMinor, c.currency)}`} />
              {c.plan && <Alert kind={c.state === 'red' ? 'error' : 'warning'} text={`${c.plan.message} Set aside ${money(c.plan.weeklySavingMinor, c.currency)} a week.`} />}
            </View>
          ))}
        </Card>
      )}
      {s && (
        <Card>
          <T bold>Automatic saving</T>
          <Row between><T>Anchor {s.anchorBps / 100}% of every income</T><Button title={s.autoAnchor ? 'On' : 'Off'} small variant={s.autoAnchor ? undefined : 'secondary'} onPress={() => save({ autoAnchor: !s.autoAnchor })} /></Row>
          <Select label="Anchor share" value={String(s.anchorBps)} options={[1000, 1500, 2000, 3000, 5000].map((b) => ({ value: String(b), label: `${b / 100}%` }))} onChange={(v) => save({ anchorBps: Number(v) })} />
          <Row between><T>Round up every payment</T><Button title={s.roundUps ? 'On' : 'Off'} small variant={s.roundUps ? undefined : 'secondary'} onPress={() => save({ roundUps: !s.roundUps })} /></Row>
          <T muted size={12}>Never below {view.data.minimumAnchorBps / 100}%. Money set aside stays in your wallet but cannot be spent by accident.</T>
        </Card>
      )}
      <Card>
        <T bold>Goals</T>
        {(view.data?.goals ?? []).length === 0 && <Empty icon="🎯" text="No goal yet." />}
        {(view.data?.goals ?? []).map((g: any) => (
          <View key={g.id} style={{ gap: 4, paddingVertical: 6 }}>
            <Row between><T bold>{g.name}{g.status === 'REACHED' ? ' ✓' : ''}</T><T>{money(g.savedMinor, g.currency)}{g.targetMinor ? ` / ${money(g.targetMinor, g.currency)}` : ''}</T></Row>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: '#e5e7eb' }}><View style={{ height: 6, borderRadius: 3, width: `${Math.round(g.progress * 100)}%`, backgroundColor: '#0f766e' }} /></View>
            <Row style={{ gap: 6 }}>
              <Button title="Set aside" small onPress={() => { setMove({ goal: g, dir: 'contribute' }); setAmount(''); }} />
              <Button title="Release" small variant="secondary" disabled={g.savedMinor <= 0} onPress={() => { setMove({ goal: g, dir: 'withdraw' }); setAmount(''); }} />
            </Row>
          </View>
        ))}
        <T bold>New goal</T>
        <Input label="Name" value={name} onChangeText={setName} placeholder="School fees, a moto…" />
        <AmountInput label="Target (optional)" amount={target} currency={cur} onAmount={setTarget} onCurrency={setCur} currencies={wallets.map((w) => w.currency)} />
        <Button title="Create goal" disabled={name.trim().length < 2} onPress={create} />
      </Card>
      <Sheet open={!!move} onClose={() => setMove(null)} title={move?.dir === 'contribute' ? `Set aside into ${move?.goal.name}` : `Release from ${move?.goal.name}`}>
        <Input label={`Amount (${move?.goal.currency ?? ''})`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
        <Button title={move?.dir === 'contribute' ? 'Set aside' : 'Release'} loading={busy} onPress={submit} disabled={!amount} />
      </Sheet>
    </Screen>
  );
}
