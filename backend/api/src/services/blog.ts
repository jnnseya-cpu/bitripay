/**
 * Blog: posts written by the editorial team or drafted by the AI content agent, rendered server-side with dynamic
 * internal links, related articles, FAQ structured data and social snippets. Nothing is published without the
 * `published` status; agent drafts wait in review unless auto-publish is switched on.
 */
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { parseJson } from '../lib/json';
import { badRequest, conflict, notFound } from '../lib/errors';
import { renderMarkdown, readingMinutes, slugify, escapeHtml, type Heading } from './markdown';
import { applyDynamicLinks, listLinkRules, absoluteUrl, faqJsonLd, breadcrumbJsonLd, siteUrl, getSeoSettingsCached, type LinkRule } from './seoHelpers';
import { recordEvent, type Actor } from './events';

export type PostStatus = 'draft' | 'review' | 'scheduled' | 'published' | 'archived';
export interface PostSummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  coverUrl: string | null;
  coverAlt: string | null;
  category: string;
  tags: string[];
  keywords: string[];
  language: string;
  authorName: string;
  status: PostStatus;
  readingMinutes: number;
  source: string;
  views: number;
  publishedAt: string | null;
  scheduledFor: string | null;
  updatedAt: string;
  createdAt: string;
  url: string;
}
export interface Post extends PostSummary {
  bodyMd: string;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  faq: { question: string; answer: string }[];
  sources: { title: string; url: string }[];
  social: Record<string, string>;
  agentRunId: string | null;
}
export interface RenderedPost extends Post {
  html: string;
  headings: Heading[];
  plainText: string;
  appliedLinks: { keyword: string; url: string }[];
  related: PostSummary[];
  jsonLd: unknown[];
}

const summary = (r: any): PostSummary => ({ id: r.id, slug: r.slug, title: r.title, excerpt: r.excerpt, coverUrl: r.cover_url, coverAlt: r.cover_alt, category: r.category, tags: parseJson(r.tags, []), keywords: parseJson(r.keywords, []), language: r.language, authorName: r.author_name, status: r.status, readingMinutes: r.reading_minutes, source: r.source, views: r.views, publishedAt: r.published_at, scheduledFor: r.scheduled_for, updatedAt: r.updated_at, createdAt: r.created_at, url: `/blog/${r.slug}` });
const full = (r: any): Post => ({ ...summary(r), bodyMd: r.body_md, metaTitle: r.meta_title, metaDescription: r.meta_description, canonicalUrl: r.canonical_url, faq: parseJson(r.faq, []), sources: parseJson(r.sources, []), social: parseJson(r.social, {}), agentRunId: r.agent_run_id });

export function listPosts(opts: { status?: PostStatus | 'all'; tag?: string | null; category?: string | null; q?: string | null; language?: string | null; page?: number; pageSize?: number } = {}): { items: PostSummary[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  const status = opts.status ?? 'published';
  if (status !== 'all') { where.push('status = ?'); params.push(status); }
  if (status === 'published') { where.push('(published_at IS NULL OR published_at <= ?)'); params.push(now()); }
  if (opts.tag) { where.push("tags LIKE ?"); params.push(`%"${opts.tag}"%`); }
  if (opts.category) { where.push('category = ?'); params.push(opts.category); }
  if (opts.language) { where.push('language = ?'); params.push(opts.language); }
  if (opts.q) { where.push('(title LIKE ? OR excerpt LIKE ? OR body_md LIKE ?)'); params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`); }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, opts.pageSize ?? 12);
  const total = (getDb().prepare(`SELECT COUNT(*) c FROM blog_posts ${sql}`).get(...params) as any).c as number;
  const items = (getDb().prepare(`SELECT * FROM blog_posts ${sql} ORDER BY COALESCE(published_at, updated_at) DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as any[]).map(summary);
  return { items, total };
}
export function listTags(): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of getDb().prepare("SELECT tags FROM blog_posts WHERE status = 'published'").all() as { tags: string }[]) for (const t of parseJson<string[]>(r.tags, [])) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
}
export function getPost(idOrSlug: string, publishedOnly = true): Post {
  const r = getDb().prepare(`SELECT * FROM blog_posts WHERE (id = ? OR slug = ?)${publishedOnly ? " AND status = 'published' AND (published_at IS NULL OR published_at <= ?)" : ''}`).get(...(publishedOnly ? [idOrSlug, idOrSlug, now()] : [idOrSlug, idOrSlug]));
  if (!r) throw notFound('Article not found', 'post_not_found');
  return full(r);
}

export interface PostInput {
  title: string;
  slug?: string | null;
  excerpt?: string | null;
  bodyMd: string;
  coverUrl?: string | null;
  coverAlt?: string | null;
  category?: string | null;
  tags?: string[];
  keywords?: string[];
  language?: string | null;
  authorName?: string | null;
  authorUserId?: string | null;
  status?: PostStatus;
  metaTitle?: string | null;
  metaDescription?: string | null;
  canonicalUrl?: string | null;
  faq?: { question: string; answer: string }[];
  sources?: { title: string; url: string }[];
  social?: Record<string, string>;
  source?: string;
  agentRunId?: string | null;
  scheduledFor?: string | null;
  publishedAt?: string | null;
}

function uniqueSlug(base: string, exceptId?: string | null): string {
  let slug = slugify(base) || 'post';
  let n = 2;
  while (true) {
    const r = getDb().prepare('SELECT id FROM blog_posts WHERE slug = ?').get(slug) as any;
    if (!r || r.id === exceptId) return slug;
    slug = `${slugify(base)}-${n++}`;
  }
}

export function createPost(input: PostInput, actor: Actor): Post {
  if (!input.title?.trim()) throw badRequest('Title is required');
  if (!input.bodyMd?.trim()) throw badRequest('Body is required');
  const id = uuid();
  const slug = uniqueSlug(input.slug || input.title);
  const status: PostStatus = input.status ?? 'draft';
  const publishedAt = status === 'published' ? input.publishedAt ?? now() : input.publishedAt ?? null;
  getDb().prepare(`INSERT INTO blog_posts (id, slug, title, excerpt, body_md, cover_url, cover_alt, category, tags, keywords, language, author_name, author_user_id, status, meta_title, meta_description, canonical_url, faq, sources, social, reading_minutes, source, agent_run_id, views, published_at, scheduled_for, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
    .run(id, slug, input.title.trim(), (input.excerpt ?? '').trim() || autoExcerpt(input.bodyMd), input.bodyMd, input.coverUrl ?? null, input.coverAlt ?? null, input.category ?? 'guides', JSON.stringify(input.tags ?? []), JSON.stringify(input.keywords ?? []), input.language ?? 'en', input.authorName ?? 'BitriPay Editorial', input.authorUserId ?? null, status, input.metaTitle ?? null, input.metaDescription ?? null, input.canonicalUrl ?? null, JSON.stringify(input.faq ?? []), JSON.stringify(input.sources ?? []), JSON.stringify(input.social ?? {}), readingMinutes(input.bodyMd), input.source ?? 'manual', input.agentRunId ?? null, publishedAt, input.scheduledFor ?? null, now(), now());
  recordEvent('admin', id, 'blog.post.created', actor, { slug, status, source: input.source ?? 'manual' });
  return getPost(id, false);
}

export function updatePost(id: string, input: Partial<PostInput>, actor: Actor): Post {
  const existing = getPost(id, false);
  const fields: Record<string, unknown> = {};
  if (input.title !== undefined) fields.title = input.title.trim();
  if (input.slug !== undefined && input.slug) fields.slug = uniqueSlug(input.slug, id);
  if (input.excerpt !== undefined) fields.excerpt = input.excerpt ?? '';
  if (input.bodyMd !== undefined) { fields.body_md = input.bodyMd; fields.reading_minutes = readingMinutes(input.bodyMd); }
  if (input.coverUrl !== undefined) fields.cover_url = input.coverUrl;
  if (input.coverAlt !== undefined) fields.cover_alt = input.coverAlt;
  if (input.category !== undefined) fields.category = input.category ?? 'guides';
  if (input.tags !== undefined) fields.tags = JSON.stringify(input.tags ?? []);
  if (input.keywords !== undefined) fields.keywords = JSON.stringify(input.keywords ?? []);
  if (input.language !== undefined) fields.language = input.language ?? 'en';
  if (input.authorName !== undefined) fields.author_name = input.authorName ?? 'BitriPay Editorial';
  if (input.metaTitle !== undefined) fields.meta_title = input.metaTitle;
  if (input.metaDescription !== undefined) fields.meta_description = input.metaDescription;
  if (input.canonicalUrl !== undefined) fields.canonical_url = input.canonicalUrl;
  if (input.faq !== undefined) fields.faq = JSON.stringify(input.faq ?? []);
  if (input.sources !== undefined) fields.sources = JSON.stringify(input.sources ?? []);
  if (input.social !== undefined) fields.social = JSON.stringify(input.social ?? {});
  if (input.scheduledFor !== undefined) fields.scheduled_for = input.scheduledFor;
  if (input.status !== undefined) {
    fields.status = input.status;
    if (input.status === 'published' && !existing.publishedAt) fields.published_at = input.publishedAt ?? now();
    if (input.status === 'scheduled' && !input.scheduledFor && !existing.scheduledFor) throw badRequest('Choose a date to schedule the article');
  }
  if (input.publishedAt !== undefined) fields.published_at = input.publishedAt;
  const keys = Object.keys(fields);
  if (keys.length) getDb().prepare(`UPDATE blog_posts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), now(), id);
  recordEvent('admin', id, 'blog.post.updated', actor, { fields: keys });
  return getPost(id, false);
}
export function deletePost(id: string, actor: Actor) {
  getPost(id, false);
  getDb().prepare('DELETE FROM blog_posts WHERE id = ?').run(id);
  recordEvent('admin', id, 'blog.post.deleted', actor, {});
}
/** Scheduler: publish scheduled posts whose time has come. */
export function publishScheduled(): string[] {
  const rows = getDb().prepare("SELECT id, slug FROM blog_posts WHERE status = 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= ?").all(now()) as { id: string; slug: string }[];
  for (const r of rows) getDb().prepare("UPDATE blog_posts SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?").run(now(), now(), r.id);
  return rows.map((r) => `/blog/${r.slug}`);
}
export function bumpPostViews(id: string) {
  getDb().prepare('UPDATE blog_posts SET views = views + 1 WHERE id = ?').run(id);
}

function autoExcerpt(md: string): string {
  const text = renderMarkdown(md).text.replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177).replace(/\s+\S*$/, '')}…` : text;
}

/** Link rules derived from other published posts: their primary keywords link to them (dynamic cross-linking). */
function postLinkRules(excludeId: string): LinkRule[] {
  const rows = getDb().prepare("SELECT id, slug, title, keywords FROM blog_posts WHERE status = 'published' AND id != ?").all(excludeId) as any[];
  const rules: LinkRule[] = [];
  for (const r of rows) for (const k of parseJson<string[]>(r.keywords, []).slice(0, 3)) rules.push({ id: `post:${r.id}:${k}`, keyword: k, url: `/blog/${r.slug}`, title: r.title, kind: 'internal', maxPerPage: 1, priority: 30, enabled: true, createdAt: '' });
  return rules;
}

export function relatedPosts(post: Post, limit = 3): PostSummary[] {
  const rows = (getDb().prepare("SELECT * FROM blog_posts WHERE status = 'published' AND id != ? AND (published_at IS NULL OR published_at <= ?)").all(post.id, now()) as any[]).map(summary);
  const score = (p: PostSummary) => p.tags.filter((t) => post.tags.includes(t)).length * 2 + (p.category === post.category ? 1 : 0) + p.keywords.filter((k) => post.keywords.includes(k)).length;
  return rows.map((p) => ({ p, s: score(p) })).sort((a, b) => b.s - a.s || (b.p.publishedAt ?? '').localeCompare(a.p.publishedAt ?? '')).slice(0, limit).map((x) => x.p);
}

/** Full render: HTML with dynamic links, table of contents, related posts and JSON-LD. */
export function renderPost(idOrSlug: string, publishedOnly = true): RenderedPost {
  const post = getPost(idOrSlug, publishedOnly);
  const md = renderMarkdown(post.bodyMd);
  const linked = applyDynamicLinks(md.html, { currentPath: post.url, rules: listLinkRules(true), extra: postLinkRules(post.id) });
  const related = relatedPosts(post);
  const seo = getSeoSettingsCached();
  const jsonLd: unknown[] = [
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      '@id': `${absoluteUrl(post.url)}#article`,
      headline: post.title,
      description: post.metaDescription ?? post.excerpt,
      image: post.coverUrl ? [absoluteUrl(post.coverUrl)] : undefined,
      datePublished: post.publishedAt ?? post.createdAt,
      dateModified: post.updatedAt,
      author: { '@type': 'Organization', name: post.authorName, url: siteUrl() },
      publisher: { '@id': `${siteUrl()}/#organization` },
      mainEntityOfPage: absoluteUrl(post.url),
      keywords: post.keywords.join(', '),
      articleSection: post.category,
      inLanguage: post.language,
      wordCount: post.bodyMd.split(/\s+/).length,
      citation: post.sources.map((s) => ({ '@type': 'CreativeWork', name: s.title, url: s.url })),
      isAccessibleForFree: true,
    },
    breadcrumbJsonLd([{ name: seo.siteName, url: '/' }, { name: 'Blog', url: '/blog' }, { name: post.title, url: post.url }]),
  ];
  if (post.faq.length) jsonLd.push(faqJsonLd(post.faq));
  return { ...post, html: linked.html, headings: md.headings, plainText: md.text, appliedLinks: linked.applied, related, jsonLd };
}

export { escapeHtml };
