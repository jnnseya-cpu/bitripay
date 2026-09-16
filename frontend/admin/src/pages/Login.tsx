import { useState } from 'react';
import { tr } from '../lib/i18n';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Field, Input } from '../components/ui';

export function Login() {
  const { login } = useStore();
  const nav = useNavigate();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = mfa ? await api.post<any>('/api/auth/2fa/verify', { code }, { token: mfa }) : await api.post<any>('/api/auth/login', { identifier, password });
      if (res.requiresTwoFactor) return setMfa(res.token);
      if (res.user.role !== 'admin') throw new Error('This account is not an administrator');
      await login(res.token, res.user);
      nav('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand" style={{ justifyContent: 'center' }}>
          <img className="brand-img lg swap" src="/brand/logo.svg" alt="BitriPay" width={214} height={52} /> <span className="chip primary">{tr('Admin')}</span>
        </div>
        <form className="card" onSubmit={submit}>
          <h2 className="center">Sign in</h2>
          {error && <Alert kind="error">{error}</Alert>}
          {mfa ? (
            <Field label={tr('Authenticator code')}>
              <Input className="pin-input" autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
          ) : (
            <>
              <Field label={tr('Email')}>
                <Input autoFocus value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
              </Field>
              <Field label={tr('Password')}>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            </>
          )}
          <Button block loading={loading}>
            {mfa ? tr('Verify') : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
