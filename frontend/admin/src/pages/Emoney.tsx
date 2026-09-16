import { useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, Field, Input, KV, Modal, PageHeader, Select, StepUpButton, Table, Tabs, Textarea, fmtDate, useAsync } from '../components/ui';

/**
 * E-money issuance engine console (TREASURY_SUPER_ADMIN): issuer programmes, safeguarded reserves, issuance against
 * cleared funds, distribution pools, daily reconciliation and promotional liabilities. Every action here is either
 * maker-checker (reserve funding, issuance) or step-up protected (go-live, allocation, freeze), and immutably logged.
 */
export function Emoney() {
  const { toast, can, config } = useStore();
  const ok = (m: string) => {
    toast(m, 'success');
    overview.reload();
    if (selected) detail.reload();
  };
  const err = (e: any) => toast(e.message, 'error');
  const overview = useAsync(() => api.get<any>('/api/admin/emoney?pageSize=50'), []);
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useAsync(() => (selected ? api.get<any>(`/api/admin/emoney/programmes/${selected}`) : Promise.resolve(null)), [selected]);
  const [edit, setEdit] = useState<any>(null);
  const [reserve, setReserve] = useState<any>(null);
  const [pool, setPool] = useState<any>(null);
  const [allocate, setAllocate] = useState<any>(null);
  const [issue, setIssue] = useState<any>(null);
  const [tab, setTab] = useState<'programmes' | 'pools' | 'recon' | 'register'>('programmes');
  const treasury = can('treasury');
  const programmes: any[] = overview.data?.programmes ?? [];
  const pools: any[] = overview.data?.pools ?? [];
  const fmt = (n: number, c: string) => {
    const cur = (config?.currencies ?? []).find((x: any) => x.code === c);
    const d = cur?.decimals ?? 2;
    return `${(n / 10 ** d).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })} ${c}`;
  };
  const posChip = (p: any) =>
    p.sandbox ? (
      <Chip>sandbox</Chip>
    ) : p.status === 'ok' ? (
      <Chip kind="success">{tr('1:1 backed')}</Chip>
    ) : p.status === 'warning' ? (
      <Chip kind="warning">cleared funds short</Chip>
    ) : (
      <Chip kind="danger">{tr('BREACH')}</Chip>
    );

  return (
    <div>
      <PageHeader
        title={tr('E-money & safeguarded reserves')}
        subtitle={tr(
          'BitriPay balances are a redeemable claim on the authorised issuer, backed 1:1 by cleared safeguarded funds. Issuable ≤ cleared reserves − pending redemptions − reserved exposure − e-money outstanding. No administrator can type an amount into existence.',
        )}
        actions={
          <>
            <Chip kind={treasury ? 'primary' : undefined} selected={treasury}>
              {tr('TREASURY_SUPER_ADMIN')}
              {treasury ? '' : ' · view only'}
            </Chip>
            {treasury && (
              <>
                <Button
                  variant="secondary"
                  onClick={() =>
                    api
                      .post('/api/admin/emoney/reconcile', {})
                      .then((r: any) => {
                        ok(`Reconciled ${r.items.length} programme(s)`);
                      })
                      .catch(err)
                  }
                >
                  {tr('Run reconciliation now')}
                </Button>
                <Button
                  onClick={() =>
                    setEdit({
                      currency: config?.baseCurrency ?? 'USD',
                      jurisdiction: '',
                      issuerModel: 'own_authorisation',
                      issuerName: '',
                      licenceRef: '',
                      regulator: '',
                      safeguardingBank: '',
                      safeguardingAccountRef: '',
                      reservedExposure: 0,
                    })
                  }
                >
                  {tr('+ Issuer programme')}
                </Button>
              </>
            )}
          </>
        }
      />
      {overview.data?.compliance === 'sandbox' && (
        <Alert kind="warning">
          <b>{tr('Platform in sandbox mode.')}</b>{' '}
          {tr(
            'Programmes cannot issue live e-money until the go-live checklist is complete; sandbox programmes are created automatically per currency so flows can be demonstrated with clearly labelled sandbox balances.',
          )}
        </Alert>
      )}
      {(overview.data?.pending ?? []).length > 0 && (
        <Alert kind="info">
          {overview.data.pending.length} reserve-funding / issuance proposal(s) await an independent checker in the <a href="/verification">verification console</a>.
        </Alert>
      )}
      <Tabs
        tabs={[
          { id: 'programmes', label: tr('Issuer programmes & reserves') },
          { id: 'pools', label: tr('Distribution pools') },
          { id: 'recon', label: tr('Reconciliation') },
          { id: 'register', label: tr('Issuance register') },
        ]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />

      {tab === 'programmes' && (
        <>
          <div className="card mb">
            <Table
              head={[tr('Currency / jurisdiction'), tr('Issuer'), tr('Licence · regulator · safeguarding'), tr('Status'), tr('Cleared reserves'), tr('Outstanding'), tr('Headroom'), tr('Backing'), '']}
              rows={programmes.map((p: any) => [
                <b>
                  {p.currency} / {p.jurisdiction}
                </b>,
                <span>
                  {p.issuerModel.replace(/_/g, ' ')}
                  {p.issuerName ? (
                    <>
                      <br />
                      <span className="tiny">{p.issuerName}</span>
                    </>
                  ) : null}
                </span>,
                <span className="tiny">
                  {p.licenceRef ?? '—'} · {p.regulator ?? '—'}
                  <br />
                  {p.safeguardingBank ? `${p.safeguardingBank} ${p.safeguardingAccountRef ?? ''}` : 'no safeguarding account'}
                  {!p.readiness.ready && (
                    <>
                      <br />
                      <span title={p.readiness.missing.join('\n')} style={{ color: 'var(--danger)', cursor: 'help' }}>
                        {p.readiness.missing.length} arrangement(s) missing ⓘ
                      </span>
                    </>
                  )}
                </span>,
                <Chip kind={p.status === 'live' ? 'success' : p.status === 'suspended' ? 'danger' : 'warning'}>{p.status}</Chip>,
                fmt(p.position.clearedReserves, p.currency),
                <span>
                  {fmt(p.position.liabilities, p.currency)}
                  <br />
                  <span className="tiny muted">
                    pools {fmt(p.position.poolBalances, p.currency)} · pending redemptions {fmt(p.position.pendingRedemptions, p.currency)}
                  </span>
                </span>,
                <b style={{ color: p.position.headroom < 0 ? 'var(--danger)' : undefined }}>{fmt(p.position.headroom, p.currency)}</b>,
                <span>
                  {posChip(p.position)}
                  {p.suspendedReason && (
                    <>
                      <br />
                      <span className="tiny" style={{ color: 'var(--danger)' }}>
                        {p.suspendedReason}
                      </span>
                    </>
                  )}
                </span>,
                <div className="row wrap">
                  <Button size="sm" variant="ghost" onClick={() => setSelected(p.id)}>
                    {tr('Details')}
                  </Button>
                  {treasury && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        setEdit({
                          id: p.id,
                          currency: p.currency,
                          jurisdiction: p.jurisdiction,
                          issuerModel: p.issuerModel,
                          issuerName: p.issuerName ?? '',
                          licenceRef: p.licenceRef ?? '',
                          regulator: p.regulator ?? '',
                          safeguardingBank: p.safeguardingBank ?? '',
                          safeguardingAccountRef: p.safeguardingAccountRef ?? '',
                          reservedExposure: p.reservedExposure,
                          limits: p.limits,
                        })
                      }
                    >
                      {tr('Edit')}
                    </Button>
                  )}
                  {treasury && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setReserve({ programmeId: p.id, currency: p.currency, kind: 'funding', direction: 'in', amount: '', reference: '', note: '', evidence: '' })}
                    >
                      {tr('Reserves +')}
                    </Button>
                  )}
                  {treasury && p.status !== 'live' && (
                    <StepUpButton
                      size="sm"
                      variant="success"
                      title={tr('Authorise live issuance')}
                      onConfirm={(pin) =>
                        api
                          .post(`/api/admin/emoney/programmes/${p.id}/status`, { status: 'live', pin })
                          .then(() => ok('Programme live'))
                          .catch(err)
                      }
                    >
                      {tr('Go live')}
                    </StepUpButton>
                  )}
                  {treasury && p.status === 'live' && (
                    <StepUpButton
                      size="sm"
                      variant="danger"
                      prompt="Reason for suspending issuance"
                      onConfirm={(pin, reason) =>
                        api
                          .post(`/api/admin/emoney/programmes/${p.id}/status`, { status: 'suspended', reason, pin })
                          .then(() => ok('Issuance suspended'))
                          .catch(err)
                      }
                    >
                      {tr('Suspend')}
                    </StepUpButton>
                  )}
                  {treasury && p.status === 'suspended' && (
                    <StepUpButton
                      size="sm"
                      variant="secondary"
                      onConfirm={(pin) =>
                        api
                          .post(`/api/admin/emoney/programmes/${p.id}/status`, { status: 'sandbox', pin })
                          .then(() => ok('Programme back to sandbox'))
                          .catch(err)
                      }
                    >
                      {tr('Back to sandbox')}
                    </StepUpButton>
                  )}
                </div>,
              ])}
              empty={tr('No issuer programme yet. Register the authorised issuer and safeguarding account per currency.')}
            />
          </div>
          {selected && detail.data && (
            <div className="card mb">
              <div className="row between">
                <h4>
                  {detail.data.programme.currency} / {detail.data.programme.jurisdiction} · reserve movements
                </h4>
                <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                  {tr('Close')}
                </Button>
              </div>
              <div className="grid cols-4 mb">
                <KV k={tr('Cleared reserves')} v={fmt(detail.data.programme.position.clearedReserves, detail.data.programme.currency)} />
                <KV k={tr('Pending inflows (processor)')} v={fmt(detail.data.programme.position.pendingInflows, detail.data.programme.currency)} />
                <KV k={tr('Reserved exposure')} v={fmt(detail.data.programme.position.reservedExposure, detail.data.programme.currency)} />
                <KV k={tr('Payout float (asset mirror)')} v={fmt(detail.data.programme.position.payoutFloat, detail.data.programme.currency)} />
              </div>
              <Table
                head={[tr('When'), tr('Kind'), tr('Direction'), tr('Amount'), tr('Status'), tr('Reference'), 'Proposed / cleared by', tr('Note'), '']}
                rows={(detail.data.movements ?? []).map((m: any) => [
                  fmtDate(m.createdAt),
                  m.kind.replace(/_/g, ' '),
                  m.direction === 'in' ? <Chip kind="success">in</Chip> : <Chip kind="warning">out</Chip>,
                  fmt(m.amount, m.currency),
                  <Chip kind={m.status === 'cleared' ? 'success' : m.status === 'pending' ? 'warning' : 'danger'}>{m.status}</Chip>,
                  <span className="mono tiny">{m.reference ?? '—'}</span>,
                  <span className="tiny">
                    {m.proposedBy ? m.proposedBy.slice(0, 8) : 'system'} / {m.clearedBy ? m.clearedBy.slice(0, 8) : '—'}
                  </span>,
                  <span className="tiny">{m.note}</span>,
                  treasury && m.status !== 'reversed' ? (
                    <StepUpButton
                      size="sm"
                      variant="danger"
                      prompt="Reason (e.g. bank reversed the transfer)"
                      onConfirm={(pin, reason) =>
                        api
                          .post(`/api/admin/emoney/reserves/${m.id}/reverse`, { reason, pin })
                          .then(() => ok('Movement reversed'))
                          .catch(err)
                      }
                    >
                      {tr('Reverse')}
                    </StepUpButton>
                  ) : null,
                ])}
                empty={tr('No reserve movements')}
              />
              <h4 className="mt">{tr('Reconciliation history')}</h4>
              <Table
                head={[tr('When'), tr('Reserves'), 'Pending in', tr('Pending redemptions'), tr('Outstanding'), tr('Headroom'), tr('Result'), 'Run by']}
                rows={(detail.data.reconciliations ?? []).map((r: any) => [
                  fmtDate(r.createdAt),
                  r.clearedReserves,
                  r.pendingInflows,
                  r.pendingRedemptions,
                  r.liabilities,
                  r.headroom,
                  posChip(r),
                  r.runBy ? r.runBy.slice(0, 8) : 'scheduler',
                ])}
                empty={tr('Not reconciled yet')}
              />
            </div>
          )}
          <div className="card">
            <h4>{tr('Promotional credit outstanding (marketing liability – not money)')}</h4>
            <Table
              head={[tr('Currency'), tr('Unused promotional credit')]}
              rows={(overview.data?.promotionalLiability ?? []).map((p: any) => [p.currency, fmt(p.total, p.currency)])}
              empty={tr('None')}
            />
          </div>
        </>
      )}

      {tab === 'pools' && (
        <div className="card">
          <div className="row between mb">
            <div>
              <h4>{tr('Distribution hierarchy')}</h4>
              <div className="tiny muted">
                {tr(
                  'Issuer → treasury → country / currency pools → institutions & master agents → agents & merchants → users. Allocation moves existing e-money and never creates it; minting into a pool is an issuance request (maker-checker, against reserves).',
                )}
              </div>
            </div>
            {treasury && <Button onClick={() => setPool({ programmeId: programmes[0]?.id ?? '', name: '', level: 'country', parentId: '', ownerUserId: '', country: '' })}>{tr('+ Pool')}</Button>}
          </div>
          <Table
            head={[tr('Pool'), tr('Level'), tr('Parent'), tr('Owner'), tr('Currency'), tr('Balance'), tr('Status'), '']}
            rows={pools.map((p: any) => [
              <b>{p.name}</b>,
              p.level.replace(/_/g, ' '),
              pools.find((x: any) => x.id === p.parentId)?.name ?? '—',
              p.owner ? `${p.owner.businessName ?? p.owner.fullName} (@${p.owner.tag})` : '—',
              p.currency,
              fmt(p.balance, p.currency),
              <Chip kind={p.status === 'active' ? 'success' : 'warning'}>{p.status}</Chip>,
              <div className="row wrap">
                {can('issuance') && (
                  <Button size="sm" variant="secondary" onClick={() => setIssue({ programmeId: p.programmeId, poolId: p.id, poolName: p.name, currency: p.currency, amount: '', reason: '' })}>
                    {tr('Mint into pool')}
                  </Button>
                )}
                {treasury && (
                  <Button size="sm" onClick={() => setAllocate({ fromPoolId: p.id, fromName: p.name, currency: p.currency, toPoolId: '', toUserId: '', amount: '', reason: '' })}>
                    {tr('Allocate')}
                  </Button>
                )}
              </div>,
            ])}
            empty={tr('No distribution pools')}
          />
        </div>
      )}

      {tab === 'recon' && (
        <div className="card">
          <Alert kind="info">
            The scheduler reconciles every programme daily at {overview.data ? '' : ''}the configured hour (Gateway controls → settings.emoney.reconciliationHourUtc). A breach on a live programme
            suspends issuance automatically and alerts every administrator (loud).
          </Alert>
          <Table
            head={[tr('When'), tr('Programme'), tr('Cleared reserves'), tr('Pending inflows'), tr('Pending redemptions'), tr('Reserved exposure'), tr('Outstanding'), tr('Headroom'), tr('Result')]}
            rows={(overview.data?.lastReconciliation ?? []).map((r: any) => [
              fmtDate(r.createdAt),
              r.currency,
              r.clearedReserves,
              r.pendingInflows,
              r.pendingRedemptions,
              r.reservedExposure,
              r.liabilities,
              r.headroom,
              posChip(r),
            ])}
            empty={tr('No reconciliation yet')}
          />
        </div>
      )}

      {tab === 'register' && (
        <div className="card">
          <h4>{tr('Immutable issuance register (hash-chained event log)')}</h4>
          <Table
            head={[tr('When'), tr('Event'), tr('Details'), tr('Actor')]}
            rows={(overview.data?.register?.items ?? []).map((e: any) => [
              fmtDate(e.createdAt),
              <Chip kind={/breach|suspended|burned|reversed/.test(e.event) ? 'danger' : /minted|cleared|allocated|live/.test(e.event) ? 'success' : undefined}>{e.event}</Chip>,
              <span className="tiny mono">{JSON.stringify(e.details).slice(0, 160)}</span>,
              e.actor.id ? <span className="mono tiny">{String(e.actor.id).slice(0, 8)}</span> : e.actor.type,
            ])}
            empty={tr('Nothing yet')}
          />
        </div>
      )}

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? tr('Edit issuer programme') : tr('Register issuer programme')}>
        {edit && (
          <>
            <Alert kind="info">
              {tr(
                'Live e-money may be issued only when BitriPay holds the e-money authorisation in the jurisdiction, or a licensed bank / EMI is the legal issuer and BitriPay is its distributor. Sandbox programmes have no real-world value.',
              )}
            </Alert>
            <div className="grid cols-2">
              <Field label={tr('Currency')}>
                <Input value={edit.currency} disabled={!!edit.id} maxLength={3} onChange={(e) => setEdit({ ...edit, currency: e.target.value.toUpperCase() })} />
              </Field>
              <Field label={tr('Jurisdiction (ISO country)')}>
                <Input value={edit.jurisdiction} disabled={!!edit.id} maxLength={10} onChange={(e) => setEdit({ ...edit, jurisdiction: e.target.value.toUpperCase() })} />
              </Field>
              <Field label={tr('Issuer model')}>
                <Select value={edit.issuerModel} onChange={(e) => setEdit({ ...edit, issuerModel: e.target.value })}>
                  <option value="own_authorisation">{tr('BitriPay own e-money authorisation')}</option>
                  <option value="partner_issuer">{tr('Licensed bank / EMI issues, BitriPay distributes')}</option>
                  <option value="sandbox">{tr('Sandbox (no real value)')}</option>
                </Select>
              </Field>
              <Field label={tr('Legal issuer name')}>
                <Input value={edit.issuerName} onChange={(e) => setEdit({ ...edit, issuerName: e.target.value })} />
              </Field>
              <Field label={tr('Authorisation / licence reference')}>
                <Input value={edit.licenceRef} onChange={(e) => setEdit({ ...edit, licenceRef: e.target.value })} placeholder={tr('FCA FRN …')} />
              </Field>
              <Field label={tr('Regulator')}>
                <Input value={edit.regulator} onChange={(e) => setEdit({ ...edit, regulator: e.target.value })} />
              </Field>
              <Field label={tr('Safeguarding bank')}>
                <Input value={edit.safeguardingBank} onChange={(e) => setEdit({ ...edit, safeguardingBank: e.target.value })} />
              </Field>
              <Field label={tr('Safeguarding account reference')}>
                <Input value={edit.safeguardingAccountRef} onChange={(e) => setEdit({ ...edit, safeguardingAccountRef: e.target.value })} />
              </Field>
              <Field label={tr('Reserved exposure (minor units, e.g. open chargebacks)')}>
                <Input type="number" value={edit.reservedExposure} onChange={(e) => setEdit({ ...edit, reservedExposure: Number(e.target.value) })} />
              </Field>
              <Field label={tr('Per-request issuance limit (minor units, 0 = none)')}>
                <Input
                  type="number"
                  value={edit.limits?.maxIssuancePerRequest ?? 0}
                  onChange={(e) => setEdit({ ...edit, limits: { ...(edit.limits ?? {}), maxIssuancePerRequest: Number(e.target.value) } })}
                />
              </Field>
              <Field label={tr('Daily issuance limit (minor units, 0 = none)')}>
                <Input
                  type="number"
                  value={edit.limits?.dailyIssuanceLimit ?? 0}
                  onChange={(e) => setEdit({ ...edit, limits: { ...(edit.limits ?? {}), dailyIssuanceLimit: Number(e.target.value) } })}
                />
              </Field>
              <Field label={tr('Max holder balance (minor units, 0 = none)')}>
                <Input type="number" value={edit.limits?.maxHolderBalance ?? 0} onChange={(e) => setEdit({ ...edit, limits: { ...(edit.limits ?? {}), maxHolderBalance: Number(e.target.value) } })} />
              </Field>
            </div>
            <Button
              onClick={() =>
                api
                  .put(`/api/admin/emoney/programmes/${edit.id ?? 'new'}`, {
                    ...edit,
                    issuerName: edit.issuerName || null,
                    licenceRef: edit.licenceRef || null,
                    regulator: edit.regulator || null,
                    safeguardingBank: edit.safeguardingBank || null,
                    safeguardingAccountRef: edit.safeguardingAccountRef || null,
                    limits: Object.fromEntries(Object.entries(edit.limits ?? {}).filter(([, v]) => Number(v) > 0)),
                  })
                  .then(() => {
                    ok('Programme saved');
                    setEdit(null);
                  })
                  .catch(err)
              }
            >
              {tr('Save')}
            </Button>
          </>
        )}
      </Modal>

      <Modal open={!!reserve} onClose={() => setReserve(null)} title={tr('Confirm safeguarded reserve funding (maker)')}>
        {reserve && (
          <>
            <Alert kind="warning">
              Record cleared funds in the safeguarding account with the bank reference and the statement evidence you checked. A <b>different</b> treasury administrator must confirm before these funds
              count towards issuance.
            </Alert>
            <div className="grid cols-2">
              <Field label={tr('Kind')}>
                <Select value={reserve.kind} onChange={(e) => setReserve({ ...reserve, kind: e.target.value })}>
                  <option value="funding">{tr('Funding received (cleared)')}</option>
                  <option value="adjustment">{tr('Adjustment')}</option>
                  <option value="redemption">{tr('Redemption paid out')}</option>
                </Select>
              </Field>
              <Field label={tr('Direction')}>
                <Select value={reserve.direction} onChange={(e) => setReserve({ ...reserve, direction: e.target.value })}>
                  <option value="in">{tr('Into safeguarding')}</option>
                  <option value="out">{tr('Out of safeguarding')}</option>
                </Select>
              </Field>
              <Field label={`Amount (${reserve.currency})`}>
                <Input inputMode="decimal" value={reserve.amount} onChange={(e) => setReserve({ ...reserve, amount: e.target.value })} />
              </Field>
              <Field label={tr('Bank / partner reference')}>
                <Input value={reserve.reference} onChange={(e) => setReserve({ ...reserve, reference: e.target.value })} />
              </Field>
            </div>
            <Field label={tr('Evidence checked (statement line, portal, document id)')}>
              <Input value={reserve.evidence} onChange={(e) => setReserve({ ...reserve, evidence: e.target.value })} />
            </Field>
            <Field label={tr('Note')}>
              <Textarea rows={2} value={reserve.note} onChange={(e) => setReserve({ ...reserve, note: e.target.value })} />
            </Field>
            <Button
              disabled={!reserve.amount || reserve.reference.length < 2 || reserve.note.length < 8}
              onClick={() =>
                api
                  .post(`/api/admin/emoney/programmes/${reserve.programmeId}/reserves`, {
                    kind: reserve.kind,
                    direction: reserve.direction,
                    amount: reserve.amount,
                    reference: reserve.reference,
                    note: reserve.note,
                    evidence: reserve.evidence ? { statementLine: reserve.evidence } : null,
                  })
                  .then(() => {
                    ok('Reserve movement proposed – awaiting an independent checker');
                    setReserve(null);
                  })
                  .catch(err)
              }
            >
              {tr('Propose')}
            </Button>
          </>
        )}
      </Modal>

      <Modal open={!!pool} onClose={() => setPool(null)} title={tr('New distribution pool')}>
        {pool && (
          <>
            <div className="grid cols-2">
              <Field label={tr('Programme')}>
                <Select value={pool.programmeId} onChange={(e) => setPool({ ...pool, programmeId: e.target.value })}>
                  {programmes.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.currency} / {p.jurisdiction} ({p.status})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={tr('Level')}>
                <Select value={pool.level} onChange={(e) => setPool({ ...pool, level: e.target.value })}>
                  <option value="country">{tr('Country / currency pool')}</option>
                  <option value="institution">{tr('Financial institution')}</option>
                  <option value="master_agent">{tr('Master agent')}</option>
                  <option value="agent">{tr('Local agent')}</option>
                  <option value="merchant">{tr('Merchant')}</option>
                </Select>
              </Field>
              <Field label={tr('Name')}>
                <Input value={pool.name} onChange={(e) => setPool({ ...pool, name: e.target.value })} />
              </Field>
              <Field label={tr('Parent pool')}>
                <Select value={pool.parentId} onChange={(e) => setPool({ ...pool, parentId: e.target.value })}>
                  <option value="">{tr('Treasury (top level)')}</option>
                  {pools
                    .filter((x: any) => x.programmeId === pool.programmeId)
                    .map((x: any) => (
                      <option key={x.id} value={x.id}>
                        {x.name} ({x.level})
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label={tr('Owner user id (institution / master agent account)')}>
                <Input value={pool.ownerUserId} onChange={(e) => setPool({ ...pool, ownerUserId: e.target.value })} />
              </Field>
              <Field label={tr('Country')}>
                <Input value={pool.country} maxLength={2} onChange={(e) => setPool({ ...pool, country: e.target.value.toUpperCase() })} />
              </Field>
            </div>
            <Button
              disabled={!pool.programmeId || pool.name.length < 2}
              onClick={() =>
                api
                  .post('/api/admin/emoney/pools', { ...pool, parentId: pool.parentId || null, ownerUserId: pool.ownerUserId || null, country: pool.country || null })
                  .then(() => {
                    ok('Pool created');
                    setPool(null);
                  })
                  .catch(err)
              }
            >
              {tr('Create')}
            </Button>
          </>
        )}
      </Modal>

      <Modal open={!!issue} onClose={() => setIssue(null)} title={issue ? `Mint e-money into ${issue.poolName}` : ''}>
        {issue && (
          <>
            <Alert kind="warning">
              {tr(
                'Issuance request against cleared safeguarded reserves. A different administrator with the issuance permission must approve it under step-up; the reserve rule is checked again at execution.',
              )}
            </Alert>
            <Field label={`Amount (${issue.currency})`}>
              <Input inputMode="decimal" value={issue.amount} onChange={(e) => setIssue({ ...issue, amount: e.target.value })} />
            </Field>
            <Field label={tr('Reason')}>
              <Input value={issue.reason} onChange={(e) => setIssue({ ...issue, reason: e.target.value })} />
            </Field>
            <Button
              disabled={!issue.amount || issue.reason.length < 3}
              onClick={() =>
                api
                  .post('/api/admin/emoney/issue', { programmeId: issue.programmeId, poolId: issue.poolId, amount: issue.amount, reason: issue.reason })
                  .then(() => {
                    ok('Issuance proposed');
                    setIssue(null);
                  })
                  .catch(err)
              }
            >
              {tr('Propose issuance')}
            </Button>
          </>
        )}
      </Modal>

      <Modal open={!!allocate} onClose={() => setAllocate(null)} title={allocate ? `Allocate from ${allocate.fromName}` : ''}>
        {allocate && (
          <>
            <Alert kind="info">{tr('Distribution moves existing e-money down the hierarchy under step-up. The pool must hold the balance; nothing is created.')}</Alert>
            <div className="grid cols-2">
              <Field label={tr('To pool')}>
                <Select value={allocate.toPoolId} onChange={(e) => setAllocate({ ...allocate, toPoolId: e.target.value, toUserId: '' })}>
                  <option value="">— (choose a user instead)</option>
                  {pools
                    .filter((x: any) => x.currency === allocate.currency && x.id !== allocate.fromPoolId)
                    .map((x: any) => (
                      <option key={x.id} value={x.id}>
                        {x.name} ({x.level})
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label={tr('Or to user id')}>
                <Input value={allocate.toUserId} onChange={(e) => setAllocate({ ...allocate, toUserId: e.target.value, toPoolId: '' })} />
              </Field>
              <Field label={`Amount (${allocate.currency})`}>
                <Input inputMode="decimal" value={allocate.amount} onChange={(e) => setAllocate({ ...allocate, amount: e.target.value })} />
              </Field>
              <Field label={tr('Reason')}>
                <Input value={allocate.reason} onChange={(e) => setAllocate({ ...allocate, reason: e.target.value })} />
              </Field>
            </div>
            <StepUpButton
              title={tr('Confirm allocation')}
              onConfirm={(pin) =>
                api
                  .post(`/api/admin/emoney/pools/${allocate.fromPoolId}/allocate`, {
                    toPoolId: allocate.toPoolId || null,
                    toUserId: allocate.toUserId || null,
                    amount: allocate.amount,
                    reason: allocate.reason,
                    pin,
                  })
                  .then(() => {
                    ok('Allocated');
                    setAllocate(null);
                  })
                  .catch(err)
              }
            >
              {tr('Allocate')}
            </StepUpButton>
          </>
        )}
      </Modal>
    </div>
  );
}
