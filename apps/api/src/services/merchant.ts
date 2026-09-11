import { getDb } from '../db';
import { uuid, now, secretToken, shortCode } from '../lib/ids';
import { sha256 } from '../lib/crypto';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import type { ApiKey } from '@bitripay/shared';
import { updateUser, getGatewaySettings, DEFAULT_GATEWAY_SETTINGS, type MerchantGatewaySettings, type UserRow, findUserById } from './users';
import { requestWithdrawal } from './withdrawals';
import { getAppSettings } from './settings';
import { listWallets } from './wallets';
import { getModules } from './modules';

export function toApiKey(r: any): ApiKey {
  return { id: r.id, label: r.label, prefix: r.prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at };
}

export function listApiKeys(userId: string): ApiKey[] {
  return getDb().prepare('SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC').all(userId).map(toApiKey);
}

export function createApiKey(user: UserRow, label: string, mode: 'live' | 'test' = 'live'): ApiKey & { secret: string } {
  if (!getModules().merchantGateway) throw unprocessable('The merchant gateway is currently disabled', 'module_disabled');
  const count = (getDb().prepare('SELECT COUNT(*) c FROM api_keys WHERE user_id = ? AND revoked_at IS NULL').get(user.id) as any).c;
  if (count >= 10) throw conflict('You can have at most 10 active API keys');
  const secret = `bp_${mode}_${secretToken(24)}`;
  const id = uuid();
  const prefix = secret.slice(0, 12) + '…' + secret.slice(-4);
  getDb().prepare('INSERT INTO api_keys (id, user_id, label, prefix, key_hash, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, user.id, label.trim() || 'API key', prefix, sha256(secret), mode, now());
  return { ...toApiKey(getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(id)), secret };
}

export function revokeApiKey(userId: string, id: string) {
  const res = getDb().prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(now(), id, userId);
  if (res.changes === 0) throw notFound('API key not found');
}

export function updateGatewaySettings(user: UserRow, patch: Partial<MerchantGatewaySettings>): MerchantGatewaySettings {
  const current = getGatewaySettings(user);
  const next: MerchantGatewaySettings = { ...current, ...patch };
  const allowed = Object.keys(DEFAULT_GATEWAY_SETTINGS);
  for (const k of Object.keys(next)) if (!allowed.includes(k)) delete (next as any)[k];
  if (!next.methods?.length) throw badRequest('Enable at least one payment method');
  updateUser(user.id, { gateway_settings: JSON.stringify(next) });
  return next;
}

export function setWebhook(user: UserRow, url: string | null): { webhookUrl: string | null; webhookSecret: string | null } {
  if (url && !/^https?:\/\//.test(url)) throw badRequest('Webhook URL must start with http:// or https://');
  const secret = url ? user.webhook_secret || `whsec_${secretToken(24)}` : null;
  updateUser(user.id, { webhook_url: url, webhook_secret: secret });
  return { webhookUrl: url, webhookSecret: secret };
}

export function rotateWebhookSecret(user: UserRow) {
  const secret = `whsec_${secretToken(24)}`;
  updateUser(user.id, { webhook_secret: secret });
  return { webhookSecret: secret };
}

export function listWebhookDeliveries(userId: string, limit = 50) {
  return (getDb().prepare('SELECT * FROM webhook_deliveries WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as any[]).map((r) => ({
    id: r.id,
    event: r.event,
    url: r.url,
    statusCode: r.status_code,
    success: !!r.success,
    attempts: r.attempts,
    lastError: r.last_error,
    payload: JSON.parse(r.payload),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function merchantStats(user: UserRow) {
  const db = getDb();
  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  const rows = db
    .prepare("SELECT currency, COUNT(*) c, COALESCE(SUM(amount),0) volume, COALESCE(SUM(fee),0) fees, SUM(CASE WHEN created_at >= ? THEN amount ELSE 0 END) today FROM transactions WHERE receiver_user_id = ? AND type IN ('merchant_payment','qr_payment') AND status = 'completed' AND created_at >= ? GROUP BY currency")
    .all(dayAgo, user.id, monthAgo) as any[];
  const methods = db
    .prepare("SELECT json_extract(metadata, '$.method') method, COUNT(*) c FROM transactions WHERE receiver_user_id = ? AND type IN ('merchant_payment','qr_payment') AND status = 'completed' AND created_at >= ? GROUP BY method")
    .all(user.id, monthAgo) as any[];
  const daily = db
    .prepare("SELECT substr(created_at, 1, 10) day, currency, COALESCE(SUM(amount),0) volume, COUNT(*) c FROM transactions WHERE receiver_user_id = ? AND type IN ('merchant_payment','qr_payment') AND status = 'completed' AND created_at >= ? GROUP BY day, currency ORDER BY day")
    .all(user.id, monthAgo) as any[];
  const openLinks = (db.prepare("SELECT COUNT(*) c FROM payment_requests WHERE requester_user_id = ? AND status = 'open'").get(user.id) as any).c;
  return { byCurrency: rows, byMethod: methods.map((m) => ({ method: m.method || 'wallet', count: m.c })), daily, openPaymentRequests: openLinks, wallets: listWallets(user.id) };
}

/** Automated settlement: sweep merchant balances above the threshold to their default bank account. */
export function runAutoSettlements(): { settled: number; skipped: number } {
  const app = getAppSettings();
  if (!app.autoSettlement.enabled) return { settled: 0, skipped: 0 };
  const db = getDb();
  const merchants = db.prepare("SELECT * FROM users WHERE role = 'merchant' AND status = 'active'").all() as UserRow[];
  let settled = 0;
  let skipped = 0;
  for (const m of merchants) {
    const settings = getGatewaySettings(m);
    if (!settings.autoSettle) continue;
    const bank = db.prepare('SELECT * FROM bank_accounts WHERE user_id = ? ORDER BY is_default DESC LIMIT 1').get(m.id) as any;
    if (!bank) {
      skipped += 1;
      continue;
    }
    const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ? AND currency = ?').get(m.id, bank.currency) as any;
    if (!wallet || wallet.balance < app.autoSettlement.minAmount) {
      skipped += 1;
      continue;
    }
    try {
      const tx = requestWithdrawal(m, { amount: wallet.balance, currency: bank.currency, bankAccountId: bank.id, note: 'Automated settlement' });
      db.prepare("INSERT INTO settlements (id, user_id, bank_account_id, amount, currency, status, transaction_id, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)").run(uuid(), m.id, bank.id, wallet.balance, bank.currency, tx.id, now());
      settled += 1;
    } catch {
      skipped += 1;
    }
  }
  return { settled, skipped };
}

export function listSettlements(userId?: string) {
  const rows = userId
    ? getDb().prepare('SELECT s.*, t.status tx_status, t.reference FROM settlements s LEFT JOIN transactions t ON t.id = s.transaction_id WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 100').all(userId)
    : getDb().prepare('SELECT s.*, t.status tx_status, t.reference FROM settlements s LEFT JOIN transactions t ON t.id = s.transaction_id ORDER BY s.created_at DESC LIMIT 200').all();
  return (rows as any[]).map((r) => ({ id: r.id, userId: r.user_id, amount: r.amount, currency: r.currency, status: r.tx_status || r.status, reference: r.reference, transactionId: r.transaction_id, createdAt: r.created_at, merchant: findUserById(r.user_id)?.business_name ?? null }));
}

export function upgradeToMerchant(user: UserRow, businessName: string) {
  if (user.role === 'admin') throw badRequest('Admins cannot become merchants');
  if (!businessName.trim()) throw badRequest('Business name is required');
  return updateUser(user.id, { role: 'merchant', business_name: businessName.trim(), gateway_settings: JSON.stringify(DEFAULT_GATEWAY_SETTINGS) });
}

export const shortRef = () => shortCode(8);
