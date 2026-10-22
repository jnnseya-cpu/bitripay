/**
 * The feature pages: a hub at /features and one page per feature at /features/:slug.
 *
 * These are the canonical description of what the platform does, and the one place where a capability's
 * availability is stated. That statement is never written into the copy — it is computed from the live module state
 * every time the page is rendered, so a capability that is built but not yet authorised says so, and a capability an
 * administrator has switched off says that instead. Selling something the platform would refuse is therefore not a
 * matter of remembering to update a page.
 */
import { layout } from './render';
import { escapeHtml } from '../services/markdown';
import { absoluteUrl, breadcrumbJsonLd, pageTitle } from '../services/seo';
import { getSeoSettings } from '../services/settings';
import { getModules, aggregatorPerimeterApplied, AGGREGATOR_PERIMETER_OFF, MODULE_OFF_MESSAGE } from '../services/modules';
import { FEATURES, FEATURE_CATEGORIES, FEATURE_BY_SLUG, featuresInCategory, type Feature, type FeatureCategory } from '../content/features';

export type AvailabilityState = 'available' | 'awaiting_authorisation' | 'switched_off';

export interface Availability {
  state: AvailabilityState;
  label: string;
  note: string;
}

/**
 * What this deployment can actually do with this feature, right now. The three answers are deliberately distinct:
 * a capability held back by the aggregator perimeter is waiting on an authorisation, which is a different fact from
 * an administrator having turned something off, and both are different from it being available.
 */
export function featureAvailability(feature: Feature, modules = getModules()): Availability {
  if (!feature.module) {
    return { state: 'available', label: 'Available', note: 'Part of the platform itself: it is present wherever BitriPay runs.' };
  }
  if (modules[feature.module] !== false) {
    return { state: 'available', label: 'Available', note: 'Switched on for this deployment.' };
  }
  if (aggregatorPerimeterApplied(modules) && AGGREGATOR_PERIMETER_OFF.includes(feature.module)) {
    return {
      state: 'awaiting_authorisation',
      label: 'Available on authorisation',
      note: 'Built, tested and switched off. It is a function of an issuer or an acquirer, so it stays off until the corresponding authorisation is recorded, or until an authorised institution operates it on the platform. Nothing here is offered to a customer meanwhile.',
    };
  }
  return { state: 'switched_off', label: 'Switched off', note: 'An administrator has switched this off for this deployment. It can be switched back on in the console under Modules.' };
}

const CHIP_CLASS: Record<AvailabilityState, string> = { available: 'ok', awaiting_authorisation: 'warn', switched_off: 'muted' };

const CSS = `
.feat-hero{padding-block:22px 10px}.feat-hero h1{font-size:clamp(28px,4.4vw,46px);line-height:1.08;margin:0 0 12px;max-width:22ch}
.feat-usp{font-size:20px;color:var(--ink);max-width:62ch;margin:0 0 10px;font-weight:600;line-height:1.45}
.feat-sub{font-size:17px;color:var(--muted);max-width:66ch;margin:0}
.chip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);background:var(--paper);color:var(--muted)}
.chip.ok{background:#e3f4ec;color:#0b6e4f;border-color:#bfe3d1}.chip.warn{background:#fbf0dc;color:#8a5a00;border-color:#f1d9a6}.chip.muted{color:var(--muted)}
@media (prefers-color-scheme:dark){.chip.ok{background:#123425;color:#4fd48b;border-color:#1d5138}.chip.warn{background:#3a2e12;color:#f5b04a;border-color:#5c4718}}
.avail{border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:12px;padding:14px 16px;margin:18px 0;background:var(--paper)}
.avail b{display:block;margin-bottom:4px}.avail p{margin:0;color:var(--muted);font-size:15px}
.fgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:14px;margin:16px 0 0}
.fcard{border:1px solid var(--line);border-radius:14px;padding:16px 18px;background:var(--paper);display:flex;flex-direction:column;gap:8px}
.fcard h3{margin:0;font-size:18px}.fcard h3 a{color:var(--ink);text-decoration:none}.fcard h3 a:hover{color:var(--accent-2)}
.fcard p{margin:0;color:var(--muted);font-size:14.5px}.fcard .foot{margin-top:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fsect{margin-block:32px}.fsect h2{font-size:25px;margin:0 0 8px}.fsect .lead{color:var(--muted);margin:0 0 14px;max-width:70ch}
ol.steps-n{counter-reset:s;list-style:none;padding:0;margin:0;display:grid;gap:10px}
ol.steps-n li{counter-increment:s;position:relative;padding-left:40px;color:var(--ink);font-size:16px}
ol.steps-n li::before{content:counter(s);position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:13px}
ul.proof{list-style:none;padding:0;margin:0;display:grid;gap:9px}
ul.proof li{padding-left:26px;position:relative;color:var(--ink);font-size:15.5px}
ul.proof li::before{content:"";position:absolute;left:4px;top:8px;width:8px;height:8px;border-radius:2px;background:var(--accent-2)}
.faq-q{border-top:1px solid var(--line);padding:14px 0}.faq-q:last-child{border-bottom:1px solid var(--line)}
.faq-q h3{margin:0 0 6px;font-size:17px}.faq-q p{margin:0;color:var(--muted)}
.cta-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}.btn{display:inline-block;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600;border:1px solid var(--ink)}
.btn.primary{background:var(--ink);color:var(--bg)}.btn.ghost{color:var(--ink)}
.catnav{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 0}.catnav a{font-size:14.5px;padding:6px 12px;border:1px solid var(--line);border-radius:999px;text-decoration:none;color:var(--ink);background:var(--paper)}
`;

const seo = () => getSeoSettings();

function chip(a: Availability): string {
  return `<span class="chip ${CHIP_CLASS[a.state]}" title="${escapeHtml(a.note)}">${escapeHtml(a.label)}</span>`;
}

function card(f: Feature): string {
  const a = featureAvailability(f);
  return `<div class="fcard">
<h3><a href="/features/${escapeHtml(f.slug)}">${escapeHtml(f.name)}</a></h3>
<p>${escapeHtml(f.usp)}</p>
<div class="foot">${chip(a)}<a href="/features/${escapeHtml(f.slug)}">Read more →</a></div>
</div>`;
}

/** The hub: every feature, grouped by what a reader is trying to do, with its live availability. */
export function featuresIndexPage(): string {
  const s = seo();
  const categories = (Object.keys(FEATURE_CATEGORIES) as FeatureCategory[]).filter((c) => featuresInCategory(c).length > 0);
  const counts = { total: FEATURES.length, available: FEATURES.filter((f) => featureAvailability(f).state === 'available').length };
  const body = `<style>${CSS}</style>
<div class="breadcrumb"><a href="/">${escapeHtml(s.siteName)}</a> / Features</div>
<div class="feat-hero"><h1>Everything BitriPay does</h1>
<p class="feat-usp">One account, one API and one ledger behind every way money can reach a business in the markets we serve.</p>
<p class="feat-sub">${counts.available} of ${counts.total} are switched on for this deployment. Where a capability is built but waiting on an authorisation, the page says so plainly rather than selling it — this list is generated from the platform's own state, not written by hand.</p>
<div class="catnav">${categories.map((c) => `<a href="#${c}">${escapeHtml(FEATURE_CATEGORIES[c].label)}</a>`).join('')}</div></div>
${categories
  .map(
    (c) =>
      `<section class="fsect" id="${c}"><h2>${escapeHtml(FEATURE_CATEGORIES[c].label)}</h2><p class="lead">${escapeHtml(FEATURE_CATEGORIES[c].blurb)}</p><div class="fgrid">${featuresInCategory(c)
        .map(card)
        .join('')}</div></section>`,
  )
  .join('')}
<section class="fsect"><h2>Start somewhere</h2><div class="cta-row"><a class="btn primary" href="/register?role=merchant">Open a merchant account</a><a class="btn ghost" href="/developers/api">Read the API reference</a><a class="btn ghost" href="/how-it-works">How it works</a></div></section>`;
  return layout(
    {
      title: pageTitle('Features'),
      description: `Every BitriPay capability, feature by feature: what it does, who it is for, what it costs and whether it is switched on. ${counts.available} of ${counts.total} available on this deployment.`,
      path: '/features',
      jsonLd: [
        breadcrumbJsonLd([
          { name: s.siteName, url: '/' },
          { name: 'Features', url: '/features' },
        ]),
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: 'BitriPay features',
          itemListElement: FEATURES.map((f, i) => ({ '@type': 'ListItem', position: i + 1, name: f.name, url: absoluteUrl(`/features/${f.slug}`) })),
        },
      ],
    },
    body,
  );
}

/** One feature, in full: the promise, the problem, how it works, what is checkable, what it costs. */
export function featurePage(slug: string): string | null {
  const f = FEATURE_BY_SLUG[slug];
  if (!f) return null;
  const s = seo();
  const a = featureAvailability(f);
  const related = f.related.map((k) => FEATURES.find((x) => x.key === k)).filter((x): x is Feature => Boolean(x));
  const body = `<style>${CSS}</style>
<div class="breadcrumb"><a href="/">${escapeHtml(s.siteName)}</a> / <a href="/features">Features</a> / ${escapeHtml(f.name)}</div>
<div class="feat-hero"><div class="catnav" style="margin:0 0 10px"><a href="/features#${f.category}">${escapeHtml(FEATURE_CATEGORIES[f.category].label)}</a>${chip(a)}</div>
<h1>${escapeHtml(f.name)}</h1>
<p class="feat-usp">${escapeHtml(f.usp)}</p>
<p class="feat-sub">${escapeHtml(f.audience)}</p></div>

<div class="avail"><b>${escapeHtml(a.label)}</b><p>${escapeHtml(a.note)}${a.state !== 'available' ? ` ${escapeHtml(MODULE_OFF_MESSAGE)}` : ''}</p></div>

<section class="fsect"><h2>The problem</h2><p class="lead">${escapeHtml(f.problem)}</p></section>
<section class="fsect"><h2>How it works</h2><ol class="steps-n">${f.how.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ol></section>
<section class="fsect"><h2>What you can check</h2><p class="lead">Facts about the running platform rather than adjectives. Each one is visible in the product, the API reference or the ledger.</p><ul class="proof">${f.proof
    .map((p) => `<li>${escapeHtml(p)}</li>`)
    .join('')}</ul></section>
<section class="fsect"><h2>What it costs</h2><p class="lead">${escapeHtml(f.cost)}</p></section>
<section class="fsect"><h2>Questions</h2>${f.faq.map((q) => `<div class="faq-q"><h3>${escapeHtml(q.question)}</h3><p>${escapeHtml(q.answer)}</p></div>`).join('')}</section>
${related.length ? `<section class="fsect"><h2>Read next</h2><div class="fgrid">${related.map(card).join('')}</div></section>` : ''}
<section class="fsect"><div class="cta-row"><a class="btn primary" href="${escapeHtml(f.cta.href)}">${escapeHtml(f.cta.label)}</a><a class="btn ghost" href="/features">All features</a><a class="btn ghost" href="/contact">Ask a question</a></div></section>`;
  return layout(
    {
      title: pageTitle(f.name),
      description: f.usp.length > 300 ? `${f.usp.slice(0, 297)}…` : f.usp,
      path: `/features/${f.slug}`,
      jsonLd: [
        breadcrumbJsonLd([
          { name: s.siteName, url: '/' },
          { name: 'Features', url: '/features' },
          { name: f.name, url: `/features/${f.slug}` },
        ]),
        {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: f.faq.map((q) => ({ '@type': 'Question', name: q.question, acceptedAnswer: { '@type': 'Answer', text: q.answer } })),
        },
      ],
    },
    body,
  );
}

/** Every feature path, for the sitemap. */
export const FEATURE_PATHS = (): string[] => ['/features', ...FEATURES.map((f) => `/features/${f.slug}`)];
