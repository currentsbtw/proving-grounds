---
version: 1
slug: "src-features-table-tablepanel-tsx"
primary_target: "src/features/table/TablePanel.tsx"
related_targets: ["src/App.tsx","src/features/readout/LiveHud.tsx","src/features/readout/SeatFrame.tsx","src/features/pressure/EventDock.tsx","src/features/scorecard/ScorecardPanel.tsx","src/features/decks/DeckPanel.tsx"]
---

# Surface brief: play surface (table, readout, pressure, pre-flight, debrief)

Scope: the whole app shell and every surface inside it. Visitor mode: Operate.

Audience and job: fluent Commander players without a pod, piloting a real decklist alone against injected adversity, reading the result afterwards. Task frequency: a run every sitting, many turns per run, one glance per turn at the readout.

Proof/content: the run itself, Scryfall card faces (untouched, always the focus), the run log, the scorecard metrics.

Constraints from the user (revised 2026-09-07): no literal instruments (no gauges, needles, dials, lamps, rendered props; a six-gauge build was rejected as "way too literal"); nothing slower to play (no added clicks, hand never hidden, no motion that interrupts). The earlier "never a gaming client" and "dark by default" constraints were released on 2026-09-07. From PRODUCT.md: keyboard-first, never colour alone, mana-colour mnemonic for event classes always printed with the class name, terse table-talk copy, the full Fan Content line.

## Information inventory (settled with the user 2026-09-01)

Every glance, fixed home, readable without leaving the cards:
- turn number, phase, whose window comes next
- own open mana (untapped lands / total lands), cards in hand, commander tax, library count
- own life and its change this turn
- race clock: seat, deadline turn, turns remaining
- active event: seat, class, prompt, two responses on keys 1 and 2, count queued behind it
- tells: counter armed on a seat (threshold), post-wipe survivor hint, standing hate pieces
- per seat: alive or eliminated, life, threat 0-10 with trend, holds the clock, commander damage dealt, archetype and colours
- who to hit: one derived answer (clock holder, else highest threat)

On demand: silhouette per seat (creatures, power, artifacts, open mana); run log and notes; token and counter creation; untap all; life adjust for any seat; hotkey reference; judge drawer; run identity (deck, bracket, seed); end run.

Between runs: deck list, run history, scorecard, hand drill.

## Direction contract

THESIS: Pressure is typographic weather. An event's class word gathers over the seat that cast it, crosses the field, and is spent grey once answered. It refuses the dark client with panels laid over the table, and the kneeboard's printed slots.

OWN-WORLD: Paper-white field. One grotesk is the only mass: 900 for seat names and fronts, 700 tabular figures, 500 tracked labels, 400 prose. Storm black; rain grey for spent things and captions; one silver flash for a word mid-change; mana colours only on class chips beside the class word. No panels, fills or shadows; hairlines where structure needs a rule; the fronts' edges dissolve into scattered small glyphs.

STORY: The pilot reads three names across the top, sees weather form over one of them, answers on 1 or 2 without leaving the hand, and afterwards reads the run as the fronts that passed.

FIRST VIEWPORT: Live run at 1440x900: three seat fronts along the top edge, each name monumental with its readings inside its measure and states as boxed words; the board of untouched faces in two halves by height; the forming class word over the casting seat, above the card rows, never covering a face; the active event in the casting seat's column, ruled off by a 2px rule, responses on 1 and 2; spent events struck through in the left margin; a quiet zone strip and player bar at the foot.

FORM: The Weather, fused from the bolder-register challenger dream-surreal-impossible-worlds-alphabet-storm; seed 47d2c8b0, re-roll 1; code-led. Decision comp: .impeccable/mocks/decision/challenger-dream-surreal-impossible-worlds-alphabet-storm.png.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

Signature interaction: a new event's class word forms over its seat (letters settling from scattered offsets, the last letters in silver flash) in one authored motion, then rolls to its block; an answered event turns rain grey and takes a strike in the margin. Reduced motion shows the formed front and the struck line.

Memorable moment: BOARD WIPE raining over seat B while the board underneath is still whole.

Responsive floor: the hand never collapses; the card unit still scales with the window; below 1280px the seat names step down before the board does; the fronts never cover a card face at any width down to 1024.

Provenance: round 1 (seed 47d2c8b0) assigned The House Mat with The Observer Desk as pick; the user re-rolled bolder on 2026-09-07 and chose The Weather from a hand of Cabinet Screen, Hall Catalog, Weather, Cue Sheet. Mocks of Observer Desk, Cabinet Screen, Hall Catalog and Weather are under .impeccable/mocks/decision/. The Sep 5 silhouette and stamped-scorecard drafts were discarded.

Unresolved: whether a light-only world ships a dark token swap at all (the mock is light only); the exact grotesk (the mock used Archivo).
