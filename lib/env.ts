// Required settings, all set in Vercel's project environment variables.
export type EnvName =
  | 'APP_URL'
  | 'DATABASE_URL'
  | 'SLACK_BOT_TOKEN'
  | 'SLACK_SIGNING_SECRET'
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'ENCRYPTION_KEY'
  | 'CRON_SECRET';

export function env(name: EnvName): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value.trim();
}
