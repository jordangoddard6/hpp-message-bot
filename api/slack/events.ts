// Slack Events API: Home tab opens and direct messages to the bot.
import { waitUntil } from '@vercel/functions';
import { clearScheduled, ensureScheduled, onMessage, renderHome } from '../../lib/bot.js';
import { firstSeen, logError } from '../../lib/db.js';
import { publishSignedOut, runForUser, type Who } from '../../lib/handler.js';
import { slack, slackToPlain, verifySlack } from '../../lib/slack.js';

interface SlackEvent {
  type: string;
  user?: string;
  tab?: string;
  channel?: string;
  channel_type?: string;
  subtype?: string;
  bot_id?: string;
  text?: string;
}

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response('bad request', { status: 400 });
  }
  // Slack checks the URL while the app is being created, possibly before the signing
  // secret is configured. Echoing the challenge has no side effects.
  if (body.type === 'url_verification') return Response.json({ challenge: body.challenge });
  if (!verifySlack(request.headers, raw)) return new Response('bad signature', { status: 401 });
  if (body.type === 'event_callback') waitUntil(handle(body).catch((e) => logError(null, 'event', e)));
  return new Response('', { status: 200 });
}

async function handle(body: { event_id: string; team_id: string; api_app_id: string; event: SlackEvent }) {
  if (!(await firstSeen(body.event_id))) return;
  const ev = body.event;
  if (!ev.user) return;
  const who: Who = { userId: ev.user, teamId: body.team_id, appId: body.api_app_id };

  if (ev.type === 'app_home_opened' && ev.tab === 'home') {
    const outcome = await runForUser(who, 'home', async (ctx) => {
      // Follow the person's Slack time zone if it changed (e.g. travel).
      const tz = await slack.userTz(ctx.user.id).catch(() => null);
      if (tz && tz !== ctx.user.tz) {
        ctx.user.tz = tz;
        await clearScheduled(ctx);
        await ensureScheduled(ctx);
      }
      await renderHome(ctx);
    }, { refreshHome: 'never' });
    if (outcome === 'signed-out') await publishSignedOut(who);
    return;
  }

  if (ev.type === 'message' && ev.channel_type === 'im' && !ev.subtype && !ev.bot_id) {
    const outcome = await runForUser(who, 'message', (ctx) => onMessage(ctx, slackToPlain(ev.text || '')));
    if (outcome === 'signed-out' && ev.channel) {
      await slack.post(ev.channel, 'Hi! Open my *Home* tab and press *Get started* to set up your daily planning.');
    }
  }
}
