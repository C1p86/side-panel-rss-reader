import { t } from './i18n.js';
import { ConflictError } from './sync.js';

const SYNC_FILE = 'rss-reader-sync.json';
const DROPBOX_AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize';
const DROPBOX_TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2/files';
const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 30000;

// Credentials are never sent as cookies, and responses are never cached: a stale revision would look like a conflict.
function request(url, options) {
  return fetch(url, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS), ...options });
}

/* ---------- Dropbox ---------- */

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Starts the PKCE flow. There is no redirect: Dropbox shows a code that the user pastes back. */
export async function startDropboxAuth(appKey) {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const query = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    code_challenge: base64Url(new Uint8Array(digest)),
    code_challenge_method: 'S256',
    token_access_type: 'offline',
  });
  return { verifier, url: `${DROPBOX_AUTHORIZE}?${query}` };
}

async function dropboxToken(params) {
  const res = await request(DROPBOX_TOKEN, { method: 'POST', body: new URLSearchParams(params) });
  if (!res.ok) throw new Error(t('dropboxRefused'));
  return res.json();
}

export async function finishDropboxAuth(appKey, code, verifier) {
  const { refresh_token: refreshToken } = await dropboxToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: appKey,
  });
  if (!refreshToken) throw new Error(t('dropboxNoToken'));
  return { provider: 'dropbox', appKey, refreshToken };
}

function dropboxProvider({ appKey, refreshToken }) {
  let accessToken = '';
  let expiresAt = 0;

  async function token() {
    if (!accessToken || Date.now() >= expiresAt) {
      const result = await dropboxToken({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appKey });
      accessToken = result.access_token;
      expiresAt = Date.now() + (result.expires_in - 60) * 1000;
    }
    return accessToken;
  }

  async function call(endpoint, arg, body) {
    const headers = { Authorization: `Bearer ${await token()}`, 'Dropbox-API-Arg': JSON.stringify(arg) };
    if (body !== undefined) headers['Content-Type'] = 'application/octet-stream';
    return request(`${DROPBOX_CONTENT}/${endpoint}`, { method: 'POST', headers, body });
  }

  return {
    async read() {
      const res = await call('download', { path: `/${SYNC_FILE}` });
      if (res.status === 409) {
        const error = await res.json().catch(() => ({}));
        if (String(error.error_summary).startsWith('path/not_found')) return { text: null, rev: null };
        throw new Error(error.error_summary ? `Dropbox: ${error.error_summary}` : t('readError', 'Dropbox'));
      }
      if (!res.ok) throw new Error(t('readErrorHttp', 'Dropbox', res.status));
      const { rev } = JSON.parse(res.headers.get('dropbox-api-result'));
      return { text: await res.text(), rev };
    },
    async write(text, rev) {
      const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'add' };
      const res = await call('upload', { path: `/${SYNC_FILE}`, mode, autorename: false, mute: true }, new TextEncoder().encode(text));
      if (res.status === 409) throw new ConflictError();
      if (!res.ok) throw new Error(t('writeErrorHttp', 'Dropbox', res.status));
    },
  };
}

/* ---------- GitHub ---------- */

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function githubHeaders(token, accept = 'application/vnd.github+json') {
  return { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
}

/** Notes and reading habits must not end up in public: only a private repository is accepted. */
async function verifyGithubRepo({ repo, token }) {
  const res = await request(`${GITHUB_API}/repos/${repo}`, { headers: githubHeaders(token) });
  if (res.status === 401) throw new Error(t('githubBadToken'));
  if (res.status === 403 || res.status === 404) throw new Error(t('githubNotFound'));
  if (!res.ok) throw new Error(t('githubError', res.status));
  const info = await res.json();
  if (!info.private) throw new Error(t('githubPublic'));
}

export async function connectGithub(repo, token) {
  const clean = repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean)) throw new Error(t('githubRepoFormat'));
  const config = { provider: 'github', repo: clean, token: token.trim() };
  await verifyGithubRepo(config);
  return config;
}

function githubProvider(config) {
  const { repo, token } = config;
  const url = `${GITHUB_API}/repos/${repo}/contents/${SYNC_FILE}`;
  let verified = false; // Checked again in each session, in case the repository was made public meanwhile.

  return {
    async read() {
      if (!verified) {
        await verifyGithubRepo(config);
        verified = true;
      }
      const res = await request(url, { headers: githubHeaders(token) });
      if (res.status === 404) return { text: null, rev: null };
      if (!res.ok) throw new Error(t('readErrorHttp', 'GitHub', res.status));
      const file = await res.json();
      if (file.encoding === 'base64' && file.content) return { text: fromBase64(file.content), rev: file.sha };
      // Above 1 MB the API leaves out the content and it must be requested in raw form.
      const raw = await request(url, { headers: githubHeaders(token, 'application/vnd.github.raw+json') });
      if (!raw.ok) throw new Error(t('readErrorHttp', 'GitHub', raw.status));
      return { text: await raw.text(), rev: file.sha };
    },
    async write(text, rev) {
      const body = { message: 'RSS Reader sync', content: toBase64(text) };
      if (rev) body.sha = rev;
      const res = await request(url, { method: 'PUT', headers: githubHeaders(token), body: JSON.stringify(body) });
      if (res.status === 409 || res.status === 422) throw new ConflictError();
      if (!res.ok) throw new Error(t('writeErrorHttp', 'GitHub', res.status));
    },
  };
}

export function createProvider(config) {
  return config.provider === 'dropbox' ? dropboxProvider(config) : githubProvider(config);
}
