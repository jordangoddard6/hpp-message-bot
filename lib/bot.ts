// Conversation logic for one user. Every entry point receives a Ctx holding that user's
// row (locked for the duration), and mutates `ctx.user`; the caller saves it afterwards.
import type { DateTime } from 'luxon';
import {
  EVENING_INTRO, MORNING_INTRO, eveningScheduledBlocks, homeBlocks, menuBlocks,
  morningScheduledBlocks, prettyDay, questionBlocks, questionTitle, scoreBlocks, scoreTitle, settingsModal,
  updateMessageBlocks, CHUNK,
} from './blocks.js';
import { DOC_PREFIX, QUESTIONS, REVIEW_ROWS, SCHEDULE_AHEAD_DAYS } from './config.js';
import type { Store } from './db.js';
import { GoogleAuthError, docUrl, type HppDrive } from './google.js';
import { taskHash } from './hppdoc.js';
import type { Block, SlackApi } from './slack.js';
import { addDays, cycleDay, eveningAt, formatTime, isActiveDay, localDay, morningAt } from './time.js';
import type { Line, Score, Task, TaskRef, User } from './types.js';

export interface Ctx {
  user: User;
  store: Store;
  slack: SlackApi;
  drive: HppDrive;
  now: DateTime;
  signupUrl: () => string;
}

// What a button / checkbox tap looks like once parsed from Slack's payload.
export interface Action {
  actionId: string;
  value: string;
  selected?: string[]; // checkbox values for this element
  stateValues?: Record<string, Record<string, { selected_options?: { value: string }[] }>>;
  messageTs?: string;
  messageBlocks?: Block[];
  channel?: string;
  triggerId?: string;
  responseUrl?: string;
  fromHome: boolean;
}

const N = QUESTIONS.length;

// ---------- small helpers ----------

async function say(ctx: Ctx, text: string, blocks?: Block[]): Promise<string> {
  return ctx.slack.post(ctx.user.dmChannel!, text, blocks);
}

async function ephemeral(a: Action | { responseUrl?: string }, text: string, ctx?: Ctx) {
  if (a.responseUrl) {
    await ctx?.slack.respond(a.responseUrl, { response_type: 'ephemeral', replace_original: false, text });
  }
}

// The day questions belong to right now. An early /hpp start (before the morning time)
// counts as today rather than yesterday.
export function today(ctx: Ctx): string {
  const cd = cycleDay(ctx.user, ctx.now);
  const sd = ctx.user.state.day;
  return sd && sd > cd ? sd : cd;
}

export function todaysDoc(ctx: Ctx): string | null {
  const st = ctx.user.state;
  return st.docId && st.docDay === today(ctx) && st.phase !== 'morning' ? st.docId : null;
}

// Removes the buttons from the current question's message.
async function retire(ctx: Ctx) {
  const st = ctx.user.state;
  if (!st.msgTs) return;
  const ts = st.msgTs;
  st.msgTs = undefined;
  await ctx.slack.update(ctx.user.dmChannel!, ts, st.msgText || 'Answered', [
    { type: 'section', text: { type: 'mrkdwn', text: st.msgText || 'Answered' } },
  ]).catch(() => undefined);
}

async function retireMessage(ctx: Ctx, a: Action) {
  if (!a.messageTs || !a.channel || !a.messageBlocks) return;
  const kept = a.messageBlocks.filter((b) => b.type !== 'actions');
  await ctx.slack.update(a.channel, a.messageTs, 'Answered', kept).catch(() => undefined);
}

// Discards unfinished answers from an earlier cycle.
export async function normalizeCycle(ctx: Ctx) {
  const st = ctx.user.state;
  const cd = cycleDay(ctx.user, ctx.now);
  if (st.phase !== 'idle' && st.day && st.day < cd) {
    await retire(ctx);
    ctx.user.state = { phase: 'idle', docId: st.docId, docDay: st.docDay, scoredDay: st.scoredDay };
    ctx.user.carry = null;
  }
  // Scores, notes and the checklist only live for their own day.
  const s = ctx.user.state;
  if (s.docDay && s.docDay < cd && (s.scores || s.checklist)) {
    delete s.scores;
    delete s.checklist;
  }
}

export function parseLines(text: string): Line[] {
  return text.split(/\r?\n/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .map((s) => ({ text: s, level: 0 }));
}

// ---------- scheduling ----------

export async function ensureScheduled(ctx: Ctx) {
  const u = ctx.user;
  const rows = await ctx.store.listScheduled(u.id);
  const current = today(ctx);
  for (const r of rows) {
    if (r.day < addDays(current, -1)) await ctx.store.removeScheduled(u.id, r.kind, r.day);
  }
  // Drop scheduled messages Slack has that we have no record of (e.g. from a failed
  // sign-up whose database changes were rolled back), so they never arrive.
  if (u.dmChannel) {
    const known = new Set(rows.map((r) => r.scheduledId));
    for (const id of await ctx.slack.listScheduled(u.dmChannel)) {
      if (!known.has(id)) await ctx.slack.unschedule(u.dmChannel, id);
    }
  }
  if (u.paused || u.needsReconnect || !u.refreshTokenEnc || !u.dmChannel) return;
  const soon = ctx.now.plus({ minutes: 1 });
  for (let i = 0; i < SCHEDULE_AHEAD_DAYS; i++) {
    const day = addDays(localDay(u, ctx.now), i);
    const at = morningAt(u, day);
    if (!isActiveDay(u, day) || at <= soon) continue;
    if (rows.some((r) => r.kind === 'morning' && r.day === day)) continue;
    if (u.state.docDay === day) continue; // planned early already
    const id = await ctx.slack.schedule(u.dmChannel, Math.floor(at.toSeconds()), 'Good morning! Time to plan today.',
      morningScheduledBlocks(day));
    await ctx.store.addScheduled(u.id, { kind: 'morning', day, postAt: Math.floor(at.toSeconds()), scheduledId: id, channel: u.dmChannel });
  }
}

export async function clearScheduled(ctx: Ctx, kinds: string[] = ['morning', 'evening'], day?: string) {
  const nowSec = ctx.now.toSeconds();
  for (const r of await ctx.store.listScheduled(ctx.user.id)) {
    if (!kinds.includes(r.kind) || (day && r.day !== day) || r.postAt <= nowSec) continue;
    await ctx.slack.unschedule(r.channel, r.scheduledId);
    await ctx.store.removeScheduled(ctx.user.id, r.kind, r.day);
  }
}

async function scheduleEvening(ctx: Ctx, day: string) {
  const u = ctx.user;
  await clearScheduled(ctx, ['evening'], day);
  const at = eveningAt(u, day);
  if (u.paused || at <= ctx.now.plus({ minutes: 1 })) return;
  const id = await ctx.slack.schedule(u.dmChannel!, Math.floor(at.toSeconds()), 'Time for your daily review.',
    eveningScheduledBlocks(day));
  await ctx.store.addScheduled(u.id, { kind: 'evening', day, postAt: Math.floor(at.toSeconds()), scheduledId: id, channel: u.dmChannel! });
}

async function morningWasSent(ctx: Ctx, day: string): Promise<boolean> {
  const nowSec = ctx.now.toSeconds();
  return (await ctx.store.listScheduled(ctx.user.id))
    .some((r) => r.kind === 'morning' && r.day === day && r.postAt <= nowSec);
}

// ---------- morning questions ----------

export async function startMorning(ctx: Ctx, day: string, silent = false) {
  const u = ctx.user;
  await retire(ctx);
  const prev = await ctx.drive.findPreviousDoc(u.folderId!, day);
  const groups = prev ? await ctx.drive.readCarry(prev.id) : {};
  u.carry = { date: prev ? prev.day : null, groups };
  const keep: Record<string, boolean[]> = {};
  for (const [k, gs] of Object.entries(groups)) keep[k] = gs.map(() => true);
  const old = u.state;
  u.state = {
    phase: 'morning', day, q: 0, answers: {}, keep,
    replaceDocId: old.docDay === day ? old.docId : null,
    docId: old.docId, docDay: old.docDay,
  };
  if (!silent) {
    await say(ctx, 'Good morning!', [{ type: 'section', text: { type: 'mrkdwn', text: MORNING_INTRO } }]);
    await askQuestion(ctx);
  }
}

async function askQuestion(ctx: Ctx) {
  const st = ctx.user.state;
  const q = st.q!;
  const key = QUESTIONS[q].key;
  const groups = ctx.user.carry?.groups[key] || [];
  await retire(ctx);
  st.msgText = questionTitle(q);
  st.msgTs = await say(ctx, QUESTIONS[q].prompt,
    questionBlocks(st.day!, q, groups, st.keep?.[key] || [], ctx.user.carry?.date || null));
}

function keptLines(ctx: Ctx): Line[] {
  const st = ctx.user.state;
  const key = QUESTIONS[st.q!].key;
  const groups = ctx.user.carry?.groups[key] || [];
  const keep = st.keep?.[key] || [];
  return groups.filter((_, i) => keep[i]).flatMap((g) => g.lines);
}

async function answer(ctx: Ctx, lines: Line[]) {
  const st = ctx.user.state;
  st.answers![QUESTIONS[st.q!].key] = lines;
  st.q = st.q! + 1;
  if (st.q < N) return askQuestion(ctx);
  await finishMorning(ctx);
}

async function goBack(ctx: Ctx) {
  const st = ctx.user.state;
  if (st.q === 0) {
    await say(ctx, 'This is the first question.');
    return;
  }
  st.q = Math.min(st.q!, N) - 1;
  await askQuestion(ctx);
}

async function morningText(ctx: Ctx, text: string) {
  const upper = text.trim().toUpperCase();
  if (upper === 'BACK') return goBack(ctx);
  if (ctx.user.state.q! >= N) return finishMorning(ctx); // retry after a failed create
  if (upper === 'SKIP') return answer(ctx, []);
  await answer(ctx, [...keptLines(ctx), ...parseLines(text)]);
}

async function finishMorning(ctx: Ctx) {
  const u = ctx.user;
  const st = u.state;
  await retire(ctx);
  await say(ctx, 'Creating today’s doc…');
  let docId: string;
  try {
    u.templateId = await ctx.drive.ensureTemplate(u.folderId!, u.templateId);
    docId = await ctx.drive.createDailyDoc(u.folderId!, u.templateId, st.day!, st.answers!);
  } catch (e) {
    if (e instanceof GoogleAuthError) return authLost(ctx);
    await ctx.store.recordError(u.id, 'create-doc', e instanceof Error ? e.message : String(e));
    await say(ctx, '⚠️ I couldn’t create your doc. Your answers are saved – reply *RETRY* to try again.');
    return;
  }
  if (st.replaceDocId) await ctx.drive.trash(st.replaceDocId).catch(() => undefined);
  const day = st.day!;
  u.state = { phase: 'idle', day, docId, docDay: day, scores: REVIEW_ROWS.map(() => null) };
  u.carry = null;
  await clearScheduled(ctx, ['morning'], day); // planned before the morning message went out
  await scheduleEvening(ctx, day);
  await say(ctx, 'Your plan is ready.', [{
    type: 'section',
    text: { type: 'mrkdwn', text: `✅ <${docUrl(docId)}|${DOC_PREFIX}${day}> is ready.\n\n` +
      'Check off finished tasks on my *Home* tab or with `/hpp-update`.' },
  }]);
}

async function morningAction(ctx: Ctx, a: Action) {
  const st = ctx.user.state;
  if (a.actionId.startsWith('m_carry_')) {
    // Checkbox taps carry no value, so match them to the current question's message.
    if (st.phase !== 'morning' || !a.messageTs || a.messageTs !== st.msgTs) return;
    const key = QUESTIONS[st.q!].key;
    const c = Number(a.actionId.slice('m_carry_'.length));
    const picked = new Set((a.selected || []).map(Number));
    const keep = st.keep![key] || [];
    for (let i = c * CHUNK; i < Math.min(keep.length, (c + 1) * CHUNK); i++) keep[i] = picked.has(i);
    st.keep![key] = keep;
    return;
  }
  const [day, qs] = a.value.split(':');
  const q = Number(qs);
  const current = today(ctx);

  if (st.phase === 'idle' && q === 0 && day === current && !todaysDoc(ctx) && a.actionId === 'm_skip') {
    await startMorning(ctx, day, true); // tapped Skip on the scheduled 8am message
    ctx.user.state.msgTs = a.messageTs;
    ctx.user.state.msgText = questionTitle(0);
  }
  const s = ctx.user.state;
  if (s.phase !== 'morning' || s.day !== day || s.q !== q) {
    await retireMessage(ctx, a);
    await ephemeral(a, 'That question has moved on.', ctx);
    return;
  }
  if (a.messageTs) s.msgTs = a.messageTs;
  const key = QUESTIONS[q].key;

  if (a.actionId === 'm_back') return goBack(ctx);
  if (a.actionId === 'm_skip') return answer(ctx, []);
  if (a.actionId === 'm_done') {
    // Trust the checkbox state Slack sends with the tap over individual toggle events.
    if (a.stateValues) {
      const keep = s.keep![key] || [];
      const picked = new Set<number>();
      let sawAny = false;
      for (const [blockId, acts] of Object.entries(a.stateValues)) {
        if (!blockId.startsWith('carry_')) continue;
        for (const v of Object.values(acts)) {
          sawAny = true;
          (v.selected_options || []).forEach((o) => picked.add(Number(o.value)));
        }
      }
      if (sawAny) s.keep![key] = keep.map((_, i) => picked.has(i));
    }
    return answer(ctx, keptLines(ctx));
  }
}

// ---------- scoring ----------

async function startScoring(ctx: Ctx, silent = false) {
  const st = ctx.user.state;
  st.phase = 'scoring';
  st.scoreIdx = 0;
  st.scores = st.scores || REVIEW_ROWS.map(() => null);
  if (!silent) {
    await say(ctx, 'Daily review', [{ type: 'section', text: { type: 'mrkdwn', text: EVENING_INTRO } }]);
    await askScore(ctx);
  }
}

async function askScore(ctx: Ctx) {
  const st = ctx.user.state;
  await retire(ctx);
  st.msgText = scoreTitle(st.scoreIdx!);
  st.msgTs = await say(ctx, REVIEW_ROWS[st.scoreIdx!], scoreBlocks(st.docDay!, st.scoreIdx!));
}

export function parseScore(text: string): Score | null {
  const m = /^(10|[1-9])(?:\s*\/\s*10)?(?![\d.])[\s\-–—:,.]*([\s\S]*)$/.exec(text.trim());
  return m ? { score: Number(m[1]), note: m[2].trim() } : null;
}

async function scoreText(ctx: Ctx, text: string) {
  const upper = text.trim().toUpperCase();
  if (upper === 'BACK') return scoreBack(ctx);
  if (upper === 'SKIP') return recordScore(ctx, null);
  const s = parseScore(text);
  if (!s) {
    await say(ctx, 'Reply with a score from 1 to 10 (optionally followed by a note), or BACK / SKIP.');
    return;
  }
  await recordScore(ctx, s);
}

async function scoreBack(ctx: Ctx) {
  const st = ctx.user.state;
  if (st.scoreIdx === 0) {
    await say(ctx, 'This is the first one.');
    return;
  }
  st.scoreIdx = st.scoreIdx! - 1;
  await askScore(ctx);
}

async function recordScore(ctx: Ctx, entry: Score | null) {
  const st = ctx.user.state;
  st.scores![st.scoreIdx!] = entry;
  let total: number;
  try {
    total = await ctx.drive.writeScores(st.docId!, st.scores!); // saved right away
  } catch (e) {
    if (e instanceof GoogleAuthError) return authLost(ctx);
    await ctx.store.recordError(ctx.user.id, 'write-scores', e instanceof Error ? e.message : String(e));
    await say(ctx, '⚠️ I couldn’t save that score to your doc. Try again in a moment.');
    return;
  }
  st.scoreIdx = st.scoreIdx! + 1;
  if (st.scoreIdx < REVIEW_ROWS.length) return askScore(ctx);

  await retire(ctx);
  st.phase = 'idle';
  st.scoredDay = st.docDay;
  await clearScheduled(ctx, ['evening'], st.docDay);
  const scored = st.scores!.filter(Boolean).length;
  await say(ctx, `Total: ${total} / 60`, [{
    type: 'section',
    text: { type: 'mrkdwn', text: `🏁 *Total: ${total} / 60*` +
      (scored < REVIEW_ROWS.length ? ` (${scored} of ${REVIEW_ROWS.length} scored)` : '') +
      `\n<${docUrl(st.docId!)}|Open today’s doc>` },
  }]);
}

async function scoreAction(ctx: Ctx, a: Action) {
  const [day, is, n] = a.value.split(':');
  const idx = Number(is);
  let st = ctx.user.state;
  if (st.phase === 'idle' && idx === 0 && day === today(ctx) && todaysDoc(ctx) && st.scoredDay !== day) {
    await startScoring(ctx, true); // tapped on the scheduled 10:30pm message
    st = ctx.user.state;
    st.msgTs = a.messageTs;
    st.msgText = scoreTitle(0);
  }
  if (st.phase !== 'scoring' || st.docDay !== day || st.scoreIdx !== idx) {
    await retireMessage(ctx, a);
    await ephemeral(a, 'That question has moved on.', ctx);
    return;
  }
  if (a.messageTs) st.msgTs = a.messageTs;
  if (a.actionId === 's_back') return scoreBack(ctx);
  if (a.actionId === 's_skip') return recordScore(ctx, null);
  const prev = st.scores![idx];
  await recordScore(ctx, { score: Number(n), note: prev?.note || '' }); // keeps a note typed earlier
}

// ---------- task checklist ----------

const refs = (tasks: Task[]): TaskRef[] =>
  tasks.map((t) => ({ area: t.area, index: t.index, hash: taskHash(t.text), done: t.done }));

async function sendChecklist(ctx: Ctx) {
  const st = ctx.user.state;
  const docId = todaysDoc(ctx);
  if (st.phase === 'morning') return void await say(ctx, 'Finish the morning questions first.');
  if (!docId) return void await say(ctx, 'There’s no doc for today yet. Start one with `/hpp-start`.');
  const tasks = await ctx.drive.readTasks(docId);
  if (tasks === null) return void await say(ctx, 'I couldn’t open today’s doc. Was it moved to the trash?');
  if (!tasks.length) return void await say(ctx, 'Today’s task table is empty.');
  if (st.checklistTs) {
    await ctx.slack.update(ctx.user.dmChannel!, st.checklistTs, 'Replaced by a newer list.', []).catch(() => undefined);
  }
  st.checklist = { docId, items: refs(tasks) };
  st.checklistTs = await say(ctx, 'Update your tasks', updateMessageBlocks(today(ctx), tasks));
}

async function saveChecklist(ctx: Ctx, a: Action) {
  const st = ctx.user.state;
  const docId = todaysDoc(ctx);
  if (!docId || a.value !== today(ctx) || st.checklist?.docId !== docId) {
    if (!a.fromHome) await ctx.slack.update(a.channel!, a.messageTs!, 'This list is out of date.', [
      { type: 'section', text: { type: 'mrkdwn', text: 'This list is out of date. Use `/hpp-update` for a fresh one.' } },
    ]);
    return;
  }
  const picked = new Set<string>();
  for (const [blockId, acts] of Object.entries(a.stateValues || {})) {
    if (!blockId.startsWith('chk_')) continue;
    for (const v of Object.values(acts)) (v.selected_options || []).forEach((o) => picked.add(o.value));
  }
  const changes = st.checklist.items
    .filter((t) => picked.has(`${t.area}:${t.index}`) !== t.done)
    .map((t) => ({ ...t, done: !t.done }));
  let applied = 0;
  try {
    applied = changes.length ? await ctx.drive.applyTaskChanges(docId, changes) : 0;
  } catch (e) {
    if (e instanceof GoogleAuthError) return authLost(ctx);
    throw e;
  }
  const doneNow = st.checklist.items.filter((t) => picked.has(`${t.area}:${t.index}`)).length;
  let text = changes.length ? `Updated ${applied} task${applied === 1 ? '' : 's'}.` : 'No changes.';
  if (applied < changes.length) text += ' Some tasks changed in the doc since this list was made, so they were skipped.';
  text += ` ${doneNow} of ${st.checklist.items.length} done today.`;
  if (!a.fromHome && a.messageTs) {
    await ctx.slack.update(a.channel!, a.messageTs, text, [{ type: 'section', text: { type: 'mrkdwn', text } }]);
    if (st.checklistTs === a.messageTs) st.checklistTs = undefined;
  }
  st.checklist = undefined;
}

// ---------- commands ----------

// The day an explicit start plans: the calendar date, even before the morning time.
function planDay(ctx: Ctx): string {
  const cal = localDay(ctx.user, ctx.now);
  const cur = today(ctx);
  return cal > cur ? cal : cur;
}

export async function cmdStart(ctx: Ctx) {
  await normalizeCycle(ctx);
  const day = planDay(ctx);
  const st = ctx.user.state;
  if (st.docId && st.docDay === day && st.phase !== 'morning') {
    await say(ctx, 'Today’s doc already exists.', [
      { type: 'section', text: { type: 'mrkdwn', text: 'Today’s doc already exists. Answer the questions again and replace it?' } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Redo questions' }, action_id: 'r_yes', value: day, style: 'danger' },
        { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'r_no', value: day },
      ] },
    ]);
    return;
  }
  await startMorning(ctx, day);
}

export async function cmdScore(ctx: Ctx) {
  await normalizeCycle(ctx);
  if (ctx.user.state.phase === 'morning') return void await say(ctx, 'Finish the morning questions first.');
  if (!todaysDoc(ctx)) return void await say(ctx, 'There’s no doc for today yet.');
  await startScoring(ctx);
}

export async function cmdUpdate(ctx: Ctx) {
  await normalizeCycle(ctx);
  await sendChecklist(ctx);
}

export async function cmdPause(ctx: Ctx) {
  ctx.user.paused = true;
  await clearScheduled(ctx);
}

export async function cmdResume(ctx: Ctx) {
  ctx.user.paused = false;
  await ensureScheduled(ctx);
  const st = ctx.user.state;
  const doc = todaysDoc(ctx);
  if (doc && st.scoredDay !== st.docDay) await scheduleEvening(ctx, st.docDay!);
}

// ---------- settings ----------

export async function openSettings(ctx: Ctx, triggerId: string) {
  await ctx.slack.openModal(triggerId, settingsModal(ctx.user));
}

export function validateSettings(morning: string, evening: string, days: number[]): Record<string, string> | null {
  const errors: Record<string, string> = {};
  if (!days.length) errors.days = 'Pick at least one day.';
  if (evening <= morning) errors.evening = 'The evening review has to be later in the day than the morning questions.';
  return Object.keys(errors).length ? errors : null;
}

export async function saveSettings(ctx: Ctx, morning: string, evening: string, days: number[]) {
  const u = ctx.user;
  u.morningTime = morning;
  u.eveningTime = evening;
  u.days = [...days].sort();
  await clearScheduled(ctx);
  await ensureScheduled(ctx);
  const st = u.state;
  if (todaysDoc(ctx) && st.scoredDay !== st.docDay) await scheduleEvening(ctx, st.docDay!);
}

// ---------- Google access ----------

export async function authLost(ctx: Ctx) {
  const u = ctx.user;
  if (u.needsReconnect) return;
  u.needsReconnect = true;
  await clearScheduled(ctx);
  await say(ctx, 'I lost access to your Google Drive.', [{
    type: 'section',
    text: { type: 'mrkdwn', text: '⚠️ *I lost access to your Google Drive*, so I’ve stopped your daily messages. ' +
      'Open my *Home* tab and press *Reconnect Google Drive* to continue.' },
  }]);
}

// ---------- home ----------

export async function renderHome(ctx: Ctx) {
  const u = ctx.user;
  const day = today(ctx);
  const docId = todaysDoc(ctx);
  let tasks: Task[] | null | undefined;
  if (docId && u.refreshTokenEnc && !u.needsReconnect) {
    try {
      tasks = await ctx.drive.readTasks(docId);
      if (tasks) u.state.checklist = { docId, items: refs(tasks) };
    } catch (e) {
      if (e instanceof GoogleAuthError) await authLost(ctx);
      else tasks = null;
    }
  }
  const scores = u.state.docDay === day ? u.state.scores || [] : [];
  const scored = scores.filter(Boolean).length;
  const total = scores.reduce((sum, s) => sum + (s?.score || 0), 0);
  await ctx.slack.publishHome(u.id, homeBlocks(u, {
    signupUrl: ctx.signupUrl(), today: day, docId, tasks, scored, total,
  }));
}

// ---------- entry points ----------

export async function onMessage(ctx: Ctx, text: string) {
  await normalizeCycle(ctx);
  const st = ctx.user.state;
  if (st.phase === 'morning') return morningText(ctx, text);
  if (st.phase === 'scoring') return scoreText(ctx, text);

  const day = today(ctx);
  const doc = todaysDoc(ctx);
  if (doc && ctx.now >= eveningAt(ctx.user, day) && st.scoredDay !== day) {
    await startScoring(ctx, true); // replying to the scheduled 10:30pm message
    return scoreText(ctx, text);
  }
  if (!doc && isActiveDay(ctx.user, day) && !ctx.user.paused && await morningWasSent(ctx, day)) {
    await startMorning(ctx, day, true); // replying to the scheduled morning message
    return morningText(ctx, text);
  }
  await say(ctx, 'Nothing is waiting on an answer right now.', [
    { type: 'section', text: { type: 'mrkdwn', text: 'Nothing is waiting on an answer right now.' } },
    ...menuBlocks().slice(1),
  ]);
}

export async function onAction(ctx: Ctx, a: Action) {
  await normalizeCycle(ctx);
  const id = a.actionId;
  if (id.startsWith('m_')) return morningAction(ctx, a);
  if (id.startsWith('s_')) return scoreAction(ctx, a);
  if (id === 'u_save') {
    await saveChecklist(ctx, a);
    if (a.fromHome) await renderHome(ctx);
    return;
  }
  if (id === 'u_cancel') {
    await ctx.slack.update(a.channel!, a.messageTs!, 'Update cancelled.', [
      { type: 'section', text: { type: 'mrkdwn', text: 'Update cancelled.' } },
    ]);
    return;
  }
  if (id === 'r_yes' || id === 'r_no') {
    await retireMessage(ctx, a);
    if (id === 'r_yes' && a.value === planDay(ctx)) await startMorning(ctx, a.value);
    return;
  }
  if (id === 'h_start') return cmdStart(ctx);
  if (id === 'h_score') return cmdScore(ctx);
  if (id === 'h_update') return cmdUpdate(ctx);
  if (id === 'h_settings') return openSettings(ctx, a.triggerId!);
  if (id === 'h_pause') { await cmdPause(ctx); return renderHome(ctx); }
  if (id === 'h_resume') { await cmdResume(ctx); return renderHome(ctx); }
  // Link buttons, checkbox toggles and headers need no handling.
}

// Daily maintenance for one user.
export async function daily(ctx: Ctx) {
  await normalizeCycle(ctx);
  if (!ctx.user.refreshTokenEnc || ctx.user.needsReconnect) return;
  try {
    await ctx.drive.checkAccess();
  } catch (e) {
    if (e instanceof GoogleAuthError) return authLost(ctx);
    throw e;
  }
  await ensureScheduled(ctx);
}

export function welcomeText(ctx: Ctx, rows: { kind: string; day: string }[]): string {
  const next = rows.filter((r) => r.kind === 'morning').map((r) => r.day).sort()[0];
  const when = next ? `${prettyDay(next)} at ${formatTime(ctx.user.morningTime)}` : 'when you resume';
  return `👋 *You’re all set!* Your first planning questions arrive ${when}.\n\n` +
    'Change your times and days, pause, or check off tasks on my *Home* tab. Want to start now? `/hpp-start`';
}
