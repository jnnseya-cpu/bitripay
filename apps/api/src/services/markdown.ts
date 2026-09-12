/**
 * Small, dependency-free Markdown renderer for blog posts and policy pages: headings, paragraphs, ordered and
 * unordered lists, blockquotes, fenced code, tables, images, links, bold / italic / inline code, horizontal rules.
 * Output is escaped first, so authored content cannot inject scripts. Heading ids are generated for the table of contents.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function inline(text: string): string {
  let t = escapeHtml(text);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, alt, src, title) => `<img src="${src}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy">`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, label, href, title) => {
    const external = /^https?:\/\//i.test(href) && !/bitripay/i.test(href);
    return `<a href="${href}"${title ? ` title="${title}"` : ''}${external ? ' rel="noopener" target="_blank"' : ''}>${label}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return t;
}

export interface Heading {
  level: number;
  id: string;
  text: string;
}

export function renderMarkdown(md: string): { html: string; headings: Heading[]; text: string } {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const headings: Heading[] = [];
  const plain: string[] = [];
  let i = 0;
  const usedIds = new Set<string>();
  const uniqueId = (base: string) => {
    let id = base || 'section';
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`;
    usedIds.add(id);
    return id;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      const id = uniqueId(slugify(text));
      if (level >= 2 && level <= 3) headings.push({ level, id, text });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      plain.push(text);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(buf.join('\n')).html}</blockquote>`);
      plain.push(...buf);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const header = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++].split('|').slice(1, -1).map((c) => c.trim()));
      out.push(`<div class="table-wrap"><table><thead><tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      plain.push(header.join(' '), ...rows.map((r) => r.join(' ')));
      continue;
    }
    const ul = /^\s*[-*+]\s+/.test(line);
    const ol = /^\s*\d+[.)]\s+/.test(line);
    if (ul || ol) {
      const items: string[] = [];
      const re = ul ? /^\s*[-*+]\s+/ : /^\s*\d+[.)]\s+/;
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i++].replace(re, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i])) item += ' ' + lines[i++].trim();
        items.push(item);
      }
      out.push(`<${ul ? 'ul' : 'ol'}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${ul ? 'ul' : 'ol'}>`);
      plain.push(...items);
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*[-*+]\s+|\s*\d+[.)]\s+|\|)/.test(lines[i]) && !/^(-{3,}|\*{3,})\s*$/.test(lines[i])) buf.push(lines[i++].trim());
    if (buf.length) {
      out.push(`<p>${inline(buf.join(' '))}</p>`);
      plain.push(buf.join(' '));
    } else i++;
  }
  return { html: out.join('\n'), headings, text: plain.join('\n') };
}

export function readingMinutes(md: string): number {
  return Math.max(1, Math.round(md.split(/\s+/).filter(Boolean).length / 220));
}
