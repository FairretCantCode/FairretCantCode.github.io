import assert from 'node:assert';
import { HERO_DB } from '../js/heroes-data.js';
import { prepareChain, runChain } from '../js/chain.js';
import { optimizeChain } from '../js/chainopt.js';
globalThis.performance ??= { now: Date.now };

const st = v => ({ atk: v, let: v, def: v, hp: v });
const side = (troops, extra = {}) => ({ tiers: { inf: 'T10', cav: 'T10', arc: 'T10' }, stats: { inf: st(250), cav: st(250), arc: st(250) },
  leaderPreset: 'none', leaderOps: {}, leaderTroops: troops, joiners: [], leaders: {}, ...extra });
const def = side({ inf: 80000, cav: 60000, arc: 60000 }, { leaders: { inf: { hero: 'Eric', lv: [5, 5, 5] } } });
const tmpl = { name: 'w', side: side({}, { leaders: { inf: { hero: 'Amadeus', lv: [5, 5, 5] } } }), capacity: 120000, limits: null };
const pool = [{ hero: 'Chenko', count: 2, level: 5 }, { hero: 'Amane', count: 2, level: 5 }, { hero: 'Saul', count: 2, level: 5 }, { hero: 'Fahd', count: 1, level: 5 }, { hero: 'Petra', count: 1, level: 5 }];

// Two waves of 120k: optimizer should break it, and its plan must reproduce exactly in the chain engine.
const plans = await optimizeChain({ defender: def, templates: [tmpl, tmpl], heroes: HERO_DB, pool, shared: true, step: 25 });
assert.ok(plans.length > 0);
const best = plans[0];
assert.ok(best.broken, 'best plan should break the garrison');
const waves = best.plan.filter(p => !p.skipped).map(p => ({ name: p.name, side: { ...p.side, joiners: p.joiners.map((h, i) => ({ hero: h, level: p.level[i], troops: {} })) }, troops: p.split.n }));
const replay = runChain(prepareChain({ defender: def, waves, heroes: HERO_DB }));
assert.strictEqual(replay.lostA, best.lostA);
assert.deepStrictEqual(replay.final, best.d);

// Double rally: a player is only used once across waves.
for (const p of plans) {
  const used = {};
  for (const w of p.plan) for (const h of w.joiners || []) used[h] = (used[h] || 0) + 1;
  for (const [h, n] of Object.entries(used)) assert.ok(n <= pool.find(x => x.hero === h).count, `${h} used ${n}×`);
}
// Successive: reuse allowed → at least as good as shared.
const plansFree = await optimizeChain({ defender: def, templates: [tmpl, tmpl], heroes: HERO_DB, pool, shared: false, step: 25 });
assert.ok(plansFree[0].broken && plansFree[0].lostA <= best.lostA * 1.02, `${plansFree[0].lostA} vs ${best.lostA}`);
console.log('ok: chainopt — best', best.plan.map(p => p.joiners?.join('/') + ' ' + JSON.stringify(p.split?.pct)).join(' → '), 'lostA', best.lostA);

// Tougher garrison: one wave can't do it, two can.
{
  const big = side({ inf: 120000, cav: 96000, arc: 84000 }, { leaders: { inf: { hero: 'Eric', lv: [5, 5, 5] } } });
  const single = await optimizeChain({ defender: big, templates: [tmpl], heroes: HERO_DB, pool, shared: true, step: 25 });
  const dbl = await optimizeChain({ defender: big, templates: [tmpl, tmpl], heroes: HERO_DB, pool, shared: true, step: 25 });
  console.log('  single broken?', single[0].broken, 'left', JSON.stringify(single[0].d), '| double broken?', dbl[0].broken, 'at wave', dbl[0].brokenAt + 1, 'lostA', dbl[0].lostA);
  assert.ok(!single[0].broken && dbl[0].broken && dbl[0].brokenAt === 1);
}
console.log('ok: chainopt needs-two-waves');
