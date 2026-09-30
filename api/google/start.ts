// "Get started" link from the Home tab → Google's consent screen.
import { verify } from '../../lib/crypto.js';
import { authUrl } from '../../lib/google.js';
import { page } from '../../lib/page.js';

export function GET(request: Request): Response {
  const s = new URL(request.url).searchParams.get('s') || '';
  if (!verify(s)) {
    return page('Link expired', 'This sign-up link has expired. Go back to Slack, reopen the HPP Message Bot Home tab and press the button again.', 400);
  }
  return Response.redirect(authUrl(s), 302);
}
