// A small stand-in for the Google Docs API: builds document JSON with real index
// arithmetic and applies the batchUpdate requests the bot sends. Good enough to catch
// off-by-one and ordering mistakes; not a full Docs implementation.
import type { DocJson, Request, StructuralElement } from '../lib/hppdoc.js';

const TABLE = '\u0001', ROW = '\u0002', CELL = '\u0003', END = '\u0004';

interface Ch { c: string; bullet?: boolean; level?: number; color?: string }

export type Spec =
  | { p: string; bullet?: boolean; level?: number; color?: string }
  | { table: { text: string; color?: string }[][][] }; // rows → cells → paragraphs

export class DocSim {
  chars: Ch[] = [];

  constructor(spec: Spec[]) {
    const para = (text: string, meta: Omit<Ch, 'c'> = {}) => {
      for (const c of text) this.chars.push({ c, color: meta.color });
      this.chars.push({ c: '\n', bullet: meta.bullet, level: meta.level || 0 });
    };
    for (const s of spec) {
      if ('p' in s) para(s.p, s);
      else {
        this.chars.push({ c: TABLE });
        for (const row of s.table) {
          this.chars.push({ c: ROW });
          for (const cell of row) {
            this.chars.push({ c: CELL });
            for (const p of cell) para(p.text, { color: p.color });
          }
        }
        this.chars.push({ c: END });
      }
    }
  }

  // Docs indices start at 1 (index 0 is the section break).
  json(): DocJson {
    let i = 0;
    const idx = () => i + 1;
    const readPara = (): StructuralElement => {
      const start = idx();
      const elements: { startIndex: number; endIndex: number; textRun: { content: string; textStyle: object } }[] = [];
      let run = '';
      let runColor: string | undefined;
      let runStart = start;
      const flush = () => {
        if (!run) return;
        const rgb = runColor ? {
          red: parseInt(runColor.slice(1, 3), 16) / 255,
          green: parseInt(runColor.slice(3, 5), 16) / 255,
          blue: parseInt(runColor.slice(5, 7), 16) / 255,
        } : undefined;
        elements.push({
          startIndex: runStart, endIndex: runStart + run.length,
          textRun: { content: run, textStyle: rgb ? { foregroundColor: { color: { rgbColor: rgb } } } : {} },
        });
      };
      while (this.chars[i].c !== '\n') {
        const ch = this.chars[i];
        if (ch.color !== runColor) { flush(); run = ''; runColor = ch.color; runStart = idx(); }
        run += ch.c;
        i++;
      }
      const nl = this.chars[i];
      if (runColor !== undefined) { flush(); run = ''; runColor = undefined; runStart = idx(); }
      run += '\n';
      i++;
      flush();
      return {
        startIndex: start, endIndex: idx(),
        paragraph: { elements, ...(nl.bullet ? { bullet: { listId: 'l', nestingLevel: nl.level || 0 } } : {}) },
      };
    };
    const content: StructuralElement[] = [];
    while (i < this.chars.length) {
      if (this.chars[i].c === TABLE) {
        const start = idx();
        i++;
        const tableRows: { tableCells: { content: StructuralElement[] }[] }[] = [];
        while (this.chars[i].c === ROW) {
          i++;
          const cells: { content: StructuralElement[] }[] = [];
          while (this.chars[i].c === CELL) {
            i++;
            const paras: StructuralElement[] = [];
            while (![CELL, ROW, END].includes(this.chars[i].c)) paras.push(readPara());
            cells.push({ content: paras });
          }
          tableRows.push({ tableCells: cells });
        }
        i++; // END
        content.push({ startIndex: start, endIndex: idx(), table: { tableRows } });
      } else {
        content.push(readPara());
      }
    }
    return { documentId: 'sim', body: { content } };
  }

  apply(requests: Request[]) {
    for (const r of requests) {
      const [kind, body] = Object.entries(r)[0] as [string, Record<string, any>];
      if (kind === 'deleteContentRange') {
        const { startIndex, endIndex } = body.range;
        const removed = this.chars.slice(startIndex - 1, endIndex - 1);
        if (removed.some((c) => [TABLE, ROW, CELL, END].includes(c.c))) throw new Error('delete crosses table structure');
        this.chars.splice(startIndex - 1, endIndex - startIndex);
      } else if (kind === 'insertText') {
        const at = body.location.index - 1;
        const nextNl = this.chars.slice(at).find((c) => c.c === '\n')!;
        const add = [...body.text as string].map((c) => (c === '\n' ? { ...nextNl, c } : { c }));
        this.chars.splice(at, 0, ...add);
      } else if (kind === 'updateTextStyle') {
        const color = body.textStyle.foregroundColor?.color?.rgbColor;
        if (body.fields.includes('foregroundColor')) {
          const hex = color && (color.red || color.green || color.blue)
            ? '#' + [color.red, color.green, color.blue].map((x: number) => Math.round((x || 0) * 255).toString(16).padStart(2, '0')).join('')
            : undefined;
          for (let k = body.range.startIndex - 1; k < body.range.endIndex - 1; k++) {
            if (this.chars[k].c !== '\n') this.chars[k].color = hex;
          }
        }
      } else if (kind === 'deleteParagraphBullets') {
        this.forParas(body.range, (nl) => { nl.bullet = false; });
      } else if (kind === 'createParagraphBullets') {
        // Leading tabs become nesting levels and are removed.
        const { startIndex, endIndex } = body.range;
        let k = startIndex - 1;
        let end = endIndex - 1;
        while (k <= end && k < this.chars.length) {
          let tabs = 0;
          while (this.chars[k]?.c === '\t') { this.chars.splice(k, 1); tabs++; end--; }
          while (this.chars[k].c !== '\n') k++;
          this.chars[k].bullet = true;
          this.chars[k].level = tabs;
          k++;
        }
      } else {
        throw new Error(`sim: unsupported request ${kind}`);
      }
    }
  }

  private forParas(range: { startIndex: number; endIndex: number }, fn: (nl: Ch) => void) {
    for (let k = range.startIndex - 1; k < this.chars.length; k++) {
      if (this.chars[k].c === '\n') {
        fn(this.chars[k]);
        if (k >= range.endIndex - 1) break;
      }
    }
  }
}

// The layout of a doc created from templateHtml(), as Google converts it.
export function templateSpec(): Spec[] {
  const nb = ' ';
  const hdr = (t: string) => [{ text: t, color: '#ffffff' }];
  const empty = [{ text: nb }];
  return [
    { p: '' },
    { p: 'What can I look forward to today?' }, { p: nb, bullet: true }, { p: nb },
    { p: 'Something I am thankful for today:' }, { p: nb, bullet: true }, { p: nb },
    { p: 'Compass:' }, { p: nb, bullet: true }, { p: nb }, { p: nb },
    { p: 'Things that have to get done today:' }, { p: nb },
    { table: [[hdr('Work'), hdr('Relations')], [empty, empty], [hdr('Physical'), hdr('Emotional / Spiritual')], [empty, empty]] },
    { p: nb }, { p: 'Daily review:' }, { p: nb },
    { table: [
      [hdr('Topic'), hdr('Score (1- 10)'), hdr('Notes')],
      ...[1, 2, 3, 4, 5, 6].map((i) => [[{ text: `Row ${i}` }], empty, empty]),
      [[{ text: 'Total Score' }], [{ text: '/ 60' }], empty],
    ] },
    { p: nb }, { p: nb },
    { p: 'Other things on my mind:' }, { p: nb, bullet: true },
  ];
}
