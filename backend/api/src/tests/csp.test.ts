/**
 * The Content-Security-Policy, and the one path that is deliberately framable.
 *
 * The embed case is the reason these tests exist. `@bitripay/checkout-js` mounts hosted checkout in an iframe on a
 * merchant's own site, and its unit tests only exercise the pure URL and message helpers — nothing in the suite ever
 * loaded the page, so nothing noticed that a same-origin framing header made every cross-origin embed refuse to
 * render. These assert the header, not the helper.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { contentSecurityPolicy, isEmbeddablePath } from '../lib/csp';

const app = createApp();
const directives = (header: string) =>
  new Map(
    header
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.split(/\s+/)[0], d]),
  );

describe('content security policy', () => {
  it('is sent on server-rendered pages and refuses inline script outright', async () => {
    const res = await request(app).get('/blog');
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp, 'every HTML response carries a policy').toBeTruthy();
    const d = directives(csp);
    // The directive that does the work: an injected <script> has nowhere to run, inline or sourced elsewhere.
    expect(d.get('script-src')).toBe("script-src 'self'");
    expect(d.get('object-src')).toBe("object-src 'none'");
    expect(d.get('base-uri')).toBe("base-uri 'self'");
    expect(d.get('form-action')).toBe("form-action 'self'");
    expect(d.get('default-src')).toBe("default-src 'self'");
  });

  it('allows the fonts the pages actually load and nothing else', () => {
    const csp = contentSecurityPolicy({ path: '/blog' }, { production: true });
    const d = directives(csp);
    expect(d.get('style-src')).toContain('https://fonts.googleapis.com');
    expect(d.get('font-src')).toContain('https://fonts.gstatic.com');
    // The stylesheet ships in a <style> block, so inline style stays allowed; script does not.
    expect(d.get('style-src')).toContain("'unsafe-inline'");
    expect(d.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('lets a merchant frame hosted checkout, and nothing else on the site', async () => {
    expect(isEmbeddablePath('/checkout')).toBe(true);
    expect(isEmbeddablePath('/checkout/abc123')).toBe(true);
    expect(isEmbeddablePath('/checkouts')).toBe(false);
    expect(isEmbeddablePath('/blog')).toBe(false);

    const embeddable = await request(app).get('/checkout/some-code');
    expect(directives(embeddable.headers['content-security-policy']).get('frame-ancestors')).toBe('frame-ancestors https:');
    // X-Frame-Options cannot express "any https site", and a browser that sees both takes the stricter one, so the
    // older header has to be absent on this path or it silently cancels the policy above.
    expect(embeddable.headers['x-frame-options'], 'checkout must not carry X-Frame-Options').toBeUndefined();

    const ordinary = await request(app).get('/blog');
    expect(directives(ordinary.headers['content-security-policy']).get('frame-ancestors')).toBe("frame-ancestors 'self'");
    expect(ordinary.headers['x-frame-options']).toBe('SAMEORIGIN');
    const api = await request(app).get('/api/health');
    expect(api.headers['x-frame-options']).toBe('DENY');
  });

  it('upgrades insecure requests only in production, so a development host still serves its assets over http', () => {
    expect(contentSecurityPolicy({ path: '/blog' }, { production: true })).toContain('upgrade-insecure-requests');
    expect(contentSecurityPolicy({ path: '/blog' }, { production: false })).not.toContain('upgrade-insecure-requests');
  });

  it('serves the reference page filter as a file, because the policy forbids inlining it', async () => {
    const js = await request(app).get('/v1/docs/reference.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.text).toContain('ref-filter');
    const page = await request(app).get('/v1/docs');
    expect(page.text).toContain('src="/v1/docs/reference.js"');
    // Only the JSON-LD data block may remain inline; a browser never executes it.
    const inline = [...page.text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].map((m) => m[0]);
    expect(
      inline.every((tag) => tag.includes('application/ld+json')),
      `unexpected inline script: ${inline.join(', ')}`,
    ).toBe(true);
  });
});
