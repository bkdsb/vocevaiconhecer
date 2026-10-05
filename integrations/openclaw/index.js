import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { createInboundHandler } from './handler.js';
import { translateRuntimeReply } from './replies.js';

const LOCAL_TOKEN_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.bridge-token');

function bridgeToken() {
  if (process.env.VVC_BRIDGE_TOKEN) return process.env.VVC_BRIDGE_TOKEN;
  const paths = [process.env.VVC_BRIDGE_TOKEN_FILE, LOCAL_TOKEN_FILE, '/home/ubuntu/vocevaiconhecer/.bridge-token'].filter(Boolean);
  for (const path of paths) {
    try {
      const token = readFileSync(path, 'utf8').trim();
      if (token) return token;
    } catch { /* try next location */ }
  }
  return '';
}

export default definePluginEntry({
  id: 'vvc-auto-post',
  name: 'Você Vai Conhecer — Auto Post',
  description: 'Encaminha comandos de aprovação do WhatsApp para o orquestrador de posts.',
  register(api) {
    api.on('message_sending', translateRuntimeReply);
    const handle = createInboundHandler({ getToken: bridgeToken });
    api.on('inbound_claim', handle);
    // Current OpenClaw invokes inbound_claim only for plugin-owned bindings.
    // Ordinary WhatsApp DMs pass through before_dispatch instead.
    api.on('before_dispatch', async (event, context) => {
      const result = await handle(event, context);
      if (result?.handled) {
        return { handled: true, replyPayloads: [result.reply] };
      }
    });
  },
});
