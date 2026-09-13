/**
 * SEO engine: site settings, dynamic hyperlinks (keyword → URL rules applied at render time), backlink registry
 * (inbound links discovered from referrers, outbound citations and partner links), structured data (JSON-LD),
 * sitemap / RSS / robots / llms.txt generation, IndexNow pings and page-view counters.
 * Everything here renders server-side so search engines, social crawlers and AI answer engines see complete HTML.
 */
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { badRequest } from '../lib/errors';
import { config } from '../config';
import { getSeoSettings, getSiteSettingsSafe, type SeoSettings } from './settings';
import { escapeHtml } from './markdown';
import { recordEvent } from './events';

export function siteUrl(): string {
  const s = getSeoSettings();
  return (s.siteUrl || config.webUrl).replace(/\/+$/, '');
}
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${siteUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}
export function pageTitle(title?: string | null): string {
  const s = getSeoSettings();
  return title ? `${title}${s.titleSuffix}` : s.defaultTitle;
}

// ---------------------------------------------------------------------------------------------
// Dynamic hyperlinks
// ---------------------------------------------------------------------------------------------
export interface LinkRule {
  id: string;
  keyword: string;
  url: string;
  title: string | null;
  kind: 'internal' | 'outbound';
  maxPerPage: number;
  priority: number;
  enabled: boolean;
  createdAt: string;
}
const toRule = (r: any): LinkRule => ({ id: r.id, keyword: r.keyword, url: r.url, title: r.title, kind: r.kind, maxPerPage: r.max_per_page, priority: r.priority, enabled: !!r.enabled, createdAt: r.created_at });

export function listLinkRules(enabledOnly = false): LinkRule[] {
  return (getDb().prepare(`SELECT * FROM seo_link_rules ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY priority DESC, length(keyword) DESC`).all() as any[]).map(toRule);
}
export function upsertLinkRule(input: { id?: string; keyword: string; url: string; title?: string | null; kind?: 'internal' | 'outbound'; maxPerPage?: number; priority?: number; enabled?: boolean }): LinkRule {
  const keyword = input.keyword.trim();
  if (keyword.length < 2) throw badRequest('Keyword must be at least 2 characters');
  if (!/^(\/|https?:\/\/)/.test(input.url)) throw badRequest('URL must be absolute or start with /');
  const id = input.id ?? (getDb().prepare('SELECT id FROM seo_link_rules WHERE lower(keyword) = lower(?)').get(keyword) as any)?.id ?? uuid();
  getDb().prepare(`INSERT INTO seo_link_rules (id, keyword, url, title, kind, max_per_page, priority, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET keyword = excluded.keyword, url = excluded.url, title = excluded.title, kind = excluded.kind, max_per_page = excluded.max_per_page, priority = excluded.priority, enabled = excluded.enabled`)
    .run(id, keyword, input.url, input.title ?? null, input.kind ?? (/^https?:/.test(input.url) ? 'outbound' : 'internal'), input.maxPerPage ?? 1, input.priority ?? 50, input.enabled === false ? 0 : 1, now());
  return toRule(getDb().prepare('SELECT * FROM seo_link_rules WHERE id = ?').get(id));
}
export function deleteLinkRule(id: string) {
  getDb().prepare('DELETE FROM seo_link_rules WHERE id = ?').run(id);
}

/**
 * Apply link rules to rendered HTML: the first `maxPerPage` occurrences of each keyword in text nodes become links.
 * Text inside existing links, headings, code and the post's own URL are left alone.
 */
export function applyDynamicLinks(html: string, opts: { currentPath?: string | null; rules?: LinkRule[]; extra?: LinkRule[] } = {}): { html: string; applied: { keyword: string; url: string }[] } {
  const rules = [...(opts.rules ?? listLinkRules(true)), ...(opts.extra ?? [])].filter((r) => !opts.currentPath || r.url !== opts.currentPath);
  if (!rules.length) return { html, applied: [] };
  const applied: { keyword: string; url: string }[] = [];
  const counts = new Map<string, number>();
  // Split into protected segments (tags we must not link inside) and linkable text.
  const parts = html.split(/(<a\b[\s\S]*?<\/a>|<h[1-6]\b[\s\S]*?<\/h[1-6]>|<code\b[\s\S]*?<\/code>|<pre\b[\s\S]*?<\/pre>|<[^>]+>)/g);
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg || seg.startsWith('<')) continue;
    let text = seg;
    for (const rule of rules) {
      const used = counts.get(rule.id) ?? 0;
      if (used >= rule.maxPerPage) continue;
      const re = new RegExp(`(^|[^\\w/-])(${escapeRe(rule.keyword)})(?=$|[^\\w-])`, 'i');
      const m = re.exec(text);
      if (!m) continue;
      const external = rule.kind === 'outbound';
      const anchor = `<a href="${escapeHtml(rule.url)}"${rule.title ? ` title="${escapeHtml(rule.title)}"` : ''}${external ? ' rel="noopener" target="_blank"' : ''} data-autolink="1">${m[2]}</a>`;
      text = text.slice(0, m.index) + m[1] + anchor + text.slice(m.index + m[0].length);
      counts.set(rule.id, used + 1);
      applied.push({ keyword: rule.keyword, url: rule.url });
    }
    parts[i] = text;
  }
  return { html: parts.join(''), applied };
}

// ---------------------------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------------------------
export interface Backlink {
  id: string;
  direction: 'inbound' | 'outbound' | 'partner';
  sourceUrl: string;
  sourceDomain: string;
  targetUrl: string;
  anchor: string | null;
  status: 'live' | 'pending' | 'lost' | 'rejected';
  hits: number;
  nofollow: boolean;
  notes: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}
const toBacklink = (r: any): Backlink => ({ id: r.id, direction: r.direction, sourceUrl: r.source_url, sourceDomain: r.source_domain, targetUrl: r.target_url, anchor: r.anchor, status: r.status, hits: r.hits, nofollow: !!r.nofollow, notes: r.notes, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at });

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}
const IGNORED_REFERRER_HOSTS = new Set(['localhost', '127.0.0.1', 'google.com', 'bing.com', 'duckduckgo.com', 'yahoo.com', 'baidu.com', 'yandex.ru', 'facebook.com', 't.co', 'twitter.com', 'x.com', 'linkedin.com', 'instagram.com', 'youtube.com', 'chatgpt.com', 'perplexity.ai', 'claude.ai']);

/** Called from the referrer middleware: a visit that arrived from another site counts as a live inbound backlink. */
export function recordReferrer(referrer: string | undefined, targetPath: string): Backlink | null {
  if (!referrer) return null;
  const domain = domainOf(referrer);
  if (!domain) return null;
  const own = domainOf(siteUrl());
  if (own && (domain === own || domain.endsWith(`.${own}`))) return null;
  if (IGNORED_REFERRER_HOSTS.has(domain)) {
    bumpPageview(targetPath);
    return null;
  }
  const target = absoluteUrl(targetPath);
  const db = getDb();
  const existing = db.prepare("SELECT id FROM seo_backlinks WHERE direction = 'inbound' AND source_url = ? AND target_url = ?").get(referrer, target) as any;
  if (existing) {
    db.prepare("UPDATE seo_backlinks SET hits = hits + 1, last_seen_at = ?, status = CASE WHEN status = 'lost' THEN 'live' ELSE status END WHERE id = ?").run(now(), existing.id);
    return toBacklink(db.prepare('SELECT * FROM seo_backlinks WHERE id = ?').get(existing.id));
  }
  const id = uuid();
  db.prepare("INSERT INTO seo_backlinks (id, direction, source_url, source_domain, target_url, anchor, status, hits, nofollow, notes, first_seen_at, last_seen_at) VALUES (?, 'inbound', ?, ?, ?, NULL, 'live', 1, 0, 'Discovered from referrer', ?, ?)").run(id, referrer.slice(0, 500), domain, target, now(), now());
  recordEvent('admin', id, 'seo.backlink.discovered', { type: 'system' }, { sourceDomain: domain, target });
  return toBacklink(db.prepare('SELECT * FROM seo_backlinks WHERE id = ?').get(id));
}

export function listBacklinks(filter: { direction?: string | null; status?: string | null } = {}): Backlink[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.direction) { where.push('direction = ?'); params.push(filter.direction); }
  if (filter.status) { where.push('status = ?'); params.push(filter.status); }
  return (getDb().prepare(`SELECT * FROM seo_backlinks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_seen_at DESC LIMIT 500`).all(...params) as any[]).map(toBacklink);
}
export function upsertBacklink(input: { id?: string; direction: 'inbound' | 'outbound' | 'partner'; sourceUrl: string; targetUrl: string; anchor?: string | null; status?: Backlink['status']; nofollow?: boolean; notes?: string | null }): Backlink {
  const domain = domainOf(input.sourceUrl);
  if (!domain) throw badRequest('Source must be a full URL');
  const db = getDb();
  const id = input.id ?? (db.prepare('SELECT id FROM seo_backlinks WHERE direction = ? AND source_url = ? AND target_url = ?').get(input.direction, input.sourceUrl, input.targetUrl) as any)?.id ?? uuid();
  db.prepare(`INSERT INTO seo_backlinks (id, direction, source_url, source_domain, target_url, anchor, status, hits, nofollow, notes, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET direction = excluded.direction, source_url = excluded.source_url, source_domain = excluded.source_domain, target_url = excluded.target_url, anchor = excluded.anchor, status = excluded.status, nofollow = excluded.nofollow, notes = excluded.notes, last_seen_at = excluded.last_seen_at`)
    .run(id, input.direction, input.sourceUrl, domain, input.targetUrl, input.anchor ?? null, input.status ?? 'live', input.nofollow ? 1 : 0, input.notes ?? null, now(), now());
  return toBacklink(db.prepare('SELECT * FROM seo_backlinks WHERE id = ?').get(id));
}
export function deleteBacklink(id: string) {
  getDb().prepare('DELETE FROM seo_backlinks WHERE id = ?').run(id);
}

/** Re-verify partner / outbound links still resolve (HEAD request); inbound links not seen for 60 days are marked lost. */
export async function verifyBacklinks(): Promise<{ checked: number; lost: number }> {
  const db = getDb();
  const stale = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const lostInbound = db.prepare("UPDATE seo_backlinks SET status = 'lost' WHERE direction = 'inbound' AND status = 'live' AND last_seen_at < ?").run(stale).changes;
  let checked = 0;
  let lost = lostInbound;
  for (const b of listBacklinks({ direction: 'partner' })) {
    checked++;
    try {
      const res = await fetch(b.sourceUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
      db.prepare('UPDATE seo_backlinks SET status = ?, last_seen_at = ? WHERE id = ?').run(res.ok ? 'live' : 'lost', now(), b.id);
      if (!res.ok) lost++;
    } catch {
      /* network unavailable: leave the status untouched */
    }
  }
  return { checked, lost };
}

// ---------------------------------------------------------------------------------------------
// Page views
// ---------------------------------------------------------------------------------------------
export function bumpPageview(path: string) {
  const day = new Date().toISOString().slice(0, 10);
  getDb().prepare('INSERT INTO seo_pageviews (day, path, views) VALUES (?, ?, 1) ON CONFLICT(day, path) DO UPDATE SET views = views + 1').run(day, path.slice(0, 200));
}
export function pageviewSummary(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const byPath = getDb().prepare('SELECT path, SUM(views) views FROM seo_pageviews WHERE day >= ? GROUP BY path ORDER BY views DESC LIMIT 50').all(since) as { path: string; views: number }[];
  const byDay = getDb().prepare('SELECT day, SUM(views) views FROM seo_pageviews WHERE day >= ? GROUP BY day ORDER BY day ASC').all(since) as { day: string; views: number }[];
  return { byPath, byDay, total: byPath.reduce((s, r) => s + r.views, 0) };
}

// ---------------------------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------------------------
export function organizationJsonLd() {
  const s = getSeoSettings();
  const site = getSiteSettingsSafe();
  return {
    '@context': 'https://schema.org',
    '@type': 'FinancialService',
    '@id': `${siteUrl()}/#organization`,
    name: s.siteName,
    legalName: s.organization.legalName || s.siteName,
    url: siteUrl(),
    logo: site?.logoUrl ? absoluteUrl(site.logoUrl) : `${siteUrl()}/favicon.svg`,
    description: s.defaultDescription,
    email: s.organization.email || undefined,
    telephone: s.organization.phone || undefined,
    address: s.organization.address ? { '@type': 'PostalAddress', streetAddress: s.organization.address } : undefined,
    areaServed: getSeoSettings().agent.markets.map((c) => ({ '@type': 'Country', name: c })),
    sameAs: s.organization.sameAs.filter(Boolean),
    serviceType: ['Mobile money transfer', 'QR code payments', 'Virtual cards', 'International remittance', 'Merchant payment gateway'],
  };
}
export function websiteJsonLd() {
  const s = getSeoSettings();
  return { '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${siteUrl()}/#website`, url: siteUrl(), name: s.siteName, inLanguage: s.languages, publisher: { '@id': `${siteUrl()}/#organization` }, potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${siteUrl()}/blog?q={search_term_string}` }, 'query-input': 'required name=search_term_string' } };
}
export function breadcrumbJsonLd(items: { name: string; url: string }[]) {
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: absoluteUrl(it.url) })) };
}
export function faqJsonLd(faq: { question: string; answer: string }[]) {
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.question, acceptedAnswer: { '@type': 'Answer', text: f.answer } })) };
}

// ---------------------------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------------------------
export interface SitemapEntry {
  path: string;
  lastmod?: string | null;
  changefreq?: string;
  priority?: number;
}
export function sitemapXml(entries: SitemapEntry[]): string {
  const s = getSeoSettings();
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries
    .map((e) => `  <url><loc>${escapeHtml(absoluteUrl(e.path))}</loc>${e.lastmod ? `<lastmod>${e.lastmod.slice(0, 10)}</lastmod>` : ''}<changefreq>${e.changefreq ?? 'weekly'}</changefreq><priority>${(e.priority ?? 0.6).toFixed(1)}</priority>${s.languages.length > 1 ? s.languages.map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${escapeHtml(absoluteUrl(e.path))}${e.path.includes('?') ? '&' : '?'}lang=${l}"/>`).join('') : ''}</url>`)
    .join('\n')}\n</urlset>\n`;
}
export function robotsTxt(): string {
  const key = getSeoSettings().indexNowKey;
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /app/',
    'Disallow: /api/',
    'Disallow: /admin/',
    '',
    '# AI answer engines are welcome to read the public site, the blog and llms.txt.',
    'User-agent: GPTBot',
    'Allow: /',
    'User-agent: ClaudeBot',
    'Allow: /',
    'User-agent: PerplexityBot',
    'Allow: /',
    'User-agent: Google-Extended',
    'Allow: /',
    '',
    `Sitemap: ${absoluteUrl('/sitemap.xml')}`,
    key ? `# IndexNow key: ${absoluteUrl(`/${key}.txt`)}` : '',
  ].join('\n') + '\n';
}

/** Ping IndexNow (Bing, Yandex, Seznam, Naver share one endpoint) with changed URLs; best-effort. */
export async function pingIndexNow(paths: string[]): Promise<{ ok: boolean; status?: number; reason?: string }> {
  const key = getSeoSettings().indexNowKey;
  if (!key) return { ok: false, reason: 'no IndexNow key configured' };
  if (config.isTest) return { ok: true, reason: 'test' };
  try {
    const host = new URL(siteUrl()).host;
    const res = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ host, key, keyLocation: absoluteUrl(`/${key}.txt`), urlList: paths.map(absoluteUrl) }), signal: AbortSignal.timeout(8000) });
    return { ok: res.status < 300, status: res.status };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export type { SeoSettings };
