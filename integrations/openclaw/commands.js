// Shared by the inbound hook and the worker: acknowledgments never need an LLM.
export function normalizeVvcCommand(value) {
  const text = String(value || '').trim();
  const themes = /^(?:\/vvc\s+)?(?:aprov[a-z]*|gostei)(?:\s+(?:tema|pauta)s?)?(?:\s+([a-f0-9]{8}|latest))?\s+(todos|todas|all|[1-8](?:[\s,;ey]+[1-8])*)$/iu.exec(text);
  if (themes) return `APROVAR TEMAS ${themes[1] && themes[1].toLowerCase() !== 'latest' ? themes[1].toLowerCase() : 'LATEST'} ${/^(todos|todas|all)$/iu.test(themes[2]) ? 'all' : themes[2].replace(/[^\d]+/g, ',')}`;
  const generate = /^(?:\/vvc\s+)?(?:g?era[rm]?|cria[rm]?|fazer|faz)\s+(?:tema|pauta)s?(?:\s+([a-f0-9]{8}|latest))?(?:\s|$)/iu.exec(text);
  if (generate) return `GERAR TEMAS ${generate[1] && generate[1].toLowerCase() !== 'latest' ? generate[1].toLowerCase() : 'LATEST'}`;
  const view = /^(?:\/vvc\s+)?(?:tema|pauta)s?(?:\s+([a-f0-9]{8}|latest))?$/iu.exec(text);
  if (view) return `TEMAS ${view[1] && view[1].toLowerCase() !== 'latest' ? view[1].toLowerCase() : 'LATEST'}`;
  const match = /^(?:\/vvc\s+)?(aprovar|aprovo|rejeitar|rejeito|status|pausar|retomar)(?:\s+([^\s]+))?(?:\s+([a-f0-9]{8,16}))?$/iu.exec(text);
  if (!match) return null;
  const verb = ({ APROVO: 'APROVAR', REJEITO: 'REJEITAR' })[match[1].toUpperCase()] || match[1].toUpperCase();
  if (['APROVAR', 'REJEITAR'].includes(verb) && !match[2]) return null;
  if (verb === 'STATUS' && match[2]) return null;
  return [verb, match[2], match[3]].filter(Boolean).join(' ');
}
