/**
 * Renders the OpenAPI operation table as a VS Code REST Client file (docs-api.http at the repository root), so the
 * quick reference can never drift from the served contract. Regenerate with `npm run docs:http`.
 */
import { openApiDocument } from './openapi';

export function renderHttpFile(doc = openApiDocument()): string {
  const out: string[] = [];
  out.push(`### ${doc.info.title} quick reference (VS Code REST Client format) — generated from GET /api/v1/openapi.json, do not edit by hand`);
  out.push(`### Merchant keys: sk_live_/sk_test_ secret keys, rk_ restricted keys with scopes, pk_ publishable keys. Every money-moving POST takes an Idempotency-Key.`);
  out.push('@api = http://localhost:4000/api/v1');
  out.push('@key = sk_test_paste-your-key-here');
  out.push('');
  const byTag = new Map<string, { path: string; method: string; op: any }[]>();
  for (const [path, methods] of Object.entries(doc.paths))
    for (const [method, op] of Object.entries(methods as Record<string, any>)) {
      const tag = op.tags?.[0] ?? 'Other';
      byTag.set(tag, [...(byTag.get(tag) ?? []), { path, method, op }]);
    }
  for (const [tag, ops] of byTag) {
    out.push(`### ---------------- ${tag} ----------------`);
    for (const { path, method, op } of ops) {
      const params: any[] = op.parameters ?? [];
      const query = params
        .filter((p) => p.in === 'query')
        .map((p) => `${p.name}=`)
        .join('&');
      const url = path.replace(/\{(\w+)\}/g, (_m, n) => `{{${n}}}`) + (query ? `?${query}` : '');
      out.push(`### ${op.summary}${op['x-scope'] ? ` (scope: ${op['x-scope']})` : ''}`);
      out.push(`${method.toUpperCase()} {{api}}${url}`);
      out.push('Authorization: Bearer {{key}}');
      if (params.some((p) => p.in === 'header' && p.name === 'Idempotency-Key')) out.push('Idempotency-Key: {{$guid}}');
      const body = op.requestBody?.content?.['application/json']?.schema;
      if (method !== 'get' && method !== 'delete') {
        out.push('Content-Type: application/json');
        out.push('');
        const props = body?.properties
          ? Object.fromEntries(
              Object.entries(body.properties).map(([k, v]: [string, any]) => [
                k,
                v.example ?? (v.type === 'integer' || v.type === 'number' ? 0 : v.type === 'boolean' ? false : v.type === 'array' ? [] : v.type === 'object' ? {} : ''),
              ]),
            )
          : {};
        out.push(JSON.stringify(props, null, 2));
      }
      out.push('');
    }
  }
  return out.join('\n') + '\n';
}

if (process.argv[1] && /httpFile\.(ts|js)$/.test(process.argv[1])) process.stdout.write(renderHttpFile());
