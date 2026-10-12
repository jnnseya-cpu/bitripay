import { useState } from 'react';
import { tr } from '../lib/i18n';
import { countryLabel } from '@bitripay/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, Field, Input, KV, Modal, PageHeader, Select, Table, Tabs, Textarea, fmtDate, useAsync } from '../components/ui';

const STATUS_KIND: Record<string, 'success' | 'warning' | 'danger' | 'primary' | undefined> = {
  live: 'success',
  active: 'success',
  met: 'success',
  answered: 'success',
  reconciled: 'success',
  executed: 'success',
  remedied: 'success',
  sandbox: 'primary',
  approved: 'primary',
  instructed: 'primary',
  confirmed: 'primary',
  in_progress: 'primary',
  open: 'warning',
  proposed: 'warning',
  closed: 'warning',
  shortfall: 'danger',
  remedy_pending: 'warning',
  blocked: 'danger',
  missed: 'danger',
  failed: 'danger',
  rejected: 'danger',
  suspended: 'danger',
};
const S = ({ v }: { v: string }) => <Chip kind={STATUS_KIND[v]}>{String(v).replace(/_/g, ' ')}</Chip>;

type Tab = 'posture' | 'counterparties' | 'settlement' | 'treasury' | 'iso20022' | 'safeguarding' | 'pnl' | 'readiness';

/**
 * Corridor network: the regulatory posture of each corridor, the counterparties that hold the money, their
 * positions and settlement, prefunding under four eyes, the ISO 20022 exchange with a sponsor bank, the daily
 * safeguarding evidence, corridor profitability and the phase gates.
 */
export function Network() {
  const { toast, money, config } = useStore();
  const [tab, setTab] = useState<Tab>('posture');
  const on = config?.modules?.corridorNetwork !== false;

  const overview = useAsync(() => (tab === 'posture' || tab === 'counterparties' ? api.get<any>('/api/admin/network/overview') : Promise.resolve(null)), [tab]);
  const settlement = useAsync(() => (tab === 'settlement' ? api.get<any>('/api/admin/network/settlement') : Promise.resolve(null)), [tab]);
  const treasury = useAsync(() => (tab === 'treasury' ? api.get<any>('/api/admin/network/treasury') : Promise.resolve(null)), [tab]);
  const messages = useAsync(() => (tab === 'iso20022' ? api.get<any>('/api/admin/network/iso20022') : Promise.resolve(null)), [tab]);
  const safeguarding = useAsync(() => (tab === 'safeguarding' ? api.get<any>('/api/admin/network/safeguarding') : Promise.resolve(null)), [tab]);
  const pnl = useAsync(() => (tab === 'pnl' ? api.get<any>('/api/admin/network/pnl') : Promise.resolve(null)), [tab]);
  const readiness = useAsync(() => (tab === 'readiness' ? api.get<any>('/api/admin/network/readiness') : Promise.resolve(null)), [tab]);
  const gates = useAsync(() => (tab === 'readiness' ? api.get<any>('/api/admin/network/gates') : Promise.resolve(null)), [tab]);
  const questions = useAsync(() => (tab === 'readiness' ? api.get<any>('/api/admin/network/questions') : Promise.resolve(null)), [tab]);

  const [flagFor, setFlagFor] = useState<{ code: string; flag: 'papss' | 'stablecoin'; on: boolean; reason: string } | null>(null);
  const [movement, setMovement] = useState<any>(null);
  const [topup, setTopup] = useState<any>(null);
  const [importXml, setImportXml] = useState<{ xml: string; counterpartyId: string } | null>(null);
  const [answering, setAnswering] = useState<{ ref: string; question: string; answer: string } | null>(null);
  const [gateEdit, setGateEdit] = useState<any>(null);

  const reload = () => {
    overview.reload();
    settlement.reload();
    treasury.reload();
    messages.reload();
    safeguarding.reload();
    pnl.reload();
    readiness.reload();
    gates.reload();
    questions.reload();
  };
  const ok = (msg: string) => {
    toast(msg, 'success');
    reload();
  };
  const err = (e: any) => toast(e.message, 'error');

  return (
    <div>
      <PageHeader
        title={tr('Corridor network')}
        subtitle={tr('Under which phase, which licence and which custody model each corridor runs — and the counterparties, settlement, prefunding, safeguarding and gates behind it.')}
      />
      {!on && (
        <Alert kind="warning">
          <b>{tr('Switched off.')}</b>{' '}
          {tr(
            'The corridor network describes capabilities that depend on authorisations and partners that are not in place yet. It stays off until an administrator switches it on in Modules, and nothing here is offered to a customer while it is off.',
          )}
        </Alert>
      )}
      <Tabs
        tabs={[
          { id: 'posture', label: tr('Phases & corridors') },
          { id: 'counterparties', label: tr('Counterparties & float') },
          { id: 'settlement', label: tr('Positions & settlement') },
          { id: 'treasury', label: tr('Treasury') },
          { id: 'iso20022', label: tr('Sponsor messages') },
          { id: 'safeguarding', label: tr('Safeguarding') },
          { id: 'pnl', label: tr('Corridor P&L') },
          { id: 'readiness', label: tr('Gates & questions') },
        ]}
        value={tab}
        onChange={(t) => setTab(t as Tab)}
      />

      {tab === 'posture' && overview.data && (
        <>
          <div className="cards">
            {overview.data.phases.map((p: any) => (
              <div className="card" key={p.phase}>
                <h3>
                  {tr('Phase')} {p.phase} · {tr(p.name)}
                </h3>
                <KV k={tr('Window')} v={tr(p.window)} />
                <KV k={tr('Role')} v={tr(p.role)} />
                <KV k={tr('Holds customer funds')} v={tr(String(p.holdsCustomerFunds).replace(/_/g, ' '))} />
                <KV k={tr('Corridors')} v={`${p.live} ${tr('live')} / ${p.corridors}`} />
              </div>
            ))}
          </div>
          <Table
            head={[tr('Corridor'), tr('Route'), tr('Phase'), tr('Custody'), tr('Rails'), tr('Settlement options'), tr('Status'), tr('Ready')]}
            empty={tr('No corridor is declared yet.')}
            rows={(overview.data.corridors ?? []).map((c: any) => [
              <>
                <b>{c.code}</b>
                <div className="muted">{c.name}</div>
              </>,
              <>
                {countryLabel(c.sourceCountry)} {c.sourceCurrency} → {countryLabel(c.destCountry)} {c.destCurrency}
                <div className="muted">
                  {tr('settles in')} {c.settlementCurrency}
                </div>
              </>,
              <>
                {c.phase} · {tr(c.phaseName)}
              </>,
              <>
                {tr(c.regulatoryLabel)}
                <div className="muted">{c.licenceBasis ?? tr('no licence basis recorded')}</div>
              </>,
              <>
                {(c.collectionRails ?? []).join(', ') || '—'}
                <div className="muted">→ {(c.payoutRails ?? []).join(', ') || '—'}</div>
              </>,
              <>
                <Chip kind={c.papssAllowed ? 'success' : undefined} onClick={() => setFlagFor({ code: c.code, flag: 'papss', on: !c.papssAllowed, reason: '' })}>
                  {tr('sponsored scheme')}
                </Chip>{' '}
                <Chip kind={c.stablecoinAllowed ? 'success' : undefined} onClick={() => setFlagFor({ code: c.code, flag: 'stablecoin', on: !c.stablecoinAllowed, reason: '' })}>
                  {tr('settlement token')}
                </Chip>
              </>,
              <S v={c.status} />,
              c.readiness?.ready ? <Chip kind="success">{tr('ready')}</Chip> : <span className="muted">{(c.readiness?.missing ?? []).map((x: string) => tr(x)).join(', ')}</span>,
            ])}
          />
        </>
      )}

      {tab === 'counterparties' && overview.data && (
        <>
          <Table
            head={[tr('Counterparty'), tr('Kind'), tr('Country'), tr('Window'), tr('Float held'), tr('Exposure'), tr('Status')]}
            empty={tr('No counterparty is declared yet.')}
            rows={(overview.data.counterparties ?? []).map((cp: any) => [
              <>
                <b>{cp.code}</b>
                <div className="muted">{cp.name}</div>
              </>,
              tr(String(cp.kind).replace(/_/g, ' ')),
              cp.country ? countryLabel(cp.country) : '—',
              tr(cp.settlementWindow),
              <>
                {(cp.float ?? []).map((f: any) => (
                  <div key={f.currency}>{money(f.balanceMinor, f.currency)}</div>
                ))}
              </>,
              <>
                {(cp.float ?? [])
                  .filter((f: any) => f.exposureLimitMinor)
                  .map((f: any) => (
                    <div key={f.currency} className={f.overLimit ? 'danger' : undefined}>
                      {((f.utilisationBps ?? 0) / 100).toFixed(1)} % {tr('of')} {money(f.exposureLimitMinor, f.currency)}
                    </div>
                  ))}
              </>,
              <S v={cp.status} />,
            ])}
          />
          {(overview.data.unlinkedPayoutAccounts ?? []).length > 0 && (
            <Alert kind="warning">
              <b>{tr('Liquidity accounts with no counterparty:')}</b> {overview.data.unlinkedPayoutAccounts.map((a: any) => `${a.label} (${money(a.balanceMinor, a.currency)})`).join(' · ')}
            </Alert>
          )}
        </>
      )}

      {tab === 'settlement' && settlement.data && (
        <>
          <div className="cards">
            {Object.entries(settlement.data.waiting ?? {}).map(([k, v]) => (
              <div className="card" key={k}>
                <h3>{tr(k.replace(/([A-Z])/g, ' $1').toLowerCase())}</h3>
                <b style={{ fontSize: 26 }}>{String(v)}</b>
              </div>
            ))}
          </div>
          <Button onClick={() => setMovement({ counterpartyId: '', currency: 'USD', kind: 'collection', amountMinor: 0, reference: '', note: '' })}>{tr('+ Record a movement')}</Button>{' '}
          <Button variant="ghost" onClick={() => api.post('/api/admin/network/positions/close-due').then((r: any) => ok(`${r.closed} ${tr('windows closed')}`), err)}>
            {tr('Close windows that are due')}
          </Button>
          <h3>{tr('Positions')}</h3>
          <Table
            head={[tr('Counterparty'), tr('Window'), tr('In'), tr('Out'), tr('Net'), tr('Status'), '']}
            empty={tr('No position yet: a position appears when a counterparty movement is recorded.')}
            rows={(settlement.data.positions ?? []).map((p: any) => [
              p.counterpartyName,
              p.windowKey,
              money(p.grossInMinor, p.currency),
              money(p.grossOutMinor, p.currency),
              <b>
                {money(Math.abs(p.netMinor), p.currency)} {p.direction === 'receive' ? tr('to receive') : tr('to pay')}
              </b>,
              <S v={p.status} />,
              p.status === 'open' ? (
                <Button variant="ghost" onClick={() => api.post(`/api/admin/network/positions/${p.id}/close`).then(() => ok(tr('Window closed')), err)}>
                  {tr('Close')}
                </Button>
              ) : p.status === 'closed' && !p.batchId ? (
                <Button variant="ghost" onClick={() => api.post(`/api/admin/network/positions/${p.id}/batch`, { rail: 'partner_network' }).then(() => ok(tr('Batch proposed')), err)}>
                  {tr('Propose a batch')}
                </Button>
              ) : null,
            ])}
          />
          <h3>{tr('Settlement batches')}</h3>
          <Table
            head={[tr('No.'), tr('Counterparty'), tr('Window'), tr('Net'), tr('Rail'), tr('Status'), tr('Next step')]}
            empty={tr('No batch yet.')}
            rows={(settlement.data.batches ?? []).map((b: any) => [
              b.number,
              b.counterpartyName,
              b.windowKey,
              <b>
                {money(b.netMinor, b.currency)} {b.direction === 'receive' ? tr('to receive') : tr('to pay')}
              </b>,
              b.rail.replace(/_/g, ' '),
              <S v={b.status} />,
              b.status === 'proposed' ? (
                <Button variant="ghost" onClick={() => api.post(`/api/admin/network/batches/${b.id}/approve`).then(() => ok(tr('Approved')), err)}>
                  {tr('Approve (second administrator)')}
                </Button>
              ) : b.status === 'approved' ? (
                <span className="muted">{tr('Instruct it on its rail, then record the reference.')}</span>
              ) : b.status === 'instructed' ? (
                <span className="muted">{tr('Waiting for the counterparty to confirm.')}</span>
              ) : b.status === 'confirmed' ? (
                <span className="muted">{tr('Reconcile against the statement.')}</span>
              ) : (
                (b.failureReason ?? '—')
              ),
            ])}
          />
        </>
      )}

      {tab === 'treasury' && treasury.data && (
        <>
          <Button onClick={() => api.post('/api/admin/network/treasury/forecast', {}).then(() => ok(tr('Forecast refreshed')), err)}>{tr('Forecast every counterparty')}</Button>{' '}
          <Button variant="ghost" onClick={() => api.post('/api/admin/network/treasury/topups/auto', {}).then((r: any) => ok(`${r.data.length} ${tr('top-ups proposed')}`), err)}>
            {tr('Propose the shortfalls')}
          </Button>{' '}
          <Button variant="ghost" onClick={() => setTopup({ counterpartyId: '', currency: 'USD', amountMinor: 0, reason: '' })}>
            {tr('+ Prefunding')}
          </Button>
          <h3>{tr('Forecast against float')}</h3>
          <Table
            head={[tr('Counterparty'), tr('Currency'), tr('Measured outflow'), tr('Forecast'), tr('Required'), tr('Held'), tr('Shortfall')]}
            empty={tr('No active counterparty to forecast.')}
            rows={(treasury.data.forecasts ?? []).map((f: any) => [
              f.counterpartyName,
              f.currency,
              <>
                {money(f.basis.observedOutflowMinor, f.currency)}
                <div className="muted">
                  {tr('over')} {f.lookbackDays} {tr('days')} · {f.basis.payoutCount} {tr('payouts')}
                </div>
              </>,
              <>
                {money(f.forecastMinor, f.currency)}
                <div className="muted">
                  {tr('next')} {f.horizonHours} h
                </div>
              </>,
              <>
                {money(f.requiredMinor, f.currency)}
                <div className="muted">×{(f.safetyFactorBps / 10000).toFixed(2)}</div>
              </>,
              money(f.balanceMinor, f.currency),
              f.shortfallMinor ? <b className="danger">{money(f.shortfallMinor, f.currency)}</b> : <Chip kind="success">{tr('covered')}</Chip>,
            ])}
          />
          <h3>{tr('Prefunding')}</h3>
          <Table
            head={[tr('Counterparty'), tr('Amount'), tr('Reason'), tr('Status'), tr('Next step')]}
            empty={tr('No prefunding proposed.')}
            rows={(treasury.data.topups ?? []).map((t: any) => [
              t.counterpartyName,
              money(t.amountMinor, t.currency),
              t.reason,
              <S v={t.status} />,
              t.status === 'proposed' ? (
                <Button variant="ghost" onClick={() => api.post(`/api/admin/network/treasury/topups/${t.id}/approve`).then(() => ok(tr('Approved')), err)}>
                  {tr('Approve (second administrator)')}
                </Button>
              ) : t.status === 'approved' ? (
                <Button onClick={() => api.post(`/api/admin/network/treasury/topups/${t.id}/execute`).then(() => ok(tr('Prefunded')), err)}>{tr('Execute the prefunding')}</Button>
              ) : (
                (t.rejectedReason ?? fmtDate(t.executedAt))
              ),
            ])}
          />
        </>
      )}

      {tab === 'iso20022' && messages.data && (
        <>
          <Alert kind="info">
            {tr(
              'Messages are exchanged with the sponsoring bank as files: a credit transfer is built here and handed over, and the answer the sponsor returns is pasted back. The platform holds no credential of the sponsor’s.',
            )}
          </Alert>
          <Button onClick={() => setImportXml({ xml: '', counterpartyId: '' })}>{tr('Import an answer or a statement')}</Button>
          <Table
            head={[tr('Kind'), tr('Direction'), tr('Message id'), tr('Amount'), tr('Status'), tr('When')]}
            empty={tr('No message yet.')}
            rows={(messages.data.data ?? []).map((msg: any) => [
              msg.kind,
              msg.direction === 'out' ? tr('to the sponsor') : tr('from the sponsor'),
              <code>{msg.msgId}</code>,
              msg.amountMinor !== null && msg.currency ? money(msg.amountMinor, msg.currency) : '—',
              <>
                <S v={msg.status} />
                {msg.statusReason ? <div className="muted">{msg.statusReason}</div> : null}
              </>,
              fmtDate(msg.createdAt),
            ])}
          />
        </>
      )}

      {tab === 'safeguarding' && safeguarding.data && (
        <>
          <div className="cards">
            <div className="card">
              <h3>{tr('Shortfalls today')}</h3>
              <b style={{ fontSize: 26 }}>{safeguarding.data.alerts.shortfalls}</b>
            </div>
            <div className="card">
              <h3>{tr('Internal mismatches')}</h3>
              <b style={{ fontSize: 26 }}>{safeguarding.data.alerts.internalMismatches}</b>
            </div>
            <div className="card">
              <h3>{tr('Resolution-pack chain')}</h3>
              <b style={{ fontSize: 26 }}>{safeguarding.data.chain.ok ? tr('intact') : tr('broken')}</b>
              <div className="muted">
                {safeguarding.data.chain.checked} {tr('packs')}
              </div>
            </div>
          </div>
          <Button onClick={() => api.post('/api/admin/network/safeguarding/run', {}).then(() => ok(tr('Checked')), err)}>{tr('Run today’s check')}</Button>{' '}
          <Button variant="ghost" onClick={() => api.post('/api/admin/network/safeguarding/packs', {}).then(() => ok(tr('Resolution pack generated')), err)}>
            {tr('Generate the resolution pack')}
          </Button>
          <Table
            head={[tr('Day'), tr('Currency'), tr('Owed to customers'), tr('Safeguarded'), tr('Shortfall'), tr('Internal'), tr('Status')]}
            empty={tr('No check recorded yet.')}
            rows={(safeguarding.data.history ?? []).map((c: any) => [
              c.day,
              c.currency,
              money(c.liabilityMinor, c.currency),
              money(c.safeguardedMinor, c.currency),
              c.shortfallMinor ? <b className="danger">{money(c.shortfallMinor, c.currency)}</b> : '—',
              c.internalOk ? <Chip kind="success">{tr('balances')}</Chip> : <Chip kind="danger">{tr('does not balance')}</Chip>,
              <S v={c.status} />,
            ])}
          />
        </>
      )}

      {tab === 'pnl' && pnl.data && (
        <>
          <Alert kind="info">{tr('A line the platform cannot derive yet is shown as “not known”, never as zero, and the contribution is withheld until every line is known.')}</Alert>
          {(pnl.data.data ?? []).map((p: any) => (
            <div className="card" key={p.corridor} style={{ marginBottom: 14 }}>
              <h3>
                {p.corridor} · {p.name}
              </h3>
              <KV k={tr('Payments settled')} v={`${p.paymentCount} · ${money(p.volumeMinor, p.currency)}`} />
              <Table
                head={[tr('Line'), tr('Amount'), tr('Where it comes from')]}
                rows={(p.lines ?? []).map((l: any) => [
                  tr(l.label),
                  l.amountMinor === null ? <span className="muted">{tr('not known')}</span> : money(l.amountMinor, p.currency),
                  <>
                    {tr(l.source)}
                    {l.note ? <div className="muted">{l.note}</div> : null}
                  </>,
                ])}
              />
              <KV
                k={tr('Contribution')}
                v={
                  p.contributionMinor === null ? (
                    <span className="muted">
                      {tr('withheld until')} {p.unknownLines.map((x: string) => tr(x)).join(', ')} {tr('are known')}
                    </span>
                  ) : (
                    <b>
                      {money(p.contributionMinor, p.currency)} ({(p.marginBps ?? 0) / 100} %)
                    </b>
                  )
                }
              />
            </div>
          ))}
        </>
      )}

      {tab === 'readiness' && readiness.data && (
        <>
          {(readiness.data.phases ?? []).map((p: any) => (
            <div className="card" key={p.phase} style={{ marginBottom: 14 }}>
              <h3>
                {tr('Phase')} {p.phase} · {tr(p.name)} {p.clearToFund ? <Chip kind="success">{tr('clear to fund')}</Chip> : <Chip kind="warning">{tr('held')}</Chip>}
              </h3>
              <KV k={tr('Gates met')} v={`${p.gates.met} / ${p.gates.total}`} />
              {p.blockedBy.length > 0 && (
                <ul>
                  {p.blockedBy.map((b: string, i: number) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <h3>{tr('Gates and kill-or-pivot criteria')}</h3>
          <Table
            head={[tr('Code'), tr('Phase'), tr('Criterion'), tr('Target'), tr('Measured'), tr('Status'), '']}
            empty={tr('No gate recorded.')}
            rows={(gates.data?.data ?? []).map((g: any) => [
              <code>{g.code}</code>,
              g.phase,
              <>
                {g.criterion}
                {g.kind === 'kill_or_pivot' ? (
                  <div className="muted">
                    <b>{tr('kill or pivot')}</b>
                  </div>
                ) : null}
              </>,
              g.target,
              <>
                {g.measured ?? '—'}
                {g.evidence ? <div className="muted">{g.evidence}</div> : null}
              </>,
              <S v={g.status} />,
              <Button variant="ghost" onClick={() => setGateEdit({ code: g.code, status: g.status, measured: g.measured ?? '', evidence: g.evidence ?? '' })}>
                {tr('Record')}
              </Button>,
            ])}
          />
          <h3>{tr('Questions to answer before building')}</h3>
          <Table
            head={[tr('Ref'), tr('Area'), tr('Question'), tr('Blocks'), tr('Owner'), tr('Status'), '']}
            empty={tr('No open question.')}
            rows={(questions.data?.data ?? []).map((q: any) => [
              <code>{q.ref}</code>,
              q.area,
              <>
                {q.question}
                {q.answer ? (
                  <div className="muted">
                    <b>{tr('Answer:')}</b> {q.answer}
                  </div>
                ) : null}
              </>,
              q.blocks ?? '—',
              q.owner ?? '—',
              <S v={q.status} />,
              q.status !== 'answered' ? (
                <Button variant="ghost" onClick={() => setAnswering({ ref: q.ref, question: q.question, answer: '' })}>
                  {tr('Answer')}
                </Button>
              ) : null,
            ])}
          />
        </>
      )}

      <Modal open={!!flagFor} onClose={() => setFlagFor(null)} title={tr('Settlement mechanism on this corridor')}>
        {flagFor && (
          <>
            <Alert kind="warning">
              {tr('This settlement mechanism is used only where a recorded decision allows it. Say which decision that is; the reason is kept in the event log with your name.')}
            </Alert>
            <Field label={tr('Reason')}>
              <Textarea rows={3} value={flagFor.reason} onChange={(e) => setFlagFor({ ...flagFor, reason: e.target.value })} />
            </Field>
            <Button
              onClick={() =>
                api.post(`/api/admin/network/corridors/${flagFor.code}/settlement-flag`, flagFor).then(() => {
                  setFlagFor(null);
                  ok(tr('Recorded'));
                }, err)
              }
            >
              {flagFor.on ? tr('Switch on') : tr('Switch off')}
            </Button>
          </>
        )}
      </Modal>

      <Modal open={!!movement} onClose={() => setMovement(null)} title={tr('Counterparty movement')}>
        {movement && (
          <>
            <Alert kind="info">
              {tr('A collection the counterparty received for BitriPay, or a payout it funded. Prefunding is not recorded here: it is a treasury movement on the liquidity account.')}
            </Alert>
            <Field label={tr('Counterparty')}>
              <Select value={movement.counterpartyId} onChange={(e) => setMovement({ ...movement, counterpartyId: e.target.value })}>
                <option value="">{tr('Choose')}</option>
                {(overview.data?.counterparties ?? []).map((cp: any) => (
                  <option key={cp.id} value={cp.id}>
                    {cp.code} · {cp.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={tr('Kind')}>
              <Select value={movement.kind} onChange={(e) => setMovement({ ...movement, kind: e.target.value })}>
                {['collection', 'postpaid_payout', 'fee', 'return', 'adjustment'].map((k) => (
                  <option key={k} value={k}>
                    {tr(k.replace(/_/g, ' '))}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={tr('Currency')}>
              <Input value={movement.currency} onChange={(e) => setMovement({ ...movement, currency: e.target.value.toUpperCase() })} />
            </Field>
            <Field label={tr('Amount in minor units')}>
              <Input type="number" value={movement.amountMinor} onChange={(e) => setMovement({ ...movement, amountMinor: Number(e.target.value) })} />
            </Field>
            <Field label={tr('Reference')} hint={tr('The counterparty’s own reference. The same reference twice posts once.')}>
              <Input value={movement.reference} onChange={(e) => setMovement({ ...movement, reference: e.target.value })} />
            </Field>
            <Button
              onClick={() =>
                api.post('/api/admin/network/movements', movement).then(() => {
                  setMovement(null);
                  ok(tr('Recorded'));
                }, err)
              }
            >
              {tr('Record')}
            </Button>
          </>
        )}
      </Modal>

      <Modal open={!!topup} onClose={() => setTopup(null)} title={tr('Propose prefunding')}>
        {topup && (
          <>
            <Field label={tr('Counterparty')}>
              <Select value={topup.counterpartyId} onChange={(e) => setTopup({ ...topup, counterpartyId: e.target.value })}>
                <option value="">{tr('Choose')}</option>
                {(treasury.data?.exposure ?? []).map((e2: any) => (
                  <option key={`${e2.counterpartyId}:${e2.currency}`} value={e2.counterpartyId}>
                    {e2.counterparty} · {e2.currency}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={tr('Currency')}>
              <Input value={topup.currency} onChange={(e) => setTopup({ ...topup, currency: e.target.value.toUpperCase() })} />
            </Field>
            <Field label={tr('Amount in minor units')}>
              <Input type="number" value={topup.amountMinor} onChange={(e) => setTopup({ ...topup, amountMinor: Number(e.target.value) })} />
            </Field>
            <Field label={tr('Reason')}>
              <Textarea rows={2} value={topup.reason} onChange={(e) => setTopup({ ...topup, reason: e.target.value })} />
            </Field>
            <Button
              onClick={() =>
                api.post('/api/admin/network/treasury/topups', topup).then(() => {
                  setTopup(null);
                  ok(tr('Proposed; a second administrator approves it.'));
                }, err)
              }
            >
              {tr('Propose')}
            </Button>
          </>
        )}
      </Modal>

      <Modal open={!!importXml} onClose={() => setImportXml(null)} title={tr('Import a sponsor message')} wide>
        {importXml && (
          <>
            <Field label={tr('Counterparty')} hint={tr('Required for a statement; a status report finds its own batch.')}>
              <Select value={importXml.counterpartyId} onChange={(e) => setImportXml({ ...importXml, counterpartyId: e.target.value })}>
                <option value="">{tr('Not needed')}</option>
                {(overview.data?.counterparties ?? []).map((cp: any) => (
                  <option key={cp.id} value={cp.id}>
                    {cp.code} · {cp.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={tr('The file’s contents')}>
              <Textarea rows={12} value={importXml.xml} onChange={(e) => setImportXml({ ...importXml, xml: e.target.value })} />
            </Field>
            <Button
              onClick={() =>
                api.post<any>('/api/admin/network/iso20022/import', { xml: importXml.xml, counterpartyId: importXml.counterpartyId || null }).then((r) => {
                  setImportXml(null);
                  ok(`${r.applied.length} ${tr('applied')}${r.warnings.length ? ` · ${r.warnings.join(' ')}` : ''}`);
                }, err)
              }
            >
              {tr('Import')}
            </Button>
          </>
        )}
      </Modal>

      <Modal open={!!answering} onClose={() => setAnswering(null)} title={tr('Answer of record')}>
        {answering && (
          <>
            <p>{answering.question}</p>
            <Field label={tr('Answer')}>
              <Textarea rows={5} value={answering.answer} onChange={(e) => setAnswering({ ...answering, answer: e.target.value })} />
            </Field>
            <Button
              onClick={() =>
                api.post(`/api/admin/network/questions/${answering.ref}/answer`, { answer: answering.answer }).then(() => {
                  setAnswering(null);
                  ok(tr('Answered'));
                }, err)
              }
            >
              {tr('Record the answer')}
            </Button>
          </>
        )}
      </Modal>

      <Modal open={!!gateEdit} onClose={() => setGateEdit(null)} title={tr('Record a gate')}>
        {gateEdit && (
          <>
            <Field label={tr('Status')}>
              <Select value={gateEdit.status} onChange={(e) => setGateEdit({ ...gateEdit, status: e.target.value })}>
                {['not_started', 'in_progress', 'met', 'missed'].map((s) => (
                  <option key={s} value={s}>
                    {tr(s.replace(/_/g, ' '))}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={tr('Measured')}>
              <Input value={gateEdit.measured} onChange={(e) => setGateEdit({ ...gateEdit, measured: e.target.value })} />
            </Field>
            <Field label={tr('Evidence')} hint={tr('Where the measurement comes from, so the next reader can check it.')}>
              <Textarea rows={3} value={gateEdit.evidence} onChange={(e) => setGateEdit({ ...gateEdit, evidence: e.target.value })} />
            </Field>
            <Button
              onClick={() =>
                api.post(`/api/admin/network/gates/${gateEdit.code}`, gateEdit).then(() => {
                  setGateEdit(null);
                  ok(tr('Recorded'));
                }, err)
              }
            >
              {tr('Record')}
            </Button>
          </>
        )}
      </Modal>
    </div>
  );
}
