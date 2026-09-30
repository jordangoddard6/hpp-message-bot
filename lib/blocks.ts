// Block Kit layouts. Button values carry the day (and question/row) they belong to, so
// taps on old messages can be recognised and ignored.
import { DateTime } from 'luxon';
import { APP_NAME, AREAS, QUESTIONS, REVIEW_ROWS, areaName } from './config.js';
import { docUrl, folderUrl } from './google.js';
import { esc, plain, type Block } from './slack.js';
import { dayName, formatDays, formatTime } from './time.js';
import type { Group, Task, User } from './types.js';

export const CHUNK = 10; // Slack allows at most 10 options per checkbox group

const section = (text: string): Block => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text: string): Block => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
// Slack rejects an empty `value`, so it's only included when there is one.
const button = (text: string, action_id: string, value = '', style?: 'primary' | 'danger'): Block =>
  ({ type: 'button', text: plain(text), action_id, ...(value ? { value } : {}), ...(style ? { style } : {}) });
const linkButton = (text: string, action_id: string, url: string): Block =>
  ({ type: 'button', text: plain(text), action_id, url });
const actions = (elements: Block[], block_id?: string): Block =>
  ({ type: 'actions', elements, ...(block_id ? { block_id } : {}) });

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

export const prettyDay = (day: string) => DateTime.fromISO(day).toFormat('ccc, LLL d');

// ---------- morning ----------

export const questionTitle = (q: number) => `*(${q + 1}/${QUESTIONS.length}) ${QUESTIONS[q].prompt}*`;

export const MORNING_INTRO =
  `☀️ *Good morning!* ${QUESTIONS.length} questions for today's plan. ` +
  'Put each item on its own line (Shift + Enter for a new line).';

export function questionBlocks(day: string, q: number, groups: Group[], keep: boolean[], carryDate: string | null): Block[] {
  const value = `${day}:${q}`;
  const blocks: Block[] = [section(questionTitle(q))];
  if (groups.length) {
    blocks.push(context(`From ${carryDate}: uncheck anything to drop, then press *Done*. ` +
      'Or type new items to add them to the checked ones.'));
    const options = groups.map((g, i) => ({
      text: plain(g.lines[0].text + (g.lines.length > 1 ? ` (+${g.lines.length - 1})` : '')),
      value: String(i),
    }));
    chunks(options).forEach((opts, c) => {
      const initial = opts.filter((o) => keep[Number(o.value)]);
      blocks.push(actions([{
        type: 'checkboxes',
        action_id: `m_carry_${c}`,
        options: opts,
        ...(initial.length ? { initial_options: initial } : {}),
      }], `carry_${c}`));
    });
  }
  const nav: Block[] = [];
  if (groups.length) nav.push(button('Done', 'm_done', value, 'primary'));
  if (q > 0) nav.push(button('⬅️ Back', 'm_back', value));
  nav.push(button('Skip ➡️', 'm_skip', value));
  blocks.push(actions(nav));
  return blocks;
}

export function morningScheduledBlocks(day: string): Block[] {
  return [section(MORNING_INTRO), ...questionBlocks(day, 0, [], [], null)];
}

// ---------- scoring ----------

export const scoreTitle = (i: number) => `*(${i + 1}/${REVIEW_ROWS.length}) ${REVIEW_ROWS[i]}*`;
export const EVENING_INTRO = '🌙 *Daily review* – score each from 1 to 10.';

export function scoreBlocks(day: string, i: number): Block[] {
  const value = `${day}:${i}`;
  const nav: Block[] = [];
  if (i > 0) nav.push(button('⬅️ Back', 's_back', value));
  nav.push(button('Skip ➡️', 's_skip', value));
  return [
    section(scoreTitle(i)),
    context('Tap a score, or type one with a note, like `7 walked instead of the gym`.'),
    actions(Array.from({ length: 10 }, (_, k) => button(String(k + 1), `s_num_${k + 1}`, `${value}:${k + 1}`))),
    actions(nav),
  ];
}

export function eveningScheduledBlocks(day: string): Block[] {
  return [section(EVENING_INTRO), ...scoreBlocks(day, 0)];
}

// ---------- task checklist (Home tab and /hpp update) ----------

export function checklistBlocks(day: string, tasks: Task[]): Block[] {
  const blocks: Block[] = [];
  for (const area of AREAS) {
    const mine = tasks.filter((t) => t.area === area.key);
    if (!mine.length) continue;
    blocks.push(section(`*${areaName(area.key)}*`));
    chunks(mine).forEach((part, c) => {
      const options = part.map((t) => ({ text: plain(t.text), value: `${t.area}:${t.index}` }));
      const initial = options.filter((_, i) => part[i].done);
      blocks.push(actions([{
        type: 'checkboxes',
        action_id: `u_chk_${area.key}_${c}`,
        options,
        ...(initial.length ? { initial_options: initial } : {}),
      }], `chk_${area.key}_${c}`));
    });
  }
  blocks.push(actions([button('Save', 'u_save', day, 'primary')]));
  return blocks;
}

export function updateMessageBlocks(day: string, tasks: Task[]): Block[] {
  const blocks = [section('Check off what’s done (it turns gray in your doc), then press *Save*.'), ...checklistBlocks(day, tasks)];
  const last = blocks[blocks.length - 1] as { elements: Block[] };
  last.elements.push(button('Cancel', 'u_cancel', day));
  return blocks;
}

// ---------- Home tab ----------

export interface HomeInfo {
  signupUrl?: string; // when signed out or reconnecting
  today: string;
  tasks?: Task[] | null; // null = doc unreadable
  docId?: string | null;
  scored?: number;
  total?: number;
}

const PRIVACY =
  '🔒 Your answers are only stored until your doc is created, then deleted from the bot. Your docs live in *your* ' +
  'Google Drive, and the bot can only open files it created. Leave any time and your data is erased.';

export function homeBlocks(u: User | null, info: HomeInfo): Block[] {
  if (!u || !u.refreshTokenEnc) {
    return [
      { type: 'header', text: plain(APP_NAME) },
      section('Daily *High Performance Planning*, one question at a time. Each morning I’ll ask your planning ' +
        'questions here and create *High Performance Planning YYYY-MM-DD* in your Google Drive. At night, I’ll ' +
        'ask for your daily review scores.'),
      section('You choose the times and days, and you can pause or leave whenever you like.'),
      actions([linkButton('Get started', 'h_signup', info.signupUrl!)]),
      context(PRIVACY),
    ];
  }
  if (u.needsReconnect) {
    return [
      { type: 'header', text: plain(APP_NAME) },
      section('⚠️ *I lost access to your Google Drive*, so daily messages are stopped. Reconnect to pick up where you left off.'),
      actions([linkButton('Reconnect Google Drive', 'h_signup', info.signupUrl!)]),
      actions([leaveButton()]),
    ];
  }

  const schedule = u.paused
    ? '⏸ *Paused* – no daily messages until you resume.'
    : `*Daily messages:* ${formatTime(u.morningTime)} and ${formatTime(u.eveningTime)}, ${formatDays(u.days)} (${u.tz})`;
  const blocks: Block[] = [
    { type: 'header', text: plain(APP_NAME) },
    section(schedule),
    actions([
      button('⚙️ Settings', 'h_settings'),
      u.paused ? button('▶️ Resume', 'h_resume', '', 'primary') : button('⏸ Pause', 'h_pause'),
      ...(u.folderId ? [linkButton('📁 My HPP folder', 'h_folder', folderUrl(u.folderId))] : []),
    ]),
    { type: 'divider' },
    section(`*Today – ${prettyDay(info.today)}*`),
  ];

  const st = u.state;
  if (st.phase === 'morning' && st.day === info.today) {
    blocks.push(section(`📝 Morning questions in progress (${(st.q ?? 0) + 1}/${QUESTIONS.length}) – answer in the *Messages* tab.`));
  } else if (info.docId) {
    blocks.push(actions([linkButton('📄 Open today’s doc', 'h_doc', docUrl(info.docId))]));
    if (info.tasks === null) {
      blocks.push(context('I couldn’t open today’s doc. Was it moved to the trash?'));
    } else if (info.tasks && info.tasks.length) {
      blocks.push(context('Check off what’s done – it turns gray in your doc when you press Save.'));
      blocks.push(...checklistBlocks(info.today, info.tasks));
    }
    const scored = info.scored ?? 0;
    blocks.push(scored === REVIEW_ROWS.length
      ? section(`✅ *Daily review done:* ${info.total} / 60`)
      : section(`*Daily review:* ${scored} of ${REVIEW_ROWS.length} scored`));
    if (scored < REVIEW_ROWS.length) blocks.push(actions([button('🌙 Score now', 'h_score')]));
  } else {
    blocks.push(section('No plan yet today.'));
    blocks.push(actions([button('📝 Plan today', 'h_start', '', 'primary')]));
  }

  blocks.push({ type: 'divider' });
  blocks.push(context(PRIVACY));
  blocks.push(actions([leaveButton()]));
  return blocks;
}

function leaveButton(): Block {
  return {
    type: 'button',
    text: plain('Leave and delete my data'),
    action_id: 'h_leave',
    style: 'danger',
    confirm: {
      title: plain('Leave HPP Message Bot?'),
      text: { type: 'mrkdwn', text: 'Daily messages stop and everything the bot stores about you is erased. ' +
        'Your docs stay in your Google Drive.' },
      confirm: plain('Leave'),
      deny: plain('Cancel'),
      style: 'danger',
    },
  };
}

// ---------- settings modal ----------

export function settingsModal(u: User): Block {
  const dayOptions = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ text: plain(dayName(d)), value: String(d) }));
  return {
    type: 'modal',
    callback_id: 'settings',
    title: plain('Settings'),
    submit: plain('Save'),
    close: plain('Cancel'),
    blocks: [
      context(`Times are in your Slack time zone (${esc(u.tz)}).`),
      {
        type: 'input', block_id: 'morning', label: plain('Morning questions'),
        element: { type: 'timepicker', action_id: 'v', initial_time: u.morningTime },
      },
      {
        type: 'input', block_id: 'evening', label: plain('Evening daily review'),
        element: { type: 'timepicker', action_id: 'v', initial_time: u.eveningTime },
      },
      {
        type: 'input', block_id: 'days', label: plain('Days'),
        element: {
          type: 'checkboxes', action_id: 'v', options: dayOptions,
          initial_options: dayOptions.filter((o) => u.days.includes(Number(o.value))),
        },
      },
    ],
  };
}

// ---------- /hpp menu ----------

export function menuBlocks(): Block[] {
  return [
    section('*HPP Message Bot* – what would you like to do?'),
    actions([
      button('📝 Plan today', 'h_start'),
      button('✅ Update tasks', 'h_update'),
      button('🌙 Score now', 'h_score'),
      button('⚙️ Settings', 'h_settings'),
    ]),
    context('Also: `/hpp start`, `/hpp update`, `/hpp score`, `/hpp pause`, `/hpp resume`. ' +
      'Your Home tab has your checklist and settings.'),
  ];
}
