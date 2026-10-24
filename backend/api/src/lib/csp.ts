/**
 * The Content-Security-Policy for everything this API serves.
 *
 * The platform renders real HTML from the server — the blog (whose body is administrator-authored markdown), the
 * feature pages, the legal pages, BitriPay Lite and the API reference. Output is escaped and markdown is sanitised,
 * and there is a test that injects script into a post and proves it does not come back. This header is the layer
 * underneath that one: it is what still refuses when an escaping bug eventually gets through, which is the only
 * assumption about sanitisers worth making.
 *
 * `script-src 'self'` carries most of the value, and it is only honest because no page inlines executable script:
 * the layout's one inline block is `application/ld+json`, which is data a browser never executes, and the reference
 * page's filter is served from `/v1/docs/reference.js`. An injected `<script>` therefore has nowhere to run.
 *
 * `style-src` still allows inline. The server-rendered pages ship their stylesheet in a `<style>` block and use a
 * handful of `style` attributes, so removing it would mean refactoring four files for a markedly smaller gain than
 * the script rule. It is stated here rather than left implicit.
 *
 * Framing is per path. Hosted checkout exists to be embedded in a merchant's own page by `@bitripay/checkout-js`,
 * so it must be framable cross-origin; everything else must not be.
 */
import type { Request } from 'express';

/** Paths that exist to be embedded in somebody else's site. */
export const EMBEDDABLE_PATHS = ['/checkout'];

export const isEmbeddablePath = (path: string): boolean => EMBEDDABLE_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

export function contentSecurityPolicy(req: Pick<Request, 'path'>, { production }: { production: boolean }): string {
  const directives: string[] = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self'",
    // A payment page a merchant chose to embed has to be framable by that merchant; nothing else here does.
    isEmbeddablePath(req.path) ? 'frame-ancestors https:' : "frame-ancestors 'self'",
  ];
  // Only in production: on a development host the pages are served over http and this would break every asset.
  if (production) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}
