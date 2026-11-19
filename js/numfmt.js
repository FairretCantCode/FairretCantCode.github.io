// K / M / B shorthand for number entry: "250k" → 250000, "1.5M" → 1500000, "2b" → 2e9.
// Also accepts plain numbers with thousands separators ("1,200,000", "1 200 000", "1_200_000")
// and a trailing % (ignored), so pasted values work too.
const UNITS = { k: 1e3, m: 1e6, b: 1e9 };

export function parseNum(input) {
  if (typeof input === 'number') return input;
  const s = String(input ?? '').trim().replace(/[\s,_]/g, '').replace(/%$/, '');
  if (s === '') return '';
  const m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+))([kmb])?$/i);
  if (!m) return NaN;
  const v = parseFloat(m[1]) * (m[2] ? UNITS[m[2].toLowerCase()] : 1);
  return m[2] ? Math.round(v) : v;
}

// Exact, compact display for troop-sized numbers: 40000 → "40K", 36569 → "36.569K",
// 1500000 → "1.5M". Below 1,000 the number is shown as is.
export function formatQty(n) {
  if (n === '' || n == null || isNaN(n)) return '';
  const a = Math.abs(n);
  for (const [u, v] of [['B', 1e9], ['M', 1e6], ['K', 1e3]]) {
    if (a >= v) return `${+(n / v).toFixed(6)}${u}`;
  }
  return String(+(+n).toFixed(6));
}
