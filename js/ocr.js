// Screenshot → text (Tesseract.js, loaded on demand) → stat bonuses / troop counts.
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

let loading;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  loading ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.onload = () => res(window.Tesseract);
    s.onerror = () => rej(new Error('Could not load the OCR engine (check your internet connection).'));
    document.head.appendChild(s);
  });
  return loading;
}

// Crop (full / left / right half), upscale 2× and grayscale for better OCR.
export async function preprocess(file, crop = 'full') {
  const img = await createImageBitmap(file);
  const sx = crop === 'right' ? img.width / 2 : 0;
  const sw = crop === 'full' ? img.width : img.width / 2;
  const scale = Math.min(2, 3000 / sw);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(img.height * scale);
  const g = c.getContext('2d');
  g.filter = 'grayscale(1) contrast(1.4)';
  g.drawImage(img, sx, 0, sw, img.height, 0, 0, c.width, c.height);
  return c;
}

export async function recognize(file, crop, onProgress) {
  const T = await loadTesseract();
  const canvas = await preprocess(file, crop);
  const { data } = await T.recognize(canvas, 'eng', {
    logger: m => m.status === 'recognizing text' && onProgress?.(m.progress),
  });
  return data.text;
}

const TYPE_RX = [
  ['inf', /infan\w*/i],
  ['cav', /caval\w*/i],
  ['arc', /arch\w*|marksm\w*/i],
];
const STAT_RX = [
  ['atk', /attack|atk/i],
  ['let', /lethal\w*/i],
  ['def', /defen[cs]e|def\b/i],
  ['hp', /health|hp\b/i],
];
const PCT_RX = /([+-]?\d[\d,]*(?:\.\d+)?)\s*%/g;
const INT_RX = /(?<![\d.%])(\d{1,3}(?:[,.\s]\d{3})+|\d{3,})(?![\d%]|\.\d)/g;

const num = s => parseFloat(String(s).replace(/,/g, ''));
const emptySide = () => ({
  stats: { inf: {}, cav: {}, arc: {} },
  troops: {},
});

// Battle reports usually show both sides in two columns, so a line with two values
// is read as [left side, right side].
export function parseReport(text) {
  const sides = [emptySide(), emptySide()];
  let ctxType = null;
  let found = 0;
  const lines = text.split(/\n+/).map(l => l.replace(/[|]/g, ' ').trim()).filter(Boolean);

  for (const line of lines) {
    const type = TYPE_RX.find(([, rx]) => rx.test(line))?.[0];
    const stat = STAT_RX.find(([, rx]) => rx.test(line))?.[0];
    const pcts = [...line.matchAll(PCT_RX)].map(m => num(m[1]));
    if (type && !stat && pcts.length === 0) ctxType = type;
    const t = type || ctxType;

    if (t && stat && pcts.length) {
      pcts.slice(0, 2).forEach((v, i) => { sides[i].stats[t][stat] = v; });
      found++;
      continue;
    }
    if (type && !stat && pcts.length === 0) {
      const ints = [...line.matchAll(INT_RX)].map(m => num(m[1].replace(/[.\s]/g, ''))).filter(v => v >= 10);
      if (ints.length) {
        ints.slice(0, 2).forEach((v, i) => { sides[i].troops[type] ??= v; });
        found++;
      }
    }
  }
  const hasRight = Object.values(sides[1].stats).some(o => Object.keys(o).length) || Object.keys(sides[1].troops).length;
  return { sides: hasRight ? sides : [sides[0]], found, lines: lines.length };
}
