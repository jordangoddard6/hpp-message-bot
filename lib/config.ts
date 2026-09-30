export const APP_NAME = 'HPP Message Bot';
export const FOLDER_NAME = 'High Performance Planning';
export const DOC_PREFIX = 'High Performance Planning ';
export const DOC_NAME_RE = /^High Performance Planning (\d{4}-\d{2}-\d{2})$/;
export const TEMPLATE_NAME = 'High Performance Planning TEMPLATE';

export const DEFAULT_MORNING = '08:00';
export const DEFAULT_EVENING = '22:30';
export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7]; // ISO weekdays, Monday = 1
export const SCHEDULE_AHEAD_DAYS = 7;

export const GRAY = '#b7b7b7';

export interface Question {
  key: string;
  prompt: string;
  label?: string; // paragraph label preceding the bulleted list
  cell?: [number, number]; // [row, col] in the task table
  carry?: boolean; // offer the previous doc's unfinished items
}

export const QUESTIONS: Question[] = [
  { key: 'lookForward', prompt: 'What can I look forward to today?', label: 'What can I look forward to today?' },
  { key: 'thankful', prompt: 'Something I am thankful for today', label: 'Something I am thankful for today:' },
  { key: 'compass', prompt: 'Compass (guiding principles/ideas for the day)', label: 'Compass:', carry: true },
  { key: 'work', prompt: 'Things that have to get done today: Work', cell: [1, 0], carry: true },
  { key: 'relations', prompt: 'Things that have to get done today: Relations', cell: [1, 1], carry: true },
  { key: 'physical', prompt: 'Things that have to get done today: Physical', cell: [3, 0], carry: true },
  { key: 'emotional', prompt: 'Things that have to get done today: Emotional / Spiritual', cell: [3, 1], carry: true },
  { key: 'other', prompt: 'Other things on my mind', label: 'Other things on my mind:', carry: true },
];

export const AREAS = QUESTIONS.filter((q) => q.cell);
export const areaName = (key: string) => QUESTIONS.find((q) => q.key === key)!.prompt.split(': ')[1];

export const REVIEW_ROWS = [
  'I worked intentionally today',
  'I accomplished the things that had to happen today',
  'I took care of work',
  'I took care of important relationships',
  'I took care of my physical self',
  'I took care of my emotional / spiritual self',
];
