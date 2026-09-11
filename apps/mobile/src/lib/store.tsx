import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import type { User, Wallet, Notification, CurrencyInfo } from '@bitripay/shared';
import { formatMoney, translate } from '@bitripay/shared';
import { api, loadToken, saveToken, onLogout } from './api';

interface Store {
  ready: boolean;
  locked: boolean;
  unlock: () => Promise<void>;
  config: any;
  user: User | null;
  wallets: Wallet[];
  notifications: Notification[];
  unread: number;
  login: (token: string, user: User) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshWallets: () => Promise<void>;
  setUser: (u: User) => void;
  money: (minor: number, code: string) => string;
  currency: (code: string) => CurrencyInfo;
  t: (key: string, vars?: Record<string, string | number>) => string;
  lang: string;
  setLang: (l: string) => void;
  dark: boolean;
  setDark: (d: boolean | null) => void;
  biometrics: boolean;
  setBiometrics: (on: boolean) => Promise<void>;
  biometricsAvailable: boolean;
  toast: (m: string, kind?: 'success' | 'error' | 'info') => void;
  toasts: { id: number; message: string; kind: string }[];
}

const Ctx = createContext<Store | null>(null);

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
});

async function registerPush() {
  try {
    if (!Device.isDevice) return;
    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (existing !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return;
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'default', importance: Notifications.AndroidImportance.MAX });
    const token = (await Notifications.getExpoPushTokenAsync()).data;
    await api.post('/api/account/push-tokens', { token, platform: Platform.OS });
  } catch {
    /* push is best-effort */
  }
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [config, setConfig] = useState<any>(null);
  const [user, setUser] = useState<User | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [lang, setLangState] = useState('en');
  const [darkPref, setDarkPref] = useState<boolean | null>(null);
  const [biometrics, setBio] = useState(false);
  const [biometricsAvailable, setBioAvail] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [toasts, setToasts] = useState<Store['toasts']>([]);
  const toast = useCallback((message: string, kind: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  const refreshWallets = useCallback(async () => {
    const [w, n] = await Promise.all([api.get<{ items: Wallet[] }>('/api/wallets'), api.get<{ items: Notification[]; unread: number }>('/api/account/notifications')]);
    setWallets(w.items);
    setNotifications(n.items);
    setUnread(n.unread);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const cfg = await api.get<any>('/api/config');
      setConfig(cfg);
      const me = await api.get<{ user: User }>('/api/auth/me');
      setUser(me.user);
      await refreshWallets();
    } catch {
      /* not signed in */
    }
  }, [refreshWallets]);

  useEffect(() => {
    (async () => {
      const [savedLang, savedDark, savedBio, token] = await Promise.all([SecureStore.getItemAsync('lang'), SecureStore.getItemAsync('dark'), SecureStore.getItemAsync('biometrics'), loadToken()]);
      if (savedLang) setLangState(savedLang);
      if (savedDark) setDarkPref(savedDark === '1');
      const hw = await LocalAuthentication.hasHardwareAsync().catch(() => false);
      const enrolled = hw && (await LocalAuthentication.isEnrolledAsync().catch(() => false));
      setBioAvail(!!enrolled);
      if (savedBio === '1' && enrolled) setBio(true);
      try {
        setConfig(await api.get<any>('/api/config'));
      } catch {
        /* offline */
      }
      if (token) {
        if (savedBio === '1' && enrolled) setLocked(true);
        else await refresh();
      }
      setReady(true);
    })();
    return onLogout(() => {
      setUser(null);
      setWallets([]);
    });
  }, [refresh]);

  useEffect(() => {
    api.get<{ overrides: Record<string, string> }>(`/api/translations/${lang}`).then((r) => setOverrides(r.overrides)).catch(() => setOverrides({}));
  }, [lang]);

  useEffect(() => {
    if (!user) return;
    void registerPush();
    const id = setInterval(() => refreshWallets().catch(() => {}), 20000);
    return () => clearInterval(id);
  }, [user, refreshWallets]);

  const unlock = useCallback(async () => {
    const res = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock BitriPay', fallbackLabel: 'Use passcode' });
    if (res.success) {
      setLocked(false);
      await refresh();
    }
  }, [refresh]);

  const currency = useCallback((code: string) => config?.currencies?.find((c: CurrencyInfo) => c.code === code) ?? { code, name: code, symbol: code + ' ', decimals: 2, rateToBase: 1 }, [config]);
  const dark = darkPref ?? Appearance.getColorScheme() === 'dark';

  const value = useMemo<Store>(
    () => ({
      ready,
      locked,
      unlock,
      config,
      user,
      wallets,
      notifications,
      unread,
      login: async (token, u) => {
        await saveToken(token);
        setUser(u);
        await refresh();
      },
      logout: async () => {
        await saveToken(null);
        setUser(null);
        setWallets([]);
      },
      refresh,
      refreshWallets,
      setUser,
      money: (m, c) => formatMoney(m, currency(c)),
      currency,
      t: (key, vars) => translate(lang, key, vars, overrides),
      lang,
      setLang: (l) => {
        setLangState(l);
        SecureStore.setItemAsync('lang', l);
      },
      dark,
      setDark: (d) => {
        setDarkPref(d);
        if (d === null) SecureStore.deleteItemAsync('dark');
        else SecureStore.setItemAsync('dark', d ? '1' : '0');
      },
      biometrics,
      setBiometrics: async (on) => {
        if (on) {
          const res = await LocalAuthentication.authenticateAsync({ promptMessage: 'Confirm to enable biometric login' });
          if (!res.success) return;
        }
        setBio(on);
        await SecureStore.setItemAsync('biometrics', on ? '1' : '0');
      },
      biometricsAvailable,
      toast,
      toasts,
    }),
    [ready, locked, unlock, config, user, wallets, notifications, unread, refresh, refreshWallets, currency, lang, overrides, dark, biometrics, biometricsAvailable, toast, toasts],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useStore outside provider');
  return c;
}
