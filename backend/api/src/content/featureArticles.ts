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
import { FEATURES, FEATURE_BY_KEY, FEATURE_CATEGORIES, FEATURE_CATEGORIES_FR, featureText, missingTranslations, type Feature, type FeatureLang } from './features';

const CATEGORY_BLOG: Record<FeatureLang, Record<Feature['category'], string>> = {
  en: {
    accept: 'accepting payments',
    build: 'developers',
    move: 'moving money',
    reach: 'reaching everyone',
    operate: 'running a business',
    trust: 'trust and compliance',
  },
  fr: {
    accept: 'encaisser',
    build: 'développeurs',
    move: 'faire circuler l’argent',
    reach: 'atteindre tout le monde',
    operate: 'tenir l’entreprise',
    trust: 'confiance et conformité',
  },
};

const SECTIONS: Record<
  FeatureLang,
  { check: string; checkLead: string; cost: string; availability: string; availabilityBody: (name: string, slug: string, lang: FeatureLang) => string; next: string }
> = {
  en: {
    check: 'What you can check',
    checkLead: 'These are facts about the running platform, not adjectives. Each one is visible in the product, in the API reference or in the ledger.',
    cost: 'What it costs',
    availability: 'Is it switched on?',
    availabilityBody: (name, slug) =>
      `Whether this is available depends on the authorisations in place and on what the administrator of a given deployment has switched on. That changes, and an article does not — so the live answer lives on the feature page, which reads it from the platform itself: **[${name} on the features page](/features/${slug})**.`,
    next: 'Read next',
  },
  fr: {
    check: 'Ce que vous pouvez vérifier',
    checkLead: 'Ce sont des faits sur la plateforme en fonctionnement, pas des adjectifs. Chacun est visible dans le produit, dans la référence de l’API ou dans le grand livre.',
    cost: 'Ce que cela coûte',
    availability: 'Est-ce activé ?',
    availabilityBody: (name, slug) =>
      `La disponibilité dépend des autorisations en place et de ce que l’administrateur d’un déploiement donné a activé. Cela change, un article non — la réponse vivante est donc sur la page de la fonctionnalité, qui la lit dans la plateforme elle-même : **[${name} sur la page des fonctionnalités](/features/${slug}?lang=fr)**.`,
    next: 'À lire ensuite',
  },
};

function body(f: Feature, lang: FeatureLang): string {
  const t = featureText(f, lang);
  const sec = SECTIONS[lang];
  const suffix = lang === 'fr' ? '?lang=fr' : '';
  const related = f.related
    .map((k) => FEATURE_BY_KEY[k])
    .filter((x): x is Feature => Boolean(x))
    .map((r) => {
      const rt = featureText(r, lang);
      return `- [${rt.name}](/features/${r.slug}${suffix}) — ${rt.tagline}`;
    });
  return `${t.article.trim()}

## ${sec.check}

${sec.checkLead}

${t.proof.map((p) => `- ${p}`).join('\n')}

## ${sec.cost}

${t.cost}

## ${sec.availability}

${sec.availabilityBody(t.name, f.slug, lang)}

${related.length ? `## ${sec.next}\n\n${related.join('\n')}\n` : ''}`;
}

/**
 * Every feature article in one language, ready to seed. Slugs come from the catalogue so an article is never
 * duplicated, and a language with no translation for a feature is skipped rather than seeded in English under a
 * French slug — a test fails on any such gap, so skipping is a safety net rather than a plan.
 */
export function featureArticles(lang: FeatureLang = 'en'): PostInput[] {
  const cats = lang === 'fr' ? FEATURE_CATEGORIES_FR : FEATURE_CATEGORIES;
  return FEATURES.filter((f) => missingTranslations(f, lang).length === 0).map((f) => {
    const t = featureText(f, lang);
    return {
      title: t.headline,
      slug: t.articleSlug,
      excerpt: t.excerpt,
      language: lang,
      category: CATEGORY_BLOG[lang][f.category],
      tags: [cats[f.category].label.toLowerCase(), t.name.toLowerCase()],
      keywords: f.keywords,
      metaTitle: t.headline.length > 60 ? `${t.headline.slice(0, 57)}…` : t.headline,
      metaDescription: t.excerpt.length > 155 ? `${t.excerpt.slice(0, 152)}…` : t.excerpt,
      faq: t.faq,
      bodyMd: body(f, lang),
    };
  });
}

/** Both languages, for seeding. */
export const allFeatureArticles = (): PostInput[] => [...featureArticles('en'), ...featureArticles('fr')];
