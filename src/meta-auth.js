import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createMetaProvider } from './providers/meta.js';

const TTL_MS = 10 * 60_000;
const REQUIRED_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
const MAX_FILE_BYTES = 1024 * 1024;
const MESSAGES = {
  META_AUTH_CONFIG: 'Configure App ID, App Secret redefinido e callback OAuth válido no ambiente privado.',
  META_AUTH_STORAGE: 'Não foi possível acessar o armazenamento privado da conexão Meta.',
  META_AUTH_STATE: 'A autorização não existe, já foi usada ou não corresponde a esta conexão. Execute start novamente.',
  META_AUTH_EXPIRED: 'A autorização expirou. Execute start novamente.',
  META_AUTH_CALLBACK: 'O retorno OAuth não corresponde ao callback configurado ou contém parâmetros inválidos.',
  META_AUTH_DENIED: 'A autorização foi cancelada ou recusada na Meta. Execute start para tentar novamente.',
  META_AUTH_REMOTE: 'Não foi possível concluir a conexão com a Meta. Confira as permissões e execute start novamente.',
  META_AUTH_PENDING: 'Não há seleção de Página válida. Conclua start e finish novamente.',
  META_AUTH_PAGE: 'A Página escolhida não pertence à lista autorizada.',
  META_AUTH_TASKS: 'A Página escolhida não concedeu uma tarefa de criação de conteúdo ou gerenciamento.',
  META_AUTH_TOKEN: 'O token não autoriza a publicação nesta Página ou não pertence ao aplicativo configurado.',
  META_AUTH_INPUT: 'Entrada inválida. Use start, finish, list, select <Page ID> ou status; o callback de finish entra somente por stdin.',
};

export class MetaAuthError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES.META_AUTH_REMOTE); this.name = 'MetaAuthError'; this.code = code in MESSAGES ? code : 'META_AUTH_REMOTE'; }
}
function fail(code) { throw new MetaAuthError(code); }
function safeError(error, fallback = 'META_AUTH_REMOTE') { return error instanceof MetaAuthError ? error : new MetaAuthError(fallback); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function identifier(value) { return typeof value === 'string' && /^[1-9]\d{0,39}$/.test(value); }
function token(value) { return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\r\n]/.test(value); }
function stateHash(value) { return createHash('sha256').update(value).digest('hex'); }
function same(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }
function publicPages(pages) { return pages.map(({ id, name, tasks }) => ({ id, name, tasks })); }
function validPeriod(record, now) { return typeof record?.expiresAt === 'string' && Number.isFinite(Date.parse(record.expiresAt)) && Date.parse(record.expiresAt) > now.getTime() && typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt)) && Date.parse(record.createdAt) <= now.getTime() && Date.parse(record.expiresAt) - Date.parse(record.createdAt) <= TTL_MS; }

async function privateDirectory(path, { create = false } = {}) {
  try {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('META_AUTH_STORAGE');
    if (create) await chmod(path, 0o700);
    else if ((info.mode & 0o077) !== 0) fail('META_AUTH_STORAGE');
  } catch (error) { throw safeError(error, 'META_AUTH_STORAGE'); }
}

async function readPrivate(path, { missing = null } = {}) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES || (info.mode & 0o077) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('META_AUTH_STORAGE');
    const bytes = Buffer.alloc(info.size + 1); let length = 0;
    while (length < bytes.length) { const { bytesRead } = await file.read(bytes, length, bytes.length - length, length); if (bytesRead === 0) break; length += bytesRead; }
    if (length !== info.size) fail('META_AUTH_STORAGE');
    const value = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!object(value)) fail('META_AUTH_STORAGE');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return missing; throw safeError(error, 'META_AUTH_STORAGE'); }
  finally { await file?.close().catch(() => {}); }
}

async function writePrivate(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`; let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await file.sync(); await file.close(); file = null;
    await rename(temporary, path);
  } catch (error) { throw safeError(error, 'META_AUTH_STORAGE'); }
  finally { await file?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}

export function createMetaAuth(config, { meta = createMetaProvider(config), now = () => new Date() } = {}) {
  const directory = resolve(config.dataDir, 'meta');
  const pendingPath = resolve(directory, 'pending.json'); const pagePath = resolve(directory, 'page.json');

  function configuration() {
    if (!identifier(config.metaAppId) || !token(config.metaAppSecret)) fail('META_AUTH_CONFIG');
    let url;
    try { url = new URL(config.metaRedirectUri); } catch { fail('META_AUTH_CONFIG'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.hash || url.searchParams.has('state') || url.searchParams.has('code') || url.searchParams.has('error') || !(url.protocol === 'https:' || local && url.protocol === 'http:') || url.hostname.endsWith('.invalid')) fail('META_AUTH_CONFIG');
    return url;
  }

  async function pending() {
    await privateDirectory(directory);
    const value = await readPrivate(pendingPath);
    if (!value || value.appId !== config.metaAppId || !validPeriod(value, now()) || !Array.isArray(value.pages)) fail('META_AUTH_PENDING');
    return value;
  }

  return {
    async start() {
      configuration();
      await privateDirectory(directory, { create: true });
      const createdAt = now(); const state = randomBytes(32).toString('base64url');
      let authorizationUrl;
      try { authorizationUrl = meta.authorizationUrl(state); } catch { fail('META_AUTH_CONFIG'); }
      const expiresAt = new Date(createdAt.getTime() + TTL_MS).toISOString();
      await writePrivate(resolve(directory, `state-${stateHash(state)}.json`), { appId: config.metaAppId, redirectUri: config.metaRedirectUri, stateHash: stateHash(state), createdAt: createdAt.toISOString(), expiresAt });
      return { authorizationUrl, expiresAt, callbackMode: 'manual-stdin' };
    },

    async finish(callbackUrl) {
      const expected = configuration();
      if (typeof callbackUrl !== 'string' || callbackUrl.length > 32_768 || /[\r\n]/.test(callbackUrl.trim())) fail('META_AUTH_CALLBACK');
      let callback;
      try { callback = new URL(callbackUrl.trim()); } catch { fail('META_AUTH_CALLBACK'); }
      if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password || callback.hash && callback.hash !== '#_=_') fail('META_AUTH_CALLBACK');
      for (const [key, value] of expected.searchParams) if (callback.searchParams.getAll(key).length !== expected.searchParams.getAll(key).length || !callback.searchParams.getAll(key).includes(value)) fail('META_AUTH_CALLBACK');
      const states = callback.searchParams.getAll('state'); const codes = callback.searchParams.getAll('code');
      if (states.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(states[0]) || codes.length > 1 || callback.searchParams.getAll('error').length > 1) fail('META_AUTH_CALLBACK');
      const hash = stateHash(states[0]); const path = resolve(directory, `state-${hash}.json`);
      await privateDirectory(directory);
      const saved = await readPrivate(path);
      if (!saved || !same(saved.stateHash, hash) || saved.appId !== config.metaAppId || saved.redirectUri !== config.metaRedirectUri) fail('META_AUTH_STATE');
      if (!validPeriod(saved, now())) fail('META_AUTH_EXPIRED');
      // Atomic rename is the one-use claim: concurrent callbacks cannot both exchange.
      const consumed = resolve(directory, `consumed-${hash}-${randomUUID()}.json`);
      try { await rename(path, consumed); } catch (error) { if (error.code === 'ENOENT') fail('META_AUTH_STATE'); throw safeError(error, 'META_AUTH_STORAGE'); }
      await unlink(consumed).catch(() => {});
      if (callback.searchParams.has('error')) fail('META_AUTH_DENIED');
      if (codes.length !== 1 || !token(codes[0])) fail('META_AUTH_CALLBACK');
      try {
        const short = await meta.exchangeCode(codes[0]);
        if (!token(short?.accessToken)) fail('META_AUTH_REMOTE');
        const extended = await meta.extendToken(short.accessToken);
        if (!token(extended?.accessToken)) fail('META_AUTH_REMOTE');
        const pages = await meta.listPages(extended.accessToken);
        if (!Array.isArray(pages) || pages.length > 1000 || pages.some((page) => !object(page) || !identifier(page.id) || typeof page.name !== 'string' || !page.name || !token(page.accessToken) || !Array.isArray(page.tasks) || page.tasks.some((task) => typeof task !== 'string'))) fail('META_AUTH_REMOTE');
        const createdAt = now(); const expiresAt = new Date(createdAt.getTime() + TTL_MS).toISOString();
        await writePrivate(pendingPath, { appId: config.metaAppId, createdAt: createdAt.toISOString(), expiresAt, pages: pages.map(({ id, name, accessToken, tasks }) => ({ id, name, accessToken, tasks })) });
        return { connected: false, selectionRequired: true, expiresAt, pages: publicPages(pages) };
      } catch (error) { throw safeError(error); }
    },

    async list() { return { pages: publicPages((await pending()).pages) }; },

    async select(pageId) {
      configuration();
      if (!identifier(pageId)) fail('META_AUTH_INPUT');
      const selection = await pending(); const page = selection.pages.find((item) => item.id === pageId);
      if (!page || !token(page.accessToken)) fail('META_AUTH_PAGE');
      if (!Array.isArray(page.tasks) || !page.tasks.some((task) => ['CREATE_CONTENT', 'MANAGE', 'PROFILE_PLUS_CREATE_CONTENT', 'PROFILE_PLUS_MANAGE'].includes(task))) fail('META_AUTH_TASKS');
      try {
        const inspected = await meta.inspectToken(page.accessToken);
        const timestamp = Math.floor(now().getTime() / 1000);
        if (!object(inspected) || inspected.is_valid !== true || String(inspected.app_id) !== config.metaAppId || inspected.type !== 'PAGE' || !Array.isArray(inspected.scopes) || !REQUIRED_SCOPES.every((scope) => inspected.scopes.includes(scope)) || ['expires_at', 'data_access_expires_at'].some((key) => inspected[key] !== undefined && (!Number.isSafeInteger(inspected[key]) || inspected[key] < 0 || inspected[key] !== 0 && inspected[key] <= timestamp))) fail('META_AUTH_TOKEN');
        if (inspected.profile_id !== undefined && String(inspected.profile_id) !== pageId) fail('META_AUTH_TOKEN');
        if (inspected.granular_scopes !== undefined) {
          if (!Array.isArray(inspected.granular_scopes)) fail('META_AUTH_TOKEN');
          for (const entry of inspected.granular_scopes) {
            if (!object(entry) || typeof entry.scope !== 'string') fail('META_AUTH_TOKEN');
            if (REQUIRED_SCOPES.includes(entry.scope) && entry.target_ids !== undefined && (!Array.isArray(entry.target_ids) || !entry.target_ids.some((id) => String(id) === pageId))) fail('META_AUTH_TOKEN');
          }
        }
        const verified = await meta.verifyPage({ pageId, pageToken: page.accessToken });
        if (!object(verified) || verified.id !== pageId || typeof verified.name !== 'string' || !verified.name) fail('META_AUTH_TOKEN');
        const record = { appId: config.metaAppId, pageId, pageToken: page.accessToken, pageName: verified.name, validatedAt: now().toISOString() };
        await writePrivate(pagePath, record);
        return { connected: true, pageId, pageName: record.pageName, validatedAt: record.validatedAt };
      } catch (error) { throw safeError(error); }
    },

    async status() {
      let appConfigured = false;
      try { configuration(); appConfigured = true; } catch { /* Status is diagnostic and never prompts or mutates. */ }
      const result = { appConfigured, storageAvailable: false, authorizationPending: false, selectionPending: false, pageConfigured: false, publishingEnabled: config.metaPublishEnabled === true };
      try {
        await privateDirectory(directory); result.storageAvailable = true;
        const page = await readPrivate(pagePath); result.pageConfigured = Boolean(page && page.appId === config.metaAppId && identifier(page.pageId) && token(page.pageToken) && typeof page.validatedAt === 'string' && Number.isFinite(Date.parse(page.validatedAt)));
        const selection = await readPrivate(pendingPath); result.selectionPending = Boolean(selection && selection.appId === config.metaAppId && validPeriod(selection, now()) && Array.isArray(selection.pages) && selection.pages.length);
        const files = (await readdir(directory)).filter((name) => /^state-[a-f0-9]{64}\.json$/.test(name));
        for (const name of files) { const state = await readPrivate(resolve(directory, name)); if (state?.appId === config.metaAppId && state.redirectUri === config.metaRedirectUri && validPeriod(state, now())) { result.authorizationPending = true; break; } }
      } catch { /* Report availability only; never echo storage contents or credentials. */ }
      return result;
    },
  };
}
