import { randomUUID } from 'node:crypto';
import { normalizeVvcCommand } from './commands.js';

export function createInboundHandler({ getToken, fetchImpl = fetch, bridgeUrl = () => process.env.VVC_BRIDGE_URL || 'http://127.0.0.1:8790/internal/command' }) {
  return async (event, context = {}) => {
    const channel = String(event.channel || context.channel || context.channelId || '').toLowerCase();
    // Different OpenClaw WhatsApp adapters expose slightly different channel ids.
    // Keep the allowlist narrow so a command cannot be claimed from an unrelated channel.
    if (!/^(?:whatsapp|whatsapp-web|whatsapp-web\.js|baileys|wa)$/u.test(channel) || event.isGroup) return;
    // content is the SDK's BodyForCommands/RawBody. Never parse replyToBody:
    // a quoted preview contains commands that the user has not issued.
    const text = normalizeVvcCommand(event.content ?? event.bodyForAgent ?? event.body ?? context.content);
    if (!text) return;
    const token = getToken();
    if (!token) return { handled: true, reply: { text: 'Ponte VVC indisponível: token não configurado.' } };
    const sender = String(event.senderId || context.senderId || '').trim();
    const messageId = String(event.messageId || context.messageId || randomUUID());
    try {
      const response = await fetchImpl(bridgeUrl(), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sender, channel: 'whatsapp', text, messageId }),
        signal: AbortSignal.timeout(10_000),
      });
      const payload = await response.json();
      const reply = payload?.text || (payload?.error ? `Comando rejeitado: ${payload.error}` : 'Não consegui confirmar o resultado. Consulte STATUS antes de repetir.');
      return { handled: true, reply: { text: reply } };
    } catch {
      return { handled: true, reply: { text: 'Não consegui confirmar o comando com o VVC. Você pode repetir o mesmo código; uma aprovação já registrada mantém seu agendamento.' } };
    }
  };
}
