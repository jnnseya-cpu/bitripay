/**
 * Minimal dependency-free PDF writer (text + rules, Helvetica, auto pagination). Enough for bank-grade statements:
 * deterministic output, no external fonts or network. Non-Latin-1 characters are replaced so the file stays valid.
 */
export interface PdfTableColumn {
  title: string;
  width: number;
  align?: 'left' | 'right';
}

interface Op {
  kind: 'text' | 'line' | 'rect';
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  text?: string;
  size?: number;
  bold?: boolean;
  gray?: number;
}

const PAGE_W = 595.28; // A4 portrait, points
const PAGE_H = 841.89;
const MARGIN = 40;

function esc(s: string): string {
  return s
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}
/** Approximate Helvetica width (avg 0.5em) – used only for alignment and truncation. */
export function textWidth(s: string, size: number): number {
  return s.length * size * 0.5;
}
export function fit(s: string, width: number, size: number): string {
  if (textWidth(s, size) <= width) return s;
  const max = Math.max(1, Math.floor(width / (size * 0.5)) - 1);
  return `${s.slice(0, max)}…`;
}

export class PdfDocument {
  private pages: Op[][] = [[]];
  private y = PAGE_H - MARGIN;
  readonly width = PAGE_W - MARGIN * 2;
  private footer: ((page: number, total: number) => string) | null = null;

  constructor(private meta: { title: string; author?: string }) {}

  get cursor() {
    return this.y;
  }
  private ops() {
    return this.pages[this.pages.length - 1];
  }
  setFooter(fn: (page: number, total: number) => string) {
    this.footer = fn;
  }
  newPage() {
    this.pages.push([]);
    this.y = PAGE_H - MARGIN;
  }
  ensure(height: number) {
    if (this.y - height < MARGIN + 30) this.newPage();
  }
  text(s: string, opts: { size?: number; bold?: boolean; x?: number; gray?: number; align?: 'left' | 'right'; width?: number } = {}) {
    const size = opts.size ?? 10;
    this.ensure(size * 1.5);
    let x = MARGIN + (opts.x ?? 0);
    if (opts.align === 'right') x = MARGIN + (opts.x ?? 0) + (opts.width ?? this.width) - textWidth(s, size);
    this.ops().push({ kind: 'text', x, y: this.y - size, text: s, size, bold: opts.bold, gray: opts.gray });
    this.y -= size * 1.5;
  }
  /** Two-column key/value line. */
  pair(label: string, value: string, opts: { size?: number } = {}) {
    const size = opts.size ?? 10;
    this.ensure(size * 1.5);
    this.ops().push({ kind: 'text', x: MARGIN, y: this.y - size, text: label, size, gray: 0.4 });
    this.ops().push({ kind: 'text', x: MARGIN + 150, y: this.y - size, text: value, size, bold: true });
    this.y -= size * 1.5;
  }
  space(h = 8) {
    this.y -= h;
  }
  rule(gray = 0.7) {
    this.ensure(4);
    this.ops().push({ kind: 'line', x: MARGIN, y: this.y, x2: MARGIN + this.width, y2: this.y, gray });
    this.y -= 6;
  }
  table(columns: PdfTableColumn[], rows: string[][], opts: { size?: number; header?: boolean; zebra?: boolean } = {}) {
    const size = opts.size ?? 8.5;
    const rowH = size * 1.9;
    const drawHeader = () => {
      this.ensure(rowH * 2);
      this.ops().push({ kind: 'rect', x: MARGIN, y: this.y - rowH, x2: this.width, y2: rowH, gray: 0.9 });
      let x = MARGIN + 3;
      for (const c of columns) {
        const tx = c.align === 'right' ? x + c.width - 6 - textWidth(c.title, size) : x;
        this.ops().push({ kind: 'text', x: tx, y: this.y - rowH + size * 0.6, text: c.title, size, bold: true });
        x += c.width;
      }
      this.y -= rowH;
    };
    if (opts.header !== false) drawHeader();
    rows.forEach((row, i) => {
      if (this.y - rowH < MARGIN + 30) {
        this.newPage();
        if (opts.header !== false) drawHeader();
      }
      if (opts.zebra && i % 2 === 1) this.ops().push({ kind: 'rect', x: MARGIN, y: this.y - rowH, x2: this.width, y2: rowH, gray: 0.97 });
      let x = MARGIN + 3;
      columns.forEach((c, j) => {
        const cell = fit(row[j] ?? '', c.width - 8, size);
        const tx = c.align === 'right' ? x + c.width - 6 - textWidth(cell, size) : x;
        this.ops().push({ kind: 'text', x: tx, y: this.y - rowH + size * 0.6, text: cell, size });
        x += c.width;
      });
      this.ops().push({ kind: 'line', x: MARGIN, y: this.y - rowH, x2: MARGIN + this.width, y2: this.y - rowH, gray: 0.85 });
      this.y -= rowH;
    });
  }

  render(): Buffer {
    const objects: string[] = [];
    const add = (body: string) => {
      objects.push(body);
      return objects.length;
    };
    const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pagesId = objects.length + 1 + this.pages.length * 2; // reserved after content+page objects
    const pageIds: number[] = [];
    this.pages.forEach((ops, idx) => {
      const parts: string[] = [];
      const footerOps: Op[] = [];
      if (this.footer) footerOps.push({ kind: 'text', x: MARGIN, y: MARGIN - 10, text: this.footer(idx + 1, this.pages.length), size: 7.5, gray: 0.45 });
      for (const op of [...ops, ...footerOps]) {
        if (op.kind === 'text') {
          const g = op.gray ?? 0;
          parts.push(`BT /${op.bold ? 'F2' : 'F1'} ${op.size ?? 10} Tf ${g} g ${op.x.toFixed(2)} ${op.y.toFixed(2)} Td (${esc(op.text ?? '')}) Tj ET`);
        } else if (op.kind === 'line') {
          parts.push(`${op.gray ?? 0} G 0.5 w ${op.x.toFixed(2)} ${op.y.toFixed(2)} m ${(op.x2 ?? op.x).toFixed(2)} ${(op.y2 ?? op.y).toFixed(2)} l S`);
        } else if (op.kind === 'rect') {
          parts.push(`${op.gray ?? 0.9} g ${op.x.toFixed(2)} ${op.y.toFixed(2)} ${(op.x2 ?? 0).toFixed(2)} ${(op.y2 ?? 0).toFixed(2)} re f 0 g`);
        }
      }
      const stream = parts.join('\n');
      const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
      const pageId = add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentId} 0 R >>`,
      );
      pageIds.push(pageId);
    });
    const realPagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    // Page objects referenced the reserved id; patch it in.
    for (const id of pageIds) objects[id - 1] = objects[id - 1].replace(`/Parent ${pagesId} 0 R`, `/Parent ${realPagesId} 0 R`);
    const infoId = add(
      `<< /Title (${esc(this.meta.title)}) /Author (${esc(this.meta.author ?? 'BitriPay')}) /Producer (BitriPay) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`,
    );
    const catalogId = add(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
