import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPost } from '../src/render.js';

test('renderer produces 1080x1350 PNG and rejects overlong headlines', async () => { const dir = await mkdtemp(join(tmpdir(), 'vvc-render-')); const image = await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer(); const output = join(dir, 'post.png'); const result = await renderPost({ imageBuffer: image, headline: 'UM ANIMAL TESTE COM UM PODER INESPERADO', highlights: ['PODER INESPERADO'], outputPath: output }); const metadata = await sharp(await readFile(result.path)).metadata(); assert.deepEqual([metadata.width, metadata.height], [1080, 1350]); await assert.rejects(() => renderPost({ imageBuffer: image, headline: 'palavra '.repeat(19), outputPath: join(dir, 'bad.png') }), /18 palavras/); });
