import { loadConfig } from './src/config.js';
import { runScraplingProfiles, researchTopics } from './src/research.js';

const config = loadConfig();

async function test() {
  try {
    const result = await researchTopics(config, {
      now: new Date(),
      runImpl: async () => [],
      scraplingImpl: runScraplingProfiles,
      relaxed: true
    });
    console.log('SUCCESS! Candidates:', result.candidates.length);
  } catch (e) {
    console.error('CRASH:', e);
  }
}
test();
