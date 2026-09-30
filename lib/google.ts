// Google OAuth (drive.file only) plus the Drive/Docs calls the bot needs. Every file the
// bot touches is one it created, which is all drive.file allows.
import { DOC_NAME_RE, DOC_PREFIX, FOLDER_NAME, GRAY, TEMPLATE_NAME } from './config.js';
import { env } from './env.js';
import {
  fillRequests, readCarry, readTasks, scoreRequests, taskColorRequests, templateHtml, templateProblem,
  type DocJson, type Request,
} from './hppdoc.js';
import type { Group, Line, Score, Task } from './types.js';

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];
const DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// The user revoked access or the grant expired; they need to sign in again.
export class GoogleAuthError extends Error {}

const redirectUri = () => `${env('APP_URL')}/api/google/callback`;

export function authUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env('GOOGLE_CLIENT_ID'),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      ...params,
    }),
  });
  const body = await res.json() as Record<string, string | number>;
  if (!res.ok) {
    if (body.error === 'invalid_grant') throw new GoogleAuthError('Google access was revoked or expired');
    throw new Error(`Google token error: ${body.error} ${body.error_description || ''}`.trim());
  }
  return body;
}

export async function exchangeCode(code: string): Promise<{ refreshToken: string; email: string | null }> {
  const body = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  if (!body.refresh_token) throw new Error('Google did not return a refresh token');
  if (!String(body.scope || '').includes('drive.file')) {
    throw new Error('Google Drive access was not granted');
  }
  let email: string | null = null;
  if (body.id_token) {
    // Came straight from Google's token endpoint over TLS, so reading the payload is enough.
    const payload = JSON.parse(Buffer.from(String(body.id_token).split('.')[1], 'base64url').toString());
    email = payload.email || null;
  }
  return { refreshToken: String(body.refresh_token), email };
}

export async function revoke(refreshToken: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' })
    .catch(() => undefined);
}

// Access tokens are cached per warm instance; they last about an hour.
const tokenCache = new Map<string, { token: string; expires: number }>();

async function accessToken(refreshToken: string): Promise<string> {
  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const body = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  const token = String(body.access_token);
  tokenCache.set(refreshToken, { token, expires: Date.now() + Number(body.expires_in) * 1000 });
  return token;
}

export interface HppDrive {
  checkAccess(): Promise<void>;
  ensureFolder(folderId: string | null): Promise<string>;
  ensureTemplate(folderId: string, templateId: string | null): Promise<string>;
  findPreviousDoc(folderId: string, beforeDay: string): Promise<{ id: string; day: string } | null>;
  readCarry(docId: string): Promise<Record<string, Group[]>>;
  createDailyDoc(folderId: string, templateId: string, day: string, answers: Record<string, Line[]>): Promise<string>;
  trash(fileId: string): Promise<void>;
  readTasks(docId: string): Promise<Task[] | null>; // null if the doc is gone
  applyTaskChanges(docId: string, changes: (Task & { done: boolean })[]): Promise<number>;
  writeScores(docId: string, scores: (Score | null)[]): Promise<number>;
}

export const docUrl = (id: string) => `https://docs.google.com/document/d/${id}/edit`;
export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;

export function driveFor(refreshToken: string): HppDrive {
  async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await accessToken(refreshToken);
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    if (res.status === 401) {
      tokenCache.delete(refreshToken);
      throw new GoogleAuthError('Google rejected the access token');
    }
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Google API ${res.status}: ${text.slice(0, 300)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? (undefined as T) : (await res.json() as T);
  }
  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const isGone = (e: unknown) => [403, 404].includes((e as { status?: number }).status || 0);

  const getDoc = (id: string) => call<DocJson>(`https://docs.googleapis.com/v1/documents/${id}`);
  const batchUpdate = (id: string, requests: Request[]) => requests.length
    ? call(`https://docs.googleapis.com/v1/documents/${id}:batchUpdate`, json({ requests }))
    : Promise.resolve();

  async function list(q: string, orderBy = 'name desc'): Promise<{ id: string; name: string }[]> {
    const params = new URLSearchParams({ q, orderBy, fields: 'files(id,name)', pageSize: '100', spaces: 'drive' });
    const res = await call<{ files: { id: string; name: string }[] }>(`https://www.googleapis.com/drive/v3/files?${params}`);
    return res.files || [];
  }

  async function alive(id: string | null): Promise<boolean> {
    if (!id) return false;
    try {
      const f = await call<{ trashed: boolean }>(`https://www.googleapis.com/drive/v3/files/${id}?fields=trashed`);
      return !f.trashed;
    } catch (e) {
      if (isGone(e)) return false;
      throw e;
    }
  }

  async function uploadTemplate(folderId: string): Promise<string> {
    const boundary = 'hpp' + Math.random().toString(36).slice(2);
    const metadata = { name: TEMPLATE_NAME, mimeType: DOC_MIME, parents: [folderId] };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${templateHtml()}\r\n--${boundary}--`;
    const res = await call<{ id: string }>('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.id;
  }

  const drive: HppDrive = {
    async checkAccess() {
      await accessToken(refreshToken);
    },

    async ensureFolder(folderId) {
      if (await alive(folderId)) return folderId!;
      // After leaving and re-joining, the app can still see the folder it made before.
      const existing = await list(`name = '${FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`);
      if (existing.length) return existing[0].id;
      const created = await call<{ id: string }>('https://www.googleapis.com/drive/v3/files', json({
        name: FOLDER_NAME, mimeType: FOLDER_MIME,
      }));
      return created.id;
    },

    async ensureTemplate(folderId, templateId) {
      const candidates = templateId ? [templateId] : [];
      for (const f of await list(`name = '${TEMPLATE_NAME}' and '${folderId}' in parents and trashed = false`)) {
        if (!candidates.includes(f.id)) candidates.push(f.id);
      }
      for (const id of candidates) {
        try {
          if (await alive(id) && templateProblem(await getDoc(id)) === null) return id;
        } catch (e) {
          if (!isGone(e)) throw e;
        }
      }
      for (const id of candidates) await drive.trash(id).catch(() => undefined);
      const id = await uploadTemplate(folderId);
      const problem = templateProblem(await getDoc(id));
      if (problem) throw new Error(`Built template is missing the ${problem}`);
      return id;
    },

    async findPreviousDoc(folderId, beforeDay) {
      const files = await list(`name contains '${DOC_PREFIX.trim()}' and '${folderId}' in parents and trashed = false`);
      let best: { id: string; day: string } | null = null;
      for (const f of files) {
        const m = DOC_NAME_RE.exec(f.name);
        if (m && m[1] < beforeDay && (!best || m[1] > best.day)) best = { id: f.id, day: m[1] };
      }
      return best;
    },

    async readCarry(docId) {
      return readCarry(await getDoc(docId));
    },

    async createDailyDoc(folderId, templateId, day, answers) {
      const copy = await call<{ id: string }>(
        `https://www.googleapis.com/drive/v3/files/${templateId}/copy`,
        json({ name: DOC_PREFIX + day, parents: [folderId] }),
      );
      try {
        await batchUpdate(copy.id, fillRequests(await getDoc(copy.id), answers));
      } catch (e) {
        await drive.trash(copy.id).catch(() => undefined); // don't leave a half-filled doc behind
        throw e;
      }
      return copy.id;
    },

    async trash(fileId) {
      await call(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true }),
      });
    },

    async readTasks(docId) {
      try {
        return readTasks(await getDoc(docId));
      } catch (e) {
        if (isGone(e)) return null;
        throw e;
      }
    },

    async applyTaskChanges(docId, changes) {
      const { requests, applied } = taskColorRequests(await getDoc(docId), changes, GRAY);
      await batchUpdate(docId, requests);
      return applied;
    },

    async writeScores(docId, scores) {
      const { requests, total } = scoreRequests(await getDoc(docId), scores);
      await batchUpdate(docId, requests);
      return total;
    },
  };
  return drive;
}
