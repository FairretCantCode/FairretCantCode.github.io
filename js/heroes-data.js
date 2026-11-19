// Hero catalog: Expedition skills mapped to SkillMod op codes.
//
// Sources
//  - Roster, class, rarity, generation, per-level skill values (levels 1-5):
//    KingshotPro data API + hero pages (kingshotpro.com, CC-BY-4.0). Raw copies in data/kingshotpro/.
//  - Op-code taxonomy and joiner values: kingshotsim.com/skillmod (engine-tested). Where the two
//    disagree on a joiner's first skill, kingshotsim's values win.
//  - The op-code mapping below is hand-curated from each skill's text.
//
// Skill format
//  ops:    [[opKey, [lv1..lv5]], ...]   opKey "102" = all squads, "102@arc" = archers only
//  chance: null (always on) | number | [lv1..lv5]   (probability the effect is active in a round)
//  q:      'ok'      matches the source description directly
//          'approx'  timed / every-N-turns / extra-hit effects folded into an expected chance
//          'none'    not modelled (non-combat, or no numeric value published)
//  First skill in the list = the joiner skill. Epic leaders only use the first skill.

const lin = (max) => [1, 2, 3, 4, 5].map(i => +(max * i / 5).toFixed(2));
const S = (name, ops, chance = null, q = 'ok', note = '') => ({ name, ops, chance, q, note });
const NONE = (name, note = 'non-combat') => S(name, [], null, 'none', note);
const PROC8 = [8, 16, 24, 32, 40];

export const HERO_DB = {
  // ---------------- Gen 1 ----------------
  Amadeus: { cls: 'inf', rarity: 'legendary', gen: 1, skills: [
    S('Battle Ready', [['101', lin(25)]]),
    S('Way of the Blade', [['102', lin(25)]]),
    S('Unrighteous Strike', [['102', [50, 50, 50, 50, 50]]], PROC8, 'ok', 'chance to +50% damage dealt'),
  ] },
  Jabel: { cls: 'cav', rarity: 'legendary', gen: 1, skills: [
    S('Rally Flag', [['111', [50, 50, 50, 50, 50]]], PROC8, 'ok', 'chance to −50% damage taken'),
    S("Hero's Domain", [['102', lin(50)]], 0.5),
    S('Youthful Rage', [['101', lin(25)]]),
  ] },
  Helga: { cls: 'inf', rarity: 'legendary', gen: 1, skills: [
    S('Oath of Guardian', [['111', [50, 50, 50, 50, 50]]], PROC8),
    S('Echoes of Valhalla', [['102', lin(25)]]),
    S("Nature's Balance", [['101', lin(25)]]),
  ] },
  Saul: { cls: 'arc', rarity: 'legendary', gen: 1, skills: [
    S('Taskforce Training', [['112', lin(10)], ['113', lin(15)]], null, 'ok', 'values from kingshotsim'),
    NONE('Resourceful', 'construction only'),
    S('Positional Batter', [['101', lin(25)]]),
  ] },
  // ---------------- Gen 2 ----------------
  Zoe: { cls: 'inf', rarity: 'legendary', gen: 2, skills: [
    S('Sundering Wound', [['103', lin(40)]], 0.2, 'approx', '20% chance to apply a 3-turn DoT'),
    S('Stoic', [['102', lin(25)]]),
    S('Infinite Arsenal', [['211', lin(50)]], 0.5),
  ] },
  Hilde: { cls: 'cav', rarity: 'legendary', gen: 2, skills: [
    S('Noble Path', [['102', lin(15)], ['112', lin(10)]], null, 'ok', 'values from kingshotsim'),
    S('Elixir of Strength', [['103', lin(100)]], 0.25, 'approx', '25% chance to deal 120–200% damage'),
    S('Trial by Fire', [['111', [50, 50, 50, 50, 50]]], PROC8),
  ] },
  Marlin: { cls: 'arc', rarity: 'legendary', gen: 2, skills: [
    S('Wild Card', [['102', [50, 50, 50, 50, 50]]], PROC8),
    S('Rumhead', [['203', lin(50)]], 0.2, 'approx', 'enemy Lethality down for 2 turns'),
    S('Dynamo', [['102', lin(50)]], 0.5),
  ] },
  // ---------------- Gen 3 ----------------
  Petra: { cls: 'cav', rarity: 'legendary', gen: 3, skills: [
    S('Evil Eye', [['211', lin(50)]], 0.5),
    S('The Favor', [['102', lin(50)]], 0.5),
    S('The Shield', [['111', lin(50)]], 0.4),
  ] },
  Eric: { cls: 'inf', rarity: 'legendary', gen: 3, skills: [
    S('Holy Warrior', [['202', lin(20)]]),
    S('Conviction', [['111', lin(20)]]),
    S('Exhortation', [['113', lin(25)]]),
  ] },
  Jaeger: { cls: 'arc', rarity: 'legendary', gen: 3, skills: [
    S('The Tempest', [['102', [40, 40, 40, 40, 40]]], PROC8, 'approx', 'buff lasts 3 turns'),
    S('The Resistance', [['203', lin(50)]], 0.2, 'approx', 'enemy Lethality down for 2 turns'),
    S('The Celebration', [['113', lin(25)]]),
  ] },
  // ---------------- Gen 4 ----------------
  Rosa: { cls: 'arc', rarity: 'legendary', gen: 4, skills: [
    S('Chaos Gambit', [['102', lin(50)]], 0.4),
    S('Rose of War', [['201', lin(20)]]),
    S('Golden Rhythm', [['102@arc', lin(30)]]),
  ] },
  Alcar: { cls: 'inf', rarity: 'legendary', gen: 4, skills: [
    S('Rescuing Hands', [['111@inf', lin(70)], ['111@arc', lin(70)]], 0.4, 'approx', 'active 2 of every 5 turns'),
    NONE('Praetorian Will', 'no numeric value published'),
    NONE('Carpe Diem', 'no numeric value published'),
  ] },
  Margot: { cls: 'cav', rarity: 'legendary', gen: 4, skills: [
    S('Warbringer', [['102', lin(25)]]),
    S('Subterfuge', [['111', lin(20)]], null, 'approx', 'dodge normal attacks ≈ damage taken down'),
    S('Sleight Hand', [['103@cav', [120, 140, 160, 180, 200]]], 0.25, 'approx', 'cavalry 25% extra attack'),
  ] },
  // ---------------- Gen 5 ----------------
  Vivian: { cls: 'arc', rarity: 'legendary', gen: 5, skills: [
    S('Crouching Tiger', [['211', lin(25)]]),
    S('Focus Fire', [['103', [100, 100, 100, 100, 100]]], 0.25, 'approx', 'every 4th attack +100%'),
    S('Trap of Greed', [['103', lin(60)]], 0.25, 'approx', 'every 4th attack'),
  ] },
  Thrud: { cls: 'cav', rarity: 'legendary', gen: 5, skills: [
    NONE('Battle Hunger', 'no numeric value published'),
    S('Reckless Charge', [['103@cav', lin(100)]], 0.2, 'approx'),
    NONE('Ancestral Guidance', 'no numeric value published'),
  ] },
  'Long Fei': { cls: 'inf', rarity: 'legendary', gen: 5, skills: [
    S('Mighty Paragon', [['111', [50, 50, 50, 50, 50]]], [10, 20, 30, 40, 50]),
    S('Celestial Sustenance', [['112', lin(25)]]),
    S('Art of War', [['103', lin(100)]], 0.25, 'approx', '25% chance to deal 120–200% damage'),
  ] },
  // ---------------- Gen 6 ----------------
  Yang: { cls: 'arc', rarity: 'legendary', gen: 6, skills: [
    S('Avalanche', [['103', lin(100)]], 0.25, 'approx', 'extra strike every 4 turns'),
    S('Ice Zone', [['103@arc', lin(100)]], 0.4, 'approx'),
    NONE('Ambush', 'pity-timer proc, damage value not published'),
  ] },
  Sophia: { cls: 'cav', rarity: 'legendary', gen: 6, skills: [
    S('Arcane Pact', [['111', [50, 50, 50, 50, 50]]], PROC8),
    NONE('Terror - Deathblow', 'Terror proc rate not published'),
    NONE('Terror - Annihilation', 'Terror proc rate not published'),
  ] },
  Triton: { cls: 'inf', rarity: 'legendary', gen: 6, skills: [
    S('Command of Power', [['112', lin(25)]]),
    S('Warfare of Power', [['103', lin(30)]]),
    NONE('Oath of Power', 'no numeric value published'),
  ] },
  // ---------------- Epic (joiner pool) ----------------
  Chenko: { cls: 'cav', rarity: 'epic', gen: 1, skills: [S('Stand of Arms', [['101', lin(25)]]), S('Shield Wall', [['111', lin(20)]])] },
  Amane: { cls: 'arc', rarity: 'epic', gen: 1, skills: [S('Tri-Phalanx', [['102', lin(25)]]), NONE('Exorcism', 'infirmary only')] },
  Yeonwoo: { cls: 'arc', rarity: 'epic', gen: 1, skills: [S('On Guard', [['101', lin(25)]]), NONE('Well-Traveled', 'research only')] },
  Gordon: { cls: 'cav', rarity: 'epic', gen: 1, skills: [S('Super Nutrients', [['113', lin(25)]]), S('Trash Talk', [['102', lin(25)]])] },
  Howard: { cls: 'inf', rarity: 'epic', gen: 1, skills: [S("Defenders' Edge", [['111', lin(20)]]), S('Weaken', [['202', lin(20)]])] },
  Quinn: { cls: 'arc', rarity: 'epic', gen: 1, skills: [S('Sixth Sense', [['111', lin(20)]]), S('Precision Shot', [['102', lin(50)]], 0.5)] },
  Fahd: { cls: 'cav', rarity: 'epic', gen: 1, skills: [S('Desert Eclipse', [['201', lin(20)]]), NONE('Pathfinder', 'march speed only')] },
  Diana: { cls: 'arc', rarity: 'epic', gen: 1, skills: [NONE('Iron Constitution', 'stamina only'), NONE('Quick Paced', 'march speed only')] },
  // ---------------- Rare (gathering) — no combat skills: count as joiners but add nothing ----------------
  Edwin: { cls: 'cav', rarity: 'rare', gen: 0, skills: [NONE('Demolitions Expert', 'quarry output only'), NONE('Stone Mining', 'gathering only')] },
  Forrest: { cls: 'inf', rarity: 'rare', gen: 0, skills: [NONE('Woodland Inheritor', 'sawmill output only'), NONE('Master Woodcutter', 'gathering only')] },
  Olive: { cls: 'arc', rarity: 'rare', gen: 0, skills: [NONE('Green Thumb', 'mill output only'), NONE("Forager's Luck", 'gathering only')] },
  Seth: { cls: 'inf', rarity: 'rare', gen: 0, skills: [NONE('Burnished Iron', 'iron output only'), NONE('Craftsmanship', 'gathering only')] },
};

// Fail-safe: any hero that is missing from the catalog (typo, old save, new release) resolves to
// this placeholder. It still occupies a joiner/leader slot but has zero effect on damage.
export const NOOP_HERO = Object.freeze({ cls: null, rarity: 'rare', gen: 0, noop: true, skills: [NONE('No combat skill', 'unknown or non-combat hero: no effect')] });
export const getHero = (heroes, name) => (name ? heroes?.[name] || NOOP_HERO : null);
export const isNoop = (h) => !h || h.noop || !h.skills?.some(s => s.q !== 'none');

// One-line description of a skill at a level, e.g. "40% → +50% Attack".
export function describeSkill(sk, level = 5, opsMeta) {
  if (!sk || sk.q === 'none' || !sk.ops.length) return sk ? `${sk.name} (${sk.note || 'not modelled'})` : '';
  const i = Math.max(1, Math.min(5, level)) - 1;
  const ch = sk.chance == null ? null : Array.isArray(sk.chance) ? sk.chance[i] : sk.chance * 100;
  const eff = sk.ops.map(([k, lv]) => {
    const [op, only] = k.split('@');
    return `${lv[i]}% ${opsMeta?.[op]?.short || op}${only ? ' (' + only + ')' : ''}`;
  }).join(' · ');
  return `${ch != null ? fmtPct(ch) + ' → ' : ''}${eff}`;
}
const fmtPct = (v) => `${+(+v).toFixed(1)}%`;

// Max-star Expedition Attack/Defense % (leader's own troop class) and max-level exclusive gear
// Expedition Lethality/Health %. Source: KingshotPro hero pages (data/kingshotpro/hero_pages.json).
// Per-star values are not published, so these are max values and editable in the app.
export const HERO_STATS = {
  "Alcar": { exp: 370.29, excl: { let: 92.5, hp: 92.5 } },
  "Amadeus": { exp: 260.2, excl: { let: 62.5, hp: 62.5 } },
  "Amane": { exp: 140.11, excl: { let: 0, hp: 0 } },
  "Chenko": { exp: 140.11, excl: { let: 0, hp: 0 } },
  "Diana": { exp: 110.08, excl: { let: 0, hp: 0 } },
  "Edwin": { exp: 90.07, excl: { let: 0, hp: 0 } },
  "Eric": { exp: 290.23, excl: { let: 70.0, hp: 70.0 } },
  "Fahd": { exp: 140.11, excl: { let: 0, hp: 0 } },
  "Forrest": { exp: 90.07, excl: { let: 0, hp: 0 } },
  "Gordon": { exp: 140.11, excl: { let: 0, hp: 0 } },
  "Helga": { exp: 200.16, excl: { let: 55.5, hp: 55.5 } },
  "Hilde": { exp: 240.19, excl: { let: 60.0, hp: 60.0 } },
  "Howard": { exp: 140.11, excl: { let: 0, hp: 0 } },
  "Jabel": { exp: 200.16, excl: { let: 50.0, hp: 50.0 } },
  "Jaeger": { exp: 290.23, excl: { let: 70.0, hp: 70.0 } },
  "Long Fei": { exp: 444.35, excl: { let: 111.0, hp: 111.0 } },
  "Margot": { exp: 370.29, excl: { let: 92.5, hp: 92.5 } },
  "Marlin": { exp: 240.19, excl: { let: 60.0, hp: 60.0 } },
  "Olive": { exp: 90.07, excl: { let: 0, hp: 0 } },
  "Petra": { exp: 290.23, excl: { let: 70.0, hp: 70.0 } },
  "Quinn": { exp: 140.11, excl: { let: 0, hp: 0 } },
  "Rosa": { exp: 370.29, excl: { let: 92.5, hp: 92.5 } },
  "Saul": { exp: 200.16, excl: { let: 50.0, hp: 50.0 } },
  "Seth": { exp: 90.07, excl: { let: 0, hp: 0 } },
  "Sophia": { exp: 540.43, excl: { let: 133.5, hp: 133.5 } },
  "Thrud": { exp: 444.35, excl: { let: 111.0, hp: 111.0 } },
  "Triton": { exp: 540.43, excl: { let: 133.5, hp: 133.5 } },
  "Vivian": { exp: 444.35, excl: { let: 111.0, hp: 111.0 } },
  "Yang": { exp: 540.43, excl: { let: 133.5, hp: 133.5 } },
  "Yeonwoo": { exp: 140.11, excl: { let: 0, hp: 0 } },
  "Zoe": { exp: 240.19, excl: { let: 60.0, hp: 60.0 } },
};
