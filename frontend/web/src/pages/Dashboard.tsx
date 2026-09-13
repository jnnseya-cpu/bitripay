import { Link, useNavigate } from 'react-router-dom';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { api } from '../lib/api';
import { PageHeader, TxRow, Empty, useAsync, QrImage } from '../components/ui';
import type { Transaction } from '@bitripay/shared';
import { convertMinor } from '@bitripay/shared';

export function Dashboard() {
  const { user, wallets, config, money, currency } = useStore();
  const t = useT();
  const nav = useNavigate();
  const tx = useAsync(() => api.get<{ items: Transaction[] }>('/api/wallets/transactions?pageSize=8'), []);
  const base = config?.baseCurrency ?? 'USD';
  const total = wallets.reduce((sum, w) => sum + (config ? convertMinor(w.balance, currency(w.currency), currency(base)) : 0), 0);
  const m = config?.modules ?? {};
  const actions = [
    ['/app/scan', '📷', t('nav.scan'), 'qrPayments'],
    ['/app/send', '📤', t('nav.send'), 'transfers'],
    ['/app/move', '🔀', t('nav.move'), 'transfers'],
    ['/app/receive', '🔳', t('nav.receive'), 'qrPayments'],
    ['/app/add-money', '➕', t('nav.addMoney'), 'addMoney'],
    ['/app/requests', '🔗', t('nav.requests'), 'moneyRequests'],
    ['/app/withdraw', '🏦', t('nav.withdraw'), 'withdrawals'],
    ['/app/remittance', '🌍', t('nav.remittance'), 'remittance'],
    ['/app/bills', '🧾', t('nav.bills'), 'billPay'],
    ['/app/topup', '📶', t('nav.topup'), 'mobileTopup'],
    ['/app/cards', '💳', t('nav.cards'), 'virtualCards'],
    ['/app/gift-cards', '🎁', t('nav.giftCards'), 'giftCards'],
    ['/app/p2p', '🤝', t('nav.p2p'), 'p2p'],
  ].filter(([, , , mod]) => m[mod as string] !== false);

  return (
    <div>
      <PageHeader title={t('dash.welcome', { name: user?.fullName.split(' ')[0] ?? '' })} subtitle={`@${user?.tag}`} />
      <div className="grid cols-3">
        <div className="card balance-card" style={{ gridColumn: 'span 2' }}>
          <div className="stat">
            <span className="label">
              {t('dash.totalBalance')} ({base})
            </span>
            <span className="value">{money(total, base)}</span>
          </div>
          <div className="row wrap mt-sm">
            {wallets.map((w) => (
              <span key={w.id} className={`chip ${w.frozen ? 'danger' : ''}`} title={w.classification?.label}>
                {money(w.balance, w.currency)}
                {w.frozen ? ' · frozen' : ''}
                {(w.promoBalance ?? 0) > 0 ? <span className="tiny muted"> +{money(w.promoBalance ?? 0, w.currency)} promo</span> : null}
              </span>
            ))}
            <Link to="/app/exchange" className="chip" style={{ textDecoration: 'none' }}>
              + {t('nav.exchange')}
            </Link>
          </div>
          {wallets[0]?.classification && (
            <div className="tiny mt-sm" style={{ color: 'rgba(255,255,255,0.85)' }}>
              {wallets[0].classification.class === 'sandbox'
                ? '🧪 Sandbox balances – no real-world value.'
                : `${wallets[0].classification.label} · issued by ${wallets[0].classification.issuer} · ${wallets[0].classification.backing}.`}
              {wallets.some((w) => (w.promoBalance ?? 0) > 0) ? ' Promotional credit covers BitriPay fees only and cannot be withdrawn.' : ''}{' '}
              <Link to="/app/statements" style={{ color: '#fff', textDecoration: 'underline' }}>
                Statements →
              </Link>
            </div>
          )}
        </div>
        <div className="card center">
          <QrImage value={`${config?.webUrl ?? ''}/q?v=1&t=${user?.role === 'merchant' ? 'm' : user?.role === 'agent' ? 'ag' : 'u'}&id=${user?.tag}`} size={140} />
          <div className="small muted mt-sm">
            Your receive code · <Link to="/app/receive">enlarge</Link>
          </div>
        </div>
      </div>
      <h3 className="mt">{t('dash.quickActions')}</h3>
      <div className="actions-grid">
        {actions.map(([to, ico, label]) => (
          <Link key={to as string} to={to as string} className="action-tile">
            <span className="ico">{ico}</span>
            {label}
          </Link>
        ))}
      </div>
      <div className="card mt">
        <div className="card-title">
          <h3>{t('dash.recent')}</h3>
          <Link to="/app/transactions" className="small">
            {t('dash.viewAll')} →
          </Link>
        </div>
        <div className="list">
          {tx.data?.items.length === 0 && <Empty icon="💸" />}
          {tx.data?.items.map((item) => (
            <TxRow key={item.id} tx={item} onClick={() => nav(`/app/transactions/${item.id}`)} />
          ))}
        </div>
      </div>
      {user?.kycStatus !== 'verified' && m.kyc !== false && (
        <div className="alert warning mt">
          Unverified accounts have lower limits. <Link to="/app/settings?tab=kyc">Complete identity verification</Link> to unlock higher limits and more virtual cards.
        </div>
      )}
    </div>
  );
}
