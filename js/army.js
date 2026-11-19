// Per-player troop availability for optimizing a rally.
//
// Every row (leader + each joiner) can carry an availability block:
//   avail: { max: {inf, cav, arc}, march, heroes: [first heroes this player can bring] }
// Missing values fall back to what the row currently sends, so an empty block means
// "exactly these troops" (the old behaviour).
import { TYPES } from './db.js';

const n0 = v => (v === '' || v == null || isNaN(+v)) ? null : Math.max(0, +v);
const sum = t => t.inf + t.cav + t.arc;

// Effective limits for one row: per-type max and march size.
export function rowAvail(troops = {}, avail = {}) {
  const sent = { inf: +troops.inf || 0, cav: +troops.cav || 0, arc: +troops.arc || 0 };
  const march = n0(avail.march);
  const max = {};
  for (const t of TYPES) {
    const m = n0(avail.max?.[t]);
    max[t] = m != null ? m : (march != null ? march : sent[t]);
  }
  const cap = march != null ? march : sum(sent);
  return { max, march: Math.min(cap, sum(max)) };
}

// Rows of a side in join order: leader first, then joiners.
export function sideRows(side) {
  return [
    { label: 'Leader', troops: side.leaderTroops, ...rowAvail(side.leaderTroops, side.leaderAvail) },
    ...(side.joiners || []).map((j, i) => ({ label: j.player || `Joiner ${i + 1}`, troops: j.troops, ...rowAvail(j.troops, j.avail) })),
  ];
}

// Rally size and per-type limits implied by the rows (and the rally cap).
export function armyLimits(side) {
  const rows = sideRows(side);
  const limits = { inf: 0, cav: 0, arc: 0 };
  for (const r of rows) for (const t of TYPES) limits[t] += Math.min(r.max[t], r.march);
  const marchTotal = rows.reduce((a, r) => a + r.march, 0);
  const cap = +side.cap > 0 ? +side.cap : Infinity;
  return { rows, limits, capacity: Math.min(cap, marchTotal, sum(limits)), cap };
}

// Can split n be sent by these rows? (Gale / Hall condition for a supply-demand network:
// for every set S of troop types, demand(S) ≤ Σ_rows min(march, Σ_{t∈S} max_t).)
const SUBSETS = [['inf'], ['cav'], ['arc'], ['inf', 'cav'], ['inf', 'arc'], ['cav', 'arc'], ['inf', 'cav', 'arc']];
export function feasibleSplit(n, rows) {
  for (const S of SUBSETS) {
    const need = S.reduce((a, t) => a + (n[t] || 0), 0);
    const have = rows.reduce((a, r) => a + Math.min(r.march, S.reduce((b, t) => b + r.max[t], 0)), 0);
    if (need > have) return false;
  }
  return true;
}

// Assign split n to rows (max-flow: types → rows, capped by max per type and march).
// Returns per-row troops, or null if infeasible.
export function allocate(n, rows) {
  const R = rows.length;
  // nodes: 0 source, 1..3 types, 4..3+R rows, 4+R sink
  const N = 5 + R, S = 0, T = 4 + R;
  const cap = Array.from({ length: N }, () => new Float64Array(N));
  TYPES.forEach((t, k) => {
    cap[S][1 + k] = n[t] || 0;
    rows.forEach((r, i) => { cap[1 + k][4 + i] = r.max[t]; });
  });
  rows.forEach((r, i) => { cap[4 + i][T] = r.march; });
  const flow = Array.from({ length: N }, () => new Float64Array(N));
  let total = 0;
  for (;;) {
    const prev = new Int32Array(N).fill(-1); prev[S] = S;
    const q = [S];
    while (q.length && prev[T] < 0) {
      const u = q.shift();
      for (let v = 0; v < N; v++) if (prev[v] < 0 && cap[u][v] - flow[u][v] > 0) { prev[v] = u; q.push(v); }
    }
    if (prev[T] < 0) break;
    let f = Infinity;
    for (let v = T; v !== S; v = prev[v]) f = Math.min(f, cap[prev[v]][v] - flow[prev[v]][v]);
    for (let v = T; v !== S; v = prev[v]) { flow[prev[v]][v] += f; flow[v][prev[v]] -= f; }
    total += f;
  }
  if (total < sum(n) - 1e-6) return null;
  return rows.map((r, i) => {
    const o = {};
    TYPES.forEach((t, k) => { o[t] = Math.round(flow[1 + k][4 + i]); });
    return o;
  });
}

// Heroes each joiner can bring (falls back to the hero currently picked).
export const ownedHeroes = j => (j.avail?.heroes?.length ? j.avail.heroes : (j.hero ? [j.hero] : []));

// Joiner pool from the roster: hero → number of joiners owning it, best owner's skill level.
export function rosterPool(joiners) {
  const pool = {};
  for (const j of joiners || []) for (const h of ownedHeroes(j)) {
    pool[h] ??= { hero: h, count: 0, level: 0 };
    pool[h].count++;
    pool[h].level = Math.max(pool[h].level, +j.level || 5);
  }
  return Object.values(pool);
}

// Give each hero of the set to a distinct joiner who owns it (bipartite matching).
// Returns joiner index per set slot, or null if impossible.
export function matchHeroes(set, joiners) {
  const owners = set.map(h => joiners.map((j, i) => ownedHeroes(j).includes(h) ? i : -1).filter(i => i >= 0));
  const takenBy = new Array(joiners.length).fill(-1);
  const tryAssign = (s, seen) => {
    for (const i of owners[s]) {
      if (seen[i]) continue;
      seen[i] = true;
      if (takenBy[i] < 0 || tryAssign(takenBy[i], seen)) { takenBy[i] = s; return true; }
    }
    return false;
  };
  for (let s = 0; s < set.length; s++) if (!tryAssign(s, new Array(joiners.length).fill(false))) return null;
  const out = new Array(set.length);
  takenBy.forEach((s, i) => { if (s >= 0) out[s] = i; });
  return out;
}

// Ratio + march ↔ counts.
export const ratioToTroops = (ratio = {}, march = 0) => {
  const m = +march || 0;
  const r = { inf: +ratio.inf || 0, cav: +ratio.cav || 0, arc: +ratio.arc || 0 };
  const tot = sum(r) || 1;
  const o = { inf: Math.round(m * r.inf / tot), cav: Math.round(m * r.cav / tot), arc: 0 };
  o.arc = Math.max(0, m - o.inf - o.cav);
  if (!sum(r)) return { inf: 0, cav: 0, arc: 0 };
  return o;
};
export const troopsToRatio = (troops = {}) => {
  const t = { inf: +troops.inf || 0, cav: +troops.cav || 0, arc: +troops.arc || 0 };
  const s = sum(t);
  if (!s) return { ratio: { inf: '', cav: '', arc: '' }, march: '' };
  return { ratio: { inf: +(t.inf / s * 100).toFixed(1), cav: +(t.cav / s * 100).toFixed(1), arc: +(t.arc / s * 100).toFixed(1) }, march: s };
};
