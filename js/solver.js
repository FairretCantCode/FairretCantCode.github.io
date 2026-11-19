// Rally search: which leader trio + joiner set + troop split beats a target.
import { TYPES, MAX_COUNTED_JOINERS } from './db.js';
import { prepareSide, simulate, monteCarlo } from './engine.js';
import { getHero, isNoop } from './heroes-data.js';

// All multisets of up to `k` joiners from pool, respecting how many players have each hero.
// Duplicate chance-skill heroes are skipped (they don't stack, so they only waste a slot).
export function joinerSets(pool, heroes, k = MAX_COUNTED_JOINERS) {
  // Fail-safe: rare / unknown heroes have no combat effect. They are merged into one filler
  // entry so they can fill an empty joiner slot without multiplying the search space.
  const all = pool.filter(p => +p.count > 0).map(p => ({ ...p, _h: getHero(heroes, p.hero) }));
  const real = all.filter(p => !isNoop(p._h));
  const filler = all.filter(p => isNoop(p._h));
  if (filler.length) real.push({ ...filler[0], count: filler.reduce((a, p) => a + +p.count, 0), level: 0, _h: getHero(heroes, filler[0].hero) });
  const items = real.map(p => ({ ...p, cap: p._h.skills?.[0]?.chance != null ? 1 : +p.count }));
  const size = Math.min(k, items.reduce((s, it) => s + it.cap, 0));
  const out = [];
  const rec = (start, cur) => {
    if (cur.length === size) { out.push(cur.slice()); return; }
    for (let i = start; i < items.length; i++) {
      const used = cur.filter(c => c === items[i]).length;
      if (used >= items[i].cap) continue;
      cur.push(items[i]);
      rec(i, cur);
      cur.pop();
    }
  };
  rec(0, []);
  // Filler only fills slots that real heroes can't: never swap a real skill for nothing.
  const realSlots = Math.min(size, items.filter(it => !isNoop(it._h)).reduce((s, it) => s + it.cap, 0));
  return out.filter(set => set.filter(it => !isNoop(it._h)).length === realSlots);
}

// Candidate troop splits summing to `capacity`. With per-type limits (the troops you really
// have), each grid point is clamped to the limit and the surplus is moved to types that still
// have room, so you always get usable splits instead of only the few that fit exactly.
export function troopSplits(capacity, step, limits) {
  const lim = {};
  for (const t of TYPES) lim[t] = limits && limits[t] !== '' && limits[t] != null ? Math.max(0, +limits[t]) : Infinity;
  const avail = TYPES.reduce((a, t) => a + Math.min(lim[t], capacity), 0);
  const cap = Math.min(capacity, avail);
  const steps = Math.round(100 / step);
  const out = [];
  const seen = new Set();
  for (let a = 0; a <= steps; a++) for (let b = 0; a + b <= steps; b++) {
    const c = steps - a - b;
    const n = { inf: Math.round(cap * a / steps), cav: Math.round(cap * b / steps), arc: Math.round(cap * c / steps) };
    for (let pass = 0; pass < 3; pass++) {
      let surplus = 0;
      for (const t of TYPES) if (n[t] > lim[t]) { surplus += n[t] - lim[t]; n[t] = lim[t]; }
      if (surplus <= 0) break;
      const room = TYPES.filter(t => n[t] < lim[t]);
      const tot = room.reduce((x, t) => x + (lim[t] === Infinity ? cap : lim[t] - n[t]), 0) || 1;
      for (const t of room) n[t] += Math.round(surplus * (lim[t] === Infinity ? cap : lim[t] - n[t]) / tot);
    }
    for (const t of TYPES) n[t] = Math.max(0, Math.min(n[t], lim[t]));
    const key = `${Math.round(n.inf / 100)}|${Math.round(n.cav / 100)}|${Math.round(n.arc / 100)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tot = n.inf + n.cav + n.arc || 1;
    out.push({ n, pct: { inf: Math.round(n.inf / tot * 100), cav: Math.round(n.cav / tot * 100), arc: Math.round(n.arc / tot * 100) } });
  }
  return out;
}

function score(r) {
  // Wins first (fewest own losses), then by trade ratio.
  if (r.winner === 'attacker') return 1e9 - r.lost[0];
  return r.trade * 1e3 - r.remaining[1].inf - r.remaining[1].cav - r.remaining[1].arc;
}

// Smooth screening metric: enemy fraction killed − own fraction lost (+1 for a win).
export function screenScore(r) {
  const tA = r.start[0].inf + r.start[0].cav + r.start[0].arc || 1;
  const tD = r.start[1].inf + r.start[1].cav + r.start[1].arc || 1;
  return r.lost[1] / tD - r.lost[0] / tA + (r.winner === 'attacker' ? 1 : 0);
}

// Two stages: (1) screen every leader-trio × joiner-set combo on a few probe splits,
// (2) run the full troop-split grid on the best `keep` combos.
// Joiner sets with identical skill effects (e.g. Chenko vs Yeonwoo) are simulated once.
// splitOk(n): optional extra check that a split can really be sent (per-joiner caps).
// setOk(set): optional extra check on a joiner set (e.g. one hero per player).
export async function searchRallies({ attacker, defenderPrepared, heroes, pool, capacity, step, limits, presets, opts, onProgress, topN = 30, keep = 25, splitOk, setOk }) {
  const sets = joinerSets(pool, heroes).filter(set => !setOk || setOk(set.map(s => s.hero)));
  if (sets.length === 0) sets.push([]);
  const splits = troopSplits(capacity, step, limits).filter(sp => !splitOk || splitOk(sp.n));
  if (!splits.length) return { total: 0, results: [], bestByArch: {}, sets: sets.length, splits: 0, combos: 0 };
  const probes = [{ inf: 40, cav: 30, arc: 30 }, { inf: 30, cav: 40, arc: 30 }, { inf: 30, cav: 30, arc: 40 }]
    .map(p => splits.reduce((best, sp) => {
      const d = Math.abs(sp.pct.inf - p.inf) + Math.abs(sp.pct.cav - p.cav) + Math.abs(sp.pct.arc - p.arc);
      return d < best.d ? { d, sp } : best;
    }, { d: Infinity }).sp);

  // Build unique combos
  const combos = [];
  const seen = new Set();
  for (const preset of presets) for (const set of sets) {
    const side = {
      ...attacker,
      leaderPreset: preset === 'current' ? attacker.leaderPreset : preset,
      joiners: set.map(s => ({ hero: s.hero, level: s.level, troops: {} })),
    };
    const base = prepareSide(side, heroes, { inf: 0, cav: 0, arc: 0 });
    const sig = preset + JSON.stringify(Object.entries(base.skills.fixed).filter(([, v]) => v).sort()) + JSON.stringify(base.skills.chance.map(c => [c.p, c.ops]).sort());
    if (seen.has(sig)) continue;
    seen.add(sig);
    combos.push({ preset, set, base });
  }

  // Big pools: screen on the balanced probe only to keep the search interactive.
  if (combos.length > 3000) probes.splice(0, probes.length, probes[0]);
  const totalWork = combos.length * probes.length + Math.min(keep, combos.length) * splits.length;
  let done = 0, lastYield = performance.now();
  const tick = async () => {
    if (performance.now() - lastYield > 40) {
      onProgress?.(done / totalWork);
      await new Promise(res => setTimeout(res, 0));
      lastYield = performance.now();
    }
  };

  // Stage 1
  for (const c of combos) {
    c.s1 = 0;
    for (const sp of probes) { c.s1 += screenScore(simulate({ ...c.base, troops: sp.n }, defenderPrepared, opts)); done++; }
    await tick();
  }
  combos.sort((x, y) => y.s1 - x.s1);
  const finalists = combos.slice(0, keep);

  // Stage 2
  const results = [];
  const bestByArch = {};
  for (const c of finalists) {
    for (const sp of splits) {
      const r = simulate({ ...c.base, troops: sp.n }, defenderPrepared, opts);
      const entry = { preset: c.preset, joiners: c.set.map(s => s.hero), level: c.set.map(s => s.level), split: sp, r, score: score(r) };
      results.push(entry);
      const arch = archetype(sp.pct);
      if (!bestByArch[arch] || entry.score > bestByArch[arch].score) bestByArch[arch] = entry;
      done++;
    }
    if (results.length > topN * 20) { results.sort((x, y) => y.score - x.score); results.length = topN * 4; }
    await tick();
  }
  results.sort((x, y) => y.score - x.score);
  onProgress?.(1);
  return { total: done, results: results.slice(0, topN), bestByArch, sets: sets.length, combos: combos.length, finalists: finalists.length, splits: splits.length };
}

export const ARCHETYPES = ['Infantry-heavy', 'Cavalry-heavy', 'Archer-heavy', 'Balanced'];
export function archetype(pct) {
  if (pct.inf >= 50) return 'Infantry-heavy';
  if (pct.cav >= 50) return 'Cavalry-heavy';
  if (pct.arc >= 50) return 'Archer-heavy';
  return 'Balanced';
}

// Smallest rally capacity (same split %, same skills) that wins in expected mode.
export function minCapacityToWin(attackerSide, heroes, pct, defenderPrepared, opts, hi) {
  const make = cap => {
    const n = {};
    for (const t of TYPES) n[t] = Math.round(cap * pct[t] / 100);
    return { ...prepareSide(attackerSide, heroes, { inf: 0, cav: 0, arc: 0 }), troops: n };
  };
  const wins = cap => simulate(make(cap), defenderPrepared, opts).winner === 'attacker';
  if (!wins(hi)) return null;
  let lo = 100;
  if (wins(lo)) return lo;
  while (hi - lo > Math.max(100, hi * 0.002)) {
    const mid = Math.floor((lo + hi) / 2);
    if (wins(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

export function winRate(attackerSide, heroes, troops, defenderPrepared, opts, runs = 300) {
  const A = { ...prepareSide(attackerSide, heroes, { inf: 0, cav: 0, arc: 0 }), troops };
  return monteCarlo(A, defenderPrepared, runs, opts);
}
