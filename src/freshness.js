const ONE_DAY_MS = 86_400_000;
const URGENT_TOPICS = /\b(?:ai|ia|llm|gpt|openai|anthropic|chatgpt|claude|gemini|tech|app|apps|stf|ban|war|wars|warfare|army|navy|nato|otan|idf)\b|\b(?:pol[ií]tic|governo|government|presidente|president|congresso|congress|senado|senate|deputad|elei[cç][aã]o|election|decreto|decree|regula[cç][aã]o|regulation|proibi[cç][aã]o|supremo|partido|party|ministro|minister|intelig[eê]ncia artificial|artificial intelligence|tecnolog|software|aplicativo|rob[oô]|robot|chip|computador|computer|smartphone|modelo de linguagem|language model|chatbot|guerra|militar|military|ex[eé]rcito|for[cç]as? armadas?|armed forces|for[cç]a a[eé]rea|air force|naval|b[eé]lic|m[ií]ss(?:il|eis)|missile|bombarde|bombing|airstrike|invas[aã]o|invasion|armamento|weapon|ceasefire|cessar\.fogo|conflito armado|armed conflict|drone|nuclear|ur[aâ]nio|uranium|plut[oô]nio|plutonium)/iu;

export function requiresOneDayFreshness(candidate) {
  return URGENT_TOPICS.test(`${candidate.topic || ''} ${candidate.summary || ''} ${candidate.headline || ''} ${candidate.caption || ''}`);
}

export function freshEnoughForPublication(candidate, now = new Date()) {
  if (!requiresOneDayFreshness(candidate)) return true;
  // Collection time is never a publication date. Undated urgent stories fail
  // closed, and a future date cannot make an old story look current.
  const dates = (candidate.sources || []).map((source) => Date.parse(source.publishedAt || '')).filter(Number.isFinite);
  if (!dates.length || dates.some((date) => date > now.getTime())) return false;
  return Math.max(...dates) >= now.getTime() - ONE_DAY_MS;
}
