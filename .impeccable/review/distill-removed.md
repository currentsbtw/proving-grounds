# Distill pass — removed complexity

Surface: play surface (shell, table, readout column, pressure dock) plus the deck
rail and scorecard where the information-architecture and visual-simplification
steps applied. Pass run 2026-09-01 against the settled information inventory in
`.impeccable/surfaces/src-features-table-tablepanel-tsx.md`.

Rule for the pass: the inventory is the floor. Nothing on the "every glance" list
lost its fixed home, and no user decision (layout B, TELLS pinned above the event,
silhouette on demand, the even nonland/land board split, keys 1 and 2, dark default
with light as a token swap, the Fan Content line in full) was touched. What came
out is what said the same thing a second time.

Captures: `distill-1440.png`, `distill-1024.png`, with
`distill-1024-silhouette.png`, `distill-drawer-log-1440.png`,
`distill-drawer-tokens-1440.png`, `distill-rail-1440.png`,
`distill-scorecard-1440.png` and `distill-scorecard-foot-1440.png` covering the
surfaces the removals reach that the two required frames do not.

## Removed

### 1. The phase strip (seven buttons under CLOCK)

`src/features/readout/YouBlock.tsx`, `src/features/readout/readout.css`

Three ways to do one thing. The strip highlighted the current phase, which the
PHASE slot two rows above already printed; and it advanced the phase, which the
`Next phase` button and the Space hotkey already did. It could only ever move
forward, so it added no reach the button lacked — only the ability to skip two
phases in one click, at the cost of seven controls and a second rendering of a
value that has a fixed home.

Kept: the PHASE slot (the reading), `Next phase` with its Space key square, and
the hotkey. That is the smallest set that stays keyboard-first.

Gone with it: `PHASE_SHORT` (the authored narrow abbreviations), `goToPhase`, the
`PHASES` / `phaseIndex` imports, YouBlock's `useMediaQuery` subscription, and
about 55 lines of `.rd-phases` / `.rd-phase` CSS including two media-query blocks.
`NARROW` is now internal to SeatsBlock and no longer exported.

Alternative access point: none needed — Space steps phases, T ends the turn.
Watch for: a player who used the strip to jump from Untap to Main 2 in one click
now presses Space three times.

### 2. The title row's Keyboard button, while a run is live

`src/App.tsx`

The readout's foot tab row already carries KEYS, which calls the same
`toggleHelp`. Two mouse entry points to one overlay, both on screen at once.

Kept: the KEYS tab, the `?` hotkey, and the title-row button *between* runs, where
there is no readout column and it is the only entry point.

### 3. The hand's card count

`src/features/table/TablePanel.tsx`, `src/features/table/table.css`

`HAND 2` over the fan, with `HAND / 2` in the YOU block. The inventory gives
"cards in hand" one fixed home. The zone keeps its printed name; the count reads
once, in the readout.

### 4. "cards" under the library count

`src/features/table/ZoneStack.tsx`, `src/features/table/table.css`

The stack is headed `LIBRARY` and holds one figure. The caption restated the
label. The figure itself stays: it is the stack's own affordance, and the stack is
what you click for draw / shuffle / search.

### 5. The commander tax on the Cast button

`src/features/table/ZoneStack.tsx`

`Cast · Tax 0` became `Cast`. Tax has a fixed home in the YOU block; the button
only has to say what it does. The figure survives in the button's tooltip
(`Cast · commander tax +0`), so a partner pair can still be told apart in place.

### 6. The word "empty" in empty zone slots

`src/features/table/ZoneStack.tsx`, `src/features/table/table.css`

`GRAVE 0` above a slot that also said "empty". The count says it. The slot itself
stays — it holds the strip's height so nothing jumps when the first card arrives.

### 7. Panel headings inside the drawers

`src/features/hud/components/RunLog.tsx`,
`src/features/hud/components/TokenBar.tsx`, `src/features/hud/hud.css`

The drawer head prints the drawer's name; the panel inside then printed it again
("Run log" under "Run log", "Tokens" under "Tokens"). The panels stopped naming
themselves. TokenBar's head row was down to one control after that, so the row
went too and the ×N field carries its own margin.

### 8. One of the two drawer-label maps

`src/features/readout/ReadoutColumn.tsx`

`DRAWER_TITLE` and `TAB_LABEL` held the same four names and differed in one word.
The tab and the head of the drawer it opens now read the same, and the drawer's
accessible name comes from that one string.

### 9. "cmdr dmg" printed twice in a folded seat row

`src/features/readout/SeatsBlock.tsx`

Below 1280px the seat's third line folds into the silhouette disclosure, which
then held the reading (`cmdr dmg 0/21`) and, a few millimetres away, the two
buttons under their own `cmdr dmg` label. Now one label, one reading, two buttons:
`cmdr dmg 0/21 +1 +3`. Verified open at 1024px (`distill-1024-silhouette.png`).

### 10. The unreachable "Run in progress" rail panel

`src/features/decks/DeckPanel.tsx`, `src/features/decks/decks.css`

`DeckPanel` rendered an `ActiveRun` block whenever a run was live — but the deck
rail stands down while a run is live (`App.tsx` mounts `DeckPanel` only when there
is no run), so the branch could not be reached. What it printed (deck name, seed,
turn, bracket) is the title row's run chip. Its copy was also stale: "End the run
from the HUD", and the HUD is gone. Removed with its `.dk-run-name` /
`.dk-run-facts` rules.

### 11. Four scorecard head rows wrapping a single heading each

`src/features/scorecard/ScorecardPanel.tsx`, `src/features/scorecard/scorecard.css`

`<div class="sc-section-head"><h3>…</h3></div>` around Turn by turn, Event ledger,
Seats and Deck profile. The heading is the head row; it now says so directly. The
wrapper survives on Compare, which genuinely has a second child.

### 12. Seat cards inside the Seats card

`src/features/scorecard/scorecard.css`

Each seat sat in its own bordered, filled box inside the bordered, filled Seats
section — a card inside a card. The frames came off; the columns are held by
spacing and their `SEAT A` labels. `is-dead` kept its dimming and lost its
`border-color`; the row already says "eliminated T9 (life)" in words, so nothing
was riding on that colour alone.

### 13. Dead and duplicated CSS

- `.tbl-stack-slot.is-filled` — a class no component has ever set.
- `.tabular` in `base.css` — a second name for `.num`, referenced nowhere.
- `.rd-pair.is-wide` declared twice, four rules apart; merged.
- `.rd-disclose` was a byte-for-byte copy of `.rd-quiet-btn` plus one flex
  property; merged into one selector list with its delta.
- The printed-label recipe (11px / 500 / 1.2 / 0.16em / uppercase / muted) was
  written out twice in `readout.css` and three times in `pressure.css`; each file
  now states it once and keeps only the per-selector deltas.
- `.pg-hud-block > .panel-heading` — orphaned by removal 7.

## Considered and kept

- **The ten-segment threat meter.** It is the same number as the numeral beside
  it, which reads like duplication. It stays: the bar is the cross-seat glance
  (three rows compared without reading), the numeral is the precise value, and the
  bar is shape rather than colour, so it survives greyscale and forced colours. It
  is a printed bar, not the dial or needle the direction contract refuses.
- **The "life" caption on each seat row.** Three rows repeat the word. It is the
  visible label and the accessible name for the figure, and the pre-printed slot is
  the kneeboard idiom. Removing it would trade a label for an aria-label — hiding
  complexity rather than removing it.
- **"untapped lands" under MANA.** It looks like a caption restating a label, but
  it names the unit of the `5/5` fraction (lands, not floating mana). Removing it
  makes the slot ambiguous rather than simpler.
- **The `declare held interaction · answers Seat A's clock` link under an active
  event.** A third route to the clock, but the only one reachable while another
  event holds the card. Removing it would remove the action, not a duplicate.
- **`add note` on the event dock.** It looks like the Notes tab, but it writes the
  note into the event's resolution payload, not the free run log. Different data,
  not a duplicated control.
- **The two identical `rd-settle-a` / `rd-settle-b` keyframe sets.** Byte-identical
  by necessity: alternating the animation *name* is what replays the settle once
  per turn. Merging them would cost more code than it saves.
- **The scorecard's metric tiles.** Boxes inside the scorecard panel, so arguably
  nested cards. De-boxing them is a restyle toward the contract's "restyled to the
  same slots", not a removal, and belongs to that step rather than this one.
- **`undo life`, the life-step buttons, every drawer tab, every hotkey.** Held out
  of scope by the brief.

## Noticed, not changed (out of scope)

- The event prompt copy carries em-dashes ("Seat B strips your hand — discard a
  card of your choice."). Those strings are generated in `src/engine` / `src/data`,
  which this pass does not touch.
- `src/domain/phases.ts` exports `FIRST_PHASE`, `prevPhaseOf`, `isLastPhase` and
  `phaseLabel`; nothing imports them. `src/domain` is outside this pass's scope.
