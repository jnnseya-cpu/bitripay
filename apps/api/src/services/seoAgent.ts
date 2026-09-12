/**
 * Content agent for SEO. Uses the Anthropic SDK (Claude) to draft articles, propose keywords, audit pages,
 * write social packs and suggest internal links. Every run is logged with tokens and cost; drafts always go to
 * editorial review unless auto-publish is switched on. When no API key is configured (or the API is unreachable)
 * a deterministic template writer produces a clearly labelled fallback draft so the pipeline keeps working.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { parseJson } from '../lib/json';
import { decrypt } from '../lib/crypto';
import { badRequest } from '../lib/errors';
import { config } from '../config';
import { getSeoSettings } from './settings';
import { createPost, getPost, updatePost, listPosts, type Post } from './blog';
import { listLinkRules, upsertLinkRule, listBacklinks, siteUrl, pingIndexNow } from './seo';
import { recordEvent, type Actor } from './events';
import { slugify } from './markdown';

export interface AgentRun {
  id: string;
  task: string;
  input: unknown;
  output: unknown;
  model: string | null;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  status: 'ok' | 'error' | 'fallback';
  error: string | null;
  postId: string | null;
  triggeredBy: string | null;
  createdAt: string;
}
const toRun = (r: any): AgentRun => ({ id: r.id, task: r.task, input: parseJson(r.input, null), output: parseJson(r.output, null), model: r.model, provider: r.provider, inputTokens: r.input_tokens, outputTokens: r.output_tokens, status: r.status, error: r.error, postId: r.post_id, triggeredBy: r.triggered_by, createdAt: r.created_at });

export function listRuns(limit = 50): AgentRun[] {
  return (getDb().prepare('SELECT * FROM seo_runs ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map(toRun);
}
function logRun(r: Omit<AgentRun, 'id' | 'createdAt'>): AgentRun {
  const id = uuid();
  getDb().prepare('INSERT INTO seo_runs (id, task, input, output, model, provider, input_tokens, output_tokens, status, error, post_id, triggered_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, r.task, JSON.stringify(r.input ?? null), JSON.stringify(r.output ?? null), r.model, r.provider, r.inputTokens, r.outputTokens, r.status, r.error, r.postId, r.triggeredBy, now());
  return toRun(getDb().prepare('SELECT * FROM seo_runs WHERE id = ?').get(id));
}

function apiKey(): string | null {
  const stored = getSeoSettings().agent.apiKey;
  if (stored) {
    try {
      return decrypt(stored);
    } catch {
      return null;
    }
  }
  return process.env.ANTHROPIC_API_KEY ?? null;
}
export function agentStatus() {
  const s = getSeoSettings().agent;
  return { enabled: s.enabled, provider: s.provider, model: s.model, keyConfigured: !!apiKey(), autoPublish: s.autoPublish, postsPerWeek: s.postsPerWeek, topicsQueued: s.topics.length, mode: apiKey() ? 'live' : 'fallback' };
}

/** Site facts the model must stay inside – no invented numbers, partners or licences. */
function siteContext(): string {
  const s = getSeoSettings();
  const posts = listPosts({ status: 'published', pageSize: 50 }).items.map((p) => `- ${p.title} (${siteUrl()}${p.url})`).join('\n');
  const rules = listLinkRules(true).map((r) => `- "${r.keyword}" → ${r.url}`).join('\n');
  return `Site: ${s.siteName} (${siteUrl()}).
What BitriPay is: a digital wallet and payment platform for everyday people, market traders, moto-taxi riders, small merchants, agents and diaspora senders. Send and receive money with a QR code or @tag, pay merchants, add money by card, bank transfer, mobile money or a cash agent, hold multi-currency balances, issue virtual cards, pay bills and airtime, send remittances to bank accounts, mobile money wallets or cash pickup. Mobile-money payouts are executed from prefunded local accounts by secured payout devices or approved agents and settled only on verified operator confirmations. Balances are regulated e-money backed 1:1 by safeguarded funds where the platform is authorised; sandbox balances have no real-world value. Fees are shown before every payment.
Audience: ${s.agent.audience}
Markets: ${s.agent.markets.join(', ')}
Tone: ${s.agent.tone}
Hard rules: never invent statistics, licence numbers, partner names, prices or customer quotes. If a number is needed, describe it qualitatively or say it varies by corridor. Do not promise rankings or returns. Write for people who may read on a small phone with patchy data.
Existing articles (link to them where relevant, using their exact URLs):
${posts || '- none yet'}
Site links to use as internal links where natural:
${rules || '- /app/send (Send money), /app/add-money (Add money), /app/cards (Virtual cards), /app/remittance (Remittance), /register (Create account)'}`;
}

interface Draft {
  title: string;
  slug: string;
  excerpt: string;
  metaTitle: string;
  metaDescription: string;
  keywords: string[];
  tags: string[];
  category: string;
  bodyMd: string;
  faq: { question: string; answer: string }[];
  sources: { title: string; url: string }[];
  social: Record<string, string>;
  internalLinks: { keyword: string; url: string }[];
}

const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'slug', 'excerpt', 'metaTitle', 'metaDescription', 'keywords', 'tags', 'category', 'bodyMd', 'faq', 'sources', 'social', 'internalLinks'],
  properties: {
    title: { type: 'string' },
    slug: { type: 'string' },
    excerpt: { type: 'string' },
    metaTitle: { type: 'string' },
    metaDescription: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
    category: { type: 'string' },
    bodyMd: { type: 'string' },
    faq: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['question', 'answer'], properties: { question: { type: 'string' }, answer: { type: 'string' } } } },
    sources: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'url'], properties: { title: { type: 'string' }, url: { type: 'string' } } } },
    social: { type: 'object', additionalProperties: false, required: ['x', 'linkedin', 'facebook', 'whatsapp', 'instagram'], properties: { x: { type: 'string' }, linkedin: { type: 'string' }, facebook: { type: 'string' }, whatsapp: { type: 'string' }, instagram: { type: 'string' } } },
    internalLinks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['keyword', 'url'], properties: { keyword: { type: 'string' }, url: { type: 'string' } } } },
  },
} as const;

async function callClaude<T>(task: string, system: string, user: string, schema: Record<string, unknown>, triggeredBy: string | null): Promise<{ data: T; run: Partial<AgentRun> }> {
  const key = apiKey();
  if (!key) throw new Error('no_api_key');
  const client = new Anthropic({ apiKey: key });
  const model = getSeoSettings().agent.model || 'claude-opus-5';
  const stream = client.messages.stream({
    model,
    max_tokens: 16000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
  } as any);
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new Error(`Model declined the request${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : ''}`);
  const text = message.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  const data = JSON.parse(text) as T;
  return { data, run: { task, model: message.model, provider: 'anthropic', inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens, status: 'ok', triggeredBy } };
}

/** Deterministic fallback writer: a useful, clearly labelled draft when the model is unavailable. */
function fallbackDraft(topic: string, keywords: string[]): Draft {
  const kw = keywords.length ? keywords : [topic.toLowerCase()];
  const title = topic.replace(/\.$/, '');
  const slug = slugify(title);
  const bodyMd = `> Draft written by the BitriPay content assistant in offline mode. An editor must review, add local detail and publish.

## Why this matters

${title} is a daily question for the people BitriPay is built for: market traders, moto-taxi riders, small shops, agents and families sending money home. This guide explains the practical steps, what it costs, and what to watch out for.

## The short answer

- Start from the BitriPay app: **Add money**, **Send money**, **Scan & pay** or **Remittance** depending on what you need.
- Fees and the exchange rate are shown before you confirm. Nothing is taken without your approval on the screen.
- Mobile money payouts are made from a prefunded local account and confirmed by the operator's own message. If the confirmation does not match, the transfer is held and reviewed rather than lost.

## Step by step

1. Open BitriPay and choose the action you need.
2. Enter the amount and the recipient (a phone number, an @tag, a bank account or a QR code).
3. Check the quote: the amount sent, fees, rate and what the recipient receives.
4. Confirm with your fingerprint, face or PIN.
5. Follow the transfer in the app. Every stage is shown, from funding to the operator's confirmation.

## What it costs

Fees depend on the corridor and the method (card, bank, mobile money or cash agent). The app always shows the full cost before you confirm, and the recipient amount is guaranteed when a live exchange rate is locked for the quote.

## Common problems and fixes

- **The recipient did not get an SMS.** Check the number and the operator. The transfer stays held until the operator confirms it.
- **The rate changed.** Quotes expire; the app asks you to re-confirm if the rate moved.
- **You paid twice.** Duplicate references are detected and the second payment is refunded.

## Keep reading

Related guides on this blog cover ${kw.slice(0, 3).join(', ')}. Create a free account to try it with sandbox balances first.`;
  return {
    title,
    slug,
    excerpt: `${title}: a plain-language guide with steps, costs and the mistakes to avoid.`,
    metaTitle: `${title} | BitriPay`,
    metaDescription: `${title}. Steps, fees, safety checks and what to do when something goes wrong, written for people who pay and get paid on a phone.`,
    keywords: kw.slice(0, 6),
    tags: kw.slice(0, 3).map((k) => slugify(k)),
    category: 'guides',
    bodyMd,
    faq: [
      { question: `Is ${kw[0]} safe with BitriPay?`, answer: 'Every payment is approved on your phone with biometrics or a PIN, and a mobile-money payout is only marked complete when the operator confirmation matches the amount, reference and recipient.' },
      { question: 'How long does it take?', answer: 'Wallet-to-wallet payments are instant. Mobile money and bank payouts usually complete within minutes to a few hours during business hours, depending on the operator.' },
      { question: 'What does it cost?', answer: 'Fees vary by corridor and method. The full cost and the recipient amount are always shown before you confirm.' },
    ],
    sources: [],
    social: {
      x: `${title} – a plain guide for people who pay and get paid on a phone. #mobilemoney #fintech`,
      linkedin: `New on the BitriPay blog: ${title}. Practical steps, real costs and the checks that keep money safe.`,
      facebook: `${title}. We wrote it for market traders, riders and families sending money home. Read it on the BitriPay blog.`,
      whatsapp: `${title} – read the short guide on the BitriPay blog.`,
      instagram: `${title}. Link in bio. #bitripay #mobilemoney #qrpayments`,
    },
    internalLinks: [{ keyword: 'send money', url: '/app/send' }, { keyword: 'add money', url: '/app/add-money' }],
  };
}

/** Draft an article for a topic. Returns the created post (status review, or published when autoPublish is on). */
export async function draftArticle(input: { topic: string; keywords?: string[]; language?: string; extraInstructions?: string | null }, actor: Actor, triggeredBy: string | null = null): Promise<{ post: Post; run: AgentRun }> {
  const s = getSeoSettings();
  if (!s.agent.enabled) throw badRequest('The content agent is switched off in SEO settings', 'agent_disabled');
  const language = input.language ?? s.agent.languages[0] ?? 'en';
  let draft: Draft;
  let runMeta: Partial<AgentRun> = { task: 'draft_article', provider: 'anthropic', model: null, inputTokens: 0, outputTokens: 0, status: 'fallback', triggeredBy };
  let error: string | null = null;
  try {
    const r = await callClaude<Draft>(
      'draft_article',
      `You are the editorial writer for ${s.siteName}. Write articles that genuinely help the reader first; search engines and AI answer engines reward pages that answer the question completely, cite sources and read like a person wrote them. Structure for skimming on a phone: a direct answer early, short paragraphs, H2/H3 headings that are real questions or steps, one comparison table where useful, a FAQ of 3-5 questions with complete answers. Use the site's own product terms. Language: ${language}. Never fabricate facts; where facts vary, say so. Return JSON that matches the schema exactly. bodyMd is Markdown (no H1; the title is separate). Include 3-6 sources as real, well-known public references (regulators, operators' official pages, World Bank / GSMA reports) with their canonical URLs, and only ones you are confident exist.\n\n${siteContext()}`,
      `Topic: ${input.topic}\nTarget keywords: ${(input.keywords ?? []).join(', ') || 'choose 4-6 realistic long-tail keywords people actually search'}\n${input.extraInstructions ? `Editor notes: ${input.extraInstructions}\n` : ''}Length: 900-1500 words.`,
      DRAFT_SCHEMA,
      triggeredBy,
    );
    draft = r.data;
    runMeta = { ...runMeta, ...r.run };
  } catch (err) {
    error = (err as Error).message;
    draft = fallbackDraft(input.topic, input.keywords ?? []);
    runMeta = { ...runMeta, status: 'fallback', error: error === 'no_api_key' ? 'No Anthropic API key configured – offline template used' : error };
  }
  const post = createPost({ title: draft.title, slug: draft.slug, excerpt: draft.excerpt, bodyMd: draft.bodyMd, category: draft.category || 'guides', tags: draft.tags, keywords: draft.keywords, language, metaTitle: draft.metaTitle, metaDescription: draft.metaDescription, faq: draft.faq, sources: draft.sources, social: draft.social, status: s.agent.autoPublish && runMeta.status === 'ok' ? 'published' : 'review', source: 'agent', authorName: `${s.siteName} Editorial` }, actor);
  for (const l of draft.internalLinks ?? []) {
    try {
      if (l.url.startsWith('/') || l.url.startsWith(siteUrl())) upsertLinkRule({ keyword: l.keyword, url: l.url.replace(siteUrl(), ''), kind: 'internal', priority: 40 });
    } catch {
      /* skip bad suggestions */
    }
  }
  const run = logRun({ ...(runMeta as AgentRun), task: 'draft_article', input: { topic: input.topic, keywords: input.keywords ?? [], language }, output: { postId: post.id, title: post.title, status: post.status }, postId: post.id, error: runMeta.error ?? null });
  getDb().prepare('UPDATE blog_posts SET agent_run_id = ? WHERE id = ?').run(run.id, post.id);
  recordEvent('admin', post.id, 'seo.agent.drafted', actor, { runId: run.id, status: run.status, model: run.model });
  if (post.status === 'published') void pingIndexNow([post.url]);
  return { post: getPost(post.id, false), run };
}

interface KeywordIdeas {
  ideas: { keyword: string; intent: string; difficulty: 'low' | 'medium' | 'high'; angle: string }[];
}
export async function keywordIdeas(seed: string, actor: Actor): Promise<{ ideas: KeywordIdeas['ideas']; run: AgentRun }> {
  const schema = { type: 'object', additionalProperties: false, required: ['ideas'], properties: { ideas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['keyword', 'intent', 'difficulty', 'angle'], properties: { keyword: { type: 'string' }, intent: { type: 'string' }, difficulty: { type: 'string', enum: ['low', 'medium', 'high'] }, angle: { type: 'string' } } } } } };
  try {
    const r = await callClaude<KeywordIdeas>('keyword_ideas', `You are an SEO strategist for ${getSeoSettings().siteName}. Propose 12 realistic long-tail search queries real people in the site's markets type into Google, Bing, YouTube, TikTok or ask an AI assistant. Prefer questions with clear intent the site can genuinely answer. Difficulty is a judgement of how competitive the query is. Return JSON only.\n\n${siteContext()}`, `Seed topic: ${seed}`, schema, actor.id ?? null);
    const run = logRun({ ...(r.run as AgentRun), input: { seed }, output: r.data, postId: null, error: null });
    return { ideas: r.data.ideas, run };
  } catch (err) {
    const words = seed.toLowerCase().split(/\s+/).filter(Boolean);
    const base = words.join(' ');
    const ideas = [`how to ${base}`, `${base} fees`, `${base} without a bank account`, `${base} in congo`, `${base} in kenya`, `is ${base} safe`, `${base} vs bank transfer`, `best app for ${base}`, `${base} step by step`, `${base} for small business`].map((k) => ({ keyword: k, intent: k.startsWith('how') || k.includes('step') ? 'informational' : k.includes('best') || k.includes('vs') ? 'commercial' : 'informational', difficulty: 'medium' as const, angle: 'Answer directly in the first paragraph, then explain with a local example.' }));
    const run = logRun({ task: 'keyword_ideas', input: { seed }, output: { ideas }, model: null, provider: 'anthropic', inputTokens: 0, outputTokens: 0, status: 'fallback', error: (err as Error).message === 'no_api_key' ? 'No Anthropic API key configured – heuristic ideas used' : (err as Error).message, postId: null, triggeredBy: actor.id ?? null });
    return { ideas, run };
  }
}

interface Audit {
  score: number;
  summary: string;
  issues: { severity: 'high' | 'medium' | 'low'; issue: string; fix: string }[];
  suggestedTitle: string;
  suggestedDescription: string;
}
/** Deterministic on-page checks always run; the model adds editorial judgement when available. */
export async function auditPost(postId: string, actor: Actor): Promise<{ audit: Audit; run: AgentRun }> {
  const post = getPost(postId, false);
  const issues: Audit['issues'] = [];
  const words = post.bodyMd.split(/\s+/).length;
  if (words < 600) issues.push({ severity: 'medium', issue: `Only ${words} words`, fix: 'Expand with concrete steps, a comparison table or a worked example; aim for 900+ words.' });
  const title = post.metaTitle ?? post.title;
  if (title.length > 60) issues.push({ severity: 'medium', issue: `Title is ${title.length} characters`, fix: 'Keep the title under 60 characters so it is not cut off in results.' });
  const desc = post.metaDescription ?? post.excerpt;
  if (!desc || desc.length < 80 || desc.length > 160) issues.push({ severity: 'medium', issue: `Meta description is ${desc?.length ?? 0} characters`, fix: 'Write 120-155 characters that answer the query and invite the click.' });
  if (!post.faq.length) issues.push({ severity: 'low', issue: 'No FAQ', fix: 'Add 3-5 questions with complete answers; they feed FAQ structured data and AI answers.' });
  if (!post.sources.length) issues.push({ severity: 'medium', issue: 'No cited sources', fix: 'Cite 2-4 authoritative references (regulators, operators, GSMA); citations raise trust and earn backlinks.' });
  if (!post.coverUrl) issues.push({ severity: 'low', issue: 'No cover image', fix: 'Add a real photo or product screenshot with descriptive alt text for social previews.' });
  if (!/^##\s/m.test(post.bodyMd)) issues.push({ severity: 'high', issue: 'No H2 headings', fix: 'Break the article into H2/H3 sections phrased as questions or steps.' });
  const kwHits = post.keywords.filter((k) => post.bodyMd.toLowerCase().includes(k.toLowerCase())).length;
  if (post.keywords.length && kwHits < Math.ceil(post.keywords.length / 2)) issues.push({ severity: 'medium', issue: 'Target keywords rarely appear in the body', fix: 'Use each target phrase naturally at least once, ideally in a heading.' });
  const internal = (post.bodyMd.match(/\]\(\//g) ?? []).length;
  if (internal < 2) issues.push({ severity: 'low', issue: `Only ${internal} internal link(s) written in the body`, fix: 'Link to 2-4 related guides or product pages; dynamic links add more automatically.' });
  const base: Audit = { score: Math.max(20, 100 - issues.reduce((s, i) => s + (i.severity === 'high' ? 25 : i.severity === 'medium' ? 12 : 5), 0)), summary: `${issues.length} finding(s) from on-page checks.`, issues, suggestedTitle: title, suggestedDescription: desc ?? '' };
  const schema = { type: 'object', additionalProperties: false, required: ['score', 'summary', 'issues', 'suggestedTitle', 'suggestedDescription'], properties: { score: { type: 'integer' }, summary: { type: 'string' }, issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'issue', 'fix'], properties: { severity: { type: 'string', enum: ['high', 'medium', 'low'] }, issue: { type: 'string' }, fix: { type: 'string' } } } }, suggestedTitle: { type: 'string' }, suggestedDescription: { type: 'string' } } };
  try {
    const r = await callClaude<Audit>('audit_post', `You are a senior SEO editor. Audit the article for search intent match, completeness, E-E-A-T signals, readability on a phone, structured-data opportunities and AI-answer readiness (does the first paragraph answer the question?). Merge the automated findings you are given with your own; keep fixes concrete. Score 0-100. Return JSON only.\n\n${siteContext()}`, `Title: ${post.title}\nMeta title: ${post.metaTitle ?? ''}\nMeta description: ${post.metaDescription ?? ''}\nKeywords: ${post.keywords.join(', ')}\nAutomated findings: ${JSON.stringify(issues)}\n\nArticle (Markdown):\n${post.bodyMd}`, schema, actor.id ?? null);
    const run = logRun({ ...(r.run as AgentRun), input: { postId }, output: r.data, postId, error: null });
    return { audit: r.data, run };
  } catch (err) {
    const run = logRun({ task: 'audit_post', input: { postId }, output: base, model: null, provider: 'anthropic', inputTokens: 0, outputTokens: 0, status: 'fallback', error: (err as Error).message === 'no_api_key' ? 'No Anthropic API key configured – automated checks only' : (err as Error).message, postId, triggeredBy: actor.id ?? null });
    return { audit: base, run };
  }
}

/** Social pack for a post (X, LinkedIn, Facebook, WhatsApp, Instagram); stored on the post for the share panel. */
export async function socialPack(postId: string, actor: Actor): Promise<{ social: Record<string, string>; run: AgentRun }> {
  const post = getPost(postId, false);
  const url = `${siteUrl()}${post.url}`;
  const schema = { type: 'object', additionalProperties: false, required: ['x', 'linkedin', 'facebook', 'whatsapp', 'instagram', 'tiktok'], properties: { x: { type: 'string' }, linkedin: { type: 'string' }, facebook: { type: 'string' }, whatsapp: { type: 'string' }, instagram: { type: 'string' }, tiktok: { type: 'string' } } };
  try {
    const r = await callClaude<Record<string, string>>('social_pack', `Write platform-native social posts announcing an article. X under 260 characters with 2 hashtags; LinkedIn 3 short paragraphs with a hook; Facebook conversational; WhatsApp one friendly line for a broadcast list; Instagram caption with 5 hashtags; TikTok a 30-second script outline. Include the URL ${url} where the platform allows links. Return JSON only.`, `Title: ${post.title}\nExcerpt: ${post.excerpt}\nKey points:\n${post.bodyMd.slice(0, 3000)}`, schema, actor.id ?? null);
    updatePost(postId, { social: r.data }, actor);
    const run = logRun({ ...(r.run as AgentRun), input: { postId }, output: r.data, postId, error: null });
    return { social: r.data, run };
  } catch (err) {
    const social = { x: `${post.title} ${url} #mobilemoney #bitripay`, linkedin: `${post.title}\n\n${post.excerpt}\n\nRead: ${url}`, facebook: `${post.title} – ${post.excerpt} ${url}`, whatsapp: `${post.title}: ${url}`, instagram: `${post.title}. Link in bio. #bitripay #mobilemoney #qrpayments #fintech #africa`, tiktok: `Hook: "${post.title}?" → 3 quick tips from the article → "Full guide on the BitriPay blog".` };
    updatePost(postId, { social }, actor);
    const run = logRun({ task: 'social_pack', input: { postId }, output: social, model: null, provider: 'anthropic', inputTokens: 0, outputTokens: 0, status: 'fallback', error: (err as Error).message === 'no_api_key' ? 'No Anthropic API key configured – template used' : (err as Error).message, postId, triggeredBy: actor.id ?? null });
    return { social, run };
  }
}

/** Scheduler: work through the topic backlog at the configured cadence. */
export async function runContentSchedule(): Promise<{ drafted: number }> {
  const s = getSeoSettings();
  if (!s.agent.enabled || s.agent.postsPerWeek <= 0 || !s.agent.topics.length || config.isTest) return { drafted: 0 };
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const thisWeek = (getDb().prepare("SELECT COUNT(*) c FROM seo_runs WHERE task = 'draft_article' AND created_at >= ?").get(since) as any).c as number;
  if (thisWeek >= s.agent.postsPerWeek) return { drafted: 0 };
  const topic = s.agent.topics[0];
  await draftArticle({ topic }, { type: 'system' }, 'scheduler');
  const { setSetting } = await import('./settings');
  setSetting('seo', { ...s, agent: { ...s.agent, topics: s.agent.topics.slice(1) } });
  return { drafted: 1 };
}

/** Backlink outreach list: sites we cite (outbound) that do not link back yet, plus partner links we track. */
export function outreachCandidates() {
  const cited = new Map<string, { domain: string; urls: Set<string>; posts: string[] }>();
  for (const p of listPosts({ status: 'published', pageSize: 100 }).items) {
    const post = getPost(p.id, false);
    for (const src of post.sources) {
      try {
        const d = new URL(src.url).hostname.replace(/^www\./, '');
        const e = cited.get(d) ?? { domain: d, urls: new Set<string>(), posts: [] };
        e.urls.add(src.url);
        e.posts.push(post.title);
        cited.set(d, e);
      } catch {
        /* ignore */
      }
    }
  }
  const inbound = new Set(listBacklinks({ direction: 'inbound' }).map((b) => b.sourceDomain));
  return [...cited.values()].map((c) => ({ domain: c.domain, citedIn: [...new Set(c.posts)], urls: [...c.urls], linksBack: inbound.has(c.domain) }));
}
