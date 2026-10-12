/**
 * A small, strict XML reader and writer for the ISO 20022 documents the platform exchanges with a sponsor bank as
 * files. ISO 20022 payloads are plain element trees — no mixed content, no entities beyond the five predefined ones,
 * no processing instructions that matter — so a focused parser is safer here than a general one: a document type
 * declaration is refused outright rather than expanded, which closes the entity-expansion family of attacks, and the
 * input is size-bounded.
 *
 * Namespace prefixes are stripped from element names: `<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008...">`
 * and `<ns:Document>` both read as `Document`. The namespace itself stays available on the root's attributes, which
 * is where the message version is checked.
 */
import { badRequest } from './errors';

export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** 8 MiB: larger than any statement a sponsor bank sends for one day, small enough to parse in memory. */
export const MAX_XML_BYTES = 8 * 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlText(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[entity] ?? whole;
  });
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;'));
}

const localName = (name: string): string => {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
};

function readAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out[m[1]] = decodeXmlText(m[3] ?? m[4] ?? '');
  return out;
}

/** Parse an XML document into a node tree. Throws a 400 with a readable reason on anything malformed. */
export function parseXml(input: string): XmlNode {
  if (Buffer.byteLength(input, 'utf8') > MAX_XML_BYTES) throw badRequest(`This document is larger than the ${MAX_XML_BYTES / (1024 * 1024)} MiB limit.`, 'xml_too_large');
  if (/<!DOCTYPE/i.test(input)) throw badRequest('A document type declaration is not accepted in an ISO 20022 file.', 'xml_doctype_refused');
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let i = 0;
  const n = input.length;
  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt === -1) break;
    if (lt > i && stack.length) stack[stack.length - 1].text += input.slice(i, lt);
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt);
      if (end === -1) throw badRequest('Unterminated comment in the XML document.', 'xml_malformed');
      i = end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt);
      if (end === -1) throw badRequest('Unterminated CDATA section in the XML document.', 'xml_malformed');
      if (stack.length) stack[stack.length - 1].text += input.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt);
      if (end === -1) throw badRequest('Unterminated processing instruction in the XML document.', 'xml_malformed');
      i = end + 2;
      continue;
    }
    const gt = input.indexOf('>', lt);
    if (gt === -1) throw badRequest('Unterminated tag in the XML document.', 'xml_malformed');
    const inner = input.slice(lt + 1, gt).trim();
    if (inner.startsWith('/')) {
      const name = localName(inner.slice(1).trim());
      const open = stack.pop();
      if (!open) throw badRequest(`Closing tag </${name}> has no opening tag.`, 'xml_malformed');
      if (open.name !== name) throw badRequest(`Closing tag </${name}> does not match <${open.name}>.`, 'xml_malformed');
      open.text = open.text.trim();
      i = gt + 1;
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1).trim() : inner;
    const space = body.search(/\s/);
    const rawName = space === -1 ? body : body.slice(0, space);
    if (!rawName) throw badRequest('Empty tag name in the XML document.', 'xml_malformed');
    const node: XmlNode = { name: localName(rawName), attributes: space === -1 ? {} : readAttributes(body.slice(space)), children: [], text: '' };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (root) throw badRequest('An XML document has exactly one root element.', 'xml_malformed');
    else root = node;
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  if (stack.length) throw badRequest(`Tag <${stack[stack.length - 1].name}> was never closed.`, 'xml_malformed');
  if (!root) throw badRequest('No XML element was found in this document.', 'xml_malformed');
  decodeTree(root);
  return root;
}

function decodeTree(node: XmlNode): void {
  node.text = decodeXmlText(node.text).trim();
  for (const c of node.children) decodeTree(c);
}

/** The first descendant on a slash-separated path of local names, or null. */
export function childAt(node: XmlNode | null | undefined, path: string): XmlNode | null {
  let current: XmlNode | null = node ?? null;
  for (const step of path.split('/').filter(Boolean)) {
    if (!current) return null;
    current = current.children.find((c) => c.name === step) ?? null;
  }
  return current;
}

/** Every direct or nested match of a path, in document order. */
export function childrenAt(node: XmlNode | null | undefined, path: string): XmlNode[] {
  const steps = path.split('/').filter(Boolean);
  let level: XmlNode[] = node ? [node] : [];
  for (const step of steps) level = level.flatMap((c) => c.children.filter((x) => x.name === step));
  return level;
}

export function textAt(node: XmlNode | null | undefined, path: string): string | null {
  return childAt(node, path)?.text ?? null;
}

export interface XmlElement {
  name: string;
  attributes?: Record<string, string>;
  children?: (XmlElement | null | undefined | false)[];
  text?: string | number | null;
}

/** Serialise an element tree, indented, with the XML declaration. Values are escaped; names are written as given. */
export function buildXml(root: XmlElement, opts: { declaration?: boolean } = {}): string {
  const render = (el: XmlElement, depth: number): string => {
    const pad = '  '.repeat(depth);
    const attrs = Object.entries(el.attributes ?? {})
      .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
      .join('');
    const kids = (el.children ?? []).filter((c): c is XmlElement => Boolean(c));
    if (!kids.length && (el.text === null || el.text === undefined || el.text === '')) return `${pad}<${el.name}${attrs}/>`;
    if (!kids.length) return `${pad}<${el.name}${attrs}>${escapeXml(String(el.text))}</${el.name}>`;
    return [`${pad}<${el.name}${attrs}>`, ...kids.map((c) => render(c, depth + 1)), `${pad}</${el.name}>`].join('\n');
  };
  return `${opts.declaration === false ? '' : '<?xml version="1.0" encoding="UTF-8"?>\n'}${render(root, 0)}\n`;
}
