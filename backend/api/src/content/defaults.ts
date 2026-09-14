/**
 * Default public content: policies, about/contact pages, launch articles and internal-link rules. Idempotent and
 * versioned – it fills in what is missing on first start and never overwrites an administrator's edits.
 */
import { getDb } from '../db';
import { getSetting, setSetting } from '../services/settings';
import { sha256 } from '../lib/crypto';
import { listPages, upsertPage } from '../services/cms';
import { createPost } from '../services/blog';
import { upsertLinkRule } from '../services/seo';
import { DEFAULT_PAGES } from './policies';
import { DEFAULT_ARTICLES } from './articles';

const CONTENT_VERSION = 2;
let done = false;

const LINK_RULES: { keyword: string; url: string; title: string }[] = [
  { keyword: 'virtual card', url: '/app/cards', title: 'BitriPay virtual cards' },
  { keyword: 'send money', url: '/app/send', title: 'Send money with BitriPay' },
  { keyword: 'QR code', url: '/app/receive', title: 'Your BitriPay QR code' },
  { keyword: 'remittance', url: '/app/remittance', title: 'Send money abroad' },
  { keyword: 'agent', url: '/app/agents', title: 'Find a BitriPay agent' },
  { keyword: 'safeguarding', url: '/legal/safeguarding', title: 'How customer funds are safeguarded' },
  { keyword: 'fees', url: '/legal/fees', title: 'BitriPay fees and charges' },
  { keyword: 'open an account', url: '/register', title: 'Create a BitriPay account' },
  { keyword: 'statement', url: '/app/statements', title: 'Account statements' },
];

/** Test hook: lets a suite run the seeding again on the same in-memory database. */
export function _resetDefaultContentForTests(): void {
  done = false;
}

export function ensureDefaultContent(): { pages: number; posts: number } {
  if (done) return { pages: 0, posts: 0 };
  done = true;
  const version = getSetting<number>('content.version', 0);
  if (version >= CONTENT_VERSION) return { pages: 0, posts: 0 };
  const existing = new Set(listPages(false).map((p) => p.slug));
  // Hash of the default text each page was last seeded with: a page whose content still matches it has never been
  // edited by an administrator and may be refreshed when the shipped default changes; an edited page is never overwritten.
  const seeded = getSetting<Record<string, string>>('content.seededHashes', {});
  let pages = 0;
  for (const p of DEFAULT_PAGES) {
    const current = listPages(false).find((x) => x.slug === p.slug);
    const untouched = !!current && (seeded[p.slug] === sha256(current.content) || /Replace this text|^# About BitriPay\n\nBitriPay is a digital wallet/.test(current.content));
    if (!existing.has(p.slug) || untouched) {
      upsertPage({ slug: p.slug, title: p.title, content: p.content, published: true });
      seeded[p.slug] = sha256(p.content);
      pages++;
    } else if (current && p.slug === 'regulatory' && !current.content.includes('## National payment switch')) {
      // An edited regulatory page keeps every administrator change and gains the mandatory national-switch section.
      const section = p.content.slice(p.content.indexOf('## National payment switch'));
      upsertPage({ slug: p.slug, title: current.title, content: `${current.content.trimEnd()}\n\n${section}`, published: current.published });
      pages++;
    }
  }
  setSetting('content.seededHashes', seeded);
  let posts = 0;
  const day = 86_400_000;
  DEFAULT_ARTICLES.forEach((a, i) => {
    if (getDb().prepare('SELECT 1 FROM blog_posts WHERE slug = ?').get(a.slug!)) return;
    createPost({ ...a, status: 'published', source: 'seed', publishedAt: new Date(Date.now() - (DEFAULT_ARTICLES.length - i) * 3 * day).toISOString() }, { type: 'system' });
    posts++;
  });
  for (const r of LINK_RULES) upsertLinkRule({ keyword: r.keyword, url: r.url, title: r.title, kind: 'internal', priority: 50 });
  setSetting('content.version', CONTENT_VERSION);
  return { pages, posts };
}
