// Once a day (Vercel cron): keep each person's morning messages scheduled a week ahead,
// clear stale answers, notice lost Google access, and prune old bookkeeping.
import { allUserIds, logError, purgeOld } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { runDaily } from '../../lib/handler.js';

export async function GET(request: Request): Promise<Response> {
  if (request.headers.get('authorization') !== `Bearer ${env('CRON_SECRET')}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const ids = await allUserIds();
  let failed = 0;
  for (const id of ids) {
    await runDaily(id).catch(async (e) => {
      failed++;
      await logError(id, 'daily', e);
    });
  }
  await purgeOld();
  return Response.json({ users: ids.length, failed });
}
