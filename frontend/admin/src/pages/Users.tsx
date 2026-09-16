import { useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs, API_BASE, getToken } from '../lib/api';
import { useStore } from '../lib/store';
import {
  Alert,
  Avatar,
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
import { TRANSACTION_TYPE_LABELS, countryFlag, countryLabel } from '@bitripay/shared';

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
  const titles: Record<string, string> = { user: tr('User care'), merchant: tr('Merchant care'), agent: tr('Agent care'), admin: tr('Admin care & role management') };
  useEffect(() => setForm((f) => ({ ...f, role })), [role]);
  const create = async () => {
    try {
      await api.post('/api/admin/users', { ...form, email: form.email || null, phone: form.phone || null, businessName: form.businessName || null, country: form.country || null });
      toast(tr('Account created'), 'success');
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
        subtitle={tr('Search, review, adjust balances, suspend or edit accounts')}
        actions={
          (role !== 'admin' || can('admins')) && (
            <Button onClick={() => setCreateOpen(true)}>
              {tr('+ Create {0}', { 0: ({ user: tr('User'), merchant: tr('Merchant'), agent: tr('Agent'), admin: tr('Admin') } as Record<string, string>)[role] ?? role })}
            </Button>
          )
        }
      />
      <Tabs
        tabs={[
          { id: 'user', label: tr('Users') },
          { id: 'merchant', label: tr('Merchants') },
          { id: 'agent', label: tr('Agents') },
          { id: 'admin', label: tr('Admins') },
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
            placeholder={tr('Search name, email, phone, @tag')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            style={{ maxWidth: 300 }}
          />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 150 }}>
            <option value="">{tr('Any status')}</option>
            <option value="active">{tr('Active')}</option>
            <option value="suspended">{tr('Suspended')}</option>
          </Select>
        </div>
        <Table
          head={[tr('Account'), tr('Contact'), 'KYC', tr('Status'), tr('Balances'), tr('Joined'), '']}
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
              {tr('Manage')}
            </Button>,
          ])}
          empty={tr('No accounts match')}
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
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={tr('Create {0} account', { 0: ({ user: tr('User'), merchant: tr('Merchant'), agent: tr('Agent'), admin: tr('Admin') } as Record<string, string>)[role] ?? role })}
      >
        <Field label={tr('Full name')}>
          <Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        </Field>
        <div className="grid cols-2">
          <Field label={tr('Email')}>
            <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label={tr('Phone')}>
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
        </div>
        <Field label={tr('Password')}>
          <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        {role !== 'user' && role !== 'admin' && (
          <Field label={tr('Business name')}>
            <Input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} />
          </Field>
        )}
        <Field label={tr('Country')}>
          <Select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
            <option value="">—</option>
            {(config?.countries ?? []).map((c: any) => (
              <option key={c.code} value={c.code}>
                {countryFlag(c.code)} {c.name}
              </option>
            ))}
          </Select>
        </Field>
        {role === 'admin' && (
          <Field label={tr('Permissions (none = super admin)')}>
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
          {tr('Create')}
        </Button>
      </Modal>
    </div>
  );
}

function UserDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { money, toast, config, can } = useStore();
  const detail = useAsync(() => api.get<any>(`/api/admin/users/${id}`), [id]);
  const removePicture = (kind: 'profile' | 'cover') =>
    api
      .del(`/api/admin/users/${id}/picture/${kind}`)
      .then(() => {
        toast(kind === 'profile' ? 'Profile photo removed' : 'Cover picture removed', 'success');
        detail.reload();
      })
      .catch((e) => toast((e as Error).message, 'error'));
  const [edit, setEdit] = useState<any>(null);
  const [adjust, setAdjust] = useState({ direction: 'credit', amount: '', currency: 'USD', reason: '' });
  const [proposed, setProposed] = useState<string | null>(null);
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
      toast(tr('Saved'), 'success');
      detail.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const doAdjust = async () => {
    try {
      const r = await api.post<{ verification: { id: string } }>(`/api/admin/users/${id}/adjust`, adjust);
      toast(tr('Issuance proposed – a second administrator with the issuance permission must approve it in the verification console'), 'success');
      setProposed(r.verification?.id ?? 'pending');
      setAdjust({ ...adjust, amount: '', reason: '' });
      detail.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Modal open onClose={onClose} title={d ? `${d.user.fullName} (@${d.user.tag})` : tr('Loading…')} wide>
      {d && edit && (
        <>
          <div className="row wrap mb">
            <StatusBadge status={d.user.role} />
            <StatusBadge status={d.user.status} />
            <Chip>{tr('KYC: {0}', { 0: d.user.kycStatus })}</Chip>
            {d.user.twoFactorEnabled && <Chip kind="success">2FA</Chip>}
            {d.user.emailVerified && <Chip kind="success">email ✓</Chip>}
            {d.user.phoneVerified && <Chip kind="success">phone ✓</Chip>}
          </div>
          <Tabs
            pills
            tabs={[
              { id: 'overview', label: tr('Overview') },
              { id: 'edit', label: tr('Edit account') },
              { id: 'balance', label: tr('Adjust balance') },
            ]}
            value={tab}
            onChange={(v) => setTab(v as any)}
          />
          <div className="mt" />
          {tab === 'overview' && (
            <div className="grid cols-2">
              <div>
                <div className="cover-banner" style={d.user.coverUrl ? { backgroundImage: `url("${d.user.coverUrl}")` } : undefined}>
                  <div className="cover-actions">
                    <Avatar user={d.user} size="sm" />
                    {d.user.pictureUrl && (
                      <Button size="sm" variant="ghost" onClick={() => removePicture('profile')}>
                        {tr('Remove photo')}
                      </Button>
                    )}
                    {d.user.coverUrl && (
                      <Button size="sm" variant="ghost" onClick={() => removePicture('cover')}>
                        {tr('Remove cover')}
                      </Button>
                    )}
                    {!d.user.pictureUrl && !d.user.coverUrl && <span className="tiny muted">{tr('No pictures')}</span>}
                  </div>
                </div>
                <KV k={tr('Email')} v={d.user.email ?? '—'} />
                <KV k={tr('Phone')} v={d.user.phone ?? '—'} />
                <KV k={tr('Country')} v={countryLabel(d.user.country)} />
                <KV k={tr('Referral code')} v={d.user.referralCode} />
                <KV k="Referred by" v={d.referrer ? `@${d.referrer.tag}` : '—'} />
                <KV k={tr('Joined')} v={fmtDate(d.user.createdAt)} />
                <KV k={tr('Last login')} v={fmtDate(d.user.lastLoginAt)} />
                {d.user.role === 'merchant' && (
                  <>
                    <KV k={tr('Webhook')} v={d.user.webhookUrl ?? '—'} />
                    <KV k={tr('API keys')} v={d.apiKeys.length} />
                  </>
                )}
                {d.user.role === 'agent' && (
                  <KV k={tr('Commission')} v={d.user.agentCommissionBps != null ? `${d.user.agentCommissionBps / 100}%` : `default (${(config?.agentCommissionBps ?? 0) / 100}%)`} />
                )}
                <h4 className="mt">{tr('Wallets')}</h4>
                {d.wallets.map((w: any) => (
                  <KV key={w.id} k={w.currency} v={money(w.balance, w.currency)} />
                ))}
                <h4 className="mt">{tr('Bank accounts')}</h4>
                {d.bankAccounts.length === 0 && <div className="small muted">{tr('None')}</div>}
                {d.bankAccounts.map((b: any) => (
                  <div key={b.id} className="small">
                    {b.bank_name} · {b.account_number} · {b.currency}
                  </div>
                ))}
              </div>
              <div>
                <h4>{tr('Recent transactions')}</h4>
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
                <Field label={tr('Full name')}>
                  <Input value={edit.fullName} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} />
                </Field>
                <Field label={tr('Role')}>
                  <Select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} disabled={!can('admins') && edit.role === 'admin'}>
                    <option value="user">{tr('User')}</option>
                    <option value="merchant">{tr('Merchant')}</option>
                    <option value="agent">{tr('Agent')}</option>
                    {can('admins') && <option value="admin">{tr('Admin')}</option>}
                  </Select>
                </Field>
                <Field label={tr('Email')}>
                  <Input value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
                </Field>
                <Field label={tr('Phone')}>
                  <Input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
                </Field>
                <Field label={tr('Status')}>
                  <Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                    <option value="active">{tr('Active')}</option>
                    <option value="suspended">{tr('Suspended')}</option>
                  </Select>
                </Field>
                {edit.status === 'suspended' && (
                  <Field
                    label={tr('Reason of the suspension')}
                    hint={tr('Told to the customer in the notification and kept in the audit trail (a suspected fraud is also declared to the central bank within 48 hours).')}
                  >
                    <Input value={edit.reason ?? ''} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} placeholder={tr('Suspected fraud')} />
                  </Field>
                )}
                <Field label={tr('KYC status')}>
                  <Select value={edit.kycStatus} onChange={(e) => setEdit({ ...edit, kycStatus: e.target.value })}>
                    {['none', 'pending', 'verified', 'rejected'].map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={tr('Country')}>
                  <Select value={edit.country} onChange={(e) => setEdit({ ...edit, country: e.target.value })}>
                    <option value="">—</option>
                    {(config?.countries ?? []).map((c: any) => (
                      <option key={c.code} value={c.code}>
                        {countryFlag(c.code)} {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={tr('Business name')}>
                  <Input value={edit.businessName} onChange={(e) => setEdit({ ...edit, businessName: e.target.value })} />
                </Field>
                {edit.role === 'agent' && (
                  <Field label={tr('Agent commission (bps, blank = default)')}>
                    <Input value={edit.agentCommissionBps} onChange={(e) => setEdit({ ...edit, agentCommissionBps: e.target.value })} />
                  </Field>
                )}
                <Field label={tr('Reset password (optional)')}>
                  <Input type="password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
                </Field>
              </div>
              {edit.role === 'admin' && can('admins') && (
                <Field label={tr('Admin permissions (none selected = super admin)')}>
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
                <Button onClick={save}>{tr('Save changes')}</Button>
                {d.user.twoFactorEnabled && (
                  <ConfirmButton
                    variant="secondary"
                    onConfirm={() =>
                      api.patch(`/api/admin/users/${id}`, { twoFactorEnabled: false }).then(() => {
                        toast(tr('2FA reset'), 'success');
                        detail.reload();
                      })
                    }
                  >
                    {tr('Reset 2FA')}
                  </ConfirmButton>
                )}
                {!d.user.emailVerified && d.user.email && (
                  <Button variant="secondary" onClick={() => api.patch(`/api/admin/users/${id}`, { emailVerified: true }).then(detail.reload)}>
                    {tr('Mark email verified')}
                  </Button>
                )}
              </div>
            </div>
          )}
          {tab === 'balance' && (
            <div>
              <Alert kind="warning">{tr('Manual adjustments are recorded in the audit log and shown to the user as an admin adjustment.')}</Alert>
              <div className="grid cols-3">
                <Field label={tr('Direction')}>
                  <Select value={adjust.direction} onChange={(e) => setAdjust({ ...adjust, direction: e.target.value })}>
                    <option value="credit">{tr('Credit (add)')}</option>
                    <option value="debit">{tr('Debit (remove)')}</option>
                  </Select>
                </Field>
                <Field label={tr('Amount')}>
                  <Input inputMode="decimal" value={adjust.amount} onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })} />
                </Field>
                <Field label={tr('Currency')}>
                  <Select value={adjust.currency} onChange={(e) => setAdjust({ ...adjust, currency: e.target.value })}>
                    {(config?.currencies ?? []).map((c: any) => (
                      <option key={c.code} value={c.code}>
                        {c.code}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label={tr('Reason (shown to the user)')}>
                <Input value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} />
              </Field>
              <Button onClick={doAdjust} disabled={!adjust.amount || adjust.reason.length < 3}>
                {tr('Propose adjustment')}
              </Button>
              {proposed && (
                <Alert kind="info">
                  Waiting for approval. Nothing is credited yet: a <strong>different</strong> administrator with the issuance permission approves it under PIN step-up in the{' '}
                  <Link to="/verification">{tr('Verification console')}</Link> (section "Awaiting a second approver"). The person who proposed it cannot approve it.
                </Alert>
              )}
              <div className="divider" />
              <h4>{tr('Balances, freezes & statements')}</h4>
              <Table
                head={[tr('Currency'), tr('Balance'), tr('Promotional credit'), tr('Class'), tr('Frozen'), '']}
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
                              toast(tr('Balance released'), 'success');
                              detail.reload();
                            })
                            .catch((e) => toast(e.message, 'error'))
                        }
                      >
                        {tr('Release')}
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
                              toast(tr('Balance frozen'), 'success');
                              detail.reload();
                            })
                            .catch((e) => toast(e.message, 'error'))
                        }
                      >
                        {tr('Freeze')}
                      </StepUpButton>
                    )
                  ) : null,
                ])}
                empty={tr('No wallets')}
              />
              <div className="grid cols-3 mt">
                <Field label={tr('Statement currency')}>
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
                  {tr('⬇ Statement PDF')}
                </Button>
                <Button variant="secondary" onClick={() => downloadStatement('csv')}>
                  {tr('⬇ Statement CSV')}
                </Button>
                <span className="tiny muted">{tr('Every statement generated for a holder is numbered, hashed and written to the audit log.')}</span>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
