import assert from 'node:assert';
import { parseNum, formatQty } from '../js/numfmt.js';
const cases = { '250k': 250000, '250K': 250000, '1.5M': 1500000, '1.5m': 1500000, '2b': 2e9, '.5k': 500, '40,000': 40000,
  '1 200 000': 1200000, '1_000': 1000, '293.66': 293.66, '293.66%': 293.66, '-20': -20, '1.2345k': 1235, '': '', '  3k ': 3000 };
for (const [k, v] of Object.entries(cases)) assert.strictEqual(parseNum(k), v, k);
for (const bad of ['abc', '1.5x', 'k', '1..2', '1.5kk']) assert.ok(Number.isNaN(parseNum(bad)), bad);
for (const n of [40000, 36569, 1500000, 1234567, 999, 2e9, 130000, 0]) assert.strictEqual(parseNum(formatQty(n)), n, String(n));
assert.strictEqual(formatQty(40000), '40K'); assert.strictEqual(formatQty(1500000), '1.5M'); assert.strictEqual(formatQty(36569), '36.569K');
console.log('ok: numfmt');
