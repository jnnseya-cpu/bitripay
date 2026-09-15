import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT, tr } from '../lib/i18n';
import { Alert, Button, Field, Input, Select, Tabs } from '../components/ui';
import type { User } from '@bitripay/shared';
import { currencyFlag } from '@bitripay/shared';
import { loginWithPasskey, passkeysSupported } from '../lib/passkeys';

type AuthResult = { token: string; user: User; requiresTwoFactor?: boolean };

function AuthShell({ title, children, footer }: { title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <Link to="/" className="brand" style={{ color: 'inherit', justifyContent: 'center' }}>
          <img className="brand-img lg swap" src="/brand/logo.svg" alt="BitriPay" width={214} height={52} />
        </Link>
        <div className="card">
          <h2 className="center">{title}</h2>
          {children}
        </div>
        {footer && <p className="center muted mt">{footer}</p>}
      </div>
    </div>
  );
}

export function Login() {
  const t = useT();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { login, config } = useStore();
  const [mode, setMode] = useState<'password' | 'otp'>('password');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [otpSent, setOtpSent] = useState<string | null>(null);
  const [mfa, setMfa] = useState<{ token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const next = params.get('next') || '/app';

  const finish = async (res: AuthResult) => {
    if (res.requiresTwoFactor) {
      setMfa({ token: res.token });
      return;
    }
    await login(res.token, res.user);
    nav(next);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mfa) {
        const res = await api.post<AuthResult>('/api/auth/2fa/verify', { code }, { token: mfa.token });
        await finish(res);
      } else if (mode === 'password') {
        await finish(await api.post<AuthResult>('/api/auth/login', { identifier, password }));
      } else if (!otpSent) {
        const r = await api.post<{ devCode?: string }>('/api/auth/otp/request', { identifier, purpose: 'login' });
        setOtpSent(r.devCode ? `Code sent. (Sandbox code: ${r.devCode})` : 'Code sent. Check your phone or inbox.');
      } else {
        await finish(await api.post<AuthResult>('/api/auth/otp/verify', { identifier, code }));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title={t('auth.signIn')}
      footer={
        <>
          {t('auth.noAccount')} <Link to="/register">{t('auth.signUp')}</Link>
          {config?.adminUrl && (
            <>
              {' · '}
              <a href={`${config.adminUrl}/login`}>{t('auth.adminSignIn')}</a>
            </>
          )}
        </>
      }
    >
      {!mfa && (
        <Tabs
          pills
          tabs={[
            { id: 'password', label: t('auth.password') },
            { id: 'otp', label: t('auth.otpLogin') },
          ]}
          value={mode}
          onChange={(m) => {
            setMode(m as any);
            setOtpSent(null);
          }}
        />
      )}
      <form onSubmit={submit} className="mt">
        {error && <Alert kind="error">{error}</Alert>}
        {mfa ? (
          <Field label={t('settings.2fa')} hint={tr('Enter the 6-digit code from your authenticator app')}>
            <Input className="pin-input" autoFocus inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        ) : (
          <>
            <Field label={t('auth.identifier')}>
              <Input autoFocus value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="you@example.com or +1555…" />
            </Field>
            {mode === 'password' ? (
              <Field label={t('auth.password')}>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            ) : otpSent ? (
              <>
                <Alert kind="info">{otpSent}</Alert>
                <Field label={t('auth.code')}>
                  <Input className="pin-input" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
                </Field>
              </>
            ) : null}
          </>
        )}
        <Button block loading={loading}>
          {mfa ? t('common.confirm') : mode === 'otp' && !otpSent ? t('auth.sendCode') : t('auth.signIn')}
        </Button>
        {!mfa && passkeysSupported() && (
          <Button
            block
            type="button"
            variant="secondary"
            className="mt-sm"
            onClick={async () => {
              setError(null);
              try {
                const res = await loginWithPasskey();
                await login(res.token, res.user);
                nav(next);
              } catch (err) {
                setError((err as Error).message || 'Biometric sign-in cancelled');
              }
            }}
          >
            {tr('🔐 Sign in with biometrics / passkey')}
          </Button>
        )}
        {mode === 'password' && !mfa && (
          <p className="center mt-sm small">
            <Link to="/forgot">{t('auth.forgot')}</Link>
          </p>
        )}
      </form>
    </AuthShell>
  );
}

export function Register() {
  const t = useT();
  const nav = useNavigate();
  const { login, config } = useStore();
  const [params] = useSearchParams();
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    phone: '',
    password: '',
    role: (params.get('role') as string) || 'user',
    businessName: '',
    referralCode: params.get('ref') || '',
    country: '',
    tag: '',
    otpCode: '',
  });
  const [otpInfo, setOtpInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const sendCode = async () => {
    setError(null);
    try {
      const r = await api.post<{ devCode?: string }>('/api/auth/otp/request', { identifier: form.phone || form.email, purpose: 'register' });
      setOtpInfo(r.devCode ? `Code sent. (Sandbox code: ${r.devCode})` : 'Verification code sent.');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const body: Record<string, unknown> = { fullName: form.fullName, password: form.password, role: form.role };
      if (form.email) body.email = form.email;
      if (form.phone) body.phone = form.phone;
      if (form.businessName) body.businessName = form.businessName;
      if (form.referralCode) body.referralCode = form.referralCode;
      if (form.country) body.country = form.country;
      if (form.tag) body.tag = form.tag;
      if (form.otpCode) body.otpCode = form.otpCode;
      const res = await api.post<AuthResult>('/api/auth/register', body);
      await login(res.token, res.user);
      nav('/app');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title={t('auth.signUp')}
      footer={
        <>
          {t('auth.haveAccount')} <Link to="/login">{t('auth.signIn')}</Link>
        </>
      }
    >
      <form onSubmit={submit}>
        {error && <Alert kind="error">{error}</Alert>}
        <Field label={t('auth.role')}>
          <Select value={form.role} onChange={(e) => set('role', e.target.value)}>
            <option value="user">{t('auth.role.user')}</option>
            <option value="merchant">{t('auth.role.merchant')}</option>
            <option value="agent">{t('auth.role.agent')}</option>
            <option value="corporate">{t('auth.role.corporate')}</option>
            <option value="ngo">{t('auth.role.ngo')}</option>
            <option value="government">{t('auth.role.government')}</option>
            <option value="developer">{t('auth.role.developer')}</option>
          </Select>
        </Field>
        <Field label={t('auth.fullName')}>
          <Input required value={form.fullName} onChange={(e) => set('fullName', e.target.value)} />
        </Field>
        {form.role !== 'user' && (
          <Field label={tr('Business name')}>
            <Input value={form.businessName} onChange={(e) => set('businessName', e.target.value)} />
          </Field>
        )}
        <div className="grid cols-2">
          <Field label={t('auth.email')}>
            <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
          </Field>
          <Field label={t('auth.phone')}>
            <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+1555…" />
          </Field>
        </div>
        <Field label={t('auth.password')}>
          <Input type="password" required minLength={8} value={form.password} onChange={(e) => set('password', e.target.value)} />
        </Field>
        <div className="grid cols-2">
          <Field label={t('auth.country')}>
            <Select value={form.country} onChange={(e) => set('country', e.target.value)}>
              <option value="">—</option>
              {(config?.countries ?? []).map((c) => (
                <option key={c.code} value={c.code}>
                  {currencyFlag(c.code)} {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="@tag (optional)">
            <Input value={form.tag} onChange={(e) => set('tag', e.target.value)} placeholder="yourname" />
          </Field>
        </div>
        <Field label={t('auth.referral')}>
          <Input value={form.referralCode} onChange={(e) => set('referralCode', e.target.value)} />
        </Field>
        <Field label={t('auth.code')} hint={tr('Optional: verify your phone/email now')}>
          <div className="row">
            <Input value={form.otpCode} onChange={(e) => set('otpCode', e.target.value)} placeholder="123456" />
            <Button type="button" variant="secondary" onClick={sendCode} disabled={!form.email && !form.phone}>
              {t('auth.sendCode')}
            </Button>
          </div>
          {otpInfo && <span className="hint">{otpInfo}</span>}
        </Field>
        <Button block loading={loading}>
          {t('auth.signUp')}
        </Button>
      </form>
    </AuthShell>
  );
}

export function Forgot() {
  const t = useT();
  const nav = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (!sent) {
        const r = await api.post<{ devCode?: string }>('/api/auth/password/forgot', { identifier });
        setSent(r.devCode ? `If the account exists a code was sent. (Sandbox code: ${r.devCode})` : 'If the account exists, a code was sent.');
      } else {
        await api.post('/api/auth/password/reset', { identifier, code, password });
        nav('/login');
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <AuthShell title={t('auth.forgot')} footer={<Link to="/login">{t('common.back')}</Link>}>
      <form onSubmit={submit}>
        {error && <Alert kind="error">{error}</Alert>}
        {sent && <Alert kind="info">{sent}</Alert>}
        <Field label={t('auth.identifier')}>
          <Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} disabled={!!sent} />
        </Field>
        {sent && (
          <>
            <Field label={t('auth.code')}>
              <Input value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Field label={tr('New password')}>
              <Input type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </>
        )}
        <Button block>{sent ? t('common.confirm') : t('auth.sendCode')}</Button>
      </form>
    </AuthShell>
  );
}

/**
 * Claim link of a connected account: a platform created this merchant account through the API and sent its owner
 * here to set a password. From then on the account is theirs to sign into; the platform appears under Team.
 */
export function Claim() {
  const t = useT();
  const nav = useNavigate();
  const { token = '' } = useParams();
  const { login } = useStore();
  const [info, setInfo] = useState<{ business_name: string; platform: string; expires_at: string } | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    api
      .get<{ business_name: string; platform: string; expires_at: string }>(`/api/auth/claim/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e: Error) => setError(e.message));
  }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) return setError(tr('The two passwords differ'));
    setLoading(true);
    try {
      const r = await api.post<AuthResult>('/api/auth/claim', { token, password });
      await login(r.token, r.user);
      nav('/app/merchant/centre');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <AuthShell title={tr('Claim your BitriPay account')} footer={<Link to="/login">{t('auth.login')}</Link>}>
      {error && <Alert kind="error">{error}</Alert>}
      {info && (
        <Alert kind="info">
          <b>{info.platform}</b> created the BitriPay account of <b>{info.business_name}</b> and integrated it into your systems. Set a password to own it: your money, your settlement details and your
          statements are yours; the platform stays listed under Team until you remove it. This link works once, until {new Date(info.expires_at).toLocaleDateString()}.
        </Alert>
      )}
      <form onSubmit={submit}>
        <Field label={tr('New password')}>
          <Input type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required disabled={!info} />
        </Field>
        <Field label={tr('Confirm password')}>
          <Input type="password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} required disabled={!info} />
        </Field>
        <Button block loading={loading} disabled={!info}>
          Set password and sign in
        </Button>
      </form>
    </AuthShell>
  );
}
