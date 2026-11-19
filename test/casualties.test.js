import assert from 'node:assert';
import { splitCasualties, fightCasualties, calibrate } from '../js/casualties.js';
// Attacker on a city: 35% die, rest severely injured (unlimited infirmary)
let s = splitCasualties(10000, { deadPct: 35 });
assert.deepStrictEqual([s.dead, s.severe, s.light], [3500, 6500, 0]);
// Lightly injured share comes off first
s = splitCasualties(10000, { deadPct: 35, lightPct: 50 });
assert.deepStrictEqual([s.dead, s.severe, s.light], [3500, 1500, 5000]);
// Defender: none die until infirmary full, then overflow dies (no enlistment)
s = splitCasualties(100000, { deadPct: 0, infirmary: 60000 });
assert.deepStrictEqual([s.dead, s.severe, s.overflow], [40000, 60000, 40000]);
// Attacker overflow: Enlistment Office rescues 70%
s = splitCasualties(100000, { deadPct: 35, infirmary: 25000, enlistSavePct: 70 });
assert.deepStrictEqual([s.deadBase, s.overflow, s.rescued, s.overflowDead, s.dead, s.severe], [35000, 40000, 28000, 12000, 47000, 25000]);
// parts always sum to casualties (rescued counted separately from dead/severe)
for (const C of [0, 1, 7, 12345, 999999]) { const x = splitCasualties(C, { deadPct: 35, lightPct: 33, infirmary: 1000, enlistSavePct: 70 }); assert.strictEqual(x.dead + x.severe + x.light + x.rescued, C); }
// fight wrapper
const f = fightCasualties({ lost: [20000, 210000] }, { attDeadPct: 35, defDeadPct: 0, defInfirmary: 150000 });
assert.strictEqual(f.att.dead, 7000); assert.strictEqual(f.def.dead, 60000); assert.ok(Math.abs(f.deadTrade - 60000 / 7000) < 1e-9);
assert.deepStrictEqual(calibrate({ dead: 35, severe: 40, light: 25 }), { deadPct: 35, lightPct: 25 });
console.log('ok: casualties');
