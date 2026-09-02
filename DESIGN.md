---
name: Proving Grounds
description: Solo Commander playtest trainer; a kneeboard readout beside a real table of Scryfall card faces.
colors:
  ground: "#17181c"
  surface: "#1f2127"
  raised: "#262932"
  line: "#33353c"
  rule: "#6a6d77"
  ink: "#e8e6e1"
  muted: "#a0a3aa"
  accent: "#c9a85c"
  danger: "#f0899f"
  ok: "#8fc49e"
  mana-w: "#e5d9a5"
  mana-u: "#8fc1e8"
  mana-b: "#bba9c9"
  mana-r: "#e58a76"
  mana-g: "#8fc49e"
typography:
  display:
    fontFamily: "Marcellus, Georgia, 'Times New Roman', serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.03em"
  headline:
    fontFamily: "'IBM Plex Sans', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  title:
    fontFamily: "'IBM Plex Sans', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.005em"
  body:
    fontFamily: "'IBM Plex Sans', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "normal"
  label:
    fontFamily: "'IBM Plex Sans', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.16em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  none: "0"
  panel: "6px"
  card: "5px"
spacing:
  hairline: "1px"
  xs: "4px"
  sm: "8px"
  gap: "12px"
  block: "14px"
  md: "16px"
  titlebar: "44px"
  rail-left: "280px"
  rail-right: "320px"
components:
  button-base:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.panel}"
    padding: "5px 10px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "4px 9px"
  button-answer-primary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "4px 9px 4px 5px"
  button-filled:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ground}"
    typography: "{typography.body}"
    rounded: "{rounded.panel}"
    padding: "5px 10px"
  button-quiet-word:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.none}"
    padding: "0 2px"
    height: "24px"
  chip-state:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "2px 6px"
  chip-hit:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "2px 6px"
  key-square:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.none}"
    padding: "0 4px"
    height: "18px"
    width: "18px"
  input:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.panel}"
    padding: "5px 8px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "14px"
  readout-block:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "6px 14px 7px"
  foot-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 2px"
    height: "34px"
  zone-stack:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    rounded: "{rounded.none}"
    padding: "6px"
    width: "92px"
---

# Design System: Proving Grounds

## Overview

**Creative North Star: "The Kneeboard"**

Proving Grounds is a solo Commander playtest trainer. Its readout is a pilot's kneeboard, not an instrument panel: pre-printed small-caps labels sit in the same place every turn, and the current figures are written into them in large tabular numerals. Blocks are separated by hairline rules across the full width of the sheet, never boxed; the sheet fills the column top to bottom in the order the pilot looks (seats, own numbers, tells, the event waiting for an answer). Card faces from Scryfall are the only imagery and they are never filtered, tinted, or framed beyond a 1px hairline.

The surface is ink on matte. Dark ships by default; light is the same design with swapped token values and is selected by `data-theme="light"` on the root element. Nothing glows, blooms, bevels, or textures. One warm accent is held back for whatever needs an answer now: the seat to hit and the active event's primary response. Everything else is stated in ink and muted ink, and every state is a printed word inside a border, so it survives greyscale and forced colours.

The build refused two things by name and the refusal is durable: the three-column admin shell (seats as sidebar cards, metrics as KPI tiles), and rendered instruments (gauges, needles, lamps, dials, drawn card backs). The threat meter is ten printed segments, filled or outlined, not a dial. An eliminated seat keeps its row and takes a rule through it, so the scan never changes.

**Key Characteristics:**
- Printed label over tabular figure is the unit of every reading, on the readout and on the scorecard alike.
- Ruled rows, not boxes: `border-top` or `border-bottom` hairlines carry structure; fills and four-sided borders are reserved for floating layers and the between-runs rail.
- One grotesk (IBM Plex Sans 400/500/600) for every heading, figure and label; the serif display face (Marcellus) exists in the wordmark only.
- Dark default, light as a pure token swap, including scrim and shadow colours.
- Square chips and key squares on the play surface; 6px radius only on panels, menus and pickers that float.
- Motion is a 240ms settle on turn advance and 110-140ms fades elsewhere, every one of them disabled under reduced motion.

## Colors

A near-black matte with warm off-white ink, one gold accent, two signal colours, and five desaturated mana hues carried as a product mnemonic.

### Primary
- **Brass Accent** (`accent`): the one colour that means "act now". It borders the HIT chip on the seat to attack, the ACTIVE EVENT head label, the primary response button and its key square, the commander's ring on the battlefield, drop targets while dragging, hover borders, and every focus ring (`outline: 2px solid`). It fills exactly one control, the deck rail's Start-run button, whose ink is `ground` so it inverts with the theme. Charts do not use it; bars are drawn in `ink`.

### Secondary
- **Rose Danger** (`danger`): life loss, the losing verdict, the player's own OUT chip, the last-turn clock reading, damage lines in the log, destructive confirmations. Deliberately held a hue away from `mana-r` so a combat event and a life loss on the same screen never read as one signal.
- **Sage OK** (`ok`): the winning verdict, a selected card's ring, +1/+1 counters, answered events in the ledger, "better" deltas in a compare.

### Tertiary (mana mnemonic)
Event classes wear the mana colour that most often produces them. This is a product convention (PRODUCT.md) rather than a visual-world decision, and the colour never travels without its name: the class chip prints BOARD WIPE / REMOVAL / COUNTERSPELL / COMBAT / RACE CLOCK / RESOURCE, the chart prints a letter mark, the log prints the sentence.
- **Parchment White** (`mana-w`): board wipes.
- **Sky Blue** (`mana-u`): counterspells; also the board-size series in the scorecard chart.
- **Dusk Violet** (`mana-b`): targeted removal and resource attacks.
- **Clay Red** (`mana-r`): combat pressure.
- **Sage Green** (`mana-g`): the race clock. Same value as `ok` in dark; distinct roles, so keep both tokens.

### Neutral
- **Ground** (`ground`): the page, the live table, the readout column, input fields, the legal footer. The default surface a reading sits on.
- **Surface** (`surface`): panels between runs, zone stacks, the drawer, pickers, menus, overlay panels.
- **Raised** (`raised`): buttons at rest, library and empty-slot slabs, card-face fallbacks, hover rows, selected history rows.
- **Ink** (`ink`): all figures and prose, the filled threat segments, the open tab's underline, the chart bars.
- **Muted Ink** (`muted`): every printed label, captions, chip text at rest, trend words, secondary buttons' text. Clears AA on every surface it is used on at full strength; it is never additionally dimmed with opacity.
- **Hairline** (`line`): the rule between blocks and rows, panel borders, base button borders, card-face edges. Never carries meaning on its own.
- **Printed Rule** (`rule`): the heavier rule that is a control edge or a printed frame: chip borders, key squares, outlined readout buttons, empty threat segments, input borders, zone-stack frames, the tell's left rule, the strike through an eliminated seat, thin scrollbars. Clears 3:1 non-text contrast where `line` does not.

### Depth colours
- **Scrim** (`rgb(10 11 13 / 72%)` dark, `rgb(43 36 26 / 55%)` light) behind overlays.
- **Shadow** (`rgb(0 0 0 / 30%)` dark, `rgb(74 62 44 / 16%)` light) under the drawer and pickers.
- **Shadow Strong** (`rgb(0 0 0 / 55%)` dark, `rgb(74 62 44 / 30%)` light) under menus, overlay panels and lifted cards.

Light theme values for every token above live in `src/styles/tokens.css` under `:root[data-theme='light']` and in the sidecar's `colorMeta.*.light`.

### Named Rules
**The Token Swap Rule.** Light is not a redesign. Every colour, including scrims and shadows, is a custom property with a value in both theme blocks; no literal hex, rgb or rgba appears in component CSS, and the share image reads the same custom properties at render time. Transparent black is not theme-neutral.

**The One Accent Rule.** `accent` is spent on what needs an answer now (HIT, the active event's head and primary response) and on interaction affordances (focus, hover border, drop target, commander ring). It is not a chart series, not a heading colour, not a second chip on the same seat row. CLOCK and ARMED print in `rule`.

**The Word Inside a Border Rule.** No state is carried by colour alone. A chip is a word with a border; a trend prints "rising"; the threat meter is filled versus outlined; an answered event is struck through. Colour underlines the word, never replaces it.

## Typography

**Display Font:** Marcellus 400 (with Georgia, Times New Roman, serif), self-hosted via `@fontsource/marcellus`.
**Body Font:** IBM Plex Sans 400 / 500 / 600 (with Segoe UI, Helvetica, Arial, sans-serif), self-hosted via `@fontsource/ibm-plex-sans`.
**Mono Font:** ui-monospace stack (SFMono-Regular, Cascadia Mono, Consolas), the decklist paste box only.

**Character:** One grotesk does all the work. Labels are small tracked caps in muted ink; figures are heavy, tight, and tabular, so a number never changes width as it ticks. The serif wordmark is the only thing on screen that is not the grotesk, and the h1 rule in `base.css` has to be overridden to let it through.

### Hierarchy
- **Display** (400, 18px, 1, 0.03em): the wordmark "Proving Grounds" in the title bar, and the PROVING GROUNDS mark on the share image. Nowhere else.
- **Headline** (600, 24-26px, 1.15, -0.01em): the largest figures. Scorecard metric values and seat commander damage (24px); the library count (26px); the verdict word WIN / LOSS in uppercase at 0.12em.
- **Title** (600, 19-22px, 1.05, -0.005em): readout figures. Seat life (22px, -0.01em); YOU slot values (19px); the clock sentence one step down (16px). Narrow columns step these to 20/17px, short windows to 18/16px.
- **Body** (400, 13px, 1.35): prose, prompts, answer buttons, the deck name in the rail (15px), the scorecard deck name (20px) and verdict sentence (17px, 1.3). Card names and player text are `overflow-wrap: anywhere` with `unicode-bidi: isolate`.
- **Small body** (400, 12px, 1.3-1.4): captions, sub-lines, log rows, trend words, table cells, the legal line, underlined action words.
- **Label** (500, 11px, 1.2, 0.16em, uppercase, muted): the printed label. Block titles (SEATS, YOU, TELLS, ACTIVE EVENT), slot labels (TURN, MANA, LIFE), zone heads (LIBRARY, GRAVE), table heads, picker heads. Chips use the same recipe at 0.12em; foot tabs at 0.1em; narrow columns tighten chips to 0.06em.
- **Key** (600, 12px): the hotkey square, 18px tall, `rule` border.
- **Mono** (400, 12px, 1.45): the decklist textarea.

All headings h1-h6 are set in the grotesk at 600 with 0.01em tracking. The root declares `font-variant-numeric: tabular-nums lining-nums`, so every figure in the app inherits fixed-width numerals.

### Named Rules
**The Wordmark-Only Rule.** Marcellus appears on exactly one element in the app and one line of the share image. Every heading, figure and verdict is IBM Plex Sans.

**The Tabular Figure Rule.** Every number sits in a printed slot and must not change width as it ticks; tabular lining numerals are set at the root and never overridden. The share image's canvas uses the same face for the same reason.

**The Printed Label Rule.** A label is 11px / 500 / 0.16em / uppercase / muted, above the value it names. Labels are the world's native device (a kneeboard's pre-printed slot names), not decoration: a label exists only where a figure or block needs naming.

## Layout

The shell is a three-row grid: a 44px title bar (38px under 820px of height), the body, and an auto-height legal footer carrying the full Fan Content line. The title bar holds the h1 wordmark, a bordered run chip (deck name, bracket, seed; truncates at the name), and a THEME toggle drawn as a printed label with a key square. The footer is ruled off with a hairline, never truncated.

**Live run.** Two columns with no gap and no padding: the table `minmax(0, 1fr)` and the readout column at 320px, separated by one hairline. The readout narrows before the board does: 280px below 1280px wide, 250px below 1100px, and 276px when the window is both narrow and shorter than 820px. The table is `ground` with no border. Inside it, the battlefield is split into two equal halves by height (nonland permanents above, lands below, a hairline between), and cards are sized to the largest width whose rows fit each half, 150px maximum down to a 96px floor, after which a half scrolls. The bottom strip is `auto minmax(260px, 1fr) auto`: zone stacks, the hand (never hidden, never under 260px), more stacks. Below 940px the strip scrolls horizontally rather than clipping.

**Readout column.** A flex column: a scroll region holding SEATS and YOU that grows to fill (rules spread inside the blocks rather than leaving a band of nothing), a pinned foot holding TELLS and the ACTIVE EVENT that never scrolls, then a 34px foot tab row (LOG, NOTES, TOKENS, KEYS, END RUN) whose drawer rises to 62% of the column height. Block padding is 6px 14px 7px (10px sides in a narrow column). YOU is two slots per line at 50% width; LIFE and CLOCK are full-width slots. Seat rows are three lines: life and chips, threat meter, on-demand line (the only line allowed to wrap). Below 1280px the "life" caption folds and chips tighten; below 940px and 820px of height, paddings and figure sizes step down so three seats, YOU, TELLS and the event fit a 768px window without sliding under the foot.

**Between runs.** A 280px deck rail and a centre panel, both `surface` panels with a hairline border and 6px radius, 14px internal padding, separated by a 12px gap in 12px page padding. The scorecard lives in the centre panel as ruled sections: a verdict line, metric slots in an auto-fit grid of 170px minimum columns, chart, ledger table, seats, profile.

**Spacing rhythm.** Hairline rules at 1px; 2-4px inside a slot; 6-8px between rows and chips; 12px page gap; 14px panel and block padding; 16px title-bar and overlay padding; 24px column gap between cards on the battlefield. Pointer targets are held to a 24px minimum on the height axis by padding handed back as negative margin, so the printed size of a word or figure never grows to satisfy the target.

## Elevation & Depth

Flat at rest. Depth on the play surface is structural, not tonal: hairline rules separate blocks, and the only fills are the three neutral steps (`ground`, `surface`, `raised`). Shadows exist only under things that float over the table: the drawer, pickers, pop menus, overlay panels, and a card while it is lifted or hovered in the hand. Selection and focus are 2px rings drawn as `box-shadow: 0 0 0 2px` or `outline: 2px solid`, never a glow.

### Shadow Vocabulary
- **Drawer** (`box-shadow: 0 -10px 26px var(--shadow)`): the readout's foot drawer rising over the scroll region.
- **Picker** (`box-shadow: 0 12px 26px var(--shadow)`): the event dock's card picker hanging over the battlefield.
- **Menu** (`box-shadow: 0 12px 30px var(--shadow-strong)`): fixed-position pop menus on cards and stacks.
- **Overlay panel** (`box-shadow: 0 24px 60px var(--shadow-strong)`): the zone browser and the hotkey reference, over the scrim.
- **Lifted card** (`box-shadow: 0 14px 28px var(--shadow-strong)`): a card mid-drag; the hand hover uses `0 10px 22px var(--shadow-strong)` with a `translateY(-8px) scale(1.06)` lift.
- **Ring** (`box-shadow: 0 0 0 2px`): `accent` for the commander and keyboard focus, `ok` for a selected card, `ink` inset `0 -2px 0` under the open foot tab.

### Named Rules
**The Only Floating Things Cast Shadows Rule.** A surface that sits in the layout has a rule, not a shadow. A surface that is positioned over the table has a shadow from the vocabulary above and nothing else.

**The Settle Rule.** On turn advance the readout's values settle in reading order: 240ms `cubic-bezier(0.16, 1, 0.3, 1)` from 0.3 opacity and 3px down, staggered 60ms (YOU) and 120ms (pinned foot), replayed by alternating `data-settle` between two identical keyframe names. A new event fades in over 140ms ease-out; drop targets, hover lifts and the history caret transition in 110-120ms ease. Every animation and transition is disabled by name under `prefers-reduced-motion: reduce`, and the settled state reads the same without it.

## Shapes

Two form languages, assigned by what the element is. Printed things are square: chips, key squares, the readout's outlined buttons, the event's response buttons, the run chip, the theme toggle, zone-stack frames, library and empty-slot slabs, threat segments, the mana-value badge. Panels that float or hold content have a gentle 6px radius: between-runs panels, base buttons and inputs, the deck cards in the rail, pop menus, pickers, overlay panels, and the battlefield's top corners. Card faces keep Scryfall's own corners under a 5px radius and a hairline edge. Empty zone slots are drawn with a dashed `rule` border. The scorecard's result, event-ledger and profile-tag chips and the deck rail's bracket chip are full pills (999px), as are the counter badges on cards; these are the between-runs vocabulary and the play surface does not use them.

Borders do the work of shape: a 1px `line` hairline where the border is structure, a 1px `rule` where the border is a control edge or printed frame, and 1px `accent` where the thing is the one that needs an answer.

## Components

### Buttons
Quiet by default; the loudest button on screen is the one whose border is the accent.
- **Shape:** 6px radius on the base button (`raised` fill, `line` border, 5px 10px); square on the play surface (transparent fill, `rule` border, 4px 9px).
- **Hover:** border to `accent` (base) or to `ink` (title-bar toggle); quiet buttons go `muted` to `ink`. Disabled is 0.45 opacity.
- **Focus:** `outline: 2px solid var(--accent)`, offset 1px, on every button and field.
- **Primary answer:** the event's key-1 response: square, `accent` border, key square in `accent`, hover fills `color-mix(in srgb, var(--accent) 12%, transparent)`.
- **Filled primary:** the deck rail's Start-run only: `accent` fill, `ground` ink at 600, hover `brightness(1.08)`.
- **Quiet word:** `undo life`, `silhouette`, `add note`: 12px underlined muted text, no border, 24px tall box via padding and negative margin so the row keeps its rhythm.
- **Turn actions:** two equal-width square outlined buttons with a key square inside (Next phase / Space, Next turn / T).
- **Life steps:** -5 -1 +1 +5 as 12px muted text, transparent border that becomes `line` on hover, 24px tall.

### Chips
- **Style:** a word in 11px / 0.12em uppercase, `rule` border, no radius, no fill, `muted` text, 2px 6px.
- **State:** OUT, CLOCK, ARMED n+ and the event's seat chip stay in `rule`/`muted`. HIT is the only accent chip. The player's own OUT is `danger`. The event class chip wears its mana colour on border and text and prints the class name.
- **Between runs:** result chips (WIN in `ok`, LOSS / CONCEDE in `danger`, ABANDONED in `muted`) and ledger event chips are 999px pills with a `currentColor` border.

### Printed Slot (signature)
The unit of every reading. A label (11px / 500 / 0.16em / uppercase / muted) 2px above its figure (19-24px / 600 / tabular), the pair ruled off from the row above by a 1px `line` on `border-top`; no fill, no side borders, no radius. Two slots to a line in YOU at 50% width; full-width for LIFE (with its delta in 13px muted, `danger` when down) and CLOCK (a sentence at 16px, `danger` when it is the last turn). The scorecard's metric slots are the same element with a 24px figure and 7px 18px 9px 0 padding; an unmeasurable value reads in `muted` at 400 and 16px.

### Seat Row (signature)
Three ruled lines in SEATS: seat letter (13px / 600 / 0.12em muted) and life (22px / 600), then the chips right-aligned; THREAT label, a ten-segment meter (9px tall segments, `rule` outline, `ink` fill when on, restated in system colours under forced colours), the numeral and the trend word; then commander damage, the `silhouette` disclosure and life steps. An eliminated seat is 0.6 opacity with a 1px `rule` drawn through the top line; the row never moves. The seat to hit carries the HIT chip.

### Event Dock (signature)
A block in the pinned foot, ruled off above, 7px row gap. Head label ACTIVE EVENT in `accent` (muted when the dock is quiet), then the seat chip and class chip, then the prompt (13px, capped at 2.8em and scrolling inside its slot), then two equal-width response buttons whose labels clamp to two lines and carry key squares 1 and 2, then extras (a right-aligned numeric field, a target name clamped to two lines, `add note`). The card picker hangs up and to the left over the battlefield in a `surface` panel with the class colour as its border.

### Cards / Containers
- **Readout block:** `ground`, 6px 14px 7px, `border-bottom: 1px solid var(--line)`; the last block before the foot drops its rule.
- **Panel:** `surface`, 1px `line` border, 6px radius, 14px padding (between-runs rail and centre).
- **Zone stack:** 92px wide, `surface`, 1px `rule` frame, square, 6px padding, printed-label head with a tabular count in `ink`; 80x112 slot in `raised` with a dashed `rule` border when empty; the library is a plain `raised` slab carrying its count at 26px.
- **Card:** 5px radius, `raised` fallback, 1px `line` edge, Scryfall image `object-fit: cover`; tapped rotates 90deg; ghost at 0.32 opacity; an 18px square mana-value badge in `raised` with a `rule` border at the top-right corner.
- **Drawer:** `surface`, hairline top rule, drawer shadow, a 7px 14px head ruled off below, 10px 14px body.
- **Pop menu:** `surface`, 6px radius, menu shadow, 4px padding, 12px items with 4px radius `raised` hover, printed-label group heads.
- **Overlay:** `scrim` backdrop, 32px padding, `surface` panel up to 1040px (440px for the hotkey reference) with 12px 16px head and 8px 16px foot ruled off.

### Inputs / Fields
- **Style:** `ground` fill, 1px `rule` border, 6px radius, 5px 8px, inherits body type. Numeric fields are right-aligned and tabular (62px wide in the dock, 46px in the token bar). The decklist textarea is `mono` at 12px / 1.45, 220px minimum height.
- **Focus:** `outline: 2px solid var(--accent)`, offset 1px.
- **Error / Warning:** a printed word (ERROR, WARNING) in label type above the message, ruled on the left by 1px `rule`; error text in `danger`, warning in `muted`. Scorecard banners use the same left rule in `ok`, `accent` or `danger`.

### Navigation
- **Title bar:** wordmark, run chip, spacer, THEME toggle; ruled off below by a hairline, no fill of its own.
- **Foot tabs:** five equal tabs, 34px tall (30px in a short window), 11px / 500 / 0.1em uppercase, hairline between tabs, `muted` text going `ink` on hover; the open tab is `ink` with a 2px inset `ink` underline (redrawn as a Highlight border under forced colours).
- **Hotkeys:** every action prints its key in a key square beside its label; the `?` overlay lists them in 13px rows with 24px `ground` key chips, 4px radius, `line` border.

### Share Image
A 1200x600 canvas drawn with the same tokens, read from the document's computed custom properties at render time, and the same faces: Marcellus for the PROVING GROUNDS mark only, IBM Plex Sans 400/600 for the deck name, verdict chip and every metric value, with the full Fan Content line at 9px along the foot.

## Do's and Don'ts

### Do:
- **Do** set every reading as a printed slot: label at 11px / 500 / 0.16em uppercase muted, figure at 19px or larger at 600, ruled off above by a 1px `line`.
- **Do** separate blocks and rows with one hairline on one side; a surface in the layout has a rule, not a box.
- **Do** keep chips, key squares and readout buttons square with a 1px `rule` border; keep the 6px radius for panels, menus and pickers.
- **Do** print the word for every state (OUT, HIT, rising, struck-through) and let colour underline it.
- **Do** spend `accent` on the one thing that needs an answer and on focus, hover and drop affordances only.
- **Do** declare every colour, including scrims and shadows, in `tokens.css` with a value in both theme blocks, and use `color-mix()` for tints.
- **Do** hold pointer targets to 24px on the height axis with padding and negative margin, leaving the printed size alone.
- **Do** disable every animation and transition by name under `prefers-reduced-motion`, and make sure the settled state reads the same.
- **Do** keep the hand visible at every width and the board above 260px of card width; narrow the readout first.

### Don't:
- **Don't** use Marcellus anywhere but the wordmark; headings, verdicts and figures are IBM Plex Sans.
- **Don't** draw instruments: no gauges, needles, lamps, dials, hatched card backs or rendered props. A meter is filled-or-outlined segments.
- **Don't** add glow, bloom, bevels, neon, gradients, textures or paper; no `filter` or `backdrop-filter` on any surface, and never on a card face.
- **Don't** box a metric: no KPI tiles with fill, four-sided border and radius on the scorecard or the readout.
- **Don't** dim `muted` further with opacity; the token clears AA at full strength and loses it when multiplied.
- **Don't** put a literal hex, rgb or rgba in component CSS, or fork the palette into a script; read the custom properties.
- **Don't** give a seat a second accent chip; CLOCK and ARMED print in `rule`.
- **Don't** make `danger` and `mana-r` the same hue; a life loss and a combat event must read as different signals.
- **Don't** add clicks or modal interruptions to the play loop, or hide the hand to make room.
