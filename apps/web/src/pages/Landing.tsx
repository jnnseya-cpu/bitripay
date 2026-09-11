import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { QrImage } from '../components/ui';

const FEATURES = [
  ['📷', 'Transfer with QR code', 'Scan a friend, a shop or an agent and pay in seconds.'],
  ['🔳', 'Receive with QR code', 'Your personal QR code accepts payments instantly and securely.'],
  ['💳', 'Add money', 'Top up by card (licensed processor), bank transfer, cash at an agent or mobile money from 250+ operators worldwide – confirmed from the operator receipt, no operator API needed.'],
  ['🔀', 'Any to any', 'Route money from a card, bank or mobile money to a wallet, QR code, bank account, mobile money number or agent – one ledger coordinates both legs, each credited only once the external payment is independently confirmed.'],
  ['🏪', 'Merchant payments', 'Merchants accept QR, card, mobile money and virtual card payments.'],
  ['🏦', 'Withdraw money', 'Send funds to your bank account or cash out at a nearby agent.'],
  ['🌍', 'Remittance', 'Send money abroad to a wallet, a bank account or for cash pickup.'],
  ['💱', 'Multi-currency', 'Hold every world currency and convert with the reference rate, its source and our markup disclosed up front.'],
  ['💳', 'Virtual cards', 'Create secure virtual cards for online purchases.'],
  ['🎁', 'Gift cards', 'Buy digital gift cards for popular brands directly from your wallet.'],
  ['🧾', 'Bill payment', 'Pay utilities, internet and TV subscriptions in a tap.'],
  ['📶', 'Mobile top-up', 'Recharge any phone instantly from your balance.'],
  ['🤝', 'P2P trading', 'Buy and sell currency with other users, protected by escrow.'],
  ['🔗', 'Payment links', 'Generate links and invoices to collect payments from anyone.'],
  ['🎉', 'Referral rewards', 'Earn multi-level rewards for inviting friends.'],
  ['🔐', 'Biometric login', 'Passkeys on web and checkout, Face ID / fingerprint in the apps, step-up approval on every payment, 2FA, KYC and PIN fallback. Biometric data never leaves your device.'],
  ['🔌', 'Payment gateway & API', 'Developer API, webhooks and a WooCommerce plugin.'],
];

export function Landing() {
  const t = useT();
  const { config, user, theme, toggleTheme } = useStore();
  const site = config?.site;
  const [cookie, setCookie] = useState(false);
  useEffect(() => {
    setCookie(!!site?.gdpr?.enabled && !localStorage.getItem('bitripay.cookies'));
    if (site?.seo?.title) document.title = site.seo.title;
  }, [site]);
  return (
    <div>
      <nav className="landing-nav">
        <Link to="/" className="brand" style={{ color: 'inherit', padding: 0 }}>
          <span className="brand-logo">B</span>BitriPay
        </Link>
        <div className="row">
          <button className="btn secondary icon" onClick={toggleTheme}>{theme === 'dark' ? '☀️' : '🌙'}</button>
          <Link to="/contact" className="btn ghost hide-mobile">Contact</Link>
          {user ? (
            <Link to="/app" className="btn">Open app</Link>
          ) : (
            <>
              <Link to="/login" className="btn secondary">{t('auth.signIn')}</Link>
              <Link to="/register" className="btn">{t('landing.getStarted')}</Link>
            </>
          )}
        </div>
      </nav>
      <section className="hero">
        <div>
          <span className="chip primary mb">QR payments · wallets · gateway · remittance</span>
          <h1>{t('landing.hero')}</h1>
          <p className="lead">{site?.description || t('landing.sub')}</p>
          <div className="row wrap mt">
            <Link to="/register" className="btn lg">{t('landing.getStarted')}</Link>
            <Link to="/register?role=merchant" className="btn secondary lg">{t('landing.merchant')}</Link>
            <Link to="/register?role=agent" className="btn ghost lg">Become an agent</Link>
          </div>
          <div className="row wrap mt small muted">
            {site?.appUrls?.playStore && <a href={site.appUrls.playStore}>Google Play</a>}
            {site?.appUrls?.appStore && <a href={site.appUrls.appStore}>App Store</a>}
            <span>{(config?.currencies?.length ?? 0) || 30}+ currencies · {config?.languages?.length ?? 8} languages</span>
          </div>
        </div>
        <div className="phone-mock">
          <div className="card balance-card mb">
            <div className="stat"><span className="label">{t('dash.totalBalance')}</span><span className="value">$2,450.00</span></div>
            <div className="row mt-sm"><span className="chip">USD</span><span className="chip">EUR</span><span className="chip">NGN</span></div>
          </div>
          <div className="center">
            <QrImage value="bitripay://pay?v=1&t=u&id=demo" size={180} />
            <p className="small muted mt-sm">Scan to pay @demo</p>
          </div>
        </div>
      </section>
      <section className="features">
        <h2 className="center">Everything a money transfer business needs</h2>
        <p className="center muted mb">User, merchant, agent and admin – all included.</p>
        <div className="grid auto">
          {FEATURES.map(([ico, title, body]) => (
            <div className="feature" key={title}>
              <div className="ico">{ico}</div>
              <h4>{title}</h4>
              <p className="small muted" style={{ margin: 0 }}>{body}</p>
            </div>
          ))}
        </div>
      </section>
      <footer className="footer">
        <span>© {new Date().getFullYear()} {site?.siteName || 'BitriPay'}. {site?.contactEmail}</span>
        <span className="row wrap">
          {(site?.usefulLinks ?? []).map((l: any) => (
            <a key={l.url} href={l.url}>{l.label}</a>
          ))}
          <Link to="/contact">Contact</Link>
        </span>
      </footer>
      {cookie && (
        <div className="cookie-banner">
          <span className="flex1">{site?.gdpr?.message} <a href={site?.gdpr?.policyUrl}>Learn more</a></span>
          <button className="btn sm" onClick={() => { localStorage.setItem('bitripay.cookies', '1'); setCookie(false); }}>OK</button>
        </div>
      )}
    </div>
  );
}
