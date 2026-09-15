/**
 * Translation engine for the phrase catalogue: what the web app shows in English (shared `PHRASES`) is translated by
 * phrase. French ships hand-written; for the other languages an administrator runs the engine from the console, which
 * translates the phrases still missing with the platform's model (same key and model as the content agent) and
 * stores them as translation overrides, where they can be corrected by hand. Placeholders such as {0} are preserved
 * or the batch is refused. Nothing is invented for languages the model cannot serve: an empty answer stays missing.
 */
import Anthropic from '@anthropic-ai/sdk';
import { LOCALES, LOCALE_FALLBACKS, PHRASES } from '@bitripay/shared';
import { badRequest, unprocessable } from '../lib/errors';
import { decrypt } from '../lib/crypto';
import { config } from '../config';
import { getSeoSettings } from './settings';
import { getTranslationOverrides, setTranslationOverrides, listLanguages } from './cms';
import { audit } from './audit';

export type Translator = (lang: string, langName: string, phrases: string[]) => Promise<Record<string, string>>;

const LANGUAGE_NOTES: Record<string, string> = {
  ln: 'Lingala as spoken in Kinshasa; keep French loanwords that Lingala speakers use for banking terms.',
  kg: 'Kikongo (Kikongo ya leta) as spoken in Kongo-Central and Kinshasa.',
  lua: 'Tshiluba as spoken in Kasaï.',
  sw: 'Swahili as spoken in the eastern DRC and East Africa.',
  ar: 'Modern Standard Arabic; the app renders right-to-left.',
};

function apiKey(): string | null {
  const stored = getSeoSettings().agent.apiKey;
  if (stored) {
    try {
      return decrypt(stored);
    } catch {
      return null;
    }
  }
  return config.anthropicApiKey || null;
}

/** Phrases the app would show in English (or in the regional fallback) for this language. */
export function missingPhrases(lang: string): string[] {
  const pack = LOCALES[lang] ?? {};
  const overrides = getTranslationOverrides(lang);
  return PHRASES.filter((p) => !pack[p] && !overrides[p]);
}

export function translationStatus(lang: string) {
  const missing = missingPhrases(lang);
  const fallback = LOCALE_FALLBACKS[lang] ?? null;
  return {
    lang,
    total: PHRASES.length,
    translated: PHRASES.length - missing.length,
    missing: missing.length,
    fallback,
    engineReady: !!apiKey(),
    model: getSeoSettings().agent.model,
  };
}

const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join(',');

/** Default translator: one model call per batch, strict JSON in and out. */
export const modelTranslator: Translator = async (lang, langName, phrases) => {
  const key = apiKey();
  if (!key) throw unprocessable('No model API key is configured (Blog & SEO → content agent)', 'engine_not_configured');
  const client = new Anthropic({ apiKey: key });
  const note = LANGUAGE_NOTES[lang] ? ` ${LANGUAGE_NOTES[lang]}` : '';
  const message = await client.messages.create({
    model: getSeoSettings().agent.model,
    max_tokens: 8000,
    system: `You translate the user interface of BitriPay, a payments app (wallets, QR payments, mobile money, agents, merchants) used in the Democratic Republic of the Congo and abroad. Translate each English phrase into ${langName} (${lang}).${note} Rules: keep placeholders like {0} and {1} exactly; keep product names (BitriPay, Orange Money, M-Pesa), currency codes, API paths, HTTP methods, header names and technical identifiers unchanged; keep the tone plain and respectful; keep emoji and arrows where present; never add explanations. Answer with a single JSON object mapping each English phrase to its translation and nothing else.`,
    messages: [{ role: 'user', content: JSON.stringify(phrases) }],
  });
  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('')
    .trim();
  const json = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw unprocessable('The model did not answer with a JSON object', 'engine_bad_answer');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  return out;
};

/** Translate the phrases still missing for a language, in batches; returns what was stored and what stayed missing. */
export async function translateMissing(lang: string, adminId: string, opts: { translator?: Translator; batchSize?: number; limit?: number } = {}) {
  if (lang === 'en') throw badRequest('English is the source language', 'source_language');
  const language = listLanguages().find((l) => l.code === lang);
  if (!language) throw badRequest(`Unknown language ${lang}`, 'unknown_language');
  const translator = opts.translator ?? modelTranslator;
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 40, 80));
  const todo = missingPhrases(lang).slice(0, opts.limit ?? Infinity);
  const stored: Record<string, string> = {};
  const rejected: string[] = [];
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const answer = await translator(lang, language.name, batch);
    for (const p of batch) {
      const t = answer[p];
      if (!t || t === p || placeholders(t) !== placeholders(p)) {
        if (t && t !== p) rejected.push(p);
        continue;
      }
      stored[p] = t;
    }
  }
  if (Object.keys(stored).length) setTranslationOverrides(lang, { ...getTranslationOverrides(lang), ...stored });
  audit(adminId, 'translations.engine', 'language', lang, { requested: todo.length, stored: Object.keys(stored).length, rejected: rejected.length });
  return { ...translationStatus(lang), requested: todo.length, stored: Object.keys(stored).length, rejected };
}
