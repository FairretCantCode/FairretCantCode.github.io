import assert from 'node:assert';
import { HERO_DB } from '../js/heroes-data.js';
import { buildSkills, expectedOps, familyValues, prepareSide, simulate, monteCarlo } from '../js/engine.js';
import { joinerSets, searchRallies } from '../js/solver.js';

const st = v => ({ atk: v, let: v, def: v, hp: v });
const side = (troops, extra = {}) => ({
  tiers: { inf: 'T10', cav: 'T10', arc: 'T10' }, stats: { inf: st(250), cav: st(250), arc: st(250) },
  leaderPreset: 'none', leaderOps: {}, leaderTroops: troops, joiners: [], leaders: {}, ...extra,
});

// Joiners: 2 Chenko + 2 Amane at lv5 → DamageUp 1.5 × 1.5 = 2.25 (kingshotsim example)
let s = side({ inf: 1, cav: 0, arc: 0 }, { joiners: ['Chenko', 'Chenko', 'Amane', 'Amane'].map(h => ({ hero: h, level: 5 })) });
assert.ok(Math.abs(familyValues(expectedOps(buildSkills(s, HERO_DB))).DamageUp - 2.25) < 1e-9);

// Duplicate chance joiners don't stack: 4 Petra = one roll of 50% × 50 → 211:25
s = side({ inf: 1 }, { joiners: Array(4).fill({ hero: 'Petra', level: 5 }) });
assert.strictEqual(expectedOps(buildSkills(s, HERO_DB))['211'], 25);

// Top-4 by skill level, ties by order
s = side({ inf: 1 }, { joiners: [{ hero: 'Gordon', level: 1 }, { hero: 'Chenko', level: 5 }, { hero: 'Amane', level: 5 }, { hero: 'Eric', level: 3 }, { hero: 'Fahd', level: 4 }] });
const c = buildSkills(s, HERO_DB).counted.map(j => j.hero);
assert.deepStrictEqual(c, ['Chenko', 'Amane', 'Fahd', 'Eric']);

// Epic leader uses first skill only; legendary all three
s = side({ inf: 1 }, { leaders: { inf: { hero: 'Amadeus', lv: [5, 5, 5] }, cav: { hero: 'Gordon', lv: [5, 5, 5] } } });
const o = expectedOps(buildSkills(s, HERO_DB));
assert.strictEqual(o['101'], 25); assert.strictEqual(o['113'], 25); assert.strictEqual(o['102'], 25 + 0.4 * 50);

// Type-scoped: Rosa Golden Rhythm only for archers
s = side({ inf: 1 }, { leaders: { arc: { hero: 'Rosa', lv: [0, 0, 5] } } });
const ops = expectedOps(buildSkills(s, HERO_DB));
assert.strictEqual(familyValues(ops, 'arc').DamageUp, 1.3); assert.strictEqual(familyValues(ops, 'inf').DamageUp, 1);

// Full fight sanity: bigger, stronger side wins
const A = prepareSide(side({ inf: 50000, cav: 30000, arc: 40000 }, { stats: { inf: st(300), cav: st(300), arc: st(300) } }), HERO_DB);
const D = prepareSide(side({ inf: 30000, cav: 20000, arc: 20000 }), HERO_DB);
const r = simulate(A, D);
assert.strictEqual(r.winner, 'attacker');
const mc = monteCarlo(A, D, 50);
assert.ok(mc.winRate > 0.9);
// Solver
const sets = joinerSets([{ hero: 'Chenko', count: 2, level: 5 }, { hero: 'Petra', count: 3, level: 5 }, { hero: 'Diana', count: 4, level: 5 }], HERO_DB);
assert.ok(sets.every(x => x.filter(y => y.hero === 'Petra').length <= 1) && sets.every(x => x.length === 4) && sets.every(x => x.filter(y => y.hero === 'Diana').length >= 1));
globalThis.performance ??= { now: Date.now };
const out = await searchRallies({ attacker: side({}), defenderPrepared: D, heroes: HERO_DB, pool: [{ hero: 'Chenko', count: 4, level: 5 }, { hero: 'Saul', count: 4, level: 5 }],
  capacity: 120000, step: 20, presets: ['none'], opts: {} });
assert.ok(out.results.length > 0);
console.log('ok', r.winner, r.rounds, 'rounds; MC', mc.winRate, '; search', out.total, 'best', out.results[0].joiners.join('/'), out.results[0].split.pct);

// ---- fail-safe: rare & unknown heroes ----
{
  const { getHero, NOOP_HERO } = await import('../js/heroes-data.js');
  assert.strictEqual(getHero(HERO_DB, 'NotAHero'), NOOP_HERO);
  let s2 = side({ inf: 1 }, { joiners: [{ hero: 'Seth', level: 5 }, { hero: 'Typo', level: 5 }, { hero: 'Chenko', level: 5 }], leaders: { inf: { hero: 'Ghost', lv: [5, 5, 5] }, cav: { hero: 'Edwin', lv: [5, 5, 5] } } });
  const sk = buildSkills(s2, HERO_DB);
  assert.deepStrictEqual(expectedOps(sk), { 101: 25 });
  assert.strictEqual(sk.counted.length, 3); // they still take slots
  const sets2 = joinerSets([{ hero: 'Seth', count: 2, level: 5 }, { hero: 'Olive', count: 3, level: 5 }, { hero: 'Nope', count: 1, level: 5 }, { hero: 'Amane', count: 1, level: 5 }], HERO_DB);
  assert.ok(sets2.length === 1 && sets2[0].length === 4, JSON.stringify(sets2.map(s => s.map(x => x.hero))));
}
// ---- hero stats & gear ----
{
  const { effectiveStats, perTroopStats, sideTroops, marchTroops } = await import('../js/engine.js');
  const base = side({ inf: 1 }, { statMode: 'build', leaders: { inf: { hero: 'Amadeus', lv: [5, 5, 5] } },
    heroGear: { inf: { let: 40, hp: 30 } }, passives: { helga: 5, amadeus: 0 } });
  const e = effectiveStats(base);
  assert.strictEqual(e.inf.atk, 250 + 260.2 + 10); assert.strictEqual(e.inf.let, 250 + 62.5 + 40); assert.strictEqual(e.inf.hp, 250 + 62.5 + 30);
  assert.strictEqual(e.cav.atk, 260); assert.strictEqual(e.cav.let, 250);
  const rep = effectiveStats({ ...base, statMode: 'report' });
  assert.strictEqual(rep.inf.atk, 250);
  const ov = effectiveStats({ ...base, heroOver: { Amadeus: { exp: 100, exclLet: 0 } } });
  assert.strictEqual(ov.inf.atk, 250 + 100 + 10); assert.strictEqual(ov.inf.let, 250 + 40);
  // presets bring their own leaders' stats
  assert.strictEqual(effectiveStats({ ...base, leaderPreset: 'defense' }).inf.atk, 250 + 290.23 + 10);
  // ---- army count / rally cap ----
  const capped = side({ inf: 30000, cav: 0, arc: 0 }, { cap: 50000, joiners: [{ troops: { inf: 0, cav: 10000, arc: 10000 } }, { troops: { inf: 10000, cav: 10000, arc: 0 } }] });
  const m = marchTroops(capped);
  assert.strictEqual(m.n.inf + m.n.cav + m.n.arc, 50000); assert.strictEqual(m.rejected, 20000); assert.strictEqual(m.accepted[2].inf, 0);
  // more troops → more damage dealt
  const D2 = prepareSide(side({ inf: 100000, cav: 100000, arc: 100000 }), HERO_DB);
  const small = simulate(prepareSide(side({ inf: 20000, cav: 20000, arc: 20000 }), HERO_DB), D2);
  const big = simulate(prepareSide(side({ inf: 60000, cav: 60000, arc: 60000 }), HERO_DB), D2);
  assert.ok(big.lost[1] > small.lost[1] * 2, `${small.lost[1]} vs ${big.lost[1]}`);
}
console.log('ok: fail-safe, hero stats, army count');
