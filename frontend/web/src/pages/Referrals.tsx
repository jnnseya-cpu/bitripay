import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { CopyButton, Empty, PageHeader, QrImage, useAsync } from '../components/ui';

export function Referrals() {
  const t = useT();
  const { user, config, money } = useStore();
  const stats = useAsync(() => api.get<any>('/api/account/referrals'), []);
  const link = `${config?.webUrl}/register?ref=${user?.referralCode}`;
  const s = stats.data;
  return (
    <div>
      <PageHeader title={t('nav.referrals')} subtitle="Invite friends and earn rewards for every level of your network" />
      <div className="grid cols-3">
        <div className="card center" style={{ gridColumn: 'span 1' }}>
          <QrImage value={link} size={160} />
          <h3 className="mt mono">{user?.referralCode}</h3>
          <div className="small muted" style={{ wordBreak: 'break-all' }}>{link}</div>
          <div className="row mt" style={{ justifyContent: 'center' }}><CopyButton text={link} label="Copy link" /><CopyButton text={user?.referralCode ?? ''} label="Copy code" /></div>
        </div>
        <div className="card" style={{ gridColumn: 'span 2' }}>
          <div className="grid cols-3">
            <div className="stat"><span className="label">Friends referred</span><span className="value">{s?.referredCount ?? 0}</span></div>
            <div className="stat"><span className="label">Total earned</span><span className="value">{s ? money(s.totalEarned, s.currency) : '—'}</span></div>
            <div className="stat"><span className="label">Rewards trigger</span><span className="value" style={{ fontSize: '1rem' }}>{s?.settings?.trigger === 'first_deposit' ? 'First deposit' : 'Sign-up'}</span></div>
          </div>
          <h4 className="mt">Reward levels</h4>
          <div className="row wrap">{(s?.settings?.rewards ?? []).map((r: number, i: number) => <span key={i} className="chip primary">Level {i + 1}: {money(r, s.currency)}</span>)}</div>
          {!s?.settings?.enabled && <div className="alert warning mt">The referral program is currently paused.</div>}
        </div>
      </div>
      <div className="grid cols-2 mt">
        <div className="card">
          <h4>Your referrals</h4>
          {s?.referred?.length === 0 && <Empty icon="👥" text="No referrals yet" />}
          <div className="list">{s?.referred?.map((r: any) => <div key={r.id} className="list-item"><div className="flex1"><div className="main-text">{r.fullName}</div><div className="sub-text">@{r.tag} · joined {new Date(r.joinedAt).toLocaleDateString()}</div></div></div>)}</div>
        </div>
        <div className="card">
          <h4>Rewards</h4>
          {s?.rewards?.length === 0 && <Empty icon="🎉" text="No rewards yet" />}
          <div className="list">{s?.rewards?.map((r: any) => <div key={r.id} className="list-item"><div className="flex1"><div className="main-text">Level {r.level} reward</div><div className="sub-text">{new Date(r.createdAt).toLocaleString()}</div></div><div className="amount in">+{money(r.amount, r.currency)}</div></div>)}</div>
        </div>
      </div>
    </div>
  );
}
