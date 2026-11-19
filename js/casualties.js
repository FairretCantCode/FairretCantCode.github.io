// Casualty breakdown. The fight itself runs until one side has no troops left (no round cap or
// retreat in normal PvP, per kingshotsim / SoS engine), so the loser's casualties are 100%.
// But a casualty is not a death: Kingshot battle reports split casualties into
// dead / severely injured (infirmary) / lightly injured (return on their own) / survivors.
//
// Rules (Kingshot Help Center "Combat FAQ" and "Enlistment Office", as quoted by search results):
//  - Attacking another player's Town Center: 35% of the attacker's casualties die.
//  - Defending: troops never die unless the Infirmary is full; the overflow dies.
//    The Enlistment Office is not active when defending.
//  - King's Castle: all casualties go to the Infirmary until it is full.
//  - Enlistment Office (attacker): rescues 70% of troops that would die from Infirmary overflow.
// The lightly-injured share is not published: default 0, set it from your own report.

export const CASUALTY_PRESETS = {
  city:   { label: 'Rally on a city (Town Center)',      attDeadPct: 35, defDeadPct: 0 },
  castle: { label: "King's Castle / fortress (all to infirmary)", attDeadPct: 0, defDeadPct: 0 },
  custom: { label: 'Custom rates' },
};

export const DEFAULT_CASUALTY = {
  type: 'city', attDeadPct: 35, defDeadPct: 0, lightPct: 0,
  attInfirmary: '', defInfirmary: '', enlistment: true, enlistSavePct: 70,
};

const pct = (v, d = 0) => (v === '' || v == null || isNaN(+v)) ? d : Math.max(0, Math.min(100, +v));

// Split `casualties` into dead / severe / light.
//   deadPct:    share of casualties that die outright
//   lightPct:   share of casualties that are lightly injured (no infirmary, return by themselves)
//   infirmary:  free infirmary beds ('' = unlimited); severe injuries beyond it overflow
//   enlistSavePct: share of overflow the Enlistment Office rescues (0 when defending)
export function splitCasualties(casualties, { deadPct = 0, lightPct = 0, infirmary = '', enlistSavePct = 0 } = {}) {
  const C = Math.max(0, Math.round(casualties));
  const light = Math.round(C * pct(lightPct) / 100);
  const deadBase = Math.min(C - light, Math.round(C * pct(deadPct) / 100));
  let severe = C - light - deadBase;
  const beds = infirmary === '' || infirmary == null || isNaN(+infirmary) ? Infinity : Math.max(0, +infirmary);
  const overflow = Math.max(0, severe - beds);
  const rescued = Math.round(overflow * pct(enlistSavePct) / 100);
  severe -= overflow;
  const overflowDead = overflow - rescued;
  return { casualties: C, dead: deadBase + overflowDead, deadBase, severe, light, overflow, rescued, overflowDead };
}

// Breakdown for both sides of a fight result (r.lost = [attacker casualties, defender casualties]).
export function fightCasualties(r, cfg = DEFAULT_CASUALTY) {
  const c = { ...DEFAULT_CASUALTY, ...cfg };
  const att = splitCasualties(r.lost[0], { deadPct: c.attDeadPct, lightPct: c.lightPct, infirmary: c.attInfirmary, enlistSavePct: c.enlistment ? c.enlistSavePct : 0 });
  const def = splitCasualties(r.lost[1], { deadPct: c.defDeadPct, lightPct: c.lightPct, infirmary: c.defInfirmary, enlistSavePct: 0 });
  return { att, def, deadTrade: att.dead > 0 ? def.dead / att.dead : (def.dead > 0 ? Infinity : null) };
}

// Derive rates from one side of a real battle report.
export function calibrate({ dead, severe, light }) {
  const C = (+dead || 0) + (+severe || 0) + (+light || 0);
  if (!C) return null;
  return { deadPct: +(100 * (+dead || 0) / C).toFixed(2), lightPct: +(100 * (+light || 0) / C).toFixed(2) };
}
