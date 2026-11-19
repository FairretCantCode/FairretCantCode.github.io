import { attPerTroop, roundDamage, familyValues } from '../js/engine.js';
import assert from 'node:assert';
const att = attPerTroop(491, 293.66, 251.82);
assert.ok(Math.abs(att - 680) < 1, 'att ' + att);
const d = roundDamage({ squad: 40233, armyMin: Math.min(120789, 78872), att, def: 2557.9, counter: false, skill: 1.26, fatigue: 1 });
assert.strictEqual(Math.ceil(d), 189, 'deaths ' + d);
// SkillMod stacking examples
const f = (ops) => familyValues(ops);
assert.strictEqual(f({101: 100}).DamageUp, 2);
assert.ok(Math.abs(f({101: 50, 102: 50}).DamageUp - 2.25) < 1e-9);
assert.ok(Math.abs(f({113: 75, 111: 20}).DefenseUp - 2.1) < 1e-9);
console.log('ok: att', att.toFixed(2), 'damage', d.toFixed(2), '-> deaths', Math.ceil(d));
