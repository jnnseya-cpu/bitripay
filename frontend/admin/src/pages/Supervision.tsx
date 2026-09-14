import { useState } from 'react';
import { api, qs, API_BASE, getToken } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, Field, Input, PageHeader, Select, Table, fmtDate, useAsync } from '../components/ui';
import { TRANSACTION_TYPE_LABELS } from '@bitripay/shared';
import { columnChart, donutChart, lineChart } from '@bitripay/charts';
import { Chart } from '@bitripay/charts/react';

interface Report {
  generatedAt: string;
  period: { from: string; to: string };
  complianceMode: string;
  transactions: {
    total: number;
    failed: number;
    exceptionRate: number;
    byTypeStatus: { type: string; status: string; currency: string; count: number; volume: number; fees: number }[];
    channels: Record<string, { count: number; volumeByCurrency: Record<string, number> }>;
    hourly: { hour: string; count: number; completed: number; failed: number }[];
  };
  accounts: { byRoleStatus: { role: string; status: string; count: number }[]; newInPeriod: number; kyc: { role: string; kyc_status: string; kyc_tier: number; count: number; tierLabel: string }[] };
  aml: { openCases: any; riskEvents: { action: string; count: number }[]; sanctionsEntries: number };
  emoney: { currency: string; jurisdiction: string; status: string; issuerModel: string; clearedReserves: number; liabilities: number; coverRatio: number | null }[];
  liquidity: { label: string; rail: string; operatorId: string | null; currency: string; balance: number; queuedDemand: number; shortfall: number; status: string }[];
  corridors: { corridor: string; status: string; ready: boolean; licenceExpiresAt: string | null }[];
  integrity: { eventChain: { ok: boolean; checked: number; brokenAt: number | null }; guardian: { mode: string; reason?: string | null } };
}
interface Manifest {
  format: string;
  from: string;
  to: string;
  records: number;
  sha256: string;
  eventChain: { ok: boolean; checked: number; brokenAt: number | null };
  complianceMode: string;
  generatedAt: string;
  pseudonymisation: string;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Regulatory supervision: real-time report, normalised journal export with integrity manifest, integrity check. */
export function Supervision() {
  const { money } = useStore();
  const [f, setF] = useState({ from: day(new Date(Date.now() - 30 * 86400_000)), to: day(new Date()), currency: '', type: '' });
  const range = () => ({ from: new Date(f.from).toISOString(), to: new Date(`${f.to}T23:59:59.999Z`).toISOString() });
  const report = useAsync(() => api.get<Report>(`/api/admin/supervision/report${qs(range())}`), [f.from, f.to]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exportJournal = async (format: 'csv' | 'json') => {
    setBusy(true);
    setError(null);
    try {
      const query = qs({ ...range(), currency: f.currency, type: f.type, format });
      const res = await fetch(`${API_BASE}/api/admin/supervision/journal${query}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bitripay-journal-${f.from}_${f.to}.${format}`;
      a.click();
      const m = await api.get<{ manifest: Manifest }>(`/api/admin/supervision/journal${qs({ ...range(), currency: f.currency, type: f.type, format, manifest: 'only' })}`);
      setManifest(m.manifest);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const r = report.data;
  return (
    <div>
      <PageHeader
        title="Regulatory supervision"
        subtitle="Real-time supervisory report, the normalised operations journal for the supervisor (CSV or JSON with an integrity manifest) and the integrity check of the ledger and event chain."
        actions={
          <div className="row">
            <Button variant="secondary" onClick={() => exportJournal('csv')} disabled={busy}>
              Export journal (CSV)
            </Button>
            <Button variant="secondary" onClick={() => exportJournal('json')} disabled={busy}>
              Export journal (JSON)
            </Button>
          </div>
        }
      />
      <div className="card mb">
        <div className="row wrap">
          <Field label="From">
            <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          </Field>
          <Field label="To">
            <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
          </Field>
          <Field label="Currency (export)">
            <Input placeholder="All" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} style={{ width: 90 }} />
          </Field>
          <Field label="Type (export)">
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="">All types</option>
              {Object.entries(TRANSACTION_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {error && <Alert kind="error">{error}</Alert>}
        {manifest && (
          <div className="mt-sm tiny">
            <b>Integrity manifest of the last export</b> · {manifest.records} records · {manifest.format.toUpperCase()} · SHA-256 <span className="mono">{manifest.sha256}</span> · event chain{' '}
            <Chip kind={manifest.eventChain.ok ? 'success' : 'danger'}>{manifest.eventChain.ok ? `intact (${manifest.eventChain.checked} events)` : `broken at ${manifest.eventChain.brokenAt}`}</Chip>{' '}
            · mode {manifest.complianceMode} · generated {fmtDate(manifest.generatedAt)}
            <div className="muted">{manifest.pseudonymisation}</div>
          </div>
        )}
      </div>

      {!r ? (
        <div className="card">Loading the report…</div>
      ) : (
        <>
          <div className="grid cols-4">
            <div className="card">
              <div className="tiny muted">Transactions in period</div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{r.transactions.total}</div>
              <div className="tiny">
                {r.transactions.failed} failed / rejected / reversed · exception rate {r.transactions.exceptionRate}%
              </div>
            </div>
            <div className="card">
              <div className="tiny muted">Compliance mode</div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{r.complianceMode}</div>
              <div className="tiny">Guardian: {r.integrity.guardian.mode}</div>
            </div>
            <div className="card">
              <div className="tiny muted">Event chain</div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{r.integrity.eventChain.ok ? 'intact' : 'BROKEN'}</div>
              <div className="tiny">{r.integrity.eventChain.checked} hash-chained events verified</div>
            </div>
            <div className="card">
              <div className="tiny muted">Sanctions entries loaded</div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{r.aml.sanctionsEntries.toLocaleString()}</div>
              <div className="tiny">{r.accounts.newInPeriod} accounts opened in period</div>
            </div>
          </div>

          <div className="grid cols-3 mt">
            <div className="card">
              <h4>Last 24 hours</h4>
              <Chart
                scene={lineChart(
                  r.transactions.hourly.map((h) => h.hour.slice(11) + 'h'),
                  [
                    { name: 'Completed', values: r.transactions.hourly.map((h) => h.completed) },
                    { name: 'Failed', values: r.transactions.hourly.map((h) => h.failed) },
                  ],
                  { format: (v) => String(Math.round(v)), height: 200 },
                )}
              />
            </div>
            <div className="card">
              <h4>Completed operations by channel</h4>
              <Chart
                scene={donutChart(
                  Object.entries(r.transactions.channels).map(([label, c]) => ({ label, value: c.count })),
                  { format: (v) => String(Math.round(v)), centre: String(Object.values(r.transactions.channels).reduce((a, c) => a + c.count, 0)), height: 200 },
                )}
              />
            </div>
            <div className="card">
              <h4>Accounts by KYC tier</h4>
              <Chart
                scene={columnChart(
                  Array.from(new Set(r.accounts.kyc.map((k) => k.tierLabel.replace(/^Tier \d · /, '')))),
                  ['user', 'merchant', 'agent'].map((role) => ({
                    name: role,
                    values: Array.from(new Set(r.accounts.kyc.map((k) => k.tierLabel))).map((tier) =>
                      r.accounts.kyc.filter((k) => k.role === role && k.tierLabel === tier).reduce((a, k) => a + k.count, 0),
                    ),
                  })),
                  { stacked: true, format: (v) => String(Math.round(v)), height: 200 },
                )}
              />
            </div>
          </div>

          <div className="card mt">
            <h4>Volumes by type, status and currency</h4>
            <Table
              head={['Type', 'Status', 'Currency', 'Count', 'Volume', 'Fees']}
              rows={r.transactions.byTypeStatus.map((x) => [
                (TRANSACTION_TYPE_LABELS as Record<string, string>)[x.type] ?? x.type,
                <Chip kind={x.status === 'completed' ? 'success' : x.status === 'pending' ? 'warning' : x.status === 'failed' || x.status === 'rejected' ? 'danger' : undefined}>{x.status}</Chip>,
                x.currency,
                x.count,
                money(x.volume, x.currency),
                money(x.fees, x.currency),
              ])}
              empty="No transactions in the period"
            />
          </div>

          <div className="grid cols-2 mt">
            <div className="card">
              <h4>Channels (completed)</h4>
              <Table
                head={['Channel', 'Count', 'Volume']}
                rows={Object.entries(r.transactions.channels).map(([ch, c]) => [
                  <b>{ch}</b>,
                  c.count,
                  <span className="tiny">
                    {Object.entries(c.volumeByCurrency)
                      .map(([cur, v]) => money(v, cur))
                      .join(' · ')}
                  </span>,
                ])}
                empty="Nothing completed in the period"
              />
            </div>
            <div className="card">
              <h4>Last 24 hours, by hour (UTC)</h4>
              <Table
                head={['Hour', 'Total', 'Completed', 'Failed']}
                rows={r.transactions.hourly.map((h) => [h.hour.replace('T', ' ') + ':00', h.count, h.completed, h.failed])}
                empty="No activity in the last 24 hours"
              />
            </div>
          </div>

          <div className="grid cols-2 mt">
            <div className="card">
              <h4>Accounts and KYC distribution</h4>
              <Table head={['Role', 'KYC status', 'Tier', 'Accounts']} rows={r.accounts.kyc.map((k) => [k.role, k.kyc_status, k.tierLabel, k.count])} empty="No accounts" />
              <Table head={['Role', 'Status', 'Accounts']} rows={r.accounts.byRoleStatus.map((a) => [a.role, a.status, a.count])} />
            </div>
            <div className="card">
              <h4>AML activity in period</h4>
              <Table head={['Risk engine action', 'Events']} rows={r.aml.riskEvents.map((e) => [e.action, e.count])} empty="No risk events in the period" />
              <div className="tiny mt-sm">
                Open compliance work: <span className="mono">{JSON.stringify(r.aml.openCases)}</span>
              </div>
            </div>
          </div>

          <div className="grid cols-2 mt">
            <div className="card">
              <h4>E-money programmes and safeguarding cover</h4>
              <Table
                head={['Currency', 'Jurisdiction', 'Issuer model', 'Status', 'Cleared reserves', 'Liabilities', 'Cover']}
                rows={r.emoney.map((p) => [
                  p.currency,
                  p.jurisdiction,
                  p.issuerModel,
                  <Chip kind={p.status === 'active' ? 'success' : 'warning'}>{p.status}</Chip>,
                  money(p.clearedReserves, p.currency),
                  money(p.liabilities, p.currency),
                  p.coverRatio === null ? '—' : <Chip kind={p.coverRatio >= 100 ? 'success' : 'danger'}>{p.coverRatio}%</Chip>,
                ])}
                empty="No e-money programme declared"
              />
            </div>
            <div className="card">
              <h4>Payout liquidity and corridors</h4>
              <Table
                head={['Payout account', 'Rail', 'Balance', 'Queued', 'Shortfall', 'Status']}
                rows={r.liquidity.map((l) => [
                  l.label,
                  `${l.rail}${l.operatorId ? ` · ${l.operatorId}` : ''}`,
                  money(l.balance, l.currency),
                  money(l.queuedDemand, l.currency),
                  money(l.shortfall, l.currency),
                  l.status,
                ])}
                empty="No payout account"
              />
              <Table
                head={['Corridor', 'Status', 'Ready', 'Licence expires']}
                rows={r.corridors.map((c) => [
                  c.corridor,
                  c.status,
                  <Chip kind={c.ready ? 'success' : 'warning'}>{c.ready ? 'yes' : 'no'}</Chip>,
                  c.licenceExpiresAt ? fmtDate(c.licenceExpiresAt) : '—',
                ])}
                empty="No corridor declared"
              />
            </div>
          </div>
          <p className="tiny muted mt">
            Report generated {fmtDate(r.generatedAt)} for {fmtDate(r.period.from)} → {fmtDate(r.period.to)}. Parties in the journal are pseudonymised; the platform re-identifies them on a lawful
            request.
          </p>
        </>
      )}
    </div>
  );
}
