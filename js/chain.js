// Successive / double rallies: each wave fights whatever the previous wave left behind.
//
// Model
//  - The defender keeps its stats, leader trio and joiner skills for every wave; only its troops
//    shrink. (Dead troops can't fight; a double rally lands before the defender can heal.)
//  - armyMin is fixed at the start of *each* fight, so a weakened garrison also lowers the
//    army factor of the next rally hitting it.
//  - Optional reinforcements arrive before a wave and are capped by the garrison capacity.
//  - A wave that arrives after the garrison is already empty takes no losses.
import { TYPES } from './db.js';
import { prepareSide, simulate } from './engine.js';

const total = n => n.inf + n.cav + n.arc;
const num = v => +v || 0;

export function prepareChain({ defender, waves, heroes }) {
  const D0 = prepareSide(defender, heroes);
  const cap = +defender.cap > 0 ? +defender.cap : Infinity;
  const W = waves.map(w => {
    const troops = { inf: num(w.troops?.inf), cav: num(w.troops?.cav), arc: num(w.troops?.arc) };
    const reinforce = { inf: num(w.reinforceTroops?.inf), cav: num(w.reinforceTroops?.cav), arc: num(w.reinforceTroops?.arc) };
    return { name: w.name, A: prepareSide(w.side, heroes, troops), reinforce };
  });
  return { D0, cap, W };
}

function addReinforcements(d, r, cap) {
  const want = total(r);
  if (!want) return { troops: d, added: 0 };
  const room = Math.max(0, cap - total(d));
  const f = want <= room ? 1 : room / want;
  const out = { ...d };
  let added = 0;
  for (const t of TYPES) { const a = Math.floor(r[t] * f); out[t] += a; added += a; }
  return { troops: out, added };
}

// One pass through the chain. mode: 'expected' | 'mc'.
export function runChain(prep, opts = {}) {
  const { D0, cap, W } = prep;
  let d = { ...D0.troops };
  const waves = [];
  let brokenAt = null;
  W.forEach((w, i) => {
    const rf = i > 0 ? addReinforcements(d, w.reinforce, cap) : { troops: d, added: 0 };
    d = rf.troops;
    const defStart = { ...d };
    const sent = { ...w.A.troops };
    if (total(d) === 0 || total(sent) === 0) {
      waves.push({ name: w.name, skipped: true, reason: total(d) === 0 ? 'garrison already empty' : 'no troops sent', sent, defStart, defLeft: { ...d }, reinforced: rf.added });
      return;
    }
    const r = simulate(w.A, { ...D0, troops: d }, opts);
    d = { ...r.remaining[1] };
    if (brokenAt == null && total(d) === 0) brokenAt = i;
    waves.push({ name: w.name, r, sent, defStart, defLeft: { ...d }, reinforced: rf.added, armyMin: Math.min(total(sent), total(defStart)) });
  });
  const lostA = waves.reduce((a, w) => a + (w.r ? w.r.lost[0] : 0), 0);
  const lostD = waves.reduce((a, w) => a + (w.r ? w.r.lost[1] : 0), 0);
  return { waves, final: d, brokenAt, lostA, lostD, defStartTotal: total(D0.troops) };
}

// Probability the garrison is broken by each wave (cumulative), over `runs` random chains.
export function chainMonteCarlo(prep, runs = 300, opts = {}) {
  const byWave = new Array(prep.W.length).fill(0);
  let lostA = 0, lostD = 0;
  for (let i = 0; i < runs; i++) {
    const c = runChain(prep, { ...opts, mode: 'mc' });
    if (c.brokenAt != null) for (let k = c.brokenAt; k < byWave.length; k++) byWave[k]++;
    lostA += c.lostA; lostD += c.lostD;
  }
  return { breakByWave: byWave.map(v => v / runs), avgLostA: lostA / runs, avgLostD: lostD / runs };
}

// Defender troops left after wave k (expected mode), for searching the next wave's rally.
export function remainingAfter(prep, k, opts = {}) {
  const c = runChain({ ...prep, W: prep.W.slice(0, k + 1) }, opts);
  return c.final;
}
