import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useStore } from '../lib/store';
import { useT, tr } from '../lib/i18n';
import { api } from '../lib/api';
import { PageHeader, TxRow, Empty, useAsync, QrImage } from '../components/ui';
import type { Transaction } from '@bitripay/shared';
import { convertMinor, currencyFlag, type User } from '@bitripay/shared';
import { isMerchantClass } from '@bitripay/shared';
import { areaChart, donutChart, type AnalyticsSeries } from '@bitripay/charts';
import { Chart } from '@bitripay/charts/react';
import { tickMoney } from './Insights';

export function Dashboard() {
  const { user, wallets, config, money, currency } = useStore();
  const t = useT();
  const nav = useNavigate();
  const tx = useAsync(() => api.get<{ items: Transaction[] }>('/api/wallets/transactions?pageSize=8'), []);
  const insights = useAsync(() => api.get<AnalyticsSeries>('/api/account/analytics?days=30'), []);
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
                {w.flag ?? currencyFlag(w.currency)} {money(w.balance, w.currency)}
                {w.role === 'main' ? ` · ${t('wallet.main')}` : w.role === 'alternative' ? ` · ${t('wallet.alternative')}` : ''}
                {w.frozen ? ' · frozen' : ''}
                {(w.promoBalance ?? 0) > 0 ? <span className="tiny muted"> +{money(w.promoBalance ?? 0, w.currency)} promo</span> : null}
              </span>
            ))}
            <Link to="/app/exchange" className="chip" style={{ textDecoration: 'none' }}>
              + {t('nav.exchange')}
            </Link>
          </div>
          <WalletPreferences />
          {wallets[0]?.classification && (
            <div className="tiny mt-sm" style={{ color: 'rgba(255,255,255,0.85)' }}>
              {wallets[0].classification.class === 'sandbox'
                ? tr('🧪 Sandbox balances – no real-world value.')
                : `${wallets[0].classification.label} · issued by ${wallets[0].classification.issuer} · ${wallets[0].classification.backing}.`}
              {wallets.some((w) => (w.promoBalance ?? 0) > 0) ? tr('Promotional credit covers BitriPay fees only and cannot be withdrawn.') : ''}{' '}
              <Link to="/app/statements" style={{ color: '#fff', textDecoration: 'underline' }}>
                {tr('Statements →')}
              </Link>
            </div>
          )}
        </div>
        <div className="card center">
          <QrImage value={`${config?.webUrl ?? ''}/q?v=1&t=${isMerchantClass(user?.role) ? 'm' : user?.role === 'agent' ? 'ag' : 'u'}&id=${user?.tag}`} size={140} />
          <div className="small muted mt-sm">
            {tr('Your receive code ·')} <Link to="/app/receive">enlarge</Link>
          </div>
        </div>
      </div>
      {insights.data && insights.data.totals.count > 0 && (
        <div className="grid cols-3 mt">
          <div className="card" style={{ gridColumn: 'span 2' }}>
            <div className="card-title">
              <h3>{t('nav.insights')}</h3>
              <Link to="/app/insights" className="small">
                {t('dash.viewAll')} →
              </Link>
            </div>
            <Chart
              scene={areaChart(
                insights.data.trend.labels.map((l) => l.slice(5)),
                [
                  { name: t('insights.in'), values: insights.data.trend.in },
                  { name: t('insights.out'), values: insights.data.trend.out },
                ],
                { format: tickMoney(money, base), height: 180 },
              )}
            />
          </div>
          <div className="card">
            <h3>
              {t('insights.in')} / {t('insights.out')}
            </h3>
            <Chart
              scene={donutChart(
                [
                  { label: t('insights.in'), value: insights.data.totals.in },
                  { label: t('insights.out'), value: insights.data.totals.out },
                ],
                { format: (m) => money(m, base), centre: money(insights.data.totals.in - insights.data.totals.out, base), width: 300, height: 170 },
              )}
            />
          </div>
        </div>
      )}
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
          {tr('Unverified accounts have lower limits.')} <Link to="/app/settings?tab=kyc">{tr('Complete identity verification')}</Link> to unlock higher limits and more virtual cards.
        </div>
      )}
    </div>
  );
}

/**
 * Main and alternative wallets: the main one is what every payment, transfer and QR uses unless the person picks
 * another currency on the form; both can be changed here at any time, and a wallet is opened when needed.
 */
function WalletPreferences() {
  const { user, wallets, config, setUser, refreshWallets, toast } = useStore();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const codes = Array.from(new Set([...wallets.map((w) => w.currency), ...(config?.currencies ?? []).map((c) => c.code)]));
  const save = async (patch: { main?: string | null; alternative?: string | null }) => {
    setBusy(true);
    try {
      const r = await api.put<{ user: User }>('/api/wallets/preferences', patch);
      setUser(r.user);
      await refreshWallets();
      toast(t('wallet.prefsSaved'), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row wrap mt-sm" style={{ gap: 8, alignItems: 'center' }}>
      <label className="tiny" style={{ color: 'rgba(255,255,255,0.85)' }}>
        {t('wallet.main')}{' '}
        <select className="input" style={{ width: 'auto', padding: '4px 8px' }} value={user?.mainCurrency ?? ''} disabled={busy} onChange={(e) => save({ main: e.target.value || null })}>
          <option value="">—</option>
          {codes.map((c) => (
            <option key={c} value={c}>
              {currencyFlag(c)} {c}
            </option>
          ))}
        </select>
      </label>
      <label className="tiny" style={{ color: 'rgba(255,255,255,0.85)' }}>
        {t('wallet.alternative')}{' '}
        <select className="input" style={{ width: 'auto', padding: '4px 8px' }} value={user?.alternativeCurrency ?? ''} disabled={busy} onChange={(e) => save({ alternative: e.target.value || null })}>
          <option value="">—</option>
          {codes.map((c) => (
            <option key={c} value={c}>
              {currencyFlag(c)} {c}
            </option>
          ))}
        </select>
      </label>
      <span className="tiny" style={{ color: 'rgba(255,255,255,0.7)' }}>
        {t('wallet.prefsHint')}
      </span>
    </div>
  );
}
