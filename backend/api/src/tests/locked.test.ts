/**
 * The invariants nothing else guards.
 *
 * Most of the work on this platform defends itself: the feature catalogue, the Content-Security-Policy, the Node
 * floor, the module switches and the credential inventory each have their own suite, and this file deliberately does
 * not repeat them. What it covers is the gap those leave — facts that live in deployment files and dependency
 * ranges, where a revert passes every other test in the repository.
 *
 * The one that matters most is hosted checkout's framing. `@bitripay/checkout-js` mounts the payment page in an
 * iframe on a merchant's own site, and for a long time that could not work: the edge set `X-Frame-Options:
 * SAMEORIGIN` on the host serving `/checkout`, so browsers refused the frame before it rendered. Nothing caught it,
 * because the SDK's unit tests only exercise the pure URL and message helpers and never load a page, and the API's
 * own CSP tests cannot see it either — in production that page is static files served by the web image behind a
 * proxy, so the API never touches the response. Deleting four lines from a config file would silently restore the
 * defect with 451 green tests behind it. These assertions are what stand in the way.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../../..');
const read = (p: string): string => fs.readFileSync(path.join(repoRoot, p), 'utf8');

/** Numeric compare, so 10.2.1 is correctly newer than 10.11.0 is not, and 4.9.0 is older than 4.10.0. */
function atLeast(actual: string, floor: string): boolean {
  const a = actual
    .replace(/^[^0-9]*/, '')
    .split('.')
    .map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

describe('locked: hosted checkout stays framable by a merchant', () => {
  it('the dedicated edge drops X-Frame-Options for /checkout and states the framing rule instead', () => {
    const caddy = read('deploy/Caddyfile');
    // The path matcher and its handler: without both, the exception does not apply to the checkout page.
    expect(caddy, 'deploy/Caddyfile must match the checkout path').toMatch(/@checkout\s+path\s+\/checkout\s+\/checkout\/\*/);
    const block = caddy.slice(caddy.indexOf('handle @checkout'), caddy.indexOf('handle @checkout') + 400);
    expect(block, 'the checkout handler must remove X-Frame-Options').toMatch(/header\s+-X-Frame-Options/);
    expect(block, 'and state frame-ancestors, which X-Frame-Options cannot express').toMatch(/frame-ancestors https:/);
    // The site-wide SAMEORIGIN must still be there: the exception is for one path, not a relaxation of the site.
    expect(caddy).toMatch(/X-Frame-Options SAMEORIGIN/);
    expect(caddy).toMatch(/X-Frame-Options DENY/);
  });

  it('the web image does the same, because it is what actually serves the page in every deployment', () => {
    // www proxies to this image in all four shapes (dedicated Caddy, the two shared-host Caddy snippets, and the
    // host-level nginx/apache), so the image is where the rule has to live to hold everywhere.
    const nginx = read('frontend/web/nginx.conf');
    const loc = nginx.match(/location\s+~\s+"\^\/checkout\([^"]*"\s*\{[^}]*\}/);
    expect(loc, 'frontend/web/nginx.conf must have a /checkout location').toBeTruthy();
    expect(loc![0], 'it must clear X-Frame-Options').toMatch(/add_header\s+X-Frame-Options\s+""/);
    expect(loc![0], 'and set frame-ancestors').toMatch(/frame-ancestors https:/);
  });

  it('no deployment config re-imposes same-origin framing on the host that serves checkout', () => {
    // The pattern sweep, kept. X-Frame-Options is correct on the admin console and on the API; it is wrong on the
    // host that serves /checkout. These files split cleanly on their host blocks, so the check stays readable.
    for (const file of ['deploy/shared-host/Caddyfile.snippet', 'deploy/shared-host/Caddyfile.container.snippet']) {
      const text = read(file);
      const wwwStart = text.indexOf('www.');
      const adminStart = text.indexOf('admin.');
      expect(wwwStart, `${file} must configure the www host`).toBeGreaterThan(-1);
      const wwwBlock = adminStart > wwwStart ? text.slice(wwwStart, adminStart) : text.slice(wwwStart);
      expect(wwwBlock, `${file}: the www host must not set X-Frame-Options — it serves /checkout`).not.toMatch(/X-Frame-Options/i);
    }
    for (const file of ['deploy/shared-host/nginx-bitripay.conf', 'deploy/shared-host/apache-bitripay.conf']) {
      const text = read(file);
      const start = text.indexOf('www.bitripay.com');
      const next = text.indexOf('admin.bitripay.com');
      const wwwBlock = next > start ? text.slice(start, next) : text.slice(start);
      expect(wwwBlock, `${file}: the www host must not set X-Frame-Options — it serves /checkout`).not.toMatch(/X-Frame-Options/i);
    }
  });
});

describe('locked: the security-fixed dependencies cannot drift back', () => {
  // `npm audit --audit-level=high` is the CI gate and it catches a zod or body-parser regression, both of which are
  // high. The nodemailer advisories are *moderate*, so a downgrade into their range would pass that gate silently —
  // which is the whole reason this block exists rather than trusting the audit alone.
  const FLOORS: { name: string; floor: string; advisory: string }[] = [
    { name: 'zod', floor: '4.6.7', advisory: 'GHSA-mrhx-c7xc-m3w5 — memory exhaustion validating oversized constrained collections, in the library that validates every request' },
    { name: 'body-parser', floor: '2.4.0', advisory: 'denial of service via trailing bytes after a compressed request body, in the request path' },
    { name: 'nodemailer', floor: '10.2.1', advisory: 'addressparser bugs that can deliver mail to a domain the header does not name; this platform sends password resets' },
  ];

  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { version?: string }> };

  it.each(FLOORS)('$name resolves at or above $floor', ({ name, floor, advisory }) => {
    const installed = Object.entries(lock.packages)
      // knip is a devDependency with its own copy; the production tree is what the advisory applies to.
      .filter(([k]) => k.endsWith(`node_modules/${name}`) && !k.includes('knip'))
      .map(([, v]) => v.version)
      .filter((v): v is string => Boolean(v));
    expect(installed.length, `${name} must be in the lockfile`).toBeGreaterThan(0);
    for (const v of installed) expect(atLeast(v, floor), `${name}@${v} is below ${floor}: ${advisory}`).toBe(true);
  });

  it('the declared range excludes the vulnerable versions, not just the lockfile', () => {
    // A lockfile can be regenerated. If the range still admits a vulnerable version, the fix survives only until
    // somebody runs `npm install` on a clean checkout, which is not a fix.
    const api = JSON.parse(read('backend/api/package.json')) as { dependencies: Record<string, string> };
    for (const { name, floor } of FLOORS) {
      const range = api.dependencies[name];
      if (!range) continue; // body-parser arrives through express and has no declared range here
      expect(atLeast(range, floor), `${name} is declared "${range}", which still allows versions below ${floor}`).toBe(true);
    }
  });

  it('compares versions numerically, so a double-digit patch is not read as older', () => {
    expect(atLeast('10.2.1', '10.2.1')).toBe(true);
    expect(atLeast('10.11.0', '10.2.1')).toBe(true);
    expect(atLeast('10.1.3', '10.2.1')).toBe(false);
    expect(atLeast('^10.2.1', '10.2.1')).toBe(true);
    expect(atLeast('3.25.76', '4.6.7')).toBe(false);
  });
});
