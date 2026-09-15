import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { alertsEnabled, armAlerts, loudAlert, setAlertsEnabled } from '../lib/alerts';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Alert, Avatar, Button, Chip, CopyButton, Field, Input, KV, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, useAsync } from '../components/ui';
import type { User } from '@bitripay/shared';
import { currencyFlag } from '@bitripay/shared';
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
    { id: 'notifications', label: t('settings.notifications') },
  ];
  return (
    <div style={{ maxWidth: 760 }}>
      <PageHeader title={t('nav.settings')} />
      <Tabs tabs={tabs} value={tab} onChange={(v) => setParams({ tab: v })} />
      {tab === 'profile' && <Profile />}
      {tab === 'security' && <Security />}
      {tab === 'kyc' && <Kyc />}
      {tab === 'preferences' && <Preferences />}
      {tab === 'notifications' && <NotificationPreferences />}
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
      <div className="list-item mb">
        <Avatar user={user} size="lg" />
        <div>
          <div className="main-text" style={{ fontSize: '1.1rem' }}>
            {user?.fullName}
          </div>
          <div className="sub-text">
            @{user?.tag} · {user?.role} · referral code {user?.referralCode}
          </div>
        </div>
      </div>
      <form onSubmit={save}>
        <Field label={t('auth.fullName')}>
          <Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        </Field>
        <Field label="@tag" hint="Others use this to pay you">
          <Input value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} />
        </Field>
        {user?.role !== 'user' && (
          <Field label="Business name">
            <Input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} />
          </Field>
        )}
        <Field label={t('auth.country')}>
          <Select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
            <option value="">—</option>
            {(config?.countries ?? []).map((c) => (
              <option key={c.code} value={c.code}>
                {currencyFlag(c.code)} {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button>{t('common.save')}</Button>
      </form>
      <div className="divider" />
      <KV
        k={t('auth.email')}
        v={
          <span className="row" style={{ justifyContent: 'flex-end' }}>
            {user?.email ?? '—'}{' '}
            {user?.email &&
              (user.emailVerified ? (
                <Chip kind="success">verified</Chip>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => requestVerify('email')}>
                  Verify
                </Button>
              ))}
          </span>
        }
      />
      <KV
        k={t('auth.phone')}
        v={
          <span className="row" style={{ justifyContent: 'flex-end' }}>
            {user?.phone ?? '—'}{' '}
            {user?.phone &&
              (user.phoneVerified ? (
                <Chip kind="success">verified</Chip>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => requestVerify('sms')}>
                  Verify
                </Button>
              ))}
          </span>
        }
      />
      <Modal open={!!otp} onClose={() => setOtp(null)} title="Enter verification code">
        <Alert kind="info">{otp?.info}</Alert>
        <Field label={t('auth.code')}>
          <Input className="pin-input" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Button block onClick={confirmVerify}>
          {t('common.confirm')}
        </Button>
      </Modal>
    </div>
  );
}

function Passkeys() {
  const { toast, setHasPasskeys } = useStore();
  const list = useAsync(() => api.get<{ items: any[] }>('/api/account/passkeys'), []);
  const [platform, setPlatform] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    biometricsAvailable().then(setPlatform);
  }, []);
  useEffect(() => {
    if (list.data) setHasPasskeys(list.data.items.length > 0);
  }, [list.data, setHasPasskeys]);
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
      <div className="card-title">
        <h3>Biometric login & payment confirmation</h3>
        {list.data && list.data.items.length > 0 ? (
          <Chip kind="success">
            {list.data.items.length} device{list.data.items.length > 1 ? 's' : ''}
          </Chip>
        ) : (
          <Chip>Not set up</Chip>
        )}
      </div>
      <p className="small muted">Use Face ID, Touch ID, Windows Hello or your phone's fingerprint (passkeys) to sign in without a password and to confirm payments instead of typing your PIN.</p>
      {!passkeysSupported() ? (
        <Alert kind="warning">This browser does not support passkeys.</Alert>
      ) : platform === false ? (
        <Alert kind="info">No built-in biometric sensor detected here; a security key or your phone can still be used as a passkey.</Alert>
      ) : null}
      <div className="list">
        {list.data?.items.map((k) => (
          <div key={k.id} className="list-item">
            <div className="flex1">
              <div className="main-text">
                {k.deviceName || 'Passkey'} {k.deviceType === 'multiDevice' && <Chip>synced</Chip>}
              </div>
              <div className="sub-text">
                Added {new Date(k.createdAt).toLocaleDateString()}
                {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleString()}` : ''}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => api.del(`/api/account/passkeys/${k.id}`).then(list.reload)}>
              Remove
            </Button>
          </div>
        ))}
      </div>
      {passkeysSupported() && (
        <Button className="mt-sm" loading={busy} onClick={add}>
          🔐 Add this device
        </Button>
      )}
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
  // recovery codes are shown exactly once (on enable or regenerate); the API only keeps their hashes
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [regenOpen, setRegenOpen] = useState(false);
  const policy = useAsync(() => api.get<{ required: boolean; deadline: string | null; overdue: boolean; enabled: boolean }>('/api/account/2fa/policy'), [user?.twoFactorEnabled]);
  const remaining = useAsync(
    () => (user?.twoFactorEnabled ? api.get<{ remaining: number; total: number }>('/api/account/2fa/recovery-codes') : Promise.resolve(null)),
    [user?.twoFactorEnabled, recoveryCodes],
  );
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
      {policy.data?.required && !policy.data.enabled && (
        <div style={{ gridColumn: 'span 2' }}>
          <Alert kind={policy.data.overdue ? 'error' : 'warning'}>
            {policy.data.overdue
              ? 'Two-factor authentication is required for your account. Enable it below to keep using BitriPay.'
              : `Two-factor authentication becomes mandatory for your account on ${policy.data.deadline ? new Date(policy.data.deadline).toLocaleDateString() : 'the end of the grace period'}. Set it up now.`}
          </Alert>
        </div>
      )}
      <Passkeys />
      <div className="card">
        <h3>{t('settings.password')}</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api.post('/api/account/password', pw), 'Password changed').then(() => setPw({ currentPassword: '', newPassword: '' }));
          }}
        >
          <Field label="Current password">
            <Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
          </Field>
          <Field label="New password">
            <Input type="password" minLength={8} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
          </Field>
          <Button>{t('common.save')}</Button>
        </form>
      </div>
      <div className="card">
        <h3>{t('settings.pin')}</h3>
        <p className="small muted">Required to send money, pay and withdraw.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api.post('/api/account/pin', { pin: pin.pin, currentPin: pin.currentPin || undefined }), 'PIN saved').then(() => setPin({ pin: '', currentPin: '' }));
          }}
        >
          {user?.hasPin && (
            <Field label="Current PIN">
              <Input className="pin-input" type="password" inputMode="numeric" maxLength={6} value={pin.currentPin} onChange={(e) => setPin({ ...pin, currentPin: e.target.value })} />
            </Field>
          )}
          <Field label={user?.hasPin ? 'New PIN' : 'Choose a 4–6 digit PIN'}>
            <Input className="pin-input" type="password" inputMode="numeric" maxLength={6} value={pin.pin} onChange={(e) => setPin({ ...pin, pin: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <Button disabled={pin.pin.length < 4}>{t('common.save')}</Button>
        </form>
      </div>
      <div className="card" style={{ gridColumn: 'span 2' }}>
        <div className="card-title">
          <h3>{t('settings.2fa')}</h3>
          {user?.twoFactorEnabled ? <Chip kind="success">Enabled</Chip> : <Chip>Disabled</Chip>}
        </div>
        <p className="small muted">Use Google Authenticator, Authy or any TOTP app for a second login step.</p>
        {!user?.twoFactorEnabled && !setup && <Button onClick={() => api.post<{ qr: string; secret: string }>('/api/account/2fa/setup').then(setSetup)}>Set up 2FA</Button>}
        {setup && (
          <div className="grid cols-2">
            <div className="center">
              <img src={setup.qr} alt="2FA QR" style={{ width: 200 }} />
              <div className="tiny mono">{setup.secret}</div>
            </div>
            <div>
              <Field label="Enter the 6-digit code from your app">
                <Input className="pin-input" value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
              <Button
                onClick={() =>
                  run(
                    () =>
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
        {recoveryCodes && <RecoveryCodes codes={recoveryCodes} onDone={() => setRecoveryCodes(null)} />}
        {user?.twoFactorEnabled && !recoveryCodes && (
          <>
            <p className="small muted">
              Recovery codes let you sign in if you lose your authenticator. Each code works once.{' '}
              {remaining.data ? (
                <b>
                  {remaining.data.remaining} of {remaining.data.total} unused.
                </b>
              ) : null}
            </p>
            <div className="row wrap">
              <Button variant="secondary" onClick={() => setRegenOpen(true)}>
                Regenerate recovery codes
              </Button>
              <Button variant="danger" onClick={() => setDisableOpen(true)}>
                Disable 2FA
              </Button>
            </div>
          </>
        )}
        <Modal open={regenOpen} onClose={() => setRegenOpen(false)} title="Regenerate recovery codes">
          <p className="small muted">Your current codes stop working the moment a new set is issued. Confirm with the code from your authenticator app.</p>
          <Field label="Authenticator code">
            <Input className="pin-input" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Button
            block
            onClick={() =>
              run(
                () =>
                  api.post<{ recoveryCodes: string[] }>('/api/account/2fa/recovery-codes/regenerate', { code }).then((r) => {
                    setRecoveryCodes(r.recoveryCodes);
                    setCode('');
                  }),
                'New recovery codes issued',
              ).then(() => setRegenOpen(false))
            }
          >
            Issue new codes
          </Button>
        </Modal>
        <Modal open={disableOpen} onClose={() => setDisableOpen(false)} title="Disable 2FA">
          <Field label="Authenticator code">
            <Input className="pin-input" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Button block variant="danger" onClick={() => run(() => api.post('/api/account/2fa/disable', { code }), '2FA disabled').then(() => setDisableOpen(false))}>
            Disable
          </Button>
        </Modal>
      </div>
    </div>
  );
}

/** One-time display of 2FA recovery codes: they are never retrievable again, so the holder copies them before moving on. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="mt">
      <Alert kind="warning">Save these recovery codes somewhere safe. They are shown only once and each one signs you in a single time if you lose your authenticator.</Alert>
      <div className="grid cols-2 mono" style={{ gap: 6, margin: '12px 0' }}>
        {codes.map((c) => (
          <div key={c} className="card" style={{ padding: '6px 10px', textAlign: 'center' }}>
            {c}
          </div>
        ))}
      </div>
      <div className="row wrap">
        <CopyButton text={codes.join('\n')} label="Copy all codes" />
        <Button variant="secondary" onClick={onDone}>
          I have saved my codes
        </Button>
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
      <div className="card-title">
        <h3>Identity verification (KYC)</h3>
        <StatusBadge status={status} />
      </div>
      {status === 'verified' && <Alert kind="success">Your identity is verified. Higher limits are active.</Alert>}
      {status === 'pending' && <Alert kind="info">Your documents are under review. We'll notify you when it's done.</Alert>}
      {status === 'rejected' && <Alert kind="error">Your last submission was rejected{kyc.data?.submission?.note ? `: ${kyc.data.submission.note}` : ''}. Please submit again.</Alert>}
      {(status === 'none' || status === 'rejected') && (
        <form onSubmit={submit}>
          <div className="grid cols-2">
            <Field label="Document type">
              <Select value={form.docType} onChange={(e) => setForm({ ...form, docType: e.target.value })}>
                <option value="passport">Passport</option>
                <option value="national_id">National ID</option>
                <option value="drivers_license">Driver's license</option>
                <option value="voter_card">Voter card</option>
              </Select>
            </Field>
            <Field label="Document number">
              <Input value={form.docNumber} onChange={(e) => setForm({ ...form, docNumber: e.target.value })} required />
            </Field>
            <Field label="Full legal name">
              <Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required />
            </Field>
            <Field label="Date of birth">
              <Input type="date" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} />
            </Field>
          </div>
          <Field label="Address">
            <Textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </Field>
          <div className="grid cols-3">
            <Field label="Document front">
              <input type="file" accept="image/*" onChange={file('docFront')} />
              {form.docFront && <img src={form.docFront} alt="" style={{ maxHeight: 80, borderRadius: 8 }} />}
            </Field>
            <Field label="Document back">
              <input type="file" accept="image/*" onChange={file('docBack')} />
              {form.docBack && <img src={form.docBack} alt="" style={{ maxHeight: 80, borderRadius: 8 }} />}
            </Field>
            <Field label="Selfie">
              <input type="file" accept="image/*" capture="user" onChange={file('selfie')} />
              {form.selfie && <img src={form.selfie} alt="" style={{ maxHeight: 80, borderRadius: 8 }} />}
            </Field>
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
  const [loud, setLoud] = useState(user?.loudAlerts !== false && alertsEnabled());
  const toggleLoud = async (on: boolean) => {
    setLoud(on);
    setAlertsEnabled(on);
    if (on) armAlerts();
    try {
      const r = await api.patch<{ user: User }>('/api/account/profile', { loudAlerts: on });
      setUser(r.user);
    } catch {
      /* ignore */
    }
  };
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
        <Select value={lang} onChange={(e) => change(e.target.value)}>
          {(config?.languages ?? []).map((l) => (
            <option key={l.code} value={l.code}>
              {l.nativeName} ({l.name})
            </option>
          ))}
        </Select>
      </Field>
      <div className="row between">
        <span>{t('settings.theme')}</span>
        <button type="button" className={`switch ${theme === 'dark' ? 'on' : ''}`} onClick={toggleTheme} aria-label="Toggle dark mode" />
      </div>
      <div className="row between mt-sm">
        <span>
          🔔 Loud alerts<div className="tiny muted">Alarm sound and long vibration whenever money arrives, a payout completes or something needs your attention.</div>
        </span>
        <button type="button" className={`switch ${loud ? 'on' : ''}`} onClick={() => toggleLoud(!loud)} aria-label="Toggle loud alerts" />
      </div>
      {loud && (
        <div className="mt-sm">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              armAlerts();
              loudAlert('Test alert', 'This is how a money alert sounds.');
            }}
          >
            Test alert
          </Button>
        </div>
      )}
      <div className="divider" />
      <KV k="Account created" v={user ? new Date(user.createdAt).toLocaleDateString() : ''} />
      <KV k="User ID" v={<span className="mono tiny">{user?.id}</span>} />
    </div>
  );
}

const CHANNEL_LABELS: Record<string, string> = { email: 'Email', inapp: 'In app', sms: 'SMS', push: 'Push', whatsapp: 'WhatsApp' };

/** Opt out per kind of notice and channel; mandatory notices (security, money movement, legal) are always delivered. */
function NotificationPreferences() {
  const t = useT();
  const data = useAsync(
    () =>
      api.get<{
        channels: string[];
        categories: { id: string; label: string; description: string; events: number; mandatory: number; channels: string[] }[];
        prefs: Record<string, Record<string, boolean>>;
      }>('/api/account/notifications/preferences'),
    [],
  );
  const [prefs, setPrefs] = useState<Record<string, Record<string, boolean>> | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const current = prefs ?? data.data?.prefs ?? {};
  const isOn = (cat: string, ch: string) => current[cat]?.[ch] !== false;
  const toggle = async (cat: string, ch: string) => {
    const next = { ...current, [cat]: { ...(current[cat] ?? {}), [ch]: !isOn(cat, ch) } };
    setPrefs(next);
    try {
      const r = await api.put<{ prefs: Record<string, Record<string, boolean>> }>('/api/account/notifications/preferences', { prefs: next });
      setPrefs(r.prefs);
      setSaved(new Date().toLocaleTimeString());
    } catch {
      setPrefs(current);
    }
  };
  if (!data.data) return <div className="card">…</div>;
  return (
    <div className="card">
      <p className="muted">{t('settings.notificationsHint')}</p>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>{t('settings.notifications')}</th>
              {data.data.channels.map((ch) => (
                <th key={ch} style={{ textAlign: 'center' }}>
                  {CHANNEL_LABELS[ch] ?? ch}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.data.categories.map((c) => (
              <tr key={c.id}>
                <td>
                  <b>{c.label}</b>
                  <div className="tiny muted">
                    {c.description}
                    {c.mandatory > 0 && ` · ${c.mandatory} always sent`}
                  </div>
                </td>
                {data.data!.channels.map((ch) => (
                  <td key={ch} style={{ textAlign: 'center' }}>
                    {c.channels.includes(ch) ? (
                      <button type="button" className={`switch ${isOn(c.id, ch) ? 'on' : ''}`} onClick={() => toggle(c.id, ch)} aria-label={`${c.label} via ${CHANNEL_LABELS[ch] ?? ch}`} />
                    ) : (
                      <span className="tiny muted">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {saved && <div className="tiny muted mt-sm">Saved {saved}</div>}
    </div>
  );
}
