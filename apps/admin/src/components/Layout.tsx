import { useState, type ReactNode } from 'react';
import { NavLink, Link, useNavigate } from 'react-router-dom';
import { useStore } from '../lib/store';
import { Avatar } from './ui';

const NAV: { section: string; items: { to: string; label: string; ico: string; perm: string }[] }[] = [
  { section: 'Overview', items: [{ to: '/', label: 'Dashboard', ico: '📊', perm: 'reports' }, { to: '/reports', label: 'Reports', ico: '📈', perm: 'reports' }] },
  { section: 'Care', items: [{ to: '/users?role=user', label: 'User care', ico: '👤', perm: 'users' }, { to: '/users?role=merchant', label: 'Merchant care', ico: '🏪', perm: 'users' }, { to: '/users?role=agent', label: 'Agent care', ico: '🧑‍💼', perm: 'users' }, { to: '/users?role=admin', label: 'Admin care & roles', ico: '🛡️', perm: 'admins' }] },
  { section: 'Money', items: [{ to: '/transactions', label: 'All transactions', ico: '📜', perm: 'transactions' }, { to: '/approvals', label: 'Approvals', ico: '✅', perm: 'approvals' }, { to: '/verification', label: 'Verification console', ico: '🔎', perm: 'approvals' }, { to: '/corridors', label: 'Corridors, liquidity & payouts', ico: '🌍', perm: 'approvals' }, { to: '/kyc', label: 'KYC verification', ico: '🪪', perm: 'kyc' }, { to: '/p2p', label: 'P2P & disputes', ico: '🤝', perm: 'p2p' }] },
  { section: 'Setup', items: [{ to: '/currencies', label: 'Currencies & rates', ico: '💱', perm: 'settings' }, { to: '/fees', label: 'Fees, limits & referral', ico: '🧮', perm: 'settings' }, { to: '/gateways', label: 'Deposit / payment gateways', ico: '🔌', perm: 'gateways' }, { to: '/mobile-money', label: 'Mobile money & evidence', ico: '📱', perm: 'gateways' }, { to: '/controls', label: 'Gateway controls & risk', ico: '🛡️', perm: 'settings' }, { to: '/modules', label: 'Modules & methods', ico: '🧩', perm: 'settings' }, { to: '/catalogs', label: 'Bills, top-up & gift cards', ico: '🧾', perm: 'catalogs' }] },
  { section: 'Website & apps', items: [{ to: '/site', label: 'Web, SEO & app settings', ico: '🌐', perm: 'cms' }, { to: '/pages', label: 'Pages & links', ico: '📄', perm: 'cms' }, { to: '/languages', label: 'Languages', ico: '🗣️', perm: 'cms' }, { to: '/messaging', label: 'Email, SMS & push', ico: '✉️', perm: 'settings' }] },
  { section: 'Support', items: [{ to: '/support', label: 'Support tickets', ico: '🎫', perm: 'support' }, { to: '/chat', label: 'Live chat', ico: '💬', perm: 'support' }, { to: '/inbox', label: 'Contact & newsletter', ico: '📬', perm: 'cms' }] },
  { section: 'System', items: [{ to: '/audit', label: 'Audit logs', ico: '🔍', perm: 'admins' }, { to: '/profile', label: 'My profile & 2FA', ico: '⚙️', perm: '' }] },
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout, theme, toggleTheme, can, config } = useStore();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  return (
    <div className="app-shell">
      {open && <div className="backdrop" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <Link to="/" className="brand" style={{ color: 'inherit' }}><span className="brand-logo">B</span>BitriPay <span className="chip primary">Admin</span></Link>
        {NAV.map((s) => (
          <div key={s.section}>
            <div className="nav-section">{s.section}</div>
            {s.items.filter((i) => !i.perm || can(i.perm)).map((i) => (
              <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => `nav-link ${isActive && (i.to.includes('?') ? window.location.search === i.to.slice(i.to.indexOf('?')) : true) ? 'active' : ''}`} onClick={() => setOpen(false)}>
                <span className="ico">{i.ico}</span>{i.label}
              </NavLink>
            ))}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <button className="nav-link" style={{ border: 0, background: 'transparent', cursor: 'pointer', width: '100%' }} onClick={() => { logout(); nav('/login'); }}><span className="ico">🚪</span>Sign out</button>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="row"><button className="btn secondary icon menu-btn" onClick={() => setOpen(true)}>☰</button>{config?.maintenanceMode && <span className="chip danger">Maintenance mode ON</span>}</div>
          <div className="row">
            <a className="btn ghost sm hide-mobile" href={config?.webUrl} target="_blank" rel="noreferrer">Open web app ↗</a>
            <button className="btn secondary icon" onClick={toggleTheme}>{theme === 'dark' ? '☀️' : '🌙'}</button>
            <Link to="/profile" className="row" style={{ color: 'inherit', textDecoration: 'none' }}><Avatar user={user} size="sm" /><span className="hide-mobile bold small">{user?.fullName}</span></Link>
          </div>
        </header>
        <main className="content" style={{ maxWidth: 1400 }}>{children}</main>
      </div>
    </div>
  );
}
export function Toasts() {
  const { toasts } = useStore();
  return <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>)}</div>;
}
