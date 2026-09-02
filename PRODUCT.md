# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: Commander (EDH) brewers who do not have a regular pod. They sit alone at a desk with a real decklist (Moxfield/Archidekt/MTGO export) and want to know how the deck behaves under adversity before they buy the cards or spend a game night on it. They are fluent Magic players who already goldfish; the job is "pressure-test this list and tell me what it is weak to."

Secondary (confirmed): competitive/cEDH tuners who do have pods but want repeatable, seeded before/after data on a specific deck edit.

Not an audience: new players learning the rules, and anyone expecting opponents, politics, or multiplayer.

## Product Purpose

Proving Grounds is a solo Commander playtest trainer. The player pilots their real deck at a virtual four-seat table; the app injects adversity events (board wipes, targeted removal, counterspells, combat pressure, a race clock, resource attacks) on a bracket-scaled, seeded schedule, and instruments every action into a run log. From that log it derives a scorecard (deployment curve, wipe recovery, commander downtime, answer rate, threat output, clock, keep quality) and, across runs, a deck profile.

Success: a brewer changes a real decklist because of something the scorecard showed them. Same-seed replay after a deck edit gives a direct A/B comparison; that comparison is the product's sharpest feature.

## Positioning

Pressure-testing without simulated opponents: "flight simulator, not dogfight AI." The app supplies the weather, the pilot still flies the plane. Because the app owns the playtest surface, it can measure and score what the deck actually did under pressure. Moxfield's playtest mode observes nothing and therefore cannot score; Forge/XMage adjudicate rules and therefore never shipped a satisfying Commander experience. Proving Grounds does neither: it is bookkeeping plus adversity plus instrumentation.

## Operating Context

- Solo, local, desktop browser session. Keyboard-fast play is the incumbent expectation (hotkeys D/S/U/Space/T/N, rebindable, `?` overlay).
- A run is: import deck -> pick commander and bracket -> seeded shuffle and mulligan -> play turns under events -> scorecard. Runs typically end around turns 9-12.
- The player resolves everything honestly (honor system). The app never verifies legality; it records what was claimed.
- Card data and imagery come from Scryfall (cache-first via IndexedDB). Decks are built elsewhere and imported.
- Scorecard PNGs are shared to Discord/Reddit as "receipts."
- Fan Content Policy context: the app is free, unofficial, Scryfall-attributed, not endorsed by Wizards of the Coast.

## Capabilities and Constraints

Hard non-goals (policy, not backlog):
- No rules engine. Automation is allowed for bookkeeping only (life, counters, tokens, tax, tap/untap), never for legality or resolution.
- No AI opponents. Seats A/B/C are life totals + threat meters (0-10) + abstract "silhouettes" (creature count/power, artifact/enchantment count, open mana). No card names, no abilities.
- No multiplayer. No deck builder.
- Not a judge of humans; teaches nothing about table politics.

Confirmed capabilities (built as of Sep 1, 2026): M0 goldfish table (six zones, phase stepping, four life totals, commander tax and damage, tokens, counters, append-only undo, run log), M1 pressure layer (six event types, bracket hazard curves, threat meters, silhouettes, race clock with respawn, counterable commander casts), M2 scorecard (seven metrics, timeline chart, event ledger, deck profile with tags, same-seed replay/compare, shareable PNG).

Committed next: M3 advisory judge (LLM grounded in the Comprehensive Rules, cites rule numbers, declines over guessing, advisory only; first backend feature). Ships only at >=95% agreement on a RulesGuru-style eval.

Technical: React + TypeScript + Vite static SPA, Zustand, Dexie/IndexedDB, seeded RNG (same seed = identical run). No accounts, no server, no analytics. Tuning knobs live in data files (`src/data/pressure.ts`, `src/data/scorecard.ts`).

Terminology (use as-is in copy): run, seed, bracket (1-5), seat (A/B/C), threat, silhouette, event, window (opponent window), clock (race clock), wrath/wipe, tax (commander tax), MV (mana value), keep/mull, scorecard, profile, replay, compare.

Undecided product facts:
- Threat meter tuning (rise per window, jump per event, decay per damage) awaits outside-tester feedback.
- Silhouette granularity (aggregate vs per-creature sizes) is open.
- Mobile layout is explicitly "later, only if earned." The desktop shell holds without horizontal scroll down to about 820px wide (audited 2026-09-01); below 1280px the readout column narrows and seat rows fold, below 940px the bottom strip scrolls.
- Monetization is not planned; the name shares a card name and would need a recheck before any monetization.
- Importing opponent decklists to "simulate a pod" (requested 2026-09-01) crosses the no-AI-opponents non-goal. The spec-safe version is list-derived seat pressure profiles: a seat imports a list only to set its threat curve, wipe density and interaction count. Not scheduled.
- Free placement or a snapping grid on the battlefield (requested 2026-09-01). The board is a flow layout; grouping matters more than position. Revisit after more real runs.

## Brand Commitments

- Name: Proving Grounds. Tagline in use: "Goldfishing with adversity injected."
- Voice (confirmed): terse table-talk for fluent EDH players. Game jargon is used freely without explanation (wrath, tax, MV, bracket). Prompts are short imperatives ("Respond or resolve."). Events are attributed to a seat ("Seat B destroys your highest-value creature."). No cheerleading, no filler.
- Event types wear the mana color that most often produces them (W wipe, B removal/resource, U counter, R combat, G clock) as a mnemonic. This is a product convention, not a visual-world decision.
- Legal line must remain: "Unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. Card data and imagery via Scryfall. Not approved or endorsed by Wizards."

## Evidence on Hand

- Design doc (draft 4, Sep 1, 2026) with decision log and M0 feel-test verdict ("not bad" for pure goldfishing; polish list applied).
- Monte-Carlo anchors from the pressure engine at bracket 3: wipe by turn 7 in about 68% of runs, commander removed about 1.4 times per run, clock spawns around turn 9-10.
- A headless scoring harness (`npm run verify:scorecard`) and a share-image harness (`scripts/verify-share-image.ts`).
- No outside testers yet (M1 exit gate pending), no testimonials, no usage data, no real-deck scorecards from other people. Do not fabricate any of these.

## Product Principles

1. Bookkeeping stops at counting, never at legality. Every automation must be justifiable as arithmetic the player would otherwise do on paper.
2. Pressure must read as a game, not a slot machine. Every event has a visible source (a seat, a threat level, a silhouette) and a legible reason.
3. The log is the product. Every mutation is recorded; scoring is derived, never stored raw; same seed reproduces the same run.
4. Faster than Moxfield playtest or nothing else matters. Keyboard-first, no modal interruptions during play, hand always fits.
5. Measure the deck, do not certify it. Honor-system drift is accepted; friction comes from structured respond/resolve, not from enforcement.

## Accessibility & Inclusion

- Keyboard-first play is a requirement, not a nicety: every table action reachable by hotkey, rebindable, with a discoverable overlay.
- Never rely on color alone. Mana-colored event signals (and any threat/status color) must also carry a letter, icon, or text label so color-vision-deficient players can distinguish them.
