import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs, API_BASE, getToken } from '../lib/api';
import { useStore } from '../lib/store';
import {
  Alert,
  Button,
  Chip,
  ConfirmButton,
  Field,
  Input,
  KV,
  Modal,
  PageHeader,
  Pager,
  Select,
  StatusBadge,
  StepUpButton,
  Table,
  Tabs,
  UserCell,
  fmtDate,
  useAsync,
  useDebounce,
} from '../components/ui';
import { TRANSACTION_TYPE_LABELS } from '@bitripay/shared';

const PERMS = ['users', 'transactions', 'approvals', 'kyc', 'settings', 'gateways', 'catalogs', 'cms', 'support', 'p2p', 'reports', 'admins', 'issuance', 'treasury', 'agents'];
/** Labels for the permission chips; the treasury permission is the TREASURY_SUPER_ADMIN role of the e-money console. */
const PERM_LABELS: Record<string, string> = { treasury: 'Treasury (TREASURY_SUPER_ADMIN)', issuance: 'Issuance (maker-checker)' };

export function Users() {
  const [params, setParams] = useSearchParams();
  const { id } = useParams();
  const nav = useNavigate();
  const { money, toast, config, can } = useStore();
  const role = params.get('role') || 'user';
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounce(search, 300);
  const list = useAsync(() => api.get<any>(`/api/admin/users${qs({ role, search: q, status, page, pageSize: 20 })}`), [role, q, status, page]);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', password: '', role, businessName: '', country: '', permissions: [] as string[] });
  const titles: Record<string, string> = { user: 'User care', merchant: 'Merchant care', agent: 'Agent care', admin: 'Admin care & role management' };
  useEffect(() => setForm((f) => ({ ...f, role })), [role]);
  const create = async () => {
    try {
      await api.post('/api/admin/users', { ...form, email: form.email || null, phone: form.phone || null, businessName: form.businessName || null, country: form.country || null });
      toast('Account created', 'success');
      setCreateOpen(false);
      list.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <div>
      <PageHeader
        title={titles[role]}
        subtitle="Search, review, adjust balances, suspend or edit accounts"
        actions={(role !== 'admin' || can('admins')) && <Button onClick={() => setCreateOpen(true)}>+ Create {role}</Button>}
      />
      <Tabs
        tabs={[
          { id: 'user', label: 'Users' },
          { id: 'merchant', label: 'Merchants' },
          { id: 'agent', label: 'Agents' },
          { id: 'admin', label: 'Admins' },
        ]}
        value={role}
        onChange={(r) => {
          setParams({ role: r });
          setPage(1);
        }}
      />
      <div className="card">
        <div className="row wrap mb">
          <Input
            placeholder="Search name, email, phone, @tag"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            style={{ maxWidth: 300 }}
          />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 150 }}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </Select>
        </div>
        <Table
          head={['Account', 'Contact', 'KYC', 'Status', 'Balances', 'Joined', '']}
          rows={(list.data?.items ?? []).map((u: any) => [
            <UserCell user={u} />,
            <div className="small">
              {u.email}
              <br />
              <span className="muted">{u.phone}</span>
            </div>,
            <StatusBadge status={u.kycStatus} />,
            <StatusBadge status={u.status} />,
            <div className="small">
              {u.wallets.map((w: any) => (
                <div key={w.id}>{money(w.balance, w.currency)}</div>
              ))}
            </div>,
            <span className="small">{fmtDate(u.createdAt).split(',')[0]}</span>,
            <Button size="sm" variant="secondary" onClick={() => nav(`/users/${u.id}?role=${role}`)}>
              Manage
            </Button>,
          ])}
          empty="No accounts match"
        />
        <Pager page={page} total={list.data?.total ?? 0} pageSize={20} onPage={setPage} />
      </div>
      {id && (
        <UserDetail
          id={id}
          onClose={() => {
            nav(`/users?role=${role}`);
            list.reload();
          }}
        />
      )}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={`Create ${role} account`}>
        <Field label="Full name">
          <Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        </Field>
        <div className="grid cols-2">
          <Field label="Email">
            <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
        </div>
        <Field label="Password">
          <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        {role !== 'user' && role !== 'admin' && (
          <Field label="Business name">
            <Input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} />
          </Field>
        )}
        <Field label="Country">
          <Select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
            <option value="">—</option>
            {(config?.countries ?? []).map((c: any) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        {role === 'admin' && (
          <Field label="Permissions (none = super admin)">
            <div className="row wrap">
              {PERMS.map((p) => (
                <Chip
                  key={p}
                  kind={form.permissions.includes(p) ? 'primary' : undefined}
                  onClick={() => setForm({ ...form, permissions: form.permissions.includes(p) ? form.permissions.filter((x) => x !== p) : [...form.permissions, p] })}
                >
                  {PERM_LABELS[p] ?? p}
                </Chip>
              ))}
            </div>
          </Field>
        )}
        <Button block onClick={create} disabled={!form.fullName || !form.password || (!form.email && !form.phone)}>
          Create
        </Button>
      </Modal>
    </div>
  );
}

function UserDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { money, toast, config, can } = useStore();
  const detail = useAsync(() => api.get<any>(`/api/admin/users/${id}`), [id]);
  const [edit, setEdit] = useState<any>(null);
  const [adjust, setAdjust] = useState({ direction: 'credit', amount: '', currency: 'USD', reason: '' });
  const [tab, setTab] = useState<'overview' | 'edit' | 'balance'>('overview');
  const today = new Date().toISOString().slice(0, 10);
  const [stmt, setStmt] = useState({ currency: 'USD', from: `${today.slice(0, 8)}01`, to: today });
  const downloadStatement = async (format: 'pdf' | 'csv') => {
    try {
      const res = await fetch(`${API_BASE}/api/admin/users/${id}/statement?currency=${stmt.currency}&from=${stmt.from}&to=${stmt.to}&format=${format}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message ?? 'Download failed');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement-${stmt.currency}-${stmt.from}-${stmt.to}.${format}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  useEffect(() => {
    if (detail.data)
      setEdit({
        fullName: detail.data.user.fullName,
        email: detail.data.user.email ?? '',
        phone: detail.data.user.phone ?? '',
        role: detail.data.user.role,
        status: detail.data.user.status,
        kycStatus: detail.data.user.kycStatus,
        country: detail.data.user.country ?? '',
        businessName: detail.data.user.businessName ?? '',
        agentCommissionBps: detail.data.user.agentCommissionBps ?? '',
        permissions: detail.data.user.permissions ?? [],
        password: '',
      });
  }, [detail.data]);
  const d = detail.data;
  const save = async () => {
    try {
      const body: any = {
        ...edit,
        email: edit.email || null,
        phone: edit.phone || null,
        country: edit.country || null,
        businessName: edit.businessName || null,
        agentCommissionBps: edit.agentCommissionBps === '' ? null : Number(edit.agentCommissionBps),
      };
      if (!body.password) delete body.password;
      await api.patch(`/api/admin/users/${id}`, body);
      toast('Saved', 'success');
      detail.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const doAdjust = async () => {
    try {
      await api.post(`/api/admin/users/${id}/adjust`, adjust);
      toast('Issuance proposed – a second administrator with the issuance permission must approve it in the verification console', 'success');
      setAdjust({ ...adjust, amount: '', reason: '' });
      detail.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Modal open onClose={onClose} title={d ? `${d.user.fullName} (@${d.user.tag})` : 'Loading…'} wide>
      {d && edit && (
        <>
          <div className="row wrap mb">
            <StatusBadge status={d.user.role} />
            <StatusBadge status={d.user.status} />
            <Chip>KYC: {d.user.kycStatus}</Chip>
            {d.user.twoFactorEnabled && <Chip kind="success">2FA</Chip>}
            {d.user.emailVerified && <Chip kind="success">email ✓</Chip>}
            {d.user.phoneVerified && <Chip kind="success">phone ✓</Chip>}
          </div>
          <Tabs
            pills
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'edit', label: 'Edit account' },
              { id: 'balance', label: 'Adjust balance' },
            ]}
            value={tab}
            onChange={(v) => setTab(v as any)}
          />
          <div className="mt" />
          {tab === 'overview' && (
            <div className="grid cols-2">
              <div>
                <KV k="Email" v={d.user.email ?? '—'} />
                <KV k="Phone" v={d.user.phone ?? '—'} />
                <KV k="Country" v={d.user.country ?? '—'} />
                <KV k="Referral code" v={d.user.referralCode} />
                <KV k="Referred by" v={d.referrer ? `@${d.referrer.tag}` : '—'} />
                <KV k="Joined" v={fmtDate(d.user.createdAt)} />
                <KV k="Last login" v={fmtDate(d.user.lastLoginAt)} />
                {d.user.role === 'merchant' && (
                  <>
                    <KV k="Webhook" v={d.user.webhookUrl ?? '—'} />
                    <KV k="API keys" v={d.apiKeys.length} />
                  </>
                )}
                {d.user.role === 'agent' && (
                  <KV k="Commission" v={d.user.agentCommissionBps != null ? `${d.user.agentCommissionBps / 100}%` : `default (${(config?.agentCommissionBps ?? 0) / 100}%)`} />
                )}
                <h4 className="mt">Wallets</h4>
                {d.wallets.map((w: any) => (
                  <KV key={w.id} k={w.currency} v={money(w.balance, w.currency)} />
                ))}
                <h4 className="mt">Bank accounts</h4>
                {d.bankAccounts.length === 0 && <div className="small muted">None</div>}
                {d.bankAccounts.map((b: any) => (
                  <div key={b.id} className="small">
                    {b.bank_name} · {b.account_number} · {b.currency}
                  </div>
                ))}
              </div>
              <div>
                <h4>Recent transactions</h4>
                {d.transactions.map((t: any) => (
                  <div key={t.id} className="kv">
                    <span className="k small">
                      {TRANSACTION_TYPE_LABELS[t.type as keyof typeof TRANSACTION_TYPE_LABELS]}
                      <br />
                      <span className="tiny muted">{fmtDate(t.createdAt)}</span>
                    </span>
                    <span className="v small">
                      {t.direction === 'in' ? '+' : '-'}
                      {money(t.amount, t.currency)}
                      <br />
                      <StatusBadge status={t.status} />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tab === 'edit' && (
            <div>
              <div className="grid cols-2">
                <Field label="Full name">
                  <Input value={edit.fullName} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} />
                </Field>
                <Field label="Role">
                  <Select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} disabled={!can('admins') && edit.role === 'admin'}>
                    <option value="user">User</option>
                    <option value="merchant">Merchant</option>
                    <option value="agent">Agent</option>
                    {can('admins') && <option value="admin">Admin</option>}
                  </Select>
                </Field>
                <Field label="Email">
                  <Input value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
                </Field>
                <Field label="Phone">
                  <Input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
                </Field>
                <Field label="Status">
                  <Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                  </Select>
                </Field>
                <Field label="KYC status">
                  <Select value={edit.kycStatus} onChange={(e) => setEdit({ ...edit, kycStatus: e.target.value })}>
                    {['none', 'pending', 'verified', 'rejected'].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Country">
                  <Select value={edit.country} onChange={(e) => setEdit({ ...edit, country: e.target.value })}>
                    <option value="">—</option>
                    {(config?.countries ?? []).map((c: any) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Business name">
                  <Input value={edit.businessName} onChange={(e) => setEdit({ ...edit, businessName: e.target.value })} />
                </Field>
                {edit.role === 'agent' && (
                  <Field label="Agent commission (bps, blank = default)">
                    <Input value={edit.agentCommissionBps} onChange={(e) => setEdit({ ...edit, agentCommissionBps: e.target.value })} />
                  </Field>
                )}
                <Field label="Reset password (optional)">
                  <Input type="password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
                </Field>
              </div>
              {edit.role === 'admin' && can('admins') && (
                <Field label="Admin permissions (none selected = super admin)">
                  <div className="row wrap">
                    {PERMS.map((p) => (
                      <Chip
                        key={p}
                        kind={edit.permissions.includes(p) ? 'primary' : undefined}
                        onClick={() => setEdit({ ...edit, permissions: edit.permissions.includes(p) ? edit.permissions.filter((x: string) => x !== p) : [...edit.permissions, p] })}
                      >
                        {PERM_LABELS[p] ?? p}
                      </Chip>
                    ))}
                  </div>
                </Field>
              )}
              <div className="row wrap">
                <Button onClick={save}>Save changes</Button>
                {d.user.twoFactorEnabled && (
                  <ConfirmButton
                    variant="secondary"
                    onConfirm={() =>
                      api.patch(`/api/admin/users/${id}`, { twoFactorEnabled: false }).then(() => {
                        toast('2FA reset', 'success');
                        detail.reload();
                      })
                    }
                  >
                    Reset 2FA
                  </ConfirmButton>
                )}
                {!d.user.emailVerified && d.user.email && (
                  <Button variant="secondary" onClick={() => api.patch(`/api/admin/users/${id}`, { emailVerified: true }).then(detail.reload)}>
                    Mark email verified
                  </Button>
                )}
              </div>
            </div>
          )}
          {tab === 'balance' && (
            <div>
              <Alert kind="warning">Manual adjustments are recorded in the audit log and shown to the user as an admin adjustment.</Alert>
              <div className="grid cols-3">
                <Field label="Direction">
                  <Select value={adjust.direction} onChange={(e) => setAdjust({ ...adjust, direction: e.target.value })}>
                    <option value="credit">Credit (add)</option>
                    <option value="debit">Debit (remove)</option>
                  </Select>
                </Field>
                <Field label="Amount">
                  <Input inputMode="decimal" value={adjust.amount} onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })} />
                </Field>
                <Field label="Currency">
                  <Select value={adjust.currency} onChange={(e) => setAdjust({ ...adjust, currency: e.target.value })}>
                    {(config?.currencies ?? []).map((c: any) => (
                      <option key={c.code} value={c.code}>
                        {c.code}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Reason (shown to the user)">
                <Input value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} />
              </Field>
              <Button onClick={doAdjust} disabled={!adjust.amount || adjust.reason.length < 3}>
                Apply adjustment
              </Button>
              <div className="divider" />
              <h4>Balances, freezes & statements</h4>
              <Table
                head={['Currency', 'Balance', 'Promotional credit', 'Class', 'Frozen', '']}
                rows={(d.wallets ?? []).map((w: any) => [
                  w.currency,
                  money(w.balance, w.currency),
                  money(w.promoBalance ?? 0, w.currency),
                  <span className="tiny">{w.classification?.label ?? '—'}</span>,
                  w.frozen ? <Chip kind="danger">frozen · {w.frozenReason}</Chip> : <Chip kind="success">available</Chip>,
                  can('treasury') ? (
                    w.frozen ? (
                      <StepUpButton
                        size="sm"
                        variant="success"
                        prompt="Reason for releasing"
                        onConfirm={(pin, reason) =>
                          api
                            .post(`/api/admin/users/${id}/wallets/${w.currency}/freeze`, { freeze: false, reason: reason || 'Released', pin })
                            .then(() => {
                              toast('Balance released', 'success');
                              detail.reload();
                            })
                            .catch((e) => toast(e.message, 'error'))
                        }
                      >
                        Release
                      </StepUpButton>
                    ) : (
                      <StepUpButton
                        size="sm"
                        variant="danger"
                        prompt="Legal basis / reason for freezing"
                        onConfirm={(pin, reason) =>
                          api
                            .post(`/api/admin/users/${id}/wallets/${w.currency}/freeze`, { freeze: true, reason: reason || 'Frozen by administrator', pin })
                            .then(() => {
                              toast('Balance frozen', 'success');
                              detail.reload();
                            })
                            .catch((e) => toast(e.message, 'error'))
                        }
                      >
                        Freeze
                      </StepUpButton>
                    )
                  ) : null,
                ])}
                empty="No wallets"
              />
              <div className="grid cols-3 mt">
                <Field label="Statement currency">
                  <Select value={stmt.currency} onChange={(e) => setStmt({ ...stmt, currency: e.target.value })}>
                    {(d.wallets ?? []).map((w: any) => (
                      <option key={w.id} value={w.currency}>
                        {w.currency}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="From">
                  <Input type="date" value={stmt.from} onChange={(e) => setStmt({ ...stmt, from: e.target.value })} />
                </Field>
                <Field label="To">
                  <Input type="date" value={stmt.to} onChange={(e) => setStmt({ ...stmt, to: e.target.value })} />
                </Field>
              </div>
              <div className="row wrap">
                <Button variant="secondary" onClick={() => downloadStatement('pdf')}>
                  ⬇ Statement PDF
                </Button>
                <Button variant="secondary" onClick={() => downloadStatement('csv')}>
                  ⬇ Statement CSV
                </Button>
                <span className="tiny muted">Every statement generated for a holder is numbered, hashed and written to the audit log.</span>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
