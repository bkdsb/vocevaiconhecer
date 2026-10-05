/**
 * Composes an AI-generated raster with the supplied brand logo and one headline.
 * renderPost({ imageBuffer, headline, highlights?, outputPath, logoPath? }) returns
 * { path, width: 1080, height: 1350 }. The path is absolute; its parent is created.
 * No network calls or fallback photos. Invalid input, missing brand files, invalid
 * raster data and a headline that cannot fit legibly reject the promise. A failed
 * validation never writes an output. The bundled OFL font is registered with Pango
 * before SVG rendering so the composition does not depend on system fonts.
 */
import sharp from 'sharp';
import { access, mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDTH = 1080;
const HEIGHT = 1350;
const MAX_TEXT_WIDTH = 948;
const MAX_TEXT_HEIGHT = 370;
const BOTTOM_MARGIN = 76;
const LOGO_SIZE = 142;
const LOGO_BORDER_WIDTH = 2;
const LOGO_LEFT = (WIDTH - LOGO_SIZE) / 2;
const LOGO_TOP = 41;
const FONT_PATH = fileURLToPath(new URL('../assets/brand/Montserrat-ExtraBold.ttf', import.meta.url));
const LOGO_PATH = fileURLToPath(new URL('../assets/brand/logo.png', import.meta.url));
const LIMIT_INPUT_PIXELS = 50_000_000;
let fontReady;

function escapeXml(text) {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}

function normalize(text) {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleUpperCase('pt-BR');
}

function validate({ imageBuffer, headline, highlights, outputPath, logoPath }) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length || imageBuffer.length > 32 * 1024 * 1024) {
    throw new TypeError('imageBuffer deve conter uma imagem raster de IA de até 32 MB.');
  }
  if (typeof headline !== 'string' || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(headline)) {
    throw new TypeError('headline deve ser texto válido, sem caracteres de controle.');
  }
  const title = normalize(headline);
  if (!title || !/\p{L}/u.test(title) || [...title].length > 220 || title.split(' ').length > 18) {
    throw new RangeError('headline deve conter um título de até 18 palavras e 220 caracteres.');
  }
  if (!Array.isArray(highlights) || highlights.length > 18 || highlights.some((item) => typeof item !== 'string' || !item.trim() || item.length > 220)) {
    throw new TypeError('highlights deve ser uma lista de até 18 palavras ou expressões.');
  }
  if (typeof outputPath !== 'string' || !outputPath.trim() || !['.png', '.jpg', '.jpeg', '.webp'].includes(extname(outputPath).toLowerCase())) {
    throw new TypeError('outputPath deve ser um caminho local .png, .jpg, .jpeg ou .webp.');
  }
  if (typeof logoPath !== 'string' || !logoPath.trim()) throw new TypeError('logoPath deve ser um caminho local.');
  if ([resolve(logoPath), FONT_PATH].includes(resolve(outputPath))) throw new RangeError('outputPath não pode sobrescrever um asset da marca.');
  return title;
}

async function registerFont() {
  if (!fontReady) {
    fontReady = (async () => {
      await access(FONT_PATH);
      await sharp({ text: { text: 'M', font: 'Montserrat ExtraBold 14', fontfile: FONT_PATH, rgba: true } }).png().toBuffer();
    })().catch((error) => { fontReady = undefined; throw error; });
  }
  await fontReady;
}

function markedWords(title, highlights) {
  const words = title.split(' ').map((text) => ({ text, marked: false }));
  const comparable = (word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const normalized = words.map(({ text }) => comparable(text));
  for (const highlight of highlights) {
    const phrase = normalize(highlight).split(' ').map(comparable);
    if (phrase.some((word) => !word)) continue;
    for (let index = 0; index <= words.length - phrase.length; index += 1) {
      if (phrase.every((word, offset) => word === normalized[index + offset])) {
        for (let offset = 0; offset < phrase.length; offset += 1) words[index + offset].marked = true;
      }
    }
  }
  return words;
}

async function renderLine(words, size) {
  const text = words.map(({ text, marked }, index) => `${index ? ' ' : ''}<tspan fill="${marked ? '#F5A900' : '#FFFFFF'}">${escapeXml(text)}</tspan>`).join('');
  // Ample temporary bounds include even unusually wide words. All final bounds
  // are measured from real glyph pixels, including accents and punctuation.
  const width = Math.ceil(words.reduce((length, word) => length + [...word.text].length + 1, 0) * size * 1.5 + 40);
  const height = Math.ceil(size * 2.8);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="16" y="${size * 1.7}" font-family="Montserrat" font-weight="800" font-size="${size}" xml:space="preserve">${text}</text></svg>`;
  return sharp(Buffer.from(svg), { limitInputPixels: LIMIT_INPUT_PIXELS })
    .trim({ background: '#00000000', threshold: 0 })
    .png().toBuffer({ resolveWithObject: true });
}

async function layoutHeadline(words) {
  const cache = new Map();
  const measured = async (line, size) => {
    const key = `${size}:${line.map((word) => word.text).join(' ')}`;
    if (!cache.has(key)) cache.set(key, renderLine(line, size));
    return cache.get(key);
  };
  const atSize = async (size) => {
    // Measure every contiguous span once, then choose line breaks that keep
    // the visual block balanced. A greedy wrap can leave a very short last
    // line even when a nearby break would give the card symmetrical margins.
    const spans = new Map();
    const span = async (start, end) => {
      const key = `${start}:${end}`;
      if (!spans.has(key)) spans.set(key, measured(words.slice(start, end), size));
      return spans.get(key);
    };
    const partitions = [];
    const visit = async (start, chosen) => {
      if (start === words.length) {
        if (chosen.length) partitions.push(chosen);
        return;
      }
      if (chosen.length === 5) return;
      for (let end = start + 1; end <= words.length; end += 1) {
        const rendered = await span(start, end);
        if (rendered.info.width > MAX_TEXT_WIDTH) break;
        await visit(end, [...chosen, { words: words.slice(start, end), rendered }]);
      }
    };
    await visit(0, []);
    if (!partitions.length) return null;

    const scored = partitions.map((partition) => {
      const widths = partition.map(({ rendered }) => rendered.info.width);
      const average = widths.reduce((sum, width) => sum + width, 0) / widths.length;
      const range = (Math.max(...widths) - Math.min(...widths)) / Math.max(1, average);
      const variance = widths.reduce((sum, width) => sum + ((width - average) / Math.max(1, average)) ** 2, 0) / widths.length;
      const lastLine = partition.at(-1).words;
      const lonelyLastLine = partition.length > 1 && lastLine.length === 1 ? 0.75 : 0;
      const lastWidthRatio = widths.at(-1) / Math.max(1, average);
      const shortLastLine = Math.max(0, 0.82 - lastWidthRatio) * 2.4;
      // Keep fewer lines when balance is comparable, while strongly preferring
      // blocks whose left and right edges sit at nearly the same visual width.
      const score = range * 2.4 + variance * 1.2 + (partition.length - 1) * 0.10 + lonelyLastLine + shortLastLine;
      const rendered = partition.map(({ rendered: pixels }) => pixels);
      const topOffsets = [];
      for (let index = 0; index < rendered.length; index += 1) {
        topOffsets[index] = index === 0
          ? 0
          : Math.max(topOffsets[index - 1] + rendered[index - 1].info.height + 8, index * Math.ceil(size * 1.03));
      }
      const height = topOffsets.at(-1) + rendered.at(-1).info.height;
      return { rendered, topOffsets, height, score, lineCount: partition.length };
    }).filter((candidate) => candidate.height <= MAX_TEXT_HEIGHT)
      .sort((left, right) => left.score - right.score);
    return scored[0] || null;
  };

  // Search legible sizes only. Reject impossible headlines instead of clipping,
  // adding ellipses, or silently shrinking the type to unreadable dimensions.
  let low = 34;
  let high = 90;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = await atSize(middle);
    if (candidate) { best = candidate; low = middle + 1; } else high = middle - 1;
  }
  if (!best) throw new RangeError('headline não cabe sem cortar o texto; encurte palavras ou o título.');

  // A slightly smaller type can produce a much more even block. Consider a
  // bounded step down so the renderer does not sacrifice legibility for a
  // single short tail line, while preserving the largest size when balance is
  // comparable.
  const largestSize = high;
  const minimumBalancedSize = Math.max(34, Math.floor(largestSize * 0.86));
  for (let size = largestSize - 1; size >= minimumBalancedSize; size -= 1) {
    const candidate = await atSize(size);
    if (!candidate || candidate.lineCount >= best.lineCount) continue;
    const sizeLoss = (largestSize - size) / largestSize;
    const balanceGain = best.score - candidate.score;
    if (balanceGain > 0.22 && sizeLoss <= 0.14) best = candidate;
  }
  return best;
}

export async function renderPost({ imageBuffer, headline, highlights = [], outputPath, logoPath = LOGO_PATH } = {}) {
  const title = validate({ imageBuffer, headline, highlights, outputPath, logoPath });
  const source = sharp(imageBuffer, { limitInputPixels: LIMIT_INPUT_PIXELS, failOn: 'warning' });
  const metadata = await source.metadata();
  if (!['jpeg', 'png', 'webp', 'avif', 'heif'].includes(metadata.format) || (metadata.pages ?? 1) !== 1 || metadata.width < 64 || metadata.height < 64) {
    throw new TypeError('A imagem de IA deve ser raster estático com pelo menos 64 × 64 pixels.');
  }
  await registerFont();
  const layout = await layoutHeadline(markedWords(title, highlights));
  const logo = await sharp(await readFile(logoPath), { limitInputPixels: LIMIT_INPUT_PIXELS })
    // The supplied logo includes transparent margins; size the visible mark itself.
    .trim({ background: '#00000000', threshold: 0 })
    .flatten({ background: '#FFFFFF' })
    .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'contain', background: '#FFFFFF' })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${LOGO_SIZE}" height="${LOGO_SIZE}"><circle cx="${LOGO_SIZE / 2}" cy="${LOGO_SIZE / 2}" r="${LOGO_SIZE / 2}" fill="white"/></svg>`), blend: 'dest-in' }])
    .png().toBuffer();
  // Draw the thin outline over the full-size white logo, without a yellow backing disc.
  const logoBorder = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${LOGO_SIZE}" height="${LOGO_SIZE}"><circle cx="${LOGO_SIZE / 2}" cy="${LOGO_SIZE / 2}" r="${(LOGO_SIZE - LOGO_BORDER_WIDTH) / 2}" fill="none" stroke="#F5A900" stroke-width="${LOGO_BORDER_WIDTH}"/></svg>`);
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.3" stop-color="#000" stop-opacity="0.37"/><stop offset="0.65" stop-color="#000" stop-opacity="0.83"/><stop offset="1" stop-color="#000" stop-opacity="0.97"/></linearGradient></defs>
    <rect x="0" y="730" width="1080" height="620" fill="url(#fade)"/>
    <circle cx="540" cy="118" r="75" fill="#000" opacity="0.18"/>
  </svg>`);
  const textTop = HEIGHT - BOTTOM_MARGIN - layout.height;
  const composite = [
    { input: overlay, left: 0, top: 0 },
    { input: logo, left: LOGO_LEFT, top: LOGO_TOP },
    { input: logoBorder, left: LOGO_LEFT, top: LOGO_TOP },
    ...layout.rendered.map(({ data, info }, index) => ({ input: data, left: Math.round((WIDTH - info.width) / 2), top: textTop + layout.topOffsets[index] })),
  ];
  const path = resolve(outputPath);
  await mkdir(dirname(path), { recursive: true });
  await source.rotate().resize(WIDTH, HEIGHT, { fit: 'cover', position: 'centre' })
    .flatten({ background: '#111111' }).toColourspace('srgb').composite(composite).toFile(path);
  return { path, width: WIDTH, height: HEIGHT };
}
