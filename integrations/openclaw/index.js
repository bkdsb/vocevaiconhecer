import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const COMMAND = /^(?:\/vvc\s+)?(?:status|aprovar\s+\S+(?:\s+\S+)?|rejeitar\s+\S+(?:\s+\S+)?|pausar|retomar)(?:\s+[^\n]*)?$/i;

function bridgeToken() {
  if (process.env.VVC_BRIDGE_TOKEN) return process.env.VVC_BRIDGE_TOKEN;
  try { return readFileSync(process.env.VVC_BRIDGE_TOKEN_FILE || '/home/ubuntu/vocevaiconhecer/.bridge-token', 'utf8').trim(); } catch { return ''; }
}

function replyText(payload) {
  if (typeof payload?.text === 'string' && payload.text) return payload.text;
  if (typeof payload?.error === 'string') return `Comando rejeitado: ${payload.error}`;
  return 'Comando processado.';
}

export default definePluginEntry({
  id: 'vvc-auto-post',
  name: 'Você Vai Conhecer — Auto Post',
  description: 'Encaminha comandos de aprovação do WhatsApp para o orquestrador de posts.',
  register(api) {
    api.on('inbound_claim', async (event, context) => {
      if (String(event.channel || '').toLowerCase() !== 'whatsapp') return;
      const text = String(event.content || event.bodyForAgent || event.body || '').trim();
      if (!COMMAND.test(text)) return;
      const token = bridgeToken();
      if (!token) return { handled: true, reply: { text: 'Ponte VVC indisponível: token não configurado.' } };
      const sender = String(event.senderId || context.senderId || '').trim();
      const messageId = String(event.messageId || context.messageId || randomUUID());
      try {
        const response = await fetch(process.env.VVC_BRIDGE_URL || 'http://127.0.0.1:8790/internal/command', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ sender, channel: event.channel, text, messageId }),
          signal: AbortSignal.timeout(10_000),
        });
        const payload = await response.json().catch(() => ({}));
        return { handled: true, reply: { text: replyText(payload) } };
      } catch {
        return { handled: true, reply: { text: 'Não consegui falar com o orquestrador VVC. Tente novamente em alguns segundos.' } };
      }
    });
  },
});
