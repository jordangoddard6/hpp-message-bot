import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

// ENCRYPTION_KEY is 32 random bytes, base64. Separate keys are derived for encryption
// and for signing so one secret covers both.
function key(purpose: string): Buffer {
  return createHmac('sha256', Buffer.from(env('ENCRYPTION_KEY'), 'base64')).update(purpose).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key('encrypt'), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(sealed: string): string {
  const [iv, tag, data] = sealed.split('.').map((s) => Buffer.from(s, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key('encrypt'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// Short-lived signed tokens for the Google sign-in link.
export function sign(payload: object, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }))
    .toString('base64url');
  const mac = createHmac('sha256', key('sign')).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify<T>(token: string): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', key('sign')).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  return payload.exp > Date.now() / 1000 ? (payload as T) : null;
}
