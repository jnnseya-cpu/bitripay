import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, Chip, Field, Input, KV, Modal, PageHeader } from '../components/ui';

export function Profile() {
  const { user, toast, refresh } = useStore();
  const [name, setName] = useState(user?.fullName ?? '');
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [disable, setDisable] = useState(false);
  const [pin, setPin] = useState({ pin: '', currentPin: '' });
  const run = (p: Promise<unknown>, msg: string) => p.then(() => { toast(msg, 'success'); refresh(); }).catch((e) => toast(e.message, 'error'));
  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader title="My profile" subtitle="Update your details, password and two-factor authentication" />
      <div className="grid cols-2">
        <div className="card">
          <h4>Profile</h4>
          <KV k="Email" v={user?.email} /><KV k="Role" v={<Chip kind="primary">{user?.permissions?.length ? 'staff admin' : 'super admin'}</Chip>} /><KV k="Permissions" v={user?.permissions?.length ? user.permissions.join(', ') : 'all'} />
          <Field label="Full name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Button onClick={() => run(api.patch('/api/account/profile', { fullName: name }), 'Profile updated')}>Save</Button>
        </div>
        <div className="card">
          <h4>Change password</h4>
          <Field label="Current password"><Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label="New password"><Input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <Button onClick={() => run(api.post('/api/account/password', pw), 'Password changed').then(() => setPw({ currentPassword: '', newPassword: '' }))} disabled={pw.newPassword.length < 8}>Change password</Button>
        </div>
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-title"><h4>Approval step-up PIN</h4>{user?.hasPin ? <Chip kind="success">Set</Chip> : <Chip kind="warning">Not set</Chip>}</div>
          <p className="small muted">Approving payouts, manual settlements and remittances requires a fresh step-up. Enter this PIN when asked (a registered passkey is accepted as well). It is never stored in plain text.</p>
          <div className="row wrap">
            {user?.hasPin && <Field label="Current PIN"><Input type="password" inputMode="numeric" value={pin.currentPin} onChange={(e) => setPin({ ...pin, currentPin: e.target.value })} style={{ width: 140 }} /></Field>}
            <Field label={user?.hasPin ? 'New PIN (4-6 digits)' : 'PIN (4-6 digits)'}><Input type="password" inputMode="numeric" value={pin.pin} onChange={(e) => setPin({ ...pin, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} style={{ width: 140 }} /></Field>
            <Button onClick={() => run(api.post('/api/account/pin', { pin: pin.pin, currentPin: pin.currentPin || undefined }), 'PIN saved').then(() => setPin({ pin: '', currentPin: '' }))} disabled={pin.pin.length < 4}>Save PIN</Button>
          </div>
        </div>
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="card-title"><h4>Two-factor authentication</h4>{user?.twoFactorEnabled ? <Chip kind="success">Enabled</Chip> : <Chip>Disabled</Chip>}</div>
          {!user?.twoFactorEnabled && !setup && <Button onClick={() => api.post<{ qr: string; secret: string }>('/api/account/2fa/setup').then(setSetup)}>Set up 2FA</Button>}
          {setup && <div className="grid cols-2"><div className="center"><img src={setup.qr} alt="" style={{ width: 200 }} /><div className="tiny mono">{setup.secret}</div></div><div><Field label="Code from authenticator"><Input className="pin-input" value={code} onChange={(e) => setCode(e.target.value)} /></Field><Button onClick={() => run(api.post('/api/account/2fa/enable', { code }), '2FA enabled').then(() => setSetup(null))}>Enable</Button></div></div>}
          {user?.twoFactorEnabled && <Button variant="danger" onClick={() => setDisable(true)}>Disable 2FA</Button>}
          <Modal open={disable} onClose={() => setDisable(false)} title="Disable 2FA"><Field label="Authenticator code"><Input className="pin-input" value={code} onChange={(e) => setCode(e.target.value)} /></Field><Button block variant="danger" onClick={() => run(api.post('/api/account/2fa/disable', { code }), '2FA disabled').then(() => setDisable(false))}>Disable</Button></Modal>
        </div>
      </div>
    </div>
  );
}
