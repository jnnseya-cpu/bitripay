/**
 * Launch audit: black-box adversarial probes against a running BitriPay API. Every probe records the request, the
 * status and the evidence it saw, and ends PASS / FAIL / BLOCKED. Exit code is non-zero when any probe fails.
 *
 *   API_URL=http://127.0.0.1:4321 ADMIN_EMAIL=admin@bitripay.local ADMIN_PASSWORD=… node scripts/launch-audit.mjs
 *
 * Meant for a scratch database (it registers accounts, moves test money, fires hundreds of requests). Never point it
 * at production with live customer data.
 */
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';

const API = (process.env.API_URL ?? 'http://127.0.0.1:4321').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@bitripay.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin123!';
const OUT = process.env.AUDIT_OUT ?? 'docs/audit/launch-audit-probes.json';

const results = [];
const record = (id, area, status, evidence, extra = {}) => {
  results.push({ id, area, status, evidence, ...extra });
  const mark = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '○';
  console.log(`  ${mark} ${id} [${status}] ${evidence}`);
};
async function probe(id, area, fn) {
  try {
    const r = await fn();
    record(id, area, r.pass ? 'PASS' : 'FAIL', r.evidence, r.extra ?? {});
  } catch (e) {
    record(id, area, 'FAIL', `threw: ${e.message}`);
  }
}
async function call(method, path, { body, token, headers = {}, raw } = {}) {
  const started = performance.now();
  const res = await fetch(API + path, {
    method,
    headers: { ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, headers: res.headers, json, text, ms: performance.now() - started };
}
const rnd = () => Math.floor(Math.random() * 1e9);
async function register(overrides = {}) {
  const n = rnd();
  const r = await call('POST', '/api/auth/register', { body: { fullName: `Audit User ${n}`, email: `audit${n}@audit.local`, password: 'AuditPass123!', ...overrides } });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${r.text.slice(0, 200)}`);
  await call('POST', '/api/account/pin', { token: r.json.token, body: { pin: '1234' } });
  return { token: r.json.token, user: r.json.user };
}

console.log(`Launch audit against ${API}`);

// ---------------------------------------------------------------------------------------------------- build & health
await probe('health', 'build', async () => {
  const r = await call('GET', '/api/health');
  return { pass: r.status === 200 && r.json?.ok === true, evidence: `GET /api/health → ${r.status} ${r.text.slice(0, 80)}` };
});
await probe('headers.api', 'security', async () => {
  const r = await call('GET', '/api/config');
  const xcto = r.headers.get('x-content-type-options');
  const powered = r.headers.get('x-powered-by');
  const xfo = r.headers.get('x-frame-options');
  const rp = r.headers.get('referrer-policy');
  return {
    pass: xcto === 'nosniff' && !powered && xfo === 'DENY' && !!rp,
    evidence: `x-content-type-options=${xcto} x-frame-options=${xfo} referrer-policy=${rp} x-powered-by=${powered ?? 'absent'} (HSTS is set at the TLS edge)`,
  };
});
await probe('error.schema.404', 'api', async () => {
  const r = await call('GET', '/api/this-route-does-not-exist');
  return { pass: r.status === 404 && r.json?.error?.code && !/at .*\.js:\d+/.test(r.text), evidence: `→ ${r.status} ${r.text.slice(0, 120)}` };
});
await probe('error.schema.malformed-json', 'api', async () => {
  const r = await call('POST', '/api/auth/login', { body: '{"identifier": ', raw: true, headers: { 'Content-Type': 'application/json' } });
  return { pass: r.status === 400 && !!r.json?.error?.code && !/SyntaxError.*at /.test(r.text), evidence: `→ ${r.status} ${r.text.slice(0, 120)}` };
});
await probe('body.oversized', 'api', async () => {
  const r = await call('POST', '/api/auth/login', { body: JSON.stringify({ identifier: 'x'.repeat(13 * 1024 * 1024), password: 'y' }), raw: true, headers: { 'Content-Type': 'application/json' } });
  return { pass: r.status === 413, evidence: `13 MB body → ${r.status}` };
});

// ---------------------------------------------------------------------------------------------------- authentication
let admin;
let lastFund = '';
await probe('auth.admin-login', 'auth', async () => {
  const r = await call('POST', '/api/auth/login', { body: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  admin = r.json?.token;
  if (admin) await call('POST', '/api/account/pin', { token: admin, body: { pin: '9999' } });
  return { pass: r.status === 200 && !!admin, evidence: `admin login → ${r.status}` };
});
await probe('auth.wrong-password', 'auth', async () => {
  const r = await call('POST', '/api/auth/login', { body: { identifier: ADMIN_EMAIL, password: 'definitely-wrong' } });
  return { pass: r.status === 401 && r.json?.error?.code === 'invalid_credentials', evidence: `→ ${r.status} ${r.json?.error?.code}` };
});
await probe('auth.enumeration', 'auth', async () => {
  const a = await call('POST', '/api/auth/login', { body: { identifier: 'nobody-here@audit.local', password: 'x' } });
  const b = await call('POST', '/api/auth/login', { body: { identifier: ADMIN_EMAIL, password: 'x' } });
  return { pass: a.status === b.status && a.json?.error?.code === b.json?.error?.code, evidence: `unknown user → ${a.status} ${a.json?.error?.code}; known user → ${b.status} ${b.json?.error?.code}` };
});
await probe('auth.tampered-token', 'auth', async () => {
  const a = await register();
  const [h, p] = a.token.split('.');
  const r = await call('GET', '/api/auth/me', { token: `${h}.${p}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` });
  return { pass: r.status === 401, evidence: `forged signature → ${r.status} ${r.json?.error?.code}` };
});
await probe('auth.password-policy', 'auth', async () => {
  const r = await call('POST', '/api/auth/register', { body: { fullName: 'Weak', email: `weak${rnd()}@audit.local`, password: 'short' } });
  return { pass: r.status === 400, evidence: `5-char password → ${r.status}` };
});
await probe('auth.session-invalidated-on-password-change', 'auth', async () => {
  const a = await register();
  await new Promise((r) => setTimeout(r, 1100));
  const ch = await call('POST', '/api/account/password', { token: a.token, body: { currentPassword: 'AuditPass123!', newPassword: 'AuditPass456!' } });
  const me = await call('GET', '/api/auth/me', { token: a.token });
  return { pass: ch.status === 200 && me.status === 401, evidence: `password change → ${ch.status}; old token → ${me.status}` };
});

// ---------------------------------------------------------------------------------------------------- authorisation
let userA;
let userB;
await probe('authz.admin-routes', 'authz', async () => {
  userA = await register({ tag: `audita${rnd() % 100000}` });
  userB = await register({ tag: `auditb${rnd() % 100000}` });
  const none = await call('GET', '/api/admin/stats');
  const user = await call('GET', '/api/admin/stats', { token: userA.token });
  const users = await call('GET', '/api/admin/users', { token: userA.token });
  return { pass: none.status === 401 && user.status === 403 && users.status === 403, evidence: `no token → ${none.status}; customer token → ${user.status}/${users.status}` };
});
await probe('authz.idor.payment-request', 'authz', async () => {
  const pr = await call('POST', '/api/payment-requests', { token: userA.token, body: { kind: 'request', amount: '5.00', currency: 'USD', payer: `@${userB.user.tag}` } });
  const cancelByB = await call('POST', `/api/payment-requests/${pr.json?.paymentRequest?.code}/cancel`, { token: userB.token, body: {} });
  const cancelByA = await call('POST', `/api/payment-requests/${pr.json?.paymentRequest?.code}/cancel`, { token: userA.token, body: {} });
  return {
    pass: pr.status === 201 && cancelByB.status >= 400 && cancelByA.status === 200,
    evidence: `create → ${pr.status}; cancel by other party → ${cancelByB.status}; cancel by owner → ${cancelByA.status}`,
  };
});
await probe('authz.idor.transaction', 'authz', async () => {
  const fund = await fundUser(userA.user.id, '30.00'); // tier 1: 50.00 per operation and per day in production
  const tx = await call('POST', '/api/transfers', { token: userA.token, body: { to: `@${userB.user.tag}`, amount: '2.00', currency: 'USD', pin: '1234' } });
  const stranger = await register();
  const byStranger = await call('GET', `/api/wallets/transactions/${tx.json?.transaction?.id}`, { token: stranger.token });
  const byParty = await call('GET', `/api/wallets/transactions/${tx.json?.transaction?.id}`, { token: userB.token });
  return {
    pass: fund && tx.status === 201 && byStranger.status === 404 && byParty.status === 200,
    evidence: `fund → ${fund} (${lastFund}); transfer → ${tx.status} ${tx.json?.error?.code ?? ''}; read by stranger → ${byStranger.status}; read by counterparty → ${byParty.status}`,
  };
});
async function fundUser(userId, amount) {
  if (!admin) return false;
  const adj = await call('POST', `/api/admin/users/${userId}/adjust`, { token: admin, body: { direction: 'credit', amount, currency: 'USD', reason: 'launch audit funding' } });
  lastFund = `adjust→${adj.status}`;
  if (adj.status !== 201) return false;
  let checker = await call('POST', '/api/auth/login', { body: { identifier: 'checker@audit.local', password: 'CheckerPass123!' } });
  if (checker.status !== 200) {
    const mk = await call('POST', '/api/admin/users', {
      token: admin,
      body: { fullName: 'Audit Checker', email: 'checker@audit.local', password: 'CheckerPass123!', role: 'admin', permissions: ['approvals', 'issuance', 'treasury'] },
    });
    lastFund += ` create-checker→${mk.status}`;
    checker = await call('POST', '/api/auth/login', { body: { identifier: 'checker@audit.local', password: 'CheckerPass123!' } });
    const pin = await call('POST', '/api/account/pin', { token: checker.json?.token, body: { pin: '2222' } });
    lastFund += ` checker-login→${checker.status} pin→${pin.status}`;
  }
  const ok = await call('POST', `/api/admin/verifications/${adj.json.verification.id}/approve`, { token: checker.json?.token, body: { pin: '2222' } });
  lastFund += ` approve→${ok.status} ${ok.json?.error?.code ?? ''}`;
  return ok.status === 200;
}
await probe('authz.maker-checker', 'financial', async () => {
  const adj = await call('POST', `/api/admin/users/${userB.user.id}/adjust`, { token: admin, body: { direction: 'credit', amount: '1.00', currency: 'USD', reason: 'self approval attempt' } });
  const self = await call('POST', `/api/admin/verifications/${adj.json?.verification?.id}/approve`, { token: admin, body: { pin: '9999' } });
  return { pass: adj.status === 201 && self.status === 403, evidence: `proposal → ${adj.status}; author approving own proposal → ${self.status}` };
});

// ---------------------------------------------------------------------------------------------------- money input validation
await probe('money.invalid-amounts', 'financial', async () => {
  const cases = ['-5.00', '0', 'abc', '1e12', '0.001', '99999999999999'];
  const out = [];
  for (const amount of cases) {
    const r = await call('POST', '/api/transfers', { token: userA.token, body: { to: `@${userB.user.tag}`, amount, currency: 'USD', pin: '1234' } });
    out.push(`${amount}→${r.status}`);
  }
  const pass = out.every((o) => /→(400|422)$/.test(o));
  return { pass, evidence: out.join(' ') };
});
await probe('money.band-minimum', 'financial', async () => {
  const r = await call('POST', '/api/transfers', { token: userA.token, body: { to: `@${userB.user.tag}`, amount: '0.50', currency: 'USD', pin: '1234' } });
  return { pass: r.status === 422 && r.json?.error?.code === 'amount_below_minimum', evidence: `0.50 transfer → ${r.status} ${r.json?.error?.code}` };
});
await probe('money.insufficient-funds', 'financial', async () => {
  const r = await call('POST', '/api/transfers', { token: userB.token, body: { to: `@${userA.user.tag}`, amount: '45.00', currency: 'USD', pin: '1234' } });
  return { pass: r.status === 422 && r.json?.error?.code === 'insufficient_funds', evidence: `→ ${r.status} ${r.json?.error?.code}` };
});
await probe('money.wrong-pin', 'financial', async () => {
  const r = await call('POST', '/api/transfers', { token: userA.token, body: { to: `@${userB.user.tag}`, amount: '2.00', currency: 'USD', pin: '0000' } });
  return { pass: r.status === 403, evidence: `wrong PIN → ${r.status} ${r.json?.error?.code}` };
});
await probe('money.idempotency', 'financial', async () => {
  const key = `audit-${rnd()}`;
  const a = await call('POST', '/api/transfers', { token: userA.token, body: { to: `@${userB.user.tag}`, amount: '2.00', currency: 'USD', pin: '1234', idempotencyKey: key } });
  const b = await call('POST', '/api/transfers', { token: userA.token, body: { to: `@${userB.user.tag}`, amount: '2.00', currency: 'USD', pin: '1234', idempotencyKey: key } });
  const c = await call('POST', '/api/transfers', { token: userA.token, body: { to: `@${userB.user.tag}`, amount: '3.00', currency: 'USD', pin: '1234', idempotencyKey: key } });
  return {
    pass: a.status === 201 && b.json?.transaction?.id === a.json?.transaction?.id && c.status >= 400,
    evidence: `first → ${a.status}; replay → same id ${b.json?.transaction?.id === a.json?.transaction?.id}; reuse with other body → ${c.status}`,
  };
});
await probe('money.concurrent-double-spend', 'financial', async () => {
  const before = (await call('GET', '/api/wallets', { token: userA.token })).json.items.find((w) => w.currency === 'USD').balance;
  const amount = Math.max(100, Math.floor(before / 3)); // three would fit, twenty would not (tier-1 daily limit permitting)
  const attempts = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      call('POST', '/api/transfers', { token: userA.token, body: { to: `@${userB.user.tag}`, amount: (amount / 100).toFixed(2), currency: 'USD', pin: '1234', idempotencyKey: `race-${rnd()}-${i}` } }),
    ),
  );
  const ok = attempts.filter((r) => r.status === 201).length;
  const after = (await call('GET', '/api/wallets', { token: userA.token })).json.items.find((w) => w.currency === 'USD').balance;
  return { pass: after >= 0 && ok <= 3, evidence: `balance ${before} → ${after}; ${ok}/20 parallel transfers of ${amount} accepted (max 3 could fit)` };
});
await probe('money.unicode-note', 'api', async () => {
  const r = await call('POST', '/api/transfers', {
    token: userB.token,
    body: { to: `@${userA.user.tag}`, amount: '1.00', currency: 'USD', pin: '1234', note: 'Mbote 🇨🇩 <script>alert(1)</script> \u0000\u202e' },
  });
  const view = r.json?.transaction?.note ?? '';
  // eslint-disable-next-line no-control-regex
  return { pass: r.status === 201 && !/[\u0000-\u001f\u202e]/.test(view), evidence: `→ ${r.status}; stored note ${JSON.stringify(view).slice(0, 80)}` };
});

// ---------------------------------------------------------------------------------------------------- web security
await probe('cors.no-credentials', 'security', async () => {
  const r = await call('GET', '/api/config', { headers: { Origin: 'https://evil.example' } });
  return {
    pass: r.headers.get('access-control-allow-credentials') === null,
    evidence: `ACAO=${r.headers.get('access-control-allow-origin')} ACAC=${r.headers.get('access-control-allow-credentials') ?? 'absent'}`,
  };
});
await probe('webhook.forged-processor-callback', 'security', async () => {
  const r = await call('POST', '/api/webhooks/stripe', { body: { type: 'payment_intent.succeeded', data: { object: { id: 'pi_forged', amount: 100000 } } } });
  return { pass: r.status >= 400 && r.status < 500, evidence: `unsigned Stripe event → ${r.status}` };
});
await probe('ssrf.webhook-endpoint', 'security', async () => {
  const m = await register({ role: 'merchant', businessName: 'Audit Shop' });
  const out = [];
  for (const url of ['http://127.0.0.1:4321/api/health', 'https://169.254.169.254/latest/meta-data', 'https://localhost/x']) {
    const r = await call('POST', '/api/v1/webhook_endpoints', { token: m.token, body: { url, events: ['payment_intent.succeeded'] } });
    out.push(`${url}→${r.status}`);
  }
  return { pass: out.every((o) => /→4\d\d$/.test(o)), evidence: out.join(' ') };
});
await probe('redirect.javascript-url', 'security', async () => {
  const m = await register({ role: 'merchant', businessName: 'Audit Shop 2' });
  const r = await call('POST', '/api/v1/checkout_sessions', { token: m.token, body: { currency: 'USD', amount_minor: 1000, success_url: 'javascript:alert(1)' } });
  return { pass: r.status === 400, evidence: `javascript: success_url → ${r.status}` };
});
await probe('xss.blog-markdown', 'security', async () => {
  const slug = `audit-xss-${rnd()}`;
  const post = await call('POST', '/api/admin/blog/posts', {
    token: admin,
    body: {
      title: 'Audit XSS probe',
      slug,
      excerpt: 'x',
      bodyMd: 'Hello <script>alert("xss")</script> <img src=x onerror=alert(1)> [link](javascript:alert(2)) and more words to pass the minimum length',
      status: 'published',
      tags: ['audit'],
    },
  });
  const page = await call('GET', `/blog/${slug}`);
  const leaked = /<script>alert\("xss"\)|<img src=x onerror|href="javascript:/i.test(page.text);
  return { pass: post.status === 201 && page.status === 200 && !leaked, evidence: `post → ${post.status}; page → ${page.status}; raw script/onerror/javascript: leaked → ${leaked}` };
});
await probe('path.traversal', 'security', async () => {
  const out = [];
  for (const p of ['/legal/..%2F..%2Fetc%2Fpasswd', '/legal/../../etc/passwd', '/brand/../../package.json', '/lite/..%2F..%2F']) {
    const r = await call('GET', p);
    out.push(`${p}→${r.status}${/root:x:0:0|"name": "bitripay"/.test(r.text) ? '!LEAK' : ''}`);
  }
  return { pass: out.every((o) => !o.includes('LEAK') && !/→200/.test(o)), evidence: out.join(' ') };
});
await probe('rate-limit.public-site', 'security', async () => {
  let limited = false;
  for (let i = 0; i < 260; i += 1) {
    const r = await call('GET', '/status.json');
    if (r.status === 429) {
      limited = true;
      break;
    }
  }
  return { pass: limited, evidence: limited ? '429 within 260 requests (limit 240/min per client)' : 'no 429 after 260 requests' };
});

// ---------------------------------------------------------------------------------------------------- privacy
await probe('privacy.account-closure', 'privacy', async () => {
  const c = await register();
  const blocked = await call('DELETE', '/api/account', { token: c.token, body: { password: 'wrong', confirm: 'CLOSE', pin: '1234' } });
  const closed = await call('DELETE', '/api/account', { token: c.token, body: { password: 'AuditPass123!', confirm: 'CLOSE', pin: '1234' } });
  const me = await call('GET', '/api/auth/me', { token: c.token });
  const login = await call('POST', '/api/auth/login', { body: { identifier: c.user.email, password: 'AuditPass123!' } });
  return {
    pass: blocked.status === 400 && closed.status === 200 && me.status === 403 && login.status === 401,
    evidence: `wrong password → ${blocked.status}; close → ${closed.status}; token after → ${me.status}; login after → ${login.status}`,
  };
});

// ---------------------------------------------------------------------------------------------------- integrity & performance
await probe('ledger.reconcile-after-probes', 'financial', async () => {
  const r = await call('GET', '/api/admin/reconcile', { token: admin });
  const g = await call('GET', '/api/admin/guardian', { token: admin });
  return {
    pass: r.json?.ledger?.ok === true && r.json?.events?.ok === true && g.json?.state?.mode === 'normal',
    evidence: `ledger ok=${r.json?.ledger?.ok} (${r.json?.ledger?.transactionsChecked} tx) chain ok=${r.json?.events?.ok} guardian=${g.json?.state?.mode}`,
  };
});
await probe('perf.config-read', 'performance', async () => {
  const N = 300;
  const times = [];
  const errors = [];
  const batch = async () => {
    const r = await call('GET', '/api/config');
    times.push(r.ms);
    if (r.status !== 200) errors.push(r.status);
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: N }, batch));
  const wall = performance.now() - started;
  times.sort((a, b) => a - b);
  const pct = (p) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * p))]);
  return {
    pass: errors.length === 0 && pct(0.95) < 2000,
    evidence: `${N} concurrent GET /api/config in ${Math.round(wall)} ms: p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, p99 ${pct(0.99)} ms, errors ${errors.length}`,
    extra: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), errors: errors.length, wallMs: Math.round(wall) },
  };
});
await probe('perf.transfers', 'performance', async () => {
  await fundUser(userB.user.id, '45.00');
  const N = 40; // tier 1 allows 50.00 a day: forty 1.00 transfers
  const times = [];
  let ok = 0;
  const refused = {};
  const started = performance.now();
  await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const r = await call('POST', '/api/transfers', { token: userB.token, body: { to: `@${userA.user.tag}`, amount: '1.00', currency: 'USD', pin: '1234', idempotencyKey: `perf-${rnd()}-${i}` } });
      times.push(r.ms);
      if (r.status === 201) ok += 1;
      else refused[r.json?.error?.code ?? r.status] = (refused[r.json?.error?.code ?? r.status] ?? 0) + 1;
    }),
  );
  const wall = performance.now() - started;
  times.sort((a, b) => a - b);
  const pct = (p) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * p))]);
  const rec = await call('GET', '/api/admin/reconcile', { token: admin });
  const onlyControls = Object.keys(refused).every((k) => /limit|velocity|risk|review|insufficient/.test(k));
  return {
    pass: ok > 0 && onlyControls && rec.json?.ledger?.ok === true,
    evidence: `${N} concurrent transfers in ${Math.round(wall)} ms: ${ok} posted, refused ${JSON.stringify(refused)} (controls, not faults), p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, p99 ${pct(0.99)} ms; ledger ok=${rec.json?.ledger?.ok}`,
    extra: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), posted: ok, wallMs: Math.round(wall) },
  };
});

// The brute-force probe exhausts the shared auth limiter for this client, so it runs last.
await probe('auth.brute-force-limit', 'auth', async () => {
  let limited = null;
  for (let i = 0; i < 40; i += 1) {
    const r = await call('POST', '/api/auth/login', { body: { identifier: 'brute@audit.local', password: `guess${i}` } });
    if (r.status === 429) {
      limited = i + 1;
      break;
    }
  }
  return { pass: limited !== null && limited <= 35, evidence: limited ? `429 after ${limited} attempts (limit 30 per 15 min per client)` : 'no 429 after 40 attempts' };
});

// ---------------------------------------------------------------------------------------------------- summary
const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
console.log(
  `\n${results.length} probes: ${Object.entries(counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')}`,
);
fs.mkdirSync(OUT.split('/').slice(0, -1).join('/') || '.', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ api: API, ranAt: new Date().toISOString(), counts, results }, null, 2));
console.log(`evidence written to ${OUT}`);
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
