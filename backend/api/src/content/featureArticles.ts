/**
 * One article per feature, composed from the catalogue.
 *
 * The selling copy is hand-written in `features.ts`; this module adds the sections that must stay identical across
 * every article — the checkable facts, what it costs, where to read the live availability, and what to read next —
 * so those are written once and cannot drift from the feature pages.
 *
 * An article never states whether a capability is switched on. That is a fact about this deployment at this moment,
 * and a seeded blog post is neither. It belongs on /features/<slug>, which computes it, and every article links
 * there for it.
 */
import type { PostInput } from '../services/blog';
import { FEATURES, FEATURE_CATEGORIES, type Feature } from './features';

const CATEGORY_BLOG: Record<Feature['category'], string> = {
  accept: 'accepting payments',
  build: 'developers',
  move: 'moving money',
  reach: 'reaching everyone',
  operate: 'running a business',
  trust: 'trust and compliance',
};

function body(f: Feature): string {
  const related = f.related
    .map((k) => FEATURES.find((x) => x.key === k))
    .filter((x): x is Feature => Boolean(x))
    .map((r) => `- [${r.name}](/features/${r.slug}) — ${r.tagline}`);
  return `${f.article.trim()}

## What you can check

These are facts about the running platform, not adjectives. Each one is visible in the product, in the API reference or in the ledger.

${f.proof.map((p) => `- ${p}`).join('\n')}

## What it costs

${f.cost}

## Is it switched on?

Whether this is available depends on the authorisations in place and on what the administrator of a given deployment has switched on. That changes, and an article does not — so the live answer lives on the feature page, which reads it from the platform itself: **[${f.name} on the features page](/features/${f.slug})**.

${related.length ? `## Read next\n\n${related.join('\n')}\n` : ''}`;
}

/** Every feature article, ready to seed. Slugs are derived from the feature so an article is never duplicated. */
export function featureArticles(): PostInput[] {
  return FEATURES.map((f) => ({
    title: f.headline,
    slug: `${f.slug}-explained`,
    excerpt: f.excerpt,
    category: CATEGORY_BLOG[f.category],
    tags: [FEATURE_CATEGORIES[f.category].label.toLowerCase(), f.name.toLowerCase()],
    keywords: f.keywords,
    metaTitle: f.headline.length > 60 ? `${f.headline.slice(0, 57)}…` : f.headline,
    metaDescription: f.excerpt.length > 155 ? `${f.excerpt.slice(0, 152)}…` : f.excerpt,
    faq: f.faq,
    bodyMd: body(f),
  }));
}
