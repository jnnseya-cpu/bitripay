/**
 * UI contract: what the web, admin and server-rendered surfaces promise the customer is backed by the API and by
 * the shipped copy. QR analytics shape and amount rules, the resolver's structured `blocked`, the hosted-checkout
 * disclosure block and recovery data, the national-switch customer wording in both languages, the positioning and
 * trust phrases on the public site, and the copy the React pages carry (read from source so drift is caught here).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupApp, registerUser } from './helpers';
import { getDb } from '../db';
import { findUserById } from '../services/users';
import { qrAnalytics, qrAmountRules, validateQrAmount, resolveScan, payerPolicyBlock } from '../services/qrcodes';
import { checkoutDisclosure } from '../routes/checkout';
import { customerMessage, SWITCH_STATES, SWITCH_LINK_CONDITIONS, SWITCH_UNAVAILABLE_MESSAGE } from '../services/switch/payments';
import { POSITIONING, POSITIONING_PHRASES } from '../content/positioning';
import { LOCALES } from '@bitripay/shared';

let app: ReturnType<typeof setupApp>;
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const src = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
const EIGHT = ['en', 'fr', 'es', 'pt', 'ar', 'sw', 'hi', 'bn'];

beforeAll(() => {
  app = setupApp();
});

async function merchantWithQr(country = 'CD') {
  const merchant = await registerUser(app, { role: 'merchant', businessName: `Shop ${Date.now()}`, country });
  const qr = await request(app).post('/api/v1/qr_codes').set(merchant.auth).send({ currency: 'USD', reference: 'TILL-1' });
  expect(qr.status, JSON.stringify(qr.body)).toBe(201);
  return { merchant, qr: qr.body };
}

describe('QR centre analytics and amount rules', () => {
  it('qrAnalytics carries byDay (one entry per day of the window, zeros kept) and byOutcome (array sorted by count) next to the existing fields', async () => {
    const { merchant, qr } = await merchantWithQr();
    const scan = await request(app).post('/api/qr/resolve').send({ data: qr.payload });
    expect(scan.status, JSON.stringify(scan.body)).toBe(200);
    const r = await request(app).get('/api/v1/qr_codes/analytics?days=7').set(merchant.auth);
    expect(r.status).toBe(200);
    expect(r.body.days).toBe(7);
    expect(Array.isArray(r.body.byDay)).toBe(true);
    expect(r.body.byDay).toHaveLength(7);
    for (const d of r.body.byDay) {
      expect(d.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof d.scans).toBe('number');
      expect(typeof d.paid).toBe('number');
    }
    const today = new Date().toISOString().slice(0, 10);
    expect(r.body.byDay[r.body.byDay.length - 1].day).toBe(today);
    expect(r.body.byDay[r.body.byDay.length - 1].scans).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(r.body.byOutcome)).toBe(true);
    expect(r.body.byOutcome.length).toBeGreaterThan(0);
    expect(r.body.byOutcome[0]).toEqual({ outcome: expect.any(String), count: expect.any(Number) });
    for (let i = 1; i < r.body.byOutcome.length; i++) expect(r.body.byOutcome[i - 1].count).toBeGreaterThanOrEqual(r.body.byOutcome[i].count);
    // the pre-existing fields are still there
    expect(r.body).toEqual(expect.objectContaining({ scans: expect.any(Object), conversion: null, byLocation: expect.any(Array), suspiciousScans: expect.any(Number) }));
    const direct = qrAnalytics(merchant.user.id, 3);
    expect(direct.byDay).toHaveLength(3);
  });

  it('validateQrAmount: dynamic needs an amount > 0, static may have none, min/max come from the merchant settings, currency must be receivable', async () => {
    const { merchant } = await merchantWithQr('CD');
    const row = findUserById(merchant.user.id)!;
    const rules = qrAmountRules(row);
    expect(rules.currencies).toEqual(expect.arrayContaining(['USD', 'CDF']));
    expect(rules.minAmountMinor).toBeNull();
    expect(rules.maxAmountMinor).toBeNull();
    expect(() => validateQrAmount(row, { mode: 'static', amount: null, currency: 'USD' })).not.toThrow();
    expect(() => validateQrAmount(row, { mode: 'dynamic', amount: null, currency: 'USD' })).toThrow(expect.objectContaining({ code: 'amount_required' }));
    expect(() => validateQrAmount(row, { mode: 'dynamic', amount: 0, currency: 'USD' })).toThrow(expect.objectContaining({ code: 'amount_required' }));
    expect(() => validateQrAmount(row, { mode: 'static', amount: 12.5 as any, currency: 'USD' })).toThrow(expect.objectContaining({ code: 'invalid_amount' }));
    expect(() => validateQrAmount(row, { mode: 'static', amount: 100, currency: 'JPY' })).toThrow(expect.objectContaining({ code: 'currency_not_receivable' }));
    expect(() => validateQrAmount(row, { mode: 'dynamic', amount: 100, currency: 'JPY', strictCurrency: false })).not.toThrow();
    getDb()
      .prepare('UPDATE users SET gateway_settings = ? WHERE id = ?')
      .run(JSON.stringify({ qrMinAmountMinor: 500, qrMaxAmountMinor: 10_000 }), row.id);
    const limited = findUserById(row.id)!;
    expect(qrAmountRules(limited)).toEqual(expect.objectContaining({ minAmountMinor: 500, maxAmountMinor: 10_000 }));
    expect(() => validateQrAmount(limited, { mode: 'dynamic', amount: 100, currency: 'USD' })).toThrow(expect.objectContaining({ code: 'amount_below_minimum' }));
    expect(() => validateQrAmount(limited, { mode: 'dynamic', amount: 20_000, currency: 'USD' })).toThrow(expect.objectContaining({ code: 'amount_above_maximum' }));
    expect(() => validateQrAmount(limited, { mode: 'dynamic', amount: 5_000, currency: 'USD' })).not.toThrow();
    // the API enforces the same rules on creation
    const bad = await request(app).post('/api/v1/qr_codes').set(merchant.auth).send({ currency: 'JPY' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('currency_not_receivable');
  });

  it('the resolver returns a structured blocked { reason, code } when the payer country policy forbids the payment, and null otherwise', async () => {
    const { merchant, qr } = await merchantWithQr('CD');
    const row = findUserById(merchant.user.id)!;
    const blocked = await resolveScan(qr.payload, { country: 'XX', channel: 'app' });
    expect(blocked.kind).not.toBe('invalid');
    expect(blocked.blocked).toEqual({ reason: expect.stringContaining('XX'), code: 'country_not_supported' });
    const fine = await resolveScan(qr.payload, { country: 'CD', channel: 'app' });
    expect(fine.blocked).toBeNull();
    expect(payerPolicyBlock(null, row, 1000, 'USD', 'XX')?.code).toBe('country_not_supported');
    expect(payerPolicyBlock(null, row, 1000, 'USD', 'KE')).toBeNull(); // KE ↔ CD both allow cross-border
    expect(payerPolicyBlock(null, row, 1000, 'USD', null)).toBeNull();
  });
});

describe('hosted checkout disclosure and recovery', () => {
  it('GET /api/checkout/:code ships the disclosure block: fee, FX (rate + margin), receiver currency and exact amount, total, ETA per method, trust copy', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Store', country: 'CD' });
    const link = await request(app).post('/api/payment-requests').set(merchant.auth).send({ kind: 'link', amount: '40.00', currency: 'USD', description: 'Order 1' });
    const code = link.body.paymentRequest.code as string;
    const info = await request(app).get(`/api/checkout/${code}`);
    expect(info.status).toBe(200);
    const d = info.body.disclosure;
    expect(d).toBeTruthy();
    expect(d.feeFrom).toBe('receiver');
    expect(d.feeMinor).toBeGreaterThan(0);
    expect(d.fxRate).toBe(1);
    expect(d.receiverCurrency).toBe('USD');
    expect(d.receiverAmountMinor).toBe(4000 - d.feeMinor);
    expect(d.totalMinor).toBe(4000);
    for (const m of info.body.methods) expect(typeof d.etaByMethod[m]).toBe('string');
    expect(d.etaByMethod.wallet).toBe('Instant');
    expect(d.trust).toBe(POSITIONING.notProof);
    expect(d.trust).toContain('A successful screen is not proof of payment');
    // settlement in another currency: rate, mid rate and margin are disclosed and the receiver amount is in that currency
    const set = await request(app).put('/api/merchant/gateway').set(merchant.auth).send({ settlementCurrency: 'EUR' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const fx = checkoutDisclosure(code, info.body.methods);
    expect(fx.receiverCurrency).toBe('EUR');
    expect(fx.fxRate).toBeGreaterThan(0);
    expect(fx.fxRate).not.toBe(1);
    expect(typeof fx.fxMidRate).toBe('number');
    expect(typeof fx.fxMarginBps).toBe('number');
    expect(fx.fxProvider.length).toBeGreaterThan(0);
    expect(fx.receiverAmountMinor).toBe(Math.round(((4000 - fx.feeMinor!) / 100) * fx.fxRate * 100));
    // open-amount requests disclose the structure without inventing numbers
    const open = await request(app).post('/api/payment-requests').set(merchant.auth).send({ kind: 'link', currency: 'USD' });
    const od = (await request(app).get(`/api/checkout/${open.body.paymentRequest.code}`)).body.disclosure;
    expect(od.feeMinor).toBeNull();
    expect(od.receiverAmountMinor).toBeNull();
    expect(od.totalMinor).toBeNull();
  });

  it('a failed attempt leaves the request open with its other methods available for recovery', async () => {
    const merchant = await registerUser(app, { role: 'merchant', businessName: 'Store 2', country: 'CD' });
    const link = await request(app).post('/api/payment-requests').set(merchant.auth).send({ kind: 'link', amount: '15.00', currency: 'USD' });
    const code = link.body.paymentRequest.code as string;
    const pay = await request(app)
      .post(`/api/checkout/${code}/pay`)
      .send({ method: 'card', card: { number: '4000000000000002', expMonth: 1, expYear: 2031, cvc: '999', holderName: 'Guest' }, email: 'guest@example.com' });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body.payment.status).toBe('failed');
    expect(pay.body.payment.failureReason).toBeTruthy();
    const again = await request(app).get(`/api/checkout/${code}`);
    expect(again.body.paymentRequest.status).toBe('open');
    expect(again.body.methods.length).toBeGreaterThan(1);
    expect(again.body.methods).toContain('card');
    expect(again.body.disclosure.trust).toBe(POSITIONING.notProof);
  });
});

describe('national switch customer wording', () => {
  it('every SwitchState and link condition has non-empty fr + en copy; the unavailable wording is the mandated French sentence in both packs', () => {
    for (const s of [...SWITCH_STATES, ...SWITCH_LINK_CONDITIONS]) {
      const m = customerMessage(s, { amount: '1 000 CDF', reference: 'REF-1', reason: 'insufficient funds' });
      expect(m.fr.trim().length, s).toBeGreaterThan(0);
      expect(m.en.trim().length, s).toBeGreaterThan(0);
    }
    for (const s of SWITCH_LINK_CONDITIONS) expect(customerMessage(s)).toEqual(SWITCH_UNAVAILABLE_MESSAGE);
    expect(SWITCH_UNAVAILABLE_MESSAGE.fr).toBe('Service temporairement indisponible. Réessayez plus tard.');
    expect(POSITIONING.switchUnavailable).toEqual(SWITCH_UNAVAILABLE_MESSAGE);
    expect(LOCALES.fr['switch.unavailable']).toBe(SWITCH_UNAVAILABLE_MESSAGE.fr);
    expect(LOCALES.en['switch.unavailable']).toBe(SWITCH_UNAVAILABLE_MESSAGE.en);
    // the web shows the wording through one component, in the user's language
    const cmp = src('frontend/web/src/components/SwitchMessage.tsx');
    expect(cmp).toContain("t('switch.unavailable')");
    expect(cmp).toContain("lang === 'fr' ? message.fr : message.en");
    const page = src('frontend/web/src/pages/SwitchPayments.tsx');
    expect(page).toContain('<SwitchMessage');
    expect(page).toContain('customer_message');
    expect(page).toContain('Instruction n°58');
  });
});

describe('positioning and trust copy on every surface', () => {
  it('the server-rendered site home, About and Lite carry both taglines; About/policies carry the no-custody wording and Instruction n°58', async () => {
    for (const p of ['/blog', '/about', '/lite/']) {
      const r = await request(app).get(p);
      expect(r.status, p).toBe(200);
      for (const phrase of POSITIONING_PHRASES) expect(r.text, `${p} ${phrase}`).toContain(phrase);
    }
    const about = await request(app).get('/about');
    expect(about.text).toContain('BitriPay never holds funds it is not licensed to hold; e-money balances are safeguarded 1:1.');
    const regulatory = await request(app).get('/legal/regulatory');
    expect(regulatory.status).toBe(200);
    expect(regulatory.text).toContain('Instruction n°58');
    expect(regulatory.text).toContain('never holds funds it is not licensed to hold');
    const page = await request(app).get('/api/pages/about');
    expect(page.body.content ?? page.body.page?.content ?? JSON.stringify(page.body)).toContain('ONE QR. ONE GATEWAY. EVERY ELIGIBLE RAIL.');
  });

  it('the developer portal explains signatures and tokens with RFC 9110 / RFC 7519 / RFC 8032', () => {
    for (const rfc of ['RFC 9110', 'RFC 7519', 'RFC 8032']) expect(POSITIONING.rfcSentence).toContain(rfc);
    const dev = src('frontend/web/src/pages/Developer.tsx');
    for (const rfc of ['RFC 9110', 'RFC 7519', 'RFC 8032']) expect(dev, rfc).toContain(rfc);
    expect(dev).toContain('Instruction n°58');
  });

  it('web landing, checkout, receipts/lifecycle and the command centre carry the positioning, trust and paused-AI keys, which exist in all eight packs', () => {
    const keys = [
      'positioning.oneQr',
      'positioning.payLocal',
      'trust.notProof',
      'trust.notProofShort',
      'checkout.disclosureTitle',
      'checkout.recoveryTitle',
      'checkout.retryWith',
      'assist.paused',
      'assist.pausedReset',
      'switch.unavailable',
      'qr.downloadPng',
      'qr.downloadPayload',
      'qr.amountRequired',
      'qr.amountRange',
      'qr.currencyNotReceivable',
      'nav.switchPayments',
    ];
    for (const lang of EIGHT) for (const k of keys) expect(LOCALES[lang]?.[k]?.trim().length, `${lang}.${k}`).toBeGreaterThan(0);
    expect(LOCALES.en['positioning.oneQr']).toBe(POSITIONING.oneQr);
    expect(LOCALES.fr['positioning.payLocal']).toBe(POSITIONING.payLocal);
    expect(LOCALES.en['trust.notProof']).toBe(POSITIONING.notProof);
    const landing = src('frontend/web/src/pages/Landing.tsx');
    expect(landing).toContain("t('positioning.oneQr')");
    expect(landing).toContain("t('positioning.payLocal')");
    const checkout = src('frontend/web/src/pages/Checkout.tsx');
    for (const k of ['checkout.disclosureTitle', 'checkout.recoveryTitle', 'checkout.retryWith', 'trust.notProof']) expect(checkout).toContain(`t('${k}'`);
    expect(checkout).toContain('info.disclosure');
    const ui = src('frontend/web/src/components/ui.tsx');
    expect(ui).toContain("t('trust.notProofShort')"); // StageTimeline: every lifecycle view
    const tx = src('frontend/web/src/pages/Transactions.tsx');
    expect(tx).toContain("t('trust.notProof')"); // the receipt
    const assist = src('frontend/web/src/pages/Assist.tsx');
    expect(assist).toContain("t('assist.paused')");
    expect(assist).toContain('neural_quota_exceeded');
    expect(assist).toContain('ACU depleted');
    const qr = src('frontend/web/src/pages/QrCentre.tsx');
    for (const k of ['qr.downloadPng', 'qr.downloadPayload', 'qr.amountRequired', 'qr.amountRange', 'qr.currencyNotReceivable']) expect(qr).toContain(`t('${k}'`);
    expect(qr).toContain('byOutcome');
    expect(qr).toContain('byDay');
  });

  it('admin labels the treasury role as TREASURY_SUPER_ADMIN on the e-money console and in the permission editor', () => {
    expect(src('frontend/admin/src/pages/Emoney.tsx')).toContain('TREASURY_SUPER_ADMIN');
    const users = src('frontend/admin/src/pages/Users.tsx');
    expect(users).toContain('Treasury (TREASURY_SUPER_ADMIN)');
    expect(users).toMatch(/PERM_LABELS\[p\] \?\? p/);
  });
});

describe('default content upgrades', () => {
  it('refreshes never-edited default pages, keeps administrator edits and still adds the national-switch section', async () => {
    const { setSetting } = await import('../services/settings');
    const { upsertPage, listPages } = await import('../services/cms');
    const { ensureDefaultContent, _resetDefaultContentForTests } = await import('../content/defaults');
    // simulate a deployment seeded before the national-switch section existed: an edited regulatory page without it
    upsertPage({ slug: 'regulatory', title: 'Regulatory information', content: '## Authorisation status\n\nEdited by the compliance team.', published: true });
    setSetting('content.version', 1);
    setSetting('content.seededHashes', {});
    _resetDefaultContentForTests();
    const r = ensureDefaultContent();
    expect(r.pages).toBeGreaterThan(0);
    const regulatory = listPages(false).find((p) => p.slug === 'regulatory')!;
    expect(regulatory.content).toContain('Edited by the compliance team.');
    expect(regulatory.content).toContain('## National payment switch');
    expect(regulatory.content).toContain('Instruction n°58');
    // an untouched page is refreshed in place when the default changes
    expect(listPages(false).find((p) => p.slug === 'about')!.content).toContain('never holds funds it is not licensed to hold');
  });

  it('retires the old mailboxes and web domain everywhere, inside administrator edits too: support@bitripay.com is the only inbox', async () => {
    const { setSetting, getSetting } = await import('../services/settings');
    const { upsertPage, listPages } = await import('../services/cms');
    const { ensureDefaultContent, _resetDefaultContentForTests, retireOldAddresses } = await import('../content/defaults');
    const { getDb } = await import('../db');
    upsertPage({ slug: 'complaints', title: 'Complaints', content: 'Edited: write to complaints@bitripay.app or privacy@bitripay.app; the app is at https://pay.bitripay.app/pay.', published: true });
    getDb().prepare("UPDATE blog_posts SET body_md = body_md || ' Old link: bitripay.app/u/yourtag' WHERE slug = (SELECT slug FROM blog_posts LIMIT 1)").run();
    setSetting('seo', { ...getSetting<any>('seo'), organization: { ...getSetting<any>('seo').organization, email: 'hello@bitripay.app' } });
    setSetting('content.version', 2);
    _resetDefaultContentForTests();
    ensureDefaultContent();
    const complaints = listPages(false).find((p) => p.slug === 'complaints')!;
    expect(complaints.content).toBe('Edited: write to support@bitripay.com or support@bitripay.com; the app is at https://www.bitripay.com/pay.');
    expect(getSetting<any>('seo').organization.email).toBe('support@bitripay.com');
    const stale = getDb().prepare("SELECT COUNT(*) c FROM blog_posts WHERE body_md LIKE '%bitripay.app%'").get() as { c: number };
    expect(stale.c).toBe(0);
    for (const page of listPages(false)) expect(page.content, page.slug).not.toMatch(/bitripay\.app/);
    expect(retireOldAddresses('security@bitripay.app')).toBe('support@bitripay.com');
  });
});
