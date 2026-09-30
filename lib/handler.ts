// Glue between HTTP routes and the per-user conversation logic.
import { DateTime } from 'luxon';
import { authLost, clearScheduled, daily, renderHome, type Ctx } from './bot.js';
import { homeBlocks } from './blocks.js';
import { decrypt, sign } from './crypto.js';
import { logError, withUser, type Store } from './db.js';
import { env } from './env.js';
import { GoogleAuthError, driveFor, revoke, type HppDrive } from './google.js';
import { ALL_DAYS, DEFAULT_EVENING, DEFAULT_MORNING } from './config.js';
import { slack } from './slack.js';
import type { User } from './types.js';

export interface Who {
  userId: string;
  teamId: string;
  appId: string | null;
}

export function signupUrl(who: Who): string {
  const s = sign({ u: who.userId, t: who.teamId, a: who.appId }, 24 * 3600);
  return `${env('APP_URL')}/api/google/start?s=${encodeURIComponent(s)}`;
}

const noDrive = new Proxy({} as HppDrive, {
  get() { throw new GoogleAuthError('Not connected to Google'); },
});

export function makeCtx(user: User, store: Store, who: Who): Ctx {
  let drive: HppDrive | null = null;
  return {
    user,
    store,
    slack,
    get drive() {
      if (!user.refreshTokenEnc) return noDrive;
      return (drive ??= driveFor(decrypt(user.refreshTokenEnc)));
    },
    now: DateTime.utc(),
    signupUrl: () => signupUrl(who),
  };
}

export async function publishSignedOut(who: Who) {
  await slack.publishHome(who.userId, homeBlocks(null, { signupUrl: signupUrl(who), today: DateTime.utc().toISODate()! }));
}

type Outcome = 'ok' | 'signed-out';

// Runs `fn` for a signed-up user with their row locked, then saves it. Errors are logged
// (without content) and the user gets a friendly message.
export async function runForUser(
  who: Who,
  step: string,
  fn: (ctx: Ctx) => Promise<void>,
  opts: { refreshHome?: 'always' | 'on-change' | 'never' } = {},
): Promise<Outcome> {
  try {
    return await withUser(who.userId, async (user, store) => {
      if (!user || !user.refreshTokenEnc) return 'signed-out';
      const ctx = makeCtx(user, store, who);
      const before = JSON.stringify([user.state.phase, user.state.docId, user.state.scoredDay, user.paused]);
      try {
        await fn(ctx);
      } catch (e) {
        if (e instanceof GoogleAuthError) await authLost(ctx);
        else {
          await store.recordError(user.id, step, e instanceof Error ? e.message : String(e));
          console.error(`[${step}] ${user.id}: ${e instanceof Error ? e.message : e}`);
          if (user.dmChannel) {
            await slack.post(user.dmChannel, '⚠️ Something went wrong on my end. Please try that again.').catch(() => undefined);
          }
        }
      }
      await store.saveUser(ctx.user);
      const after = JSON.stringify([ctx.user.state.phase, ctx.user.state.docId, ctx.user.state.scoredDay, ctx.user.paused]);
      const refresh = opts.refreshHome || 'on-change';
      if (refresh === 'always' || (refresh === 'on-change' && before !== after)) {
        await renderHome(ctx).catch((e) => console.error(`[home] ${user.id}: ${e instanceof Error ? e.message : e}`));
      }
      return 'ok';
    });
  } catch (e) {
    await logError(who.userId, step, e);
    return 'ok';
  }
}

export async function runDaily(userId: string) {
  await withUser(userId, async (user, store) => {
    if (!user) return;
    const ctx = makeCtx(user, store, { userId, teamId: user.teamId, appId: user.appId });
    try {
      await daily(ctx);
    } catch (e) {
      await store.recordError(user.id, 'daily', e instanceof Error ? e.message : String(e));
    }
    await store.saveUser(ctx.user);
  });
}

export async function leave(who: Who) {
  await withUser(who.userId, async (user, store) => {
    if (!user) return;
    const ctx = makeCtx(user, store, who);
    await clearScheduled(ctx).catch(() => undefined);
    if (user.refreshTokenEnc) await revoke(decrypt(user.refreshTokenEnc));
    await store.deleteUser(user.id);
    if (user.dmChannel) {
      await slack.post(user.dmChannel, '👋 You’ve left HPP Message Bot. Everything I stored about you is deleted, and ' +
        'your docs are still in your Google Drive. You can sign up again from my Home tab any time.').catch(() => undefined);
    }
  });
  await publishSignedOut(who);
}

export function defaultsFor(who: Who, tz: string | null): User {
  return {
    id: who.userId,
    teamId: who.teamId,
    appId: who.appId,
    dmChannel: null,
    email: null,
    refreshTokenEnc: null,
    folderId: null,
    templateId: null,
    tz: tz || 'America/Denver',
    morningTime: DEFAULT_MORNING,
    eveningTime: DEFAULT_EVENING,
    days: [...ALL_DAYS],
    paused: false,
    needsReconnect: false,
    state: { phase: 'idle' },
    carry: null,
  };
}
