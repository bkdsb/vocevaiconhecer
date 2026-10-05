import { loadConfig } from './src/config.js';
import { runScraplingProfiles, researchTopics } from './src/research.js';
import { resolve } from 'path';

const config = loadConfig();

async function test() {
  const scrapling = await runScraplingProfiles({ pythonBin: config.scraplingPython, scriptPath: resolve(process.cwd(), 'scripts/scrapling-sources.py') });
  const inspirationProfiles = (scrapling.profiles || []).flatMap((profile) => (profile.topics || []).slice(0, 20).map((topic) => ({
    source: profile.source,
    url: profile.url,
    category: profile.category,
    text: typeof topic === 'string' ? topic : topic.text,
    metrics: typeof topic === 'object' && topic.metrics ? topic.metrics : { score: 1000 }
  })));
  console.log('first 3:', inspirationProfiles.slice(0, 3));
  const undef = inspirationProfiles.filter(p => !p.text);
  console.log('undefined count:', undef.length);
  if (undef.length > 0) console.log('first undef:', undef[0]);
}
test();
