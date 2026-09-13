/**
 * SMS command channel: short keyword commands from any phone ("BAL 1234", "SEND 20 @amina 1234"). The inbound
 * webhook accepts the field names of the common aggregators, replies synchronously in the format the aggregator
 * expects and, when an SMS provider is configured, also sends the reply as a message. Same services, limits and PIN
 * checks as the app and USSD.
 */
import { getDb } from '../../db';
import { config } from '../../config';
import { uuid, now } from '../../lib/ids';
import { createUser, findUserByIdentifier, findUserByPhone, normalizePhone, type UserRow } from '../users';
import { listWallets } from '../wallets';
import { listTransactions, calculateFee } from '../ledger';
import { sendMoney } from '../transfers';
import { createCashOutRequest } from '../agents';
import { assertPin, setPin } from '../auth';
import { convert, formatMinor, getCurrency, listCurrencies } from '../currencies';
import { getChannelSettings, getAppSettings, getSiteSettingsSafe } from '../settings';
import { sendSms } from '../messaging';

const money = formatMinor;
function defaultCurrency(user: UserRow): string {
  const w = listWallets(user.id);
  if (w.length) return w.sort((a, b) => b.balance - a.balance)[0].currency;
  return listCurrencies(true).some((c) => c.code === config.baseCurrency) ? config.baseCurrency : (listCurrencies(true)[0]?.code ?? 'USD');
}
function pinOk(user: UserRow, pin: string): boolean {
  try {
    assertPin(user, pin);
    return true;
  } catch {
    return false;
  }
}
const HELP = 'BitriPay SMS: BAL <PIN> · SEND <amount> [CUR] <@code|phone> <PIN> · PAY <amount> [CUR] <@merchant> <PIN> · CASH <amount> [CUR] <@agent> <PIN> · STMT <PIN> · CODE · REG <name> <PIN>';

/** Pure command logic: phone + message → reply text. */
export function smsHandle(phoneRaw: string, body: string): string {
  const s = getChannelSettings().sms;
  if (!s.enabled) return 'This service is not available right now.';
  const phone = normalizePhone(phoneRaw) ?? phoneRaw;
  const parts = body.trim().split(/\s+/).filter(Boolean);
  const cmd = (parts[0] ?? '').toUpperCase();
  const user = findUserByPhone(phone);
  const site = getSiteSettingsSafe();
  if (cmd === 'HELP' || cmd === '?' || !cmd) return `${HELP}. Help: ${site?.contactEmail ?? getAppSettings().supportEmail ?? ''}`.trim();
  if (cmd === 'REG') {
    if (user) return `You are already registered as @${user.tag}.`;
    if (!s.allowRegistration) return 'Registration by SMS is closed. Please use the app.';
    const pin = parts[parts.length - 1];
    const name = parts.slice(1, -1).join(' ');
    if (!/^\d{4,6}$/.test(pin ?? '') || name.length < 2) return 'To register: REG <your full name> <4-digit PIN>';
    const created = createUser({ fullName: name.slice(0, 80), phone, phoneVerified: true, country: null });
    setPin(created, pin);
    return `Welcome ${created.full_name}. Your BitriPay code is @${created.tag}. Send HELP for commands.`;
  }
  if (!user) return `This number is not registered. Reply REG <your name> <PIN> to open a BitriPay wallet, or dial ${getChannelSettings().ussd.serviceCode}.`;
  if (cmd === 'CODE') return `Your BitriPay code is @${user.tag}. Others can send to it or to your phone number.`;
  if (cmd === 'BAL') {
    if (!pinOk(user, parts[1] ?? '')) return 'Wrong PIN. Format: BAL <PIN>';
    const ws = listWallets(user.id);
    return ws.length ? `Balance: ${ws.map((w) => money(w.balance, w.currency)).join(', ')}` : 'No wallet yet. Cash in at an agent to start.';
  }
  if (cmd === 'STMT') {
    if (!pinOk(user, parts[1] ?? '')) return 'Wrong PIN. Format: STMT <PIN>';
    const items = listTransactions({ userId: user.id, page: 1, pageSize: 5 }).items;
    return items.length
      ? `Last: ${items.map((x) => `${x.createdAt.slice(5, 10)} ${x.direction === 'in' ? '+' : '-'}${money(x.amount, x.currency)} ${x.counterparty ? '@' + x.counterparty.tag : x.type.replace(/_/g, ' ')}`).join('; ')}`
      : 'No transactions yet.';
  }
  if (cmd === 'SEND' || cmd === 'PAY' || cmd === 'CASH') {
    // SEND <amount> [CUR] <recipient> <PIN>
    const pin = parts[parts.length - 1] ?? '';
    const amountText = parts[1] ?? '';
    let currency = defaultCurrency(user);
    let target = parts[2] ?? '';
    if (parts.length >= 5 && /^[A-Za-z]{3}$/.test(parts[2])) {
      currency = parts[2].toUpperCase();
      target = parts[3];
    }
    const n = Number(amountText.replace(',', '.'));
    let decimals = 2;
    try {
      decimals = getCurrency(currency).decimals;
    } catch {
      return `Unknown currency ${currency}.`;
    }
    if (!Number.isFinite(n) || n <= 0 || !target) return `Format: ${cmd} <amount> [CUR] <@code or phone> <PIN>`;
    const minor = Math.round(n * 10 ** decimals);
    let cap: number;
    try {
      cap = convert(s.maxPerTransaction, s.maxPerTransactionCurrency, currency);
    } catch {
      cap = s.maxPerTransaction;
    }
    if (minor > cap) return `Amount above the SMS limit of ${money(cap, currency)}. Use the app or an agent.`;
    if (!pinOk(user, pin)) return 'Wrong PIN.';
    const other = findUserByIdentifier(target);
    if (!other || other.is_system || other.id === user.id) return `${target} was not found.`;
    try {
      if (cmd === 'CASH') {
        if (other.role !== 'agent') return `${target} is not a BitriPay agent.`;
        const r = createCashOutRequest(user, { agent: `@${other.tag}`, amount: minor, currency });
        return `Cash-out code ${r.code} for ${money(minor, currency)} (fee ${money(r.fee, currency)}). Show it to agent @${other.tag} within 30 minutes.`;
      }
      const fee = calculateFee(cmd === 'PAY' ? 'merchant_payment' : 'transfer', minor, currency);
      const tx = sendMoney(user, {
        to: `@${other.tag}`,
        amount: minor,
        currency,
        note: `SMS ${cmd.toLowerCase()}`,
        type: cmd === 'PAY' ? 'merchant_payment' : 'transfer',
        idempotencyKey: `sms:${phone}:${body.trim()}:${now().slice(0, 16)}`,
      });
      return `Sent ${money(minor, currency)} to @${other.tag} (fee ${money(fee, currency)}). Ref ${tx.id.slice(0, 8).toUpperCase()}. New balance: ${money(listWallets(user.id).find((w) => w.currency === currency)?.balance ?? 0, currency)}`;
    } catch (err: any) {
      return String(err?.message ?? 'Failed').slice(0, 150);
    }
  }
  return `Unknown command. ${HELP}`;
}

/** Log the exchange, send the reply through the SMS provider when one is configured, and return the text for the webhook. */
export async function smsInbound(phoneRaw: string, body: string): Promise<string> {
  const db = getDb();
  const phone = normalizePhone(phoneRaw) ?? phoneRaw;
  const user = findUserByPhone(phone);
  const reply = smsHandle(phone, body);
  db.prepare('INSERT INTO channel_messages (id, channel, direction, phone, body, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    uuid(),
    'sms',
    'in',
    phone,
    body.slice(0, 500),
    user?.id ?? null,
    now(),
  );
  db.prepare('INSERT INTO channel_messages (id, channel, direction, phone, body, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    uuid(),
    'sms',
    'out',
    phone,
    reply.slice(0, 500),
    user?.id ?? null,
    now(),
  );
  void sendSms(phone, reply).catch(() => {});
  return reply;
}
export function recentSms(limit = 40) {
  return (getDb().prepare("SELECT * FROM channel_messages WHERE channel = 'sms' ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map((r) => ({
    id: r.id,
    direction: r.direction,
    phone: r.phone,
    body: r.body,
    userId: r.user_id,
    createdAt: r.created_at,
  }));
}
