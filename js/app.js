import {
  TYPES, TYPE_NAMES, TROOP_TIERS, TIER_NAMES, OPS, OP_CODES, FAMILIES,
  LEADER_PRESETS, MAX_SKILL_LEVEL, COUNTERS,
} from './db.js';
import { HERO_DB, HERO_STATS, describeSkill, getHero, isNoop } from './heroes-data.js';
import {
  perTroopStats, buildSkills, expectedOps, familyValues, skillMod,
  prepareSide, simulate, monteCarlo, sideTroops, countedJoiners,
  effectiveStats, heroContribution, leaderHeroes, marchTroops, armyFactors,
} from './engine.js';
import { searchRallies, minCapacityToWin, winRate, ARCHETYPES } from './solver.js';
import { recognize, parseReport } from './ocr.js';
import { parseNum, formatQty } from './numfmt.js';
import { prepareChain, runChain, chainMonteCarlo, remainingAfter } from './chain.js';
import { optimizeChain } from './chainopt.js';
import { armyLimits, feasibleSplit, allocate, rosterPool, matchHeroes, ratioToTroops, troopsToRatio, ownedHeroes } from './army.js';
import { CASUALTY_PRESETS, DEFAULT_CASUALTY, splitCasualties, fightCasualties, calibrate } from './casualties.js';

// ---------------- state ----------------
const STORE = 'kingshot-rally-calc-v1';
const stat = (atk, let_, def, hp) => ({ atk, let: let_, def, hp });
const newSide = (name, troops, pct) => ({
  name,
  tiers: { inf: 'T10', cav: 'T10', arc: 'T10' },
  stats: { inf: stat(...pct), cav: stat(...pct), arc: stat(...pct) },
  territory: false,
  leaderPreset: 'none',
  leaders: { inf: { hero: '', lv: [5, 5, 5] }, cav: { hero: '', lv: [5, 5, 5] }, arc: { hero: '', lv: [5, 5, 5] } },
  leaderOps: {},
  statMode: 'report',
  heroOver: {},
  heroGear: { inf: {}, cav: {}, arc: {} },
  passives: { helga: 0, amadeus: 0 },
  cap: '',
  leaderTroops: troops,
  joiners: [],
});
const defaultState = () => ({
  target: withLeaders(newSide('Target garrison', { inf: 30000, cav: 25000, arc: 25000 }, [250, 250, 250, 250]), 'Eric', 'Hilde', 'Jaeger'),
  attacker: withLeaders(newSide('Your rally', { inf: 40000, cav: 40000, arc: 40000 }, [290, 250, 260, 250]), 'Amadeus', 'Petra', 'Marlin'),
  customHeroes: {},
  chain: { waves: [] },
  chainOpt: { waves: 2, shared: true, step: 20 },
  casualty: { ...DEFAULT_CASUALTY },
  calib: { dead: '', severe: '', light: '' },
  fatigue: false,
  maxGen: 0, // 0 = all generations
  search: {
    capacity: '',
    step: 10,
    limits: { inf: '', cav: '', arc: '' },
    presets: { current: true, offense: false, defense: false },
    useActual: true,
    poolSource: 'manual',
    pool: defaultPool(),
  },
});

function withLeaders(side, inf, cav, arc) {
  side.leaders = { inf: { hero: inf, lv: [5, 5, 5] }, cav: { hero: cav, lv: [5, 5, 5] }, arc: { hero: arc, lv: [5, 5, 5] } };
  return side;
}
function defaultPool() {
  const pool = {};
  for (const [h, d] of Object.entries(HERO_DB)) if (d.skills[0]?.q !== 'none') pool[h] = { count: 1, level: 5 };
  return pool;
}
let state = load();
function migrate(s) {
  const d = defaultState();
  s = { ...d, ...s, search: { ...d.search, ...s.search } };
  for (const k of ['target', 'attacker']) {
    s[k].leaders ??= d[k].leaders;
    s[k].statMode ??= 'report'; s[k].heroOver ??= {}; s[k].heroGear ??= { inf: {}, cav: {}, arc: {} };
    s[k].passives ??= { helga: 0, amadeus: 0 }; s[k].cap ??= '';
    for (const t of TYPES) s[k].leaders[t] ??= { hero: '', lv: [5, 5, 5] };
  }
  for (const [h, p] of Object.entries(d.search.pool)) s.search.pool[h] ??= p;
  s.chain ??= { waves: [] }; s.chain.waves ??= [];
  s.chainOpt = { waves: 2, shared: true, step: 20, ...(s.chainOpt || {}) };
  s.casualty = { ...DEFAULT_CASUALTY, ...(s.casualty || {}) }; s.calib ??= { dead: '', severe: '', light: '' };
  for (const [h, c] of Object.entries(s.customHeroes || {})) if (!c.skills) delete s.customHeroes[h]; // old format
  return s;
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && s.target && s.attacker) return migrate(s);
  } catch {}
  return defaultState();
}
function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} }
const heroes = () => ({ ...HERO_DB, ...state.customHeroes });
const firstEff = (h, lvl = 5) => describeSkill(h?.skills?.[0], lvl, OPS);
// Server generation filter: heroes from later generations are hidden from dropdowns and the
// search pool. Epic, rare and custom heroes are never hidden. Existing picks stay (flagged).
const MAX_GEN = Math.max(...Object.values(HERO_DB).map(h => h.gen || 0));
const genOk = h => !state.maxGen || h?.rarity !== 'legendary' || (h.gen || 0) <= state.maxGen;
const genTag = h => h.rarity === 'legendary' ? `Gen ${h.gen}` : h.rarity;
// Keep the current pick visible even if the filter would hide it, so nothing changes silently.
const withCurrent = (list, cur, H) => !cur || list.some(([v]) => v === cur) ? list
  : [...list, [cur, H[cur] ? `${cur} (${genTag(H[cur])}: above server gen)` : `${cur} (unknown: no effect)`]];
const getPath = (p) => p.split('.').reduce((o, k) => o?.[k], state);
function setPath(p, v) {
  const ks = p.split('.'); const last = ks.pop();
  const o = ks.reduce((o, k) => (o[k] ??= {}), state);
  o[last] = v;
}

// ---------------- helpers ----------------
const $ = (s, r = document) => r.querySelector(s);
const fmt = (n, d = 0) => (n == null || isNaN(n)) ? '—' : (n === Infinity ? '∞' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sum = n => n.inf + n.cav + n.arc;
const tname = t => `<span class="t-${t}">${TYPE_NAMES[t]}</span>`;
// Number boxes accept K/M/B shorthand ("250k", "1.5M") and separators ("1,200,000").
// Troop-sized fields redisplay compactly (40000 → "40K") when you leave them.
const isQty = path => /troops|\.cap$|capacity|limits|infirmary|calib\.|march|avail\.max/i.test(path);
const numIn = (path, attrs = '') => {
  const v = getPath(path);
  const qty = isQty(path);
  const shown = v === '' || v == null ? '' : qty ? formatQty(+v) : String(v);
  const title = qty && v !== '' && v != null && !isNaN(v) ? ` title="${Number(v).toLocaleString()}"` : '';
  return `<input type="text" inputmode="decimal" class="numfield${qty ? ' qty' : ''}" autocomplete="off" data-bind="${path}" data-parse value="${esc(shown)}"${title} ${attrs.replace(/placeholder="(\d{4,})"/, (m, d) => `placeholder="${formatQty(+d)}"`)}>`;
};
const opts = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('');
const splitBar = n => { const t = sum(n) || 1; return `<div class="bar">${TYPES.map(k => `<span style="width:${n[k] / t * 100}%"></span>`).join('')}</div>`; };
const opName = key => { const [op, only] = String(key).split('@'); return `${op} · ${OPS[op]?.label || 'unknown op'}${only ? ` (${TYPE_NAMES[only] || only} only)` : ''}`; };
const trioNames = (side) => side.leaderPreset !== 'none' ? LEADER_PRESETS[side.leaderPreset].label.split(' (')[0] : TYPES.map(t => side.leaders?.[t]?.hero).filter(Boolean).join(' · ') || 'no leaders';
const presetLabel = (p) => p === 'current' ? `Your trio (${trioNames(state.attacker)})` : LEADER_PRESETS[p].label + ' — kingshotsim full-kit preset';

function famTable(fam) {
  return `<table class="small"><tr>${FAMILIES.map(f => `<th class="num">${f}</th>`).join('')}</tr>
    <tr>${FAMILIES.map(f => `<td class="num">×${fam[f].toFixed(3)}</td>`).join('')}</tr></table>`;
}

// ---------------- side editor (target / attacker) ----------------
function renderSide(key) {
  const s = state[key];
  const isTarget = key === 'target';
  const ratioMode = s.entryMode === 'ratio';
  const H = heroes();
  const heroOpts = [['', '— none —'], ...Object.keys(H).filter(h => genOk(H[h])).sort().map(h => [h, `${h} — ${firstEff(H[h])}`])];
  const leaderOpts = t => [['', '— none —'], ...Object.keys(H).filter(h => H[h].cls === t && genOk(H[h])).sort((a, b) => (H[b].rarity === 'legendary') - (H[a].rarity === 'legendary') || (H[b].gen || 0) - (H[a].gen || 0) || a.localeCompare(b)).map(h => [h, `${h} (${genTag(H[h])})`])];
  const el = $(`#tab-${key}`);
  el.innerHTML = `
  <div class="grid">
    <div class="card">
      <h2>${isTarget ? 'Target battle report / scout' : 'Your battle report'}</h2>
      <p class="muted small">Upload screenshots of the stat-bonus page. Text is read on your device (Tesseract OCR) and only fills the boxes below, so check and fix anything it misreads.</p>
      <div class="drop" data-drop="${key}">Drop screenshots here or click to choose<input type="file" accept="image/*" multiple hidden data-file="${key}"></div>
      <div class="row" style="margin-top:8px">
        <label class="small">Read <select data-crop="${key}">${opts([['full', 'whole image (2 columns)'], ['left', 'left half only'], ['right', 'right half only']], 'full')}</select></label>
      </div>
      <div class="thumbs" data-thumbs="${key}"></div>
      <div data-ocr="${key}"></div>
    </div>

    <div class="card">
      <h2>Leader heroes</h2>
      <p class="muted small">One hero per troop type. Here they add their <b>Expedition skills</b> to SkillMod. Their stats and gear are either already in your report totals or added under \"Leader hero stats &amp; gear\" (see Troop stats). Legendary leaders use all 3 skills, epic leaders only the first.</p>
      <table class="small">
        <tr><th>Slot</th><th>Hero</th><th class="num">Skill levels 1 · 2 · 3</th></tr>
        ${TYPES.map(t => { const L = s.leaders[t]; const h = H[L.hero]; const n = h ? (h.rarity === 'epic' ? 1 : h.skills.length) : 0; return `<tr>
          <td>${tname(t)}</td>
          <td><select data-bind="${key}.leaders.${t}.hero" data-rerender="${key}" ${s.leaderPreset !== 'none' ? 'disabled' : ''}>${opts(withCurrent(leaderOpts(t), L.hero, H), L.hero)}</select></td>
          <td class="num">${[0, 1, 2].map(k => k < n ? `<select data-bind="${key}.leaders.${t}.lv.${k}" data-num title="${esc(describeSkill(h.skills[k], L.lv[k] || 5, OPS))}" ${s.leaderPreset !== 'none' ? 'disabled' : ''}>${opts([0, 1, 2, 3, 4, 5].map(l => [l, l]), L.lv[k])}</select>` : '').join(' ')}</td></tr>
          ${h ? `<tr><td></td><td colspan="2" class="muted">${h.skills.slice(0, n).map((sk, k) => `${esc(sk.name)}: ${esc(describeSkill(sk, L.lv[k], OPS))}${sk.q === 'approx' ? ' <span class="badge warn" title="' + esc(sk.note) + '">approx</span>' : ''}`).join('<br>')}</td></tr>` : ''}`; }).join('')}
      </table>
      <label class="small" style="display:block;margin-top:8px">Or use a kingshotsim full-kit preset (includes widgets, replaces the heroes above)
        <select data-bind="${key}.leaderPreset" data-rerender="${key}">${opts(Object.entries(LEADER_PRESETS).map(([k, v]) => [k, k === 'none' ? 'No — use the heroes above' : v.label]), s.leaderPreset)}</select></label>
      <details ${Object.values(s.leaderOps || {}).some(v => +v) ? 'open' : ''}>
        <summary>Extra / custom skill ops (widgets, other heroes) — adds to the trio</summary>
        <table class="small">${OP_CODES.map(op => `<tr><td>${opName(op)}<span class="muted"> · ${OPS[op].family}</span></td><td>${numIn(`${key}.leaderOps.${op}`, 'placeholder="0"')}%</td></tr>`).join('')}</table>
      </details>
      ${isTarget ? `<label class="chk" style="margin-top:8px"><input type="checkbox" data-bind="${key}.territory" ${s.territory ? 'checked' : ''}> Garrisoned in allied territory (+10% Atk/Def, B = A×1.1 + 10)</label>` : ''}
    </div>

    <div class="card wide">
      <h2>Troop stats <span class="muted small">(leader's account bonuses apply to every troop in the ${isTarget ? 'garrison' : 'rally'})</span></h2>
      <div class="row small" style="margin-bottom:8px">The bonuses I enter below are
        <label class="chk"><input type="radio" name="${key}-mode" data-bind="${key}.statMode" value="report" data-rerender="${key}" ${s.statMode !== 'build' ? 'checked' : ''}> battle-report totals (hero stats &amp; gear already included)</label>
        <label class="chk"><input type="radio" name="${key}-mode" data-bind="${key}.statMode" value="build" data-rerender="${key}" ${s.statMode === 'build' ? 'checked' : ''}> account only, so add leader hero stats &amp; gear</label>
      </div>
      <div class="tablewrap"><table>
        <tr><th>Type</th><th>Tier</th><th class="num">Attack %</th><th class="num">Lethality %</th><th class="num">Defense %</th><th class="num">Health %</th><th class="num">Att / troop</th><th class="num">Def / troop</th></tr>
        ${TYPES.map(t => `<tr>
          <td>${tname(t)}</td>
          <td><select data-bind="${key}.tiers.${t}">${opts(TIER_NAMES.map(n => [n, n]), s.tiers[t])}</select></td>
          <td class="num">${numIn(`${key}.stats.${t}.atk`)}</td>
          <td class="num">${numIn(`${key}.stats.${t}.let`)}</td>
          <td class="num">${numIn(`${key}.stats.${t}.def`)}</td>
          <td class="num">${numIn(`${key}.stats.${t}.hp`)}</td>
          <td class="num" data-pt="${key}.${t}.att"></td>
          <td class="num" data-pt="${key}.${t}.def"></td>
        </tr>${s.statMode === 'build' ? `<tr class="small muted"><td></td><td>fighting with</td>${['atk', 'let', 'def', 'hp'].map(k => `<td class="num" data-eff="${key}.${t}.${k}"></td>`).join('')}<td colspan="2"></td></tr>` : ''}`).join('')}
      </table></div>
    </div>

    ${s.statMode === 'build' ? heroStatsCard(key) : ''}

    <div class="card wide">
      <h2>Troops &amp; joiners</h2>
      <div class="row small" style="margin-bottom:6px"><label>${isTarget ? 'Garrison' : 'Rally'} capacity ${numIn(`${key}.cap`, 'placeholder="no cap" style="width:110px"')}</label>
        <span class="muted">The leader fills first, then joiners in join order. Marches past the cap are cut off.</span></div>
      <p class="muted small">Only the leader's stats fight. Joiners add troops, and the 4 with the highest first-skill level (ties: join order) add their first hero's first skill. Duplicate chance skills only roll once.</p>
      <div class="row small" style="margin-bottom:6px">
        <button class="ghost small" data-act="swapentry" data-key="${key}" title="Switch how you type troops; the other format is always shown underneath">⇄ Entry: <b>${ratioMode ? 'Ratio % + march' : 'Troop counts'}</b></button>
        <button class="ghost small" data-act="toggleavail" data-key="${key}" title="Per-player limits the optimizer may use">${s.showAvail ? '▾' : '▸'} Availability for the optimizer (max per type, march size, heroes owned)</button>
      </div>
      <div class="tablewrap"><table>
        <tr><th>#</th><th>Player</th><th>First hero</th><th class="num">Skill lvl</th>
          ${ratioMode ? `<th class="num t-inf">Inf %</th><th class="num t-cav">Cav %</th><th class="num t-arc">Arc %</th><th class="num">March</th>` : `<th class="num t-inf">Inf</th><th class="num t-cav">Cav</th><th class="num t-arc">Arc</th><th></th>`}
          <th>Skill</th><th></th></tr>
        ${troopRow(key, -1)}
        ${s.joiners.map((j, i) => troopRow(key, i)).join('')}
        <tr><td></td><td colspan="3"><b>Marching</b></td>${TYPES.map(t => `<td class="num" data-total="${key}.${t}"></td>`).join('')}<td></td><td class="small" data-total="${key}.all" colspan="2"></td></tr>
      </table></div>
      <div class="row" style="margin-top:8px">
        <button data-act="addjoiner" data-key="${key}">+ Add joiner</button>
        <button class="ghost" data-act="addjoiners4" data-key="${key}">+ Add 4</button>
      </div>
    </div>

    <div class="card wide" data-summary="${key}"></div>
  </div>`;
  refreshSide(key);
}

// ---------------- troop rows (leader = -1) ----------------
const rowPath = (key, i) => i < 0
  ? { troops: `${key}.leaderTroops`, ratio: `${key}.leaderRatio`, march: `${key}.leaderMarch`, avail: `${key}.leaderAvail` }
  : { troops: `${key}.joiners.${i}.troops`, ratio: `${key}.joiners.${i}.ratio`, march: `${key}.joiners.${i}.march`, avail: `${key}.joiners.${i}.avail` };

function troopRow(key, i) {
  const s = state[key];
  const H = heroes();
  const P = rowPath(key, i);
  const ratioMode = s.entryMode === 'ratio';
  const j = i >= 0 ? s.joiners[i] : null;
  const heroOpts = [['', '— none —'], ...Object.keys(H).filter(h => genOk(H[h])).sort().map(h => [h, `${h} — ${firstEff(H[h])}`])];
  const entry = ratioMode
    ? TYPES.map(t => `<td class="num">${numIn(`${P.ratio}.${t}`, 'placeholder="%" style="width:60px"')}</td>`).join('') + `<td class="num">${numIn(P.march)}</td>`
    : TYPES.map(t => `<td class="num">${numIn(`${P.troops}.${t}`)}</td>`).join('') + '<td></td>';
  const head = i < 0
    ? `<tr><td>★</td><td><b>Leader</b></td><td class="muted small">see trio</td><td></td>`
    : `<tr data-jrow="${key}.${i}"><td>${i + 1}</td>
      <td><input type="text" data-bind="${key}.joiners.${i}.player" value="${esc(j.player)}" placeholder="name"></td>
      <td><select data-bind="${key}.joiners.${i}.hero" data-rerender="${key}">${opts(withCurrent(heroOpts, j.hero, H), j.hero)}</select></td>
      <td class="num"><select data-bind="${key}.joiners.${i}.level" data-num>${opts([0, 1, 2, 3, 4, 5].map(l => [l, l]), j.level)}</select></td>`;
  const tail = i < 0 ? '<td></td><td></td></tr>'
    : `<td class="small"><span data-jstatus="${key}.${i}"></span> <span data-jcut="${key}.${i}" class="badge warn" hidden></span></td>
      <td><button class="icon danger" data-act="rmjoiner" data-key="${key}" data-i="${i}" title="Remove">✕</button></td></tr>`;
  const hint = `<tr class="hintrow"><td></td><td colspan="3"></td><td colspan="4" class="small muted mono" data-hint="${key}.${i}"></td><td colspan="2"></td></tr>`;
  let avail = '';
  if (s.showAvail) {
    const av = getPath(P.avail) || {};
    const owned = av.heroes || [];
    const combat = Object.keys(H).filter(h => genOk(H[h]) && !isNoop(H[h])).sort();
    avail = `<tr class="availrow"><td></td><td colspan="9" class="small">
      <span class="muted">Can send:</span>
      ${TYPES.map(t => `<label class="t-${t}">max ${TYPE_NAMES[t]} ${numIn(`${P.avail}.max.${t}`, 'placeholder="as sent" style="width:76px"')}</label>`).join(' ')}
      <label>march ${numIn(`${P.avail}.march`, 'placeholder="as sent" style="width:76px"')}</label>
      ${i >= 0 ? `<details class="heropick"><summary data-hsum="${key}.${i}">heroes they can bring: ${owned.length ? esc(owned.join(', ')) : `<span class="muted">${j.hero ? esc(j.hero) + ' (picked)' : 'none'}</span>`}</summary>
        <div class="herogrid">${combat.map(h => `<label class="chk t-${H[h].cls}"><input type="checkbox" data-hero-toggle="${key}.${i}" value="${esc(h)}" ${owned.includes(h) ? 'checked' : ''}> ${esc(h)}</label>`).join('')}</div></details>` : ''}
    </td></tr>`;
  }
  return head + entry + tail + hint + avail;
}

function refreshHints(key) {
  const s = state[key];
  const el = $(`#tab-${key}`);
  const ratioMode = s.entryMode === 'ratio';
  [-1, ...s.joiners.map((_, i) => i)].forEach(i => {
    const c = $(`[data-hint="${key}.${i}"]`, el); if (!c) return;
    const tr = getPath(rowPath(key, i).troops) || {};
    const n = { inf: +tr.inf || 0, cav: +tr.cav || 0, arc: +tr.arc || 0 };
    if (!sum(n)) { c.textContent = ''; return; }
    if (ratioMode) {
      const r = getPath(rowPath(key, i).ratio) || {};
      const rs = (+r.inf || 0) + (+r.cav || 0) + (+r.arc || 0);
      c.textContent = `= ${TYPES.map(t => formatQty(n[t]) || '0').join(' / ')}${rs && Math.abs(rs - 100) > 0.05 ? `  (ratios add to ${+rs.toFixed(1)}%, scaled to 100)` : ''}`;
    } else {
      const { ratio } = troopsToRatio(n);
      c.textContent = `= ${ratio.inf}% / ${ratio.cav}% / ${ratio.arc}% · march ${formatQty(sum(n))}`;
    }
  });
}

function swapEntry(key) {
  const s = state[key];
  if (s.entryMode !== 'ratio') {
    // Seed ratio + march from the current counts so nothing changes.
    [-1, ...s.joiners.map((_, i) => i)].forEach(i => {
      const P = rowPath(key, i);
      const { ratio, march } = troopsToRatio(getPath(P.troops));
      setPath(P.ratio, ratio); setPath(P.march, march);
    });
    s.entryMode = 'ratio';
  } else s.entryMode = 'counts';
  save(); renderSide(key);
}

function heroStatsCard(key) {
  const s = state[key];
  const lead = leaderHeroes(s);
  const ph = (h, k) => { const d = HERO_STATS[h]; if (!d) return '0'; return k === 'exp' ? d.exp : d.excl[k === 'exclLet' ? 'let' : 'hp']; };
  return `<div class="card wide">
    <h2>Leader hero stats &amp; gear</h2>
    <p class="small muted">Each leader adds to <b>its own troop class</b>: Expedition Attack &amp; Defense % (from its stars) + exclusive gear Lethality &amp; Health % + the 4 hero-gear pieces. Grey placeholders are max-star / max-level values from KingshotPro, so type your hero's real numbers (shown on its stat page) over them. Hero gear stays with the slot when you swap heroes.</p>
    <div class="tablewrap"><table class="small">
      <tr><th>Slot</th><th>Hero</th><th class="num">Exp. Atk/Def %</th><th class="num">Excl. gear Let %</th><th class="num">Excl. gear HP %</th>
        <th class="num">Gear Atk %</th><th class="num">Gear Let %</th><th class="num">Gear Def %</th><th class="num">Gear HP %</th><th class="num">Adds Atk / Let / Def / HP</th></tr>
      ${TYPES.map(t => { const h = lead[t]; return `<tr><td>${tname(t)}</td><td>${h ? esc(h) : '<span class="muted">none</span>'}</td>
        ${['exp', 'exclLet', 'exclHp'].map(k => `<td class="num">${h ? numIn(`${key}.heroOver.${h}.${k}`, `placeholder="${ph(h, k)}"`) : ''}</td>`).join('')}
        ${['atk', 'let', 'def', 'hp'].map(k => `<td class="num">${numIn(`${key}.heroGear.${t}.${k}`, 'placeholder="0"')}</td>`).join('')}
        <td class="num mono" data-hc="${key}.${t}"></td></tr>`; }).join('')}
    </table></div>
    <div class="row small" style="margin-top:8px">Account-wide passives (count even if the hero isn't deployed):
      <label>Helga ★ <select data-bind="${key}.passives.helga" data-num>${opts([0, 1, 2, 3, 4, 5].map(v => [v, v ? v + '★ (+' + 2 * v + '% Atk & Def)' : 'not owned']), s.passives.helga)}</select></label>
      <label>Amadeus ★ <select data-bind="${key}.passives.amadeus" data-num>${opts([0, 1, 2, 3, 4, 5].map(v => [v, v ? v + '★ (+' + 3 * v + '% Let & HP)' : 'not owned']), s.passives.amadeus)}</select></label>
    </div>
  </div>`;
}

function refreshSide(key) {
  const s = state[key];
  const el = $(`#tab-${key}`);
  if (!el.innerHTML) return;
  const pt = perTroopStats(s);
  for (const t of TYPES) {
    $(`[data-pt="${key}.${t}.att"]`, el).textContent = fmt(pt[t].att, 1);
    $(`[data-pt="${key}.${t}.def"]`, el).textContent = fmt(pt[t].def, 1);
  }
  refreshHints(key);
  const m = marchTroops(s);
  const n = m.n;
  for (const t of TYPES) $(`[data-total="${key}.${t}"]`, el).textContent = fmt(n[t]);
  $(`[data-total="${key}.all"]`, el).innerHTML = `<b class="mono">${fmt(sum(n))}</b>${m.cap !== Infinity ? ` / ${fmt(m.cap)} cap` : ''}${m.rejected > 0 ? ` <span class="badge bad">${fmt(m.rejected)} over cap, not marching</span>` : ''}`;
  s.joiners.forEach((j, i) => {
    const c = $(`[data-jcut="${key}.${i}"]`, el); if (!c) return;
    const want = TYPES.reduce((a, t) => a + (+j.troops?.[t] || 0), 0), got = sum(m.accepted[i + 1]);
    c.hidden = !(want > got);
    c.textContent = got === 0 ? 'rejected: rally full' : `cut to ${fmt(got)}`;
  });
  if (s.statMode === 'build') {
    const eff = effectiveStats(s);
    for (const t of TYPES) for (const k of ['atk', 'let', 'def', 'hp']) { const c = $(`[data-eff="${key}.${t}.${k}"]`, el); if (c) c.textContent = fmt(eff[t][k], 2) + '%'; }
    const lead = leaderHeroes(s);
    for (const t of TYPES) { const c = $(`[data-hc="${key}.${t}"]`, el); if (c) { const h = heroContribution(s, t, lead[t]); c.textContent = `+${fmt(h.atk, 2)} / +${fmt(h.let, 2)} / +${fmt(h.def, 2)} / +${fmt(h.hp, 2)}`; } }
  }

  const H = heroes();
  const sk = buildSkills(s, H);
  const countedIdx = new Set(countedJoiners(s.joiners).map(j => j._i));
  const chanceHeroes = new Set(sk.chance.map(c => c.hero));
  const seenChance = new Set();
  s.joiners.forEach((j, i) => {
    const row = $(`[data-jrow="${key}.${i}"]`, el);
    const st = $(`[data-jstatus="${key}.${i}"]`, el);
    if (!row) return;
    const counted = countedIdx.has(i);
    row.classList.toggle('counted', counted);
    let badge = '<span class="badge">troops only</span>';
    const hj = getHero(H, j.hero);
    if (counted && hj && isNoop(hj)) badge = `<span class="badge warn">counted, but ${H[j.hero] ? 'its first skill is non-combat' : 'unknown hero'}: no effect</span>`;
    else if (counted && H[j.hero]) {
      const isChance = H[j.hero].skills?.[0]?.chance != null;
      const dup = isChance && seenChance.has(j.hero);
      if (isChance) seenChance.add(j.hero);
      badge = dup ? '<span class="badge warn">duplicate chance skill: no effect</span>'
        : `<span class="badge gold">counted</span> <span class="muted">${esc(firstEff(H[j.hero], j.level))}</span>`;
    } else if (j.hero && !(+j.level)) badge = '<span class="badge">skill lvl 0</span>';
    st.innerHTML = badge;
  });

  const ops = expectedOps(sk);
  const fam = familyValues(ops);
  $(`[data-summary="${key}"]`, el).innerHTML = `
    <h2>SkillMod contribution (expected)</h2>
    ${famTable(fam)}
    <p class="small muted">Offense ×${(fam.DamageUp * fam.OppDefenseDown).toFixed(3)} (DamageUp × OppDefenseDown) · Defense ÷${(fam.OppDamageDown * fam.DefenseUp).toFixed(3)} (OppDamageDown × DefenseUp)</p>
    <details><summary>Op-code sums</summary><table class="small">${Object.entries(ops).filter(([, v]) => v).sort().map(([op, v]) => `<tr><td>${opName(op)}</td><td class="num">${fmt(v, 1)}%</td></tr>`).join('') || '<tr><td class="muted">No skills</td></tr>'}</table></details>`;
}

// ---------------- OCR ----------------
const files = { target: [], attacker: [] };
async function handleFiles(key, list) {
  const el = $(`#tab-${key}`);
  const box = $(`[data-ocr="${key}"]`, el);
  const crop = $(`[data-crop="${key}"]`, el).value;
  files[key] = [...list];
  $(`[data-thumbs="${key}"]`, el).innerHTML = files[key].map(f => `<img src="${URL.createObjectURL(f)}" alt="">`).join('');
  box.innerHTML = `<div class="small muted">Reading…</div><div class="progress"><div></div></div>`;
  const bar = $('.progress > div', box);
  let text = '';
  try {
    for (let i = 0; i < files[key].length; i++) {
      text += '\n' + await recognize(files[key][i], crop, p => { bar.style.width = ((i + p) / files[key].length * 100) + '%'; });
    }
  } catch (e) {
    box.innerHTML = `<p class="danger small">${esc(e.message)}</p>`;
    return;
  }
  const parsed = parseReport(text);
  lastParsed[key] = parsed;
  const col = (side, i) => {
    const cells = TYPES.flatMap(t => ['atk', 'let', 'def', 'hp'].map(k => side.stats[t][k])).filter(v => v != null).length;
    const tr = TYPES.filter(t => side.troops[t] != null).length;
    return `<div class="card" style="padding:10px">
      <b>${parsed.sides.length > 1 ? (i ? 'Right column' : 'Left column') : 'Detected'}</b> <span class="muted small">${cells}/12 stats · ${tr}/3 troop counts</span>
      <table class="small">${TYPES.map(t => `<tr><td>${tname(t)}</td>${['atk', 'let', 'def', 'hp'].map(k => `<td class="num">${side.stats[t][k] ?? '—'}${side.stats[t][k] != null ? '%' : ''}</td>`).join('')}<td class="num">${fmt(side.troops[t])}</td></tr>`).join('')}</table>
      <div class="row" style="margin-top:6px">
        <button class="primary" data-act="applyocr" data-key="${key}" data-side="${i}" data-to="${key}">Apply to ${key === 'target' ? 'target' : 'your rally'}</button>
        <button class="ghost" data-act="applyocr" data-key="${key}" data-side="${i}" data-to="${key === 'target' ? 'attacker' : 'target'}">Apply to ${key === 'target' ? 'your rally' : 'target'}</button>
      </div></div>`;
  };
  box.innerHTML = `
    <h3 style="margin-top:12px">Read from report</h3>
    ${parsed.found ? parsed.sides.map(col).join('') : '<p class="small warn">No stat lines recognized. Try "left half only" / "right half only", a sharper screenshot, or type the values in.</p>'}
    <p class="small muted">Columns: Attack · Lethality · Defense · Health · troops. Troop counts go to the leader row.</p>
    <details><summary>Raw OCR text</summary><pre class="raw">${esc(text)}</pre></details>`;
}
const lastParsed = {};
function applyOcr(fromKey, sideIdx, toKey) {
  const p = lastParsed[fromKey]?.sides[sideIdx];
  if (!p) return;
  const s = state[toKey];
  for (const t of TYPES) {
    for (const k of ['atk', 'let', 'def', 'hp']) if (p.stats[t][k] != null) s.stats[t][k] = p.stats[t][k];
    if (p.troops[t] != null) s.leaderTroops[t] = p.troops[t];
  }
  syncRatio(toKey);
  save();
  if (toKey === fromKey) refreshAndKeepOcr(toKey); else renderSide(toKey);
  toast(`Applied to ${toKey === 'target' ? 'target' : 'your rally'}`);
}
function refreshAndKeepOcr(key) {
  const el = $(`#tab-${key}`);
  const box = $(`[data-ocr="${key}"]`, el).innerHTML;
  const thumbs = $(`[data-thumbs="${key}"]`, el).innerHTML;
  renderSide(key);
  $(`[data-ocr="${key}"]`, el).innerHTML = box;
  $(`[data-thumbs="${key}"]`, el).innerHTML = thumbs;
}

// ---------------- simulate ----------------
function simOpts() { return { fatigue: state.fatigue }; }
function armyCard(r) {
  const af = armyFactors(r.start[0], r.start[1]);
  const mA = marchTroops(state.attacker), mD = marchTroops(state.target);
  const row = (label, n, f) => `<tr><td>${label}</td>${TYPES.map(t => `<td class="num">${fmt(n[t])}<div class="small muted">AF ${fmt(f[t])}</div></td>`).join('')}<td class="num"><b>${fmt(sum(n))}</b></td></tr>`;
  return `<div class="card wide">
    <h2>Army count</h2>
    <table>
      <tr><th></th>${TYPES.map(t => `<th class="num">${tname(t)}</th>`).join('')}<th class="num">Total</th></tr>
      ${row('Your rally', r.start[0], af.att)}
      ${row('Target', r.start[1], af.def)}
    </table>
    <p class="small">armyMin = min(${fmt(sum(r.start[0]))}, ${fmt(sum(r.start[1]))}) = <b class="mono">${fmt(af.armyMin)}</b>, fixed at fight start. Each squad's round-0 army factor (AF) = √(squad × armyMin).
      ${mA.rejected > 0 ? `<br><span class="danger">${fmt(mA.rejected)} of your troops are over the rally cap and don't march.</span>` : ''}
      ${mD.rejected > 0 ? `<br><span class="danger">${fmt(mD.rejected)} target troops are over the garrison cap.</span>` : ''}</p>
    <p class="small muted">Why more troops don't scale 1:1: your damage grows with √(your squad × armyMin). Once your total passes the target's, armyMin stops growing, so doubling your army gives about +41% damage, not +100%. Your troops still matter as the HP pool the enemy has to chew through.</p>
  </div>`;
}

function renderSim() {
  const H = heroes();
  const A = prepareSide(state.attacker, H);
  const D = prepareSide(state.target, H);
  const el = $('#tab-sim');
  if (!sum(A.troops) || !sum(D.troops)) {
    el.innerHTML = `<div class="card"><p>Add troops to both your rally and the target first.</p></div>`;
    return;
  }
  const r = simulate(A, D, { ...simOpts(), log: true });
  lastSim = r;
  const mc = monteCarlo(A, D, 400, simOpts());
  const v = r.winner === 'attacker' ? ['win', 'Your rally wins'] : r.winner === 'defender' ? ['lose', 'The target holds'] : ['draw', r.winner === 'draw' ? 'Mutual wipe (draw)' : 'No result (round cap)'];
  const lossRow = (i) => TYPES.map(t => `<td class="num">${fmt(r.start[i][t] - r.remaining[i][t])}</td>`).join('');
  const remRow = (i) => TYPES.map(t => `<td class="num">${fmt(r.remaining[i][t])}</td>`).join('');
  el.innerHTML = `
  <div class="grid">
    <div class="card wide">
      <div class="verdict ${v[0]}">${v[1]} <span class="small" style="font-weight:400">(expected-value run, ${r.rounds} rounds)</span></div>
      <div class="kpis">
        <div class="kpi"><div class="k">Win rate (Monte Carlo ×400)</div><div class="v">${fmt(mc.winRate * 100, 1)}%</div></div>
        <div class="kpi"><div class="k">Your casualties</div><div class="v">${fmt(r.lost[0])}</div></div>
        <div class="kpi"><div class="k">Enemy casualties</div><div class="v">${fmt(r.lost[1])}</div></div>
        <div class="kpi"><div class="k">Casualty trade (theirs / yours)</div><div class="v">${fmt(r.trade, 2)}</div></div>
        <div class="kpi"><div class="k">Dead: you / them</div><div class="v" id="kpi-dead"></div></div>
        <div class="kpi"><div class="k">SkillMod: your hit</div><div class="v">×${r.skillMod[0].toFixed(3)}</div></div>
        <div class="kpi"><div class="k">SkillMod: their hit</div><div class="v">×${r.skillMod[1].toFixed(3)}</div></div>
      </div>
      <p class="small muted" style="margin-top:8px">Expected mode folds chance skills, cavalry bypass (20%) and archer volley (10%) in as averages; Monte Carlo rolls them each round.</p>
    </div>
    ${armyCard(r)}
    ${casualtyCard()}
    <div class="card">
      <h2>Casualties by troop type</h2>
      <table>
        <tr><th></th>${TYPES.map(t => `<th class="num">${tname(t)}</th>`).join('')}</tr>
        <tr><td>Your start</td>${TYPES.map(t => `<td class="num">${fmt(r.start[0][t])}</td>`).join('')}</tr>
        <tr><td>Your casualties</td>${lossRow(0)}</tr>
        <tr><td>Your left</td>${remRow(0)}</tr>
        <tr><td colspan="4"></td></tr>
        <tr><td>Enemy start</td>${TYPES.map(t => `<td class="num">${fmt(r.start[1][t])}</td>`).join('')}</tr>
        <tr><td>Enemy casualties</td>${lossRow(1)}</tr>
        <tr><td>Enemy left</td>${remRow(1)}</tr>
      </table>
    </div>
    <div class="card">
      <h2>SkillMod families</h2>
      <h3>Your rally</h3>${famTable(A.expFam)}
      <h3 style="margin-top:10px">Target</h3>${famTable(D.expFam)}
      <p class="small muted">Your hit = (your DamageUp × OppDefenseDown) / (their OppDamageDown × DefenseUp).</p>
    </div>
    <div class="card wide">
      <details open><summary>Round-by-round (first 40 rounds)</summary>
      <div class="tablewrap"><table class="small">
        <tr><th>Rd</th><th>Hits (from → to: deaths)</th><th class="num">You left</th><th class="num">Enemy left</th></tr>
        ${r.history.slice(0, 40).map(h => `<tr><td>${h.round}</td><td>${h.hits.map(x => `<span class="${x.side ? 'muted' : ''}">${x.side ? 'E' : 'Y'}·<span class="t-${x.from}">${x.from}</span>→<span class="t-${x.to}">${x.to}</span>${COUNTERS[x.from] === x.to ? '⁺' : ''}: ${fmt(x.deaths)}</span>`).join(' · ')}</td><td class="num">${fmt(sum(h.after[0]))}</td><td class="num">${fmt(sum(h.after[1]))}</td></tr>`).join('')}
      </table></div>
      <p class="small muted">Y = your squad, E = enemy squad, ⁺ = type counter (+10%).</p></details>
    </div>
  </div>`;
  refreshCasualties();
}

// ---------------- search ----------------
let searching = false;
// The army you can really send: offered troops per type are the limits, the rally cap the size.
// What the rally can really send: each row's availability (max per type, march size; falls back
// to what it sends now), capped by rally capacity. rows feed the exact feasibility check.
function actualArmy(side = state.attacker) {
  const L = armyLimits(side);
  return { limits: L.limits, capacity: L.capacity, cap: L.cap, rows: L.rows };
}

// Generation of a search trio: a kingshotsim preset brings fixed leaders; "current" uses yours.
const presetGen = p => {
  const H = heroes();
  const names = p === 'current' ? Object.values(leaderHeroes(state.attacker)) : Object.values(LEADER_PRESETS[p]?.slots || {});
  return Math.max(0, ...names.filter(Boolean).map(n => H[n]?.rarity === 'legendary' ? H[n].gen || 0 : 0));
};
// "current" is always allowed (it's the user's own pick, already flagged in the dropdowns).
const presetGenOk = p => p === 'current' || !state.maxGen || presetGen(p) <= state.maxGen;
// The joiner pool every optimizer uses: search-tab counts, minus heroes above the server gen.
const genPool = () => Object.entries(state.search.pool)
  .filter(([hero]) => { const h = heroes()[hero]; return !h || genOk(h); })
  .map(([hero, p]) => ({ hero, count: +p.count || 0, level: +p.level || 5 }));

function renderSearch() {
  const S = state.search;
  const H = heroes();
  const n = sideTroops(state.attacker);
  const actual = actualArmy();
  const el = $('#tab-search');
  el.innerHTML = `
  <div class="grid">
    ${searchTarget ? `<div class="card wide" style="border-color:var(--gold)">
      <div class="row"><b class="t-cav">Target: ${esc(searchTarget.label)}</b>
        <span class="mono small">${fmt(sum(searchTarget.troops))} troops · ${TYPES.map(t => `<span class="t-${t}">${fmt(searchTarget.troops[t])}</span>`).join(' / ')}</span>
        <span class="spacer"></span><button class="ghost small" data-act="cleartarget">Use the full target instead</button></div>
      <p class="small muted" style="margin:6px 0 0">Same garrison stats and skills as the Target tab, with only the troops left after the earlier wave(s). "+ Wave" on a result adds it to the chain.</p>
    </div>` : ''}
    <div class="card">
      <h2>Rally to test</h2>
      <p class="small muted">Uses your account stats and troop tiers from "Your rally". Joiner gear/stats never matter; only their first skill and troops.</p>
      <table>
        <tr><td colspan="2"><label class="chk"><input type="checkbox" data-bind="search.useActual" data-rerender-search ${S.useActual ? 'checked' : ''}> Use my rally's real army: each player's availability on "Your rally" (max per type and march size, or what they send now), capped by rally capacity</label></td></tr>
        ${S.useActual ? `<tr><td>Rally size</td><td class="mono">${fmt(actual.capacity)}${actual.cap !== Infinity ? ` <span class="muted small">(cap ${fmt(actual.cap)})</span>` : ''}</td></tr>
          ${TYPES.map(t => `<tr><td>${tname(t)} available</td><td class="mono">${fmt(actual.limits[t])}</td></tr>`).join('')}`
        : `<tr><td>Rally size (troops)</td><td>${numIn('search.capacity', `placeholder="${sum(n) || 100000}"`)}</td></tr>
          ${TYPES.map(t => `<tr><td>Max ${tname(t)} available</td><td>${numIn(`search.limits.${t}`, 'placeholder="no limit"')}</td></tr>`).join('')}`}
        <tr><td>Troop split step</td><td><select data-bind="search.step" data-num>${opts([[5, '5%'], [10, '10%'], [20, '20%'], [25, '25%']], S.step)}</select></td></tr>
      </table>
      <h3 style="margin-top:12px">Leader trios to try</h3>
      ${['current', 'offense', 'defense'].map(p => { const ok = presetGenOk(p); return `<label class="chk" style="display:flex"${ok ? '' : ' title="Above the server generation"'}><input type="checkbox" data-bind="search.presets.${p}" ${S.presets[p] && ok ? 'checked' : ''} ${ok ? '' : 'disabled'}> <span class="${ok ? '' : 'muted'}">${esc(presetLabel(p))}${ok ? '' : ` (needs Gen ${presetGen(p)})`}</span></label>`; }).join('')}
    </div>
    <div class="card">
      <h2>Joiners you can call in</h2>
      ${state.maxGen ? `<p class="small t-cav">Server gen ${state.maxGen}: later-generation heroes are hidden and not searched.</p>` : ''}
      <div class="row small" style="margin-bottom:6px">
        <label class="chk"><input type="radio" name="poolsrc" data-bind="search.poolSource" value="manual" data-rerender-search ${S.poolSource !== 'roster' ? 'checked' : ''}> Manual pool</label>
        <label class="chk"><input type="radio" name="poolsrc" data-bind="search.poolSource" value="roster" data-rerender-search ${S.poolSource === 'roster' ? 'checked' : ''}> My rally's joiners (heroes each one owns, one hero per player)</label>
      </div>
      ${S.poolSource === 'roster' ? rosterSummary() : `<p class="small muted">How many players can join with each first hero, and their skill level. Set 0 to exclude.</p>`}
      ${S.poolSource === 'roster' ? '' : `      <div class="tablewrap"><table class="small">
        <tr><th>Hero</th><th>Skill</th><th class="num">Players</th><th class="num">Lvl</th></tr>
        ${Object.keys(S.pool).filter(h => H[h] && genOk(H[h])).sort().map(h => `<tr><td class="t-${H[h].cls}">${esc(h)}</td><td class="muted">${esc(firstEff(H[h], S.pool[h]?.level ?? 5))}</td>
          <td class="num">${numIn(`search.pool.${h}.count`, 'min="0" style="width:56px"')}</td>
          <td class="num"><select data-bind="search.pool.${h}.level" data-num>${opts([1, 2, 3, 4, 5].map(l => [l, l]), S.pool[h]?.level ?? 5)}</select></td></tr>`).join('')}
      </table></div>`}
    </div>
    <div class="card wide">
      <div class="row"><button class="primary" data-act="search" ${searching ? 'disabled' : ''}>Find rallies that beat the target</button>
        <span class="small muted" id="search-info"></span></div>
      <div class="progress" id="search-prog" style="display:none"><div></div></div>
      <div id="search-out"></div>
    </div>
  </div>`;
}

async function runSearch() {
  if (searching) return;
  const H = heroes();
  const S = state.search;
  const D = prepareSide(state.target, H, searchTarget?.troops);
  if (!sum(D.troops)) { toast(searchTarget ? 'Nothing left to beat: the garrison is already empty after that wave' : 'Give the target some troops first'); return; }
  const presets = Object.entries(S.presets).filter(([, v]) => v).map(([k]) => k);
  const uniq = [...new Set(presets)].filter(presetGenOk);
  if (!uniq.length) { toast('Pick at least one leader trio'); return; }
  const actual = actualArmy();
  const capacity = S.useActual ? actual.capacity : (+S.capacity || sum(sideTroops(state.attacker)) || 100000);
  const limits = S.useActual ? actual.limits : S.limits;
  if (!capacity) { toast('Your rally has no troops: add them on "Your rally" or untick "Use my rally\'s real army"'); return; }
  const roster = S.poolSource === 'roster';
  const joinersR = state.attacker.joiners;
  const pool = roster ? rosterPool(joinersR).filter(p => !H[p.hero] || genOk(H[p.hero])) : genPool();
  if (roster && !pool.length) { toast('None of your joiners has a hero: pick heroes or tick "heroes they can bring" under Availability'); return; }
  const setOk = roster ? set => matchHeroes(set.filter(h => !isNoop(getHero(H, h))), joinersR) != null : null;
  const splitOk = S.useActual ? n => feasibleSplit(n, actual.rows) : null;
  searching = true;
  const prog = $('#search-prog'); prog.style.display = 'block';
  const bar = $('div', prog);
  $('[data-act="search"]').disabled = true;
  const t0 = performance.now();
  const out = await searchRallies({
    attacker: state.attacker, defenderPrepared: D, heroes: H, pool, capacity, step: +S.step,
    limits, presets: uniq, splitOk, setOk, opts: simOpts(), onProgress: p => { bar.style.width = (p * 100) + '%'; },
  });
  searching = false;
  $('[data-act="search"]').disabled = false;
  prog.style.display = 'none';
  $('#search-info').textContent = `${fmt(out.total)} fights: screened ${fmt(out.combos)} distinct trio + joiner combos, then the best ${out.finalists} across ${out.splits} troop splits · ${fmt((performance.now() - t0) / 1000, 1)}s · capacity ${fmt(capacity)}`;
  lastSearch = { ...out, capacity, D, info: $('#search-info').textContent };
  renderResults();
}

let lastSearch = null;
const presetOf = p => p === 'current' ? state.attacker.leaderPreset : p;
const sideFor = (res) => ({ ...state.attacker, leaderPreset: presetOf(res.preset), joiners: res.joiners.map((h, i) => ({ hero: h, level: res.level[i], troops: {} })) });

function renderResults() {
  const { results, bestByArch, capacity, D } = lastSearch;
  if ($('#search-info')) $('#search-info').textContent = lastSearch.info || '';
  const wins = results.filter(r => r.r.winner === 'attacker').length;
  const row = (x, i) => `<tr>
    <td>${i + 1}</td>
    <td>${x.r.winner === 'attacker' ? '<span class="badge ok">WIN</span>' : x.r.winner === 'defender' ? '<span class="badge bad">loss</span>' : '<span class="badge warn">draw</span>'}</td>
    <td class="small">${esc(x.preset === 'current' ? trioNames(state.attacker) : LEADER_PRESETS[x.preset].label.split(' (')[0])}</td>
    <td class="small">${x.joiners.map(h => `<span class="t-${heroes()[h]?.cls}">${esc(h)}</span>`).join(', ') || '<span class="muted">none</span>'}</td>
    <td>${splitBar(x.split.n)}<span class="small mono">${x.split.pct.inf}/${x.split.pct.cav}/${x.split.pct.arc}</span></td>
    <td class="num">${fmt(x.r.lost[0])}</td><td class="num">${fmt(x.r.lost[1])}</td>
    <td class="num">${fmt(x.r.trade, 2)}</td><td class="num">${(f => `${fmt(f.att.dead)} / ${fmt(f.def.dead)}`)(fightCasualties(x.r, state.casualty))}</td><td class="num">${x.r.rounds}</td>
    <td class="num" data-wr="${i}"><button class="icon" data-act="wr" data-i="${i}" title="Monte Carlo win rate + min troops">check</button></td>
    <td style="white-space:nowrap"><button class="ghost small" data-act="applyres" data-i="${i}" title="Load into Your rally">Use</button> <button class="ghost small" data-act="addwaveres" data-i="${i}" title="Append to the Rally chain">+ Wave</button></td>
  </tr>`;
  $('#search-out').innerHTML = `
    <h2 style="margin-top:14px">What type of rally beats it</h2>
    <div class="archetypes">${ARCHETYPES.map(a => {
      const b = bestByArch[a];
      if (!b) return `<div class="arch"><div class="t">${a}</div><div class="small muted">not possible with the troops you have (needs ≥50% of one type)</div></div>`;
      const w = b.r.winner === 'attacker';
      return `<div class="arch ${w ? 'win' : 'lose'}"><div class="t">${a} ${w ? '<span class="badge ok">can win</span>' : '<span class="badge bad">loses</span>'}</div>
        <div class="small">${b.split.pct.inf}/${b.split.pct.cav}/${b.split.pct.arc} · ${esc(b.preset === 'current' ? trioNames(state.attacker) : LEADER_PRESETS[b.preset].label.split(' (')[0])}</div>
        <div class="small muted">${b.joiners.join(', ') || 'no joiners'}</div>
        <div class="small">${w ? `lose ${fmt(b.r.lost[0])} to kill ${fmt(b.r.lost[1])}` : `kills ${fmt(b.r.lost[1])} of ${fmt(sum(b.r.start[1]))}`}</div></div>`;
    }).join('')}</div>
    <p class="small">${wins ? `<b class="t-cav">${wins}</b> of the top ${results.length} win.` : `<span class="danger">No tested rally beats this target at ${fmt(capacity)} troops.</span> Best attempts below, ranked by trade. Try a larger capacity, more joiners, or check the stats.`}</p>
    <div class="tablewrap"><table>
      <tr><th>#</th><th>Result</th><th>Leaders</th><th>Joiners (counted 4)</th><th>Inf/Cav/Arc %</th><th class="num">You lose</th><th class="num">Enemy lose</th><th class="num">Trade</th><th class="num" title="Permanent deaths under the casualty rules on the Simulate tab">Dead: you / them</th><th class="num">Rds</th><th class="num">Win% · min troops</th><th></th></tr>
      ${results.map(row).join('')}
    </table></div>
    <p class="small muted">Ranked by expected-value sim: wins first (fewest losses), then by trade ratio. "check" runs 300 Monte Carlo fights and finds the smallest rally with that split that still wins.</p>`;
  lastSearch.D = D;
}

function checkResult(i) {
  const x = lastSearch.results[i];
  const H = heroes();
  const cell = $(`[data-wr="${i}"]`);
  cell.textContent = '…';
  setTimeout(() => {
    const side = sideFor(x);
    const wr = winRate(side, H, x.split.n, lastSearch.D, simOpts(), 300);
    const min = minCapacityToWin(side, H, x.split.pct, lastSearch.D, simOpts(), Math.max(lastSearch.capacity * 4, sum(lastSearch.D.troops) * 6));
    cell.innerHTML = `${fmt(wr.winRate * 100, 0)}% · ${min ? fmt(min) : 'never'}`;
  }, 10);
}

// In ratio-entry mode, re-derive ratio + march from troop counts set by code (OCR, Use, plans).
function syncRatio(key) {
  const s = state[key];
  if (s.entryMode !== 'ratio') return;
  [-1, ...s.joiners.map((_, i) => i)].forEach(i => {
    const P = rowPath(key, i);
    const { ratio, march } = troopsToRatio(getPath(P.troops));
    setPath(P.ratio, ratio); setPath(P.march, march);
  });
}

function rosterSummary() {
  const J = state.attacker.joiners;
  if (!J.length) return '<p class="small muted">No joiners on "Your rally" yet.</p>';
  return `<p class="small muted">Each joiner can be given any hero they own (set under <b>Availability</b> on "Your rally"; otherwise their picked hero). The search never gives two heroes to one player.</p>
    <table class="small">${J.map((j, i) => `<tr><td>${esc(j.player || 'Joiner ' + (i + 1))}</td><td>lvl ${j.level}</td><td>${ownedHeroes(j).map(h => `<span class="t-${heroes()[h]?.cls}">${esc(h)}</span>`).join(', ') || '<span class="muted">no hero</span>'}</td></tr>`).join('')}</table>`;
}

function applyResult(i) {
  const x = lastSearch.results[i];
  const a = state.attacker;
  const H = heroes();
  a.leaderPreset = presetOf(x.preset);
  const roster = state.search.poolSource === 'roster';
  const chosen = x.joiners.filter(h => !isNoop(getHero(H, h)));
  // Heroes: roster mode gives each hero to a player who owns it; otherwise the first rows.
  const match = roster ? matchHeroes(chosen, a.joiners) : null;
  while (!roster && a.joiners.length < chosen.length) a.joiners.push({ player: '', hero: '', level: 5, troops: { inf: 0, cav: 0, arc: 0 } });
  const assigned = new Map(); // joiner index -> hero
  chosen.forEach((h, k) => assigned.set(roster && match ? match[k] : k, h));
  a.joiners.forEach((j, k) => {
    if (assigned.has(k)) { j.hero = assigned.get(k); if (!roster) j.level = x.level[x.joiners.indexOf(j.hero)] || 5; }
    else j.hero = ''; // troops only, so they can't push a chosen skill out of the top 4
  });
  // Troops: split the chosen mix across players within their availability.
  const rows = actualArmy(a).rows;
  const alloc = allocate(x.split.n, rows);
  if (alloc) {
    a.leaderTroops = alloc[0];
    a.joiners.forEach((j, k) => { j.troops = alloc[k + 1] || { inf: 0, cav: 0, arc: 0 }; });
  } else {
    const js = { inf: 0, cav: 0, arc: 0 };
    for (const j of a.joiners) for (const t of TYPES) js[t] += +j.troops?.[t] || 0;
    a.leaderTroops = Object.fromEntries(TYPES.map(t => [t, Math.max(0, x.split.n[t] - js[t])]));
  }
  syncRatio('attacker');
  save();
  renderSide('attacker');
  toast(alloc ? 'Loaded: heroes and troops assigned per player within their availability' : 'Loaded: the leader row tops up each type (the split does not fit the per-player limits)');
}

// ---------------- database ----------------
function renderDb() {
  const H = heroes();
  const el = $('#tab-db');
  el.innerHTML = `
  <div class="grid">
    <div class="card wide">
      <h2>The formula</h2>
      <pre class="raw" style="max-height:none;font-size:12px">damage = army_factor × att_per_troop_attacker / def_per_troop_target × type_bonus × SkillMod × fatigue / 100
deaths = ceil(damage)

army_factor   = √(N_squad_attacker × armyMin)        armyMin = min(total_attacker, total_defender), fixed at start
att_per_troop = base_atk × (1+atk%) × 10 × (1+let%) / 100
def_per_troop = 10 × (1+def%) × base_hp × (1+hp%) / 100
type_bonus    = 1.10 when Inf→Cav, Cav→Arc, Arc→Inf (damage only)
SkillMod      = (DamageUp × OppDefenseDown) / (OppDamageDown × DefenseUp)
                each family = ∏ over op codes (1 + Σ same-op values / 100)
fatigue       = 1 − round × 0.0001   (speculative, toggle in header)</pre>
      <p class="small muted">Source: <a href="https://kingshotsim.com/damage-formula" target="_blank" rel="noopener">kingshotsim.com</a> (damage formula, SkillMod, stat bonuses, rally &amp; troops). Regression anchor: 40,233 T10.1 Inf (+293.66% atk, +251.82% let) vs def 2,557.9, armyMin 78,872, SkillMod 1.26 → <b>189</b> deaths.</p>
    </div>
    <div class="card">
      <h2>Troop base stats</h2>
      <p class="small muted">Engine values, not the training-panel numbers. Base Lethality = Defense = 10 everywhere.</p>
      <table class="small"><tr><th>Tier</th>${TYPES.map(t => `<th class="num t-${t}">${t} atk</th><th class="num t-${t}">${t} hp</th>`).join('')}</tr>
        ${TIER_NAMES.map(n => `<tr><td>${n}</td>${TYPES.map(t => `<td class="num">${TROOP_TIERS[n][t].atk}</td><td class="num">${TROOP_TIERS[n][t].hp}</td>`).join('')}</tr>`).join('')}</table>
    </div>
    <div class="card">
      <h2>SkillMod op codes</h2>
      <table class="small"><tr><th>Op</th><th>Family</th><th>Effect</th></tr>
        ${OP_CODES.map(op => `<tr><td class="mono">${op}</td><td>${OPS[op].family}</td><td>${OPS[op].label}</td></tr>`).join('')}</table>
      <p class="small muted">Same op stacks additively, different ops multiply.</p>
    </div>
    <div class="card wide">
      <h2>Heroes &amp; Expedition skills</h2>
      <p class="small muted">Roster, rarity, skill values per level (1→5), base Expedition %, and exclusive gear: <a href="https://kingshotpro.com/data/" target="_blank" rel="noopener">KingshotPro data API</a> (CC-BY-4.0). Op-code mapping is ours. <span class="badge warn">approx</span> = a timed / every-N-turns / extra-hit effect folded into an expected chance. <span class="badge">not modelled</span> = non-combat, or no number published. First skill = joiner skill.</p>
      <div class="row small" style="margin-bottom:8px"><input type="text" id="hero-filter" placeholder="Filter heroes…" style="width:180px" value="${esc(heroFilter)}"></div>
      <div class="tablewrap"><table class="small" id="hero-table">
        <tr><th>Hero</th><th>Class</th><th>Rarity</th><th class="num">Exp. Atk/Def %</th><th>Tiers (rally/garrison/joiner)</th><th>Expedition skills · Lv1 → Lv5</th><th></th></tr>
        ${Object.keys(H).sort((a, b) => (H[a].rarity === 'epic') - (H[b].rarity === 'epic') || (H[a].gen || 0) - (H[b].gen || 0) || a.localeCompare(b)).filter(h => h.toLowerCase().includes(heroFilter.toLowerCase())).map(h => {
          const d = H[h]; const m = kp.meta[h] || {}; const pg = kp.pages[slug(h)] || {};
          const ex = pg.baseStats?.['Expedition attack %'];
          const gear = pg.exclusiveGear?.expedition && Object.keys(pg.exclusiveGear.expedition).length ? `<div class="muted">Excl. gear: ${Object.entries(pg.exclusiveGear.expedition).map(([k, v]) => `${esc(k)} ${v}`).join(', ')}</div>` : '';
          return `<tr><td><b>${esc(h)}</b>${state.customHeroes[h] ? ' <span class="badge gold">custom</span>' : ''}</td>
          <td class="t-${d.cls}">${TYPE_NAMES[d.cls]}</td><td>${esc(d.rarity || '')}${d.gen ? ' · G' + d.gen : ''}</td>
          <td class="num">${ex != null ? fmt(ex, 2) : '—'}${gear}</td>
          <td>${m.rally ? `${esc(m.rally)} / ${esc(m.garrison)} / ${esc(m.joiner)}` : '—'}</td>
          <td>${d.skills.map((sk, k) => `<div>${k === 0 ? '<span class="badge gold" title="joiner skill">J</span> ' : ''}<b>${esc(sk.name)}</b> ${sk.q === 'none' ? `<span class="badge">not modelled</span> <span class="muted">${esc(sk.note)}</span>` : `<span class="mono">${sk.ops.map(([op, lv]) => `${op}: ${lv.join('/')}`).join(' · ')}${sk.chance != null ? ` @ ${Array.isArray(sk.chance) ? sk.chance.join('/') + '%' : sk.chance * 100 + '%'}` : ''}</span>${sk.q === 'approx' ? ` <span class="badge warn" title="${esc(sk.note)}">approx</span>` : ''}`}</div>`).join('')}</td>
          <td>${state.customHeroes[h] ? `<button class="icon danger" data-act="rmhero" data-h="${esc(h)}">✕</button>` : ''}</td></tr>`;
        }).join('')}
      </table></div>
      <p class="small muted">Not in the API: hero stats for each star level (only max-star Expedition %) and combat stats for T6+ troops — the troop table above is from kingshotsim. Your battle report's bonuses already include hero star stats, so the engine doesn't need them.</p>
      <h3 style="margin-top:12px">Add / override a hero (first skill)</h3>
      <div class="row" id="newhero">
        <input type="text" id="nh-name" placeholder="Hero name">
        <select id="nh-cls">${opts(TYPES.map(t => [t, TYPE_NAMES[t]]), 'inf')}</select>
        <label class="small">Chance % <input type="number" id="nh-chance" placeholder="always" style="width:70px"></label>
        <select id="nh-op1">${opts(OP_CODES.map(o => [o, opName(o)]), 102)}</select><input type="number" id="nh-v1" placeholder="% at Lv5">
        <select id="nh-op2">${opts([['', '— second op —'], ...OP_CODES.map(o => [o, opName(o)])], '')}</select><input type="number" id="nh-v2" placeholder="% at Lv5">
        <button class="primary" data-act="addhero">Save hero</button>
      </div>
    </div>
    <div class="card">
      <h2>Governor gear (Atk/Def %)</h2>
      <p class="small muted">Per piece, cumulative. KingshotPro.</p>
      <div class="tablewrap" style="max-height:320px;overflow:auto"><table class="small"><tr><th>Tier</th><th class="num">★</th><th class="num">Attack</th><th class="num">Defense</th></tr>
        ${(kp.gear || []).map(g => `<tr><td>${esc(g.tier)}</td><td class="num">${g.stars}</td><td class="num">${esc(g.bonuses?.attack)}</td><td class="num">${esc(g.bonuses?.defense)}</td></tr>`).join('') || '<tr><td class="muted">loading…</td></tr>'}</table></div>
    </div>
    <div class="card">
      <h2>Governor charm (Let/HP %)</h2>
      <p class="small muted">Stat gained per level and cumulative. KingshotPro.</p>
      <div class="tablewrap" style="max-height:320px;overflow:auto"><table class="small"><tr><th class="num">Level</th><th class="num">+%</th><th class="num">Total %</th></tr>
        ${(() => { let c = 0; return (kp.charm || []).map(r => { c += +r.statIncreasePct || 0; return `<tr><td class="num">${r.level}</td><td class="num">${r.statIncreasePct}</td><td class="num">${fmt(c, 1)}</td></tr>`; }).join(''); })() || '<tr><td class="muted">loading…</td></tr>'}</table></div>
    </div>
    <div class="card wide">
      <h2>Leader trio presets (kingshotsim)</h2>
      <table class="small"><tr><th>Preset</th><th>Op sums (full kit incl. widgets, expected)</th></tr>
        ${Object.values(LEADER_PRESETS).map(p => `<tr><td>${esc(p.label)}</td><td class="mono">${Object.entries(p.ops).map(([o, v]) => `${o}:${v}`).join(' · ') || '—'}</td></tr>`).join('')}</table>
    </div>
  </div>`;
}

// KingshotPro reference data (display only; the engine uses js/heroes-data.js).
const kp = { meta: {}, pages: {}, gear: [], charm: [] };
const slug = h => h.toLowerCase().replace(/[^a-z]+/g, '-');
let heroFilter = '';
async function loadKingshotPro() {
  const get = f => fetch('data/kingshotpro/' + f).then(r => r.ok ? r.json() : null).catch(() => null);
  const [h, pages, gear, charm] = await Promise.all([get('heroes.json'), get('hero_pages.json'), get('gear.json'), get('charm.json')]);
  for (const x of h?.heroes || []) kp.meta[x.name] = x;
  kp.pages = pages || {};
  kp.gear = gear?.upgradeSteps || [];
  const ck = charm && Object.keys(charm).find(k => Array.isArray(charm[k]));
  kp.charm = ck ? charm[ck] : [];
  renderDb();
}

function addHero() {
  const name = $('#nh-name').value.trim();
  const v1 = +$('#nh-v1').value;
  if (!name || !v1) { toast('Name and first op value are required'); return; }
  const lin = v => [1, 2, 3, 4, 5].map(i => +(v * i / 5).toFixed(2));
  const ops = [[$('#nh-op1').value, lin(v1)]];
  if ($('#nh-op2').value && +$('#nh-v2').value) ops.push([$('#nh-op2').value, lin(+$('#nh-v2').value)]);
  const ch = $('#nh-chance').value;
  const chance = ch === '' ? null : Math.min(100, +ch) / 100;
  state.customHeroes[name] = { cls: $('#nh-cls').value, rarity: 'epic', gen: 0, skills: [{ name: 'Custom first skill', ops, chance, q: 'ok', note: 'custom' }] };
  state.search.pool[name] ??= { count: 1, level: 5 };
  save(); renderAll(); toast(`Saved ${name}`);
}

// ---------------- casualty breakdown ----------------
let lastSim = null;
function casualtyCard() {
  const c = state.casualty;
  const custom = c.type === 'custom';
  return `<div class="card wide">
    <h2>Casualties → dead / injured</h2>
    <p class="small muted">The fight runs until one side has no troops left: Kingshot PvP has no round cap or retreat point, so the loser's <b>casualties</b> are 100%. A casualty isn't a death, though. Battle reports split casualties into <b>dead</b>, <b>severely injured</b> (go to the infirmary), and <b>lightly injured</b> (come back on their own). Official rules: when attacking a city, 35% of the attacker's casualties die. Defenders lose nobody until their infirmary is full. The Enlistment Office saves 70% of the attacker's infirmary overflow.</p>
    <div class="row small" style="margin:8px 0">
      <label>Battle type <select data-bind="casualty.type" data-rerender-sim>${opts(Object.entries(CASUALTY_PRESETS).map(([k, v]) => [k, v.label]), c.type)}</select></label>
      <label>Attacker dead % ${numIn('casualty.attDeadPct', `style="width:60px" ${custom ? '' : 'disabled'}`)}</label>
      <label>Defender dead % ${numIn('casualty.defDeadPct', `style="width:60px" ${custom ? '' : 'disabled'}`)}</label>
      <label title="Not published: calibrate it from one of your reports below">Lightly injured % ${numIn('casualty.lightPct', 'style="width:60px"')}</label>
    </div>
    <div class="row small" style="margin-bottom:8px">
      <label title="Combined free infirmary beds of everyone in the rally">Your infirmary space ${numIn('casualty.attInfirmary', 'placeholder="unlimited" style="width:100px"')}</label>
      <label>Target infirmary space ${numIn('casualty.defInfirmary', 'placeholder="unlimited" style="width:100px"')}</label>
      <label class="chk"><input type="checkbox" data-bind="casualty.enlistment" ${c.enlistment ? 'checked' : ''}> Enlistment Office (saves ${c.enlistSavePct}% of your overflow)</label>
    </div>
    <div id="cas-out"></div>
    <details style="margin-top:8px"><summary>Calibrate from one of your battle reports</summary>
      <p class="small muted">Enter one side's numbers from a real report. The dead % and lightly-injured % are computed from them.</p>
      <div class="row small">
        <label>Dead ${numIn('calib.dead', 'style="width:90px"')}</label>
        <label>Severely injured ${numIn('calib.severe', 'style="width:90px"')}</label>
        <label>Lightly injured ${numIn('calib.light', 'style="width:90px"')}</label>
        <span id="calib-out" class="mono"></span>
        <button class="ghost small" data-act="calib" data-to="att">Use for attacker</button>
        <button class="ghost small" data-act="calib" data-to="def">Use for defender</button>
      </div>
    </details>
  </div>`;
}

function refreshCasualties() {
  const out = $('#cas-out');
  if (!out || !lastSim) return;
  const f = fightCasualties(lastSim, state.casualty);
  const surv = i => sum(lastSim.remaining[i]);
  const row = (label, x, i) => `<tr><td>${label}</td><td class="num">${fmt(x.casualties)}</td><td class="num danger">${fmt(x.dead)}${x.overflowDead ? `<div class="small muted">${fmt(x.overflowDead)} from infirmary overflow</div>` : ''}</td><td class="num">${fmt(x.severe)}</td><td class="num">${fmt(x.light)}</td><td class="num">${fmt(x.rescued)}</td><td class="num">${fmt(surv(i))}</td></tr>`;
  out.innerHTML = `<div class="tablewrap"><table>
    <tr><th></th><th class="num">Casualties</th><th class="num">Dead</th><th class="num">Severely injured</th><th class="num">Lightly injured</th><th class="num">Saved by Enlistment</th><th class="num">Survivors</th></tr>
    ${row('Your rally', f.att, 0)}${row('Target', f.def, 1)}
  </table></div>
  <p class="small">Permanent losses: you <b>${fmt(f.att.dead)}</b>, them <b>${fmt(f.def.dead)}</b>${f.deadTrade != null ? ` · dead trade ${fmt(f.deadTrade, 2)}` : ''}.
    ${!f.def.dead && lastSim.lost[1] ? '<span class="muted">The target loses no one for good unless its infirmary overflows, so enter its infirmary space to see real kills.</span>' : ''}</p>`;
  const k = $('#kpi-dead'); if (k) k.textContent = `${fmt(f.att.dead)} / ${fmt(f.def.dead)}`;
  const cal = calibrate(state.calib); const co = $('#calib-out');
  if (co) co.textContent = cal ? `→ dead ${cal.deadPct}% · light ${cal.lightPct}%` : '';
}

// ---------------- rally chain (double / successive rallies) ----------------
let searchTarget = null; // { label, troops }: search against what's left after a wave
const clone = o => JSON.parse(JSON.stringify(o));
const snapshot = side => { const c = clone(side); delete c.name; return c; };
function addWave(side, troops = marchTroops(side).n) {
  const W = state.chain.waves;
  W.push({ name: `Wave ${W.length + 1}`, side, troops: { ...troops }, reinforceTroops: { inf: '', cav: '', arc: '' } });
  save();
  if (current === 'chain') renderChain();
  toast(`Added wave ${W.length} (${trioNames(side)}, ${fmt(sum(troops))} troops)`);
}
function addWaveFromResult(i) {
  const x = lastSearch.results[i];
  const side = snapshot({ ...state.attacker, leaderPreset: presetOf(x.preset), joiners: x.joiners.map((h, k) => ({ player: '', hero: h, level: x.level[k] || 5, troops: { inf: 0, cav: 0, arc: 0 } })) });
  addWave(side, x.split.n);
}
const joinerNames = side => countedJoiners(side.joiners || []).map(j => j.hero).join(', ') || 'no joiners';

function renderChain() {
  const W = state.chain.waves;
  const startD = marchTroops(state.target).n;
  $('#tab-chain').innerHTML = `
  <div class="grid">
    <div class="card wide">
      <h2>Rally chain: double &amp; successive rallies</h2>
      <p class="small muted">Wave 1 hits the garrison from the Target tab. Every later wave hits <b>whatever the previous wave left</b>: same garrison stats, leader trio and joiner skills, fewer troops. Each fight fixes its own armyMin at the start, so a thinned garrison also deals less damage back. A double rally is just 2 waves landing back to back. For timed follow-ups, add the troops the garrison gets back (reinforcements) before a wave.</p>
      <div class="row small"><b>Garrison at start:</b> <span class="mono">${fmt(sum(startD))}</span> ${TYPES.map(t => `<span class="t-${t}">${fmt(startD[t])}</span>`).join(' / ')}
        ${+state.target.cap > 0 ? `<span class="muted">· capacity ${fmt(+state.target.cap)}</span>` : ''} <span class="muted">(edit on the Target tab)</span></div>
    </div>
    <div class="card wide">
      <h2>Waves</h2>
      ${W.length ? `<div class="tablewrap"><table class="small">
        <tr><th>#</th><th>Name</th><th>Leaders · counted joiners</th><th class="num t-inf">Inf sent</th><th class="num t-cav">Cav sent</th><th class="num t-arc">Arc sent</th><th class="num">Garrison reinforced before this wave<br><span class="t-inf">Inf</span> / <span class="t-cav">Cav</span> / <span class="t-arc">Arc</span></th><th></th></tr>
        ${W.map((w, i) => `<tr>
          <td><b>${i + 1}</b></td>
          <td><input type="text" data-bind="chain.waves.${i}.name" value="${esc(w.name)}" style="width:110px"></td>
          <td>${esc(trioNames(w.side))}<div class="muted">${esc(joinerNames(w.side))}</div></td>
          ${TYPES.map(t => `<td class="num">${numIn(`chain.waves.${i}.troops.${t}`)}</td>`).join('')}
          <td class="num" style="white-space:nowrap">${i === 0 ? '<span class="muted">n/a</span>' : TYPES.map(t => numIn(`chain.waves.${i}.reinforceTroops.${t}`, 'placeholder="0" style="width:64px"')).join(' ')}</td>
          <td style="white-space:nowrap">
            <button class="icon" data-act="upwave" data-i="${i}" title="Move up" ${i ? '' : 'disabled'}>↑</button>
            <button class="ghost small" data-act="loadwave" data-i="${i}" title="Open this wave's setup in Your rally to edit it">Edit</button>
            <button class="ghost small" data-act="updwave" data-i="${i}" title="Replace this wave with the current Your rally setup">Update from Your rally</button>
            <button class="icon" data-act="dupwave" data-i="${i}" title="Duplicate">⧉</button>
            <button class="icon danger" data-act="rmwave" data-i="${i}" title="Remove">✕</button></td>
        </tr>`).join('')}
      </table></div>` : '<p class="muted">No waves yet. Add your current rally as wave 1, then add the next one (change leaders/joiners/troops on "Your rally" first, or use "+ Wave" on a search result).</p>'}
      <div class="row" style="margin-top:8px">
        <button class="primary" data-act="addwave">+ Add wave from "Your rally"</button>
        ${W.length ? '<button class="ghost danger" data-act="clearchain">Clear chain</button>' : ''}
      </div>
    </div>
    <div class="card wide" id="chain-out"></div>
    ${chainOptCard()}
  </div>`;
  renderChainResults();
}

let chainTimer = null;
function scheduleChain() { clearTimeout(chainTimer); chainTimer = setTimeout(renderChainResults, 200); }

function renderChainResults() {
  const out = $('#chain-out');
  if (!out) return;
  const W = state.chain.waves;
  if (!W.length) { out.innerHTML = '<h2>Result</h2><p class="muted">Add at least one wave.</p>'; return; }
  const H = heroes();
  const prep = prepareChain({ defender: state.target, waves: W, heroes: H });
  if (!sum(prep.D0.troops)) { out.innerHTML = '<h2>Result</h2><p class="muted">Give the target some troops first.</p>'; return; }
  const c = runChain(prep, simOpts());
  // Casualty split per wave. The target's infirmary fills up across waves (no time to heal).
  const cs = state.casualty;
  let bedsLeft = cs.defInfirmary === '' ? '' : +cs.defInfirmary;
  const waveDead = c.waves.map(w => {
    if (!w.r) return { att: 0, def: 0 };
    const a = splitCasualties(w.r.lost[0], { deadPct: cs.attDeadPct, lightPct: cs.lightPct, infirmary: cs.attInfirmary, enlistSavePct: cs.enlistment ? cs.enlistSavePct : 0 });
    const d = splitCasualties(w.r.lost[1], { deadPct: cs.defDeadPct, lightPct: cs.lightPct, infirmary: bedsLeft });
    if (bedsLeft !== '') bedsLeft = Math.max(0, bedsLeft - d.severe);
    return { att: a.dead, def: d.dead };
  });
  const deadA = waveDead.reduce((x, w) => x + w.att, 0), deadD = waveDead.reduce((x, w) => x + w.def, 0);
  const mc = chainMonteCarlo(prep, 300, simOpts());
  const left = sum(c.final);
  const lastP = mc.breakByWave[mc.breakByWave.length - 1];
  const verdict = c.brokenAt != null
    ? ['win', `Garrison broken on wave ${c.brokenAt + 1}`]
    : ['lose', `Garrison holds after ${W.length} wave${W.length > 1 ? 's' : ''}: ${fmt(left)} troops left (${fmt(left / c.defStartTotal * 100, 1)}%)`];
  const bars = n => splitBar(n) + `<span class="mono small">${fmt(sum(n))}</span>`;
  out.innerHTML = `
    <div class="verdict ${verdict[0]}">${verdict[1]} <span class="small" style="font-weight:400">(expected-value run)</span></div>
    <div class="kpis">
      <div class="kpi"><div class="k">Break chance by last wave (MC ×300)</div><div class="v">${fmt(lastP * 100, 1)}%</div></div>
      <div class="kpi"><div class="k">Your total losses</div><div class="v">${fmt(c.lostA)}</div></div>
      <div class="kpi"><div class="k">Garrison total losses</div><div class="v">${fmt(c.lostD)}</div></div>
      <div class="kpi"><div class="k">Trade (theirs / yours)</div><div class="v">${fmt(c.lostA ? c.lostD / c.lostA : Infinity, 2)}</div></div>
      <div class="kpi"><div class="k">Dead: you / them</div><div class="v">${fmt(deadA)} / ${fmt(deadD)}</div></div>
    </div>
    <div class="tablewrap" style="margin-top:12px"><table class="small">
      <tr><th>Wave</th><th>You sent</th><th>Garrison at start</th><th class="num">armyMin</th><th>Result</th><th class="num">Rds</th><th class="num">You lose</th><th class="num">They lose</th><th class="num">Dead you / them</th><th>Garrison left (Inf / Cav / Arc)</th><th class="num">Broken by now (MC)</th><th></th></tr>
      ${c.waves.map((w, k) => `<tr>
        <td><b>${k + 1}</b> ${esc(w.name)}</td>
        <td>${bars(w.sent)}</td>
        <td>${bars(w.defStart)}${w.reinforced ? `<div class="t-cav">+${fmt(w.reinforced)} reinforced</div>` : ''}</td>
        <td class="num">${w.skipped ? '—' : fmt(w.armyMin)}</td>
        <td>${w.skipped ? `<span class="badge">${esc(w.reason)}</span>` : w.r.winner === 'attacker' ? '<span class="badge ok">breaks it</span>' : w.r.winner === 'defender' ? '<span class="badge bad">rally wiped</span>' : '<span class="badge warn">draw</span>'}</td>
        <td class="num">${w.skipped ? '—' : w.r.rounds}</td>
        <td class="num">${w.skipped ? 0 : fmt(w.r.lost[0])}</td>
        <td class="num">${w.skipped ? 0 : fmt(w.r.lost[1])}</td>
        <td class="num">${fmt(waveDead[k].att)} / ${fmt(waveDead[k].def)}</td>
        <td class="mono">${TYPES.map(t => `<span class="t-${t}">${fmt(w.defLeft[t])}</span>`).join(' / ')} <span class="muted">= ${fmt(sum(w.defLeft))}</span></td>
        <td class="num">${fmt(mc.breakByWave[k] * 100, 0)}%</td>
        <td>${sum(w.defLeft) > 0 ? `<button class="ghost small" data-act="findnext" data-k="${k}" title="Search for the rally that best finishes what this wave left">Find next rally</button>` : ''}</td>
      </tr>`).join('')}
    </table></div>
    <p class="small muted">"Broken by now" is the share of 300 randomized chains (skill procs, cavalry bypass, archer volley rolled per round) where the garrison was empty by that wave. "Find next rally" searches your joiner pool and troops against the garrison left after that wave.</p>`;
}

function findNext(k) {
  const prep = prepareChain({ defender: state.target, waves: state.chain.waves, heroes: heroes() });
  const troops = remainingAfter(prep, k, simOpts());
  searchTarget = { label: `garrison after wave ${k + 1} (${state.chain.waves[k].name})`, troops };
  lastSearch = null;
  show('search');
  toast(`Search target set to what's left after wave ${k + 1}. Press "Find rallies".`);
}

// ---------------- chain optimizer ----------------
let chainPlans = null, chainOptRunning = false;
// Wave templates: existing waves keep their leader account and size; extra waves use "Your rally".
function chainTemplates(n) {
  const W = state.chain.waves;
  const own = actualArmy();
  return Array.from({ length: n }, (_, i) => W[i]
    ? { name: W[i].name, side: W[i].side, capacity: sum({ inf: +W[i].troops.inf || 0, cav: +W[i].troops.cav || 0, arc: +W[i].troops.arc || 0 }), limits: null }
    : { name: `Wave ${i + 1}`, side: snapshot(state.attacker), capacity: own.capacity || sum(sideTroops(state.attacker)), limits: own.limits, rows: own.rows });
}

function chainOptCard() {
  const o = state.chainOpt;
  const T = chainTemplates(+o.waves);
  const poolN = genPool().filter(p => p.count > 0);
  return `<div class="card wide">
    <h2>Optimize the chain</h2>
    <p class="small muted">Finds the joiners and troop split for <b>every wave</b> that break the garrison with the fewest losses on your side. If no plan can break it, it finds the one that leaves the least standing. Each wave keeps its leader account (stats, leader trio) and its size from the waves above. Extra waves use "Your rally". Joiners come from the pool on "Find a winning rally" (${poolN.length} heroes, ${poolN.reduce((a, p) => a + p.count, 0)} players${state.maxGen ? `, up to Gen ${state.maxGen}` : ''}).</p>
    <div class="row small" style="margin:8px 0">
      <label>Waves <select data-bind="chainOpt.waves" data-num data-rerender-chain>${opts([1, 2, 3, 4].map(v => [v, v === 1 ? '1 (single rally)' : v]), o.waves)}</select></label>
      <label class="chk"><input type="radio" name="co-shared" data-bind="chainOpt.shared" value="1" data-bool ${o.shared ? 'checked' : ''}> Double rally: each player joins one wave only</label>
      <label class="chk"><input type="radio" name="co-shared" data-bind="chainOpt.shared" value="" data-bool ${o.shared ? '' : 'checked'}> Successive: players can rejoin every wave</label>
      <label>Split step <select data-bind="chainOpt.step" data-num>${opts([[25, '25%'], [20, '20%'], [10, '10% (slower)']], o.step)}</select></label>
    </div>
    <div class="small muted">${T.map((t, i) => `Wave ${i + 1}: ${esc(trioNames(t.side))} · ${fmt(t.capacity)} troops`).join(' &nbsp;·&nbsp; ')}</div>
    <div class="row" style="margin-top:8px"><button class="primary" data-act="optchain" ${chainOptRunning ? 'disabled' : ''}>Optimize ${o.waves > 1 ? o.waves + '-wave chain' : 'single rally'}</button><span class="small muted" id="co-info"></span></div>
    <div class="progress" id="co-prog" style="display:none"><div></div></div>
    <div id="co-out">${chainPlans ? planHtml() : ''}</div>
  </div>`;
}

async function runChainOpt() {
  if (chainOptRunning) return;
  const H = heroes();
  if (!sum(marchTroops(state.target).n)) { toast('Give the target some troops first'); return; }
  const o = state.chainOpt;
  const templates = chainTemplates(+o.waves);
  if (templates.some(t => !t.capacity)) { toast('Every wave needs troops (set them on "Your rally" or in the waves table)'); return; }
  chainOptRunning = true;
  const prog = $('#co-prog'); prog.style.display = 'block';
  $('[data-act="optchain"]').disabled = true;
  const t0 = performance.now();
  try {
    const plans = await optimizeChain({ defender: state.target, templates, heroes: H, pool: genPool(), shared: !!o.shared, step: +o.step, opts: simOpts(),
      onProgress: p => { const b = $('#co-prog > div'); if (b) b.style.width = (p * 100) + '%'; } });
    // Monte Carlo break chance for the top plans
    chainPlans = plans.slice(0, 3).map(p => {
      const waves = planWaves(p);
      const mc = waves.length ? chainMonteCarlo(prepareChain({ defender: state.target, waves, heroes: H }), 200, simOpts()) : null;
      return { ...p, waves, breakP: mc ? mc.breakByWave[mc.breakByWave.length - 1] : 0 };
    });
    chainPlans.info = `${o.waves} wave${o.waves > 1 ? 's' : ''} · ${o.shared ? 'double rally (players used once)' : 'successive (players rejoin)'} · ${fmt((performance.now() - t0) / 1000, 1)}s`;
  } finally {
    chainOptRunning = false;
  }
  if (current === 'chain') renderChain();
}

const planWaves = p => p.plan.filter(w => !w.skipped).map(w => ({
  name: w.name,
  side: { ...clone(w.side), joiners: w.joiners.map((h, i) => ({ player: '', hero: h, level: w.level[i] || 5, troops: { inf: 0, cav: 0, arc: 0 } })) },
  troops: { ...w.split.n }, reinforceTroops: { inf: '', cav: '', arc: '' },
}));

function planHtml() {
  const start = sum(marchTroops(state.target).n);
  return `<p class="small muted" style="margin-top:10px">${esc(chainPlans.info || '')}</p>` + chainPlans.map((p, i) => `
    <div class="arch ${p.broken ? 'win' : 'lose'}" style="margin-top:10px">
      <div class="row"><span class="t">Plan ${i + 1}: ${p.broken ? `breaks it on wave ${p.brokenAt + 1}` : `garrison keeps ${fmt(sum(p.d))} (${fmt(sum(p.d) / start * 100, 1)}%)`}</span>
        <span class="badge ${p.breakP >= 0.5 ? 'ok' : 'warn'}">${fmt(p.breakP * 100, 0)}% break chance (MC)</span>
        <span class="small">your losses ${fmt(p.lostA)}</span><span class="spacer"></span>
        <button class="ghost small" data-act="useplan" data-i="${i}">Use this plan</button></div>
      <div class="tablewrap"><table class="small">
        <tr><th>Wave</th><th>Leaders</th><th>Joiners</th><th>Inf/Cav/Arc</th><th class="num">Garrison before → after</th><th>Result</th></tr>
        ${p.plan.map((w, k) => w.skipped ? `<tr><td>${k + 1}</td><td colspan="5" class="muted">not needed: garrison already broken</td></tr>` : `<tr>
          <td>${k + 1}</td><td>${esc(trioNames(w.side))}</td>
          <td>${w.joiners.map(h => `<span class="t-${heroes()[h]?.cls}">${esc(h)}</span>`).join(', ') || '<span class="muted">none</span>'}</td>
          <td>${splitBar(w.split.n)}<span class="mono">${fmt(w.split.n.inf)} / ${fmt(w.split.n.cav)} / ${fmt(w.split.n.arc)}</span></td>
          <td class="num">${fmt(sum(w.defStart))} → ${fmt(sum(w.r.remaining[1]))}</td>
          <td>${w.r.winner === 'attacker' ? '<span class="badge ok">breaks it</span>' : '<span class="badge bad">rally wiped</span>'} <span class="muted">−${fmt(w.r.lost[0])}</span></td></tr>`).join('')}
      </table></div>
    </div>`).join('');
}

function usePlan(i) {
  const p = chainPlans?.[i];
  if (!p) return;
  if (state.chain.waves.length && !confirm('Replace the current waves with this plan?')) return;
  state.chain.waves = p.waves.map(w => clone(w));
  save();
  renderChain();
  toast(`Chain set to plan ${i + 1} (${p.waves.length} wave${p.waves.length > 1 ? 's' : ''})`);
}

// ---------------- events ----------------
let current = 'target';
function show(tab) {
  current = tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('on', s.id === 'tab-' + tab));
  if (tab === 'sim') renderSim();
  if (tab === 'search' && !searching) { renderSearch(); if (lastSearch) renderResults(); }
  if (tab === 'chain') renderChain();
}
function renderAll() {
  renderSide('target'); renderSide('attacker'); renderSearch(); renderDb();
  if (current === 'sim') renderSim();
  if (lastSearch) renderResults();
}

document.addEventListener('input', e => {
  if (e.target.id === 'hero-filter') { heroFilter = e.target.value; const pos = e.target.selectionStart; renderDb(); const f = $('#hero-filter'); f.focus(); f.setSelectionRange(pos, pos); return; }
  if (e.target.dataset?.heroToggle) {
    const [k, i] = e.target.dataset.heroToggle.split('.');
    const j = state[k].joiners[+i];
    j.avail ??= {}; const set = new Set(j.avail.heroes || []);
    e.target.checked ? set.add(e.target.value) : set.delete(e.target.value);
    j.avail.heroes = [...set].sort();
    save();
    const sm = $(`[data-hsum="${k}.${i}"]`); if (sm) sm.textContent = 'heroes they can bring: ' + (j.avail.heroes.join(', ') || (j.hero ? j.hero + ' (picked)' : 'none'));
    return;
  }
  const b = e.target.dataset?.bind;
  if (!b) return;
  let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (e.target.dataset.num != null) v = +v;
  if (e.target.dataset.bool != null) v = !!v;
  if (e.target.dataset.parse != null) {
    v = parseNum(v);
    const bad = Number.isNaN(v);
    e.target.classList.toggle('bad', bad);
    e.target.title = bad ? 'Use a number, optionally with K, M or B (e.g. 250k, 1.5M)' : (e.target.classList.contains('qty') && v !== '' ? Number(v).toLocaleString() : '');
    if (bad) return;
  }
  setPath(b, v);
  // Ratio + march entry: keep the troop counts (what the engine uses) in sync.
  const rm = b.match(/^(target|attacker)\.(?:(leader)(?:Ratio\.\w+|March)|joiners\.(\d+)\.(?:ratio\.\w+|march))$/);
  if (rm) { const P = rowPath(rm[1], rm[2] ? -1 : +rm[3]); setPath(P.troops, ratioToTroops(getPath(P.ratio), getPath(P.march))); }
  save();
  const side = b.split('.')[0];
  if (e.target.hasAttribute('data-rerender-search')) renderSearch();
  if (side === 'target' || side === 'attacker') {
    if (e.target.dataset.rerender) renderSide(side); else refreshSide(side);
  }
  if (side === 'chain') scheduleChain();
  if (side === 'chainOpt' && e.target.hasAttribute('data-rerender-chain')) renderChain();
  if (side === 'casualty' || side === 'calib') {
    if (b === 'casualty.type' && CASUALTY_PRESETS[v]?.attDeadPct != null) { state.casualty.attDeadPct = CASUALTY_PRESETS[v].attDeadPct; state.casualty.defDeadPct = CASUALTY_PRESETS[v].defDeadPct; save(); }
    if (e.target.hasAttribute('data-rerender-sim')) renderSim(); else refreshCasualties();
    scheduleChain();
  }
});
document.addEventListener('focusout', e => {
  const el = e.target;
  if (!el.matches?.('input.qty[data-parse]')) return;
  const v = parseNum(el.value);
  if (v !== '' && !Number.isNaN(v)) el.value = formatQty(v);
});
document.addEventListener('change', e => {
  if (e.target.dataset?.rerender) renderSide(e.target.dataset.rerender);
  if (e.target.matches('[data-file]')) handleFiles(e.target.dataset.file, e.target.files);
});
document.addEventListener('click', e => {
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) return show(tabBtn.dataset.tab);
  const drop = e.target.closest('[data-drop]');
  if (drop && !e.target.matches('input')) return $('input[type=file]', drop).click();
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const { act, key } = a.dataset;
  const blankJoiner = () => ({ player: '', hero: '', level: 5, troops: { inf: 0, cav: 0, arc: 0 } });
  if (act === 'swapentry') swapEntry(key);
  if (act === 'toggleavail') { state[key].showAvail = !state[key].showAvail; save(); renderSide(key); }
  if (act === 'addjoiner') { state[key].joiners.push(blankJoiner()); save(); renderSide(key); }
  if (act === 'addjoiners4') { for (let i = 0; i < 4; i++) state[key].joiners.push(blankJoiner()); save(); renderSide(key); }
  if (act === 'rmjoiner') { state[key].joiners.splice(+a.dataset.i, 1); save(); renderSide(key); }
  if (act === 'applyocr') applyOcr(key, +a.dataset.side, a.dataset.to);
  if (act === 'search') runSearch();
  if (act === 'wr') checkResult(+a.dataset.i);
  if (act === 'applyres') applyResult(+a.dataset.i);
  if (act === 'addwaveres') addWaveFromResult(+a.dataset.i);
  if (act === 'cleartarget') { searchTarget = null; lastSearch = null; renderSearch(); }
  if (act === 'addwave') addWave(snapshot(state.attacker));
  if (act === 'dupwave') { const w = state.chain.waves[+a.dataset.i]; state.chain.waves.splice(+a.dataset.i + 1, 0, { ...clone(w), name: w.name + ' (copy)' }); save(); renderChain(); }
  if (act === 'rmwave') { state.chain.waves.splice(+a.dataset.i, 1); save(); renderChain(); }
  if (act === 'upwave') { const i = +a.dataset.i, W = state.chain.waves; if (i > 0) { [W[i - 1], W[i]] = [W[i], W[i - 1]]; save(); renderChain(); } }
  if (act === 'loadwave' && confirm('Replace the setup on "Your rally" with this wave? (Add it as a wave first if you want to keep it.)')) { state.attacker = clone(state.chain.waves[+a.dataset.i].side); syncRatio('attacker'); save(); renderSide('attacker'); show('attacker'); toast('Loaded into "Your rally". Edit it, then use "Update from Your rally" on the chain.'); }
  if (act === 'updwave') { const w = state.chain.waves[+a.dataset.i]; w.side = snapshot(state.attacker); w.troops = { ...marchTroops(state.attacker).n }; save(); renderChain(); toast('Wave updated from "Your rally"'); }
  if (act === 'findnext') findNext(+a.dataset.k);
  if (act === 'calib') { const cal = calibrate(state.calib); if (!cal) { toast('Enter the dead / injured numbers first'); } else { state.casualty.type = 'custom'; state.casualty[a.dataset.to === 'att' ? 'attDeadPct' : 'defDeadPct'] = cal.deadPct; state.casualty.lightPct = cal.lightPct; save(); renderSim(); toast(`Set ${a.dataset.to === 'att' ? 'attacker' : 'defender'} dead ${cal.deadPct}% · lightly injured ${cal.lightPct}%`); } }
  if (act === 'optchain') runChainOpt();
  if (act === 'useplan') usePlan(+a.dataset.i);
  if (act === 'clearchain') { if (confirm('Remove all waves?')) { state.chain.waves = []; save(); renderChain(); } }
  if (act === 'addhero') addHero();
  if (act === 'rmhero') { delete state.customHeroes[a.dataset.h]; save(); renderAll(); }
});
document.addEventListener('dragover', e => { const d = e.target.closest('[data-drop]'); if (d) { e.preventDefault(); d.classList.add('hover'); } });
document.addEventListener('dragleave', e => { const d = e.target.closest('[data-drop]'); if (d) d.classList.remove('hover'); });
document.addEventListener('drop', e => {
  const d = e.target.closest('[data-drop]');
  if (!d) return;
  e.preventDefault(); d.classList.remove('hover');
  handleFiles(d.dataset.drop, [...e.dataTransfer.files].filter(f => f.type.startsWith('image/')));
});
document.addEventListener('paste', e => {
  if (current !== 'target' && current !== 'attacker') return;
  const imgs = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'));
  if (imgs.length) handleFiles(current, imgs);
});

$('#opt-gen').innerHTML = opts([[0, 'All'], ...Array.from({ length: MAX_GEN }, (_, i) => [i + 1, `Gen ${i + 1}`])], state.maxGen);
$('#opt-gen').addEventListener('change', e => { state.maxGen = +e.target.value; save(); lastSearch = null; chainPlans = null; renderAll(); if (current === 'chain') renderChain(); toast(state.maxGen ? `Showing heroes up to Gen ${state.maxGen}` : 'Showing all generations'); });
$('#opt-fatigue').checked = state.fatigue;
$('#opt-fatigue').addEventListener('change', e => { state.fatigue = e.target.checked; save(); if (current === 'sim') renderSim(); });
$('#btn-reset').addEventListener('click', () => { if (confirm('Reset all inputs to defaults?')) { state = defaultState(); save(); lastSearch = null; renderAll(); } });
$('#btn-export').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  a.download = 'kingshot-rally.json'; a.click();
});
$('#btn-import').addEventListener('change', async e => {
  try { state = { ...defaultState(), ...JSON.parse(await e.target.files[0].text()) }; save(); renderAll(); toast('Imported'); }
  catch { toast('Could not read that file'); }
});

function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, { position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', background: 'var(--surf2)', border: '1px solid var(--gold)', padding: '8px 14px', borderRadius: '8px', zIndex: 9, maxWidth: '90vw' });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

renderAll();
loadKingshotPro();
