# Kingshot Rally Calculator

A static web app that runs Kingshot Expedition rally-vs-garrison fights on the
[kingshotsim.com damage formula](https://kingshotsim.com/damage-formula). It also searches for
leader trios, joiners and troop splits that beat a target.

```
python3 scripts/serve.py 8765    # then open http://localhost:8765 (no-cache dev server)
node test/anchor.test.js && node test/engine.test.js && node test/numfmt.test.js && node test/chain.test.js && node test/casualties.test.js && node test/chainopt.test.js && node test/army.test.js
```

## Tabs
1. **Target**: upload a battle report or scout screenshot. OCR runs in the browser with
   Tesseract.js and fills the stat bonuses and troop counts. Then set the garrison leader trio
   and the joiners.
2. **Your rally**: the same, for your side. The 4 counted joiners (highest first-skill level,
   ties broken by join order) are highlighted.
3. **Simulate**: an expected-value fight plus a 400-run Monte Carlo win rate, casualties,
   SkillMod families and a round-by-round log.
4. **Find a winning rally**: screens every leader trio × joiner set you can field, then runs
   the best 25 across every troop split. Shows which archetypes can win (Inf-, Cav- or
   Arc-heavy, or Balanced). "check" gives the Monte Carlo win rate and the smallest rally that
   still wins.
5. **Rally chain**: double and successive rallies. Wave 1 hits the Target, and each later wave
   hits what the previous one left: same garrison stats and skills, fewer troops, armyMin
   re-fixed per fight. Optional reinforcements arrive before a wave (capped by garrison
   capacity). Shows per-wave losses, the garrison left, a Monte Carlo "broken by this wave"
   chance, and "Find next rally", which runs the search against the garrison left after that wave.
   "+ Wave" on a search result adds it to the chain. Engine: `js/chain.js`.
   **Optimize the chain** (`js/chainopt.js`) picks joiners and the troop split for every wave
   (1–4 waves) to break the garrison with the fewest losses on your side. Each wave keeps its
   leader account and size; extra waves use "Your rally". In *double rally* mode each player
   joins one wave only. In *successive* mode players can rejoin. It's a beam search: joiner sets
   are screened once per wave template, then the 6 best partial chains are expanded wave by
   wave. The top 3 plans get a Monte Carlo break chance, and "Use this plan" loads one into the
   chain.
6. **Database**: the formula, troop base stats, op codes, heroes and skills, and the gear and
   charm ladders.

## Data
| What | Source | File |
|---|---|---|
| Formula, SkillMod op codes, troop base stats T6–T11, rally rules, kingshotsim joiner values | kingshotsim.com | `js/db.js` |
| Hero roster, Expedition skill values per level, max-star Expedition %, exclusive gear, gear/charm ladders | KingshotPro API (CC-BY-4.0) | `data/kingshotpro/` |
| Skill → op-code mapping (hand-curated) | ours | `js/heroes-data.js` |

Refresh the raw KingshotPro data with `scripts/fetch_kingshotpro.sh`. After a refresh, check
`js/heroes-data.js` for new heroes or changed skills.

## Stats, hero gear and army count
- **Stat source** (per side): either *battle-report totals*, where hero stats and gear are already
  included, or *account only*. With account only, each leader adds to its own troop class:
  Expedition Atk/Def % from its stars, exclusive-gear Let/HP %, and the 4 hero-gear pieces.
  Helga and Amadeus passives apply account-wide. Hero placeholders are max-star values, so type
  your real ones over them.
- **Capacity**: the leader fills first, then joiners in join order. Marches past the rally or
  garrison cap are cut off.
- **Search** uses your real army by default: troops per type from "Your rally", capped by
  capacity. Splits are clamped to what you actually have.
- **Fail-safe**: rare heroes (Edwin, Forrest, Olive, Seth), heroes with a non-combat first skill
  (Diana) and any unknown name still take a joiner/leader slot but have zero effect. In the
  search they only fill slots that real heroes can't.

## Casualties vs deaths
Fights run until one side has no troops left. Kingshot PvP has no round cap or retreat point;
only Bear Hunt caps at 10 rounds. So the loser's **casualties** are always 100%. Casualties are
then split the way battle reports do (`js/casualties.js`, settings on the Simulate tab):
- **Rally on a city:** 35% of the attacker's casualties die. Defenders lose nobody until their
  infirmary is full, and the overflow dies (official Kingshot Combat FAQ).
- **King's Castle / fortress:** all casualties go to the infirmary until it's full.
- **Enlistment Office:** saves 70% of the attacker's overflow. It's inactive when defending.
- **Lightly injured share:** not published. "Calibrate" derives it, and the dead %, from a real
  report.
- **Rally chain:** the target's infirmary fills up across waves.

## Server generation
The **Server gen** selector in the header hides legendary heroes from later generations in every
hero dropdown and in the search's joiner pool. Searches also never try them. Epic, rare and custom
heroes are always shown. The kingshotsim preset trios are disabled when one of their leaders is
above the limit, and both optimizers only use joiners within it. If a hero you already picked is above the limit, it stays selected and is
labelled "(Gen N: above server gen)", so nothing changes behind your back.

## Troop entry & availability
- **⇄ Entry** swaps each troop table between *troop counts* and *ratio % + march size*. The
  other format is always shown on the line underneath (e.g. `= 50% / 20% / 30% · march 200K`).
  Ratios that don't add to 100 are scaled.
- **Availability for the optimizer** (per leader and joiner row): max Inf/Cav/Arc the player can
  send, their march size, and which first heroes they can bring. Empty fields mean "exactly what
  they send now / their picked hero".
- The search ("Use my rally's real army") and the chain optimizer only use troop splits the
  players can actually send. That's an exact check over the per-player caps (`js/army.js`,
  Gale/Hall condition), not just per-type totals.
- **Joiner pool → My rally's joiners**: the search picks one hero per player from the heroes they
  own (bipartite matching).
- **Use** assigns the chosen heroes to the players who own them and divides the troop mix across
  players within their caps (max-flow). Unused joiners become troops-only.

## Number entry
Number boxes accept K/M/B shorthand (`250k`, `1.5M`, `2B`) and separators (`1,200,000`).
Troop and capacity boxes redisplay compactly when you leave them (`40000` → `40K`), and hovering
shows the full number. Invalid entries get a red outline and aren't saved.

## Known gaps / assumptions
- **Not in the KingshotPro API**: hero stats for each star level (only the max-star Expedition
  %), and combat stats for T6+ troops. Report bonuses already include hero star stats, so the
  engine doesn't need them.
- Skills marked `approx` are timed, every-N-turns or extra-hit effects. They are folded into an
  expected per-round chance. Skills marked `not modelled` have no published number.
- Saul and Hilde first-skill values come from kingshotsim, because KingshotPro lists no number.
- Fatigue is speculative and off by default.
- The army factor uses the current squad size each round. armyMin is fixed at the start.
