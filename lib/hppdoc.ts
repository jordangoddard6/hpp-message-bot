// Pure functions over Google Docs API JSON: find the HPP sections, read carry-over and
// tasks, and build batchUpdate requests. Sections are located by their labels (and tables
// by their first cell), so any doc with the HPP layout works.
import { AREAS, QUESTIONS, REVIEW_ROWS } from './config.js';
import type { Group, Line, Score, Task } from './types.js';

// ---------- minimal Docs API shapes ----------

interface RgbColor { red?: number; green?: number; blue?: number }
interface TextRun {
  content?: string;
  textStyle?: { foregroundColor?: { color?: { rgbColor?: RgbColor } } };
}
interface ParagraphElement { startIndex?: number; endIndex?: number; textRun?: TextRun }
export interface Paragraph {
  elements?: ParagraphElement[];
  bullet?: { listId?: string; nestingLevel?: number };
}
interface TableCell { content?: StructuralElement[] }
interface Table { tableRows?: { tableCells?: TableCell[] }[] }
export interface StructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: Paragraph;
  table?: Table;
}
export interface DocJson {
  documentId?: string;
  body?: { content?: StructuralElement[] };
}
export type Request = Record<string, unknown>;

// ---------- helpers ----------

export function norm(s: string): string {
  return s.replace(/ /g, ' ').trim().replace(/:$/, '').trim().toLowerCase();
}

function paraText(p: Paragraph): string {
  return (p.elements || []).map((e) => e.textRun?.content || '').join('').replace(/\n$/, '');
}

const clean = (s: string) => s.replace(/ /g, ' ').trim();

export function isGray(rgb: RgbColor | undefined): boolean {
  if (!rgb) return false;
  const c = [rgb.red || 0, rgb.green || 0, rgb.blue || 0].map((x) => Math.round(x * 255));
  return Math.max(...c) - Math.min(...c) <= 16 && Math.max(...c) >= 0x80;
}

// Done = the first visible character is gray.
function paraDone(p: Paragraph): boolean {
  for (const el of p.elements || []) {
    const content = el.textRun?.content || '';
    if (/\S/.test(content.replace(/ /g, ' '))) {
      return isGray(el.textRun?.textStyle?.foregroundColor?.color?.rgbColor);
    }
  }
  return false;
}

function body(doc: DocJson): StructuralElement[] {
  return doc.body?.content || [];
}

function findTable(doc: DocJson, firstCell: string): Table | null {
  for (const el of body(doc)) {
    const cell = el.table?.tableRows?.[0]?.tableCells?.[0];
    if (!cell) continue;
    const text = (cell.content || []).map((c) => (c.paragraph ? paraText(c.paragraph) : '')).join(' ');
    if (norm(text) === firstCell) return el.table!;
  }
  return null;
}

function cell(table: Table, [r, c]: [number, number]): StructuralElement[] {
  return table.tableRows?.[r]?.tableCells?.[c]?.content || [];
}

interface Para { start: number; end: number; text: string; done: boolean; level: number; el: Paragraph }

function paras(content: StructuralElement[]): Para[] {
  return content
    .filter((c) => c.paragraph)
    .map((c) => ({
      start: c.startIndex!,
      end: c.endIndex!,
      text: clean(paraText(c.paragraph!)),
      done: paraDone(c.paragraph!),
      level: c.paragraph!.bullet?.nestingLevel || 0,
      el: c.paragraph!,
    }));
}

// Bulleted paragraphs directly after the paragraph labelled `label`.
function listAfter(doc: DocJson, label: string): Para[] {
  const els = body(doc);
  const want = norm(label);
  const i = els.findIndex((e) => e.paragraph && !e.paragraph.bullet && norm(paraText(e.paragraph)) === want);
  if (i < 0) return [];
  const out: StructuralElement[] = [];
  for (let j = i + 1; j < els.length && els[j].paragraph?.bullet; j++) out.push(els[j]);
  return paras(out);
}

// ---------- reading ----------

export function templateProblem(doc: DocJson): string | null {
  if (!findTable(doc, 'work')) return 'task table';
  if (!findTable(doc, 'topic')) return 'daily review table';
  const missing = QUESTIONS.find((q) => q.label && !listAfter(doc, q.label).length);
  return missing ? `list after "${missing.label}"` : null;
}

// Unfinished items per carry-over question.
export function readCarry(doc: DocJson): Record<string, Group[]> {
  const tasks = findTable(doc, 'work');
  const carry: Record<string, Group[]> = {};
  for (const q of QUESTIONS.filter((x) => x.carry)) {
    if (q.cell) {
      carry[q.key] = !tasks ? [] : paras(cell(tasks, q.cell))
        .filter((p) => p.text && !p.done)
        .map((p) => ({ lines: [{ text: p.text, level: 0 }] }));
      continue;
    }
    const groups: Group[] = [];
    for (const p of listAfter(doc, q.label!)) {
      if (!p.text || p.done) continue;
      const level = Math.min(p.level, 2);
      if (level === 0 || !groups.length) groups.push({ lines: [{ text: p.text, level: 0 }] });
      else groups[groups.length - 1].lines.push({ text: p.text, level });
    }
    carry[q.key] = groups;
  }
  return carry;
}

export function readTasks(doc: DocJson): Task[] {
  const tasks = findTable(doc, 'work');
  if (!tasks) return [];
  const out: Task[] = [];
  for (const q of AREAS) {
    paras(cell(tasks, q.cell!)).forEach((p, index) => {
      if (p.text) out.push({ area: q.key, index, text: p.text, done: p.done });
    });
  }
  return out;
}

// ---------- writing ----------

const BASE_STYLE = {
  textStyle: {
    weightedFontFamily: { fontFamily: 'Arial' },
    fontSize: { magnitude: 10, unit: 'PT' },
    foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
    bold: false,
    italic: false,
  },
  fields: 'weightedFontFamily,fontSize,foregroundColor,bold,italic',
};

interface Replace { start: number; end: number; text: string; list: boolean }

// Replace the text of [start, end) (end excludes the final newline) with `text`.
// Must be applied in descending `start` order so earlier indices stay valid.
function replaceRequests(r: Replace): Request[] {
  const reqs: Request[] = [];
  if (r.end > r.start) reqs.push({ deleteContentRange: { range: { startIndex: r.start, endIndex: r.end } } });
  if (!r.text) return reqs;
  const range = { startIndex: r.start, endIndex: r.start + r.text.length };
  reqs.push({ insertText: { location: { index: r.start }, text: r.text } });
  reqs.push({ updateTextStyle: { range, ...BASE_STYLE } });
  if (r.list) {
    // Re-bullet so leading tabs become nesting levels.
    reqs.push({ deleteParagraphBullets: { range } });
    reqs.push({ createParagraphBullets: { range, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
  }
  return reqs;
}

function applyInOrder(replaces: Replace[]): Request[] {
  return replaces.sort((a, b) => b.start - a.start).flatMap(replaceRequests);
}

export function fillRequests(doc: DocJson, answers: Record<string, Line[]>): Request[] {
  const tasks = findTable(doc, 'work');
  if (!tasks) throw new Error('Template is missing the task table');
  const replaces: Replace[] = [];
  for (const q of QUESTIONS) {
    const lines = answers[q.key] || [];
    if (!lines.length) continue;
    const target = q.cell ? paras(cell(tasks, q.cell))[0] : listAfter(doc, q.label!)[0];
    if (!target) throw new Error(`Template is missing the ${q.cell ? 'cell' : 'list'} for "${q.prompt}"`);
    const text = lines.map((l) => (q.cell ? '' : '\t'.repeat(l.level)) + l.text).join('\n');
    replaces.push({ start: target.start, end: target.end - 1, text, list: !q.cell });
  }
  return applyInOrder(replaces);
}

export function taskColorRequests(
  doc: DocJson,
  changes: { area: string; index: number; text: string; done: boolean }[],
  gray: string,
): { requests: Request[]; applied: number } {
  const tasks = findTable(doc, 'work');
  const requests: Request[] = [];
  if (!tasks) return { requests, applied: 0 };
  const hex = (h: string) => parseInt(h, 16) / 255;
  const grayRgb = { red: hex(gray.slice(1, 3)), green: hex(gray.slice(3, 5)), blue: hex(gray.slice(5, 7)) };
  for (const ch of changes) {
    const q = AREAS.find((a) => a.key === ch.area);
    const p = q && paras(cell(tasks, q.cell!))[ch.index];
    if (!p || p.text !== ch.text || p.end - 1 <= p.start) continue;
    requests.push({
      updateTextStyle: {
        range: { startIndex: p.start, endIndex: p.end - 1 },
        textStyle: { foregroundColor: { color: { rgbColor: ch.done ? grayRgb : { red: 0, green: 0, blue: 0 } } } },
        fields: 'foregroundColor',
      },
    });
  }
  return { requests, applied: requests.length };
}

export function scoreRequests(doc: DocJson, scores: (Score | null)[]): { requests: Request[]; total: number } {
  const review = findTable(doc, 'topic');
  if (!review) throw new Error('Daily review table not found');
  let total = 0;
  let any = false;
  const replaces: Replace[] = [];
  const set = (pos: [number, number], text: string) => {
    const ps = paras(cell(review, pos));
    if (!ps.length) return;
    replaces.push({ start: ps[0].start, end: ps[ps.length - 1].end - 1, text, list: false });
  };
  REVIEW_ROWS.forEach((_, i) => {
    const s = scores[i];
    set([i + 1, 1], s ? String(s.score) : '');
    set([i + 1, 2], s?.note || '');
    if (s) { total += s.score; any = true; }
  });
  set([REVIEW_ROWS.length + 1, 1], (any ? `${total} ` : '') + '/ 60');
  return { requests: applyInOrder(replaces), total };
}

// ---------- template ----------

// Uploaded as HTML and converted to a Google Doc. Empty spots hold a non-breaking space so
// the conversion keeps the bullet / paragraph.
export function templateHtml(): string {
  const P = 'margin:0;font-family:Arial;font-size:10pt;color:#000000';
  const p = (text: string, center = false) =>
    `<p style="${P}${center ? ';text-align:center' : ''}">${text || '&nbsp;'}</p>`;
  const bullet = `<ul style="margin:0"><li style="${P}">&nbsp;</li></ul>`;
  const td = (content: string, opts: { width?: string; height?: string; header?: boolean; indent?: boolean } = {}) => {
    const style = [
      'border:1px solid #000000',
      'vertical-align:top',
      'padding:5pt',
      opts.width ? `width:${opts.width}` : '',
      opts.height ? `height:${opts.height}` : '',
      opts.header ? 'background-color:#000000' : '',
    ].filter(Boolean).join(';');
    const pStyle = `${P}${opts.header ? ';color:#ffffff;text-align:center' : ''}${opts.indent ? ';margin-left:36pt' : ''}`;
    return `<td style="${style}"><p style="${pStyle}">${content || '&nbsp;'}</p></td>`;
  };
  const table = (rows: string[]) =>
    `<table style="border-collapse:collapse">${rows.map((r) => `<tr>${r}</tr>`).join('')}</table>`;

  const tasks = table([
    td('Work', { width: '223.5pt', height: '20.7pt', header: true }) + td('Relations', { width: '231.8pt', header: true }),
    td('', { height: '85.5pt' }) + td(''),
    td('Physical', { height: '18pt', header: true }) + td('Emotional / Spiritual', { header: true }),
    td('', { height: '72pt' }) + td(''),
  ]);
  const review = table([
    td('Topic', { width: '243.1pt', header: true }) + td('Score (1- 10)', { width: '112.5pt', header: true }) +
      td('Notes', { width: '112.5pt', header: true }),
    ...REVIEW_ROWS.map((r) => td(r) + td('') + td('')),
    td('Total Score', { indent: true }) + td('/ 60') + td(''),
  ]);

  return [
    '<html><body>',
    p(''),
    p('What can I look forward to today?'), bullet, p(''),
    p('Something I am thankful for today:'), bullet, p(''),
    p('Compass:'), bullet, p(''), p(''),
    p('Things that have to get done today:', true), p('', true),
    tasks,
    p(''), p('Daily review:', true), p(''),
    review,
    p(''), p(''),
    p('Other things on my mind:'), bullet,
    '</body></html>',
  ].join('\n');
}
