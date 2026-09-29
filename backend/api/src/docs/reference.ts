/**
 * Human-readable rendering of the OpenAPI document: the same operations, scopes, parameters, request bodies,
 * responses, webhook events and error families that /v1/openapi.json publishes, grouped by tag and laid out for a
 * person to read. The JSON document stays the single source of truth — this page never states anything the document
 * does not contain, so the two can never drift. Served at /v1/docs and /api/v1/docs; /v1/openapi.json answers with
 * this page when the caller asks for HTML (a browser) and with the JSON for everyone else.
 *
 * `referenceModel()` takes an optional `include` predicate: the published surface is filtered in exactly one place,
 * so a narrower published perimeter later is a predicate, not a rewrite.
 */
import { layout } from '../site/render';
import { escapeHtml } from '../services/markdown';
import { absoluteUrl, breadcrumbJsonLd, pageTitle } from '../services/seo';
import { getSeoSettings } from '../services/settings';
import { openApiDocument } from './openapi';
import { API_KEY_SCOPES } from '../services/merchant';
import { config } from '../config';

export interface RefParam {
  name: string;
  in: string;
  required: boolean;
  type: string;
}
export interface RefField {
  name: string;
  type: string;
  values: string[];
  description: string;
}
export interface RefOperation {
  id: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  scope: string | null;
  idempotent: boolean;
  params: RefParam[];
  body: RefField[];
  bodyFree: boolean;
  responses: { status: string; description: string }[];
  sample: string;
}
export interface RefGroup {
  tag: string;
  slug: string;
  operations: RefOperation[];
}
export interface ReferenceModel {
  title: string;
  version: string;
  description: string;
  servers: string[];
  groups: RefGroup[];
  operationCount: number;
  scopes: { scope: string; description: string }[];
  keyDescription: string;
  keyKinds: string;
  webhooks: { signature: string; retries: string; events: { type: string; description: string }[] };
  errorCodes: { code: string; bp: string }[];
}

type Json = Record<string, any>;

const METHOD_ORDER = ['get', 'post', 'patch', 'put', 'delete'];

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** One line describing a JSON-schema fragment, as a reader would say it out loud. */
function schemaType(schema: Json | undefined): string {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum)) return 'string';
  if (schema.type === 'array') return `array of ${schemaType(schema.items)}`;
  if (schema.type === 'object' && schema.properties) return `object { ${Object.keys(schema.properties).join(', ')} }`;
  if (typeof schema.type === 'string') return schema.type;
  return 'any';
}

function constraints(schema: Json | undefined): string {
  if (!schema) return '';
  const bits: string[] = [];
  if (typeof schema.minLength === 'number' && schema.minLength === schema.maxLength) bits.push(`exactly ${schema.minLength} characters`);
  else {
    if (typeof schema.minLength === 'number') bits.push(`at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number') bits.push(`at most ${schema.maxLength} characters`);
  }
  return bits.join(', ');
}

/** A value a reader can send as-is, derived from the field name and its declared type. */
function sampleValue(name: string, schema: Json | undefined): unknown {
  const s = schema ?? {};
  if (Array.isArray(s.enum)) return s.enum[0];
  if (s.type === 'array') return [sampleValue(name.replace(/s$/, ''), s.items)];
  if (s.type === 'object') return s.properties ? Object.fromEntries(Object.entries(s.properties as Json).map(([k, v]) => [k, sampleValue(k, v as Json)])) : { order: 'A-1042' };
  if (s.type === 'boolean') return true;
  if (s.type === 'integer' || s.type === 'number') {
    if (/bps/.test(name)) return 150;
    if (/minor/.test(name)) return 250000;
    if (/minutes/.test(name)) return 30;
    if (/seconds/.test(name)) return 600;
    if (/limit|count/.test(name)) return 20;
    return 1;
  }
  if (/rail/.test(name)) return 'national_switch';
  if (/recipient/.test(name)) return 'acct_...';
  if (/currency/.test(name)) return 'CDF';
  if (/country/.test(name)) return 'CD';
  if (/email/.test(name)) return 'owner@example.com';
  if (/msisdn|phone/.test(name)) return '+243810000000';
  if (/_url$/.test(name)) return 'https://example.com/return';
  if (/reference|order/.test(name)) return 'order-1042';
  if (/business_name/.test(name)) return 'Pharmacie Lumiere';
  if (/description|label|reason|note/.test(name)) return 'Order 1042';
  if (/payment_intent|intent/.test(name)) return 'pi_...';
  if (/account/.test(name)) return 'acct_...';
  if (/pin/.test(name)) return '0000';
  if (/date|_at$/.test(name)) return '2026-09-01';
  return '...';
}

function curlSample(op: RefOperation, base: string, bodySchema: Json | undefined): string {
  const verb = op.method.toUpperCase();
  const lines = [
    `curl${verb === 'GET' ? '' : ` -X ${verb}`} ${base}${op.path}${
      op.params.some((p) => p.in === 'query')
        ? `?${op.params
            .filter((p) => p.in === 'query')
            .map((p) => `${p.name}=`)
            .join('&')}`
        : ''
    } \\`,
  ];
  lines.push(`  -H "Authorization: Bearer sk_test_..." \\`);
  if (op.idempotent) lines.push(`  -H "Idempotency-Key: ${sampleValue('reference', { type: 'string' })}" \\`);
  const props = (bodySchema?.properties ?? {}) as Json;
  const keys = Object.keys(props);
  if (keys.length) {
    lines.push(`  -H "Content-Type: application/json" \\`);
    const sample = Object.fromEntries(keys.map((k) => [k, sampleValue(k, props[k] as Json)]));
    lines.push(`  -d '${JSON.stringify(sample, null, 2).split('\n').join('\n     ')}'`);
  } else if (verb !== 'GET') {
    lines.push(`  -H "Content-Type: application/json" -d '{}'`);
  }
  const last = lines[lines.length - 1];
  lines[lines.length - 1] = last.endsWith(' \\') ? last.slice(0, -2) : last;
  return lines.join('\n');
}

const RESPONSE_NOTES: Record<string, string> = {
  '200': 'The object, or a list under `data`.',
  '201': 'Created; the new object is returned in full.',
  '4XX': 'Error envelope: `error.code`, `error.bp` (stable family) and `error.message`.',
};

/**
 * Turn the published document into the shape the page renders. `include` decides which operations are described;
 * it defaults to all of them, which is what the document itself publishes today.
 */
export function referenceModel(doc: Json = openApiDocument() as Json, include: (op: RefOperation) => boolean = () => true): ReferenceModel {
  const base = String((doc.servers?.[0]?.url as string) ?? `${config.webUrl}/v1`);
  const byTag = new Map<string, RefOperation[]>();
  let count = 0;
  for (const [path, methods] of Object.entries(doc.paths as Json)) {
    for (const [method, raw] of Object.entries(methods as Json)) {
      const o = raw as Json;
      const bodySchema = o.requestBody?.content?.['application/json']?.schema as Json | undefined;
      const props = (bodySchema?.properties ?? {}) as Json;
      const op: RefOperation = {
        id: String(o.operationId ?? `${method}_${slugify(path)}`),
        method,
        path,
        tag: String(o.tags?.[0] ?? 'Other'),
        summary: String(o.summary ?? ''),
        scope: (o['x-scope'] as string) ?? null,
        idempotent: (o.parameters ?? []).some((p: Json) => p.name === 'Idempotency-Key'),
        params: (o.parameters ?? [])
          .filter((p: Json) => p.name !== 'Idempotency-Key')
          .map((p: Json) => ({ name: String(p.name), in: String(p.in), required: Boolean(p.required), type: schemaType(p.schema) })),
        body: Object.entries(props).map(([name, schema]) => {
          const s = schema as Json;
          return {
            name,
            type: schemaType(s),
            values: Array.isArray(s.enum) ? s.enum.map(String) : [],
            description: [s.description ? String(s.description) : '', constraints(s)].filter(Boolean).join(' · '),
          };
        }),
        bodyFree: Boolean(o.requestBody) && Object.keys(props).length === 0,
        responses: Object.keys(o.responses ?? {}).map((status) => ({ status, description: RESPONSE_NOTES[status] ?? String(o.responses[status]?.description ?? '') })),
        sample: '',
      };
      if (!include(op)) continue;
      op.sample = curlSample(op, base, bodySchema);
      count += 1;
      const list = byTag.get(op.tag) ?? [];
      list.push(op);
      byTag.set(op.tag, list);
    }
  }
  const order = (doc.tags as Json[] | undefined)?.map((t) => String(t.name)) ?? [...byTag.keys()];
  const groups: RefGroup[] = order
    .filter((tag) => byTag.has(tag))
    .map((tag) => ({
      tag,
      slug: slugify(tag),
      operations: (byTag.get(tag) ?? []).sort((a, b) => a.path.localeCompare(b.path) || METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method)),
    }));
  const hooks = (doc.components?.['x-webhooks'] ?? {}) as Json;
  return {
    title: String(doc.info?.title ?? `${config.appName} API`),
    version: String(doc.info?.version ?? ''),
    description: String(doc.info?.description ?? ''),
    servers: (doc.servers as Json[] | undefined)?.map((s) => String(s.url)) ?? [],
    groups,
    operationCount: count,
    scopes: API_KEY_SCOPES.map((scope) => ({ scope, description: '' })),
    keyDescription: String(doc.components?.securitySchemes?.apiKey?.description ?? ''),
    // The document names the key kinds and then lists every scope inside brackets; the card shows the kinds and the
    // Scopes section below shows the list, so neither is a wall of text.
    keyKinds: String(doc.components?.securitySchemes?.apiKey?.description ?? '').replace(/\s*\([^)]*\)/g, ''),
    webhooks: {
      signature: String(hooks.signature ?? ''),
      retries: String(hooks.retries ?? ''),
      // The document publishes the catalogue with a receiver note per event; a bare list of names is accepted too.
      events: ((hooks.events as unknown[] | undefined) ?? []).map((e) =>
        typeof e === 'string' ? { type: e, description: '' } : { type: String((e as Json).type ?? ''), description: String((e as Json).description ?? '') },
      ),
    },
    errorCodes: Object.entries((doc.components?.['x-error-codes'] ?? {}) as Record<string, string>).map(([code, bp]) => ({ code, bp })),
  };
}

const REF_CSS = `
.ref-hero{padding-block:18px 8px}.ref-hero h1{margin:0 0 10px}.ref-hero p{color:var(--muted);max-width:66ch;font-size:19px}
.ref-meta{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0}
.chip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--line);background:var(--paper);color:var(--muted);text-decoration:none}
.chip b{color:var(--ink);font-weight:600}
.ref{display:grid;grid-template-columns:232px minmax(0,1fr);gap:36px;align-items:start;margin-top:26px}
.ref > *{min-width:0}.op{min-width:0}.op-head code{min-width:0}
.ref aside{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow:auto;border:1px solid var(--line);border-radius:14px;background:var(--paper);padding:14px}
.ref aside b{display:block;font-family:var(--mono);font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:10px 0 6px}
.ref aside a{display:block;padding:5px 8px;border-radius:8px;color:var(--ink);text-decoration:none;font-size:14.5px}
.ref aside a:hover{background:var(--bg)}
.ref aside input{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--ink);font:inherit;font-size:14px}
.ref-group{display:block}
.ref-sect{margin-block:34px}.ref-sect h2{margin:0 0 6px}.ref-sect .lead{color:var(--muted);max-width:72ch;margin:0 0 16px}
.notecards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.notecard{border:1px solid var(--line);border-radius:14px;padding:16px 18px;background:var(--paper)}
.notecard h3{margin:0 0 6px;font-size:17px}.notecard p{margin:0 0 8px;color:var(--muted);font-size:14.5px}.notecard p:last-child{margin-bottom:0}
.op{border:1px solid var(--line);border-radius:14px;background:var(--paper);padding:16px 18px;margin:0 0 14px;min-width:0}
.op-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.op-head code{font-family:var(--mono);font-size:15px;color:var(--ink);word-break:break-all}
.m{font-family:var(--mono);font-size:11.5px;font-weight:600;letter-spacing:.06em;padding:3px 9px;border-radius:7px;border:1px solid transparent;color:#fff}
.m.get{background:#0b6e4f}.m.post{background:#1f4fd8}.m.patch{background:#8a5a00}.m.put{background:#8a5a00}.m.delete{background:#b42318}
.op p.sum{margin:10px 0 0;color:var(--ink)}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
.badge{font-family:var(--mono);font-size:11.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.badge.scope{background:#eef0ff;color:#2E2A7B;border-color:#d7dbff}.badge.idem{background:#fbf0dc;color:#8a5a00;border-color:#f1d9a6}.badge.pub{background:#e3f4ec;color:#0b6e4f;border-color:#bfe3d1}
@media (prefers-color-scheme:dark){.badge.scope{background:#23234f;color:#b3aef5;border-color:#3a3a74}.badge.idem{background:#3a2e12;color:#f5b04a;border-color:#5c4718}.badge.pub{background:#123425;color:#4fd48b;border-color:#1d5138}}
.op details{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
.op details summary{cursor:pointer;font-family:var(--mono);font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.op details[open] summary{margin-bottom:10px}
.op .tw{overflow-x:auto}
.op table{border-collapse:collapse;width:100%;font-size:14px}.op th,.op td{border-bottom:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
.op th{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.op td code,.op td .t{font-family:var(--mono);font-size:12.5px}
.req{font-family:var(--mono);font-size:11px;color:#b42318}
pre.sample{background:#0f172a;color:#e2e8f0;border-radius:11px;padding:13px 15px;font-family:var(--mono);font-size:12.5px;line-height:1.55;overflow-x:auto;margin:10px 0 0}
.evgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:6px}
.evgrid code{font-family:var(--mono);font-size:12.5px;color:var(--muted)}
.ref-empty{display:none;color:var(--muted)}
@media (max-width:900px){.ref{grid-template-columns:1fr}.ref aside{position:static;max-height:300px}}
`;

const FILTER_JS = `
(function(){
  var box=document.getElementById('ref-filter');if(!box)return;
  var ops=[].slice.call(document.querySelectorAll('article.op'));
  var sections=[].slice.call(document.querySelectorAll('section.ref-group'));
  var empty=document.getElementById('ref-empty');
  box.addEventListener('input',function(){
    var q=box.value.trim().toLowerCase();
    ops.forEach(function(o){o.style.display=!q||o.getAttribute('data-q').indexOf(q)>-1?'':'none';});
    var shown=0;
    sections.forEach(function(s){
      var here=[].slice.call(s.querySelectorAll('article.op')).filter(function(o){return o.style.display!=='none';}).length;
      s.style.display=here?'':'none';if(here)shown++;
      var lead=s.querySelector('p.lead'),total=lead&&lead.getAttribute('data-total');
      if(lead)lead.textContent=q&&here!==Number(total)?here+' of '+total+' operations match.':total+(total==='1'?' operation.':' operations.');
    });
    if(empty)empty.style.display=shown?'none':'block';
  });
})();
`;

function paramTable(op: RefOperation): string {
  if (!op.params.length) return '';
  return `<details${op.params.some((p) => p.required) ? ' open' : ''}><summary>Parameters (${op.params.length})</summary><div class="tw"><table><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th></tr>${op.params
    .map(
      (p) =>
        `<tr><td><code>${escapeHtml(p.name)}</code></td><td>${escapeHtml(p.in)}</td><td><span class="t">${escapeHtml(p.type)}</span></td><td>${p.required ? '<span class="req">required</span>' : 'optional'}</td></tr>`,
    )
    .join('')}</table></div></details>`;
}

function bodyTable(op: RefOperation): string {
  if (op.bodyFree)
    return `<details><summary>Request body</summary><p style="color:var(--muted);font-size:14.5px;margin:0">A JSON object. The fields this operation reads are listed in the guide for its tag; unknown fields are refused rather than ignored.</p></details>`;
  if (!op.body.length) return '';
  return `<details><summary>Request body (${op.body.length} fields)</summary><div class="tw"><table><tr><th>Field</th><th>Type</th><th>Accepted values</th><th>Notes</th></tr>${op.body
    .map(
      (f) =>
        `<tr><td><code>${escapeHtml(f.name)}</code></td><td><span class="t">${escapeHtml(f.type)}</span></td><td>${f.values.length ? f.values.map((v) => `<code>${escapeHtml(v)}</code>`).join(' · ') : '—'}</td><td>${escapeHtml(f.description) || '—'}</td></tr>`,
    )
    .join('')}</table></div></details>`;
}

function responseList(op: RefOperation): string {
  if (!op.responses.length) return '';
  return `<details><summary>Responses</summary><div class="tw"><table><tr><th>Status</th><th>Body</th></tr>${op.responses
    .map((r) => `<tr><td><code>${escapeHtml(r.status)}</code></td><td>${escapeHtml(r.description)}</td></tr>`)
    .join('')}</table></div></details>`;
}

function operationCard(op: RefOperation): string {
  const haystack = [op.method, op.path, op.summary, op.tag, op.scope ?? '', ...op.body.map((b) => b.name)].join(' ').toLowerCase();
  const badges = [
    op.scope ? `<span class="badge scope">${escapeHtml(op.scope)}</span>` : '<span class="badge pub">no scope</span>',
    op.idempotent ? '<span class="badge idem">Idempotency-Key</span>' : '',
  ]
    .filter(Boolean)
    .join('');
  return `<article class="op" id="${escapeHtml(op.id)}" data-q="${escapeHtml(haystack)}">
<div class="op-head"><span class="m ${escapeHtml(op.method)}">${escapeHtml(op.method.toUpperCase())}</span><code>${escapeHtml(op.path)}</code><span class="badges">${badges}</span></div>
<p class="sum">${escapeHtml(op.summary)}</p>
${paramTable(op)}${bodyTable(op)}${responseList(op)}
<details><summary>Example request</summary><pre class="sample">${escapeHtml(op.sample)}</pre></details>
</article>`;
}

/** The whole reference as one server-rendered page. */
export function apiReferencePage(model: ReferenceModel = referenceModel()): string {
  const seo = getSeoSettings();
  const nav = model.groups.map((g) => `<a href="#${g.slug}">${escapeHtml(g.tag)} <span style="color:var(--muted)">${g.operations.length}</span></a>`).join('');
  const sections = model.groups
    .map(
      (g) =>
        `<section class="ref-group ref-sect" id="${g.slug}"><h2>${escapeHtml(g.tag)}</h2><p class="lead" data-total="${g.operations.length}">${g.operations.length} operation${g.operations.length > 1 ? 's' : ''}.</p>${g.operations.map(operationCard).join('')}</section>`,
    )
    .join('');
  const families = [
    ['BP-1xxx', 'Authentication and authorisation', 'The key, the session, the role or the scope does not allow the call.'],
    ['BP-2xxx', 'Validation', 'The request itself is wrong: a field, an amount, a JSON body, a reused idempotency key.'],
    ['BP-3xxx', 'Ledger', 'The money cannot move: balance, freeze, limit, fee or a Guardian halt.'],
    ['BP-4xxx', 'Rail', 'No rail can carry the payment right now, or the route was refused.'],
    ['BP-5xxx', 'Compliance', 'Risk, velocity, cooling-off, KYC tier or sanctions stopped the operation.'],
    ['BP-6xxx', 'Intelligence', 'A metered assistant operation could not run (units, policy, model).'],
  ];
  const body = `<style>${REF_CSS}</style>
<div class="breadcrumb"><a href="/">${escapeHtml(seo.siteName)}</a> / <a href="/developers">Developers</a> / API reference</div>
<div class="ref-hero"><h1>API reference</h1>
<p>Every operation BitriPay publishes, in the order you will meet them: what it does, which scope it needs, what it takes and what it returns. This page and <a href="/v1/openapi.json?format=json">the OpenAPI document</a> are generated from the same table, so they cannot disagree.</p>
<div class="ref-meta"><span class="chip">Version <b>${escapeHtml(model.version)}</b></span><span class="chip">Operations <b>${model.operationCount}</b></span><span class="chip">Groups <b>${model.groups.length}</b></span><span class="chip">Webhook events <b>${model.webhooks.events.length}</b></span><a class="chip" href="/v1/openapi.json?format=json">OpenAPI 3.1 JSON</a><a class="chip" href="/v1/keys">Signing keys</a><a class="chip" href="/v1/status">Status</a></div></div>

<section class="ref-sect"><h2>Before the first call</h2><div class="notecards">
<div class="notecard"><h3>Base URL</h3>${model.servers.map((s) => `<p><code>${escapeHtml(s)}</code></p>`).join('')}<p>Test and live keys share it; the key decides which world you are in.</p></div>
<div class="notecard"><h3>Authentication</h3><p><code>Authorization: Bearer sk_test_…</code> on every call.</p><p>${escapeHtml(model.keyKinds)}</p><p><a href="#scopes">The ${model.scopes.length} scopes</a>, and which operation each one opens.</p></div>
<div class="notecard"><h3>Idempotency</h3><p>Operations marked <span class="badge idem">Idempotency-Key</span> require that header. A replay returns the same object; the same key with a different body is refused with <code>idempotency_key_reused</code>. Keys expire after 24 hours.</p></div>
<div class="notecard"><h3>Amounts</h3><p>Integers in minor units, with the currency beside them: <code>250000</code> + <code>CDF</code> is 2 500,00 CDF. No floating point anywhere in the API.</p></div>
<div class="notecard"><h3>Errors</h3><p>Every failure returns the same envelope: <code>error.code</code>, <code>error.bp</code> and <code>error.message</code>. Branch on <code>bp</code> — it is stable across releases.</p></div>
<div class="notecard"><h3>Acting for a customer</h3><p>Send <code>BitriPay-Account: acct_…</code> with your own key to run any operation for a connected account. Your scopes still apply, and the customer stays the merchant of record.</p></div>
</div></section>

<div class="ref"><aside><label for="ref-filter" style="display:block;font-family:var(--mono);font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Filter</label><input id="ref-filter" type="search" placeholder="intent, refund, scope…" autocomplete="off"><b>Groups</b>${nav}<b>Reference</b><a href="#webhooks">Webhooks</a><a href="#errors">Error codes</a><a href="#scopes">Scopes</a></aside>
<div><p id="ref-empty" class="ref-empty">No operation matches that filter.</p>${sections}

<section class="ref-sect" id="webhooks"><h2>Webhooks</h2><p class="lead">BitriPay posts every event to your endpoint at least once and signs it twice. Deduplicate on the event id; answer 2xx quickly and do your work afterwards.</p>
<div class="notecards"><div class="notecard"><h3>Signature</h3><p><code>${escapeHtml(model.webhooks.signature)}</code></p></div>
<div class="notecard"><h3>Retries</h3><p>${escapeHtml(model.webhooks.retries)}</p></div></div>
<h3>Events (${model.webhooks.events.length})</h3><div class="op"><div class="tw"><table><tr><th>Event</th><th>Sent when</th></tr>${model.webhooks.events
    .map((e) => `<tr><td><code>${escapeHtml(e.type)}</code></td><td>${escapeHtml(e.description) || '—'}</td></tr>`)
    .join('')}</table></div></div></section>

<section class="ref-sect" id="errors"><h2>Error codes</h2><p class="lead">The descriptive <code>code</code> tells a human what happened; the numeric <code>bp</code> family is what your code should branch on.</p>
<div class="op"><div class="tw"><table><tr><th>Family</th><th>Meaning</th><th>When you see it</th></tr>${families.map((f) => `<tr><td><code>${f[0]}</code></td><td>${f[1]}</td><td>${f[2]}</td></tr>`).join('')}</table></div></div>
<div class="op"><div class="tw"><table><tr><th>Code</th><th>BP</th></tr>${model.errorCodes.map((e) => `<tr><td><code>${escapeHtml(e.code)}</code></td><td><code>${escapeHtml(e.bp)}</code></td></tr>`).join('')}</table></div></div></section>

<section class="ref-sect" id="scopes"><h2>Scopes</h2><p class="lead">A restricted key (<code>rk_</code>) holds only the scopes you choose; a missing scope returns <code>scope_denied</code>. Secret keys (<code>sk_</code>) carry them all.</p>
<div class="op"><div class="tw"><table><tr><th>Scope</th><th>Operations</th></tr>${model.scopes
    .map((s) => {
      const ops = model.groups.flatMap((g) => g.operations).filter((o) => o.scope === s.scope);
      return `<tr><td><code>${escapeHtml(s.scope)}</code></td><td>${ops.length ? ops.map((o) => `<a href="#${escapeHtml(o.id)}"><code>${escapeHtml(o.method.toUpperCase())} ${escapeHtml(o.path)}</code></a>`).join('<br>') : '—'}</td></tr>`;
    })
    .join('')}</table></div></div></section>
</div></div>
<script>${FILTER_JS}</script>`;
  return layout(
    {
      title: pageTitle('API reference'),
      description: `Readable reference for the ${escapeHtml(model.title)} (${model.operationCount} operations, version ${model.version}): authentication, idempotency, every operation with its scope, parameters, body and responses, webhook events and error codes.`,
      path: '/v1/docs',
      jsonLd: [
        breadcrumbJsonLd([
          { name: seo.siteName, url: '/' },
          { name: 'Developers', url: '/developers' },
          { name: 'API reference', url: '/v1/docs' },
        ]),
        { '@context': 'https://schema.org', '@type': 'TechArticle', name: `${model.title} reference`, url: absoluteUrl('/v1/docs'), about: 'Payment API', version: model.version },
      ],
    },
    body,
  );
}
