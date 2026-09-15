/**
 * Phrase extraction for the web app: every English string a person can see (JSX text, text props, option labels,
 * toasts) becomes tr('…') so the language packs can translate it by phrase, and the catalogue of phrases is
 * regenerated for the packs and the console's translation engine.
 *   node scripts/i18n-extract.mjs            # report what would change
 *   node scripts/i18n-extract.mjs --write    # rewrite sources and shared/core/src/locales/phrases/catalogue.ts
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const WRITE = process.argv.includes('--write');
const ROOT = 'frontend/web/src';
const SKIP = new Set(['Static.tsx', 'Landing.tsx', 'ErrorBoundary.tsx']);
const PROPS = new Set(['label', 'title', 'subtitle', 'placeholder', 'hint', 'text', 'aria-label', 'description', 'empty', 'summary', 'help', 'caption']);
const OBJECT_KEYS = new Set(['label', 'title', 'text', 'hint', 'description', 'subtitle']);
const CALLS = new Set(['toast', 'setError']);
const files = [...fs.readdirSync(`${ROOT}/pages`).map((f) => `${ROOT}/pages/${f}`), ...fs.readdirSync(`${ROOT}/components`).map((f) => `${ROOT}/components/${f}`)].filter(
  (f) => f.endsWith('.tsx') && !SKIP.has(path.basename(f)),
);

const phrases = new Set();
function okPhrase(t) {
  t = t.trim();
  if (t.length < 2 || !/[A-Za-z]/.test(t)) return false;
  if (!/^[A-Z0-9“"(…•✓→←+©]/.test(t) && !/^\p{Extended_Pictographic}/u.test(t)) return false; // fragments starting lowercase stay
  if (/^[A-Z0-9_.\-/ ]{2,5}$/.test(t)) return false; // codes: USD, ID, 2FA, KYC, P2P
  if (/^https?:|^\/|^@|^#/.test(t)) return false;
  if (/^[0-9+().\s-]+$/.test(t)) return false;
  if (/^[([]/.test(t)) return false; // a parenthesis opened around an inline element: a fragment, not a phrase
  if (/\b(the|a|an|from|with|to|of|under|then|and|or|for|in|on|at|by|your|our|its)$/i.test(t) || /[,:;–-]$/.test(t)) return false; // cut before an inline element
  if (!/\s/.test(t) && /\d/.test(t)) return false; // sample values such as A1234567X or ABC123
  return true;
}
const js = (t) => JSON.stringify(t);

function insideVisibleExpression(node) {
  let p = node.parent;
  while (p) {
    if (ts.isJsxExpression(p)) {
      const owner = p.parent;
      if (ts.isJsxAttribute(owner)) return PROPS.has(owner.name.getText());
      return ts.isJsxElement(owner) || ts.isJsxFragment(owner);
    }
    if (ts.isJsxAttribute(p) || ts.isFunctionLike(p) || ts.isSourceFile(p)) return false;
    p = p.parent;
  }
  return false;
}
function rewrite(file) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = []; // {start,end,text}
  const visit = (node) => {
    // <Tag prop="text">
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(sf);
      const val = node.initializer.text;
      if (PROPS.has(name) && okPhrase(val)) {
        phrases.add(val.trim());
        edits.push({ start: node.initializer.getStart(sf), end: node.initializer.getEnd(), text: `{tr(${js(val.trim())})}` });
      }
    }
    // { label: 'text' } inside tabs / options / KV arrays
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.text;
      const val = node.initializer.text;
      if (OBJECT_KEYS.has(name) && okPhrase(val)) {
        phrases.add(val.trim());
        edits.push({ start: node.initializer.getStart(sf), end: node.initializer.getEnd(), text: `tr(${js(val.trim())})` });
      }
    }
    // already converted: tr('…') keeps its phrase in the catalogue
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'tr' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
      phrases.add(node.arguments[0].text);
    // toast('Saved', 'success') / setError('…')
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CALLS.has(node.expression.text) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const val = node.arguments[0].text;
      if (okPhrase(val)) {
        phrases.add(val.trim());
        edits.push({ start: node.arguments[0].getStart(sf), end: node.arguments[0].getEnd(), text: `tr(${js(val.trim())})` });
      }
    }
    // cond ? 'Save' : 'Saving…'  and  a ?? 'Default'  inside a text prop or a JSX child expression
    if (
      (ts.isConditionalExpression(node) ||
        (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken))) &&
      insideVisibleExpression(node)
    ) {
      const branches = ts.isConditionalExpression(node) ? [node.whenTrue, node.whenFalse] : [node.right];
      for (const b of branches) {
        if (ts.isStringLiteral(b) && okPhrase(b.text)) {
          phrases.add(b.text.trim());
          edits.push({ start: b.getStart(sf), end: b.getEnd(), text: `tr(${js(b.text.trim())})` });
        }
      }
    }
    // JSX children: plain text, or text mixed with simple expressions → one phrase with {0} {1} placeholders
    if ((ts.isJsxElement(node) || ts.isJsxFragment(node)) && node.children.length) {
      const kids = node.children;
      const texts = kids.filter((k) => ts.isJsxText(k) && k.text.trim());
      const exprs = kids.filter((k) => ts.isJsxExpression(k));
      const elements = kids.filter((k) => ts.isJsxElement(k) || ts.isJsxSelfClosingElement(k) || ts.isJsxFragment(k));
      if (texts.length && !elements.length && exprs.length && exprs.length <= 3) {
        const simple = exprs.every((e) => e.expression && !/[<?]|&&|\|\|/.test(e.expression.getText(sf)));
        const combined = kids.map((k) => (ts.isJsxText(k) ? k.text : ts.isJsxExpression(k) ? `{${exprs.indexOf(k)}}` : '')).join('');
        const flat = combined.replace(/\s+/g, ' ').trim();
        if (simple && okPhrase(flat.replace(/\{\d\}/g, 'x')) && /[A-Za-z]{3,}/.test(flat)) {
          phrases.add(flat);
          const first = kids[0],
            last = kids[kids.length - 1];
          const lead = ts.isJsxText(first) ? first.text.match(/^\s*/)[0] : '';
          const trail = ts.isJsxText(last) ? last.text.match(/\s*$/)[0] : '';
          const vars = exprs.map((e, i) => `${i}: ${e.expression.getText(sf)}`).join(', ');
          edits.push({ start: first.getStart(sf), end: last.getEnd(), text: `${lead}{tr(${js(flat)}, { ${vars} })}${trail}` });
          return; // children consumed
        }
      }
      for (const k of kids) {
        if (ts.isJsxText(k)) {
          const flat = k.text.replace(/\s+/g, ' ').trim();
          if (okPhrase(flat)) {
            phrases.add(flat);
            const lead = k.text.match(/^\s*/)[0],
              trail = k.text.match(/\s*$/)[0];
            edits.push({ start: k.getStart(sf), end: k.getEnd(), text: `${lead}{tr(${js(flat)})}${trail}` });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // apply non-overlapping edits from the end
  edits.sort((a, b) => b.start - a.start);
  let out = src,
    lastStart = Infinity,
    applied = 0;
  for (const e of edits) {
    if (e.end > lastStart) continue; // nested inside an already-applied edit
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lastStart = e.start;
    applied++;
  }
  if (applied && !/\btr\b[^\n]*from '\.\.\/lib\/i18n'/.test(out)) {
    if (/from '\.\.\/lib\/i18n';/.test(out)) out = out.replace(/import \{ ([^}]*) \} from '\.\.\/lib\/i18n';/, (m, g) => `import { ${g}, tr } from '../lib/i18n';`);
    else out = out.replace(/^(import [^\n]+\n)/, `$1import { tr } from '../lib/i18n';\n`);
  }
  return { out, applied };
}
let total = 0;
for (const f of files) {
  const { out, applied } = rewrite(f);
  if (!applied) continue;
  total += applied;
  console.log(String(applied).padStart(4), f);
  if (WRITE) fs.writeFileSync(f, out);
}
console.log('replacements', total, 'distinct phrases', phrases.size);
if (WRITE) {
  fs.mkdirSync('shared/core/src/locales/phrases', { recursive: true });
  const list = [...phrases].sort((a, b) => a.localeCompare(b));
  fs.writeFileSync(
    'shared/core/src/locales/phrases/catalogue.ts',
    `/** Every English phrase the web app shows through tr(). Generated by scripts/i18n-extract.mjs; packs translate these by phrase. */\nexport const PHRASES: string[] = [\n${list.map((p) => `  ${js(p)},`).join('\n')}\n];\n`,
  );
} else fs.writeFileSync(process.env.PHRASES_OUT || '/dev/null', JSON.stringify([...phrases].sort(), null, 1));
