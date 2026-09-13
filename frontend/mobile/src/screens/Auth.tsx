import React, { useState } from 'react';
import { Dimensions, Image, ScrollView, Text, View, Pressable } from 'react-native';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Screen, Card, Button, Input, Select, Alert, T, Tabs, useTheme } from '../components/ui';
import { useNav, type ScreenProps } from '../navigation';
import type { User } from '@bitripay/shared';

type AuthResult = { token: string; user: User; requiresTwoFactor?: boolean };

export function Onboarding() {
  const { config, t } = useStore();
  const nav = useNav();
  const th = useTheme();
  const [idx, setIdx] = useState(0);
  const screens: any[] = config?.site?.onboarding?.length
    ? config.site.onboarding
    : [
        { title: 'Scan & pay in seconds', body: 'Point your camera at any BitriPay QR code to pay a friend, a shop or an agent.', color: '#2563eb' },
        { title: 'One wallet, every currency', body: 'Hold multiple currencies and send money across borders.', color: '#7c3aed' },
        { title: 'Cards, bills & top-ups', body: 'Add money by card or mobile money, pay bills and create virtual cards.', color: '#16a34a' },
      ];
  const s = screens[idx];
  const width = Dimensions.get('window').width;
  return (
    <Screen scroll={false} padded={false}>
      <Image source={require('../../assets/logo-white.png')} style={{ width: 170, height: 70, alignSelf: 'center', marginTop: 48 }} resizeMode="contain" accessibilityLabel="BitriPay" />
      <View style={{ flex: 1, backgroundColor: s.color, justifyContent: 'flex-end' }}>
        <View style={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}>
          <View style={{ width: width * 0.5, height: width * 0.5, borderRadius: width * 0.25, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 72 }}>{['📷', '💱', '💳', '🌍', '🎁'][idx % 5]}</Text>
          </View>
        </View>
        <View style={{ backgroundColor: th.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, gap: 14 }}>
          <Text style={{ fontSize: 26, fontWeight: '800', color: th.text }}>{s.title}</Text>
          <T muted>{s.body}</T>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {screens.map((_, i) => (
              <View key={i} style={{ width: i === idx ? 22 : 8, height: 8, borderRadius: 4, backgroundColor: i === idx ? th.primary : th.border }} />
            ))}
          </View>
          {idx < screens.length - 1 ? <Button title={t('common.continue')} onPress={() => setIdx(idx + 1)} /> : <Button title={t('landing.getStarted')} onPress={() => nav.navigate('Register')} />}
          <Button title={t('auth.signIn')} variant="secondary" onPress={() => nav.navigate('Login')} />
          {idx < screens.length - 1 && (
            <Pressable onPress={() => setIdx(screens.length - 1)}>
              <T muted center>
                Skip
              </T>
            </Pressable>
          )}
        </View>
      </View>
    </Screen>
  );
}

export function Login() {
  const { login, t } = useStore();
  const nav = useNav();
  const [mode, setMode] = useState<'password' | 'otp'>('password');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [otpSent, setOtpSent] = useState<string | null>(null);
  const [mfa, setMfa] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const finish = async (r: AuthResult) => {
    if (r.requiresTwoFactor) return setMfa(r.token);
    await login(r.token, r.user);
  };
  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      if (mfa) await finish(await api.post<AuthResult>('/api/auth/2fa/verify', { code }, mfa));
      else if (mode === 'password') await finish(await api.post<AuthResult>('/api/auth/login', { identifier, password }));
      else if (!otpSent) {
        const r = await api.post<{ devCode?: string }>('/api/auth/otp/request', { identifier, purpose: 'login' });
        setOtpSent(r.devCode ? `Code sent (sandbox: ${r.devCode})` : 'Code sent to your phone or inbox');
      } else await finish(await api.post<AuthResult>('/api/auth/otp/verify', { identifier, code }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Screen title={t('auth.signIn')}>
      <Image source={require('../../assets/logo.png')} style={{ width: 210, height: 87, alignSelf: 'center', marginBottom: 6 }} resizeMode="contain" accessibilityLabel="BitriPay" />
      <Card>
        {!mfa && (
          <Tabs
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
        {error && <Alert kind="error" text={error} />}
        {mfa ? (
          <Input label={t('settings.2fa')} value={code} onChangeText={setCode} keyboardType="number-pad" placeholder="123456" />
        ) : (
          <>
            <Input label={t('auth.identifier')} value={identifier} onChangeText={setIdentifier} autoCapitalize="none" keyboardType="email-address" placeholder="you@example.com or +1555…" />
            {mode === 'password' ? (
              <Input label={t('auth.password')} value={password} onChangeText={setPassword} secureTextEntry />
            ) : otpSent ? (
              <>
                <Alert text={otpSent} />
                <Input label={t('auth.code')} value={code} onChangeText={setCode} keyboardType="number-pad" />
              </>
            ) : null}
          </>
        )}
        <Button title={mfa ? t('common.confirm') : mode === 'otp' && !otpSent ? t('auth.sendCode') : t('auth.signIn')} onPress={submit} loading={loading} />
        <Pressable onPress={() => nav.navigate('Register')}>
          <T center muted>
            {t('auth.noAccount')} <T color="#2563eb">{t('auth.signUp')}</T>
          </T>
        </Pressable>
      </Card>
    </Screen>
  );
}

export function Register({ route }: ScreenProps<'Register'>) {
  const { login, t, config } = useStore();
  const nav = useNav();
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', password: '', role: route.params?.role ?? 'user', businessName: '', referralCode: '', country: '', otpCode: '' });
  const [otpInfo, setOtpInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const sendCode = async () => {
    try {
      const r = await api.post<{ devCode?: string }>('/api/auth/otp/request', { identifier: form.phone || form.email, purpose: 'register' });
      setOtpInfo(r.devCode ? `Code sent (sandbox: ${r.devCode})` : 'Verification code sent');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      const body: Record<string, unknown> = { fullName: form.fullName, password: form.password, role: form.role };
      for (const k of ['email', 'phone', 'businessName', 'referralCode', 'country', 'otpCode'] as const) if (form[k]) body[k] = form[k];
      const r = await api.post<AuthResult>('/api/auth/register', body);
      await login(r.token, r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Screen title={t('auth.signUp')}>
      <Card>
        {error && <Alert kind="error" text={error} />}
        <Select
          label={t('auth.role')}
          value={form.role}
          onChange={(v) => set('role', v)}
          options={[
            { value: 'user', label: t('auth.role.user') },
            { value: 'merchant', label: t('auth.role.merchant') },
            { value: 'agent', label: t('auth.role.agent') },
          ]}
        />
        <Input label={t('auth.fullName')} value={form.fullName} onChangeText={(v) => set('fullName', v)} />
        {form.role !== 'user' && <Input label="Business name" value={form.businessName} onChangeText={(v) => set('businessName', v)} />}
        <Input label={t('auth.phone')} value={form.phone} onChangeText={(v) => set('phone', v)} keyboardType="phone-pad" placeholder="+1555…" />
        <Input label={t('auth.email')} value={form.email} onChangeText={(v) => set('email', v)} autoCapitalize="none" keyboardType="email-address" />
        <Input label={t('auth.password')} value={form.password} onChangeText={(v) => set('password', v)} secureTextEntry />
        <Select
          label={t('auth.country')}
          value={form.country}
          onChange={(v) => set('country', v)}
          options={[{ value: '', label: '—' }, ...((config?.countries ?? []) as any[]).map((c) => ({ value: c.code, label: c.name }))]}
        />
        <Input label={t('auth.referral')} value={form.referralCode} onChangeText={(v) => set('referralCode', v)} autoCapitalize="characters" />
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}>
            <Input label={t('auth.code')} value={form.otpCode} onChangeText={(v) => set('otpCode', v)} keyboardType="number-pad" hint={otpInfo ?? 'Optional: verify your phone or email now'} />
          </View>
          <Button title={t('auth.sendCode')} variant="secondary" small onPress={sendCode} disabled={!form.phone && !form.email} />
        </View>
        <Button title={t('auth.signUp')} onPress={submit} loading={loading} disabled={!form.fullName || form.password.length < 8 || (!form.email && !form.phone)} />
        <Pressable onPress={() => nav.navigate('Login')}>
          <T center muted>
            {t('auth.haveAccount')} <T color="#2563eb">{t('auth.signIn')}</T>
          </T>
        </Pressable>
      </Card>
      <ScrollView />
    </Screen>
  );
}
