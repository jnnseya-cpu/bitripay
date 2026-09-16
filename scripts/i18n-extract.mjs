/**
 * Phrase extraction for every surface a person reads: the web app, the phone app and the console. Every English
 * string (JSX text, text props, option labels, toasts, alerts, table heads) becomes tr('…') so the language packs can
 * translate it by phrase; the API's user-facing messages (errors, notification titles, communication events) are
 * collected too, because the clients translate them on arrival and the server translates them before sending. One
 * catalogue of phrases is regenerated for the packs and for the console's translation engine.
 *   node scripts/i18n-extract.mjs                   # report what would change
 *   node scripts/i18n-extract.mjs --write           # rewrite sources and shared/core/src/locales/phrases/catalogue.ts
 *   node scripts/i18n-extract.mjs --app mobile      # only one app (web | mobile | admin); the API scan always runs
 */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const WRITE = process.argv.includes('--write');
const only = process.argv.includes('--app') ? process.argv[process.argv.indexOf('--app') + 1] : null;

const APPS = {
  web: { root: 'frontend/web/src', dirs: ['pages', 'components'], skip: ['Static.tsx', 'Landing.tsx', 'ErrorBoundary.tsx'] },
  mobile: { root: 'frontend/mobile/src', dirs: ['screens', 'components'], skip: ['ErrorBoundary.tsx'] },
  admin: { root: 'frontend/admin/src', dirs: ['pages', 'components'], skip: ['ErrorBoundary.tsx'] },
};
const PROPS = new Set(['label', 'title', 'subtitle', 'placeholder', 'hint', 'text', 'aria-label', 'description', 'empty', 'summary', 'help', 'caption', 'k', 'confirm', 'message']);
const ARRAY_PROPS = new Set(['head', 'columns']);
const OBJECT_KEYS = new Set(['label', 'title', 'text', 'hint', 'description', 'subtitle']);
const CALLS = new Set(['toast', 'setError']);
/** Alert.alert(title, message) on the phone: both arguments are read by a person. */
const MEMBER_CALLS = new Set(['Alert.alert']);
/** API helpers whose first argument is a sentence shown to the person. */
const API_ERRORS = new Set(['badRequest', 'conflict', 'forbidden', 'unprocessable', 'notFound', 'unauthorized', 'tooManyRequests']);

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
/** A literal evaluated once when the module loads (top-level constant) cannot follow a later language change. */
function atModuleScope(node) {
  let p = node.parent;
  while (p) {
    if (ts.isFunctionLike(p) || ts.isClassLike(p)) return false;
    if (ts.isSourceFile(p)) return true;
    p = p.parent;
  }
  return true;
}
const moduleScopeCalls = [];

function rewrite(file) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = []; // {start,end,text}
  const add = (lit) => {
    phrases.add(lit.text.trim());
    edits.push({ start: lit.getStart(sf), end: lit.getEnd(), text: `tr(${js(lit.text.trim())})` });
  };
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
    // <Table head={['Country', 'Phase']}>
    if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ARRAY_PROPS.has(node.name.getText(sf))) {
      const arr = node.initializer.expression;
      if (ts.isArrayLiteralExpression(arr)) for (const el of arr.elements) if (ts.isStringLiteral(el) && okPhrase(el.text)) add(el);
    }
    // { label: 'text' } inside tabs / options / KV arrays (inside a component, never a module constant)
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.text;
      const val = node.initializer.text;
      if (OBJECT_KEYS.has(name) && okPhrase(val)) {
        // a module-level table (navigation, step labels) keeps its English text and is translated at render with tr(x.label);
        // its phrases still belong in the catalogue so the packs cover them
        if (atModuleScope(node)) phrases.add(val.trim());
        else add(node.initializer);
      }
      if (name === 'section' && okPhrase(val)) phrases.add(val.trim());
    }
    // already converted: tr('…') keeps its phrase in the catalogue
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'tr' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      phrases.add(node.arguments[0].text);
      if (atModuleScope(node)) moduleScopeCalls.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
    }
    // toast('Saved', 'success') / setError('…')
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CALLS.has(node.expression.text) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      if (okPhrase(node.arguments[0].text)) add(node.arguments[0]);
    }
    // Alert.alert('Title', 'Message')
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && MEMBER_CALLS.has(node.expression.getText(sf))) {
      for (const a of node.arguments.slice(0, 2)) if (ts.isStringLiteral(a) && okPhrase(a.text)) add(a);
    }
    // cond ? 'Save' : 'Saving…'  and  a ?? 'Default'  inside a text prop or a JSX child expression
    if (
      (ts.isConditionalExpression(node) ||
        (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken))) &&
      insideVisibleExpression(node)
    ) {
      const branches = ts.isConditionalExpression(node) ? [node.whenTrue, node.whenFalse] : [node.right];
      for (const b of branches) if (ts.isStringLiteral(b) && okPhrase(b.text)) add(b);
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

/** API: error sentences, notification titles and the communication catalogue (subject and body, {{placeholders}} kept). */
function scanApi() {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) return d.name === 'tests' ? [] : walk(p);
      return p.endsWith('.ts') ? [p] : [];
    });
  let count = 0;
  const apiOk = (t) => t.trim().length >= 3 && /[A-Za-z]{3,}/.test(t) && !/^https?:/.test(t);
  for (const file of walk('backend/api/src')) {
    const src = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const a = node.arguments;
        const lits = [];
        if (API_ERRORS.has(name) && a[0] && ts.isStringLiteral(a[0])) lits.push(a[0]);
        if (name === 'notify' && a[1] && ts.isStringLiteral(a[1])) lits.push(a[1]);
        if (name === 'notify' && a[2] && ts.isStringLiteral(a[2])) lits.push(a[2]);
        if (name === 'ev' && file.endsWith('comms/catalogue.ts')) for (const x of a.slice(2, 5)) if (x && ts.isStringLiteral(x)) lits.push(x);
        for (const l of lits)
          if (apiOk(l.text)) {
            phrases.add(l.text.trim());
            count++;
          }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return count;
}

let total = 0;
for (const [app, cfg] of Object.entries(APPS)) {
  if (only && only !== app) continue;
  const files = cfg.dirs
    .flatMap((d) => (fs.existsSync(`${cfg.root}/${d}`) ? fs.readdirSync(`${cfg.root}/${d}`).map((f) => `${cfg.root}/${d}/${f}`) : []))
    .filter((f) => f.endsWith('.tsx') && !cfg.skip.includes(path.basename(f)));
  for (const f of files) {
    const { out, applied } = rewrite(f);
    if (!applied) continue;
    total += applied;
    console.log(String(applied).padStart(4), f);
    if (WRITE) fs.writeFileSync(f, out);
  }
}
const apiCount = scanApi();
console.log('replacements', total, 'api strings', apiCount, 'distinct phrases', phrases.size);
if (moduleScopeCalls.length) console.log('tr() evaluated once at module load (translate at render instead):\n  ' + moduleScopeCalls.join('\n  '));
if (WRITE) {
  fs.mkdirSync('shared/core/src/locales/phrases', { recursive: true });
  const list = [...phrases].sort((a, b) => a.localeCompare(b));
  fs.writeFileSync(
    'shared/core/src/locales/phrases/catalogue.ts',
    `/** Every English phrase the web app, the phone app, the console and the API show through tr() or translate(). Generated by scripts/i18n-extract.mjs; packs translate these by phrase. */\nexport const PHRASES: string[] = [\n${list.map((p) => `  ${js(p)},`).join('\n')}\n];\n`,
  );
} else fs.writeFileSync(process.env.PHRASES_OUT || '/dev/null', JSON.stringify([...phrases].sort(), null, 1));
