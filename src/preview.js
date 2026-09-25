import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyCandidates } from './research.js';
import { renderPost } from './render.js';

// Technical previews are deliberately separate from the publication database.
// No approval command or scheduling action can publish one accidentally.
export async function createPreview({ config, candidate, ai, verifyImpl, messenger, renderer = renderPost, clock = () => new Date() }) {
  if (!candidate || typeof candidate.topic !== 'string' || !['curiosity', 'news'].includes(candidate.category) || !Array.isArray(candidate.sources)) throw new Error('Candidato de prévia inválido.');
  const [verified] = await verifyCandidates([candidate], { verifyImpl, now: clock(), clock });
  const disallowed = verified.blockedReasons.filter((reason) => reason !== 'NO_RECENT_DATED_TREND_SIGNAL');
  if (disallowed.length) throw Object.assign(new Error(`Prévia bloqueada: ${disallowed.join(', ')}.`), { code: 'PREVIEW_UNVERIFIED' });
  const id = `preview_${randomUUID()}`;
  const directory = join(config.outputDir, 'previews', id);
  await mkdir(directory, { recursive: true });
  const copy = await ai.generateCopy(verified);
  const generated = await ai.generateImage({ prompt: copy.imagePrompt });
  const imagePath = join(directory, 'post.png');
  await renderer({ imageBuffer: generated.buffer, headline: copy.headline, highlights: copy.highlights, outputPath: imagePath });
  const { buffer, ...provenance } = generated;
  const report = { id, createdAt: clock().toISOString(), kind: 'technical-preview', publishable: false, note: 'Prévia técnica, fora dos lotes e sem agendamento. Tendência recente não é presumida.', candidate: verified, copy, image: provenance, imagePath };
  const reportPath = join(directory, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  let delivery = { sent: false, skipped: true };
  if (messenger) {
    delivery = await messenger.send({ imagePath, text: `PRÉVIA TÉCNICA — NÃO AGENDADA\n${copy.headline}\n\n${copy.caption}\n\n${verified.trend.label}\nEste teste não entra no lote diário e não tem comando de aprovação.` });
  }
  return { id, imagePath, reportPath, headline: copy.headline, sent: delivery.sent === true, publishable: false };
}
