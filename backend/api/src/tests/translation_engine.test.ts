/**
 * Translation engine: phrase coverage per language, the engine fills only what is missing through an injected
 * translator, refuses answers that drop a placeholder, stores the rest as overrides, and the public translations
 * endpoint serves them to the apps.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, adminToken } from './helpers';
import { missingPhrases, translateMissing, translationStatus } from '../services/translationEngine';
import { PHRASES } from '@bitripay/shared';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

describe('translation engine', () => {
  it('reports coverage: French complete, Lingala falls back to French, Spanish missing every phrase', async () => {
    const admin = await adminToken(app);
    const fr = await request(app).get('/api/admin/translations/fr/status').set(admin.auth);
    expect(fr.status).toBe(200);
    expect(fr.body.missing).toBe(0);
    expect(fr.body.total).toBe(PHRASES.length);
    expect(translationStatus('ln').fallback).toBe('fr');
    expect(missingPhrases('es').length).toBe(PHRASES.length);
  });

  it('translates only the missing phrases, keeps placeholders, and serves the result to the apps', async () => {
    const admin = await adminToken(app);
    const seen: string[][] = [];
    const withPlaceholder = PHRASES.filter((p) => /\{\d+\}/.test(p));
    // a translator that prefixes everything and, for phrases with placeholders, drops them (which the engine must refuse)
    const translator = async (_lang: string, _name: string, phrases: string[]) => {
      seen.push(phrases);
      return Object.fromEntries(phrases.map((p) => [p, `ES:${p.replace(/\{\d+\}/g, '')}`]));
    };
    const r = await translateMissing('es', admin.user?.id ?? 'admin', { translator, batchSize: 80 });
    expect(seen.length).toBe(Math.ceil(PHRASES.length / 80));
    expect(r.requested).toBe(PHRASES.length);
    expect(r.stored).toBe(PHRASES.length - withPlaceholder.length);
    expect(r.rejected.sort()).toEqual([...withPlaceholder].sort());
    expect(missingPhrases('es').sort()).toEqual([...withPlaceholder].sort());
    const pub = await request(app).get('/api/translations/es');
    expect(pub.status).toBe(200);
    expect(pub.body.overrides['Add money']).toBe('ES:Add money');
    // a second run resends only what is still missing
    const again = await translateMissing('es', 'admin', { translator: async (_l, _n, ps) => (seen.push(ps), {}), batchSize: 80 });
    expect(again.requested).toBe(withPlaceholder.length);
    expect(seen[seen.length - 1]).not.toContain('Add money');
    expect(again.stored).toBe(0);
    const status = await request(app).get('/api/admin/translations/es/status').set(admin.auth);
    expect(status.body.translated).toBe(PHRASES.length - withPlaceholder.length);
  });

  it('refuses the source language and unknown languages', async () => {
    await expect(translateMissing('en', 'admin', { translator: async () => ({}) })).rejects.toThrow(/source language/);
    await expect(translateMissing('xx', 'admin', { translator: async () => ({}) })).rejects.toThrow(/Unknown language/);
  });
});
