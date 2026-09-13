/**
 * Server-rendered public pages: blog index and articles, legal / policy pages, about page, sitemap, RSS and llms.txt.
 * Crawlers, social previews and AI answer engines get complete HTML with metadata and JSON-LD; humans get a fast,
 * readable page that shares the product's visual language and links into the app.
 */
import { escapeHtml } from '../services/markdown';
import { getSeoSettings, getSiteSettingsSafe } from '../services/settings';
import { absoluteUrl, organizationJsonLd, websiteJsonLd, breadcrumbJsonLd, pageTitle, siteUrl } from '../services/seo';
import type { RenderedPost, PostSummary } from '../services/blog';

export interface Meta {
  title: string;
  description: string;
  path: string;
  type?: 'website' | 'article';
  image?: string | null;
  publishedAt?: string | null;
  modifiedAt?: string | null;
  jsonLd?: unknown[];
  noindex?: boolean;
  language?: string;
}

const CSS = `
:root{--bg:#f6f6fb;--paper:#ffffff;--ink:#161832;--muted:#5b5e7e;--line:#e2e2ef;--accent:#2E2A7B;--accent-2:#12A34B;--amber:#F49D1F;--display:'Bricolage Grotesque',ui-sans-serif,system-ui,sans-serif;--body:'Source Sans 3',ui-sans-serif,system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0f0f22;--paper:#17173a;--ink:#ecebf7;--muted:#a6a8c4;--line:#2b2b5c;--accent:#9c96ee;--accent-2:#3ac47a;--amber:#f5b04a}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--body);font-size:17px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--accent-2)}a:hover{text-decoration-thickness:2px}
.wrap{max-width:1120px;margin:0 auto;padding-inline:clamp(16px,4vw,40px)}
header.top{border-bottom:1px solid var(--line);background:var(--paper)}
header.top .wrap{display:flex;align-items:center;gap:24px;min-height:64px}
.brand{font-family:var(--display);font-weight:700;font-size:20px;color:var(--ink);text-decoration:none;display:flex;align-items:center;gap:10px;letter-spacing:-.01em}
.brand i{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent-2));display:inline-block}.brand img{height:34px;width:auto;display:block}@media (prefers-color-scheme:dark){.brand img{filter:brightness(0) invert(1)}}
nav.main{display:flex;gap:18px;margin-left:auto;font-size:15px}nav.main a{color:var(--ink);text-decoration:none;font-weight:500}nav.main a:hover{color:var(--accent-2)}
nav.main .cta{background:var(--ink);color:var(--bg);padding:8px 14px;border-radius:8px}
@media (max-width:640px){nav.main a:not(.cta){display:none}}
main{padding-block:40px 72px}
h1{font-family:var(--display);font-weight:700;letter-spacing:-.02em;line-height:1.08;font-size:clamp(30px,4.6vw,52px);margin:0 0 14px;text-wrap:balance}
h2{font-family:var(--display);font-size:clamp(22px,2.6vw,30px);letter-spacing:-.015em;line-height:1.2;margin:40px 0 12px}
h3{font-family:var(--display);font-size:20px;margin:28px 0 8px}
p{margin:0 0 18px}.lede{font-size:20px;color:var(--muted);max-width:62ch;margin-bottom:28px}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:24px}
.card{background:var(--paper);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.card .body{padding:20px 22px 22px;display:grid;gap:8px}.card h3{margin:0;font-size:21px;line-height:1.25}.card h3 a{color:var(--ink);text-decoration:none}.card h3 a:hover{color:var(--accent-2)}
.card .meta{font-family:var(--mono);font-size:12px;color:var(--muted);display:flex;gap:10px;flex-wrap:wrap}
.card .cover{aspect-ratio:16/9;background:linear-gradient(120deg,#0b6e4f 0%,#1f4fd8 100%);position:relative}
.card .cover span{position:absolute;left:18px;bottom:14px;font-family:var(--display);font-weight:700;color:#fff;font-size:26px;letter-spacing:-.02em;text-shadow:0 2px 10px rgba(0,0,0,.35)}
.tag{display:inline-block;padding:3px 9px;border-radius:999px;border:1px solid var(--line);font-size:12px;color:var(--muted);text-decoration:none}
article.post{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:48px;align-items:start}
@media (max-width:900px){article.post{grid-template-columns:1fr}}
.prose{max-width:70ch}.prose p,.prose li{font-size:18px}.prose img{max-width:100%;height:auto;border-radius:10px}.prose blockquote{margin:0 0 20px;padding:14px 18px;border-left:3px solid var(--amber);background:var(--paper);border-radius:0 10px 10px 0;color:var(--muted)}
.prose pre{background:#0f1216;color:#eceae4;padding:14px 16px;border-radius:10px;overflow:auto;font-family:var(--mono);font-size:14px}.prose code{font-family:var(--mono);font-size:.92em}
.table-wrap{overflow-x:auto;margin:0 0 20px}.prose table{border-collapse:collapse;width:100%;font-size:16px}.prose th,.prose td{border:1px solid var(--line);padding:9px 12px;text-align:left;vertical-align:top}.prose th{background:var(--paper)}
aside.toc{position:sticky;top:20px;display:grid;gap:18px}
.tocbox{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:16px 18px}.tocbox b{display:block;font-family:var(--mono);font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}.tocbox a{display:block;color:var(--ink);text-decoration:none;font-size:15px;padding:4px 0;border-bottom:1px solid var(--line)}.tocbox a.l3{padding-left:14px;color:var(--muted)}.tocbox a:last-child{border-bottom:0}
.share a{display:inline-block;margin:0 8px 8px 0;font-size:14px}
.faq details{border-top:1px solid var(--line);padding:12px 0}.faq summary{cursor:pointer;font-weight:600;font-size:18px;font-family:var(--display)}.faq details p{margin:10px 0 0;color:var(--muted)}
.byline{display:flex;gap:14px;flex-wrap:wrap;font-family:var(--mono);font-size:13px;color:var(--muted);margin-bottom:28px}
.hero-post{border-radius:18px;padding:40px clamp(20px,4vw,48px);color:#fff;background:radial-gradient(1200px 400px at 10% -20%,rgba(255,255,255,.22),transparent 60%),linear-gradient(120deg,#0b6e4f,#1f4fd8 70%,#123b8f);margin-bottom:36px}
.hero-post .eyebrow{color:rgba(255,255,255,.75)}.hero-post h1{color:#fff;font-size:clamp(26px,3.6vw,44px)}.hero-post p{color:rgba(255,255,255,.85);max-width:60ch}.hero-post a.btn{display:inline-block;margin-top:8px;background:#fff;color:#12161c;padding:10px 16px;border-radius:9px;text-decoration:none;font-weight:600}
.cta-band{margin-top:48px;background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:28px;display:flex;gap:20px;align-items:center;flex-wrap:wrap}.cta-band .btn{background:var(--accent);color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600}
footer.site{border-top:1px solid var(--line);background:var(--paper);padding-block:44px 36px;font-size:15px}
footer .cols{display:grid;grid-template-columns:2fr repeat(3,1fr);gap:32px}@media (max-width:820px){footer .cols{grid-template-columns:1fr 1fr}}@media (max-width:480px){footer .cols{grid-template-columns:1fr}}
footer h4{margin:0 0 10px;font-family:var(--mono);font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}footer ul{list-style:none;padding:0;margin:0;display:grid;gap:7px}footer a{color:var(--ink);text-decoration:none}footer a:hover{color:var(--accent-2)}
footer .legal{margin-top:32px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:13px;display:grid;gap:8px}
.breadcrumb{font-family:var(--mono);font-size:12px;color:var(--muted);margin-bottom:18px}.breadcrumb a{color:var(--muted)}
.notice{border:1px solid var(--line);background:var(--paper);border-radius:12px;padding:14px 18px;font-size:15px;color:var(--muted);margin-bottom:24px}
`;

export const FOOTER_LINKS = {
  product: [
    { label: 'Send money', href: '/app/send' },
    { label: 'QR payments', href: '/app/scan' },
    { label: 'Add money', href: '/app/add-money' },
    { label: 'Virtual cards', href: '/app/cards' },
    { label: 'Remittance', href: '/app/remittance' },
    { label: 'Agents & cash', href: '/app/agents' },
    { label: 'For merchants', href: '/register?role=merchant' },
    { label: 'Become an agent', href: '/register?role=agent' },
  ],
  company: [
    { label: 'About us', href: '/about' },
    { label: 'Blog', href: '/blog' },
    { label: 'Security', href: '/legal/security' },
    { label: 'Regulatory information', href: '/legal/regulatory' },
    { label: 'Fees & charges', href: '/legal/fees' },
    { label: 'Contact', href: '/contact' },
  ],
  legal: [
    { label: 'Privacy policy', href: '/legal/privacy' },
    { label: 'Terms of service', href: '/legal/terms' },
    { label: 'Cookie policy', href: '/legal/cookies' },
    { label: 'Acceptable use', href: '/legal/acceptable-use' },
    { label: 'AML, KYC & sanctions', href: '/legal/aml-kyc' },
    { label: 'Safeguarding of funds', href: '/legal/safeguarding' },
    { label: 'Refunds & cancellations', href: '/legal/refunds' },
    { label: 'Complaints', href: '/legal/complaints' },
    { label: 'Accessibility', href: '/legal/accessibility' },
    { label: 'Agent & merchant agreement', href: '/legal/agent-merchant-agreement' },
  ],
};

export function layout(meta: Meta, body: string, _opts: { wide?: boolean } = {}): string {
  const seo = getSeoSettings();
  const site = getSiteSettingsSafe();
  const url = absoluteUrl(meta.path);
  const image = meta.image ? absoluteUrl(meta.image) : seo.ogImage ? absoluteUrl(seo.ogImage) : absoluteUrl('/og-default.png');
  const jsonLd = [organizationJsonLd(), websiteJsonLd(), ...(meta.jsonLd ?? [])];
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="${escapeHtml(meta.language ?? 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<meta name="description" content="${escapeHtml(meta.description)}">
<link rel="canonical" href="${escapeHtml(url)}">
${meta.noindex ? '<meta name="robots" content="noindex,follow">' : '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">'}
<meta property="og:type" content="${meta.type ?? 'website'}"><meta property="og:site_name" content="${escapeHtml(seo.siteName)}"><meta property="og:title" content="${escapeHtml(meta.title)}"><meta property="og:description" content="${escapeHtml(meta.description)}"><meta property="og:url" content="${escapeHtml(url)}"><meta property="og:image" content="${escapeHtml(image)}"><meta property="og:locale" content="${escapeHtml((meta.language ?? 'en') === 'fr' ? 'fr_FR' : 'en_GB')}">
${meta.publishedAt ? `<meta property="article:published_time" content="${escapeHtml(meta.publishedAt)}">` : ''}${meta.modifiedAt ? `<meta property="article:modified_time" content="${escapeHtml(meta.modifiedAt)}">` : ''}
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="${escapeHtml(seo.twitterHandle)}"><meta name="twitter:title" content="${escapeHtml(meta.title)}"><meta name="twitter:description" content="${escapeHtml(meta.description)}"><meta name="twitter:image" content="${escapeHtml(image)}">
${seo.languages.map((l) => `<link rel="alternate" hreflang="${l}" href="${escapeHtml(url)}${url.includes('?') ? '&' : '?'}lang=${l}">`).join('')}<link rel="alternate" hreflang="x-default" href="${escapeHtml(url)}">
<link rel="alternate" type="application/rss+xml" title="${escapeHtml(seo.siteName)} blog" href="${escapeHtml(absoluteUrl('/feed.xml'))}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Source+Sans+3:wght@400;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>${CSS}</style>
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="/" aria-label="${escapeHtml(seo.siteName)}"><img src="/brand/logo.svg" alt="${escapeHtml(seo.siteName)}" width="140" height="34"></a><nav class="main"><a href="/blog">Blog</a><a href="/about">About</a><a href="/legal/fees">Fees</a><a href="/login">Sign in</a><a class="cta" href="/register">Open an account</a></nav></div></header>
<main><div class="wrap">${body}</div></main>
<footer class="site"><div class="wrap">
<div class="cols">
<div><a class="brand" href="/" aria-label="${escapeHtml(seo.siteName)}"><img src="/brand/logo.svg" alt="${escapeHtml(seo.siteName)}" width="140" height="34"></a><p style="color:var(--muted);margin-top:12px;max-width:40ch">Money that works for everyone: the mother selling food at the market, the moto-taxi rider paid by his passengers, the shop on the corner and the family sending money home.</p>${site?.contactEmail ? `<p><a href="mailto:${escapeHtml(site.contactEmail)}">${escapeHtml(site.contactEmail)}</a></p>` : ''}</div>
<div><h4>Product</h4><ul>${FOOTER_LINKS.product.map((l) => `<li><a href="${l.href}">${l.label}</a></li>`).join('')}</ul></div>
<div><h4>Company</h4><ul>${FOOTER_LINKS.company.map((l) => `<li><a href="${l.href}">${l.label}</a></li>`).join('')}</ul></div>
<div><h4>Legal</h4><ul>${FOOTER_LINKS.legal.map((l) => `<li><a href="${l.href}">${l.label}</a></li>`).join('')}</ul></div>
</div>
<div class="legal"><span>© ${year} ${escapeHtml(seo.organization.legalName || seo.siteName)}. BitriPay balances are electronic money, not bank deposits. Where the platform is not yet authorised in a country, accounts run in sandbox mode with no real-world value and this is shown in the app. Cross-border transfers are a regulated money-transfer service and are offered only through authorised corridors.</span><span><a href="/sitemap.xml">Sitemap</a> · <a href="/feed.xml">RSS</a> · <a href="/llms.txt">llms.txt</a></span></div>
</div></footer>
</body></html>`;
}

const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

export function blogIndexPage(posts: PostSummary[], opts: { tag?: string | null; q?: string | null; tags: { tag: string; count: number }[]; total: number; page: number; pageSize: number }): string {
  const seo = getSeoSettings();
  const [first, ...rest] = posts;
  const title = opts.tag ? `Articles about ${opts.tag}` : opts.q ? `Search: ${opts.q}` : 'Blog';
  const body = `
<div class="breadcrumb"><a href="/">${escapeHtml(seo.siteName)}</a> / Blog</div>
<div class="eyebrow">Guides, corridors and plain answers</div>
<h1>${escapeHtml(title)}</h1>
<p class="lede">Practical writing for people who pay and get paid on a phone: mobile money, QR payments, cards, remittance costs, agents and how your money is protected.</p>
<form action="/blog" method="get" style="margin-bottom:28px;display:flex;gap:8px;max-width:520px"><input name="q" value="${escapeHtml(opts.q ?? '')}" placeholder="Search the blog" style="flex:1;padding:10px 12px;border:1px solid var(--line);border-radius:9px;font:inherit;background:var(--paper);color:var(--ink)"><button style="padding:10px 14px;border-radius:9px;border:0;background:var(--ink);color:var(--bg);font:inherit;font-weight:600">Search</button></form>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:28px">${opts.tags
    .slice(0, 14)
    .map((t) => `<a class="tag" href="/blog?tag=${encodeURIComponent(t.tag)}">${escapeHtml(t.tag)} · ${t.count}</a>`)
    .join('')}</div>
${first && !opts.tag && !opts.q && opts.page === 1 ? `<section class="hero-post"><div class="eyebrow">Latest</div><h1><a href="${first.url}" style="color:#fff;text-decoration:none">${escapeHtml(first.title)}</a></h1><p>${escapeHtml(first.excerpt)}</p><a class="btn" href="${first.url}">Read the guide →</a></section>` : ''}
<div class="grid">${(first && !opts.tag && !opts.q && opts.page === 1 ? rest : posts).map(cardHtml).join('')}</div>
${posts.length === 0 ? '<p class="notice">No articles match yet. Try another search or browse the tags above.</p>' : ''}
${opts.total > opts.pageSize ? `<p style="margin-top:28px;font-family:var(--mono);font-size:13px">${opts.page > 1 ? `<a href="/blog?page=${opts.page - 1}${opts.tag ? `&tag=${encodeURIComponent(opts.tag)}` : ''}">← Newer</a> · ` : ''}Page ${opts.page} of ${Math.ceil(opts.total / opts.pageSize)}${opts.page * opts.pageSize < opts.total ? ` · <a href="/blog?page=${opts.page + 1}${opts.tag ? `&tag=${encodeURIComponent(opts.tag)}` : ''}">Older →</a>` : ''}</p>` : ''}
${ctaBand()}`;
  return layout(
    {
      title: pageTitle(opts.tag ? `${title}` : 'Blog: money guides for people who pay and get paid on a phone'),
      description: 'Guides on mobile money, QR payments, virtual cards, remittance costs, agents and safeguarding, written for market traders, riders, merchants and families sending money home.',
      path: opts.tag ? `/blog?tag=${encodeURIComponent(opts.tag)}` : '/blog',
      jsonLd: [
        breadcrumbJsonLd([
          { name: seo.siteName, url: '/' },
          { name: 'Blog', url: '/blog' },
        ]),
        {
          '@context': 'https://schema.org',
          '@type': 'Blog',
          '@id': `${siteUrl()}/blog#blog`,
          name: `${seo.siteName} blog`,
          url: absoluteUrl('/blog'),
          publisher: { '@id': `${siteUrl()}/#organization` },
          blogPost: posts.map((p) => ({ '@type': 'BlogPosting', headline: p.title, url: absoluteUrl(p.url), datePublished: p.publishedAt })),
        },
      ],
      noindex: !!opts.q,
    },
    body,
  );
}

function cardHtml(p: PostSummary): string {
  return `<article class="card">${p.coverUrl ? `<a href="${p.url}"><img src="${escapeHtml(p.coverUrl)}" alt="${escapeHtml(p.coverAlt ?? p.title)}" style="display:block;width:100%;aspect-ratio:16/9;object-fit:cover" loading="lazy"></a>` : `<a href="${p.url}" class="cover" style="text-decoration:none"><span>${escapeHtml(p.category)}</span></a>`}<div class="body"><div class="meta"><span>${fmtDate(p.publishedAt)}</span><span>${p.readingMinutes} min read</span></div><h3><a href="${p.url}">${escapeHtml(p.title)}</a></h3><p style="margin:0;color:var(--muted);font-size:15px">${escapeHtml(p.excerpt)}</p><div>${p.tags
    .slice(0, 3)
    .map((t) => `<a class="tag" href="/blog?tag=${encodeURIComponent(t)}">${escapeHtml(t)}</a> `)
    .join('')}</div></div></article>`;
}

function ctaBand(): string {
  return `<section class="cta-band"><div style="flex:1;min-width:240px"><b style="font-family:var(--display);font-size:20px">Try it with a free account</b><p style="margin:6px 0 0;color:var(--muted)">Send with a QR code, add money by card or mobile money, issue a virtual card. Sandbox balances let you explore before any real money moves.</p></div><a class="btn" href="/register">Open an account</a></section>`;
}

export function blogPostPage(post: RenderedPost): string {
  const seo = getSeoSettings();
  const url = absoluteUrl(post.url);
  const share = [
    ['X', `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(post.social.x ?? post.title)}`],
    ['LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`],
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`],
    ['WhatsApp', `https://wa.me/?text=${encodeURIComponent(`${post.social.whatsapp ?? post.title} ${url}`)}`],
    ['Telegram', `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(post.title)}`],
  ];
  const body = `
<div class="breadcrumb"><a href="/">${escapeHtml(seo.siteName)}</a> / <a href="/blog">Blog</a> / ${escapeHtml(post.category)}</div>
<article class="post">
<div>
<div class="eyebrow">${escapeHtml(post.category)}</div>
<h1>${escapeHtml(post.title)}</h1>
<p class="lede">${escapeHtml(post.excerpt)}</p>
<div class="byline"><span>By ${escapeHtml(post.authorName)}</span><span>${fmtDate(post.publishedAt)}</span>${post.updatedAt && post.publishedAt && post.updatedAt.slice(0, 10) !== post.publishedAt.slice(0, 10) ? `<span>Updated ${fmtDate(post.updatedAt)}</span>` : ''}<span>${post.readingMinutes} min read</span></div>
${post.coverUrl ? `<img src="${escapeHtml(post.coverUrl)}" alt="${escapeHtml(post.coverAlt ?? post.title)}" style="width:100%;border-radius:14px;margin-bottom:28px">` : ''}
${post.source === 'agent' ? '' : ''}
<div class="prose">${post.html}</div>
${post.faq.length ? `<section class="faq"><h2 id="faq">Frequently asked questions</h2>${post.faq.map((f) => `<details><summary>${escapeHtml(f.question)}</summary><p>${escapeHtml(f.answer)}</p></details>`).join('')}</section>` : ''}
${post.sources.length ? `<section><h2 id="sources">Sources and further reading</h2><ol>${post.sources.map((s) => `<li><a href="${escapeHtml(s.url)}" rel="noopener" target="_blank">${escapeHtml(s.title)}</a></li>`).join('')}</ol></section>` : ''}
<div style="margin-top:28px">${post.tags.map((t) => `<a class="tag" href="/blog?tag=${encodeURIComponent(t)}">${escapeHtml(t)}</a> `).join('')}</div>
${ctaBand()}
${post.related.length ? `<h2>Keep reading</h2><div class="grid">${post.related.map(cardHtml).join('')}</div>` : ''}
</div>
<aside class="toc">
${post.headings.length ? `<div class="tocbox"><b>In this article</b>${post.headings.map((h) => `<a class="${h.level === 3 ? 'l3' : ''}" href="#${h.id}">${escapeHtml(h.text)}</a>`).join('')}${post.faq.length ? '<a href="#faq">FAQ</a>' : ''}</div>` : ''}
<div class="tocbox"><b>Share</b><div class="share">${share.map(([n, h]) => `<a href="${h}" rel="noopener" target="_blank">${n}</a>`).join('')}</div></div>
<div class="tocbox"><b>Get the app</b><p style="margin:0 0 10px;font-size:14px;color:var(--muted)">Send with a QR code, add money by card or mobile money, get a virtual card.</p><a href="/register" style="display:inline-block;background:var(--accent);color:#fff;padding:9px 14px;border-radius:9px;text-decoration:none;font-weight:600;font-size:14px">Open an account</a></div>
</aside>
</article>`;
  return layout(
    {
      title: post.metaTitle ?? pageTitle(post.title),
      description: post.metaDescription ?? post.excerpt,
      path: post.canonicalUrl ?? post.url,
      type: 'article',
      image: post.coverUrl,
      publishedAt: post.publishedAt,
      modifiedAt: post.updatedAt,
      jsonLd: post.jsonLd,
      language: post.language,
    },
    body,
  );
}

export function legalPage(page: { slug: string; title: string; html: string; updatedAt: string }, kind: 'legal' | 'about' | 'contact'): string {
  const seo = getSeoSettings();
  const path = kind === 'legal' ? `/legal/${page.slug}` : `/${kind}`;
  const body = `
<div class="breadcrumb"><a href="/">${escapeHtml(seo.siteName)}</a> / ${kind === 'legal' ? 'Legal' : kind === 'about' ? 'Company' : 'Contact'}</div>
<article class="post"><div><h1>${escapeHtml(page.title)}</h1><div class="byline"><span>Last updated ${fmtDate(page.updatedAt)}</span></div><div class="prose">${page.html}</div></div>
<aside class="toc"><div class="tocbox"><b>${kind === 'legal' ? 'Policies' : 'Company'}</b>${(kind === 'legal' ? FOOTER_LINKS.legal : FOOTER_LINKS.company).map((l) => `<a href="${l.href}"${l.href === path ? ' style="color:var(--accent-2);font-weight:600"' : ''}>${l.label}</a>`).join('')}</div></aside></article>`;
  return layout(
    {
      title: pageTitle(page.title),
      description: page.html
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 155),
      path,
      jsonLd: [
        breadcrumbJsonLd([
          { name: seo.siteName, url: '/' },
          { name: page.title, url: path },
        ]),
        ...(kind === 'about' ? [{ '@context': 'https://schema.org', '@type': 'AboutPage', name: page.title, url: absoluteUrl(path), mainEntity: { '@id': `${siteUrl()}/#organization` } }] : []),
      ],
    },
    body,
  );
}

export function rssXml(posts: RenderedPost[]): string {
  const seo = getSeoSettings();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>${escapeHtml(seo.siteName)} blog</title><link>${escapeHtml(absoluteUrl('/blog'))}</link><description>${escapeHtml(seo.defaultDescription)}</description><language>en</language><atom:link href="${escapeHtml(absoluteUrl('/feed.xml'))}" rel="self" type="application/rss+xml"/>
${posts.map((p) => `<item><title>${escapeHtml(p.title)}</title><link>${escapeHtml(absoluteUrl(p.url))}</link><guid isPermaLink="true">${escapeHtml(absoluteUrl(p.url))}</guid><pubDate>${new Date(p.publishedAt ?? p.createdAt).toUTCString()}</pubDate><description>${escapeHtml(p.excerpt)}</description>${p.tags.map((t) => `<category>${escapeHtml(t)}</category>`).join('')}<content:encoded><![CDATA[${p.html}]]></content:encoded></item>`).join('\n')}
</channel></rss>
`;
}

/** llms.txt: the short, machine-readable guide AI answer engines use to understand and cite the site. */
export function llmsTxt(posts: PostSummary[], full = false, rendered: RenderedPost[] = []): string {
  const seo = getSeoSettings();
  const head = `# ${seo.siteName}

> ${seo.defaultDescription}

BitriPay is a digital wallet and payment platform built so that anyone with a phone can be paid and can pay: a mother selling food at the market, a moto-taxi rider collecting fares, a corner shop, an agent with cash, and families sending money home. Money moves by QR code, @tag, phone number, bank transfer, mobile money and cash agents. Balances are electronic money backed 1:1 by safeguarded funds where the platform is authorised; sandbox balances carry no real-world value. Mobile-money payouts are executed from prefunded local accounts and settled only on verified operator confirmations. Fees and exchange rates are shown before every payment.

## Key pages
- [Home](${siteUrl()}/): product overview
- [Open an account](${absoluteUrl('/register')})
- [About us](${absoluteUrl('/about')}): mission and who we build for
- [Fees & charges](${absoluteUrl('/legal/fees')})
- [Security](${absoluteUrl('/legal/security')})
- [Safeguarding of funds](${absoluteUrl('/legal/safeguarding')})
- [Regulatory information](${absoluteUrl('/legal/regulatory')})
- [Privacy policy](${absoluteUrl('/legal/privacy')})
- [Terms of service](${absoluteUrl('/legal/terms')})
- [Blog](${absoluteUrl('/blog')}) · [RSS](${absoluteUrl('/feed.xml')}) · [Sitemap](${absoluteUrl('/sitemap.xml')})

## Articles
${posts.map((p) => `- [${p.title}](${absoluteUrl(p.url)}): ${p.excerpt}`).join('\n')}
`;
  if (!full) return head;
  return head + '\n\n' + rendered.map((p) => `---\n\n# ${p.title}\n\n${p.plainText}\n${p.faq.map((f) => `\n**${f.question}**\n${f.answer}`).join('\n')}`).join('\n\n');
}
