import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { researchTopics } from './research.js';
import { createEditorialVerifier } from './verification.js';
import { createOpenClawTextRunner } from './providers/openclaw-ai.js';
import { createEditorialSelector } from './editorial-selection.js';

export function createVerifier(config) {
  if (!config.openclawAiEnabled) return undefined;
  return createEditorialVerifier(config, { modelCall: createOpenClawTextRunner(config) });
}

export function createResearch(config, { discoverOnly = false } = {}) {
  const verifyImpl = discoverOnly ? undefined : createVerifier(config);
  const selectImpl = discoverOnly || !config.openclawAiEnabled ? undefined : createEditorialSelector({ modelCall: createOpenClawTextRunner(config), agent: config.openclawAiAgent });
  return async (_config, options = {}) => {
    const result = await researchTopics(config, { ...options, verifyImpl, selectImpl });
    const directory = join(config.dataDir, 'research');
    await mkdir(directory, { recursive: true });
    const reportPath = join(directory, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.json`);
    await writeFile(reportPath, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
    return { ...result, reportPath };
  };
}
