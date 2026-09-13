/** Blog + SEO engine: server-rendered pages with structured data, dynamic links, backlinks, feeds, the content agent (fallback mode) and admin editing. */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, adminToken } from './helpers';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('public site', () => {
  it('serves the blog, articles, legal pages, feeds and llms.txt as complete HTML with JSON-LD and dynamic links', async () => {
    const index = await request(app).get('/blog');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.text).toContain('get-paid-by-qr-code-at-the-market');
    expect(index.text).toContain('"@type":"Blog"');
    const post = await request(app).get('/blog/get-paid-by-qr-code-at-the-market');
    expect(post.status).toBe(200);
    expect(post.text).toContain('<link rel="canonical"');
    expect(post.text).toContain('"@type":"Article"');
    expect(post.text).toContain('"@type":"FAQPage"');
    expect(post.text).toContain('property="og:type" content="article"');
    expect(post.text).toContain('data-autolink="1"'); // dynamic hyperlink applied
    expect(post.text).toContain('href="/app/agents"'); // the "agent" link rule
    expect(post.text).toContain('Keep reading'); // related posts
    expect(post.text).toContain('href="/legal/privacy"'); // footer policies
    const missing = await request(app).get('/blog/does-not-exist');
    expect(missing.status).toBe(404);
    for (const path of ['/legal/privacy', '/legal/terms', '/legal/safeguarding', '/legal/complaints', '/legal/accessibility', '/about', '/contact']) {
      const r = await request(app).get(path);
      expect(r.status, path).toBe(200);
      expect(r.text).toContain('<h1>');
    }
    const about = await request(app).get('/about');
    expect(about.text).toContain('moto-taxi rider');
    expect(about.text).toContain('"@type":"AboutPage"');
    const sitemap = await request(app).get('/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(sitemap.text).toContain('/blog/sending-money-uk-to-congo-costs-speed-safety');
    expect(sitemap.text).toContain('/legal/privacy');
    const robots = await request(app).get('/robots.txt');
    expect(robots.text).toContain('Sitemap:');
    expect(robots.text).toContain('GPTBot');
    const feed = await request(app).get('/feed.xml');
    expect(feed.headers['content-type']).toContain('rss');
    expect(feed.text).toContain('<item>');
    const llms = await request(app).get('/llms.txt');
    expect(llms.text).toContain('# BitriPay');
    expect(llms.text).toContain('/blog/');
    const full = await request(app).get('/llms-full.txt');
    expect(full.text.length).toBeGreaterThan(llms.text.length);
    const json = await request(app).get('/api/blog?tag=agents');
    expect(json.body.items.length).toBeGreaterThan(0);
    expect(json.body.tags.length).toBeGreaterThan(0);
    const one = await request(app).get('/api/blog/virtual-cards-online-shopping-without-bank-card');
    expect(one.body.post.html).toContain('<h2');
    expect(one.body.post.jsonLd.length).toBeGreaterThan(1);
  });

  it('discovers inbound backlinks from referrers and counts page views', async () => {
    await request(app).get('/blog/what-safeguarding-means-for-your-balance').set('Referer', 'https://example-partner.org/resources/wallets');
    await request(app).get('/blog/what-safeguarding-means-for-your-balance').set('Referer', 'https://example-partner.org/resources/wallets');
    await request(app).get('/blog').set('Referer', 'https://www.google.com/');
    const admin = await adminToken(app);
    const seo = await request(app).get('/api/admin/seo').set(admin.auth);
    expect(seo.status).toBe(200);
    const link = seo.body.backlinks.find((b: any) => b.sourceDomain === 'example-partner.org');
    expect(link.direction).toBe('inbound');
    expect(link.hits).toBe(2);
    expect(seo.body.backlinks.some((b: any) => b.sourceDomain === 'google.com')).toBe(false);
    expect(seo.body.views.total).toBeGreaterThan(0);
  });
});

describe('content agent and editing', () => {
  it('drafts an article for review (offline template without an API key), proposes keywords, audits and writes a social pack', async () => {
    const admin = await adminToken(app);
    const status = await request(app).get('/api/admin/seo').set(admin.auth);
    expect(status.body.agent.mode).toBe('fallback');
    expect(status.body.agent.keyConfigured).toBe(false);
    const draft = await request(app)
      .post('/api/admin/seo/agent/draft')
      .set(admin.auth)
      .send({ topic: 'How to pay school fees with mobile money', keywords: ['pay school fees mobile money', 'school fees payment app'] });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.post.status).toBe('review'); // never auto-published
    expect(draft.body.post.source).toBe('agent');
    expect(draft.body.run.status).toBe('fallback');
    expect(draft.body.run.error).toContain('No Anthropic API key');
    // not public until an editor publishes it
    const hidden = await request(app).get(`/blog/${draft.body.post.slug}`);
    expect(hidden.status).toBe(404);
    const kw = await request(app).post('/api/admin/seo/agent/keywords').set(admin.auth).send({ seed: 'school fees' });
    expect(kw.body.ideas.length).toBeGreaterThan(5);
    const audit = await request(app).post(`/api/admin/seo/agent/audit/${draft.body.post.id}`).set(admin.auth);
    expect(audit.body.audit.score).toBeGreaterThan(0);
    expect(Array.isArray(audit.body.audit.issues)).toBe(true);
    const social = await request(app).post(`/api/admin/seo/agent/social/${draft.body.post.id}`).set(admin.auth);
    expect(social.body.social.whatsapp).toContain(draft.body.post.slug);
    // editor publishes; the article is now served, and its keywords become dynamic links from other posts
    const pub = await request(app)
      .patch(`/api/admin/blog/posts/${draft.body.post.id}`)
      .set(admin.auth)
      .send({ status: 'published', metaDescription: 'Pay school fees from your phone with mobile money: steps, fees and what to check before you send.' });
    expect(pub.status).toBe(200);
    const live = await request(app).get(`/blog/${draft.body.post.slug}`);
    expect(live.status).toBe(200);
    expect(live.text).toContain('offline mode'); // the fallback draft is labelled for the editor
    const runs = await request(app).get('/api/admin/seo').set(admin.auth);
    expect(runs.body.runs.map((r: any) => r.task)).toEqual(expect.arrayContaining(['draft_article', 'keyword_ideas', 'audit_post', 'social_pack']));
  });

  it('lets editors create posts, manage link rules and register partner backlinks', async () => {
    const admin = await adminToken(app);
    const created = await request(app)
      .post('/api/admin/blog/posts')
      .set(admin.auth)
      .send({
        title: 'Airtime top-up from your wallet',
        bodyMd: '## Why\n\nBuy airtime for any network from your balance, with fees shown first.\n\n## How\n\n1. Open Services.\n2. Choose Mobile top-up.',
        tags: ['airtime'],
        keywords: ['buy airtime from wallet'],
        status: 'published',
      });
    expect(created.status).toBe(201);
    const rule = await request(app)
      .put('/api/admin/seo/rules/new')
      .set(admin.auth)
      .send({ keyword: 'airtime', url: `/blog/${created.body.post.slug}`, title: 'Airtime top-up guide' });
    expect(rule.status).toBe(200);
    const page = await request(app).get('/blog/moto-taxi-riders-collect-fares-without-cash');
    expect(page.text).toContain(`href="/blog/${created.body.post.slug}"`);
    const bl = await request(app)
      .put('/api/admin/seo/backlinks/new')
      .set(admin.auth)
      .send({ direction: 'partner', sourceUrl: 'https://partner-directory.example/fintech', targetUrl: 'https://bitripay.app/', anchor: 'BitriPay', status: 'pending', notes: 'Listing requested' });
    expect(bl.status).toBe(200);
    expect(bl.body.backlink.sourceDomain).toBe('partner-directory.example');
    const settings = await request(app)
      .put('/api/admin/seo/settings')
      .set(admin.auth)
      .send({ indexNowKey: 'abc123def456', agent: { apiKey: 'sk-ant-test-key' } });
    expect(settings.status).toBe(200);
    expect(settings.body.settings.agent.apiKey).toBe('••••••••');
    expect(settings.body.agent.keyConfigured).toBe(true);
    const keyFile = await request(app).get('/abc123def456.txt');
    expect(keyFile.text.trim()).toBe('abc123def456');
    const del = await request(app).delete(`/api/admin/blog/posts/${created.body.post.id}`).set(admin.auth);
    expect(del.status).toBe(200);
  });
});
