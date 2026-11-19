import assert from 'node:assert';
import { rowAvail, sideRows, armyLimits, feasibleSplit, allocate, rosterPool, matchHeroes, ratioToTroops, troopsToRatio } from '../js/army.js';

// fallback: no avail → exactly what is sent
assert.deepStrictEqual(rowAvail({ inf: 100, cav: 50, arc: 0 }, {}), { max: { inf: 100, cav: 50, arc: 0 }, march: 150 });
// march only → any type up to march
assert.deepStrictEqual(rowAvail({}, { march: 200 }), { max: { inf: 200, cav: 200, arc: 200 }, march: 200 });
// march capped by what they own
assert.deepStrictEqual(rowAvail({}, { march: 500, max: { inf: 100, cav: 100, arc: 0 } }).march, 200);

const side = {
  cap: 1000,
  leaderTroops: {}, leaderAvail: { march: 300, max: { inf: 300, cav: 300, arc: 300 } },
  joiners: [
    { hero: 'Chenko', level: 5, troops: {}, avail: { march: 400, max: { inf: 0, cav: 400, arc: 400 }, heroes: ['Chenko', 'Amane'] } },
    { hero: 'Saul', level: 4, troops: {}, avail: { march: 400, max: { inf: 400, cav: 0, arc: 0 }, heroes: ['Saul', 'Amane'] } },
  ],
};
const L = armyLimits(side);
assert.deepStrictEqual(L.limits, { inf: 700, cav: 700, arc: 700 });
assert.strictEqual(L.capacity, 1000);
// Joint feasibility: 700 inf is OK alone (300 leader + 400 joiner2), but 700 inf + 300 arc needs
// leader for inf, so arc must come from joiner1: fine. 800 inf impossible.
assert.ok(feasibleSplit({ inf: 700, cav: 0, arc: 300 }, L.rows));
assert.ok(!feasibleSplit({ inf: 800, cav: 0, arc: 200 }, L.rows));
// Each per-type limit is fine but jointly impossible: leader+j1 must cover cav+arc = 750 > 300+400
assert.ok(!feasibleSplit({ inf: 250, cav: 400, arc: 350 }, L.rows));
const a = allocate({ inf: 700, cav: 100, arc: 200 }, L.rows);
assert.ok(a);
a.forEach((x, i) => { const r = L.rows[i]; for (const t of ['inf', 'cav', 'arc']) assert.ok(x[t] <= r.max[t]); assert.ok(x.inf + x.cav + x.arc <= r.march); });
assert.deepStrictEqual(['inf', 'cav', 'arc'].map(t => a.reduce((s, x) => s + x[t], 0)), [700, 100, 200]);
assert.strictEqual(allocate({ inf: 800, cav: 0, arc: 200 }, L.rows), null);
// random agreement between feasibility test and allocator
for (let k = 0; k < 300; k++) {
  const n = { inf: Math.floor(Math.random() * 900), cav: Math.floor(Math.random() * 900), arc: Math.floor(Math.random() * 900) };
  assert.strictEqual(feasibleSplit(n, L.rows), allocate(n, L.rows) != null, JSON.stringify(n));
}
// hero matching: Amane owned by both, but each player brings one hero
const pool = rosterPool(side.joiners);
assert.deepStrictEqual(pool.find(p => p.hero === 'Amane').count, 2);
assert.deepStrictEqual(matchHeroes(['Chenko', 'Amane'], side.joiners), [0, 1]);
assert.strictEqual(matchHeroes(['Chenko', 'Saul', 'Amane'], side.joiners), null);
assert.strictEqual(matchHeroes(['Amane', 'Amane'], side.joiners).length, 2);
// ratio ↔ counts
assert.deepStrictEqual(ratioToTroops({ inf: 50, cav: 20, arc: 30 }, 120000), { inf: 60000, cav: 24000, arc: 36000 });
assert.deepStrictEqual(ratioToTroops({ inf: 1, cav: 1, arc: 1 }, 100), { inf: 33, cav: 33, arc: 34 });
assert.deepStrictEqual(troopsToRatio({ inf: 60000, cav: 24000, arc: 36000 }), { ratio: { inf: 50, cav: 20, arc: 30 }, march: 120000 });
console.log('ok: army');
