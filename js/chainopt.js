// Rally-chain optimizer: pick joiners + troop split for every wave of a double / successive
// rally so the chain breaks the garrison with the fewest own losses (or, if it can't, leaves
// the least garrison standing).
//
// Each wave keeps its own leader account (stats, tiers, leader trio, capacity) from its
// template; the optimizer chooses the counted joiners and the troop split.
//
// Method: beam search.
//  1. Screen every distinct joiner set once per wave template against the full garrison and keep
//     the best `topCombos` (joiner value barely depends on how many troops are left).
//  2. Wave by wave, expand every beam state with (combo × split), simulate against what that
//     state left, and keep the best `beam` states.
//  shared = true (double rally): a player can only be in one wave, so joiner counts from the
//  pool are used up across waves. shared = false (successive): everyone can rejoin each wave.
import { TYPES } from './db.js';
import { prepareSide, simulate } from './engine.js';
import { joinerSets, troopSplits, screenScore } from './solver.js';
import { feasibleSplit } from './army.js';

const total = n => n.inf + n.cav + n.arc;
const sigOf = base => JSON.stringify(Object.entries(base.skills.fixed).filter(([, v]) => v).sort()) + JSON.stringify(base.skills.chance.map(c => [c.p, c.ops]).sort());

// Lower is better while the chain is still running.
const midScore = s => total(s.d) === 0 ? -1e12 + s.lostA : total(s.d) + 0.3 * s.lostA;
// Final ranking: broken chains first (fewest own losses), then least garrison left.
export const finalScore = s => total(s.d) === 0 ? 1e12 - s.lostA : -total(s.d) * 10 - s.lostA;

export async function optimizeChain({
  defender, templates, heroes, pool, shared = true, step = 20, opts = {},
  beam = 6, perState = 4, topCombos = 24, onProgress,
}) {
  const D0 = prepareSide(defender, heroes);
  const sets = joinerSets(pool, heroes);
  if (!sets.length) sets.push([]);

  // ---- 1. per-template combo screening (cached for identical templates) ----
  const cache = new Map();
  let lastYield = performance.now();
  const tick = async (p) => {
    if (performance.now() - lastYield > 40) { onProgress?.(p); await new Promise(r => setTimeout(r, 0)); lastYield = performance.now(); }
  };
  const W = [];
  for (let wi = 0; wi < templates.length; wi++) {
    const T = templates[wi];
    // T.rows (optional): per-player availability; drop splits the players can't actually send.
    const splits = troopSplits(T.capacity, step, T.limits).filter(sp => !T.rows || feasibleSplit(sp.n, T.rows));
    const key = JSON.stringify([T.side, T.capacity, T.limits, T.rows]);
    if (!cache.has(key)) {
      const probe = splits.reduce((b, sp) => {
        const d = Math.abs(sp.pct.inf - 40) + Math.abs(sp.pct.cav - 30) + Math.abs(sp.pct.arc - 30);
        return d < b.d ? { d, sp } : b;
      }, { d: Infinity }).sp;
      const seen = new Set();
      const combos = [];
      for (const set of sets) {
        const base = prepareSide({ ...T.side, joiners: set.map(s => ({ hero: s.hero, level: s.level, troops: {} })) }, heroes, { inf: 0, cav: 0, arc: 0 });
        const sig = sigOf(base);
        if (seen.has(sig)) continue;
        seen.add(sig);
        combos.push({ set, base, s1: probe ? screenScore(simulate({ ...base, troops: probe.n }, D0, opts)) : 0 });
        await tick(0.3 * (wi + combos.length / sets.length) / templates.length);
      }
      combos.sort((a, b) => b.s1 - a.s1);
      cache.set(key, combos);
    }
    // Keep extra candidates when players are used up across waves, so later waves have options.
    W.push({ T, splits, combos: cache.get(key).slice(0, shared ? topCombos * 3 : topCombos) });
  }

  // ---- 2. beam search over waves ----
  let states = [{ d: { ...D0.troops }, used: {}, lostA: 0, plan: [] }];
  for (let wi = 0; wi < W.length; wi++) {
    const { T, splits, combos } = W[wi];
    const next = [];
    for (let si = 0; si < states.length; si++) {
      const st = states[si];
      if (total(st.d) === 0) { next.push({ ...st, plan: [...st.plan, { name: T.name, skipped: true }] }); continue; }
      const cand = [];
      let tried = 0;
      for (const c of combos) {
        if (shared) {
          const need = {};
          for (const s of c.set) need[s.hero] = (need[s.hero] || 0) + 1;
          if (Object.entries(need).some(([h, n]) => (st.used[h] || 0) + n > (pool.find(p => p.hero === h)?.count || 0))) continue;
        }
        if (++tried > topCombos) break;
        for (const sp of splits) {
          const r = simulate({ ...c.base, troops: sp.n }, { ...D0, troops: st.d }, opts);
          const used = { ...st.used };
          if (shared) for (const s of c.set) used[s.hero] = (used[s.hero] || 0) + 1;
          cand.push({
            d: { ...r.remaining[1] }, used, lostA: st.lostA + r.lost[0],
            plan: [...st.plan, { name: T.name, side: T.side, joiners: c.set.map(s => s.hero), level: c.set.map(s => s.level), split: sp, r, defStart: { ...st.d } }],
          });
        }
        await tick(0.3 + 0.7 * (wi + (si + tried / topCombos) / states.length) / W.length);
      }
      cand.sort((a, b) => midScore(a) - midScore(b));
      next.push(...cand.slice(0, perState));
    }
    // Dedupe near-identical outcomes so the beam keeps genuinely different plans.
    next.sort((a, b) => midScore(a) - midScore(b));
    const seen = new Set();
    states = next.filter(s => {
      const k = `${Math.round(total(s.d) / 500)}|${Math.round(s.lostA / 500)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, beam);
  }
  onProgress?.(1);
  states.sort((a, b) => finalScore(b) - finalScore(a));
  return states.map(s => ({ ...s, broken: total(s.d) === 0, brokenAt: s.plan.findIndex(p => p.r && total(p.r.remaining[1]) === 0) }));
}
