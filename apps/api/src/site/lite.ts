/**
 * BitriPay Lite: server-rendered pages with no JavaScript, no fonts and no images, for very slow connections and
 * basic phone browsers. Every page is a few kilobytes and works with forms alone. Sign in with phone + PIN (as set
 * by USSD or the app) or email + password; money actions ask for the PIN again. Same services and limits as the app.
 */
import { Router } from 'express';
import { rateLimit } from '../middleware/rateLimit';
import { randomBytes } from 'node:crypto';
import { getDb } from '../db';
import { now } from '../lib/ids';
import { verifyPassword } from '../lib/password';
import { findUserById, findUserByEmail, findUserByPhone, findUserByIdentifier, normalizeEmail, normalizePhone, createUser, type UserRow } from '../services/users';
import { listWallets } from '../services/wallets';
import { listTransactions, calculateFee } from '../services/ledger';
import { sendMoney } from '../services/transfers';
import { createCashOutRequest, listCashRequests } from '../services/agents';
import { buildStatement, statementCsv, statementPdf } from '../services/statements';
import { assertPin, setPin } from '../services/auth';
import { getCurrency } from '../services/currencies';
import { getChannelSettings, getAppSettings } from '../services/settings';
import { formatMoney } from '@bitripay/shared';
import { escapeHtml as e } from '../services/markdown';
import { config } from '../config';

export const liteRouter = Router();
const limit = rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'lite' });
const COOKIE = 'bp_lite';

const CSS = `body{font:16px/1.4 system-ui,Arial,sans-serif;margin:0;background:#f4f6fb;color:#111}main{max-width:480px;margin:0 auto;padding:12px}h1{font-size:20px;margin:8px 0}h2{font-size:17px;margin:14px 0 6px}a{color:#1d4ed8}.card{background:#fff;border:1px solid #dfe3ea;border-radius:8px;padding:12px;margin:10px 0}label{display:block;font-size:14px;margin:8px 0 3px}input,select{width:100%;box-sizing:border-box;padding:9px;font-size:16px;border:1px solid #c8cdd6;border-radius:6px}button{width:100%;padding:11px;font-size:16px;background:#1d4ed8;color:#fff;border:0;border-radius:6px;margin-top:10px}.b{font-weight:700}.m{color:#5b6472;font-size:13px}.err{background:#fde8e8;color:#9b1c1c;padding:8px;border-radius:6px}.ok{background:#e6f7ee;color:#0b6e4f;padding:8px;border-radius:6px}nav a{margin-right:10px;font-size:14px}table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 2px;border-bottom:1px solid #eee;vertical-align:top}.r{text-align:right;white-space:nowrap}`;

function page(title: string, body: string, user?: UserRow | null) {
  const app = getAppSettings().appName || 'BitriPay';
  const nav = user ? `<nav><a href="/lite/home">Home</a><a href="/lite/send">Send</a><a href="/lite/receive">Receive</a><a href="/lite/cash">Cash out</a><a href="/lite/history">History</a><a href="/lite/statement">Statement</a><a href="/lite/logout">Sign out</a></nav>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)} · ${e(app)} Lite</title><style>${CSS}</style></head><body><main><h1>${e(app)} <span class="m">Lite</span></h1>${nav}${body}<p class="m">Lite works on any browser and slow connections. Full app: <a href="${config.webUrl}">${config.webUrl.replace(/^https?:\/\//, '')}</a> · USSD ${e(getChannelSettings().ussd.serviceCode)}</p></main></body></html>`;
}
function cookieOf(req: any): string | null {
  const raw = String(req.headers.cookie ?? '');
  const m = raw.split(';').map((x) => x.trim()).find((x) => x.startsWith(`${COOKIE}=`));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : null;
}
function currentUser(req: any): UserRow | null {
  const id = cookieOf(req);
  if (!id) return null;
  const row = getDb().prepare('SELECT * FROM lite_sessions WHERE id = ? AND expires_at > ?').get(id, now()) as any;
  if (!row) return null;
  getDb().prepare('UPDATE lite_sessions SET last_seen_at = ? WHERE id = ?').run(now(), id);
  const u = findUserById(row.user_id);
  return u && u.status === 'active' ? u : null;
}
/** Opaque, revocable session id in an HttpOnly cookie; sign-out deletes the row so old cookies are dead. */
function setSession(req: any, res: any, user: UserRow | null) {
  const existing = cookieOf(req);
  if (existing) getDb().prepare('DELETE FROM lite_sessions WHERE id = ?').run(existing);
  let value = '';
  if (user) {
    value = randomBytes(24).toString('base64url');
    getDb().prepare('INSERT INTO lite_sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)').run(value, user.id, now(), new Date(Date.now() + 12 * 3600_000).toISOString(), now(), String(req.headers['user-agent'] ?? '').slice(0, 200));
    getDb().prepare('DELETE FROM lite_sessions WHERE expires_at < ?').run(now());
  }
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/lite; HttpOnly; SameSite=Lax${config.isProduction ? '; Secure' : ''}${user ? '; Max-Age=43200' : '; Max-Age=0'}`);
}
const money = (minor: number, code: string) => {
  try {
    return formatMoney(minor, getCurrency(code, false));
  } catch {
    return `${minor} ${code}`;
  }
};
function guard(req: any, res: any): UserRow | null {
  if (!getChannelSettings().lite.enabled) {
    res.status(503).send(page('Unavailable', '<div class="card">Lite is switched off. Please use the app.</div>'));
    return null;
  }
  const u = currentUser(req);
  if (!u) res.redirect('/lite?next=' + encodeURIComponent(req.originalUrl));
  return u;
}
const flash = (q: any) => (q.ok ? `<div class="ok">${e(String(q.ok))}</div>` : q.err ? `<div class="err">${e(String(q.err))}</div>` : '');

liteRouter.get('/', limit, (req, res) => {
  if (!getChannelSettings().lite.enabled) return res.status(503).send(page('Unavailable', '<div class="card">Lite is switched off. Please use the app.</div>'));
  if (currentUser(req)) return res.redirect('/lite/home');
  res.send(page('Sign in', `${flash(req.query)}<div class="card"><form method="post" action="/lite/login"><label>Phone number or email</label><input name="identifier" autocomplete="username" required><label>PIN (phone) or password (email)</label><input name="secret" type="password" autocomplete="current-password" required><input type="hidden" name="next" value="${e(String(req.query.next ?? ''))}"><button>Sign in</button></form></div><div class="card">New to BitriPay? <a href="/lite/register">Open a wallet</a> with your phone number, or dial ${e(getChannelSettings().ussd.serviceCode)}.</div>`));
});
liteRouter.post('/login', limit, (req, res) => {
  const id = String(req.body?.identifier ?? '').trim();
  const secret = String(req.body?.secret ?? '');
  let user: UserRow | undefined;
  if (id.includes('@')) {
    user = findUserByEmail(normalizeEmail(id)!);
    if (!user || !user.password_hash || !verifyPassword(secret, user.password_hash)) user = undefined;
  } else {
    user = findUserByPhone(normalizePhone(id) ?? id);
    if (user) {
      const ok = (user.pin_hash && verifyPassword(secret, user.pin_hash)) || (user.password_hash && verifyPassword(secret, user.password_hash));
      if (!ok) user = undefined;
    }
  }
  if (!user || user.status !== 'active') return res.redirect('/lite?err=' + encodeURIComponent('Wrong number, email, PIN or password.'));
  setSession(req, res, user);
  const next = String(req.body?.next ?? '');
  res.redirect(next.startsWith('/lite') ? next : '/lite/home');
});
liteRouter.get('/logout', (req, res) => {
  setSession(req, res, null);
  res.redirect('/lite');
});
liteRouter.get('/register', limit, (req, res) => {
  if (!getChannelSettings().ussd.allowRegistration) return res.redirect('/lite?err=' + encodeURIComponent('Registration is only available in the app.'));
  res.send(page('Open a wallet', `${flash(req.query)}<div class="card"><form method="post" action="/lite/register"><label>Full name</label><input name="fullName" required minlength="2"><label>Phone number (with country code)</label><input name="phone" type="tel" required><label>Choose a 4-digit PIN</label><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,6}" required><button>Open my wallet</button></form></div>`));
});
liteRouter.post('/register', limit, (req, res) => {
  if (!getChannelSettings().ussd.allowRegistration) return res.redirect('/lite');
  const phone = normalizePhone(String(req.body?.phone ?? ''));
  const name = String(req.body?.fullName ?? '').trim();
  const pin = String(req.body?.pin ?? '');
  if (!phone || name.length < 2 || !/^\d{4,6}$/.test(pin)) return res.redirect('/lite/register?err=' + encodeURIComponent('Check your name, phone number and PIN.'));
  if (findUserByPhone(phone)) return res.redirect('/lite?err=' + encodeURIComponent('This number already has a wallet. Sign in with your PIN.'));
  try {
    const u = createUser({ fullName: name.slice(0, 80), phone, phoneVerified: false, country: null });
    setPin(u, pin);
    setSession(req, res, u);
    res.redirect('/lite/home?ok=' + encodeURIComponent(`Welcome ${u.full_name}. Your BitriPay code is @${u.tag}.`));
  } catch (err: any) {
    res.redirect('/lite/register?err=' + encodeURIComponent(err?.message ?? 'Could not register'));
  }
});

liteRouter.get('/home', (req, res) => {
  const u = guard(req, res);
  if (!u) return;
  const ws = listWallets(u.id);
  const tx = listTransactions({ userId: u.id, page: 1, pageSize: 5 }).items;
  res.send(page('Home', `${flash(req.query)}<div class="card"><div class="b">${e(u.full_name)} · @${e(u.tag)}</div>${ws.length ? ws.map((w) => `<div><span class="b">${money(w.balance, w.currency)}</span>${w.frozen_at ? ' <span class="m">(frozen)</span>' : ''}</div>`).join('') : '<div class="m">No wallet yet. Cash in at an agent or ask someone to send to @' + e(u.tag) + '.</div>'}</div><h2>Recent</h2><div class="card">${tx.length ? `<table>${tx.map((t) => `<tr><td>${t.createdAt.slice(0, 10)}<br><span class="m">${e(t.counterparty ? '@' + t.counterparty.tag : t.type.replace(/_/g, ' '))}</span></td><td class="r ${t.direction === 'in' ? 'b' : ''}">${t.direction === 'in' ? '+' : '−'}${money(t.amount, t.currency)}</td></tr>`).join('')}</table>` : '<span class="m">Nothing yet.</span>'}</div>`, u));
});
liteRouter.get('/send', (req, res) => {
  const u = guard(req, res);
  if (!u) return;
  const ws = listWallets(u.id);
  res.send(page('Send money', `${flash(req.query)}<div class="card"><form method="post" action="/lite/send"><label>To (@code or phone number)</label><input name="to" required value="${e(String(req.query.to ?? ''))}"><label>Amount</label><input name="amount" inputmode="decimal" required value="${e(String(req.query.amount ?? ''))}"><label>Currency</label><select name="currency">${ws.map((w) => `<option value="${w.currency}">${w.currency} (${money(w.balance, w.currency)})</option>`).join('') || '<option value="USD">USD</option>'}</select><label>Note (optional)</label><input name="note" maxlength="80"><label>Your PIN</label><input name="pin" type="password" inputmode="numeric" required><button>Send now</button></form><p class="m">Fees are shown on your receipt and statement. Transfers are instant and final.</p></div>`, u));
});
liteRouter.post('/send', limit, (req, res) => {
  const u = guard(req, res);
  if (!u) return;
  try {
    const cur = getCurrency(String(req.body?.currency ?? 'USD').toUpperCase());
    const minor = Math.round(Number(String(req.body?.amount ?? '0').replace(',', '.')) * 10 ** cur.decimals);
    if (!Number.isFinite(minor) || minor <= 0) throw new Error('Enter a valid amount');
    assertPin(u, String(req.body?.pin ?? ''));
    const to = String(req.body?.to ?? '').trim();
    const recipient = findUserByIdentifier(to);
    if (!recipient) throw new Error(`${to} was not found`);
    const fee = calculateFee('transfer', minor, cur.code);
    const tx = sendMoney(u, { to: `@${recipient.tag}`, amount: minor, currency: cur.code, note: String(req.body?.note ?? '') || null, idempotencyKey: `lite:${u.id}:${to}:${minor}:${Date.now().toString().slice(0, -4)}` });
    res.redirect('/lite/home?ok=' + encodeURIComponent(`Sent ${money(minor, cur.code)} to @${recipient.tag} (fee ${money(fee, cur.code)}). Ref ${tx.id.slice(0, 8).toUpperCase()}.`));
  } catch (err: any) {
    res.redirect('/lite/send?err=' + encodeURIComponent(err?.message ?? 'Could not send'));
  }
});
liteRouter.get('/receive', (req, res) => {
  const u = guard(req, res);
  if (!u) return;
  res.send(page('Receive', `<div class="card"><div>Your BitriPay code</div><div class="b" style="font-size:26px">@${e(u.tag)}</div><p class="m">Anyone can send to this code or to your phone number${u.phone ? ` (${e(u.phone)})` : ''}. Agents cash in to it. In the full app you also get a QR code.</p></div>`, u));
});
liteRouter.get('/cash', (req, res) => {
  const u = guard(req, res);
  if (!u) return;
  const ws = listWallets(u.id);
  const open = listCashRequests(u).filter((r) => r.status === 'pending').slice(0, 3);
  res.send(page('Cash out', `${flash(req.query)}${open.length ? `<div class="card"><div class="b">Open cash-out codes</div>${open.map((r) => `<div>${e(r.code)} · ${money(r.amount, r.currency)} · agent @${e(r.agent?.tag ?? '')} · until ${r.expiresAt.slice(11, 16)}</div>`).join('')}</div>` : ''}<div class="card"><form method="post" action="/lite/cash"><label>Agent (@code or phone)</label><input name="agent" required><label>Amount</label><input name="amount" inputmode="decimal" required><label>Currency</label><select name="currency">${ws.map((w) => `<option value="${w.currency}">${w.currency} (${money(w.balance, w.currency)})</option>`).join('') || '<option value="USD">USD</option>'}</select><label>Your PIN</label><input name="pin" type="password" inputmode="numeric" required><button>Get a cash-out code</button></form><p class="m">Show the code to the agent. Money leaves your wallet only when the agent hands over the cash and confirms the code.</p></div>`, u));
});
liteRouter.post('/cash', limit, (req, res) => {
  const u = guard(req, res);
  if (!u) return;
  try {
    const cur = getCurrency(String(req.body?.currency ?? 'USD').toUpperCase());
    const minor = Math.round(Number(String(req.body?.amount ?? '0').replace(',', '.')) * 10 ** cur.decimals);
    if (!Number.isFinite(minor) || minor <= 0) throw new Error('Enter a valid amount');
    assertPin(u, String(req.body?.pin ?? ''));
    const r = createCashOutRequest(u, { agent: String(req.body?.agent ?? '').trim(), amount: minor, currency: cur.code });
    res.redirect('/lite/cash?ok=' + encodeURIComponent(`Code ${r.code} for ${money(minor, cur.code)} (fee ${money(r.fee, cur.code)}). Show it to agent @${r.agent.tag} within 30 minutes.`));
  } catch (err: any) {
    res.redirect('/lite/cash?err=' + encodeURIComponent(err?.message ?? 'Could not create a code'));
  }
});
liteRouter.get('/history', (req, res) => {
  const u = guard(req, res);
  if (!u) return;
  const pg = Math.max(1, Number(req.query.page) || 1);
  const r = listTransactions({ userId: u.id, page: pg, pageSize: 15 });
  res.send(page('History', `<div class="card">${r.items.length ? `<table>${r.items.map((t) => `<tr><td>${t.createdAt.slice(0, 10)}<br><span class="m">${e(t.type.replace(/_/g, ' '))}${t.counterparty ? ' · @' + e(t.counterparty.tag) : ''}${t.note ? ' · ' + e(t.note) : ''}</span></td><td class="r ${t.direction === 'in' ? 'b' : ''}">${t.direction === 'in' ? '+' : '−'}${money(t.amount, t.currency)}<br><span class="m">${e(t.status)}</span></td></tr>`).join('')}</table>` : '<span class="m">No transactions yet.</span>'}<p class="m">${pg > 1 ? `<a href="/lite/history?page=${pg - 1}">← Newer</a> ` : ''}${pg * 15 < r.total ? `<a href="/lite/history?page=${pg + 1}">Older →</a>` : ''}</p></div>`, u));
});
liteRouter.get('/statement', (req, res) => {
  const u = guard(req, res);
  if (!u) return;
  const ws = listWallets(u.id);
  const today = new Date().toISOString().slice(0, 10);
  const q = req.query as Record<string, string>;
  if (q.currency && q.from && q.to) {
    try {
      const s = buildStatement(u, q.currency.toUpperCase(), q.from, q.to, 'lite');
      const name = `bitripay-statement-${s.account.currency}-${q.from}-${q.to}`;
      if (q.format === 'pdf') return res.type('application/pdf').setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`).send(statementPdf(s));
      if (q.format === 'csv') return res.type('text/csv').setHeader('Content-Disposition', `attachment; filename="${name}.csv"`).send(statementCsv(s));
      return res.send(page('Statement', `<div class="card"><div class="b">Statement ${e(s.number)} · ${e(s.account.currency)}</div><div class="m">${e(s.period.from)} to ${e(s.period.to)} · hash ${e(s.hash.slice(0, 16))}…</div><table><tr><td>Opening</td><td class="r">${money(s.opening, s.account.currency)}</td></tr>${s.lines.map((l) => `<tr><td>${l.date.slice(0, 10)}<br><span class="m">${e(l.description)}</span></td><td class="r">${l.credit ? '+' + money(l.credit, s.account.currency) : '−' + money(l.debit, s.account.currency)}<br><span class="m">${money(l.balance, s.account.currency)}</span></td></tr>`).join('')}<tr><td class="b">Closing</td><td class="r b">${money(s.closing, s.account.currency)}</td></tr></table><p><a href="/lite/statement?currency=${e(s.account.currency)}&from=${e(q.from)}&to=${e(q.to)}&format=pdf">Download PDF</a> · <a href="/lite/statement?currency=${e(s.account.currency)}&from=${e(q.from)}&to=${e(q.to)}&format=csv">CSV</a></p></div>`, u));
    } catch (err: any) {
      return res.redirect('/lite/statement?err=' + encodeURIComponent(err?.message ?? 'Could not build the statement'));
    }
  }
  res.send(page('Statement', `${flash(req.query)}<div class="card"><form method="get" action="/lite/statement"><label>Currency</label><select name="currency">${ws.map((w) => `<option value="${w.currency}">${w.currency}</option>`).join('') || '<option value="USD">USD</option>'}</select><label>From</label><input name="from" type="date" value="${today.slice(0, 8)}01" required><label>To</label><input name="to" type="date" value="${today}" required><button>Show statement</button></form></div>`, u));
});
