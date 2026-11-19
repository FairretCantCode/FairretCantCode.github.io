// Kingshot rally combat engine, following kingshotsim.com/damage-formula:
//   damage = army_factor × att_per_troop_attacker / def_per_troop_target
//            × type_bonus × SkillMod × fatigue_factor / 100
//   deaths = ceil(damage)
import {
  TYPES, TROOP_TIERS, BASE_LET, BASE_DEF, COUNTERS, TYPE_BONUS, TARGET_ORDER,
  CAV_BYPASS_CHANCE, ARC_VOLLEY_CHANCE, FATIGUE_PER_ROUND, OPS, FAMILIES,
  MAX_SKILL_LEVEL, MAX_COUNTED_JOINERS, TERRITORY_BONUS, LEADER_PRESETS,
} from './db.js';
import { HERO_STATS, getHero } from './heroes-data.js';

// ---------- per-troop stats ----------
export function attPerTroop(baseAtk, atkPct, letPct) {
  return baseAtk * (1 + atkPct / 100) * BASE_LET * (1 + letPct / 100) / 100;
}
export function defPerTroop(baseHp, defPct, hpPct) {
  return BASE_DEF * (1 + defPct / 100) * baseHp * (1 + hpPct / 100) / 100;
}

// Territory garrison: B = A × (1 + S) + S on Attack and Defense.
export function territory(pct, S = TERRITORY_BONUS) {
  return pct * (1 + S / 100) + S;
}

// Leader hero names per slot (a kingshotsim preset brings its own trio).
export function leaderHeroes(side) {
  const preset = LEADER_PRESETS[side.leaderPreset];
  if (preset && preset.slots) return { ...preset.slots };
  return { inf: side.leaders?.inf?.hero || '', cav: side.leaders?.cav?.hero || '', arc: side.leaders?.arc?.hero || '' };
}

// Hero contribution to the visible stat bonuses of the leader's own troop class:
//   Expedition Attack/Defense % (hero stars) + exclusive gear Lethality/Health % + hero gear.
// Values come from side.heroOver[hero] (user edits) falling back to HERO_STATS (max star / max level).
// Hero gear (side.heroGear[slot]) belongs to the slot, so it stays when the hero is swapped.
export function heroContribution(side, t, heroName = leaderHeroes(side)[t]) {
  const c = { atk: 0, def: 0, let: 0, hp: 0 };
  const g = side.heroGear?.[t] || {};
  for (const k of ['atk', 'def', 'let', 'hp']) c[k] += +g[k] || 0;
  if (!heroName) return c;
  const d = HERO_STATS[heroName] || { exp: 0, excl: { let: 0, hp: 0 } };
  const o = side.heroOver?.[heroName] || {};
  const exp = num(o.exp, d.exp);
  c.atk += exp; c.def += exp;
  c.let += num(o.exclLet, d.excl.let);
  c.hp += num(o.exclHp, d.excl.hp);
  return c;
}
const num = (v, dflt) => (v === '' || v == null || isNaN(+v)) ? dflt : +v;

// Account-wide passives (owned hero, even when not deployed): Helga +2%/star Atk & Def,
// Amadeus +3%/star Lethality & Health, all troop types.
export function passiveContribution(side) {
  const h = +side.passives?.helga || 0, a = +side.passives?.amadeus || 0;
  return { atk: 2 * h, def: 2 * h, let: 3 * a, hp: 3 * a };
}

// The stat bonuses that actually fight.
//   statMode 'report': side.stats are battle-report totals (heroes, gear, passives already inside).
//   statMode 'build':  side.stats are account bonuses without heroes; hero + passive parts are added.
export function effectiveStats(side) {
  const out = {};
  const build = side.statMode === 'build';
  const lead = leaderHeroes(side);
  const pas = build ? passiveContribution(side) : null;
  for (const t of TYPES) {
    const s = side.stats[t];
    const r = { atk: +s.atk || 0, def: +s.def || 0, let: +s.let || 0, hp: +s.hp || 0 };
    if (build) {
      const h = heroContribution(side, t, lead[t]);
      for (const k in r) r[k] += h[k] + pas[k];
    }
    out[t] = r;
  }
  return out;
}

export function perTroopStats(side) {
  const out = {};
  const eff = effectiveStats(side);
  for (const t of TYPES) {
    const base = TROOP_TIERS[side.tiers[t]][t];
    const s = eff[t];
    let atk = s.atk, def = s.def;
    if (side.territory) { atk = territory(atk); def = territory(def); }
    out[t] = {
      att: attPerTroop(base.atk, atk, s.let),
      def: defPerTroop(base.hp, def, s.hp),
    };
  }
  return out;
}

// ---------- joiners & SkillMod ----------
// Pick the 4 counted joiners: highest skill level, ties by join order (list order).
export function countedJoiners(joiners) {
  return joiners
    .map((j, i) => ({ ...j, _i: i }))
    .filter(j => j.hero && (+j.level || 0) > 0)
    .sort((a, b) => (b.level - a.level) || (a._i - b._i))
    .slice(0, MAX_COUNTED_JOINERS);
}

const chanceAt = (c, i) => c == null ? null : Array.isArray(c) ? c[i] / 100 : c;

// Add one skill at a level into fixed sums or the chance list.
function addSkill(sk, level, fixed, chance, tag) {
  if (!sk || sk.q === 'none' || !sk.ops?.length || !(level > 0)) return;
  const i = Math.min(level, MAX_SKILL_LEVEL) - 1;
  const ops = sk.ops.map(([k, lv]) => [String(k), lv[i]]);
  const p = chanceAt(sk.chance, i);
  if (p == null) for (const [k, v] of ops) fixed[k] = (fixed[k] || 0) + v;
  else chance.push({ p, ops, tag });
}

// Turns a side into { fixed: {opKey: sum}, chance: [{p, ops:[[opKey,v]]}] }.
// opKey is "102" (all squads) or "102@arc" (archers only).
// Leaders: legendary = all 3 expedition skills, epic = first skill only.
// Joiners: top 4 by first-skill level; duplicate chance skills only roll once.
export function buildSkills(side, heroes) {
  const fixed = {};
  const chance = [];
  const preset = LEADER_PRESETS[side.leaderPreset] || LEADER_PRESETS.none;
  for (const [op, v] of Object.entries(preset.ops)) fixed[op] = (fixed[op] || 0) + v;
  for (const [op, v] of Object.entries(side.leaderOps || {})) if (+v) fixed[op] = (fixed[op] || 0) + +v;

  // A kingshotsim full-kit preset replaces the individual leader heroes.
  const usePreset = preset !== LEADER_PRESETS.none;
  for (const t of usePreset ? [] : TYPES) {
    const L = side.leaders?.[t];
    const h = L && getHero(heroes, L.hero);   // unknown name → no-op placeholder
    if (!h) continue;
    const n = h.rarity === 'legendary' ? h.skills.length : 1;
    for (let k = 0; k < n; k++) addSkill(h.skills[k], +(L.lv?.[k] ?? MAX_SKILL_LEVEL), fixed, chance, `${L.hero} ${k + 1}`);
  }

  const seenChance = new Set();
  const counted = countedJoiners(side.joiners || []);
  for (const j of counted) {
    const h = getHero(heroes, j.hero);   // rare / unknown hero: takes the slot, adds nothing
    const sk = h?.skills?.[0];
    if (!sk) continue;
    if (sk.chance != null) {
      if (seenChance.has(j.hero)) continue;
      seenChance.add(j.hero);
    }
    addSkill(sk, +j.level, fixed, chance, j.hero);
  }
  return { fixed, chance, counted };
}

export function expectedOps(skills) {
  const o = { ...skills.fixed };
  for (const c of skills.chance) for (const [op, v] of c.ops) o[op] = (o[op] || 0) + v * c.p;
  return o;
}

// Family multipliers for one squad type (type = null: only all-squad effects).
// Same op code sums additively (including type-scoped entries), different ops multiply.
export function familyValues(ops, type = null) {
  const byOp = {};
  for (const [key, v] of Object.entries(ops)) {
    if (!v) continue;
    const [op, only] = key.split('@');
    if (only && only !== type) continue;
    byOp[op] = (byOp[op] || 0) + v;
  }
  const f = { DamageUp: 1, OppDefenseDown: 1, OppDamageDown: 1, DefenseUp: 1 };
  for (const [op, v] of Object.entries(byOp)) if (OPS[op]) f[OPS[op].family] *= 1 + v / 100;
  return f;
}
export const typeFamilies = (ops) => ({ inf: familyValues(ops, 'inf'), cav: familyValues(ops, 'cav'), arc: familyValues(ops, 'arc') });
export const offense = f => f.DamageUp * f.OppDefenseDown;
export const defense = f => f.OppDamageDown * f.DefenseUp;

// SkillMod for `a` hitting `b`.
export function skillMod(fa, fb) {
  return offense(fa) / defense(fb);
}

// ---------- the round formula ----------
export function roundDamage({ squad, armyMin, att, def, counter, skill, fatigue }) {
  const armyFactor = Math.sqrt(squad * armyMin);
  return armyFactor * att / def * (counter ? TYPE_BONUS : 1) * skill * fatigue / 100;
}

const total = n => n.inf + n.cav + n.arc;

// Troops that actually march. The leader fills first, then joiners in join order until the
// rally / garrison capacity (side.cap) is full; later marches are cut off (partially for the
// joiner that hits the cap). Returns totals and the per-row accepted counts.
export function marchTroops(side) {
  const cap = +side.cap > 0 ? +side.cap : Infinity;
  const rows = [{ ...side.leaderTroops }, ...(side.joiners || []).map(j => ({ ...j.troops }))];
  const n = { inf: 0, cav: 0, arc: 0 };
  let room = cap, offered = 0;
  const accepted = rows.map(r => {
    const want = { inf: +r.inf || 0, cav: +r.cav || 0, arc: +r.arc || 0 };
    const w = want.inf + want.cav + want.arc;
    offered += w;
    const f = w <= room ? 1 : Math.max(0, room) / w;
    const got = { inf: Math.floor(want.inf * f), cav: Math.floor(want.cav * f), arc: Math.floor(want.arc * f) };
    room -= got.inf + got.cav + got.arc;
    for (const t of TYPES) n[t] += got[t];
    return got;
  });
  return { n, accepted, offered, cap, rejected: offered - (n.inf + n.cav + n.arc) };
}
export function sideTroops(side) { return marchTroops(side).n; }

export function armyFactors(A, D) {
  const total = x => x.inf + x.cav + x.arc;
  const armyMin = Math.min(total(A), total(D));
  const f = n => ({ inf: Math.sqrt(n.inf * armyMin), cav: Math.sqrt(n.cav * armyMin), arc: Math.sqrt(n.arc * armyMin) });
  return { armyMin, att: f(A), def: f(D) };
}

// Prepare a side for simulation (cache stats and skills).
export function prepareSide(side, heroes, troopsOverride) {
  const skills = buildSkills(side, heroes);
  const ops = expectedOps(skills);
  return {
    troops: troopsOverride || sideTroops(side),
    pt: perTroopStats(side),
    skills,
    expFam: familyValues(ops),
    expTypeFam: typeFamilies(ops),
  };
}

// Simulate a full fight. mode: 'expected' (deterministic averages) or 'mc' (random rolls).
export function simulate(A, D, { mode = 'expected', fatigue = false, maxRounds = 2000, rng = Math.random, log = false } = {}) {
  const n = [{ ...A.troops }, { ...D.troops }];
  const start = [{ ...A.troops }, { ...D.troops }];
  const P = [A, D];
  const armyMin = Math.min(total(n[0]), total(n[1]));
  const history = [];
  let round = 0;

  const famFor = (side) => {
    if (mode === 'expected') return side.expTypeFam;
    const o = { ...side.skills.fixed };
    for (const c of side.skills.chance) if (rng() < c.p) for (const [op, v] of c.ops) o[op] = (o[op] || 0) + v;
    return typeFamilies(o);
  };

  while (total(n[0]) > 0 && total(n[1]) > 0 && round < maxRounds) {
    const fat = fatigue ? 1 - round * FATIGUE_PER_ROUND : 1;
    const fam = [famFor(A), famFor(D)];
    const off = fam.map(f => ({ inf: offense(f.inf), cav: offense(f.cav), arc: offense(f.arc) }));
    const dfn = fam.map(f => ({ inf: defense(f.inf), cav: defense(f.cav), arc: defense(f.arc) }));
    const deaths = [{ inf: 0, cav: 0, arc: 0 }, { inf: 0, cav: 0, arc: 0 }];
    const rlog = log ? { round, hits: [] } : null;

    for (let s = 0; s < 2; s++) {
      const e = 1 - s;
      const front = TARGET_ORDER.find(t => n[e][t] > 0);
      for (const t of TYPES) {
        const squad = n[s][t];
        if (squad <= 0) continue;
        const hit = (tt, frac, mult) => {
          const d = roundDamage({
            squad, armyMin, att: P[s].pt[t].att, def: P[e].pt[tt].def,
            counter: COUNTERS[t] === tt, skill: off[s][t] / dfn[e][tt], fatigue: fat,
          }) * frac * mult;
          const k = Math.ceil(d);
          deaths[e][tt] += k;
          if (rlog) rlog.hits.push({ side: s, from: t, to: tt, dmg: d, deaths: k, sm: off[s][t] / dfn[e][tt] });
        };
        let mult = 1;
        if (t === 'arc') mult = mode === 'expected' ? 1 + ARC_VOLLEY_CHANCE : (rng() < ARC_VOLLEY_CHANCE ? 2 : 1);
        if (t === 'cav' && front !== 'arc' && n[e].arc > 0) {
          if (mode === 'expected') { hit(front, 1 - CAV_BYPASS_CHANCE, mult); hit('arc', CAV_BYPASS_CHANCE, mult); }
          else hit(rng() < CAV_BYPASS_CHANCE ? 'arc' : front, 1, mult);
        } else hit(front, 1, mult);
      }
    }
    for (let s = 0; s < 2; s++) for (const t of TYPES) n[s][t] = Math.max(0, n[s][t] - deaths[s][t]);
    if (rlog) { rlog.after = [{ ...n[0] }, { ...n[1] }]; history.push(rlog); }
    round++;
  }

  const ta = total(n[0]), td = total(n[1]);
  const winner = ta > 0 && td === 0 ? 'attacker' : td > 0 && ta === 0 ? 'defender' : (ta === 0 && td === 0 ? 'draw' : 'timeout');
  const lost = [total(start[0]) - ta, total(start[1]) - td];
  return {
    winner, rounds: round, remaining: [{ ...n[0] }, { ...n[1] }], start, lost,
    trade: lost[0] > 0 ? lost[1] / lost[0] : Infinity,
    skillMod: [skillMod(A.expFam, D.expFam), skillMod(D.expFam, A.expFam)],
    history,
  };
}

export function monteCarlo(A, D, runs = 300, opts = {}) {
  let wins = 0, lostA = 0, lostD = 0;
  for (let i = 0; i < runs; i++) {
    const r = simulate(A, D, { ...opts, mode: 'mc' });
    if (r.winner === 'attacker') wins++;
    lostA += r.lost[0]; lostD += r.lost[1];
  }
  return { winRate: wins / runs, avgLost: [lostA / runs, lostD / runs] };
}
