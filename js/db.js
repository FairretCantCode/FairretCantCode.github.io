// Game database, sourced from kingshotsim.com methodology pages
// (damage-formula, skillmod, stat-bonuses, rally-and-troops).
// Confidence grades from the source: C = confirmed, P = probable, S = speculative.

export const TYPES = ['inf', 'cav', 'arc'];
export const TYPE_NAMES = { inf: 'Infantry', cav: 'Cavalry', arc: 'Archer' };

// Base Lethality = base Defense = 10 for every tier and type (C).
export const BASE_LET = 10;
export const BASE_DEF = 10;

// Real engine base stats (not the training-panel placeholders). Only Attack and Health vary.
// Source: rally-and-troops "The real troop base stats" (P for T11).
export const TROOP_TIERS = {
  'T6':    { inf: { atk: 243, hp: 730 },  cav: { atk: 730,  hp: 243 }, arc: { atk: 974,  hp: 183 } },
  'T9':    { inf: { atk: 400, hp: 1200 }, cav: { atk: 1200, hp: 400 }, arc: { atk: 1600, hp: 300 } },
  'T10':   { inf: { atk: 472, hp: 1416 }, cav: { atk: 1416, hp: 472 }, arc: { atk: 1888, hp: 354 } },
  'T10.1': { inf: { atk: 491, hp: 1473 }, cav: { atk: 1473, hp: 491 }, arc: { atk: 1964, hp: 368 } },
  'T10.2': { inf: { atk: 515, hp: 1546 }, cav: { atk: 1546, hp: 515 }, arc: { atk: 2062, hp: 387 } },
  'T10.3': { inf: { atk: 541, hp: 1624 }, cav: { atk: 1624, hp: 541 }, arc: { atk: 2165, hp: 406 } },
  'T10.4': { inf: { atk: 568, hp: 1705 }, cav: { atk: 1705, hp: 568 }, arc: { atk: 2273, hp: 426 } },
  'T10.5': { inf: { atk: 597, hp: 1790 }, cav: { atk: 1790, hp: 597 }, arc: { atk: 2387, hp: 448 } },
  'T11':   { inf: { atk: 566, hp: 1699 }, cav: { atk: 1699, hp: 566 }, arc: { atk: 2266, hp: 390 } },
};
export const TIER_NAMES = Object.keys(TROOP_TIERS);

// Infantry > Cavalry > Archer > Infantry. +10% damage only, no defensive bonus (C).
export const COUNTERS = { inf: 'cav', cav: 'arc', arc: 'inf' };
export const TYPE_BONUS = 1.10;

// Targeting order: first available enemy line (C).
export const TARGET_ORDER = ['inf', 'cav', 'arc'];

export const CAV_BYPASS_CHANCE = 0.20;   // Ambusher: hit archers directly (community figure)
export const ARC_VOLLEY_CHANCE = 0.10;   // double attack (community figure)
export const FATIGUE_PER_ROUND = 0.0001; // S: from SoS engine, off by default

// SkillMod op codes (skillmod page). Same op = additive, different ops = multiplicative.
export const OPS = {
  101: { family: 'DamageUp',       label: 'Lethality % (own)',            short: 'Lethality' },
  102: { family: 'DamageUp',       label: 'Attack % / Damage Up (own)',   short: 'Attack/Dmg' },
  103: { family: 'DamageUp',       label: 'Skill / extra damage % (own)', short: 'Skill dmg' },
  111: { family: 'DefenseUp',      label: 'Damage Taken Down (own)',      short: 'Dmg taken ↓' },
  112: { family: 'DefenseUp',      label: 'Defense % (own)',              short: 'Defense' },
  113: { family: 'DefenseUp',      label: 'Health % (own)',               short: 'Health' },
  201: { family: 'OppDamageDown',  label: 'Enemy Damage Dealt Down',      short: 'Enemy dmg ↓' },
  202: { family: 'OppDamageDown',  label: 'Enemy Attack % Down',          short: 'Enemy Atk ↓' },
  203: { family: 'OppDamageDown',  label: 'Enemy damage down (generic / "Lethality Down")', short: 'Enemy Let ↓' },
  211: { family: 'OppDefenseDown', label: 'Enemy Damage Taken Up',        short: 'Enemy dmg taken ↑' },
  212: { family: 'OppDefenseDown', label: 'Enemy Defense % Down',         short: 'Enemy Def ↓' },
};
export const OP_CODES = Object.keys(OPS).map(Number);
export const FAMILIES = ['DamageUp', 'OppDefenseDown', 'OppDamageDown', 'DefenseUp'];

// Leader trio presets: aggregate op sums for a full mythic kit in expected mode.
export const LEADER_PRESETS = {
  none:    { label: 'None / unknown', leaders: [], ops: {} },
  offense: { label: 'Offensive trio (Amadeus · Petra · Marlin)', leaders: ['Amadeus', 'Petra', 'Marlin'], slots: { inf: 'Amadeus', cav: 'Petra', arc: 'Marlin' },
             ops: { 101: 40, 102: 145, 211: 25, 111: 25, 203: 18 } },
  defense: { label: 'Defensive trio (Eric · Hilde · Jaeger)', leaders: ['Eric', 'Hilde', 'Jaeger'], slots: { inf: 'Eric', cav: 'Hilde', arc: 'Jaeger' },
             ops: { 102: 84.5, 111: 40, 112: 25, 113: 80, 202: 20, 203: 18 } },
};

export const MAX_SKILL_LEVEL = 5;
export const MAX_COUNTED_JOINERS = 4;
export const TERRITORY_BONUS = 10; // % Attack and Defense, B = A×(1+S)+S
