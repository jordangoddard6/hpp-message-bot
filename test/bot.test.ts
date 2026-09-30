import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cmdPause, cmdResume, cmdStart, cmdUpdate, ensureScheduled, onAction, onMessage, parseLines, parseScore,
  validateSettings, type Action, type Ctx,
} from '../lib/bot.js';
import type { Store } from '../lib/db.js';
import type { HppDrive } from '../lib/google.js';
import type { Block, SlackApi } from '../lib/slack.js';
import type { Group, Line, ScheduledRow, Score, Task, TaskRef, User } from '../lib/types.js';

// ---------- fakes ----------

class FakeSlack implements SlackApi {
  posts: { ts: string; text: string; blocks?: Block[] }[] = [];
  updates: { ts: string; text: string }[] = [];
  scheduled = new Map<string, { postAt: number; blocks?: Block[] }>();
  unscheduled: string[] = [];
  homes = 0;
  ephemerals: string[] = [];
  private n = 0;
  async post(_c: string, text: string, blocks?: Block[]) { const ts = `m${++this.n}`; this.posts.push({ ts, text, blocks }); return ts; }
  async update(_c: string, ts: string, text: string) { this.updates.push({ ts, text }); }
  async schedule(_c: string, postAt: number, _t: string, blocks?: Block[]) { const id = `s${++this.n}`; this.scheduled.set(id, { postAt, blocks }); return id; }
  async unschedule(_c: string, id: string) { this.unscheduled.push(id); this.scheduled.delete(id); }
  async listScheduled() { return [...this.scheduled.keys()]; }
  async publishHome() { this.homes++; }
  async openModal() {}
  async openDm() { return 'D1'; }
  async userTz() { return 'America/Denver'; }
  async respond(_u: string, body: Block) { this.ephemerals.push(String(body.text)); }
  last() { return this.posts[this.posts.length - 1]; }
  lastText() { return JSON.stringify(this.last().blocks || this.last().text); }
}

class FakeStore implements Store {
  rows: ScheduledRow[] = [];
  errors: string[] = [];
  async saveUser() {}
  async deleteUser() {}
  async listScheduled() { return this.rows.map((r) => ({ ...r })); }
  async addScheduled(_u: string, row: ScheduledRow) {
    this.rows = this.rows.filter((r) => !(r.kind === row.kind && r.day === row.day)).concat(row);
  }
  async removeScheduled(_u: string, kind: string, day: string) {
    this.rows = this.rows.filter((r) => !(r.kind === kind && r.day === day));
  }
  async recordError(_u: string | null, step: string, message: string) { this.errors.push(`${step}: ${message}`); }
}

interface FakeDoc { id: string; day: string; answers: Record<string, Line[]>; done: Set<string>; scores: (Score | null)[] }

class FakeDrive implements HppDrive {
  docs: FakeDoc[] = [];
  trashed: string[] = [];
  failNextCreate = false;
  carry: Record<string, Group[]> = {
    compass: [{ lines: [{ text: 'Be helpful and friendly', level: 0 }] }],
    work: [{ lines: [{ text: 'Apply to TaxHawk', level: 0 }] }, { lines: [{ text: 'Email Prof. Lee', level: 0 }] }],
    relations: [], physical: [], emotional: [],
    other: [{ lines: [{ text: 'Applying to jobs', level: 0 }, { text: 'Paramify', level: 1 }] }, { lines: [{ text: 'Health insurance', level: 0 }] }],
  };
  async checkAccess() {}
  async ensureFolder() { return 'folder'; }
  async ensureTemplate() { return 'template'; }
  async findPreviousDoc(_f: string, before: string) { return { id: 'prev', day: before === '2026-09-30' ? '2026-09-25' : '2026-09-29' }; }
  async readCarry() { return this.carry; }
  async createDailyDoc(_f: string, _t: string, day: string, answers: Record<string, Line[]>) {
    if (this.failNextCreate) { this.failNextCreate = false; throw new Error('boom'); }
    const id = `doc${this.docs.length + 1}`;
    this.docs.push({ id, day, answers: JSON.parse(JSON.stringify(answers)), done: new Set(), scores: [] });
    return id;
  }
  async trash(id: string) { this.trashed.push(id); }
  doc(id: string) { return this.docs.find((d) => d.id === id)!; }
  async readTasks(id: string): Promise<Task[]> {
    const d = this.doc(id);
    return ['work', 'relations', 'physical', 'emotional'].flatMap((area) =>
      (d.answers[area] || []).map((l, index) => ({ area, index, text: l.text, done: d.done.has(`${area}:${index}`) })));
  }
  async applyTaskChanges(id: string, changes: TaskRef[]) {
    const d = this.doc(id);
    changes.forEach((c) => (c.done ? d.done.add(`${c.area}:${c.index}`) : d.done.delete(`${c.area}:${c.index}`)));
    return changes.length;
  }
  async writeScores(id: string, scores: (Score | null)[]) {
    this.doc(id).scores = JSON.parse(JSON.stringify(scores));
    return scores.reduce((s, x) => s + (x?.score || 0), 0);
  }
}

// ---------- harness ----------

let slack: FakeSlack, store: FakeStore, drive: FakeDrive, ctx: Ctx;

function user(): User {
  return {
    id: 'U1', teamId: 'T1', appId: 'A1', dmChannel: 'D1', email: 'me@example.com', refreshTokenEnc: 'x',
    folderId: 'folder', templateId: 'template', tz: 'America/Denver', morningTime: '08:00', eveningTime: '22:30',
    days: [1, 2, 3, 4, 5, 6, 7], paused: false, needsReconnect: false, state: { phase: 'idle' }, carry: null,
  };
}

const at = (iso: string) => { ctx.now = DateTime.fromISO(iso, { zone: 'America/Denver' }).toUTC(); };
const act = (actionId: string, value: string, extra: Partial<Action> = {}) =>
  onAction(ctx, { actionId, value, fromHome: false, channel: 'D1', responseUrl: 'https://resp', ...extra });
const say = (text: string) => onMessage(ctx, text);

beforeEach(() => {
  slack = new FakeSlack();
  store = new FakeStore();
  drive = new FakeDrive();
  ctx = { user: user(), store, slack, drive, now: DateTime.utc(), signupUrl: () => 'https://signup' };
});

// ---------- tests ----------

describe('scheduling', () => {
  it('books the next week of mornings on chosen days only, and pause/resume clears and restores them', async () => {
    at('2026-09-30T09:00'); // Wednesday, after the morning time
    ctx.user.days = [1, 2, 3, 4, 5];
    await ensureScheduled(ctx);
    expect(store.rows.map((r) => r.day).sort()).toEqual(['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']);
    expect(store.rows[0].postAt).toBe(DateTime.fromISO('2026-10-01T08:00', { zone: 'America/Denver' }).toSeconds());
    await cmdPause(ctx);
    expect(store.rows).toHaveLength(0);
    expect(slack.scheduled.size).toBe(0);
    await cmdResume(ctx);
    expect(store.rows).toHaveLength(4);
  });

  it('uses the right UTC instant across the DST change', async () => {
    at('2026-10-30T12:00');
    await ensureScheduled(ctx);
    const nov2 = store.rows.find((r) => r.day === '2026-11-02')!;
    expect(new Date(nov2.postAt * 1000).toISOString()).toBe('2026-11-02T15:00:00.000Z'); // 8:00 MST
  });
});

describe('a full day', () => {
  it('runs morning questions from the scheduled message, creates the doc, then scores at night', async () => {
    at('2026-09-29T20:00');
    await ensureScheduled(ctx);
    at('2026-09-30T08:30'); // the 8am message has gone out

    await say('Dinner with Whiteley\n- Football game');
    expect(ctx.user.state).toMatchObject({ phase: 'morning', day: '2026-09-30', q: 1 });
    await say('Health');
    expect(slack.lastText()).toContain('(3/8) Compass');
    expect(slack.lastText()).toContain('Be helpful and friendly');
    await act('m_done', '2026-09-30:2');
    // Work: drop "Email Prof. Lee" (index 1), then type a new item
    expect(slack.lastText()).toContain('(4/8)');
    await act('m_carry_0', '', { selected: ['0'], messageTs: slack.last().ts });
    await say('Finish deck');
    await say('BACK');
    expect(ctx.user.state.q).toBe(3);
    await say('Finish deck\nStudy'); // keep state survives BACK
    await say('Call mom');
    await say('SKIP');
    await act('m_skip', '2026-09-30:6');
    // stale button on an earlier question
    await act('m_skip', '2026-09-30:2', { messageTs: 'old', messageBlocks: [{ type: 'actions' }] });
    expect(slack.ephemerals).toContain('That question has moved on.');
    // Other: done via state values, dropping Health insurance
    await act('m_done', '2026-09-30:7', { stateValues: { carry_0: { m_carry_0: { selected_options: [{ value: '0' }] } } } });

    expect(drive.docs).toHaveLength(1);
    const a = drive.docs[0].answers;
    expect(a.lookForward.map((l) => l.text)).toEqual(['Dinner with Whiteley', 'Football game']);
    expect(a.compass.map((l) => l.text)).toEqual(['Be helpful and friendly']);
    expect(a.work.map((l) => l.text)).toEqual(['Apply to TaxHawk', 'Finish deck', 'Study']);
    expect(a.relations.map((l) => l.text)).toEqual(['Call mom']);
    expect(a.physical).toEqual([]);
    expect(a.emotional).toEqual([]);
    expect(a.other).toEqual([{ text: 'Applying to jobs', level: 0 }, { text: 'Paramify', level: 1 }]);
    expect(ctx.user.state).toMatchObject({ phase: 'idle', docId: 'doc1', docDay: '2026-09-30' });
    expect(ctx.user.carry).toBeNull();
    const evening = store.rows.find((r) => r.kind === 'evening')!;
    expect(evening.day).toBe('2026-09-30');
    expect(new Date(evening.postAt * 1000).toISOString()).toBe('2026-10-01T04:30:00.000Z');

    // /hpp update: check off TaxHawk, via the message's checkbox state
    await cmdUpdate(ctx);
    expect(slack.lastText()).toContain('Apply to TaxHawk');
    await act('u_save', '2026-09-30', {
      messageTs: slack.last().ts,
      stateValues: { chk_work_0: { u_chk_work_0: { selected_options: [{ value: 'work:0' }] } } },
    });
    expect([...drive.doc('doc1').done]).toEqual(['work:0']);

    // Before the evening time, a stray message doesn't start anything
    await say('hello?');
    expect(slack.lastText()).toContain('Nothing is waiting');

    // 10:30pm: tap 8 on the scheduled message, then type the rest
    at('2026-09-30T22:31');
    await act('s_num_8', '2026-09-30:0:8', { messageTs: 'sched' });
    expect(ctx.user.state).toMatchObject({ phase: 'scoring', scoreIdx: 1 });
    await say('7 walked instead of the gym');
    await say('eleven');
    expect(slack.lastText()).toContain('score from 1 to 10');
    await say('BACK');
    await act('s_num_6', '2026-09-30:1:6');
    expect(drive.doc('doc1').scores[1]).toEqual({ score: 6, note: 'walked instead of the gym' });
    await act('s_skip', '2026-09-30:2');
    await say('10');
    await say('9/10 good');
    await say('5');
    expect(ctx.user.state).toMatchObject({ phase: 'idle', scoredDay: '2026-09-30' });
    expect(slack.lastText()).toContain('Total: 38 / 60');
    expect(slack.lastText()).toContain('5 of 6 scored');
  });

  it('throws away unfinished answers at the next morning and asks again', async () => {
    at('2026-09-29T20:00');
    await ensureScheduled(ctx);
    at('2026-09-30T08:30');
    await say('Something');
    await say('Else');
    expect(ctx.user.state.q).toBe(2);
    at('2026-10-01T08:10');
    await say('Fresh start');
    expect(ctx.user.state).toMatchObject({ phase: 'morning', day: '2026-10-01', q: 1 });
    expect(ctx.user.state.answers!.lookForward.map((l) => l.text)).toEqual(['Fresh start']);
    expect(drive.docs).toHaveLength(0);
  });

  it('does not start the morning questions on a day with no morning message', async () => {
    at('2026-09-30T09:00'); // signed up after today's morning time
    await ensureScheduled(ctx);
    await say('hi');
    expect(ctx.user.state.phase).toBe('idle');
    expect(slack.lastText()).toContain('Nothing is waiting');
  });

  it('keeps answers when creating the doc fails, and RETRY finishes it', async () => {
    at('2026-09-30T07:00');
    await cmdStart(ctx);
    drive.failNextCreate = true;
    for (let i = 0; i < 8; i++) await say(`answer ${i}`);
    expect(slack.lastText()).toContain('RETRY');
    expect(store.errors[0]).toContain('create-doc');
    expect(ctx.user.state.phase).toBe('morning');
    await say('RETRY');
    expect(drive.docs).toHaveLength(1);
    expect(drive.docs[0].answers.other.map((l) => l.text)).toContain('answer 7');
  });
});

describe('/hpp start', () => {
  it('plans today (not yesterday) before the morning time and cancels that morning message', async () => {
    at('2026-09-29T20:00');
    await ensureScheduled(ctx);
    const sept30 = store.rows.find((r) => r.day === '2026-09-30')!;
    at('2026-09-30T07:00');
    await cmdStart(ctx);
    expect(ctx.user.state.day).toBe('2026-09-30');
    for (let i = 0; i < 8; i++) await say('SKIP');
    expect(drive.docs[0].day).toBe('2026-09-30');
    expect(slack.unscheduled).toContain(sept30.scheduledId);
    // After 8am a message doesn't restart the questions
    at('2026-09-30T08:05');
    await say('hi');
    expect(ctx.user.state.phase).toBe('idle');
  });

  it('asks before redoing an existing doc and trashes the old one', async () => {
    at('2026-09-30T09:00');
    await cmdStart(ctx);
    for (let i = 0; i < 8; i++) await say('x');
    await cmdStart(ctx);
    expect(slack.lastText()).toContain('already exists');
    await act('r_yes', '2026-09-30', { messageTs: slack.last().ts, messageBlocks: slack.last().blocks });
    for (let i = 0; i < 8; i++) await say('y');
    expect(drive.docs).toHaveLength(2);
    expect(drive.trashed).toEqual(['doc1']);
    expect(ctx.user.state.docId).toBe('doc2');
  });
});

describe('parsing', () => {
  it('splits lines and strips list markers', () => {
    expect(parseLines(' - one\n\n2) two\n• three\nfour ').map((l) => l.text)).toEqual(['one', 'two', 'three', 'four']);
  });
  it('reads scores with optional notes', () => {
    expect(parseScore('7 walked')).toEqual({ score: 7, note: 'walked' });
    expect(parseScore('10')).toEqual({ score: 10, note: '' });
    expect(parseScore('9/10 - good')).toEqual({ score: 9, note: 'good' });
    expect(parseScore('11')).toBeNull();
    expect(parseScore('7.5')).toBeNull();
  });
  it('validates settings', () => {
    expect(validateSettings('08:00', '22:30', [1])).toBeNull();
    expect(validateSettings('08:00', '07:00', [])).toEqual({
      days: expect.any(String), evening: expect.any(String),
    });
  });
});
