import { mkdir, access, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';

const run = promisify(execFile);
const config = loadConfig();
const vendorRoot = resolve(config.last30daysDir, 'vendor/last30days');
await mkdir(config.last30daysDir, { recursive: true });
try { await access(resolve(vendorRoot, 'skills/last30days/scripts/last30days.py')); console.log(`last30days já instalado em ${vendorRoot}`); }
catch {
  await run('git', ['clone', '--no-checkout', config.last30daysRepo, vendorRoot], { maxBuffer: 2_000_000 });
  await run('git', ['-C', vendorRoot, 'checkout', '--detach', config.last30daysSha], { maxBuffer: 2_000_000 });
  await writeFile(resolve(vendorRoot, 'VVC_PINNED_SHA'), `${config.last30daysSha}\n`, { mode: 0o600 });
  console.log(`last30days fixado em ${config.last30daysSha}`);
}
