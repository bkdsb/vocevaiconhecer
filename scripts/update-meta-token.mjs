#!/usr/bin/env node
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createMetaProvider } from '../src/providers/meta.js';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const supplied = raw.trim();
if (!supplied) throw Object.assign(new Error('Token ausente.'), { code: 'META_TOKEN_MISSING' });

const config = loadConfig();
const meta = createMetaProvider(config);
const inspected = await meta.inspectToken(supplied);
if (!Array.isArray(inspected.scopes) || !inspected.scopes.includes('read_insights')) {
  throw Object.assign(new Error('O token não possui read_insights.'), { code: 'META_INSIGHTS_SCOPE_MISSING' });
}

let pageId = config.metaPageId;
let pageToken = supplied;
let pageName = '';

if (inspected.type === 'USER') {
  const pages = await meta.listPages(supplied);
  const page = pages.find((item) => item.id === pageId);
  if (!page) throw Object.assign(new Error('A Página configurada não está disponível neste token.'), { code: 'META_PAGE_NOT_FOUND' });
  pageToken = page.accessToken;
  pageName = page.name;
}
const pageInfo = await meta.inspectToken(pageToken);
if (!Array.isArray(pageInfo.scopes) || !pageInfo.scopes.includes('read_insights')) {
  throw Object.assign(new Error('O token de Página não possui read_insights.'), { code: 'META_PAGE_INSIGHTS_SCOPE_MISSING' });
}

const verified = await meta.verifyPage({ pageId, pageToken });
pageName ||= verified.name;
const record = {
  appId: config.metaAppId,
  pageId,
  pageName,
  pageToken,
  validatedAt: new Date().toISOString(),
};
await mkdir(dirname(config.metaCredentialsFile), { recursive: true, mode: 0o700 });
const temp = config.metaCredentialsFile + '.tmp';
await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
await chmod(temp, 0o600);
await rename(temp, config.metaCredentialsFile);
console.log(JSON.stringify({ updated: true, type: inspected.type, pageId, pageName, hasInsights: true }));
