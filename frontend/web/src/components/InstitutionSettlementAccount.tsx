import { useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Empty, Field, Input, Select, StatusBadge, useAsync } from './ui';

/**
 * Settlement account at a participating institution (national switch, CMP-02): the merchant declares the bank or
 * mobile-money account that receives its switch payments; BitriPay operations verify it with the institution and a
 * second administrator activates it. BitriPay never holds the funds: they settle at the institution.
 */
export function InstitutionSettlementAccount() {
  const { toast, config } = useStore();
  const participants = useAsync(() => api.get<any>('/api/v1/participants'), []);
  const bindings = useAsync(() => api.get<any>('/api/v1/beneficiary_bindings'), []);
  const [form, setForm] = useState({ participant_id: '', account_token: '', account_name: '', replaces_id: '' });
  const [busy, setBusy] = useState(false);
  const list: any[] = bindings.data?.data ?? [];
  const active = list.filter((b) => b.status === 'ACTIVE');
  const institutions: any[] = (participants.data?.data ?? []).filter((p: any) => p.kind !== 'AGGREGATOR');
  const name = (id: string) => institutions.find((p) => p.participant_id === id)?.name ?? id;
  const explain: Record<string, string> = {
    PENDING: tr('Declared. BitriPay operations verify the account with the institution.'),
    VERIFIED: tr('Verified with the institution. A second administrator activates it (four eyes).'),
    ACTIVE: tr('Active: your switch payments settle on this account.'),
    SUSPENDED: tr('Suspended by operations. Contact support.'),
    SUPERSEDED: tr('Replaced by a newer account.'),
  };
  const submit = () => {
    setBusy(true);
    api
      .post('/api/v1/beneficiary_bindings', {
        participant_id: form.participant_id,
        account_token: form.account_token.trim(),
        account_name: form.account_name.trim(),
        replaces_id: form.replaces_id || null,
      })
      .then(() => {
        toast(tr('Settlement account declared. Operations will verify it with the institution.'), 'success');
        setForm({ participant_id: '', account_token: '', account_name: '', replaces_id: '' });
        bindings.reload();
      })
      .catch((e) => toast(e.message, 'error'))
      .finally(() => setBusy(false));
  };
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>{tr('Settlement account at your institution')}</h3>
        <p className="small muted">
          {tr(
            'Payments received through the {0} settle on an account you hold at a participating bank or mobile-money institution. Declare it here; BitriPay verifies it with the institution and two administrators activate it. BitriPay never holds these funds.',
            { 0: config?.switchSchemeBrand ?? tr('Switch Monétique National') },
          )}
        </p>
        {participants.data?.connection?.simulation && (
          <Alert kind="info">{tr('The national switch runs in simulation: the institutions below are the simulator participants of the certification profile.')}</Alert>
        )}
        <Field label={tr('Institution')} hint={tr('A participant of the national switch in your country.')}>
          <Select value={form.participant_id} onChange={(e) => setForm({ ...form, participant_id: e.target.value })}>
            <option value="">{tr('Choose an institution')}</option>
            {institutions.map((p) => (
              <option key={p.participant_id} value={p.participant_id}>
                {p.name} · {p.kind === 'MMO' ? tr('mobile money') : p.kind === 'BANK' ? tr('bank') : p.kind} · {(p.currencies ?? []).join(', ')}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid cols-2">
          <Field label={tr('Account number')} hint={tr('Bank account (IBAN or number) or mobile-money number at that institution.')}>
            <Input value={form.account_token} onChange={(e) => setForm({ ...form, account_token: e.target.value })} placeholder="00123456789 / +243…" />
          </Field>
          <Field label={tr('Account holder name')} hint={tr('Exactly as the institution knows it.')}>
            <Input value={form.account_name} onChange={(e) => setForm({ ...form, account_name: e.target.value })} />
          </Field>
        </div>
        {active.length > 0 && (
          <Field label={tr('Replaces')} hint={tr('When the new account is activated, the one it replaces is closed.')}>
            <Select value={form.replaces_id} onChange={(e) => setForm({ ...form, replaces_id: e.target.value })}>
              <option value="">{tr('Add as an additional account')}</option>
              {active.map((b) => (
                <option key={b.id} value={b.id}>
                  {name(b.participantId)} · {b.accountMasked}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Button onClick={submit} disabled={busy || !form.participant_id || form.account_token.trim().length < 4 || form.account_name.trim().length < 2}>
          {tr('Declare the account')}
        </Button>
      </div>
      <div className="card">
        <h3>{tr('Declared accounts')}</h3>
        {bindings.error && <Alert kind="error">{bindings.error}</Alert>}
        {list.length === 0 && !bindings.error && <Empty icon="🏦" text={tr('No settlement account declared yet')} />}
        <div className="list">
          {list.map((b) => (
            <div key={b.id} className="list-item">
              <div className="flex1">
                <div className="main-text">
                  {name(b.participantId)} · <span className="mono">{b.accountMasked}</span>
                </div>
                <div className="sub-text">
                  {b.accountName} · v{b.version} · {new Date(b.createdAt).toLocaleDateString()}
                </div>
                <div className="tiny muted">{explain[b.status] ?? ''}</div>
              </div>
              <StatusBadge status={b.status} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
