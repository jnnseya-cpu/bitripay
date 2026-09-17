import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppConfig, User, Wallet, Notification, CurrencyInfo, Country, MembershipSummary } from '@bitripay/shared';
import { armAlerts, ringForNew } from './alerts';
import { api, getToken, setToken, getOrganisation, setOrganisation } from './api';
import { formatMoney as fmt } from '@bitripay/shared';

export interface FullConfig extends AppConfig {
  modules: Record<string, boolean>;
  /** National scheme brand printed on QR sheets (Instruction n°58 art. 19). */
  switchSchemeBrand?: string;
  maintenanceMode: boolean;
  registrationOpen: boolean;
  site: any;
  languages: { code: string; name: string; nativeName: string; rtl: boolean }[];
  exchangeMarginBps: number;
  countries: Country[];
  apiUrl: string;
}

interface Store {
  config: FullConfig | null;
  user: User | null;
  /** Organisations this person can act for with their own login (own shop or agent counter, or invited as a member). */
  memberships: MembershipSummary[];
  /** The workspace chosen when the person belongs to several (null = the API's default: their own, else the first membership of the surface's kind). */
  organisationId: string | null;
  setOrganisation: (id: string | null) => void;
  wallets: Wallet[];
  notifications: Notification[];
  unread: number;
  loading: boolean;
  currency: (code: string) => CurrencyInfo;
  money: (minor: number, code: string) => string;
  login: (token: string, user: User) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  refreshWallets: () => Promise<void>;
  setUser: (u: User) => void;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  lang: string;
  setLang: (l: string) => void;
  toast: (message: string, kind?: 'success' | 'error' | 'info') => void;
  toasts: { id: number; message: string; kind: 'success' | 'error' | 'info' }[];
  hasPasskeys: boolean;
  setHasPasskeys: (v: boolean) => void;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<FullConfig | null>(null);
  const [user, setUserState] = useState<User | null>(null);
  const [memberships, setMemberships] = useState<MembershipSummary[]>([]);
  const [organisationId, setOrganisationId] = useState<string | null>(() => getOrganisation());
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (localStorage.getItem('bitripay.theme') as 'light' | 'dark') || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  );
  // A first visit follows the browser's language (French browsers get French: guests on a hosted checkout page included); the choice is then kept.
  const [lang, setLangState] = useState(() => localStorage.getItem('bitripay.lang') || (typeof navigator !== 'undefined' && /^fr\b/i.test(navigator.language || '') ? 'fr' : 'en'));
  const [toasts, setToasts] = useState<Store['toasts']>([]);
  const [hasPasskeys, setHasPasskeys] = useState(false);

  const toast = useCallback((message: string, kind: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const refreshWallets = useCallback(async () => {
    if (!getToken()) return;
    const [w, n] = await Promise.all([api.get<{ items: Wallet[] }>('/api/wallets'), api.get<{ items: Notification[]; unread: number }>('/api/account/notifications')]);
    setWallets(w.items);
    setNotifications(n.items);
    setUnread(n.unread);
    ringForNew(n.items as any);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const cfg = await api.get<FullConfig>('/api/config');
      setConfig(cfg);
      if (getToken()) {
        const me = await api.get<{ user: User; memberships?: MembershipSummary[] }>('/api/auth/me');
        setUserState(me.user);
        setMemberships(me.memberships ?? []);
        // a remembered workspace the person no longer belongs to is forgotten
        if (getOrganisation() && !(me.memberships ?? []).some((m) => m.organisationId === getOrganisation())) {
          setOrganisation(null);
          setOrganisationId(null);
        }
        await refreshWallets();
        api
          .get<{ items: unknown[] }>('/api/account/passkeys')
          .then((r) => setHasPasskeys(r.items.length > 0))
          .catch(() => {});
      }
    } catch {
      setUserState(null);
    } finally {
      setLoading(false);
    }
  }, [refreshWallets]);

  useEffect(() => {
    void refresh();
    const onLogout = () => setUserState(null);
    window.addEventListener('bitripay:logout', onLogout);
    return () => window.removeEventListener('bitripay:logout', onLogout);
  }, [refresh]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('bitripay.theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('bitripay.lang', lang);
    const rtl = config?.languages.find((l) => l.code === lang)?.rtl;
    document.documentElement.dir = rtl ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [lang, config]);

  useEffect(() => {
    if (!user) return;
    const arm = () => armAlerts();
    window.addEventListener('pointerdown', arm, { once: true });
    window.addEventListener('keydown', arm, { once: true });
    const timer = setInterval(() => void refreshWallets().catch(() => {}), 20000);
    return () => clearInterval(timer);
  }, [user, refreshWallets]);

  const currency = useCallback((code: string) => config?.currencies.find((c) => c.code === code) ?? { code, name: code, symbol: code + ' ', decimals: 2, rateToBase: 1 }, [config]);
  const money = useCallback((minor: number, code: string) => fmt(minor, currency(code)), [currency]);

  const value = useMemo<Store>(
    () => ({
      config,
      user,
      memberships,
      organisationId,
      setOrganisation: (id) => {
        setOrganisation(id);
        setOrganisationId(id);
        window.dispatchEvent(new Event('bitripay:organisation'));
      },
      wallets,
      notifications,
      unread,
      loading,
      currency,
      money,
      login: async (token, u) => {
        setToken(token);
        setUserState(u);
        await refreshWallets();
        api
          .get<{ memberships?: MembershipSummary[] }>('/api/auth/me')
          .then((r) => setMemberships(r.memberships ?? []))
          .catch(() => {});
        api
          .get<{ items: unknown[] }>('/api/account/passkeys')
          .then((r) => setHasPasskeys(r.items.length > 0))
          .catch(() => {});
      },
      logout: () => {
        // Revoke this token on the server first (best effort; the local copy is dropped either way).
        if (getToken()) api.post('/api/auth/logout').catch(() => {});
        setToken(null);
        setOrganisation(null);
        setOrganisationId(null);
        setUserState(null);
        setMemberships([]);
        setWallets([]);
      },
      refresh,
      refreshWallets,
      setUser: setUserState,
      theme,
      toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
      lang,
      setLang: setLangState,
      toast,
      toasts,
      hasPasskeys,
      setHasPasskeys,
    }),
    [config, user, memberships, organisationId, wallets, notifications, unread, loading, currency, money, refresh, refreshWallets, theme, lang, toast, toasts, hasPasskeys],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore outside provider');
  return ctx;
}
