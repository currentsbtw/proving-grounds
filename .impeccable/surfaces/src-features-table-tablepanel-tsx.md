---
version: 2
slug: "src-features-table-tablepanel-tsx"
primary_target: "src/features/table/TablePanel.tsx"
related_targets: ["src/App.tsx","src/features/hud/HudPanel.tsx","src/features/pressure/PressureLayer.tsx","src/features/pressure/EventDock.tsx","src/features/scorecard/ScorecardPanel.tsx","src/features/decks/DeckPanel.tsx"]
---

# Surface brief: play surface (table, readout column, pressure, pre-flight, debrief)

Scope: the whole app shell and every surface inside it. Visitor mode: Operate.

Audience and job: fluent Commander players without a pod, piloting a real decklist alone against injected adversity, reading the result afterwards. Task frequency: a run every sitting, many turns per run, one glance per turn at the readout.

Proof/content: the run itself, Scryfall card faces (untouched, always the focus), the run log, the scorecard metrics.

Constraints from the user: never a gaming client (no glow, bloom, bevels, neon, fantasy chrome); never slower to play (no added clicks, hand never hidden, no motion that interrupts); Scryfall imagery stays real; the cockpit idea is liked but literal instruments are not (a previous six-gauge build was rejected as "way too literal"). From PRODUCT.md: keyboard-first, never colour alone, mana-colour mnemonic for event classes, terse table-talk copy, the full Fan Content line.

## Information inventory (settled with the user 2026-09-01)

Every glance, fixed home, readable without leaving the cards:
- turn number, phase, whose window comes next
- own open mana (untapped lands / total lands), cards in hand, commander tax, library count
- own life and its change this turn
- race clock: seat, deadline turn, turns remaining
- active event: seat, class, prompt, two responses on keys 1 and 2, count queued behind it
- tells: counter armed on a seat (threshold), post-wipe survivor hint
- per seat: alive or eliminated, life, threat 0-10 with trend, holds the clock, commander damage dealt
- who to hit: one derived answer (clock holder, else highest threat)

On demand: silhouette per seat (creatures, power, artifacts, open mana); run log and notes; token and counter creation; untap all; life adjust for any seat; hotkey reference; run identity (deck, bracket, seed); end run.

Between runs: deck list, run history, scorecard.

## Direction contract

THESIS: The readout is a kneeboard, not an instrument panel. Pre-printed slots in the same place every turn, filled in with the current numbers, ranked top to bottom by how often the pilot looks. It refuses the three-column admin shell with seats as sidebar cards and metrics as KPI tiles, and it refuses gauges, needles, lamps and any rendered prop.

OWN-WORLD: Ink on matte. Small-caps printed labels above large tabular figures; ruled rows, not boxes; one accent reserved for what needs action now (the active event, the seat to hit). Card faces are the only imagery. Dark and light are both admissible; whichever ships, the other is a token swap, never a redesign. Type: one grotesk family with true tabular numerals for every value; the display face survives only in the wordmark. No texture, no paper, no straps, no dials, no glow.

STORY: The pilot scans the column top to bottom each turn (seats, then own numbers, then the event waiting at the bottom), answers the event on 1 or 2 without leaving the hand, and reads the debrief as the same slots filled in over time with a verdict line on top.

FIRST VIEWPORT: Layout B (Readout), chosen by the user from three placement wireframes on 2026-09-01. During a run: board and hand fill the left, full height, the board split into two equal halves by height (nonland permanents above, lands below; user decision 2026-09-01); one fixed right column about a quarter of the width holds, in order, SEATS (three ruled rows), YOU (turn and phase, mana, hand, tax, library, life with delta, clock) in a scroll region, then a pinned foot that never scrolls: TELLS (counter-armed sentence and post-wipe hint, both live regions; the ARMED chip on the seat row is the only other rendering) and the ACTIVE EVENT with its two responses and queue count; on-demand items sit behind a tab row at the column foot (Log, Notes, Tokens, Keys, End run) that opens a drawer. The deck rail is hidden while a run is live; run identity becomes a chip in the title row. Between runs: deck rail, run history, scorecard as today but restyled to the same slots.

FORM: Kneeboard readout, layout B, derived from the information inventory rather than a dealt direction; code-led. Provenance: concept roll dfaf45d6 was run and its chosen challenger (Night Flight Six-Pack, literal cockpit gauges) was rejected by the user; the approved wireframes and styled mockups are kept under .impeccable/mocks/approved/ with a README.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

Signature interaction: on turn advance the column's values update in reading order with a short settle; reduced-motion shows the settled state.

Memorable moment: the ELIMINATED rule drawn through a seat's row, the row staying in place so the scan never changes.

Responsive floor: the hand never collapses; below 1150px the column narrows before the board does, and the board never drops under 260px of card width.

Unresolved: dark or light as the shipping default (user has no preference); exact grotesk.
