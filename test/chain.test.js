import assert from 'node:assert';
import { HERO_DB } from '../js/heroes-data.js';
import { prepareSide, simulate } from '../js/engine.js';
import { prepareChain, runChain, chainMonteCarlo, remainingAfter } from '../js/chain.js';

const st = v => ({ atk: v, let: v, def: v, hp: v });
const side = (troops, extra = {}) => ({ tiers: { inf: 'T10', cav: 'T10', arc: 'T10' }, stats: { inf: st(250), cav: st(250), arc: st(250) },
  leaderPreset: 'none', leaderOps: {}, leaderTroops: troops, joiners: [], leaders: {}, ...extra });
const def = side({ inf: 80000, cav: 60000, arc: 60000 });
const atkSide = side({});
const wave = (n, extra = {}) => ({ name: 'w', side: atkSide, troops: { inf: n, cav: n, arc: n }, ...extra });

// Wave 1 alone loses; two waves break it.
const one = runChain(prepareChain({ defender: def, waves: [wave(50000)], heroes: HERO_DB }));
assert.strictEqual(one.brokenAt, null);
// wave 1 result equals a standalone fight
const solo = simulate(prepareSide(atkSide, HERO_DB, { inf: 50000, cav: 50000, arc: 50000 }), prepareSide(def, HERO_DB));
assert.deepStrictEqual(one.waves[0].r.remaining, solo.remaining);
const two = runChain(prepareChain({ defender: def, waves: [wave(50000), wave(50000)], heroes: HERO_DB }));
// wave 2 starts from wave 1's survivors
assert.deepStrictEqual(two.waves[1].defStart, one.final);
assert.ok(two.brokenAt === 1, 'second wave should break it: ' + JSON.stringify(two.final));
// a third wave after the break is skipped with no losses
const three = runChain(prepareChain({ defender: def, waves: [wave(50000), wave(50000), wave(50000)], heroes: HERO_DB }));
assert.ok(three.waves[2].skipped && three.lostA === two.lostA);
// reinforcements (capped by garrison capacity) arrive before wave 2
const reinf = runChain(prepareChain({ defender: { ...def, cap: 210000 }, waves: [wave(50000), wave(50000, { reinforceTroops: { inf: 50000, cav: 0, arc: 0 } })], heroes: HERO_DB }));
const left1 = one.final.inf + one.final.cav + one.final.arc;
assert.strictEqual(reinf.waves[1].reinforced, Math.min(50000, 210000 - left1));
// Monte Carlo is cumulative and in [0,1]
const mc = chainMonteCarlo(prepareChain({ defender: def, waves: [wave(50000), wave(50000)], heroes: HERO_DB }), 60);
assert.ok(mc.breakByWave[0] <= mc.breakByWave[1] && mc.breakByWave[1] > 0.5);
assert.deepStrictEqual(remainingAfter(prepareChain({ defender: def, waves: [wave(50000), wave(50000)], heroes: HERO_DB }), 0), one.final);
console.log('ok: chain', JSON.stringify(one.final), 'break by wave', mc.breakByWave);
