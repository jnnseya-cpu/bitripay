import { useState } from 'react';
import { api } from '../lib/api';
import { Button, Chip, Empty, Field, Input, KV, Select } from './ui';
import { ORG_PERMISSIONS, type OrgRole } from '@bitripay/shared';

/**
 * Team & business units (§43, §44): who acts for the organisation and with which role, and — for a merchant — the
 * departments, branches or programmes that locations, terminals and QR codes belong to. The same component serves an
 * agent's counter (`kind="agent"`): the roles are the ones that matter at the till and there are no business units.
 * Every refusal from the API (a cashier trying to invite someone, a read-only member creating a unit) is shown as
 * the API's own message.
 */
export function OrganisationTeam({ org, toast, err, kind }: { org: { data: any; loading: boolean; reload: () => void }; toast: any; err: (e: any) => void; kind: 'merchant' | 'agent' }) {
  const [invite, setInvite] = useState<{ identifier: string; role: OrgRole }>({ identifier: '', role: 'cashier' });
  const [unit, setUnit] = useState({ name: '', code: '' });
  const [limit, setLimit] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const data = org.data;
  if (!data) return org.loading ? null : <Empty text="No organisation on this account yet." />;
  const agent = kind === 'agent';
  const allRoles: OrgRole[] = data.roles ?? Object.keys(ORG_PERMISSIONS);
  const fullMatrix: Record<string, string[]> = data.permissions ?? ORG_PERMISSIONS;
  // At an agent counter only the permissions that exist at the till are shown, and only roles that hold at least one.
  const relevant = (perms: string[]) => (agent ? perms.filter((x) => x === '*' || x.startsWith('agent:')) : perms);
  const matrix: Record<string, string[]> = Object.fromEntries(Object.entries(fullMatrix).map(([r, perms]) => [r, relevant(perms as string[])]));
  const roles = allRoles.filter((r) => r === 'owner' || (matrix[r] ?? []).length > 0);
  const mine: string[] = data.membership?.permissions ?? [];
  const can = (p: string) => mine.includes('*') || mine.includes(p);
  const label = (r: string) => r.replace(/_/g, ' ');
  const run = (p: Promise<unknown>, ok: string) => {
    setBusy(true);
    return p
      .then(() => {
        toast(ok, 'success');
        org.reload();
      })
      .catch(err)
      .finally(() => setBusy(false));
  };
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>{data.organisation.name}</h3>
        <p className="small muted">
          {agent ? 'agent counter' : label(data.organisation.kind)} · {data.organisation.country ?? '—'} · KYB {data.organisation.kybStatus} · you act as <b>{label(data.membership.role)}</b>
        </p>
        {agent && (
          <p className="small muted">
            Counter staff sign in with their own credentials, confirm every cash operation with their own PIN and are recorded as the operator on each transaction. The float, the commissions and the
            limits stay on this agent account.
          </p>
        )}
        {!agent && <KV k="Cashier refund limit" v={`${data.organisation.settings.cashierRefundLimitMinor} minor units per refund`} />}
        {!agent && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              run(api.patch('/api/organisations/me', { cashierRefundLimitMinor: Number(limit) }), 'Cashier refund limit updated');
            }}
          >
            <Field label="New cashier limit (minor units)">
              <Input
                type="number"
                min={0}
                step={1}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                placeholder={String(data.organisation.settings.cashierRefundLimitMinor)}
                disabled={!can('org:settings')}
              />
            </Field>
            <Button type="submit" size="sm" variant="secondary" disabled={busy || !limit || !can('org:settings')}>
              Save
            </Button>
          </form>
        )}
        {data.platform && (
          <p className="small muted">
            <b>{data.platform.platform.businessName || data.platform.platform.fullName}</b> created this account through the BitriPay API on {new Date(data.platform.since).toLocaleDateString()} and
            acts for it as administrator (payments, refunds, keys, webhooks). Your money, settlement details and statements are yours. Remove it from the members below to end its access.
          </p>
        )}
        <h3>Members</h3>
        <div className="list">
          {(data.members ?? []).map((m: any) => (
            <div key={m.userId} className="list-item">
              <div className="flex1">
                <div className="main-text">
                  {m.user?.fullName ?? m.userId} {m.user?.tag ? <span className="muted">@{m.user.tag}</span> : null}
                </div>
                <div className="sub-text">{m.permissions.includes('*') ? 'every permission' : relevant(m.permissions).map(label).join(', ')}</div>
              </div>
              {m.role === 'owner' ? (
                <Chip kind="primary">owner</Chip>
              ) : (
                <>
                  <Select
                    value={m.role}
                    disabled={busy || !can('org:manage_members')}
                    onChange={(e) => run(api.patch(`/api/organisations/members/${m.userId}`, { role: e.target.value }), `${m.user?.fullName ?? 'Member'} is now ${label(e.target.value)}`)}
                  >
                    {roles
                      .filter((r) => r !== 'owner')
                      .map((r) => (
                        <option key={r} value={r}>
                          {label(r)}
                        </option>
                      ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy || !can('org:manage_members')}
                    onClick={() => run(api.del(`/api/organisations/members/${m.userId}`), `${m.user?.fullName ?? 'Member'} removed`)}
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(api.post('/api/organisations/members', invite), `${invite.identifier} invited as ${label(invite.role)}`).then(() => setInvite({ ...invite, identifier: '' }));
          }}
        >
          <h3>Invite a member</h3>
          <p className="small muted">
            They need a BitriPay account already: enter their email, phone or @tag. They sign in with their own credentials and {agent ? 'work at the counter of' : 'act for'} {data.organisation.name}{' '}
            with the role you choose.
          </p>
          <div className="grid cols-2">
            <Field label="Email, phone or @tag">
              <Input value={invite.identifier} onChange={(e) => setInvite({ ...invite, identifier: e.target.value })} placeholder="ana@example.com or @ana" required />
            </Field>
            <Field label="Role" hint={(matrix[invite.role] ?? []).map(label).join(', ')}>
              <Select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value as OrgRole })}>
                {roles
                  .filter((r) => r !== 'owner')
                  .map((r) => (
                    <option key={r} value={r}>
                      {label(r)}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" loading={busy} disabled={!invite.identifier}>
            Invite
          </Button>
          {!can('org:manage_members') && <p className="small muted">Your role ({label(data.membership.role)}) cannot manage members; the API will refuse and say so.</p>}
        </form>
      </div>
      {agent ? (
        <div className="card">
          <h3>Roles at the counter</h3>
          <p className="small muted">
            A cashier serves customers (cash-in, cash-out, pickups, assisted onboarding). An operations manager also declares cash, requests float and handles the payout queue. Analysts and read-only
            members only see the figures. Administrators do everything, including managing this team.
          </p>
          <div className="list">
            {roles.map((r) => (
              <div key={r} className="list-item">
                <div className="flex1">
                  <div className="main-text">{label(r)}</div>
                  <div className="sub-text">{(matrix[r] ?? []).includes('*') ? 'every permission' : (matrix[r] ?? []).map(label).join(', ')}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="card">
          <h3>Business units</h3>
          <p className="small muted">Departments, branches or programmes. Attach locations to a unit from the QR centre; every payment taken at that location then carries the unit.</p>
          {(data.businessUnits ?? []).length === 0 && <Empty text="No business units yet." />}
          <div className="list">
            {(data.businessUnits ?? []).map((u: any) => (
              <div key={u.id} className="list-item">
                <div className="flex1">
                  <div className="main-text">
                    {u.name} <Chip>{u.code}</Chip>
                  </div>
                  <div className="sub-text">
                    {u.locations} location{u.locations === 1 ? '' : 's'}
                    {u.settlementProfileId ? ` · settlement profile ${u.settlementProfileId}` : ' · settles with the organisation'}
                  </div>
                </div>
                <Button size="sm" variant="ghost" disabled={busy || !can('org:manage_units')} onClick={() => run(api.del(`/api/organisations/business-units/${u.id}`), `${u.name} deleted`)}>
                  Delete
                </Button>
              </div>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(api.post('/api/organisations/business-units', { name: unit.name, code: unit.code || null }), `${unit.name} created`).then(() => setUnit({ name: '', code: '' }));
            }}
          >
            <h3>New business unit</h3>
            <div className="grid cols-2">
              <Field label="Name">
                <Input value={unit.name} onChange={(e) => setUnit({ ...unit, name: e.target.value })} placeholder="Gombe branch" required />
              </Field>
              <Field label="Code (optional)" hint="Letters and digits; derived from the name when empty">
                <Input value={unit.code} onChange={(e) => setUnit({ ...unit, code: e.target.value })} placeholder="GOMBE" maxLength={16} />
              </Field>
            </div>
            <Button type="submit" loading={busy} disabled={unit.name.trim().length < 2}>
              Create unit
            </Button>
          </form>
          <h3>Permission matrix</h3>
          <div className="list">
            {roles.map((r) => (
              <div key={r} className="list-item">
                <div className="flex1">
                  <div className="main-text">{label(r)}</div>
                  <div className="sub-text">{(matrix[r] ?? []).includes('*') ? 'every permission' : (matrix[r] ?? []).map(label).join(', ')}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
