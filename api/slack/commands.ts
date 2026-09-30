// The /hpp slash command.
import { waitUntil } from '@vercel/functions';
import { cmdPause, cmdResume, cmdScore, cmdStart, cmdUpdate, openSettings, type Ctx } from '../../lib/bot.js';
import { menuBlocks } from '../../lib/blocks.js';
import { logError, withUser } from '../../lib/db.js';
import { makeCtx, runForUser, type Who } from '../../lib/handler.js';
import { verifySlack } from '../../lib/slack.js';

const COMMANDS: Record<string, { run: (ctx: Ctx) => Promise<void>; reply: string }> = {
  start: { run: cmdStart, reply: 'Starting today’s questions in your messages with me.' },
  update: { run: cmdUpdate, reply: 'Sent your task list to your messages with me.' },
  score: { run: cmdScore, reply: 'Starting your daily review in your messages with me.' },
  pause: { run: cmdPause, reply: '⏸ Paused. No daily messages until you `/hpp-resume`.' },
  resume: { run: cmdResume, reply: '▶️ Resumed. Your daily messages are back on.' },
};

// `/hpp start` and `/hpp-start` do the same thing; the hyphenated forms exist so each
// option shows up in Slack's command autocomplete.
export function subcommand(command: string, text: string): string {
  const fromName = command.trim().toLowerCase().replace(/^\/hpp-?/, '');
  return fromName || text.trim().toLowerCase();
}

const ephemeral = (text: string, blocks?: unknown[]) =>
  Response.json({ response_type: 'ephemeral', text, ...(blocks ? { blocks } : {}) });

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  if (!verifySlack(request.headers, raw)) return new Response('bad signature', { status: 401 });
  const form = new URLSearchParams(raw);
  const who: Who = {
    userId: form.get('user_id')!,
    teamId: form.get('team_id')!,
    appId: form.get('api_app_id'),
  };
  const sub = subcommand(form.get('command') || '/hpp', form.get('text') || '');

  if (!sub || sub === 'help') return ephemeral('HPP Message Bot', menuBlocks());

  if (sub === 'settings') {
    let signedUp = false;
    await withUser(who.userId, async (user, store) => {
      if (!user?.refreshTokenEnc) return;
      signedUp = true;
      await openSettings(makeCtx(user, store, who), form.get('trigger_id')!);
    }).catch((e) => logError(who.userId, 'settings-open', e));
    return signedUp ? new Response('', { status: 200 }) : notSignedUp();
  }

  const cmd = COMMANDS[sub];
  if (!cmd) return ephemeral(`I don’t know \`/hpp ${sub}\`. Try \`/hpp\` for the menu.`);

  waitUntil((async () => {
    const outcome = await runForUser(who, `command:${sub}`, cmd.run, { refreshHome: 'always' });
    if (outcome === 'signed-out') {
      await fetch(form.get('response_url')!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_type: 'ephemeral', text: NOT_SIGNED_UP }),
      });
    }
  })().catch((e) => logError(who.userId, `command:${sub}`, e)));
  return ephemeral(cmd.reply);
}

const NOT_SIGNED_UP = 'You’re not set up yet. Open *HPP Message Bot* in the Apps section of the sidebar and press *Get started* on its Home tab.';
const notSignedUp = () => ephemeral(NOT_SIGNED_UP);
