import { useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, Empty, Field, Input, KV, Modal, PageHeader, PinModal, Select, StatusBadge, Tabs, Textarea, useAsync } from '../components/ui';
import { offlineDevice, offlineQueue } from '../lib/offline';
import { OrganisationTeam } from '../components/OrganisationTeam';
import { MERCHANT_CLASS_ROLES } from '@bitripay/shared';

/**
 * Merchant command centre: balance classes, settlement calendar / cycles / statements, disputes with evidence,
 * effective fees, split payouts, verification level, and the offline acceptance kit (device key, prefetched nonces,
 * pending promises).
 */
export function MerchantCentre() {
  const { user, money, toast, config } = useStore();
  const [tab, setTab] = useState<'overview' | 'settlement' | 'disputes' | 'fees' | 'payouts' | 'plans' | 'offline' | 'team'>('overview');
  const balance = useAsync(() => api.get<any>('/api/v1/balance'), [tab]);
  const calendar = useAsync(() => api.get<any>('/api/v1/settlement_calendar'), [tab]);
  const disputes = useAsync(() => api.get<any>('/api/v1/disputes'), [tab]);
  const verification = useAsync(() => api.get<any>('/api/risk/verification'), [tab]);
  const fees = useAsync(() => (tab === 'fees' ? api.get<any>('/api/v1/fee_schedule') : Promise.resolve(null)), [tab]);
  const aggregation = useAsync(() => (tab === 'fees' ? api.get<any>('/api/v1/fees/aggregation').catch(() => null) : Promise.resolve(null)), [tab]);
  const [payInvoice, setPayInvoice] = useState<any>(null);
  /** The organisation this session acts for (§43): merchant-class owners, administrators and invited members. */
  const org = useAsync(() => api.get<any>('/api/organisations/me').catch(() => null), [tab]);
  const err = (e: any) => toast(e.message, 'error');
  const merchantClass = (MERCHANT_CLASS_ROLES as readonly string[]).includes(user?.role ?? '');
  if (org.loading && !merchantClass && user?.role !== 'admin') return null;
  if (!merchantClass && user?.role !== 'admin' && !org.data?.membership)
    return (
      <Alert kind="info">
        Upgrade to a merchant account under <Link to="/app/merchant">{tr('Merchant')}</Link> to use the command centre.
      </Alert>
    );
  const open = (disputes.data?.data ?? []).filter((d: any) => ['OPEN', 'EVIDENCE_REQUESTED', 'UNDER_REVIEW'].includes(d.status));
  return (
    <div>
      <PageHeader
        title={tr('Command centre')}
        subtitle={tr('What you can spend, what is on its way, what needs your attention')}
        actions={
          <>
            <Link className="btn" to="/app/merchant/qr">
              {tr('🔳 QR centre')}
            </Link>
            <Link className="btn secondary" to="/app/merchant/developer">
              {tr('🧑‍💻 Developer')}
            </Link>
          </>
        }
      />
      <Tabs
        tabs={[
          { id: 'overview', label: tr('Overview') },
          { id: 'settlement', label: tr('Settlement') },
          { id: 'disputes', label: `Disputes${open.length ? ` (${open.length})` : ''}` },
          { id: 'fees', label: tr('My fees') },
          { id: 'payouts', label: tr('Bulk payouts') },
          { id: 'plans', label: tr('Plans & billing') },
          { id: 'offline', label: tr('Offline kit') },
          { id: 'team', label: tr('Team & business units') },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />
      {tab === 'overview' && (
        <>
          <div className="grid cols-4">
            {(balance.data?.data ?? []).map((b: any) => (
              <div className="card" key={b.currency}>
                <div className="stat">
                  <span className="label">{tr('Available · {0}', { 0: b.currency })}</span>
                  <span className="value">{money(b.available, b.currency)}</span>
                  <span className="small muted">balance {money(b.balance, b.currency)}</span>
                </div>
                <div className="mt small">
                  <KV k="Pending in" v={money(b.pending, b.currency)} />
                  <KV k="Awaiting settlement" v={money(b.settlement_pending, b.currency)} />
                  <KV k="Held" v={money(b.held, b.currency)} />
                  <KV k="Disputed" v={money(b.disputed, b.currency)} />
                  {b.frozen ? <KV k="Frozen" v={<Chip kind="danger">{money(b.frozen, b.currency)}</Chip>} /> : null}
                </div>
              </div>
            ))}
            {balance.data?.data?.length === 0 && (
              <div className="card">
                <Empty icon="💼" text={tr('No wallet yet')} />
              </div>
            )}
          </div>
          <div className="grid cols-3 mt">
            <div className="card">
              <h3>{tr('Next settlements')}</h3>
              {(calendar.data?.upcoming ?? []).map((u: any) => (
                <KV
                  key={u.profileId}
                  k={`${u.currency} · ${u.schedule}`}
                  v={
                    <span className="small">
                      cut-off {new Date(u.nextCutoff).toLocaleString()}
                      <br />
                      paid {u.expectedPayout ? new Date(u.expectedPayout).toLocaleDateString() : 'in wallet'}
                    </span>
                  }
                />
              ))}
              {calendar.data?.upcoming?.length === 0 && <p className="small muted">{tr('No settlement profile yet — payments stay in your wallet. Set one under Settlement.')}</p>}
              {calendar.data?.obligations?.cycles?.length > 0 && <Alert kind="info">{calendar.data.obligations.cycles.length} closed cycle(s) awaiting payout.</Alert>}
            </div>
            <div className="card">
              <h3>{tr('Needs attention')}</h3>
              {open.length === 0 && <p className="small muted">{tr('No open disputes.')}</p>}
              {open.slice(0, 5).map((d: any) => (
                <div key={d.id} className="list-item">
                  <div className="flex1">
                    <div className="main-text">
                      {money(d.amount.valueMinor, d.amount.currency)} · {d.reasonCode.replace(/_/g, ' ')}
                    </div>
                    <div className="sub-text">respond by {new Date(d.deadlineAt).toLocaleDateString()}</div>
                  </div>
                  <StatusBadge status={d.status} />
                </div>
              ))}
            </div>
            <div className="card">
              <h3>{tr('Verification level')}</h3>
              {verification.data && (
                <>
                  <div className="value" style={{ fontSize: 20 }}>
                    {verification.data.label}
                  </div>
                  {verification.data.limits ? (
                    <p className="small muted">
                      {tr('Per transaction {0} · daily {1} · monthly {2} (base minor units)', {
                        0: verification.data.limits.perTransaction,
                        1: verification.data.limits.daily,
                        2: verification.data.limits.monthly,
                      })}
                    </p>
                  ) : (
                    <p className="small muted">{tr('Legacy limits apply.')}</p>
                  )}
                  <p className="small">{verification.data.next}</p>
                  <KV k="Business (KYB)" v={<StatusBadge status={verification.data.kybStatus} />} />
                  <Link className="btn secondary" to="/app/settings?tab=kyc">
                    {tr('Verification →')}
                  </Link>
                </>
              )}
            </div>
          </div>
        </>
      )}
      {tab === 'settlement' && <Settlement calendar={calendar} money={money} toast={toast} currencies={(config?.currencies ?? []).map((c) => c.code)} />}
      {tab === 'disputes' && <Disputes disputes={disputes} money={money} toast={toast} />}
      {tab === 'fees' && (
        <div className="card">
          <p className="small muted">{tr('The fee rules that apply to your account right now (merchant &gt; tier &gt; country &gt; platform). Fixed parts are in base-currency minor units.')}</p>
          {fees.data?.tier && (
            <Alert kind="success">
              You are on the <b>{fees.data.tier}</b> tier.
            </Alert>
          )}
          <div className="list">
            {(fees.data?.data ?? []).map((f: any) => (
              <div key={f.type} className="list-item">
                <div className="flex1">
                  <div className="main-text">{f.type.replace(/_/g, ' ')}</div>
                  <div className="sub-text">
                    {f.rule.bps / 100}% + {f.rule.fixed}
                    {f.rule.min ? ` · min ${f.rule.min}` : ''}
                    {f.rule.max ? ` · max ${f.rule.max}` : ''}
                  </div>
                </div>
                <Chip>
                  {f.source.scope}
                  {f.source.version ? ` v${f.source.version}` : ''}
                </Chip>
              </div>
            ))}
          </div>
          {aggregation.data && (
            <div className="mt">
              <h4>{tr('Aggregation fees on national switch payments')}</h4>
              <p className="small muted">
                {tr(
                  'Payments routed through the national switch never pass through your BitriPay balance. The aggregation fee ({0}% per completed payment) is accrued, invoiced per month and paid from your wallet or by bank transfer.',
                  {
                    0: aggregation.data.rate.bps / 100,
                  },
                )}
              </p>
              {aggregation.data.accrued.length === 0 && aggregation.data.invoices.length === 0 && <div className="muted small">{tr('No switch payment completed yet.')}</div>}
              {aggregation.data.accrued.map((a: any) => (
                <KV key={`${a.period}-${a.currency}`} k={`${a.period} · ${a.count} ${tr('payment(s)')} · ${tr('not yet invoiced')}`} v={money(a.total, a.currency)} />
              ))}
              {aggregation.data.invoices.map((inv: any) => (
                <div key={inv.id} className="list-item">
                  <div className="flex1">
                    <div className="main-text">
                      {inv.number} · {inv.period} · {money(inv.total, inv.currency)}
                    </div>
                    <div className="sub-text">
                      {inv.entryCount} {tr('payment(s)')}
                      {inv.paidAt ? ` · ${tr('paid on')} ${new Date(inv.paidAt).toLocaleDateString()}` : ''}
                    </div>
                  </div>
                  <StatusBadge status={inv.status} />
                  {inv.status === 'open' && (
                    <Button size="sm" onClick={() => setPayInvoice(inv)}>
                      {tr('Pay from wallet')}
                    </Button>
                  )}
                </div>
              ))}
              <PinModal
                open={!!payInvoice}
                onClose={() => setPayInvoice(null)}
                title={payInvoice ? `${tr('Pay invoice')} ${payInvoice.number} · ${money(payInvoice.total, payInvoice.currency)}` : ''}
                onSubmit={(pin) =>
                  api
                    .post(`/api/v1/fees/invoices/${payInvoice.id}/pay`, { pin })
                    .then(() => {
                      toast(tr('Invoice paid'), 'success');
                      setPayInvoice(null);
                      aggregation.reload();
                    })
                    .catch(err)
                }
              />
            </div>
          )}
        </div>
      )}
      {tab === 'payouts' && <BulkPayouts money={money} toast={toast} err={err} currencies={(config?.currencies ?? []).map((c) => c.code)} />}
      {tab === 'plans' && <Plans money={money} toast={toast} err={err} currencies={(config?.currencies ?? []).map((c) => c.code)} />}
      {tab === 'offline' && <OfflineKit toast={toast} err={err} />}
      {tab === 'team' && <OrganisationTeam org={org} toast={toast} err={err} kind="merchant" />}
    </div>
  );
}

function Settlement({ calendar, money, toast, currencies }: { calendar: any; money: (m: number, c: string) => string; toast: any; currencies: string[] }) {
  const [form, setForm] = useState<any>({
    currency: currencies[0] ?? 'USD',
    schedule: 'T1',
    cutoff_hour_utc: 22,
    destination: { method: 'wallet' },
    min_amount: 0,
    auto: true,
    settlement_currency: currencies[0] ?? 'USD',
    auto_convert: false,
  });
  const banks = useAsync(() => api.get<{ items: any[] }>('/api/bank-accounts'), []);
  const [statement, setStatement] = useState<any>(null);
  /** Next-cycle preview of one profile: collection vs settlement currency with the conversion and fee lines disclosed. */
  const [preview, setPreview] = useState<any>(null);
  /** A settlement (cycle) with its statement summary from GET /v1/settlements/:id. */
  const [detail, setDetail] = useState<any>(null);
  const err = (e: any) => toast(e.message, 'error');
  const loadPreview = (profileId: string) => api.get<any>(`/api/v1/settlement_profiles/${profileId}/preview`).then(setPreview).catch(err);
  const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
  const save = () =>
    api
      .post('/api/v1/settlement_profiles', form)
      .then(() => {
        toast(tr('Settlement profile saved'), 'success');
        calendar.reload();
      })
      .catch(err);
  const close = (currency: string, pay: boolean) =>
    api
      .post('/api/v1/settlement_cycles', { currency, pay })
      .then((c: any) => {
        toast(`Cycle ${c.status.toLowerCase()} · net ${money(c.netMinor, c.currency)}`, 'success');
        calendar.reload();
      })
      .catch(err);
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>{tr('Settlement profile')}</h3>
        <p className="small muted">{tr('When your collections are paid out, where, and the minimum. T+1 means the day after the cut-off. Destination changes cool off for 24 hours.')}</p>
        <div className="grid cols-2">
          <Field label={tr('Currency')}>
            <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Schedule')}>
            <Select value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })}>
              {['T0', 'T1', 'T2', 'weekly', 'manual'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Cut-off hour (UTC)')}>
            <Input type="number" min={0} max={23} value={form.cutoff_hour_utc} onChange={(e) => setForm({ ...form, cutoff_hour_utc: Number(e.target.value) })} />
          </Field>
          <Field label={tr('Minimum (minor units)')}>
            <Input type="number" min={0} value={form.min_amount} onChange={(e) => setForm({ ...form, min_amount: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label={tr('Destination')}>
          <Select
            value={form.destination.method === 'bank' ? form.destination.bankAccountId : 'wallet'}
            onChange={(e) => setForm({ ...form, destination: e.target.value === 'wallet' ? { method: 'wallet' } : { method: 'bank', bankAccountId: e.target.value } })}
          >
            <option value="wallet">{tr('Keep in my wallet')}</option>
            {(banks.data?.items ?? []).map((b: any) => (
              <option key={b.id} value={b.id}>
                {b.bankName} •••• {String(b.accountNumber).slice(-4)} ({b.currency})
              </option>
            ))}
          </Select>
        </Field>
        <label className="checkbox mb">
          <input type="checkbox" checked={!!form.auto} onChange={(e) => setForm({ ...form, auto: e.target.checked })} /> {tr('Run automatically at the cut-off')}
        </label>
        <div className="grid cols-2">
          <Field label="Paid out in" hint={tr('Collections in another currency are converted at the platform rate; the margin is disclosed on every statement.')}>
            <Select value={form.settlement_currency} onChange={(e) => setForm({ ...form, settlement_currency: e.target.value })}>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Conversion')}>
            <label className="checkbox">
              <input type="checkbox" checked={!!form.auto_convert} disabled={form.settlement_currency === form.currency} onChange={(e) => setForm({ ...form, auto_convert: e.target.checked })} />{' '}
              {form.settlement_currency === form.currency
                ? tr('Same currency — nothing to convert')
                : form.auto_convert
                  ? tr('Convert automatically when the cycle closes')
                  : tr('Convert only when the cycle is paid')}
            </label>
          </Field>
        </div>
        <div className="row">
          <Button onClick={save}>{tr('Save profile')}</Button>
          <Button variant="secondary" onClick={() => close(form.currency, false)}>
            {tr('Close cycle now')}
          </Button>
          <Button variant="ghost" onClick={() => close(form.currency, true)}>
            {tr('Close & pay')}
          </Button>
        </div>
        <h4 className="mt">{tr('Profiles')}</h4>
        {(calendar.data?.profiles ?? []).map((p: any) => (
          <div key={p.id} className="list-item">
            <div className="flex1">
              <div className="main-text">
                {p.currency} · {p.rail}
                {p.settlementCurrency && p.settlementCurrency !== p.currency ? ` → paid in ${p.settlementCurrency}` : ''}
              </div>
              <div className="sub-text">
                {p.schedule} · {p.destination?.method ?? 'wallet'}
                {p.auto ? ' · auto' : ''}
                {p.settlementCurrency && p.settlementCurrency !== p.currency ? (p.autoConvert ? ' · converts at close' : ' · converts at payment') : ''}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => loadPreview(p.id)}>
              {tr('Preview')}
            </Button>
          </div>
        ))}
        {preview && (
          <div className="card mt">
            <h4>
              {tr('Next cycle ·')} {preview.collectionCurrency}
              {preview.settlementCurrency !== preview.collectionCurrency ? ` → ${preview.settlementCurrency}` : ''}
            </h4>
            <p className="small muted">
              {preview.itemCount} item{preview.itemCount === 1 ? '' : 's'} since {String(preview.periodFrom).slice(0, 10)}
              {preview.wouldSkip ? ' — nothing to settle yet' : ''}
            </p>
            <KV k="Gross collections" v={preview.totals.formatted.gross} />
            <KV k="Provider (rail) fee" v={preview.totals.formatted.providerFees} />
            <KV k="BitriPay fee" v={preview.totals.formatted.platformFees} />
            <KV k={`Tax on BitriPay fee (${pct(preview.taxRateBps)})`} v={preview.totals.formatted.feeTax} />
            <KV k="Refunds" v={preview.totals.formatted.refunds} />
            <KV k="Splits" v={preview.totals.formatted.splits} />
            <KV k="Holds" v={preview.totals.formatted.holds} />
            <KV k={`Net in ${preview.collectionCurrency}`} v={<b>{preview.totals.formatted.net}</b>} />
            {preview.settlement.conversion ? (
              <>
                <KV
                  k="Rate"
                  v={`1 ${preview.collectionCurrency} = ${Number(preview.settlement.conversion.rate).toFixed(6)} ${preview.settlementCurrency} (mid ${Number(preview.settlement.conversion.midRate).toFixed(6)})`}
                />
                <KV k="Margin" v={`${preview.settlement.conversion.marginBps} bps (${pct(preview.settlement.conversion.marginBps)})`} />
                <KV k={`Paid in ${preview.settlementCurrency}`} v={<b>{preview.settlement.formatted}</b>} />
                <p className="small muted">
                  {tr('Converted')} {preview.settlement.convertsAt === 'close' ? 'when the cycle closes' : 'when the cycle is paid'}; the exchange is posted in your ledger with this rate.
                </p>
              </>
            ) : (
              preview.settlementCurrency !== preview.collectionCurrency && (
                <p className="small muted">{tr('The conversion into {0} is quoted once there is something to settle.', { 0: preview.settlementCurrency })}</p>
              )
            )}
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
              {tr('Close preview')}
            </Button>
          </div>
        )}
      </div>
      <div className="card">
        <h3>{tr('Cycles & statements')}</h3>
        {(calendar.data?.recent ?? []).length === 0 && <Empty icon="📅" text={tr('No cycles yet')} />}
        <div className="list">
          {(calendar.data?.recent ?? []).map((c: any) => (
            <div key={c.id} className="list-item">
              <div className="flex1">
                <div className="main-text">
                  {c.businessDate} · {money(c.netMinor, c.currency)} net
                </div>
                <div className="sub-text">
                  gross {money(c.grossMinor, c.currency)} · fees {money(c.feesMinor, c.currency)} · refunds {money(c.refundsMinor, c.currency)} · splits {money(c.splitsMinor, c.currency)} · holds{' '}
                  {money(c.holdsMinor, c.currency)} · {c.itemCount} items
                  {c.settlementCurrency && c.settlementCurrency !== c.currency
                    ? ` · paid ${money(c.settlementAmountMinor, c.settlementCurrency)}${c.conversion?.transactionId ? ' (converted)' : c.conversion ? ' (quoted)' : ''}`
                    : ''}
                </div>
              </div>
              <StatusBadge status={c.status} />
              <div className="row">
                <Button size="sm" variant="ghost" onClick={() => api.get(`/api/v1/settlements/${c.id}`).then(setDetail).catch(err)}>
                  {tr('Detail')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => api.get(`/api/v1/settlement_cycles/${c.id}/statement`).then(setStatement).catch(err)}>
                  {tr('Statement')}
                </Button>
                <a className="btn ghost sm" href={`/api/v1/settlement_cycles/${c.id}/statement?format=csv`} target="_blank" rel="noreferrer">
                  CSV
                </a>
                <a className="btn ghost sm" href={`/api/v1/settlement_cycles/${c.id}/statement?format=pdf`} target="_blank" rel="noreferrer">
                  PDF
                </a>
                {c.status === 'CLOSED' && (
                  <Button
                    size="sm"
                    onClick={() =>
                      api
                        .post(`/api/v1/settlement_cycles/${c.id}/pay`, {})
                        .then(() => {
                          toast(tr('Payout requested'), 'success');
                          calendar.reload();
                        })
                        .catch(err)
                    }
                  >
                    {tr('Pay')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        <Modal open={!!statement} onClose={() => setStatement(null)} title={statement?.number} wide>
          {statement && (
            <>
              <KV k="Merchant" v={statement.merchant.name} />
              <KV k="Period" v={`${statement.cycle.periodFrom.slice(0, 10)} → ${statement.cycle.periodTo.slice(0, 10)}`} />
              <KV k="Gross" v={statement.totals.formatted.gross} />
              <KV k="Provider (rail) fee" v={statement.totals.formatted.providerFees} />
              <KV k="BitriPay fee" v={statement.totals.formatted.platformFees} />
              <KV k={`Tax on BitriPay fee (${statement.totals.taxLabel ?? 'tax'} ${pct(statement.totals.taxRateBps ?? 0)})`} v={statement.totals.formatted.feeTax} />
              <KV k="Net" v={statement.totals.formatted.net} />
              {statement.settlement && statement.settlement.currency !== statement.currency && (
                <KV
                  k={`Paid in ${statement.settlement.currency}`}
                  v={`${statement.settlement.formatted}${statement.settlement.conversion ? ` at ${Number(statement.settlement.conversion.rate).toFixed(6)} (margin ${statement.settlement.conversion.marginBps} bps)` : ''}`}
                />
              )}
              <KV k="Hash" v={<span className="mono tiny">{statement.hash}</span>} />
              <div className="list mt">
                {statement.items.map((i: any) => (
                  <div key={i.id} className="list-item">
                    <div className="flex1">
                      <div className="main-text">
                        {i.kind} · {i.reference}
                      </div>
                      <div className="sub-text">
                        {i.occurredAt}
                        {i.kind === 'payment'
                          ? ` · provider ${money(i.providerFeeMinor ?? 0, statement.currency)} · BitriPay ${money(i.platformFeeMinor ?? 0, statement.currency)} · tax ${money(i.feeTaxMinor ?? 0, statement.currency)}`
                          : ''}
                      </div>
                    </div>
                    <b>{money(i.amountMinor, statement.currency)}</b>
                  </div>
                ))}
              </div>
            </>
          )}
        </Modal>
        <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `Settlement ${detail.statement?.number ?? detail.id}` : undefined} wide>
          {detail && (
            <>
              <KV k="Status" v={<StatusBadge status={detail.status} />} />
              <KV k="Business date" v={detail.businessDate} />
              <KV k="Gross" v={detail.statement.totals.formatted.gross} />
              <KV k="Provider (rail) fee" v={detail.statement.totals.formatted.providerFees} />
              <KV k="BitriPay fee" v={detail.statement.totals.formatted.platformFees} />
              <KV k={`Tax on BitriPay fee (${detail.statement.totals.taxLabel ?? 'tax'} ${pct(detail.statement.totals.taxRateBps ?? 0)})`} v={detail.statement.totals.formatted.feeTax} />
              <KV k="Refunds" v={detail.statement.totals.formatted.refunds} />
              <KV k="Splits" v={detail.statement.totals.formatted.splits} />
              <KV k="Holds" v={detail.statement.totals.formatted.holds} />
              <KV k={`Net in ${detail.currency}`} v={<b>{detail.statement.totals.formatted.net}</b>} />
              {detail.settlementCurrency !== detail.currency && (
                <>
                  <KV k={`Paid in ${detail.settlementCurrency}`} v={<b>{detail.statement.settlement.formatted}</b>} />
                  {detail.conversion && (
                    <KV
                      k="Conversion"
                      v={`1 ${detail.currency} = ${Number(detail.conversion.rate).toFixed(6)} ${detail.settlementCurrency} · mid ${Number(detail.conversion.midRate).toFixed(6)} · margin ${detail.conversion.marginBps} bps · ${
                        detail.conversion.transactionId ? `posted ${detail.conversion.transactionId}` : 'quoted, posted at payment'
                      }`}
                    />
                  )}
                </>
              )}
              {detail.dueAt && <KV k="Due" v={String(detail.dueAt).slice(0, 10)} />}
              <KV k="Hash" v={<span className="mono tiny">{detail.hash}</span>} />
            </>
          )}
        </Modal>
      </div>
    </div>
  );
}

function Disputes({ disputes, money, toast }: { disputes: any; money: (m: number, c: string) => string; toast: any }) {
  const [sel, setSel] = useState<any>(null);
  const [text, setText] = useState('');
  const detail = useAsync(() => (sel ? api.get<any>(`/api/v1/disputes/${sel}`) : Promise.resolve(null)), [sel, disputes.data]);
  const err = (e: any) => toast(e.message, 'error');
  const respond = () =>
    api
      .post(`/api/v1/disputes/${sel}/respond`, { response: text })
      .then(() => {
        toast(tr('Response sent'), 'success');
        setText('');
        disputes.reload();
      })
      .catch(err);
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>{tr('Disputes')}</h3>
        <p className="small muted">
          Response windows:{' '}
          {Object.entries(disputes.data?.settings?.responseDays ?? {})
            .map(([k, v]) => `${k} ${v}d`)
            .join(' · ')}
        </p>
        {(disputes.data?.data ?? []).length === 0 && <Empty icon="⚖️" text={tr('No disputes')} />}
        <div className="list">
          {(disputes.data?.data ?? []).map((d: any) => (
            <div key={d.id} className="list-item" onClick={() => setSel(d.id)} style={{ cursor: 'pointer' }}>
              <div className="flex1">
                <div className="main-text">
                  {money(d.amount.valueMinor, d.amount.currency)} · {d.reasonCode.replace(/_/g, ' ')}
                </div>
                <div className="sub-text">
                  {d.openedBy} · {d.rail} · deadline {new Date(d.deadlineAt).toLocaleDateString()}
                </div>
              </div>
              <StatusBadge status={d.status} />
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        {!detail.data && <Empty icon="📂" text={tr('Select a dispute')} />}
        {detail.data && (
          <>
            <h3>
              {detail.data.reasonCode.replace(/_/g, ' ')} · <StatusBadge status={detail.data.status} />
            </h3>
            <KV k="Amount" v={money(detail.data.amount.valueMinor, detail.data.amount.currency)} />
            <KV k="Opened by" v={detail.data.openedBy} />
            <KV k="Deadline" v={new Date(detail.data.deadlineAt).toLocaleString()} />
            {detail.data.decision && <KV k="Decision" v={`${detail.data.decision}: ${detail.data.decisionReason ?? ''}`} />}
            <h4 className="mt">{tr('Evidence')}</h4>
            {detail.data.evidence.map((e: any, i: number) => (
              <div key={i} className="card soft compact small">
                <b>{e.role}</b> · {new Date(e.at).toLocaleString()}
                <br />
                {e.text}
                {e.files?.length ? <div className="tiny muted">files: {e.files.join(', ')}</div> : null}
              </div>
            ))}
            {['OPEN', 'EVIDENCE_REQUESTED'].includes(detail.data.status) && (
              <>
                <Field label={tr('Your response')}>
                  <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={tr('What happened, with delivery proof, invoice numbers, signatures…')} />
                </Field>
                <Button onClick={respond} disabled={text.length < 5}>
                  {tr('Send response')}
                </Button>
              </>
            )}
            <h4 className="mt">{tr('Chronology')}</h4>
            <div className="list">
              {(detail.data.chronology ?? []).map((e: any, i: number) => (
                <div key={i} className="list-item">
                  <div className="flex1">
                    <div className="main-text">{e.event}</div>
                    <div className="sub-text">
                      {new Date(e.at).toLocaleString()} · {e.actor}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function OfflineKit({ toast, err }: { toast: any; err: (e: any) => void }) {
  const settings = useAsync(() => api.get<any>('/api/v1/offline/settings'), []);
  const devices = useAsync(() => api.get<any>('/api/v1/offline/devices'), []);
  const promises = useAsync(() => api.get<any>('/api/v1/offline/promises'), []);
  const [local, setLocal] = useState<{ deviceId: string | null; keyId: string | null; nonces: number; queued: number; supported: boolean }>({
    deviceId: null,
    keyId: null,
    nonces: 0,
    queued: 0,
    supported: true,
  });
  const refreshLocal = async () => {
    const d = await offlineDevice.status();
    setLocal({ deviceId: d.deviceId, keyId: d.keyId, nonces: d.nonces, queued: await offlineQueue.count(), supported: d.supported });
  };
  useEffect(() => {
    void refreshLocal();
  }, []);
  const provision = async () => {
    try {
      const d = await offlineDevice.provision(navigator.userAgent.includes('Mobile') ? 'Phone' : 'Browser');
      toast(`Device ${d.deviceId} ready until ${new Date(d.keyNotAfter).toLocaleString()}`, 'success');
      await refreshLocal();
      devices.reload();
    } catch (e) {
      err(e);
    }
  };
  const prefetch = async () => {
    try {
      const n = await offlineDevice.prefetchNonces(20);
      toast(`${n} offline codes stored on this device`, 'success');
      await refreshLocal();
    } catch (e) {
      err(e);
    }
  };
  const sync = async () => {
    try {
      const r = await offlineQueue.sync();
      toast(`Synced: ${r.settled} settled, ${r.rejected} rejected, ${r.duplicates} duplicates`, r.rejected ? 'error' : 'success');
      await refreshLocal();
      promises.reload();
    } catch (e) {
      err(e);
    }
  };
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>{tr('Offline acceptance')}</h3>
        <p className="small muted">
          When the network is down this device shows signed offline codes and customers' phones sign a promise. Money moves only when either side is back online and the platform confirms; nothing is
          final before that. Ceiling per payment: {settings.data?.maxPerPromiseBase} base minor units; device keys last {settings.data ? Math.round(settings.data.promiseValidityHours) : 72} hours.
        </p>
        {!local.supported && <Alert kind="warning">{tr('This browser cannot generate the device key (Ed25519 WebCrypto). Use a recent Chrome, Edge, Safari or the mobile app.')}</Alert>}
        <KV k="This device" v={local.deviceId ? <span className="mono small">{local.deviceId}</span> : <span className="muted">not provisioned</span>} />
        <KV k="Key" v={local.keyId ? <span className="mono small">{local.keyId}</span> : '—'} />
        <KV k="Offline codes stored" v={local.nonces} />
        <KV k="Promises waiting to sync" v={local.queued} />
        <div className="row mt">
          <Button onClick={provision} disabled={!local.supported}>
            {local.deviceId ? tr('Renew device key') : tr('Provision this device')}
          </Button>
          <Button variant="secondary" onClick={prefetch} disabled={!local.deviceId}>
            {tr('Prefetch codes')}
          </Button>
          <Button variant="ghost" onClick={sync} disabled={!local.queued}>
            {tr('Sync now')}
          </Button>
        </div>
        <p className="small mt">
          Offline codes are issued from the <Link to="/app/merchant/qr">{tr('QR centre')}</Link> (“Offline code”) and customers pay them from <Link to="/app/scan">{tr('Scan')}</Link> even without
          signal.
        </p>
      </div>
      <div className="card">
        <h3>{tr('Devices & recent promises')}</h3>
        {(devices.data?.data ?? []).map((d: any) => (
          <KV
            key={d.deviceId}
            k={d.label ?? d.deviceId}
            v={
              <span className="small">
                key {d.keyId} · until {new Date(d.keyNotAfter).toLocaleString()} · counter {d.lastCounter}
              </span>
            }
          />
        ))}
        <div className="list mt">
          {(promises.data?.data ?? []).slice(0, 20).map((p: any) => (
            <div key={p.hash} className="list-item">
              <div className="flex1">
                <div className="main-text">
                  {p.amountMinor / 100} {p.currency} · {p.reference ?? p.hash.slice(0, 10)}
                </div>
                <div className="sub-text">
                  {p.syncedAt ? new Date(p.syncedAt).toLocaleString() : ''}
                  {p.rejectReason ? ` · ${p.rejectReason.replace(/_/g, ' ')}` : ''}
                </div>
              </div>
              <StatusBadge status={p.state} />
            </div>
          ))}
        </div>
        {promises.data?.data?.length === 0 && <Empty icon="📡" text={tr('No offline promises yet')} />}
      </div>
    </div>
  );
}
export { qs };

/** Bulk payouts: upload rows or CSV, see every row validated with its reason, approve with the PIN, follow per-row outcomes. */
function BulkPayouts({
  money,
  toast,
  err,
  currencies,
}: {
  money: (m: number, c: string) => string;
  toast: (m: string, k?: 'success' | 'error' | 'info') => void;
  err: (e: any) => void;
  currencies: string[];
}) {
  const batches = useAsync(() => api.get<any>('/api/v1/payouts/batches'), []);
  const columns = useAsync(() => api.get<any>('/api/v1/payouts/batches/columns'), []);
  const [currency, setCurrency] = useState(currencies[0] ?? 'USD');
  const [csv, setCsv] = useState('');
  const [reference, setReference] = useState('');
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [selected, setSelected] = useState<any>(null);
  const [pinFor, setPinFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (id: string) => api.get<any>(`/api/v1/payouts/batches/${id}`).then(setSelected).catch(err);
  const upload = () => {
    if (!csv.trim()) return toast(tr('Paste or load a CSV first'), 'error');
    setBusy(true);
    api
      .post<any>('/api/v1/payouts/batches', { currency, csv, reference: reference || null, skip_invalid: skipInvalid })
      .then((r) => {
        setSelected(r);
        setCsv('');
        batches.reload();
        toast(`${r.batch.validRows} valid row(s), ${r.batch.invalidRows} invalid`, r.batch.invalidRows ? 'info' : 'success');
      })
      .catch(err)
      .finally(() => setBusy(false));
  };
  const file = (f: File | null) => {
    if (!f) return;
    f.text().then(setCsv);
  };
  const approve = (pin: string) => {
    if (!pinFor) return;
    setBusy(true);
    api
      .post<any>(`/api/v1/payouts/batches/${pinFor}/approve`, { pin })
      .then((r) => {
        setPinFor(null);
        setSelected({ batch: r.batch, readiness: selected?.readiness });
        batches.reload();
        toast(r.batch.status === 'EXECUTED' ? 'Batch paid' : `Batch ${r.batch.status.toLowerCase()}`, r.batch.status === 'EXECUTED' ? 'success' : 'info');
      })
      .catch(err)
      .finally(() => setBusy(false));
  };
  const cancel = (id: string) =>
    api
      .post<any>(`/api/v1/payouts/batches/${id}/cancel`, {})
      .then((r) => {
        setSelected({ batch: r.batch, readiness: null });
        batches.reload();
      })
      .catch(err);
  const b = selected?.batch;
  const readiness = selected?.readiness;
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>{tr('New batch')}</h3>
        <p className="sub-text">
          One row per payment. Columns: {columns.data?.columns?.join(', ') ?? '…'}. Up to {columns.data?.max_rows ?? 5000} rows. Every row is checked before you approve; nothing moves until you
          confirm with your PIN.
        </p>
        <div className="grid cols-2">
          <Field label={tr('Currency')}>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Reference')}>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="PAYROLL-09" />
          </Field>
        </div>
        <Field label="CSV">
          <Textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={columns.data?.example ?? 'method,amount,wallet,operator_id,phone,name,reference'} />
        </Field>
        <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" accept=".csv,text/csv" onChange={(e) => file(e.target.files?.[0] ?? null)} />
          <label className="row" style={{ gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} /> {tr('Skip invalid rows')}
          </label>
          <Button loading={busy} onClick={upload}>
            {tr('Validate batch')}
          </Button>
        </div>
        <h4 style={{ marginTop: 16 }}>{tr('Batches')}</h4>
        {(batches.data?.data ?? []).length === 0 && <Empty icon="📑" text={tr('No batch yet.')} />}
        {(batches.data?.data ?? []).map((x: any) => (
          <div key={x.id} className="list-item clickable" onClick={() => load(x.id)}>
            <div className="flex1">
              <div className="main-text">
                {x.reference ?? x.id} <StatusBadge status={x.status} />
              </div>
              <div className="sub-text">
                {x.rowCount} rows · {money(x.totalMinor, x.currency)} · {new Date(x.createdAt).toLocaleString()}
              </div>
            </div>
            <div className="sub-text">
              {x.paidRows}/{x.validRows} paid
            </div>
          </div>
        ))}
      </div>
      <div className="card">
        {!b && <Empty icon="🧾" text={tr('Select a batch to see its rows.')} />}
        {b && (
          <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <h3>
                {b.reference ?? b.id} <StatusBadge status={b.status} />
              </h3>
              <div className="row" style={{ gap: 6 }}>
                {b.status === 'PENDING_APPROVAL' && (
                  <Button size="sm" onClick={() => setPinFor(b.id)} disabled={readiness?.blockedByInvalidRows || (readiness?.shortfallMinor ?? 0) > 0}>
                    {tr('Approve & pay')}
                  </Button>
                )}
                {b.status === 'PENDING_APPROVAL' && (
                  <Button size="sm" variant="ghost" onClick={() => cancel(b.id)}>
                    {tr('Cancel')}
                  </Button>
                )}
              </div>
            </div>
            <div className="grid cols-2">
              <KV k="Rows" v={`${b.rowCount} (${b.validRows} valid, ${b.invalidRows} invalid)`} />
              <KV k="Total + fees" v={`${money(b.totalMinor, b.currency)} + ${money(b.feeMinor, b.currency)}`} />
              <KV k="Paid" v={`${b.paidRows} rows · ${money(b.paidMinor, b.currency)}`} />
              <KV k="Approval" v={b.approvalMethod ? `${b.approvalMethod.replace('_', ' ')} · ${new Date(b.approvedAt).toLocaleString()}` : 'pending'} />
            </div>
            {readiness?.blockedByInvalidRows && <Alert kind="warning">{readiness.invalidRows} row(s) are invalid. Fix the file, or upload again with "Skip invalid rows".</Alert>}
            {(readiness?.shortfallMinor ?? 0) > 0 && <Alert kind="error">{tr('Available balance is {0} short of the total with fees.', { 0: money(readiness.shortfallMinor, b.currency) })}</Alert>}
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>To</th>
                    <th>{tr('Amount')}</th>
                    <th>{tr('Ref')}</th>
                    <th>{tr('Status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r: any) => (
                    <tr key={r.id}>
                      <td>{r.lineNo}</td>
                      <td>
                        {r.name ?? ''}{' '}
                        <span className="sub-text">
                          {r.method === 'wallet'
                            ? r.destination.to
                            : r.method === 'mobile_money'
                              ? `${r.destination.operatorId} ${r.destination.phone}`
                              : (r.destination.bankName ?? r.destination.bankAccountId)}
                        </span>
                      </td>
                      <td>{money(r.amountMinor, b.currency)}</td>
                      <td>{r.reference ?? ''}</td>
                      <td>
                        <StatusBadge status={r.status} />
                        {r.error && (
                          <div className="sub-text" style={{ color: 'var(--danger)' }}>
                            {r.error}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <PinModal
        open={!!pinFor}
        onClose={() => setPinFor(null)}
        onSubmit={approve}
        loading={busy}
        title={tr('Approve and pay this batch')}
        summary={b ? `${b.validRows} payments · ${money(b.totalMinor + b.feeMinor, b.currency)} including fees. Rows run in order; a failed row never blocks the next.` : ''}
      />
    </div>
  );
}

/** Subscription plans and billing: create plans (interval, trial, tax, metered usage), watch subscriptions, invoices and dunning. */
function Plans({
  money,
  toast,
  err,
  currencies,
}: {
  money: (m: number, c: string) => string;
  toast: (m: string, k?: 'success' | 'error' | 'info') => void;
  err: (e: any) => void;
  currencies: string[];
}) {
  const plans = useAsync(() => api.get<any>('/api/v1/plans'), []);
  const subs = useAsync(() => api.get<any>('/api/v1/subscriptions'), []);
  const [form, setForm] = useState({
    name: '',
    description: '',
    currency: currencies[0] ?? 'USD',
    amount: '',
    interval: 'month',
    trialDays: '0',
    taxBps: '0',
    taxLabel: '',
    usageUnit: '',
    usagePrice: '',
  });
  const [usage, setUsage] = useState<Record<string, string>>({});
  const create = () =>
    api
      .post<any>('/api/v1/plans', {
        name: form.name,
        description: form.description || null,
        currency: form.currency,
        amount_minor: Math.round(Number(form.amount || '0') * 100),
        interval: form.interval,
        trial_days: Number(form.trialDays) || 0,
        tax_bps: Number(form.taxBps) || 0,
        tax_label: form.taxLabel || null,
        usage_unit: form.usageUnit || null,
        usage_price_minor: Math.round(Number(form.usagePrice || '0') * 100),
      })
      .then((r) => {
        plans.reload();
        toast(`Plan created · code ${r.plan.code}`, 'success');
        setForm({ ...form, name: '', description: '', amount: '' });
      })
      .catch(err);
  const record = (id: string) =>
    api
      .post(`/api/v1/subscriptions/${id}/usage`, { quantity: Number(usage[id] || '0') })
      .then(() => {
        subs.reload();
        setUsage({ ...usage, [id]: '' });
        toast(tr('Usage recorded'), 'success');
      })
      .catch(err);
  const ov = subs.data?.overview;
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>{tr('New plan')}</h3>
        <div className="grid cols-2">
          <Field label={tr('Name')}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={tr('Home 20 Mbps')} />
          </Field>
          <Field label={tr('Currency')}>
            <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label={tr('Price per period')}>
            <Input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="10.00" />
          </Field>
          <Field label={tr('Every')}>
            <Select value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })}>
              <option value="day">day</option>
              <option value="week">week</option>
              <option value="month">month</option>
              <option value="year">year</option>
            </Select>
          </Field>
          <Field label={tr('Trial days')}>
            <Input inputMode="numeric" value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: e.target.value })} />
          </Field>
          <Field label={tr('Tax (basis points)')} hint="1600 = 16%">
            <Input inputMode="numeric" value={form.taxBps} onChange={(e) => setForm({ ...form, taxBps: e.target.value })} />
          </Field>
          <Field label={tr('Tax label')}>
            <Input value={form.taxLabel} onChange={(e) => setForm({ ...form, taxLabel: e.target.value })} placeholder="VAT" />
          </Field>
          <Field label={tr('Metered unit (optional)')}>
            <Input value={form.usageUnit} onChange={(e) => setForm({ ...form, usageUnit: e.target.value })} placeholder="GB" />
          </Field>
          <Field label={tr('Price per unit')}>
            <Input inputMode="decimal" value={form.usagePrice} onChange={(e) => setForm({ ...form, usagePrice: e.target.value })} placeholder="0.50" />
          </Field>
        </div>
        <Field label={tr('Description')}>
          <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Button onClick={create} disabled={!form.name || !form.amount}>
          {tr('Create plan')}
        </Button>
        <h4 style={{ marginTop: 16 }}>{tr('Plans')}</h4>
        {(plans.data?.data ?? []).map((p: any) => (
          <div key={p.id} className="list-item">
            <div className="flex1">
              <div className="main-text">
                {p.name} <code>{p.code}</code>
              </div>
              <div className="sub-text">
                {money(p.amountMinor, p.currency)} / {p.interval}
                {p.taxBps ? ` + ${p.taxBps / 100}% ${p.taxLabel ?? 'tax'}` : ''}
                {p.usageUnit ? ` · ${money(p.usagePriceMinor, p.currency)} per ${p.usageUnit}` : ''}
                {p.trialDays ? ` · ${p.trialDays}-day trial` : ''}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                api
                  .post(`/api/v1/plans/${p.id}/archive`, {})
                  .then(() => plans.reload())
                  .catch(err)
              }
            >
              {tr('Archive')}
            </Button>
          </div>
        ))}
      </div>
      <div className="card">
        <h3>{tr('Subscriptions')}</h3>
        {ov && (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {Object.entries(ov.byStatus).map(([k, v]) => (
              <Chip key={k}>
                {k} {v as number}
              </Chip>
            ))}
            {ov.monthlyRecurring.map((m: any) => (
              <Chip key={m.currency} kind="success">
                {tr('MRR {0}', { 0: money(m.minor, m.currency) })}
              </Chip>
            ))}
            {ov.collected30d.map((c: any) => (
              <Chip key={c.currency}>{tr('30d {0} · {1} inv.', { 0: money(c.minor, c.currency), 1: c.invoices })}</Chip>
            ))}
          </div>
        )}
        {(subs.data?.data ?? []).length === 0 && <Empty icon="🔄" text={tr('No subscriber yet. Share a plan code.')} />}
        {(subs.data?.data ?? []).map((s: any) => (
          <div key={s.id} className="list-item" style={{ display: 'block' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="main-text">
                {s.plan.name} · {s.customerId.slice(0, 8)}
              </div>
              <StatusBadge status={s.status} />
            </div>
            <div className="sub-text">
              next {new Date(s.nextChargeAt).toLocaleDateString()}
              {s.usageQty ? ` · ${s.usageQty} ${s.plan.usageUnit} this period` : ''}
              {s.lastError ? ` · ${s.lastError}` : ''}
            </div>
            {s.plan.usageUnit && ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(s.status) && (
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <Input inputMode="numeric" style={{ maxWidth: 120 }} value={usage[s.id] ?? ''} onChange={(e) => setUsage({ ...usage, [s.id]: e.target.value })} placeholder={s.plan.usageUnit} />
                <Button size="sm" variant="secondary" onClick={() => record(s.id)} disabled={!usage[s.id]}>
                  {tr('Record usage')}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
