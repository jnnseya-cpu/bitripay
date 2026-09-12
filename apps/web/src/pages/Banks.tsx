import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, Button, Chip, Empty, Field, Input, KV, PageHeader, PinModal, Select, StatusBadge, Tabs, Textarea, useAsync } from '../components/ui';

/** Linked banks: connect an account under consent (or import a statement), see verified income, pay by bank, and set recurring mandates. */
export function Banks() {
  const { money, toast, user } = useStore();
  const t = useT();
  const [params] = useSearchParams();
  const view = useAsync(() => api.get<any>('/api/open-banking'), []);
  const [tab, setTab] = useState<'links' | 'income' | 'mandates'>('links');
  const [country, setCountry] = useState(user?.country ?? 'CD');
  const [statement, setStatement] = useState({ institutionName: '', currency: 'USD', csv: '' });
  const [mandate, setMandate] = useState({ linkId: '', accountId: '', purpose: 'top_up', maxPerPayment: '', maxPerMonth: '' });
  const [pin, setPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const err = (e: any) => toast(e.message, 'error');
  useEffect(() => { const st = params.get('status'); if (st === 'linked') toast('Bank linked', 'success'); if (st === 'declined') toast('Authorisation declined at the bank', 'info'); }, [params, toast]);
  const institutions = (view.data?.institutions ?? []).filter((i: any) => i.country === country);
  const link = (institutionId: string) => api.post<any>('/api/open-banking/links', { institutionId }).then((r) => { if (r.link.authUrl) window.location.href = r.link.authUrl; else view.reload(); }).catch(err);
  const importCsv = () => api.post<any>('/api/open-banking/statements', statement).then((r) => { view.reload(); setStatement({ ...statement, csv: '' }); toast(`${r.link.imported} rows imported${r.link.rejected ? `, ${r.link.rejected} skipped` : ''}`, 'success'); }).catch(err);
  const sync = (id: string) => api.post<any>(`/api/open-banking/links/${id}/sync`, {}).then((r) => { view.reload(); toast(`${r.link.imported} new transaction(s)`, 'success'); }).catch(err);
  const revoke = (id: string) => { if (!confirm('Revoke this consent? Mandates on it stop too.')) return; api.del(`/api/open-banking/links/${id}`).then(() => view.reload()).catch(err); };
  const createMandate = (p: string) => { setBusy(true); api.post('/api/open-banking/mandates', { ...mandate, pin: p }).then(() => { setPin(false); view.reload(); toast('Mandate created', 'success'); }).catch(err).finally(() => setBusy(false)); };
  const links: any[] = view.data?.links ?? [];
  const linkable = links.filter((l) => l.status === 'LINKED' && l.provider !== 'statement_import');
  const income = view.data?.income;
  return (
    <div>
      <PageHeader title={t('nav.banks')} subtitle="Connect a bank account under your consent, or import a statement. Your income is verified from your real transactions; you can pay by bank and allow limited recurring draws." />
      <Tabs tabs={[{ id: 'links', label: 'Linked banks' }, { id: 'income', label: 'Verified income' }, { id: 'mandates', label: 'Recurring mandates' }]} value={tab} onChange={(v) => setTab(v as any)} />
      {tab === 'links' && (
        <div className="grid cols-2">
          <div className="card">
            <h3>Connect a bank</h3>
            <Field label="Country"><Select value={country} onChange={(e) => setCountry(e.target.value)}>{(view.data?.countries ?? []).map((c: any) => <option key={c.code} value={c.code}>{c.name}</option>)}</Select></Field>
            {institutions.length === 0 && <Empty icon="🏦" text="No connected institution in this country yet. Import a statement below." />}
            {institutions.map((i: any) => (
              <div key={i.id} className="list-item">
                <div className="flex1"><div className="main-text">{i.name}</div><div className="sub-text">{i.currencies.join(', ')} · {i.features.join(', ')}{i.provider === 'sandbox' ? ' · sandbox' : ''}</div></div>
                <Button size="sm" onClick={() => link(i.id)}>Connect</Button>
              </div>
            ))}
            <h4 style={{ marginTop: 16 }}>Import a statement</h4>
            <p className="sub-text">CSV with date, description and amount columns (credit/debit columns also work). Nothing leaves your account; the rows verify your income.</p>
            <div className="grid cols-2">
              <Field label="Bank"><Input value={statement.institutionName} onChange={(e) => setStatement({ ...statement, institutionName: e.target.value })} placeholder="My bank" /></Field>
              <Field label="Currency"><Input value={statement.currency} onChange={(e) => setStatement({ ...statement, currency: e.target.value.toUpperCase() })} maxLength={3} /></Field>
            </div>
            <Field label="CSV"><Textarea rows={6} value={statement.csv} onChange={(e) => setStatement({ ...statement, csv: e.target.value })} placeholder={'date,description,amount\n2026-08-28,ACME LTD SALARY,1500.00\n2026-08-01,RENT,-650.00'} /></Field>
            <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0]?.text().then((csv) => setStatement({ ...statement, csv }))} />
            <div style={{ marginTop: 8 }}><Button onClick={importCsv} disabled={!statement.csv.trim() || statement.institutionName.length < 2}>Import</Button></div>
          </div>
          <div className="card">
            <h3>Linked</h3>
            {links.length === 0 && <Empty icon="🔗" text="No bank linked yet." />}
            {links.map((l) => (
              <div key={l.id} className="list-item" style={{ display: 'block' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="main-text">{l.institutionName} <span className="sub-text">{l.provider === 'statement_import' ? 'statement' : l.provider}</span></div>
                  <StatusBadge status={l.status} />
                </div>
                {l.accounts.map((a: any) => <KV key={a.id} k={`${a.name} ${a.masked}`} v={money(a.balanceMinor, a.currency)} />)}
                <div className="sub-text">{l.transactionCount} transactions{l.consentExpiresAt ? ` · consent until ${l.consentExpiresAt.slice(0, 10)}` : ''}{l.lastSyncedAt ? ` · synced ${new Date(l.lastSyncedAt).toLocaleString()}` : ''}</div>
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  {l.status === 'PENDING' && l.authUrl && <Button size="sm" onClick={() => { window.location.href = l.authUrl; }}>Continue at the bank</Button>}
                  {l.status === 'LINKED' && l.provider !== 'statement_import' && <Button size="sm" variant="secondary" onClick={() => sync(l.id)}>Sync</Button>}
                  {['LINKED', 'PENDING', 'EXPIRED'].includes(l.status) && <Button size="sm" variant="ghost" onClick={() => revoke(l.id)}>Revoke</Button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {tab === 'income' && (
        <div className="card">
          <h3>Verified income</h3>
          {!income || income.confidence === 'none' ? <Empty icon="📄" text="No recurring income found yet. Link a bank or import at least three months of statements." /> : (
            <>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <Chip kind={income.confidence === 'high' ? 'success' : income.confidence === 'medium' ? 'warning' : undefined}>{income.confidence} confidence</Chip>
                <span className="sub-text">{income.monthsCovered} month(s) of statements · computed {new Date(income.computedAt).toLocaleString()}</span>
              </div>
              <KV k="Verified monthly income" v={money(income.monthlyIncomeBase, income.baseCurrency)} />
              {income.streams.map((s: any) => <KV key={s.label + s.currency} k={`${s.label} (${s.months} months)`} v={`${money(s.medianMinor, s.currency)} / month${s.regular ? '' : ' · irregular'}`} />)}
              <p className="sub-text">This feeds your credit readiness signal. It is shared with a lender only through a consent you grant.</p>
            </>
          )}
          <Button variant="secondary" onClick={() => api.get('/api/open-banking/income?refresh=1').then(() => view.reload()).catch(err)}>Recompute</Button>
        </div>
      )}
      {tab === 'mandates' && (
        <div className="grid cols-2">
          <div className="card">
            <h3>New mandate</h3>
            <p className="sub-text">A recurring mandate lets BitriPay draw from your bank within the limits you set: to top up your balance, or to cover a subscription when the wallet is short.</p>
            <Field label="Bank"><Select value={mandate.linkId} onChange={(e) => setMandate({ ...mandate, linkId: e.target.value, accountId: '' })}><option value="">—</option>{linkable.map((l) => <option key={l.id} value={l.id}>{l.institutionName}</option>)}</Select></Field>
            <Field label="Account"><Select value={mandate.accountId} onChange={(e) => setMandate({ ...mandate, accountId: e.target.value })}><option value="">—</option>{(linkable.find((l) => l.id === mandate.linkId)?.accounts ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.name} {a.masked} · {a.currency}</option>)}</Select></Field>
            <Field label="Purpose"><Select value={mandate.purpose} onChange={(e) => setMandate({ ...mandate, purpose: e.target.value })}><option value="top_up">Top up my balance</option><option value="billing">Cover my subscriptions</option></Select></Field>
            <div className="grid cols-2">
              <Field label="Max per payment"><Input inputMode="decimal" value={mandate.maxPerPayment} onChange={(e) => setMandate({ ...mandate, maxPerPayment: e.target.value })} /></Field>
              <Field label="Max per month"><Input inputMode="decimal" value={mandate.maxPerMonth} onChange={(e) => setMandate({ ...mandate, maxPerMonth: e.target.value })} /></Field>
            </div>
            <Button onClick={() => setPin(true)} disabled={!mandate.linkId || !mandate.accountId || !mandate.maxPerPayment || !mandate.maxPerMonth}>Create mandate</Button>
          </div>
          <div className="card">
            <h3>Mandates</h3>
            {(view.data?.mandates ?? []).length === 0 && <Empty icon="🔁" text="No mandate." />}
            {(view.data?.mandates ?? []).map((m: any) => (
              <div key={m.id} className="list-item">
                <div className="flex1"><div className="main-text">{m.institutionName} · {m.purpose === 'billing' ? 'subscriptions' : 'top-ups'}</div><div className="sub-text">up to {money(m.maxPerPaymentMinor, m.currency)} per payment, {money(m.maxPerMonthMinor, m.currency)} a month · used {money(m.usedThisMonthMinor, m.currency)} this month</div></div>
                <StatusBadge status={m.status} />
                {m.status === 'ACTIVE' && <Button size="sm" variant="ghost" onClick={() => api.del(`/api/open-banking/mandates/${m.id}`).then(() => view.reload()).catch(err)}>Revoke</Button>}
              </div>
            ))}
          </div>
        </div>
      )}
      {!view.data && view.error && <Alert kind="error">{view.error}</Alert>}
      <PinModal open={pin} onClose={() => setPin(false)} loading={busy} onSubmit={createMandate} title="Confirm the mandate" summary={`BitriPay may draw up to ${mandate.maxPerPayment} per payment and ${mandate.maxPerMonth} a month from the selected account for ${mandate.purpose === 'billing' ? 'subscriptions' : 'top-ups'}.`} />
    </div>
  );
}
