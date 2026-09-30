import { Pool, type PoolClient } from '@neondatabase/serverless';
import { env } from './env.js';
import type { ScheduledRow, User } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  team_id text NOT NULL,
  app_id text,
  dm_channel text,
  email text,
  refresh_token_enc text,
  folder_id text,
  template_id text,
  tz text NOT NULL,
  morning_time text NOT NULL,
  evening_time text NOT NULL,
  days int[] NOT NULL,
  paused boolean NOT NULL DEFAULT false,
  needs_reconnect boolean NOT NULL DEFAULT false,
  state jsonb NOT NULL DEFAULT '{"phase":"idle"}',
  carry jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS scheduled (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  day date NOT NULL,
  post_at bigint NOT NULL,
  scheduled_id text NOT NULL,
  channel text NOT NULL,
  PRIMARY KEY (user_id, kind, day)
);
CREATE TABLE IF NOT EXISTS seen_events (
  id text PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
);
-- Failures only: which user, which step, and the error. Never message content.
CREATE TABLE IF NOT EXISTS errors (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id text,
  step text NOT NULL,
  message text NOT NULL
);
`;

let schemaReady: Promise<void> | null = null;

function pool(): Pool {
  return new Pool({ connectionString: env('DATABASE_URL') });
}

// Runs `fn` with a client, creating the tables on the first use per instance.
export async function withDb<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const p = pool();
  const client = await p.connect();
  try {
    if (!schemaReady) schemaReady = client.query(SCHEMA).then(() => undefined);
    await schemaReady.catch((e) => { schemaReady = null; throw e; });
    return await fn(client);
  } finally {
    client.release();
    await p.end();
  }
}

export interface Store {
  saveUser(u: User): Promise<void>;
  deleteUser(id: string): Promise<void>;
  listScheduled(userId: string): Promise<ScheduledRow[]>;
  addScheduled(userId: string, row: ScheduledRow): Promise<void>;
  removeScheduled(userId: string, kind: string, day: string): Promise<void>;
  recordError(userId: string | null, step: string, message: string): Promise<void>;
}

type Row = Record<string, unknown>;

function toUser(r: Row): User {
  return {
    id: r.id as string,
    teamId: r.team_id as string,
    appId: r.app_id as string | null,
    dmChannel: r.dm_channel as string | null,
    email: r.email as string | null,
    refreshTokenEnc: r.refresh_token_enc as string | null,
    folderId: r.folder_id as string | null,
    templateId: r.template_id as string | null,
    tz: r.tz as string,
    morningTime: r.morning_time as string,
    eveningTime: r.evening_time as string,
    days: (r.days as number[]).map(Number),
    paused: r.paused as boolean,
    needsReconnect: r.needs_reconnect as boolean,
    state: (r.state as User['state']) || { phase: 'idle' },
    carry: (r.carry as User['carry']) || null,
  };
}

export function storeFor(c: PoolClient): Store {
  return {
    async saveUser(u) {
      await c.query(
        `INSERT INTO users (id, team_id, app_id, dm_channel, email, refresh_token_enc, folder_id, template_id,
           tz, morning_time, evening_time, days, paused, needs_reconnect, state, carry)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO UPDATE SET team_id=$2, app_id=$3, dm_channel=$4, email=$5, refresh_token_enc=$6,
           folder_id=$7, template_id=$8, tz=$9, morning_time=$10, evening_time=$11, days=$12, paused=$13,
           needs_reconnect=$14, state=$15, carry=$16, updated_at=now()`,
        [u.id, u.teamId, u.appId, u.dmChannel, u.email, u.refreshTokenEnc, u.folderId, u.templateId, u.tz,
          u.morningTime, u.eveningTime, u.days, u.paused, u.needsReconnect, JSON.stringify(u.state),
          u.carry ? JSON.stringify(u.carry) : null],
      );
    },
    async deleteUser(id) {
      await c.query('DELETE FROM users WHERE id = $1', [id]);
    },
    async listScheduled(userId) {
      const res = await c.query(
        'SELECT kind, day::text AS day, post_at, scheduled_id, channel FROM scheduled WHERE user_id = $1',
        [userId],
      );
      return res.rows.map((r: Row) => ({
        kind: r.kind as ScheduledRow['kind'],
        day: r.day as string,
        postAt: Number(r.post_at),
        scheduledId: r.scheduled_id as string,
        channel: r.channel as string,
      }));
    },
    async addScheduled(userId, row) {
      await c.query(
        `INSERT INTO scheduled (user_id, kind, day, post_at, scheduled_id, channel) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, kind, day) DO UPDATE SET post_at=$4, scheduled_id=$5, channel=$6`,
        [userId, row.kind, row.day, row.postAt, row.scheduledId, row.channel],
      );
    },
    async removeScheduled(userId, kind, day) {
      await c.query('DELETE FROM scheduled WHERE user_id = $1 AND kind = $2 AND day = $3', [userId, kind, day]);
    },
    async recordError(userId, step, message) {
      await c.query('INSERT INTO errors (user_id, step, message) VALUES ($1, $2, $3)',
        [userId, step, message.slice(0, 1000)]);
    },
  };
}

// Loads the user with a row lock so one person's events are handled one at a time.
export async function withUser<T>(
  id: string,
  fn: (user: User | null, store: Store) => Promise<T>,
): Promise<T> {
  return withDb(async (c) => {
    await c.query('BEGIN');
    try {
      const res = await c.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
      const result = await fn(res.rows[0] ? toUser(res.rows[0]) : null, storeFor(c));
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  });
}

// True the first time an event id is seen (Slack retries deliveries).
export async function firstSeen(eventId: string): Promise<boolean> {
  return withDb(async (c) => {
    const res = await c.query('INSERT INTO seen_events (id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
    return res.rowCount === 1;
  });
}

export async function allUserIds(): Promise<string[]> {
  return withDb(async (c) => (await c.query('SELECT id FROM users')).rows.map((r: Row) => r.id as string));
}

export async function logError(userId: string | null, step: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${step}] ${userId || '-'}: ${message}`);
  await withDb((c) => storeFor(c).recordError(userId, step, message)).catch(() => undefined);
}

export async function purgeOld(): Promise<void> {
  await withDb(async (c) => {
    await c.query(`DELETE FROM seen_events WHERE at < now() - interval '2 days'`);
    await c.query(`DELETE FROM errors WHERE at < now() - interval '30 days'`);
  });
}
