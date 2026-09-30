export interface Line {
  text: string;
  level: number; // bullet nesting level, 0 = top
}

// A carried-over item: a top-level line plus any sub-bullets under it.
export interface Group {
  lines: Line[];
}

export interface Carry {
  date: string | null; // date of the doc the items came from
  groups: Record<string, Group[]>;
}

export interface Task {
  area: string;
  index: number; // paragraph index inside the task-table cell
  text: string;
  done: boolean;
}

export interface Score {
  score: number;
  note: string;
}

export interface State {
  phase: 'idle' | 'morning' | 'scoring';
  day?: string; // cycle day (local date the morning questions belong to)
  q?: number;
  answers?: Record<string, Line[]>;
  keep?: Record<string, boolean[]>;
  msgTs?: string; // the message holding the current question's buttons
  msgText?: string; // its title, kept when the buttons are removed
  replaceDocId?: string | null;
  docId?: string;
  docDay?: string;
  scores?: (Score | null)[];
  scoreIdx?: number;
  scoredDay?: string;
  checklist?: { docId: string; items: Task[] }; // last task list shown (Home tab or /hpp update)
  checklistTs?: string; // /hpp update message
}

export interface User {
  id: string; // Slack user id
  teamId: string;
  appId: string | null;
  dmChannel: string | null;
  email: string | null;
  refreshTokenEnc: string | null;
  folderId: string | null;
  templateId: string | null;
  tz: string;
  morningTime: string; // HH:mm
  eveningTime: string; // HH:mm
  days: number[];
  paused: boolean;
  needsReconnect: boolean;
  state: State;
  carry: Carry | null;
}

export interface ScheduledRow {
  kind: 'morning' | 'evening';
  day: string;
  postAt: number; // epoch seconds
  scheduledId: string;
  channel: string;
}
