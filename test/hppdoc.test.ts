import { describe, expect, it } from 'vitest';
import {
  fillRequests, readCarry, readTasks, scoreRequests, taskColorRequests, taskHash, templateHtml, templateProblem,
} from '../lib/hppdoc.js';
import { DocSim, templateSpec } from './docsim.js';

const answers = {
  lookForward: [{ text: 'Dinner with Whiteley', level: 0 }, { text: 'Football game', level: 0 }],
  thankful: [{ text: 'Health', level: 0 }],
  compass: [{ text: 'Be helpful and friendly', level: 0 }],
  work: [{ text: 'Apply to TaxHawk', level: 0 }, { text: 'Finish deck', level: 0 }],
  relations: [{ text: 'Call mom', level: 0 }],
  physical: [],
  emotional: [{ text: 'Say a prayer', level: 0 }],
  other: [
    { text: 'Applying to jobs', level: 0 }, { text: 'Paramify', level: 1 }, { text: 'TaxHawk', level: 1 },
    { text: 'Health insurance', level: 0 },
  ],
};

function filled() {
  const sim = new DocSim(templateSpec());
  sim.apply(fillRequests(sim.json(), answers));
  return sim;
}

describe('template', () => {
  it('the simulated template passes the template check', () => {
    expect(templateProblem(new DocSim(templateSpec()).json())).toBeNull();
  });

  it('flags a template with a missing list', () => {
    const spec = templateSpec().filter((s) => !('p' in s && s.p === 'Compass:'));
    expect(templateProblem(new DocSim(spec).json())).toMatch(/Compass/);
  });

  it('html has every label and both tables', () => {
    const html = templateHtml();
    for (const label of ['What can I look forward to today?', 'Something I am thankful for today:', 'Compass:',
      'Things that have to get done today:', 'Daily review:', 'Other things on my mind:', 'Emotional / Spiritual',
      'Score (1- 10)', 'Total Score']) {
      expect(html).toContain(label);
    }
    expect(html.match(/<table/g)).toHaveLength(2);
  });
});

describe('filling a day', () => {
  it('writes every answer into the right place, keeping nesting', () => {
    const doc = filled().json();
    expect(templateProblem(doc)).toBeNull();
    const carry = readCarry(doc);
    expect(carry.compass).toEqual([{ lines: [{ text: 'Be helpful and friendly', level: 0 }] }]);
    expect(carry.other).toEqual([
      { lines: [{ text: 'Applying to jobs', level: 0 }, { text: 'Paramify', level: 1 }, { text: 'TaxHawk', level: 1 }] },
      { lines: [{ text: 'Health insurance', level: 0 }] },
    ]);
    const tasks = readTasks(doc);
    expect(tasks.map((t) => `${t.area}:${t.index}:${t.text}`)).toEqual([
      'work:0:Apply to TaxHawk', 'work:1:Finish deck', 'relations:0:Call mom', 'emotional:0:Say a prayer',
    ]);
    // Header cells untouched, skipped section keeps its placeholder.
    const text = filled().chars.map((c) => c.c).join('');
    expect(text).toContain('Work');
    expect(text).toContain('Emotional / Spiritual');
    expect(text).toContain('Dinner with Whiteley\nFootball game\n');
  });

  it('graying tasks marks them done and they drop out of carry-over', () => {
    const sim = filled();
    const tasks = readTasks(sim.json());
    const change = { area: tasks[1].area, index: tasks[1].index, hash: taskHash(tasks[1].text), done: true };
    const { requests, applied } = taskColorRequests(sim.json(), [change], '#b7b7b7');
    expect(applied).toBe(1);
    sim.apply(requests);
    const after = readTasks(sim.json());
    expect(after.find((t) => t.text === 'Finish deck')!.done).toBe(true);
    expect(readCarry(sim.json()).work.map((g) => g.lines[0].text)).toEqual(['Apply to TaxHawk']);
    // and back to black
    sim.apply(taskColorRequests(sim.json(), [{ ...change, done: false }], '#b7b7b7').requests);
    expect(readTasks(sim.json()).find((t) => t.text === 'Finish deck')!.done).toBe(false);
  });

  it('skips a task whose text changed since the list was read', () => {
    const sim = filled();
    const { applied } = taskColorRequests(sim.json(), [{ area: 'work', index: 0, hash: taskHash('Something else'), done: true }], '#b7b7b7');
    expect(applied).toBe(0);
  });

  it('writes scores, notes and the total, and can overwrite them', () => {
    const sim = filled();
    const scores = [{ score: 8, note: '' }, { score: 7, note: 'walked instead of the gym' }, null, { score: 10, note: '' }, null, null];
    const { requests, total } = scoreRequests(sim.json(), scores);
    expect(total).toBe(25);
    sim.apply(requests);
    let text = sim.chars.map((c) => c.c).join('');
    expect(text).toContain('Row 1\n\u00038\n');
    expect(text).toContain('Row 2\n\u00037\n\u0003walked instead of the gym\n');
    expect(text).toContain('Total Score\n\u000325 / 60\n');
    // overwrite: change a score, clear a note
    scores[1] = { score: 5, note: '' };
    sim.apply(scoreRequests(sim.json(), scores).requests);
    text = sim.chars.map((c) => c.c).join('');
    expect(text).toContain('Row 2\n\u00035\n\u0003\n');
    expect(text).toContain('Total Score\n\u000323 / 60\n');
    // the task table still parses after score edits
    expect(readTasks(sim.json())).toHaveLength(4);
  });
});
