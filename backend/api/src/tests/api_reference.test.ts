/**
 * The published API contract is readable: /v1/docs and /developers/api render every operation the OpenAPI document
 * declares, /v1/openapi.json still serves JSON to machines and the rendered page to a browser, and the page is built
 * from the document itself so the two cannot drift.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp } from './helpers';
import { openApiDocument } from '../docs/openapi';
import { referenceModel, apiReferencePage } from '../docs/reference';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

const doc = () => openApiDocument() as Record<string, any>;
const operationCount = () => Object.values(doc().paths as Record<string, Record<string, unknown>>).reduce((n, methods) => n + Object.keys(methods).length, 0);

describe('API reference', () => {
  it('describes every operation of the document, with no group left out', () => {
    const model = referenceModel();
    expect(model.operationCount).toBe(operationCount());
    expect(model.groups.length).toBe((doc().tags as { name: string }[]).length);
    expect(
      model.groups
        .flatMap((g) => g.operations)
        .map((o) => `${o.method} ${o.path}`)
        .sort(),
    ).toEqual(
      Object.entries(doc().paths as Record<string, Record<string, unknown>>)
        .flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m} ${path}`))
        .sort(),
    );
    expect(model.webhooks.events.length).toBe((doc().components['x-webhooks'].events as unknown[]).length);
    expect(model.errorCodes.length).toBe(Object.keys(doc().components['x-error-codes']).length);
  });

  it('carries the scope, the idempotency requirement, the body fields and a runnable example of an operation', () => {
    const create = referenceModel()
      .groups.flatMap((g) => g.operations)
      .find((o) => o.method === 'post' && o.path === '/payment_intents')!;
    expect(create.scope).toBe('payment_intents:write');
    expect(create.idempotent).toBe(true);
    expect(create.body.map((f) => f.name)).toContain('amount_minor');
    expect(create.body.find((f) => f.name === 'capture_method')!.values).toEqual(['automatic', 'manual']);
    expect(create.sample).toContain('Idempotency-Key');
    expect(create.sample).toContain('-X POST');
    const payload = JSON.parse(create.sample.slice(create.sample.indexOf("-d '") + 4, create.sample.lastIndexOf("'")));
    expect(payload.currency).toBe('CDF');
    expect(Number.isInteger(payload.amount_minor)).toBe(true);
  });

  it('renders one HTML section per group and one card per operation, and escapes what it renders', () => {
    const html = apiReferencePage();
    const model = referenceModel();
    expect(html.split('class="ref-group ref-sect"').length - 1).toBe(model.groups.length);
    expect(html.split('<article class="op"').length - 1).toBe(model.operationCount);
    for (const group of model.groups) expect(html).toContain(`id="${group.slug}"`);
    // Every operation id the sidebar and the scope table link to exists as an anchor on the page.
    for (const op of model.groups.flatMap((g) => g.operations)) expect(html).toContain(`id="${op.id}"`);
    expect(html).not.toContain('<script>alert');
  });

  it('publishes exactly what the predicate allows, so a narrower perimeter needs no second renderer', () => {
    const only = referenceModel(openApiDocument() as Record<string, any>, (op) => op.tag === 'Refunds');
    expect(only.groups.map((g) => g.tag)).toEqual(['Refunds']);
    expect(only.operationCount).toBeGreaterThan(0);
    expect(only.operationCount).toBeLessThan(operationCount());
    const html = apiReferencePage(only);
    expect(html).toContain('Refunds');
    expect(html.split('<article class="op"').length - 1).toBe(only.operationCount);
  });

  it('serves the reference at /v1/docs, at /api/v1/docs and at /developers/api', async () => {
    for (const path of ['/v1/docs', '/api/v1/docs', '/developers/api']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers['content-type'], path).toMatch(/html/);
      expect(res.text, path).toContain('API reference');
      expect(res.text, path).toContain('/payment_intents');
    }
  });

  it('answers /v1/openapi.json with JSON for machines and with the reference for a browser', async () => {
    const json = await request(app).get('/v1/openapi.json').set('Accept', '*/*');
    expect(json.status).toBe(200);
    expect(json.headers['content-type']).toMatch(/json/);
    expect(json.headers.vary).toMatch(/Accept/);
    expect(json.body.openapi).toBe('3.1.0');

    const explicit = await request(app).get('/v1/openapi.json').set('Accept', 'application/json');
    expect(explicit.headers['content-type']).toMatch(/json/);

    const browser = await request(app).get('/v1/openapi.json').set('Accept', 'text/html,application/xhtml+xml,*/*;q=0.8');
    expect(browser.status).toBe(200);
    expect(browser.headers['content-type']).toMatch(/html/);
    expect(browser.text).toContain('API reference');

    // A browser that asks for the document anyway still gets the document.
    const forced = await request(app).get('/v1/openapi.json?format=json').set('Accept', 'text/html,*/*;q=0.8');
    expect(forced.headers['content-type']).toMatch(/json/);
    expect(forced.body.openapi).toBe('3.1.0');
  });
});
