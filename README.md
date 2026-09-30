# HPP Message Bot

A Slack app for daily **High Performance Planning**. Each morning it asks the planning
questions one at a time in a direct message, then creates `High Performance Planning YYYY-MM-DD`
in the person's own Google Drive. During the day people check off tasks (they turn gray in the
doc); at night the bot collects the six daily review scores.

- Only people who press **Get started** on the app's Home tab get messages.
- Each person picks their times and days, and can pause or leave (which deletes their data).
- Docs live in the person's Drive, in a `High Performance Planning` folder with a `TEMPLATE` doc.
  The app uses Google's `drive.file` permission, so it can only open files it created.
- Morning answers are kept only until the doc is created. Nothing people write is logged.

## How it works

| Piece | Where |
|---|---|
| Slack events, buttons, `/hpp` | `api/slack/*` (Vercel Functions, answered within Slack's 3 s, work continues in `waitUntil`) |
| Google sign-in | `api/google/start.ts`, `api/google/callback.ts` |
| Daily maintenance | `api/cron/daily.ts` (Vercel Cron, once a day) |
| Conversation logic | `lib/bot.ts` |
| Doc reading/writing | `lib/hppdoc.ts` (pure, tested with `test/docsim.ts`), `lib/google.ts` |
| State | Neon Postgres (`lib/db.ts`, tables created automatically) |

The 8:00am and 10:30pm messages are **Slack scheduled messages**, booked a week ahead by
the daily job, so no frequent cron is needed. Replying to one (or tapping its buttons)
starts that session.

## Commands

`/hpp` shows a menu. Also `/hpp start`, `update`, `score`, `pause`, `resume`, `settings`.
While answering: `BACK`, `SKIP` (or the buttons). After a failed doc creation: `RETRY`.

## Setup

1. Deploy to Vercel and add the Neon Postgres integration (sets `DATABASE_URL`).
2. Google Cloud: create an OAuth client (Web application) with redirect URI
   `https://<your domain>/api/google/callback`. Consent screen: External, scopes `openid`,
   `email`, `.../auth/drive.file`, **publishing status: In production** (Testing expires tokens
   after 7 days). Enable the Google Drive API and Google Docs API.
3. Slack: create an app **from a manifest** using `slack-manifest.json` (replace `APP_DOMAIN`),
   then install it to the workspace.
4. Set the environment variables listed in `.env.example` in Vercel and redeploy.

## Development

```
npm install
npm test
npm run typecheck
```
