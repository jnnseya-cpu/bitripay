import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, Avatar, Button, Chip, Field, Input, KV, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, useAsync } from '../components/ui';
import type { User } from '@bitripay/shared';
import { registerPasskey, passkeysSupported, biometricsAvailable } from '../lib/passkeys';

export function Settings() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'profile';
  const { config } = useStore();
  const tabs = [
    { id: 'profile', label: t('settings.profile') },
    { id: 'security', label: t('settings.security') },
    ...(config?.modules.kyc !== false ? [{ id: 'kyc', label: t('settings.kyc') }] : []),
    { id: 'preferences', label: t('settings.language') },
  ];
  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader title={t('nav.settings')} />
      <Tabs tabs={tabs} value={tab} onChange={(v) => setParams({ tab: v })} />
      {tab === 'profile' && <Profile />}
      {tab === 'security' && <Security />}
      {tab === 'kyc' && <Kyc />}
      {tab === 'preferences' && <Preferences />}
    </div>
  );
}

function Profile() {
  const t = useT();
  const { user, setUser, toast, config } = useStore();
  const [form, setForm] = useState({ fullName: user?.fullName ?? '', tag: user?.tag ?? '', country: user?.country ?? '', businessName: user?.businessName ?? '' });
  const [otp, setOtp] = useState<{ channel: 'email' | 'sms'; info: string } | null>(null);
  const [code, setCode] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.patch<{ user: User }>('/api/account/profile', { ...form, country: form.country || null, businessName: form.businessName || null });
      setUser(r.user);
      toast('Profile updated', 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const requestVerify = async (channel: 'email' | 'sms') => {
    const r = await api.post<{ devCode?: string }>('/api/account/verify/request', { channel });
    setOtp({ channel, info: r.devCode ? `Code sent (sandbox: ${r.devCode})` : 'Code sent' });
  };
  const confirmVerify = async () => {
    const r = await api.post<{ user: User }>('/api/account/verify/confirm', { channel: otp!.channel, code });
    setUser(r.user);
    setOtp(null);
    toast('Verified', 'success');
  };
  return (
    <div className="card">
      <div className="list-item mb"><Avatar user={user} size="lg" /><div><div className="main-text" style={{ fontSize: '1.1rem' }}>{user?.fullName}</div><div className="sub-text">@{user?.tag} · {user?.role} · referral code {user?.referralCode}</div></div></div>
      <form onSubmit={save}>
        <Field label={t('auth.fullName')}><Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></Field>
        <Field label="@tag" hint="Others use this to pay you"><Input value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} /></Field>
        {user?.role !== 'user' && <Field label="Business name"><Input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} /></Field>}
        <Field label={t('auth.country')}><Select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}><option value="">—</option>{(config?.countries ?? []).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</Select></Field>
        <Button>{t('common.save')}</Button>
      </form>
      <div className="divider" />
      <KV k={t('auth.email')} v={<span className="row" style={{ justifyContent: 'flex-end' }}>{user?.email ?? '—'} {user?.email && (user.emailVerified ? <Chip kind="success">verified</Chip> : <Button size="sm" variant="secondary" onClick={() => requestVerify('email')}>Verify</Button>)}</span>} />
      <KV k={t('auth.phone')} v={<span className="row" style={{ justifyContent: 'flex-end' }}>{user?.phone ?? '—'} {user?.phone && (user.phoneVerified ? <Chip kind="success">verified</Chip> : <Button size="sm" variant="secondary" onClick={() => requestVerify('sms')}>Verify</Button>)}</span>} />
      <Modal open={!!otp} onClose={() => setOtp(null)} title="Enter verification code">
        <Alert kind="info">{otp?.info}</Alert>
        <Field label={t('auth.code')}><Input className="pin-input" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <Button block onClick={confirmVerify}>{t('common.confirm')}</Button>
      </Modal>
    </div>
  );
}

function Passkeys() {
  const { toast, setHasPasskeys } = useStore();
  const list = useAsync(() => api.get<{ items: any[] }>('/api/account/passkeys'), []);
  const [platform, setPlatform] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { biometricsAvailable().then(setPlatform); }, []);
  useEffect(() => { if (list.data) setHasPasskeys(list.data.items.length > 0); }, [list.data, setHasPasskeys]);
  const add = async () => {
    setBusy(true);
    try {
      await registerPasskey();
      toast('Biometric login enabled on this device', 'success');
      list.reload();
    } catch (err) {
      toast((err as Error).message || 'Registration cancelled', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" style={{ gridColumn: 'span 2' }}>
      <div className="card-title"><h3>Biometric login & payment confirmation</h3>{list.data && list.data.items.length > 0 ? <Chip kind="success">{list.data.items.length} device{list.data.items.length > 1 ? 's' : ''}</Chip> : <Chip>Not set up</Chip>}</div>
      <p className="small muted">Use Face ID, Touch ID, Windows Hello or your phone's fingerprint (passkeys) to sign in without a password and to confirm payments instead of typing your PIN.</p>
      {!passkeysSupported() ? <Alert kind="warning">This browser does not support passkeys.</Alert> : platform === false ? <Alert kind="info">No built-in biometric sensor detected here; a security key or your phone can still be used as a passkey.</Alert> : null}
      <div className="list">
        {list.data?.items.map((k) => (
          <div key={k.id} className="list-item"><div className="flex1"><div className="main-text">{k.deviceName || 'Passkey'} {k.deviceType === 'multiDevice' && <Chip>synced</Chip>}</div><div className="sub-text">Added {new Date(k.createdAt).toLocaleDateString()}{k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleString()}` : ''}</div></div><Button size="sm" variant="ghost" onClick={() => api.del(`/api/account/passkeys/${k.id}`).then(list.reload)}>Remove</Button></div>
        ))}
      </div>
      {passkeysSupported() && <Button className="mt-sm" loading={busy} onClick={add}>🔐 Add this device</Button>}
    </div>
  );
}

function Security() {
  const t = useT();
  const { user, toast, refresh } = useStore();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [pin, setPin] = useState({ pin: '', currentPin: '' });
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast(msg, 'success');
      await refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <div className="grid cols-2">
      <Passkeys />
      <div className="card">
        <h3>{t('settings.password')}</h3>
        <form onSubmit={(e) => { e.preventDefault(); run(() => api.post('/api/account/password', pw), 'Password changed').then(() => setPw({ currentPassword: '', newPassword: '' })); }}>
          <Field label="Current password"><Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label="New password"><Input type="password" minLength={8} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <Button>{t('common.save')}</Button>
        </form>
      </div>
      <div className="card">
        <h3>{t('settings.pin')}</h3>
        <p className="small muted">Required to send money, pay and withdraw.</p>
        <form onSubmit={(e) => { e.preventDefault(); run(() => api.post('/api/account/pin', { pin: pin.pin, currentPin: pin.currentPin || undefined }), 'PIN saved').then(() => setPin({ pin: '', currentPin: '' })); }}>
          {user?.hasPin && <Field label="Current PIN"><Input className="pin-input" type="password" inputMode="numeric" maxLength={6} value={pin.currentPin} onChange={(e) => setPin({ ...pin, currentPin: e.target.value })} /></Field>}
          <Field label={user?.hasPin ? 'New PIN' : 'Choose a 4–6 digit PIN'}><Input className="pin-input" type="password" inputMode="numeric" maxLength={6} value={pin.pin} onChange={(e) => setPin({ ...pin, pin: e.target.value.replace(/\D/g, '') })} /></Field>
          <Button disabled={pin.pin.length < 4}>{t('common.save')}</Button>
        </form>
      </div>
      <div className="card" style={{ gridColumn: 'span 2' }}>
        <div className="card-title"><h3>{t('settings.2fa')}</h3>{user?.twoFactorEnabled ? <Chip kind="success">Enabled</Chip> : <Chip>Disabled</Chip>}</div>
        <p className="small muted">Use Google Authenticator, Authy or any TOTP app for a second login step.</p>
        {!user?.twoFactorEnabled && !setup && <Button onClick={() => api.post<{ qr: string; secret: string }>('/api/account/2fa/setup').then(setSetup)}>Set up 2FA</Button>}
        {setup && (
          <div className="grid cols-2">
            <div className="center"><img src={setup.qr} alt="2FA QR" style={{ width: 200 }} /><div className="tiny mono">{setup.secret}</div></div>
            <div>
              <Field label="Enter the 6-digit code from your app"><Input className="pin-input" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
              <Button onClick={() => run(() => api.post('/api/account/2fa/enable', { code }), '2FA enabled').then(() => setSetup(null))}>Enable</Button>
            </div>
          </div>
        )}
        {user?.twoFactorEnabled && <Button variant="danger" onClick={() => setDisableOpen(true)}>Disable 2FA</Button>}
        <Modal open={disableOpen} onClose={() => setDisableOpen(false)} title="Disable 2FA">
          <Field label="Authenticator code"><Input className="pin-input" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Button block variant="danger" onClick={() => run(() => api.post('/api/account/2fa/disable', { code }), '2FA disabled').then(() => setDisableOpen(false))}>Disable</Button>
        </Modal>
      </div>
    </div>
  );
}

function Kyc() {
  const { user, toast, refresh } = useStore();
  const kyc = useAsync(() => api.get<{ submission: any; status: string }>('/api/kyc'), []);
  const [form, setForm] = useState({ docType: 'passport', docNumber: '', fullName: user?.fullName ?? '', dob: '', address: '', docFront: '', docBack: '', selfie: '' });
  const file = (key: 'docFront' | 'docBack' | 'selfie') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 2_500_000) return toast('Image must be under 2.5 MB', 'error');
    const reader = new FileReader();
    reader.onload = () => setForm((x) => ({ ...x, [key]: String(reader.result) }));
    reader.readAsDataURL(f);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/api/kyc', { ...form, dob: form.dob || null, address: form.address || null, docFront: form.docFront || null, docBack: form.docBack || null, selfie: form.selfie || null });
      toast('Submitted for review', 'success');
      kyc.reload();
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const status = user?.kycStatus ?? 'none';
  return (
    <div className="card">
      <div className="card-title"><h3>Identity verification (KYC)</h3><StatusBadge status={status} /></div>
      {status === 'verified' && <Alert kind="success">Your identity is verified. Higher limits are active.</Alert>}
      {status === 'pending' && <Alert kind="info">Your documents are under review. We'll notify you when it's done.</Alert>}
      {status === 'rejected' && <Alert kind="error">Your last submission was rejected{kyc.data?.submission?.note ? `: ${kyc.data.submission.note}` : ''}. Please submit again.</Alert>}
      {(status === 'none' || status === 'rejected') && (
        <form onSubmit={submit}>
          <div className="grid cols-2">
            <Field label="Document type"><Select value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })}><option value="passport">Passport</option><option value="national_id">National ID</option><option value="drivers_license">Driver's license</option><option value="voter_card">Voter card</option></Select></Field>
            <Field label="Document number"><Input value={form.docNumber} onChange={(e) => setForm({ ...form, docNumber: e.target.value })} required /></Field>
            <Field label="Full legal name"><Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required /></Field>
            <Field label="Date of birth"><Input type="date" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} /></Field>
          </div>
          <Field label="Address"><Textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
          <div className="grid cols-3">
            <Field label="Document front"><input type="file" accept="image/*" onChange={file('docFront')} />{form.docFront && <img src={form.docFront} alt="" style={{ maxHeight: 80, borderRadius: 8 }} />}</Field>
            <Field label="Document back"><input type="file" accept="image/*" onChange={file('docBack')} />{form.docBack && <img src={form.docBack} alt="" style={{ maxHeight: 80, borderRadius: 8 }} />}</Field>
            <Field label="Selfie"><input type="file" accept="image/*" capture="user" onChange={file('selfie')} />{form.selfie && <img src={form.selfie} alt="" style={{ maxHeight: 80, borderRadius: 8 }} />}</Field>
          </div>
          <Button>Submit for verification</Button>
        </form>
      )}
    </div>
  );
}

function Preferences() {
  const t = useT();
  const { config, lang, setLang, theme, toggleTheme, user, setUser } = useStore();
  const change = async (l: string) => {
    setLang(l);
    try {
      const r = await api.patch<{ user: User }>('/api/account/profile', { language: l });
      setUser(r.user);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="card">
      <Field label={t('settings.language')}>
        <Select value={lang} onChange={(e) => change(e.target.value)}>{(config?.languages ?? []).map((l) => <option key={l.code} value={l.code}>{l.nativeName} ({l.name})</option>)}</Select>
      </Field>
      <div className="row between">
        <span>{t('settings.theme')}</span>
        <button type="button" className={`switch ${theme === 'dark' ? 'on' : ''}`} onClick={toggleTheme} aria-label="Toggle dark mode" />
      </div>
      <div className="divider" />
      <KV k="Account created" v={user ? new Date(user.createdAt).toLocaleDateString() : ''} />
      <KV k="User ID" v={<span className="mono tiny">{user?.id}</span>} />
    </div>
  );
}
