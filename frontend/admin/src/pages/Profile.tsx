import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Chip, Field, Input, KV, Modal, PageHeader, Switch, useAsync } from '../components/ui';
import { alertsEnabled, armAlerts, loudAlert, setAlertsEnabled } from '../lib/alerts';
import { ProfilePictures } from '../components/ProfilePictures';

export function Profile() {
  const { user, toast, refresh } = useStore();
  const [name, setName] = useState(user?.fullName ?? '');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [disable, setDisable] = useState(false);
  const [pin, setPin] = useState({ pin: '', currentPin: '' });
  const [loud, setLoudState] = useState(alertsEnabled());
  // recovery codes are shown exactly once (on enable or regenerate); the API only keeps their hashes
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [regen, setRegen] = useState(false);
  const [copied, setCopied] = useState(false);
  const policy = useAsync(() => api.get<{ required: boolean; deadline: string | null; overdue: boolean; enabled: boolean }>('/api/account/2fa/policy'), [user?.twoFactorEnabled]);
  const remaining = useAsync(
    () => (user?.twoFactorEnabled ? api.get<{ remaining: number; total: number }>('/api/account/2fa/recovery-codes') : Promise.resolve(null)),
    [user?.twoFactorEnabled, recoveryCodes],
  );
  const copyCodes = () => {
    navigator.clipboard?.writeText((recoveryCodes ?? []).join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const run = (p: Promise<unknown>, msg: string) =>
    p
      .then(() => {
        toast(msg, 'success');
        refresh();
      })
      .catch((e) => toast(e.message, 'error'));
  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader title="My profile" subtitle="Update your details, password and two-factor authentication" />
      <div className="grid cols-2">
        <div className="card">
          <h4>Profile</h4>
          {user && <ProfilePictures user={user} onSaved={() => void refresh()} onError={(m) => toast(m, 'error')} />}
          <KV k="Email" v={user?.email} />
          <KV k="Role" v={<Chip kind="primary">{user?.permissions?.length ? 'staff admin' : 'super admin'}</Chip>} />
          <KV k="Permissions" v={user?.permissions?.length ? user.permissions.join(', ') : 'all'} />
          <Field label="Full name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button onClick={() => run(api.patch('/api/account/profile', { fullName: name }), 'Profile updated')}>Save</Button>
        </div>
        <div className="card">
          <h4>Change password</h4>
          <Field label="Current password">
            <Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
          </Field>
          <Field label="New password">
            <Input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
          </Field>
          <Button onClick={() => run(api.post('/api/account/password', pw), 'Password changed').then(() => setPw({ currentPassword: '', newPassword: '' }))} disabled={pw.newPassword.length < 8}>
            Change password
          </Button>
        </div>
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-title">
            <h4>Approval step-up PIN</h4>
            {user?.hasPin ? <Chip kind="success">Set</Chip> : <Chip kind="warning">Not set</Chip>}
          </div>
          <p className="small muted">
            Approving payouts, manual settlements and remittances requires a fresh step-up. Enter this PIN when asked (a registered passkey is accepted as well). It is never stored in plain text.
          </p>
          <div className="row wrap">
            {user?.hasPin && (
              <Field label="Current PIN">
                <Input type="password" inputMode="numeric" value={pin.currentPin} onChange={(e) => setPin({ ...pin, currentPin: e.target.value })} style={{ width: 140 }} />
              </Field>
            )}
            <Field label={user?.hasPin ? 'New PIN (4-6 digits)' : 'PIN (4-6 digits)'}>
              <Input type="password" inputMode="numeric" value={pin.pin} onChange={(e) => setPin({ ...pin, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} style={{ width: 140 }} />
            </Field>
            <Button
              onClick={() => run(api.post('/api/account/pin', { pin: pin.pin, currentPin: pin.currentPin || undefined }), 'PIN saved').then(() => setPin({ pin: '', currentPin: '' }))}
              disabled={pin.pin.length < 4}
            >
              Save PIN
            </Button>
          </div>
        </div>
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-title">
            <h4>Loud money alerts</h4>
            {loud ? <Chip kind="success">On</Chip> : <Chip>Off</Chip>}
          </div>
          <p className="small muted">
            A long alarm tone and vibration for approvals waiting, payouts to release, disputes and compliance holds, on this device. Sound needs one click on the page first; the test button plays it
            now.
          </p>
          <div className="row wrap">
            <Switch
              on={loud}
              onChange={(on) => {
                setLoudState(on);
                setAlertsEnabled(on);
                if (on) armAlerts();
              }}
              label="Play a very loud alert for money events"
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                armAlerts();
                loudAlert('Test alert', 'This is how a money alert sounds on this device.');
              }}
              disabled={!loud}
            >
              Test the alarm
            </Button>
          </div>
        </div>
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-title">
            <h4>Two-factor authentication</h4>
            {user?.twoFactorEnabled ? <Chip kind="success">Enabled</Chip> : <Chip>Disabled</Chip>}
          </div>
          {policy.data?.required && !policy.data.enabled && (
            <Alert kind={policy.data.overdue ? 'error' : 'warning'}>
              {policy.data.overdue
                ? 'Two-factor authentication is mandatory for administrators. Enable it now to keep using the console.'
                : `Two-factor authentication becomes mandatory for your account on ${policy.data.deadline ? new Date(policy.data.deadline).toLocaleDateString() : 'the end of the grace period'}.`}
            </Alert>
          )}
          {!user?.twoFactorEnabled && !setup && <Button onClick={() => api.post<{ qr: string; secret: string }>('/api/account/2fa/setup').then(setSetup)}>Set up 2FA</Button>}
          {setup && (
            <div className="grid cols-2">
              <div className="center">
                <img src={setup.qr} alt="" style={{ width: 200 }} />
                <div className="tiny mono">{setup.secret}</div>
              </div>
              <div>
                <Field label="Code from authenticator">
                  <Input className="pin-input" value={code} onChange={(e) => setCode(e.target.value)} />
                </Field>
                <Button
                  onClick={() =>
                    run(
                      api.post<{ recoveryCodes: string[] }>('/api/account/2fa/enable', { code }).then((r) => {
                        setRecoveryCodes(r.recoveryCodes);
                        setCode('');
                      }),
                      '2FA enabled',
                    ).then(() => setSetup(null))
                  }
                >
                  Enable
                </Button>
              </div>
            </div>
          )}
          {recoveryCodes && (
            <div className="mt">
              <Alert kind="warning">Save these recovery codes now. They are shown only once; each signs you in a single time if you lose your authenticator.</Alert>
              <div className="grid cols-4 mono" style={{ gap: 6, margin: '12px 0' }}>
                {recoveryCodes.map((c) => (
                  <div key={c} className="card" style={{ padding: '6px 10px', textAlign: 'center' }}>
                    {c}
                  </div>
                ))}
              </div>
              <div className="row wrap">
                <Button variant="secondary" size="sm" onClick={copyCodes}>
                  {copied ? 'Copied' : 'Copy all codes'}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setRecoveryCodes(null)}>
                  I have saved my codes
                </Button>
              </div>
            </div>
          )}
          {user?.twoFactorEnabled && !recoveryCodes && (
            <>
              <p className="small muted">
                Recovery codes let you sign in without your authenticator; each code works once.{' '}
                {remaining.data ? (
                  <b>
                    {remaining.data.remaining} of {remaining.data.total} unused.
                  </b>
                ) : null}
              </p>
              <div className="row wrap">
                <Button variant="secondary" onClick={() => setRegen(true)}>
                  Regenerate recovery codes
                </Button>
                <Button variant="danger" onClick={() => setDisable(true)}>
                  Disable 2FA
                </Button>
              </div>
            </>
          )}
          <Modal open={regen} onClose={() => setRegen(false)} title="Regenerate recovery codes">
            <p className="small muted">The current codes stop working as soon as a new set is issued. Confirm with the code from your authenticator app.</p>
            <Field label="Authenticator code">
              <Input className="pin-input" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Button
              block
              onClick={() =>
                run(
                  api.post<{ recoveryCodes: string[] }>('/api/account/2fa/recovery-codes/regenerate', { code }).then((r) => {
                    setRecoveryCodes(r.recoveryCodes);
                    setCode('');
                  }),
                  'New recovery codes issued',
                ).then(() => setRegen(false))
              }
            >
              Issue new codes
            </Button>
          </Modal>
          <Modal open={disable} onClose={() => setDisable(false)} title="Disable 2FA">
            <Field label="Authenticator code">
              <Input className="pin-input" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Button block variant="danger" onClick={() => run(api.post('/api/account/2fa/disable', { code }), '2FA disabled').then(() => setDisable(false))}>
              Disable
            </Button>
          </Modal>
        </div>
      </div>
    </div>
  );
}
