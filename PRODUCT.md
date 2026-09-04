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
- No AI opponents. Seats A/B/C are life totals + threat meters (0-10) + abstract "silhouettes" (creature count/power, artifact/enchantment count, open mana). Seats have no decklists and no abilities of their own. Each event does cite one real card (name, mana value, true effect) as the thing the seat cast, chosen from a curated table by the seat's open mana, the bracket and the turn; a citation is attribution for one effect, never a deck. Each seat also carries a seeded archetype profile drawn once at run start (Aggro, Control, Midrange, Combo, Stax, Tokens), so the three seats are three different opponents rather than three copies of the average pod: a profile is a label, a colour identity and a set of event weights, and a seat cites only cards inside its own colours. Still no decklists and no abilities of their own.
- No multiplayer. No deck builder.
- Not a judge of humans; teaches nothing about table politics.

Confirmed capabilities (built as of Sep 1, 2026; the M1, M2 and M3 exit gates were signed off by the owner on Sep 3, 2026, M1 without the outside testers the design doc asked for, which are now post-ship feedback): M0 goldfish table (six zones, phase stepping, four life totals, commander tax and damage, tokens, counters, append-only undo, run log), M1 pressure layer (six event types, bracket hazard curves, threat meters, silhouettes, race clock with respawn, counterable commander casts), M2 scorecard (seven metrics, timeline chart, event ledger, deck profile with tags, same-seed replay/compare, shareable PNG). Stack tray (added Sep 2, 2026): an opt-in manual last-in-first-out tray on the table; the player casts spells to it, pushes named abilities or triggers, and resolves the top item; seat counterspells land on a stacked spell as an item above it. The app records the declared order and hands back one item at a time; it never decides what triggers, who acts next, or legality, and the word "priority" does not appear in copy. Commander's free first mulligan (CR 103.5c) shipped the same day. Event plausibility (added Sep 2, 2026): every wipe, removal, counterspell, resource and clock event cites a real card and fires only when a real card fits the seat's open mana, the bracket and the turn (so no nonland wipe before turn 5); the one-shot tax was replaced by pay-or-punish triggers in the Rhystic Study family (pay N or the seat draws or makes a Treasure).

M3 advisory judge (started Sep 2, 2026, signed off Sep 3, 2026 after live use from the drawer): the first feature with a process outside the browser. Built so far: a local proxy (`npm run judge`, port 5174, loopback only) that reaches `claude-opus-5` through one of two drivers, the Anthropic API (a key in that shell's environment, never the page) or the player's own Claude Code login (no API spend; checked Sep 2, 2026: Claude Code and its headless mode draw from a Pro or Max plan, while the API always bills Console credits, and third parties may not offer claude.ai login to their users, so the shipped judge stays API-keyed and the login path is for the owner), grounds each question in a retrieved excerpt of the Comprehensive Rules (about 12k tokens; the full 250k-token text is a switch for when there is budget) and returns structured answers whose rule citations are checked against that text (an answer with no verifiable citation becomes a decline); a Judge drawer in the readout (hotkey J) that sends the question with a snapshot of the table (battlefield, stack, hand and command zone with oracle text, graveyard and exile names only, never the library); and an eval harness (`npm run eval:build`, `npm run eval:judge`) whose expert answers are Wizards card rulings from Scryfall for 182 Commander staples plus 60 held-out Comprehensive Rules worked examples. Ships only at >=95% agreement with those rulings and 100% verified citations. First full live eval ran Sep 3, 2026 on the `claude-code` driver with retrieval grounding: 160 items (100 Wizards rulings, 60 CR worked examples of which 30 are falsified variants), 156 agree, 3 disagree, 1 decline, 0 errors, 98.1% agreement, all citations verified, gate PASS; about 17 minutes, roughly $33 at API list prices, drawn from the owner's subscription instead. Audit of the misses: two disagreements were eval-set defects (a generated scenario that did not instantiate the ruling's precondition; an answer key that miscounted a mana value), one was the judge re-framing a true CR example as a correction, and the decline was a retrieval miss on delayed triggered abilities (rule 603.7). Fixed the same day: the question generator now requires a precondition check and shown arithmetic; the two defective items are hand-corrected and flagged `handEdited` (kept through `--refresh`, exempt from the self-correction filter in both scripts); the policy prompt confirms-then-caveats on confirm-or-correct questions; retrieval floors rule 603.7's family in on delayed-trigger cues read off the question, the cards it names, the stack tray and the active event (never the whole battlefield, never above the top score); results files fingerprint the policy prompt and retrieval behaviour so a resume only matches the same harness. All four items grade agree on re-run. Re-measured the same day under the draft-7 prompt: 160 items, 158 agree, 2 disagree, 0 declined, 98.75% agreement, all citations verified, 29 of 30 falsified CR examples caught; the two misses were a guessed printed mana cost (neither the eval reference block nor the table snapshot carried mana costs; both carry them now, stack-tray spells included, and the item grades agree on re-run) and a falsified trigger timing the judge named and then confirmed as wording. 18 items were lost to a transient CLI login refresh ("another Claude Code process is refreshing it") and re-run by hand; the harness now retries that collision three times with jittered waits, one waiter at a time, and an explicit `--resume` re-asks the items a finished run left without a verdict. RulesGuru is not used; its license forbids use for validating machine-learning models.

Technical: React + TypeScript + Vite static SPA, Zustand, Dexie/IndexedDB, seeded RNG (same seed = identical run). No accounts, no analytics. The only server is the optional judge proxy, which the player runs on their own machine. Tuning knobs live in data files (`src/data/pressure.ts`, `src/data/scorecard.ts`).

Terminology (use as-is in copy): run, seed, bracket (1-5), seat (A/B/C), threat, silhouette, event, window (opponent window), clock (race clock), wrath/wipe, tax (commander tax), MV (mana value), keep/mull, stack (the stack tray; items are spells, abilities, counterspells; "resolve" pops the top), scorecard, profile (deck profile), profile (seat profile), replay, compare.

Undecided product facts:
- Threat meter tuning (rise per window, jump per event, decay per damage) awaits outside-tester feedback.
- Silhouette granularity (aggregate vs per-creature sizes) is open.
- Mobile layout is explicitly "later, only if earned." The desktop shell holds without horizontal scroll down to about 820px wide (audited 2026-09-01); below 1280px the readout column narrows and seat rows fold, below 940px the bottom strip scrolls.
- Monetization is not planned; the name shares a card name and would need a recheck before any monetization.
- Importing opponent decklists to "simulate a pod" (requested 2026-09-01) crosses the no-AI-opponents non-goal. The spec-safe version is list-derived seat pressure profiles: a seat imports a list only to set its threat curve, wipe density and interaction count. Not scheduled.
- Two sites now route a card by its front-face type, and they are the closest the app comes to resolution automation. The stack tray routes a resolved card (permanent to battlefield, instant or sorcery to graveyard). Binding an answer to a pressure event makes the same read on a card answering out of hand: instant or sorcery to the graveyard, anything else to the battlefield, with no player-chosen-zone fallback yet (a permanent answering with an activated ability moves nothing, which needs no read). This is the same class of type-line read as the battlefield's land row; if real runs show either site guessing wrong (flashback, split cards, spells that make permanents), the fallback is to resolve to a player-chosen zone, and it would have to cover both. A standalone stack lesson mode was considered on Sep 2, 2026 and dropped in favour of the tray inside real runs.
- Persistent tax pieces (Thalia, Sphere of Resistance, Trinisphere) are not modelled; they need a lasting tell and a way to log that the piece was removed. Recorded Sep 2, 2026 as the next step for resource pressure, along with opponent-choice discard (Thoughtseize picks your best card) and showing the cited card's Scryfall face on hover.
- How much table context the judge should read by default (design doc open question). Currently everything the player can see except the library; whether hand contents should be included is untested.
- The confirm-then-caveat rule could bias the judge toward confirming the falsified CR variants; only a full run measures it.
- Free placement or a snapping grid on the battlefield (requested 2026-09-01). The board is a flow layout; grouping matters more than position. Revisit after more real runs.

## Brand Commitments

- Name: Proving Grounds. Tagline in use: "Goldfishing with adversity injected."
- Voice (confirmed): terse table-talk for fluent EDH players. Game jargon is used freely without explanation (wrath, tax, MV, bracket). Prompts are short imperatives ("Respond or resolve."). Events are attributed to a seat ("Seat B destroys your highest-value creature."). No cheerleading, no filler.
- Event types wear the mana color that most often produces them (W wipe, B removal/resource, U counter, R combat, G clock) as a mnemonic. This is a product convention, not a visual-world decision.
- Legal line must remain: "Unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. Card data and imagery via Scryfall. Not approved or endorsed by Wizards."

## Evidence on Hand

- Design doc (draft 4, Sep 1, 2026) with decision log and M0 feel-test verdict ("not bad" for pure goldfishing; polish list applied).
- Monte-Carlo anchors from the pressure engine at bracket 3: wipe by turn 7 in about 68% of runs, commander removed about 1.4 times per run, clock spawns around turn 9-10.
- A headless scoring harness (`npm run verify:scorecard`), a share-image harness (`scripts/verify-share-image.ts`), an offline judge harness (`npm run verify:judge`) and a judge eval harness (`npm run eval:judge`; has run live on Sep 3, 2026 and in mock mode).
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
