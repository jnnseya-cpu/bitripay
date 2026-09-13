import { getDb } from '../db';
import { grantPromoCredit } from './emoney';
import { uuid, now } from '../lib/ids';
import { getReferralSettings } from './settings';
import { getBaseCurrency } from './currencies';
import { notify } from './notifications';
import { findUserById, type UserRow } from './users';
import { formatMoney } from '@bitripay/shared';

/** Walk up the referral chain and pay each level its configured reward from the treasury. */
function payRewards(referee: UserRow, trigger: 'registration' | 'first_deposit') {
  const settings = getReferralSettings();
  if (!settings.enabled || settings.trigger !== trigger) return;
  const db = getDb();
  const already = db.prepare('SELECT 1 FROM referral_rewards WHERE referee_id = ? LIMIT 1').get(referee.id);
  if (already) return;
  const base = getBaseCurrency();
  let current = referee.referred_by ? findUserById(referee.referred_by) : undefined;
  let level = 1;
  while (current && level <= settings.rewards.length) {
    const amount = settings.rewards[level - 1];
    if (amount > 0) {
      // Referral rewards are promotional credit: a marketing liability that can cover fees, never redeemable money.
      const tx = { id: grantPromoCredit(current.id, base.code, amount, 'referral_rewards', `Level ${level} referral reward for @${referee.tag}`, { referenceId: referee.id }).id };
      db.prepare('INSERT INTO referral_rewards (id, referrer_id, referee_id, level, amount, currency, transaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        uuid(),
        current.id,
        referee.id,
        level,
        amount,
        base.code,
        tx.id,
        now(),
      );
      notify(
        current.id,
        'Referral reward earned',
        `You earned ${formatMoney(amount, base)} of promotional credit for a level ${level} referral (@${referee.tag}). It covers your BitriPay fees and cannot be withdrawn.`,
        { kind: 'referral', transactionId: tx.id },
      );
    }
    current = current.referred_by ? findUserById(current.referred_by) : undefined;
    level += 1;
  }
}

export function onUserRegistered(user: UserRow) {
  if (user.referred_by) payRewards(user, 'registration');
}

export function onDepositCompleted(userId: string) {
  const user = findUserById(userId);
  if (!user?.referred_by) return;
  const count = (
    getDb()
      .prepare("SELECT COUNT(*) c FROM transactions WHERE receiver_user_id = ? AND status = 'completed' AND type IN ('card_deposit','bank_deposit','mobile_money_deposit','agent_cash_in')")
      .get(userId) as any
  ).c;
  if (count === 1) payRewards(user, 'first_deposit');
}

export function referralStats(userId: string) {
  const db = getDb();
  const referred = db.prepare('SELECT id, tag, full_name, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC').all(userId) as any[];
  const rewards = db.prepare('SELECT * FROM referral_rewards WHERE referrer_id = ? ORDER BY created_at DESC').all(userId) as any[];
  const totalEarned = rewards.reduce((s, r) => s + r.amount, 0);
  return {
    referredCount: referred.length,
    totalEarned,
    currency: getBaseCurrency().code,
    referred: referred.map((r) => ({ id: r.id, tag: r.tag, fullName: r.full_name, joinedAt: r.created_at })),
    rewards: rewards.map((r) => ({ id: r.id, level: r.level, amount: r.amount, currency: r.currency, refereeId: r.referee_id, createdAt: r.created_at })),
    settings: getReferralSettings(),
  };
}
