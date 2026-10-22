/**
 * The feature catalogue, the feature pages and the feature articles.
 *
 * The load-bearing test here is the one about availability: a capability the platform would refuse must never read
 * as available on a public page, and the prose must not assert availability at all, because prose cannot know.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, adminToken } from './helpers';
import { FEATURES, FEATURE_BY_SLUG, FEATURE_CATEGORIES } from '../content/features';
import { featureArticles } from '../content/featureArticles';
import { featureAvailability, featurePage, featuresIndexPage, FEATURE_PATHS } from '../site/features';
import { DEFAULT_MODULES, AGGREGATOR_PERIMETER_OFF, AGGREGATOR_PERIMETER_ON, type ModuleFlags } from '../services/modules';
import { listPosts } from '../services/blog';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('feature catalogue', () => {
  it('gives every feature a selling point, a problem, steps, checkable proof, a price and questions', () => {
    expect(FEATURES.length).toBeGreaterThan(0);
    for (const f of FEATURES) {
      expect(f.usp.length, `${f.key} usp`).toBeGreaterThan(40);
      expect(f.headline.length, `${f.key} headline`).toBeGreaterThan(10);
      expect(f.excerpt.length, `${f.key} excerpt`).toBeGreaterThan(60);
      expect(f.problem.length, `${f.key} problem`).toBeGreaterThan(40);
      expect(f.how.length, `${f.key} how`).toBeGreaterThanOrEqual(3);
      expect(f.proof.length, `${f.key} proof`).toBeGreaterThanOrEqual(3);
      expect(f.cost.length, `${f.key} cost`).toBeGreaterThan(20);
      expect(f.faq.length, `${f.key} faq`).toBeGreaterThanOrEqual(3);
      expect(f.keywords.length, `${f.key} keywords`).toBeGreaterThanOrEqual(3);
      expect(f.article.length, `${f.key} article`).toBeGreaterThan(900);
      expect(FEATURE_CATEGORIES[f.category], `${f.key} category`).toBeTruthy();
      expect(f.cta.href.startsWith('/'), `${f.key} cta`).toBe(true);
    }
  });

  it('keeps keys, slugs and article slugs unique, and every related key resolves', () => {
    const keys = FEATURES.map((f) => f.key);
    const slugs = FEATURES.map((f) => f.slug);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const f of FEATURES)
      for (const r of f.related)
        expect(
          FEATURES.some((x) => x.key === r),
          `${f.key} → ${r}`,
        ).toBe(true);
  });

  it('binds every gated feature to a real module flag', () => {
    for (const f of FEATURES) {
      if (f.module === null) continue;
      expect(Object.keys(DEFAULT_MODULES), `${f.key}`).toContain(f.module);
    }
  });

  it('never states availability in the prose: that is a fact about a deployment, not about the feature', () => {
    const forbidden = /\b(available (today|now)|switched on today|currently available|live today)\b/i;
    for (const f of FEATURES) {
      expect(forbidden.test(f.article), `${f.key} article`).toBe(false);
      expect(forbidden.test(f.usp), `${f.key} usp`).toBe(false);
      expect(forbidden.test(f.cost), `${f.key} cost`).toBe(false);
    }
  });
});

describe('availability is computed, not claimed', () => {
  it('reads a capability inside the aggregator perimeter as awaiting an authorisation, never as available', () => {
    // A perimeter deployment: only the acceptance modules on, every issuer and acquirer function off.
    const perimeter = Object.fromEntries(Object.keys(DEFAULT_MODULES).map((k) => [k, AGGREGATOR_PERIMETER_ON.includes(k as keyof ModuleFlags)])) as ModuleFlags;
    const gated = FEATURES.filter((f) => f.module && AGGREGATOR_PERIMETER_OFF.includes(f.module));
    for (const f of gated) {
      const a = featureAvailability(f, perimeter);
      expect(a.state, `${f.key}`).toBe('awaiting_authorisation');
      expect(a.label).not.toMatch(/^Available$/);
      expect(a.note).toMatch(/authorisation/i);
    }
    for (const f of FEATURES.filter((x) => x.module && AGGREGATOR_PERIMETER_ON.includes(x.module))) {
      expect(featureAvailability(f, perimeter).state, `${f.key}`).toBe('available');
    }
  });

  it('separates a module an administrator switched off from one waiting on an authorisation', () => {
    const allOn = { ...DEFAULT_MODULES, corridorNetwork: true } as ModuleFlags;
    const qr = FEATURES.find((f) => f.module === 'qrPayments')!;
    expect(featureAvailability(qr, allOn).state).toBe('available');
    expect(featureAvailability(qr, { ...allOn, qrPayments: false }).state).toBe('switched_off');
  });

  it('treats the platform’s own machinery as always present', () => {
    for (const f of FEATURES.filter((x) => x.module === null)) {
      expect(featureAvailability(f, { ...DEFAULT_MODULES } as ModuleFlags).state).toBe('available');
    }
  });
});

describe('feature pages', () => {
  it('renders the hub with every feature and a link to each page', () => {
    const html = featuresIndexPage();
    for (const f of FEATURES) {
      expect(html).toContain(`/features/${f.slug}`);
      expect(html).toContain(f.name);
    }
    expect(FEATURE_PATHS()).toHaveLength(FEATURES.length + 1);
  });

  it('renders a feature page carrying its selling point, proof, price and questions, and nothing for an unknown slug', () => {
    const f = FEATURE_BY_SLUG['qr-code-payments'];
    const html = featurePage(f.slug)!;
    expect(html).toBeTruthy();
    expect(html).toContain(f.usp.slice(0, 40));
    for (const p of f.proof) expect(html).toContain(p.slice(0, 40));
    expect(html).toContain('FAQPage');
    expect(featurePage('not-a-feature')).toBeNull();
  });

  it('answers on the site, and the hub is never cached into a stale availability claim', async () => {
    const hub = await request(app).get('/features');
    expect(hub.status).toBe(200);
    expect(hub.headers['cache-control']).toMatch(/no-store/);
    const detail = await request(app).get('/features/payment-links');
    expect(detail.status).toBe(200);
    expect(detail.text).toContain('Payment links');
    const missing = await request(app).get('/features/nothing-here');
    expect(missing.status).toBe(404);
  });

  it('lists every feature page in the sitemap', async () => {
    const res = await request(app).get('/sitemap.xml');
    expect(res.status).toBe(200);
    for (const path of FEATURE_PATHS()) expect(res.text).toContain(`${path}</loc>`);
  });
});

describe('feature articles', () => {
  it('writes one article per feature, with the proof, the price and a link to the live availability', () => {
    const articles = featureArticles();
    expect(articles).toHaveLength(FEATURES.length);
    for (const [i, a] of articles.entries()) {
      const f = FEATURES[i];
      expect(a.title).toBe(f.headline);
      expect(a.slug).toBe(`${f.slug}-explained`);
      expect(a.bodyMd).toContain(f.cost);
      for (const p of f.proof) expect(a.bodyMd).toContain(p);
      expect(a.bodyMd).toContain(`/features/${f.slug}`);
      expect(a.faq).toEqual(f.faq);
      expect((a.metaDescription ?? '').length).toBeLessThanOrEqual(155);
      expect((a.metaTitle ?? '').length).toBeLessThanOrEqual(60);
    }
  });

  it('seeds every feature article as published, without disturbing the launch articles', async () => {
    await adminToken(app); // the app is booted, so content seeding has run
    const posts = listPosts({ status: 'all', pageSize: 200 }).items;
    const slugs = new Set(posts.map((p) => p.slug));
    for (const a of featureArticles()) expect(slugs.has(a.slug!), a.slug!).toBe(true);
    // The original launch articles are still there.
    expect(slugs.has('get-paid-by-qr-code-at-the-market')).toBe(true);
  });

  it('seeds once: re-running the seed from scratch duplicates nothing', async () => {
    const { _resetDefaultContentForTests, ensureDefaultContent } = await import('../content/defaults');
    const { setSetting } = await import('../services/settings');
    const before = listPosts({ status: 'all', pageSize: 200 }).total;
    // Clear both guards — the once-per-process flag and the stored content version — so the slug check is what is
    // actually being tested, rather than the version gate quietly skipping the work.
    _resetDefaultContentForTests();
    setSetting('content.version', 0);
    const again = ensureDefaultContent();
    expect(again.posts).toBe(0);
    expect(listPosts({ status: 'all', pageSize: 200 }).total).toBe(before);
  });

  it('is reachable on the blog', async () => {
    const res = await request(app).get('/blog/payment-links-explained');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Get paid in the chat where the sale happened');
  });
});
