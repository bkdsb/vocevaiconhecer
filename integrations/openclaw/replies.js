// Deterministic wording for known runtime failures: no extra model call and
// no automatic repeat of an operation whose result may be ambiguous.
export function translateRuntimeReply(event, context = {}) {
  const channel = String(context.channelId || context.channel || '').toLowerCase();
  if (channel !== 'whatsapp' || typeof event.content !== 'string') return;
  const content = event.content.trim();
  if (/^I couldn[’']t confirm whether my previous reply reached this chat,/u.test(content)) return { content: 'Não consegui confirmar a entrega da resposta anterior. Não vou reenviar nem repetir operações automaticamente. Diga qual informação ficou faltando; posso consultar o estado da tarefa.' };
  if (/^(?:⚠️\s*)?(?:Agent (?:couldn[’']t generate a response|failed before reply)|Context overflow:|All models failed|No available auth profile|LLM request (?:timed out|rejected))/iu.test(content)) return { content: 'Não consegui concluir a resposta do chat: as rotas gratuitas falharam ou atingiram um limite. As tarefas registradas têm acompanhamento independente; peça STATUS para consultar o resultado. Não vou repetir aprovações ou publicações automaticamente.' };
}
