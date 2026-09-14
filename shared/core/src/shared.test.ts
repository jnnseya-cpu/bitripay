import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMinor, fromMinor, formatMoney, convertMinor, applyBps } from './money.ts';
import { encodeQr, decodeQr, encodeQrLink } from './qr.ts';
import { luhnCheck, luhnCheckDigit, detectCardBrand, isExpiryValid } from './cards.ts';
import { normalizePhone, nationalSignificant, samePhone } from './phone.ts';
import { en } from './locales/en.ts';
import { fr } from './locales/fr.ts';
import { es } from './locales/es.ts';
import { pt } from './locales/pt.ts';
import { ar } from './locales/ar.ts';
import { sw } from './locales/sw.ts';
import { hi } from './locales/hi.ts';
import { bn } from './locales/bn.ts';
import { ln } from './locales/ln.ts';
import { kg } from './locales/kg.ts';
import { lua } from './locales/lua.ts';

test('money conversion round trips', () => {
  assert.equal(toMinor('12.50', 2), 1250);
  assert.equal(toMinor('12', 2), 1200);
  assert.equal(toMinor('1,000.5', 2), 100050);
  assert.equal(toMinor('150', 0), 150);
  assert.throws(() => toMinor('12.505', 2));
  assert.throws(() => toMinor('abc', 2));
  assert.equal(fromMinor(1250, 2), '12.50');
  assert.equal(fromMinor(5, 2), '0.05');
  assert.equal(fromMinor(-1250, 2), '-12.50');
  assert.equal(fromMinor(150, 0), '150');
  assert.equal(formatMoney(123456789, { code: 'USD', symbol: '$', decimals: 2 }), '$1,234,567.89');
  assert.equal(applyBps(10000, 150), 150);
});

test('currency conversion', () => {
  const usd = { code: 'USD', name: '', symbol: '$', decimals: 2, rateToBase: 1 };
  const ngn = { code: 'NGN', name: '', symbol: '₦', decimals: 2, rateToBase: 1500 };
  assert.equal(convertMinor(100, usd, ngn), 150000);
  assert.equal(convertMinor(150000, ngn, usd), 100);
});

test('qr codec', () => {
  const p = { type: 'pr' as const, id: 'ABC123', amount: '10.00', currency: 'USD', note: 'Coffee' };
  const encoded = encodeQr(p);
  assert.ok(encoded.startsWith('bitripay://pay?'));
  assert.deepEqual(decodeQr(encoded), p);
  const link = encodeQrLink({ type: 'u', id: 'alice' }, 'https://pay.example.com/');
  assert.equal(link, 'https://pay.example.com/q?v=1&t=u&id=alice');
  assert.deepEqual(decodeQr(link), { type: 'u', id: 'alice' });
  assert.deepEqual(decodeQr('https://pay.example.com/pay/XYZ'), { type: 'pr', id: 'XYZ' });
  assert.deepEqual(decodeQr('@Alice'), { type: 'u', id: 'alice' });
  assert.equal(decodeQr('https://google.com'), null);
  assert.equal(decodeQr('hello'), null);
});

test('card helpers', () => {
  assert.ok(luhnCheck('4242424242424242'));
  assert.ok(!luhnCheck('4242424242424241'));
  const partial = '627311000000001';
  assert.ok(luhnCheck(partial + luhnCheckDigit(partial)));
  assert.equal(detectCardBrand('4242424242424242'), 'visa');
  assert.equal(detectCardBrand('5555555555554444'), 'mastercard');
  assert.equal(detectCardBrand('378282246310005'), 'amex');
  assert.equal(detectCardBrand('6273110000000012'), 'bitripay');
  assert.ok(isExpiryValid(12, 2099));
  assert.ok(!isExpiryValid(1, 2000));
});

test('every built-in locale carries every English key, no orphan keys and the same placeholders', () => {
  const LOCALES: Record<string, Record<string, string>> = { en, fr, es, pt, ar, sw, hi, bn, ln, kg, lua };
  const PARTIAL = ['ln', 'kg', 'lua']; // launch packs that fall back to French, then English
  const keys = Object.keys(en);
  const placeholders = (v: string) => (v.match(/\{\w+\}/g) ?? []).sort();
  for (const [lang, dict] of Object.entries(LOCALES)) {
    const missing = keys.filter((k) => !(k in dict));
    const extra = Object.keys(dict).filter((k) => !(k in en));
    if (PARTIAL.includes(lang)) assert.ok(Object.keys(dict).length >= 20, `${lang} partial pack carries at least the core keys`);
    else assert.deepEqual(missing, [], `${lang} is missing ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${lang} has keys unknown to en: ${extra.join(', ')}`);
    for (const [k, v] of Object.entries(dict)) {
      assert.ok(v.trim().length > 0, `${lang}.${k} is empty`);
      assert.deepEqual(placeholders(v), placeholders(en[k]), `${lang}.${k} placeholders differ from en`);
    }
  }
  assert.equal(fr['nav.statements'], 'Relevés');
  // partial packs fall back to French before English
  const chain = (lang: string, key: string) => LOCALES[lang]?.[key] ?? (PARTIAL.includes(lang) ? fr[key] : undefined) ?? en[key];
  assert.equal(chain('ln', 'nav.send'), 'Kotinda mbongo');
  assert.equal(chain('ln', 'nav.statements'), 'Relevés');
  assert.equal(chain('kg', 'dash.welcome'), 'Mbote, {name}');
  assert.equal(chain('lua', 'nav.savings'), 'Épargne et objectifs');
});

test('phone normalisation is shared and prefix-tolerant', () => {
  assert.equal(normalizePhone(' +243 (0)81 234-5678 '), '+2430812345678');
  assert.equal(normalizePhone('00243812345678'), '+243812345678');
  assert.equal(normalizePhone('243812345678'), '+243812345678');
  assert.equal(normalizePhone('+'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(nationalSignificant('+243 812 345 678'), '812345678');
  assert.equal(nationalSignificant('0812345678'), '812345678');
  assert.equal(nationalSignificant('1234567'), null);
  assert.ok(samePhone('+243812345678', '0812345678'));
  assert.ok(!samePhone('+243812345678', '+243812345679'));
  assert.ok(!samePhone(null, '0812345678'));
});
