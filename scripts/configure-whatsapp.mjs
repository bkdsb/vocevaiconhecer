import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const target = process.argv[2];
const aliases = process.argv.slice(3);
if (![target, ...aliases].every((value) => /^\+[1-9]\d{7,14}$/.test(value || ''))) {
  throw new Error('Use configure-whatsapp.mjs <destino E.164> [aliases autorizados E.164].');
}
const path = resolve('.env');
let contents = await readFile(path, 'utf8');
const values = { OPENCLAW_WHATSAPP_TARGET: target, VVC_ALLOWED_SENDERS: [...new Set([target, ...aliases])].join(',') };
for (const [key, value] of Object.entries(values)) {
  const pattern = new RegExp(`^${key}=.*$`, 'gm');
  contents = pattern.test(contents) ? contents.replace(pattern, `${key}=${value}`) : `${contents.trimEnd()}\n${key}=${value}\n`;
}
const temporary = `${path}.${randomUUID()}.tmp`;
await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
await rename(temporary, path);
await chmod(path, 0o600);
console.log(JSON.stringify({ target, authorizedSenders: values.VVC_ALLOWED_SENDERS.split(',') }));
