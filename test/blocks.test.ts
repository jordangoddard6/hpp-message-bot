// Checks every layout the bot sends against Slack Block Kit rules that Slack enforces
// at runtime (and that a type checker can't see).
import { describe, expect, it } from 'vitest';
import {
  eveningScheduledBlocks, homeBlocks, menuBlocks, morningScheduledBlocks, questionBlocks, scoreBlocks,
  settingsModal, updateMessageBlocks,
} from '../lib/blocks.js';
import type { Block } from '../lib/slack.js';
import type { Group, Task, User } from '../lib/types.js';

function problems(blocks: Block[]): string[] {
  const out: string[] = [];
  let actionIds = new Set<string>(); // action_id must be unique within its block
  const blockIds = new Set<string>();
  const visit = (el: Record<string, any>, path: string) => {
    if (!el || typeof el !== 'object') return;
    if (el.block_id) {
      if (blockIds.has(el.block_id)) out.push(`${path}: duplicate block_id ${el.block_id}`);
      blockIds.add(el.block_id);
    }
    if (el.action_id) {
      if (actionIds.has(el.action_id)) out.push(`${path}: duplicate action_id ${el.action_id}`);
      actionIds.add(el.action_id);
    }
    if (el.type === 'button') {
      if ('value' in el && !el.value) out.push(`${path}: empty button value`);
      if (el.text.text.length > 75) out.push(`${path}: button text too long`);
      if ((el.value || '').length > 2000) out.push(`${path}: value too long`);
    }
    if (el.type === 'checkboxes') {
      if (el.options.length < 1 || el.options.length > 10) out.push(`${path}: ${el.options.length} checkbox options`);
      if (el.initial_options && !el.initial_options.length) out.push(`${path}: empty initial_options`);
      for (const o of el.options) if (o.text.text.length > 75 || !o.value) out.push(`${path}: bad option`);
    }
    if (el.type === 'plain_text' && !el.text) out.push(`${path}: empty text`);
    if (el.type === 'header' && el.text.text.length > 150) out.push(`${path}: header too long`);
    if (el.type === 'section' && el.text && el.text.text.length > 3000) out.push(`${path}: section too long`);
    if (el.type === 'actions' && (el.elements.length < 1 || el.elements.length > 25)) out.push(`${path}: actions size`);
    for (const [k, v] of Object.entries(el)) {
      if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${path}.${k}[${i}]`));
      else if (v && typeof v === 'object') visit(v, `${path}.${k}`);
    }
  };
  const each = (list: Block[], prefix: string) => list.forEach((b, i) => {
    actionIds = new Set();
    if (b.type === 'modal') return each(b.blocks as Block[], `${prefix}[${i}].blocks`);
    visit(b, `${prefix}[${i}]`);
  });
  each(blocks, '');
  if (blocks.length > 100) out.push('more than 100 blocks');
  return out;
}

const long = 'x'.repeat(200);
const groups: Group[] = Array.from({ length: 23 }, (_, i) => ({ lines: [{ text: `${long} ${i}`, level: 0 }, { text: 'sub', level: 1 }] }));
const tasks: Task[] = ['work', 'relations', 'physical', 'emotional'].flatMap((area) =>
  Array.from({ length: 12 }, (_, index) => ({ area, index, text: `${area} ${long}`, done: index % 2 === 0 })));

const base: User = {
  id: 'U1', teamId: 'T1', appId: 'A1', dmChannel: 'D1', email: 'e', refreshTokenEnc: 'x', folderId: 'f',
  templateId: 't', tz: 'America/Denver', morningTime: '08:00', eveningTime: '22:30', days: [1, 2, 3, 4, 5, 6, 7],
  paused: false, needsReconnect: false, state: { phase: 'idle' }, carry: null,
};

describe('Block Kit layouts', () => {
  const cases: [string, Block[]][] = [
    ['home: signed out', homeBlocks(null, { signupUrl: 'https://s', today: '2026-09-30' })],
    ['home: reconnect', homeBlocks({ ...base, needsReconnect: true }, { signupUrl: 'https://s', today: '2026-09-30' })],
    ['home: no doc', homeBlocks(base, { signupUrl: 'https://s', today: '2026-09-30' })],
    ['home: paused', homeBlocks({ ...base, paused: true }, { signupUrl: 'https://s', today: '2026-09-30' })],
    ['home: morning in progress', homeBlocks({ ...base, state: { phase: 'morning', day: '2026-09-30', q: 3 } },
      { signupUrl: 'https://s', today: '2026-09-30' })],
    ['home: doc with tasks', homeBlocks(base, { signupUrl: 'https://s', today: '2026-09-30', docId: 'd', tasks, scored: 2, total: 15 })],
    ['home: doc, all scored', homeBlocks(base, { signupUrl: 'https://s', today: '2026-09-30', docId: 'd', tasks: [], scored: 6, total: 49 })],
    ['home: doc unreadable', homeBlocks(base, { signupUrl: 'https://s', today: '2026-09-30', docId: 'd', tasks: null })],
    ['question without carry', questionBlocks('2026-09-30', 0, [], [], null)],
    ['question with many carry items', questionBlocks('2026-09-30', 3, groups, groups.map((_, i) => i % 3 !== 0), '2026-09-29')],
    ['question with nothing kept', questionBlocks('2026-09-30', 7, groups.slice(0, 3), [false, false, false], '2026-09-29')],
    ['score first', scoreBlocks('2026-09-30', 0)],
    ['score later', scoreBlocks('2026-09-30', 4)],
    ['morning scheduled', morningScheduledBlocks('2026-09-30')],
    ['evening scheduled', eveningScheduledBlocks('2026-09-30')],
    ['update message', updateMessageBlocks('2026-09-30', tasks)],
    ['menu', menuBlocks()],
    ['settings modal', [settingsModal(base)]],
  ];
  it.each(cases)('%s follows Slack’s rules', (_, blocks) => {
    expect(problems(blocks)).toEqual([]);
  });
});
