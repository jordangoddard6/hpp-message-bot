import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebClient } from '@slack/web-api';
import { env } from './env.js';

export type Block = Record<string, unknown>;

export interface SlackApi {
  post(channel: string, text: string, blocks?: Block[]): Promise<string>; // returns ts
  update(channel: string, ts: string, text: string, blocks?: Block[]): Promise<void>;
  schedule(channel: string, postAt: number, text: string, blocks?: Block[]): Promise<string>; // scheduled id
  unschedule(channel: string, scheduledId: string): Promise<void>;
  publishHome(userId: string, blocks: Block[]): Promise<void>;
  openModal(triggerId: string, view: Block): Promise<void>;
  openDm(userId: string): Promise<string>;
  userTz(userId: string): Promise<string | null>;
  respond(responseUrl: string, body: Block): Promise<void>; // slash command / ephemeral follow-up
}

let client: WebClient | null = null;
const web = () => (client ??= new WebClient(env('SLACK_BOT_TOKEN')));

export const slack: SlackApi = {
  async post(channel, text, blocks) {
    const res = await web().chat.postMessage({ channel, text, blocks: blocks as never, unfurl_links: false });
    return res.ts as string;
  },
  async update(channel, ts, text, blocks) {
    await web().chat.update({ channel, ts, text, blocks: (blocks || []) as never });
  },
  async schedule(channel, postAt, text, blocks) {
    const res = await web().chat.scheduleMessage({ channel, post_at: postAt, text, blocks: blocks as never });
    return res.scheduled_message_id as string;
  },
  async unschedule(channel, scheduledId) {
    try {
      await web().chat.deleteScheduledMessage({ channel, scheduled_message_id: scheduledId });
    } catch (e) {
      // Already sent or already deleted.
      if (!/invalid_scheduled_message_id/.test(String((e as Error).message))) throw e;
    }
  },
  async publishHome(userId, blocks) {
    await web().views.publish({ user_id: userId, view: { type: 'home', blocks } as never });
  },
  async openModal(triggerId, view) {
    await web().views.open({ trigger_id: triggerId, view: view as never });
  },
  async openDm(userId) {
    const res = await web().conversations.open({ users: userId });
    return res.channel!.id as string;
  },
  async userTz(userId) {
    const res = await web().users.info({ user: userId });
    return (res.user?.tz as string) || null;
  },
  async respond(responseUrl, body) {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },
};

// https://api.slack.com/authentication/verifying-requests-from-slack
export function verifySlack(headers: Headers, rawBody: string): boolean {
  const ts = headers.get('x-slack-request-timestamp');
  const sig = headers.get('x-slack-signature');
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = 'v0=' + createHmac('sha256', env('SLACK_SIGNING_SECRET')).update(`v0:${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Slack escapes &, < and > and wraps links as <url|label>.
export function slackToPlain(text: string): string {
  return text
    .replace(/<([^>|]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+|mailto:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Escapes user text for mrkdwn.
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function plain(text: string, max = 75): { type: 'plain_text'; text: string; emoji: true } {
  const t = text.trim();
  return { type: 'plain_text', text: t.length > max ? t.slice(0, max - 1) + '…' : t || ' ', emoji: true };
}
