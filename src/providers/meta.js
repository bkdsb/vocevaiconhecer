import { createHmac } from 'node:crypto';
import { open } from 'node:fs/promises';

const GRAPH_ORIGIN = 'https://graph.facebook.com';
const REQUIRED_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

class MetaProviderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MetaProviderError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new MetaProviderError(code, message, details);
}

function identifier(value, label = 'ID') {
  if (typeof value !== 'string' || !/^[1-9]\d{0,39}$/.test(value)) {
    fail('META_INVALID_INPUT', `${label} da Meta inválido.`);
  }
  return value;
}

function secret(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\r\n]/.test(value)) {
    fail('META_CONFIG', `${label} da Meta não configurado corretamente.`);
  }
  return value;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidResponse() {
  fail('META_INVALID_RESPONSE', 'A Meta devolveu uma resposta inesperada.');
}

async function readImage(imagePath) {
  if (typeof imagePath !== 'string' || !imagePath || imagePath.includes('\0')) {
    fail('META_INVALID_INPUT', 'O caminho da imagem é inválido.');
  }
  let file;
  let bytes;
  try {
    file = await open(imagePath, 'r');
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_IMAGE_BYTES) {
      fail('META_INVALID_INPUT', 'A imagem deve ser um arquivo de até 10 MiB.');
    }
    // Bound the read as well as stat: a file can grow between these operations.
    const buffer = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length !== metadata.size) {
      fail('META_INVALID_INPUT', 'A imagem mudou durante a leitura; tente novamente.');
    }
    bytes = buffer.subarray(0, length);
  } catch (error) {
    if (error instanceof MetaProviderError) throw error;
    fail('META_INVALID_INPUT', 'Não foi possível ler a imagem local.');
  } finally {
    await file?.close().catch(() => {});
  }
  return imageFromBytes(bytes);
}

function imageFromBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    fail('META_INVALID_INPUT', 'A imagem deve conter entre 1 byte e 10 MiB.');
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { bytes, type: 'image/png', name: 'post.png' };
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return { bytes, type: 'image/jpeg', name: 'post.jpg' };
  }
  fail('META_INVALID_INPUT', 'Use uma imagem PNG ou JPEG.');
}

/** Meta Pages adapter. This module never retries writes or logs remote bodies. */
export function createMetaProvider(config, { fetchImpl = globalThis.fetch } = {}) {
  const version = config.metaApiVersion ?? 'v26.0';
  if (!/^v[1-9]\d{0,2}\.0$/.test(version)) {
    fail('META_CONFIG', 'Versão da Graph API inválida.');
  }
  if (typeof fetchImpl !== 'function') fail('META_CONFIG', 'Cliente HTTP indisponível.');

  function appId() {
    if (!config.metaAppId) fail('META_CONFIG', 'App ID da Meta não configurado.');
    return identifier(config.metaAppId, 'App ID');
  }

  function appSecret() {
    return secret(config.metaAppSecret, 'App Secret');
  }

  function redirectUri() {
    let url;
    try {
      url = new URL(config.metaRedirectUri);
    } catch {
      fail('META_CONFIG', 'Callback OAuth da Meta inválido.');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
      fail('META_CONFIG', 'O callback OAuth exige HTTPS, exceto em localhost.');
    }
    return config.metaRedirectUri;
  }

  function proof(token) {
    return createHmac('sha256', appSecret()).update(token).digest('hex');
  }

  async function request(path, { token, query = {}, body, publication = false } = {}) {
    const url = new URL(`/${version}/${path}`, GRAPH_ORIGIN);
    const headers = { Accept: 'application/json' };
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    if (token) {
      secret(token, 'Access Token');
      headers.Authorization = `Bearer ${token}`;
      if (body) body.set('appsecret_proof', proof(token));
      else url.searchParams.set('appsecret_proof', proof(token));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await fetchImpl(url, {
        method: body ? 'POST' : 'GET', headers, body,
        signal: controller.signal, redirect: 'error',
      });
      if (response.status >= 500) {
        fail(publication ? 'PUBLICATION_UNKNOWN' : 'META_UNAVAILABLE', publication
          ? 'A Meta pode ter recebido a publicação. Confira a Página antes de tentar novamente.'
          : 'A Meta está temporariamente indisponível.', { httpStatus: response.status });
      }
      let data;
      try {
        const raw = await response.text();
        if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error('Oversized response');
        data = JSON.parse(raw);
      } catch {
        fail(publication ? 'PUBLICATION_UNKNOWN' : 'META_INVALID_RESPONSE',
          publication ? 'Resposta inconclusiva da publicação; confira a Página antes de repetir.' : 'Resposta inválida da Meta.');
      }
      if (response.status >= 400 && response.status < 500 && object(data?.error)) {
        // Remote error messages can echo request values; keep only numeric diagnostics.
        const details = { httpStatus: response.status };
        if (Number.isSafeInteger(data.error.code)) details.graphCode = data.error.code;
        if (Number.isSafeInteger(data.error.error_subcode)) details.graphSubcode = data.error.error_subcode;
        fail('META_REJECTED', 'A Meta rejeitou a solicitação. Verifique permissões, token e parâmetros.', details);
      }
      if (!response.ok || !object(data) || data.error) {
        fail(publication ? 'PUBLICATION_UNKNOWN' : 'META_INVALID_RESPONSE',
          publication ? 'Publicação sem confirmação; confira a Página antes de repetir.' : 'Resposta inesperada da Meta.');
      }
      return data;
    } catch (error) {
      if (error instanceof MetaProviderError) throw error;
      fail(publication ? 'PUBLICATION_UNKNOWN' : 'META_UNAVAILABLE', publication
        ? 'Conexão interrompida: a publicação pode ter ocorrido. Confira a Página antes de tentar novamente.'
        : 'Não foi possível conectar à Meta.');
    } finally {
      clearTimeout(timeout);
    }
  }

  function tokenResponse(data) {
    const expiresIn = data.expires_in ?? data.expires;
    if (typeof data.access_token !== 'string' || !data.access_token.trim() || /[\r\n]/.test(data.access_token)
      || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) invalidResponse();
    return { accessToken: data.access_token, expiresIn };
  }

  return {
    authorizationUrl(state) {
      if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{24,512}$/.test(state)) {
        fail('META_INVALID_INPUT', 'OAuth state deve ser um identificador aleatório de pelo menos 24 caracteres.');
      }
      const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
      url.searchParams.set('client_id', appId());
      url.searchParams.set('redirect_uri', redirectUri());
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('state', state);
      if (config.metaConfigId) {
        url.searchParams.set('config_id', identifier(config.metaConfigId, 'Configuration ID'));
        url.searchParams.set('override_default_response_type', 'true');
      } else {
        url.searchParams.set('scope', REQUIRED_SCOPES.join(','));
      }
      return url.toString();
    },

    async exchangeCode(code) {
      return tokenResponse(await request('oauth/access_token', { query: {
        client_id: appId(), client_secret: appSecret(), redirect_uri: redirectUri(),
        code: secret(code, 'Código OAuth'),
      } }));
    },

    async extendToken(token) {
      return tokenResponse(await request('oauth/access_token', { query: {
        client_id: appId(), client_secret: appSecret(), grant_type: 'fb_exchange_token',
        fb_exchange_token: secret(token, 'User Access Token'),
      } }));
    },

    async listPages(userToken) {
      secret(userToken, 'User Access Token');
      const pages = new Map();
      const cursors = new Set();
      let after;
      for (let page = 0; page < 100; page += 1) {
        const data = await request('me/accounts', { token: userToken, query: {
          fields: 'id,name,access_token,tasks', limit: 100, ...(after ? { after } : {}),
        } });
        if (!Array.isArray(data.data)) invalidResponse();
        for (const item of data.data) {
          if (!object(item) || typeof item.id !== 'string' || !/^[1-9]\d{0,39}$/.test(item.id)
            || typeof item.name !== 'string' || typeof item.access_token !== 'string' || !item.access_token
            || /[\r\n]/.test(item.access_token) || !Array.isArray(item.tasks)
            || !item.tasks.every(task => typeof task === 'string')) invalidResponse();
          pages.set(item.id, { id: item.id, name: item.name, accessToken: item.access_token, tasks: item.tasks });
        }
        if (!data.paging?.next) return [...pages.values()];
        // Never follow the remote URL with a bearer token. Only copy its cursor.
        let next;
        try { next = new URL(data.paging.next); } catch { invalidResponse(); }
        const nextPath = next.pathname.slice(`/${version}/`.length);
        if (next.origin !== GRAPH_ORIGIN || !next.pathname.startsWith(`/${version}/`)
          || !/^(?:me|[1-9]\d{0,39})\/accounts$/.test(nextPath) || next.username || next.password) invalidResponse();
        after = data.paging?.cursors?.after ?? next.searchParams.get('after');
        if (typeof after !== 'string' || !after || after.length > 4096 || cursors.has(after)) invalidResponse();
        cursors.add(after);
      }
      fail('META_INVALID_RESPONSE', 'Limite de paginação da Meta excedido.');
    },

    async inspectToken(token) {
      const data = (await request('debug_token', {
        token: `${appId()}|${appSecret()}`, query: { input_token: secret(token, 'Access Token') },
      })).data;
      const now = Math.floor(Date.now() / 1000);
      if (!object(data) || data.is_valid !== true || String(data.app_id) !== appId()
        || !['USER', 'PAGE'].includes(data.type)
        || !Array.isArray(data.scopes) || !REQUIRED_SCOPES.every(scope => data.scopes.includes(scope))
        || ['expires_at', 'data_access_expires_at'].some(key => data[key] !== undefined
          && (!Number.isSafeInteger(data[key]) || data[key] < 0 || (data[key] !== 0 && data[key] <= now)))) {
        fail('META_TOKEN_INVALID', 'Token inválido, expirado, pertencente a outro aplicativo ou sem as permissões necessárias.');
      }
      return data;
    },

    async verifyPage({ pageId, pageToken }) {
      const data = await request(identifier(pageId, 'Page ID'), {
        token: secret(pageToken, 'Page Access Token'), query: { fields: 'id,name' },
      });
      if (data.id !== pageId || typeof data.name !== 'string' || !data.name) invalidResponse();
      return { id: data.id, name: data.name };
    },

    async publishPhoto({ pageId, pageToken, imageBuffer, imagePath, caption, published = true }) {
      identifier(pageId, 'Page ID');
      secret(pageToken, 'Page Access Token');
      if (typeof caption !== 'string' || !caption.trim() || caption.length > 63_206 || typeof published !== 'boolean') {
        fail('META_INVALID_INPUT', 'Legenda ou modo de publicação inválido.');
      }
      // The workflow hashes these exact bytes before claiming publication. Never
      // reopen the path when a verified buffer was supplied: the file can change.
      const image = imageBuffer === undefined ? await readImage(imagePath) : imageFromBytes(imageBuffer);
      const body = new FormData();
      body.set('source', new Blob([image.bytes], { type: image.type }), image.name);
      body.set('caption', caption);
      body.set('published', String(published));
      const data = await request(`${pageId}/photos`, { token: pageToken, body, publication: true });
      if (typeof data.id !== 'string' || !/^[1-9]\d{0,39}$/.test(data.id)
        || (data.post_id !== undefined && (typeof data.post_id !== 'string' || !/^[1-9]\d{0,39}(?:_[1-9]\d{0,39})?$/.test(data.post_id)))) {
        fail('PUBLICATION_UNKNOWN', 'A Meta não confirmou o ID da publicação. Confira a Página antes de repetir.');
      }
      return { id: data.id, postId: data.post_id ?? null };
    },
  };
}
