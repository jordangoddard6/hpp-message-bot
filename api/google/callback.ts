// Google redirects here after consent. Saves the (encrypted) access, prepares the
// person's Drive folder and template, and schedules their messages.
import { DateTime } from 'luxon';
import { ensureScheduled, renderHome, welcomeText } from '../../lib/bot.js';
import { encrypt, verify } from '../../lib/crypto.js';
import { logError, withUser } from '../../lib/db.js';
import { GoogleAuthError, driveFor, exchangeCode } from '../../lib/google.js';
import { defaultsFor, makeCtx, type Who } from '../../lib/handler.js';
import { page } from '../../lib/page.js';
import { slack } from '../../lib/slack.js';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const state = verify<{ u: string; t: string; a: string | null }>(params.get('state') || '');
  if (!state) return page('Link expired', 'Go back to Slack, reopen the HPP Message Bot Home tab and try again.', 400);
  const who: Who = { userId: state.u, teamId: state.t, appId: state.a };
  const back = {
    href: who.appId ? `https://slack.com/app_redirect?app=${who.appId}&team=${who.teamId}` : 'https://slack.com',
    label: 'Back to Slack',
  };
  if (params.get('error') || !params.get('code')) {
    return page('Sign-in cancelled', 'No problem. You can press Get started on the Home tab whenever you’re ready.', 200, back);
  }

  try {
    const { refreshToken, email } = await exchangeCode(params.get('code')!);
    const drive = driveFor(refreshToken);
    const folderId = await drive.ensureFolder(null);
    const templateId = await drive.ensureTemplate(folderId, null);
    const tz = await slack.userTz(who.userId).catch(() => null);
    const dm = await slack.openDm(who.userId);

    await withUser(who.userId, async (existing, store) => {
      const reconnect = Boolean(existing);
      const user = existing || defaultsFor(who, tz);
      Object.assign(user, {
        teamId: who.teamId,
        appId: who.appId || user.appId,
        dmChannel: dm,
        email,
        refreshTokenEnc: encrypt(refreshToken),
        folderId,
        templateId,
        needsReconnect: false,
        tz: tz || user.tz,
      });
      await store.saveUser(user);
      const ctx = makeCtx(user, store, who);
      ctx.now = DateTime.utc();
      // The account is saved; problems after this point are logged, not fatal.
      await ensureScheduled(ctx).catch((e) => logError(who.userId, 'signup-schedule', e));
      await store.saveUser(ctx.user);
      await renderHome(ctx).catch((e) => logError(who.userId, 'signup-home', e));
      const rows = await store.listScheduled(user.id);
      await slack.post(dm, reconnect ? 'Reconnected' : 'You’re all set!', [{
        type: 'section',
        text: { type: 'mrkdwn', text: reconnect && existing?.refreshTokenEnc
          ? '✅ *Google Drive reconnected.* Your daily messages are back on.'
          : welcomeText(ctx, rows) },
      }]).catch((e) => logError(who.userId, 'signup-welcome', e));
    });
    return page('You’re all set!', 'Your planning folder is ready in Google Drive. Head back to Slack – your questions will arrive at your morning time.', 200, back);
  } catch (e) {
    await logError(who.userId, 'signup', e);
    const msg = e instanceof GoogleAuthError || /Drive access was not granted/.test(String(e))
      ? 'Google Drive access is needed to create your docs. Please try again and leave the Drive box checked.'
      : 'Something went wrong while setting up. Please try again from the Home tab.';
    return page('Setup didn’t finish', msg, 500, back);
  }
}
