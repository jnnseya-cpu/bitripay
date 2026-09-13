/**
 * Public, server-rendered marketing surface (behind the web domain via the reverse proxy):
 *   /blog, /blog/:slug, /legal/:slug, /about, /contact, /sitemap.xml, /feed.xml, /robots.txt, /llms.txt, /llms-full.txt
 * plus the JSON blog API under /api/blog for the apps.
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate, wrap } from '../lib/http';
import { rateLimit } from '../middleware/rateLimit';
import { listPosts, listTags, renderPost, bumpPostViews, getPost } from '../services/blog';
import { listPages, getPage } from '../services/cms';
import { renderMarkdown } from '../services/markdown';
import { applyDynamicLinks, sitemapXml, robotsTxt, recordReferrer, bumpPageview } from '../services/seo';
import { getSeoSettings } from '../services/settings';
import { blogIndexPage, blogPostPage, legalPage, rssXml, llmsTxt } from '../site/render';

export const siteRouter = Router();
const publicLimit = rateLimit({ windowMs: 60_000, max: 240, keyPrefix: 'site' });

siteRouter.use((req, _res, next) => {
  // Inbound backlinks are discovered from the Referer header; page views are counted per path, never per person.
  if (req.method === 'GET' && !req.path.includes('.')) {
    try {
      recordReferrer(req.get('referer'), req.path);
      bumpPageview(req.path);
    } catch {
      /* analytics never break a page */
    }
  }
  next();
});

siteRouter.get('/blog', publicLimit, (req, res) => {
  const q = validate(z.object({ tag: z.string().max(60).optional(), q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).default(1) }), req.query);
  const pageSize = 12;
  const { items, total } = listPosts({ tag: q.tag ?? null, q: q.q ?? null, page: q.page, pageSize });
  res.type('html').send(blogIndexPage(items, { tag: q.tag ?? null, q: q.q ?? null, tags: listTags(), total, page: q.page, pageSize }));
});
siteRouter.get('/blog/:slug', publicLimit, (req, res) => {
  const post = renderPost(String(req.params.slug));
  bumpPostViews(post.id);
  res.type('html').send(blogPostPage(post));
});
function pageHtml(slug: string) {
  const page = getPage(slug);
  const md = renderMarkdown(page.content);
  return { slug: page.slug, title: page.title, html: applyDynamicLinks(md.html, { currentPath: `/legal/${page.slug}` }).html, updatedAt: page.updatedAt };
}
siteRouter.get('/legal/:slug', publicLimit, (req, res) => res.type('html').send(legalPage(pageHtml(String(req.params.slug)), 'legal')));
siteRouter.get('/about', publicLimit, (_req, res) => res.type('html').send(legalPage(pageHtml('about'), 'about')));
siteRouter.get('/contact', publicLimit, (_req, res) => res.type('html').send(legalPage(pageHtml('contact'), 'contact')));

siteRouter.get('/sitemap.xml', (_req, res) => {
  const posts = listPosts({ pageSize: 100 }).items;
  const pages = listPages(true).filter((p) => !['about', 'contact', 'faq'].includes(p.slug));
  res
    .type('application/xml')
    .send(
      sitemapXml([
        { path: '/', changefreq: 'weekly', priority: 1 },
        { path: '/register', changefreq: 'monthly', priority: 0.8 },
        { path: '/about', changefreq: 'monthly', priority: 0.7 },
        { path: '/blog', changefreq: 'daily', priority: 0.9 },
        ...posts.map((p) => ({ path: p.url, lastmod: p.updatedAt, changefreq: 'weekly', priority: 0.8 })),
        ...pages.map((p) => ({ path: `/legal/${p.slug}`, lastmod: p.updatedAt, changefreq: 'yearly', priority: 0.3 })),
      ]),
    );
});
siteRouter.get('/feed.xml', (_req, res) => res.type('application/rss+xml').send(rssXml(listPosts({ pageSize: 20 }).items.map((p) => renderPost(p.id)))));
siteRouter.get('/robots.txt', (_req, res) => res.type('text/plain').send(robotsTxt()));
siteRouter.get('/llms.txt', (_req, res) => res.type('text/plain').send(llmsTxt(listPosts({ pageSize: 100 }).items)));
siteRouter.get('/llms-full.txt', (_req, res) => {
  const items = listPosts({ pageSize: 50 }).items;
  res.type('text/plain').send(
    llmsTxt(
      items,
      true,
      items.map((p) => renderPost(p.id)),
    ),
  );
});
/** IndexNow key file. */
siteRouter.get('/:key.txt', (req, res, next) => {
  const key = getSeoSettings().indexNowKey;
  if (key && String(req.params.key) === key) return res.type('text/plain').send(key);
  next();
});

// ---- JSON API for the apps
export const blogApiRouter = Router();
blogApiRouter.get('/', (req, res) => {
  const q = validate(
    z.object({ tag: z.string().max(60).optional(), q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(12) }),
    req.query,
  );
  res.json({ ...listPosts({ tag: q.tag ?? null, q: q.q ?? null, page: q.page, pageSize: q.pageSize }), tags: listTags() });
});
blogApiRouter.get(
  '/:slug',
  wrap(async (req, res) => {
    const post = renderPost(String(req.params.slug));
    bumpPostViews(post.id);
    res.json({ post });
  }),
);
export { getPost };
