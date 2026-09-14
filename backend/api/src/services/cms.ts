import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';
import { getSetting, setSetting } from './settings';
import { sendEmail } from './messaging';

export interface SiteSettings {
  siteName: string;
  tagline: string;
  description: string;
  contactEmail: string;
  contactPhone: string;
  address: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string;
  seo: { title: string; description: string; keywords: string; ogImage: string | null };
  appUrls: { playStore: string; appStore: string; agentApp: string; merchantApp: string };
  social: { twitter: string; facebook: string; instagram: string; linkedin: string; youtube: string };
  splash: { headline: string; subheadline: string; backgroundColor: string; imageUrl: string | null };
  onboarding: { title: string; body: string; imageUrl: string | null; color: string }[];
  usefulLinks: { label: string; url: string }[];
  gdpr: { enabled: boolean; message: string; policyUrl: string };
  defaultLanguage: string;
  darkModeDefault: boolean;
}

export const DEFAULT_SITE: SiteSettings = {
  siteName: 'BitriPay',
  tagline: 'Send, receive and accept money with a QR code',
  description: 'BitriPay is a complete money transfer platform: wallets, QR payments, cards, mobile money, remittance, agents and a merchant payment gateway.',
  contactEmail: 'support@bitripay.com',
  contactPhone: '',
  address: '',
  logoUrl: null,
  faviconUrl: null,
  primaryColor: '#2563eb',
  seo: {
    title: 'BitriPay – QR Code Money Transfer & Payment Gateway',
    description: 'Launch payments with QR codes, cards, mobile money, remittance and more.',
    keywords: 'qr payment, money transfer, wallet, payment gateway, remittance',
    ogImage: null,
  },
  appUrls: { playStore: '', appStore: '', agentApp: '', merchantApp: '' },
  social: { twitter: '', facebook: '', instagram: '', linkedin: '', youtube: '' },
  splash: { headline: 'BitriPay', subheadline: 'Pay anyone with a scan', backgroundColor: '#0f172a', imageUrl: null },
  onboarding: [
    { title: 'Scan & pay in seconds', body: 'Point your camera at any BitriPay QR code to pay a friend, a shop or an agent instantly.', imageUrl: null, color: '#2563eb' },
    { title: 'One wallet, every currency', body: 'Hold multiple currencies, exchange at live rates and send money across borders.', imageUrl: null, color: '#7c3aed' },
    { title: 'Cards, bills & top-ups', body: 'Add money by card or mobile money, pay bills, buy airtime and create virtual cards.', imageUrl: null, color: '#16a34a' },
  ],
  usefulLinks: [
    { label: 'Help center', url: '/pages/faq' },
    { label: 'Terms of service', url: '/pages/terms' },
    { label: 'Privacy policy', url: '/pages/privacy' },
  ],
  gdpr: { enabled: true, message: 'We use cookies to keep you signed in and to understand how BitriPay is used.', policyUrl: '/pages/privacy' },
  defaultLanguage: 'en',
  darkModeDefault: false,
};

export const getSiteSettings = () => {
  const stored = getSetting<Partial<SiteSettings>>('site', {});
  return {
    ...DEFAULT_SITE,
    ...stored,
    seo: { ...DEFAULT_SITE.seo, ...(stored.seo ?? {}) },
    appUrls: { ...DEFAULT_SITE.appUrls, ...(stored.appUrls ?? {}) },
    social: { ...DEFAULT_SITE.social, ...(stored.social ?? {}) },
    splash: { ...DEFAULT_SITE.splash, ...(stored.splash ?? {}) },
    gdpr: { ...DEFAULT_SITE.gdpr, ...(stored.gdpr ?? {}) },
  } as SiteSettings;
};
export const updateSiteSettings = (patch: Partial<SiteSettings>) => {
  setSetting('site', { ...getSiteSettings(), ...patch });
  return getSiteSettings();
};

// ----- Pages (About, FAQ, Terms, Privacy, ...) -----
export interface Page {
  slug: string;
  title: string;
  content: string;
  published: boolean;
  updatedAt: string;
}
const DEFAULT_PAGES: Page[] = [
  {
    slug: 'about',
    title: 'About BitriPay',
    content: '# About BitriPay\n\nBitriPay is a digital wallet and payment platform. Send money with a QR code, pay merchants, add funds by card or mobile money, and send remittances worldwide.',
    published: true,
    updatedAt: now(),
  },
  {
    slug: 'faq',
    title: 'Frequently asked questions',
    content:
      '# FAQ\n\n**How do I add money?** Go to Add Money and choose card, mobile money, bank transfer or a nearby agent.\n\n**How do I pay with QR?** Tap Scan, point your camera at the QR code and confirm.\n\n**Is my money safe?** Balances are held in segregated accounts and every transaction is recorded on a double-entry ledger.',
    published: true,
    updatedAt: now(),
  },
  {
    slug: 'terms',
    title: 'Terms of service',
    content: '# Terms of service\n\nBy using BitriPay you agree to these terms. Replace this text with your own terms in Admin → Pages.',
    published: true,
    updatedAt: now(),
  },
  {
    slug: 'privacy',
    title: 'Privacy policy',
    content: '# Privacy policy\n\nWe only collect the data needed to operate your account and comply with regulations. Replace this text in Admin → Pages.',
    published: true,
    updatedAt: now(),
  },
];
export function listPages(publishedOnly = true): Page[] {
  const pages = getSetting<Page[]>('pages', DEFAULT_PAGES);
  return publishedOnly ? pages.filter((p) => p.published) : pages;
}
export function getPage(slug: string): Page {
  const page = listPages(false).find((p) => p.slug === slug);
  if (!page || !page.published) throw notFound('Page not found');
  return page;
}
export function upsertPage(input: { slug: string; title: string; content: string; published: boolean }): Page {
  const slug = input.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!slug) throw badRequest('Invalid slug');
  const pages = listPages(false).filter((p) => p.slug !== slug);
  const page: Page = { slug, title: input.title, content: input.content, published: input.published, updatedAt: now() };
  setSetting('pages', [...pages, page]);
  return page;
}
export function deletePage(slug: string) {
  setSetting(
    'pages',
    listPages(false).filter((p) => p.slug !== slug),
  );
}

// ----- Contact messages & newsletter (stored in settings-backed tables for simplicity) -----
export function submitContact(input: { name: string; email: string; subject: string; message: string }) {
  const db = getDb();
  db.exec('CREATE TABLE IF NOT EXISTS contact_messages (id TEXT PRIMARY KEY, name TEXT, email TEXT, subject TEXT, message TEXT, status TEXT DEFAULT "new", reply TEXT, created_at TEXT)');
  const id = uuid();
  db.prepare('INSERT INTO contact_messages (id, name, email, subject, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    input.name,
    input.email,
    input.subject,
    input.message,
    'new',
    now(),
  );
  return { id };
}
export function listContactMessages() {
  const db = getDb();
  db.exec('CREATE TABLE IF NOT EXISTS contact_messages (id TEXT PRIMARY KEY, name TEXT, email TEXT, subject TEXT, message TEXT, status TEXT DEFAULT "new", reply TEXT, created_at TEXT)');
  return (db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 200').all() as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    subject: r.subject,
    message: r.message,
    status: r.status,
    reply: r.reply,
    createdAt: r.created_at,
  }));
}
export async function replyContactMessage(id: string, reply: string) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(id) as any;
  if (!row) throw notFound('Message not found');
  db.prepare("UPDATE contact_messages SET status = 'replied', reply = ? WHERE id = ?").run(reply, id);
  await sendEmail(row.email, `Re: ${row.subject}`, reply);
}

export function subscribeNewsletter(email: string) {
  const db = getDb();
  db.exec('CREATE TABLE IF NOT EXISTS newsletter_subscribers (email TEXT PRIMARY KEY, created_at TEXT)');
  db.prepare('INSERT OR IGNORE INTO newsletter_subscribers (email, created_at) VALUES (?, ?)').run(email.trim().toLowerCase(), now());
}
export function listSubscribers() {
  const db = getDb();
  db.exec('CREATE TABLE IF NOT EXISTS newsletter_subscribers (email TEXT PRIMARY KEY, created_at TEXT)');
  return (db.prepare('SELECT * FROM newsletter_subscribers ORDER BY created_at DESC').all() as any[]).map((r) => ({ email: r.email, createdAt: r.created_at }));
}
export async function sendNewsletter(subject: string, body: string, includeUsers = true) {
  const emails = new Set(listSubscribers().map((s) => s.email));
  if (includeUsers) for (const r of getDb().prepare("SELECT email FROM users WHERE email IS NOT NULL AND is_system = 0 AND status = 'active'").all() as any[]) emails.add(r.email);
  let sent = 0;
  for (const email of emails) {
    await sendEmail(email, subject, body);
    sent += 1;
  }
  return { sent };
}

// ----- Languages & translations -----
export interface Language {
  code: string;
  name: string;
  nativeName: string;
  rtl: boolean;
  enabled: boolean;
}
export const DEFAULT_LANGUAGES: Language[] = [
  { code: 'en', name: 'English', nativeName: 'English', rtl: false, enabled: true },
  { code: 'fr', name: 'French', nativeName: 'Français', rtl: false, enabled: true },
  { code: 'es', name: 'Spanish', nativeName: 'Español', rtl: false, enabled: true },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', rtl: false, enabled: true },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', rtl: true, enabled: true },
  { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili', rtl: false, enabled: true },
  { code: 'ln', name: 'Lingala', nativeName: 'Lingála', rtl: false, enabled: true },
  { code: 'kg', name: 'Kikongo', nativeName: 'Kikongo', rtl: false, enabled: true },
  { code: 'lua', name: 'Tshiluba', nativeName: 'Tshiluba', rtl: false, enabled: true },
  { code: 'am', name: 'Amharic', nativeName: 'አማርኛ', rtl: false, enabled: true },
  { code: 'ha', name: 'Hausa', nativeName: 'Hausa', rtl: false, enabled: true },
  { code: 'yo', name: 'Yoruba', nativeName: 'Yorùbá', rtl: false, enabled: true },
  { code: 'ig', name: 'Igbo', nativeName: 'Igbo', rtl: false, enabled: true },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', rtl: false, enabled: true },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', rtl: false, enabled: true },
];
export const listLanguages = () => getSetting<Language[]>('languages', DEFAULT_LANGUAGES);
export function upsertLanguage(lang: Language) {
  const langs = listLanguages().filter((l) => l.code !== lang.code);
  setSetting('languages', [...langs, lang]);
  return listLanguages();
}
export function deleteLanguage(code: string) {
  if (code === 'en') throw badRequest('English is the fallback language and cannot be removed');
  setSetting(
    'languages',
    listLanguages().filter((l) => l.code !== code),
  );
}
/** Admin-provided translation overrides per language: { [lang]: { key: text } }. Apps merge these over their built-in dictionaries. */
export const getTranslationOverrides = (lang: string) => getSetting<Record<string, Record<string, string>>>('translations', {})[lang] ?? {};
export function setTranslationOverrides(lang: string, dict: Record<string, string>) {
  const all = getSetting<Record<string, Record<string, string>>>('translations', {});
  all[lang] = dict;
  setSetting('translations', all);
}
