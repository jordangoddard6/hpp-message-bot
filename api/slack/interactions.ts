// Slack interactivity: button and checkbox taps, and the settings form.
import { waitUntil } from '@vercel/functions';
import { onAction, openSettings, saveSettings, validateSettings, type Action } from '../../lib/bot.js';
import { logError, withUser } from '../../lib/db.js';
import { leave, makeCtx, runForUser, type Who } from '../../lib/handler.js';
import { verifySlack, type Block } from '../../lib/slack.js';

interface Payload {
  type: string;
  user: { id: string; team_id?: string };
  team?: { id: string };
  api_app_id?: string;
  trigger_id?: string;
  response_url?: string;
  container?: { type: string; message_ts?: string; channel_id?: string };
  channel?: { id: string };
  message?: { ts: string; blocks?: Block[] };
  state?: { values: Action['stateValues'] };
  view?: {
    type: string;
    callback_id?: string;
    state?: { values: Record<string, Record<string, SelectedValue>> };
  };
  actions?: {
    action_id: string;
    value?: string;
    selected_options?: { value: string }[];
  }[];
}

interface SelectedValue {
  selected_time?: string;
  selected_options?: { value: string }[];
}

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  if (!verifySlack(request.headers, raw)) return new Response('bad signature', { status: 401 });
  const payload = JSON.parse(new URLSearchParams(raw).get('payload') || '{}') as Payload;
  const who: Who = {
    userId: payload.user.id,
    teamId: payload.team?.id || payload.user.team_id || '',
    appId: payload.api_app_id || null,
  };

  if (payload.type === 'block_actions' && payload.actions?.length) {
    const act = payload.actions[0];
    // Opening a modal must happen within 3 seconds of the tap, so do it before responding.
    if (act.action_id === 'h_settings' && payload.trigger_id) {
      await withUser(who.userId, async (user, store) => {
        if (user?.refreshTokenEnc) await openSettings(makeCtx(user, store, who), payload.trigger_id!);
      }).catch((e) => logError(who.userId, 'settings-open', e));
      return new Response('', { status: 200 });
    }
    if (act.action_id === 'h_leave') {
      waitUntil(leave(who).catch((e) => logError(who.userId, 'leave', e)));
      return new Response('', { status: 200 });
    }
    const fromHome = payload.container?.type === 'view' || payload.view?.type === 'home';
    const action: Action = {
      actionId: act.action_id,
      value: act.value || '',
      selected: act.selected_options?.map((o) => o.value),
      stateValues: (fromHome ? payload.view?.state?.values : payload.state?.values) as Action['stateValues'],
      messageTs: payload.message?.ts || payload.container?.message_ts,
      messageBlocks: payload.message?.blocks,
      channel: payload.channel?.id || payload.container?.channel_id,
      triggerId: payload.trigger_id,
      responseUrl: payload.response_url,
      fromHome,
    };
    // Link buttons and checkbox toggles on the Home tab / checklist need no work.
    if (['h_signup', 'h_doc', 'h_folder'].includes(act.action_id) || act.action_id.startsWith('u_chk_')) {
      return new Response('', { status: 200 });
    }
    waitUntil(runForUser(who, `action:${act.action_id}`, (ctx) => onAction(ctx, action),
      { refreshHome: fromHome ? 'always' : 'on-change' }));
    return new Response('', { status: 200 });
  }

  if (payload.type === 'view_submission' && payload.view?.callback_id === 'settings') {
    const v = payload.view.state!.values;
    const morning = v.morning.v.selected_time!;
    const evening = v.evening.v.selected_time!;
    const days = (v.days.v.selected_options || []).map((o) => Number(o.value));
    const errors = validateSettings(morning, evening, days);
    if (errors) return Response.json({ response_action: 'errors', errors });
    waitUntil(runForUser(who, 'settings-save', (ctx) => saveSettings(ctx, morning, evening, days), { refreshHome: 'always' }));
    return new Response('', { status: 200 });
  }

  return new Response('', { status: 200 });
}
