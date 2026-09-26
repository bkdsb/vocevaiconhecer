import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createMetaAuth, MetaAuthError } from '../src/meta-auth.js';

async function callbackFromStdin(stdin) {
  let value = '';
  for await (const chunk of stdin) {
    value += chunk.toString();
    if (Buffer.byteLength(value) > 32_768) throw new MetaAuthError('META_AUTH_INPUT');
  }
  return value.trim();
}

export async function runMetaAuthCli({ args = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout, config = loadConfig(), auth } = {}) {
  try {
    const [command, pageId] = args;
    if (!['start', 'finish', 'list', 'select', 'status'].includes(command) || (command === 'select' ? args.length !== 2 || !/^[1-9]\d{0,39}$/.test(pageId || '') : args.length !== 1)) throw new MetaAuthError('META_AUTH_INPUT');
    auth ||= createMetaAuth(config);
    const result = command === 'finish' ? await auth.finish(await callbackFromStdin(stdin)) : command === 'select' ? await auth.select(pageId) : await auth[command]();
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const safe = error instanceof MetaAuthError ? error : new MetaAuthError('META_AUTH_REMOTE');
    stdout.write(`${JSON.stringify({ error: safe.code, message: safe.message })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runMetaAuthCli();
