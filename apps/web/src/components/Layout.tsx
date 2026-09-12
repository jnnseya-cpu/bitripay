import { useState, type ReactNode, useEffect } from 'react';
import { NavLink, Link, useNavigate } from 'react-router-dom';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { Avatar } from './ui';
import { api } from '../lib/api';
import { onPwaChange, pwaState } from '../lib/pwa';

interface NavItem {
  to: string;
  key: string;
  ico: string;
  module?: string;
}

/** Shown while the network is down: the shell keeps working on the last synced state (rule 14: nothing offline is final). */
function OfflineBanner() {
  const t = useT();
  const [, force] = useState(0);
  useEffect(() => onPwaChange(() => force((n) => n + 1)), []);
  if (pwaState.online) return null;
  return <div className="alert warning" role="status">📡 {t('pwa.offline')}{pwaState.lastSync ? ` ${t('pwa.lastSync')}: ${new Date(pwaState.lastSync).toLocaleString()}.` : ''}</div>;
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, config, logout, theme, toggleTheme, unread, notifications, lang, setLang, refreshWallets } = useStore();
  const t = useT();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const m = config?.modules ?? {};
  const has = (key?: string) => !key || m[key] !== false;

  const main: NavItem[] = [
    { to: '/app', key: 'nav.dashboard', ico: '🏠' },
    { to: '/app/assist', key: 'nav.assist', ico: '🧭' },
    { to: '/app/scan', key: 'nav.scan', ico: '📷', module: 'qrPayments' },
    { to: '/app/receive', key: 'nav.receive', ico: '🔳', module: 'qrPayments' },
    { to: '/app/send', key: 'nav.send', ico: '📤', module: 'transfers' },
    { to: '/app/move', key: 'nav.move', ico: '🔀', module: 'transfers' },
    { to: '/app/requests', key: 'nav.requests', ico: '🔗', module: 'moneyRequests' },
    { to: '/app/add-money', key: 'nav.addMoney', ico: '➕', module: 'addMoney' },
    { to: '/app/withdraw', key: 'nav.withdraw', ico: '🏦', module: 'withdrawals' },
    { to: '/app/agents', key: 'nav.agents', ico: '🏪', module: 'agents' },
    { to: '/app/remittance', key: 'nav.remittance', ico: '🌍', module: 'remittance' },
    { to: '/app/exchange', key: 'nav.exchange', ico: '💱', module: 'exchange' },
    { to: '/app/savings', key: 'nav.savings', ico: '🎯' },
  ];
  const services: NavItem[] = [
    { to: '/app/cards', key: 'nav.cards', ico: '💳', module: 'virtualCards' },
    { to: '/app/bills', key: 'nav.bills', ico: '🧾', module: 'billPay' },
    { to: '/app/topup', key: 'nav.topup', ico: '📶', module: 'mobileTopup' },
    { to: '/app/gift-cards', key: 'nav.giftCards', ico: '🎁', module: 'giftCards' },
    { to: '/app/p2p', key: 'nav.p2p', ico: '🤝', module: 'p2p' },
  ];
  const account: NavItem[] = [
    { to: '/app/transactions', key: 'nav.transactions', ico: '📜' },
    { to: '/app/statements', key: 'nav.statements', ico: '🧾' },
    { to: '/app/referrals', key: 'nav.referrals', ico: '🎉', module: 'referrals' },
    { to: '/app/support', key: 'nav.support', ico: '💬', module: 'support' },
    { to: '/app/settings', key: 'nav.settings', ico: '⚙️' },
  ];

  const renderItems = (items: NavItem[]) =>
    items.filter((i) => has(i.module)).map((i) => (
      <NavLink key={i.to} to={i.to} end={i.to === '/app'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => setOpen(false)}>
        <span className="ico">{i.ico}</span>
        {t(i.key)}
      </NavLink>
    ));

  return (
    <div className="app-shell">
      {open && <div className="backdrop" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <Link to="/app" className="brand" style={{ color: 'inherit' }} aria-label="BitriPay">
          <img className="brand-img swap" src="/brand/logo.svg" alt="BitriPay" width={140} height={34} />
        </Link>
        {renderItems(main)}
        {(user?.role === 'merchant' || user?.role === 'admin') && has('merchantGateway') && (
          <>
            <div className="nav-section">{t('nav.merchant')}</div>
            {renderItems([
              { to: '/app/merchant', key: 'nav.dashboard', ico: '📊' },
              { to: '/app/merchant/pos', key: 'nav.receive', ico: '🧾' },
              { to: '/app/merchant/gateway', key: 'nav.merchant', ico: '🔌' },
              { to: '/app/merchant/centre', key: 'nav.centre', ico: '🧭' },
              { to: '/app/merchant/qr', key: 'nav.qrCentre', ico: '🔳' },
              { to: '/app/merchant/developer', key: 'nav.developer', ico: '🧑‍💻' },
            ])}
          </>
        )}
        {user?.role === 'agent' && has('agents') && (
          <>
            <div className="nav-section">{t('nav.agentTools')}</div>
            {renderItems([{ to: '/app/agent', key: 'nav.agentTools', ico: '🏪' }])}
          </>
        )}
        <div className="nav-section">Services</div>
        {renderItems(services)}
        <div className="nav-section">Account</div>
        {renderItems(account)}
        <div style={{ flex: 1 }} />
        <button className="nav-link" style={{ border: 0, background: 'transparent', cursor: 'pointer', width: '100%' }} onClick={() => { logout(); nav('/'); }}>
          <span className="ico">🚪</span>
          {t('nav.logout')}
        </button>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="row">
            <button className="btn secondary icon menu-btn" onClick={() => setOpen(true)} aria-label="Menu">☰</button>
            {user?.kycStatus !== 'verified' && has('kyc') && (
              <Link to="/app/settings?tab=kyc" className="chip warning hide-mobile" style={{ textDecoration: 'none' }}>
                {user?.kycStatus === 'pending' ? 'KYC under review' : 'Verify your identity →'}
              </Link>
            )}
          </div>
          <div className="row">
            <select className="input" style={{ width: 'auto', padding: '6px 8px' }} value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language">
              {(config?.languages ?? [{ code: 'en', nativeName: 'English' }]).map((l) => (
                <option key={l.code} value={l.code}>
                  {l.nativeName}
                </option>
              ))}
            </select>
            <button className="btn secondary icon" onClick={toggleTheme} aria-label="Toggle theme">{theme === 'dark' ? '☀️' : '🌙'}</button>
            <div style={{ position: 'relative' }}>
              <button className="btn secondary icon" onClick={() => setNotifOpen((o) => !o)} aria-label="Notifications">
                🔔
                {unread > 0 && <span className="chip danger" style={{ position: 'absolute', top: -6, right: -6, padding: '0 6px' }}>{unread}</span>}
              </button>
              {notifOpen && (
                <div className="card" style={{ position: 'absolute', right: 0, top: 44, width: 340, maxHeight: 420, overflowY: 'auto', zIndex: 30, padding: 12 }}>
                  <div className="card-title">
                    <h4 style={{ margin: 0 }}>Notifications</h4>
                    <button className="btn ghost sm" onClick={() => api.post('/api/account/notifications/read').then(refreshWallets)}>Mark all read</button>
                  </div>
                  {notifications.length === 0 && <div className="muted small">No notifications</div>}
                  {notifications.slice(0, 20).map((n) => (
                    <div key={n.id} className="list-item" style={{ opacity: n.read ? 0.7 : 1 }}>
                      <div className="flex1">
                        <div className="main-text small">{n.title}</div>
                        <div className="sub-text">{n.body}</div>
                        <div className="tiny muted">{new Date(n.createdAt).toLocaleString()}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <Link to="/app/settings" className="row" style={{ color: 'inherit', textDecoration: 'none' }}>
              <Avatar user={user} size="sm" />
              <span className="hide-mobile bold small">{user?.fullName}</span>
            </Link>
          </div>
        </header>
        <main className="content"><OfflineBanner />{children}</main>
      </div>
    </div>
  );
}

export function Toasts() {
  const { toasts } = useStore();
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>
      ))}
    </div>
  );
}
