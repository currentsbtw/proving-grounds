---
name: Proving Grounds
description: Solo Commander playtest trainer; a kneeboard readout floating over a real table of Scryfall card faces.
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
  pane: "rgb(23 24 28 / 84%)"
  pane-strong: "rgb(23 24 28 / 94%)"
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
  hud-inset: "10px"
  hud-frame: "clamp(212px, 19vw, 272px)"
  hud-event: "clamp(300px, 22vw, 320px)"
  hud-drawer: "360px"
  card-w: "round(clamp(84px, min(11vw, 18.6vh), 158px), 1px)"
  table-max: "2000px"
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
  pane:
    backgroundColor: "{colors.pane}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "7px 10px 8px"
  seat-frame:
    backgroundColor: "{colors.pane}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "7px 10px 8px"
    width: "{spacing.hud-frame}"
  bar-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 8px"
    height: "26px"
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

Proving Grounds is a solo Commander playtest trainer. Its readout is a pilot's kneeboard, not an instrument panel: pre-printed small-caps labels sit in the same place every turn, and the current figures are written into them in large tabular numerals. During a run the kneeboard is laid over the table rather than beside it — three opponent frames along the top edge of the board, whatever a seat is telling you hanging under its own frame, and your own numbers as one bar across the foot. The panes are the page's own ground at 84-94% with an 8px backdrop blur and a single hairline: a sheet on the board, never a new surface colour. Card faces from Scryfall are the only imagery and they are never filtered, tinted, or framed beyond a 1px hairline.

The surface is ink on matte. Dark ships by default; light is the same design with swapped token values and is selected by `data-theme="light"` on the root element. Nothing glows, blooms, bevels, or textures. One warm accent is held back for whatever needs an answer now: the seat to hit and the active event's primary response. Everything else is stated in ink and muted ink, and every state is a printed word inside a border, so it survives greyscale and forced colours.

The build refused two things by name and the refusal is durable: the three-column admin shell (seats as sidebar cards, metrics as KPI tiles), and rendered instruments (gauges, needles, lamps, dials, drawn card backs). The threat meter is ten printed segments, filled or outlined, not a dial. An eliminated seat keeps its row and takes a rule through it, so the scan never changes.

**Key Characteristics:**
- Printed label over tabular figure is the unit of every reading, on the readout and on the scorecard alike.
- Ruled rows, not boxes: `border-top` or `border-bottom` hairlines carry structure; fills and four-sided borders are reserved for floating layers and the between-runs rail. A HUD pane is the one four-sided hairline on the play surface, because it is floating.
- One grotesk (IBM Plex Sans 400/500/600) for every heading, figure and label; the serif display face (Marcellus) exists in the wordmark and on the three seat letters, and nowhere else.
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
- **Ground** (`ground`): the page, the live table, the player bar, input fields, the legal footer. The default surface a reading sits on.
- **Pane** (`pane` 84%, `pane-strong` 94%): the same ground at two strengths, used only by the HUD's floating panes with `backdrop-filter: blur(8px)`. `pane` carries the reading panes (seat frames, details, tells), `pane-strong` the ones that hold controls (the active event, the drawer). 84% is the floor at which a frame over a run of card faces still reads as one sheet rather than as text sitting on the art. Both swap with the theme like every other token, so the light HUD is paper rather than tinted glass.
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
- **Display** (400, 18-20px, 1, 0.03em): the wordmark "Proving Grounds" in the title bar, the PROVING GROUNDS mark on the share image, and the seat letter on a HUD frame (20px, 0.06em, in `ink`; 17px in a short window). Nowhere else.
- **Headline** (600, 24-26px, 1.15, -0.01em): the largest figures. Scorecard metric values and seat commander damage (24px); the library count (26px); the verdict word WIN / LOSS in uppercase at 0.12em.
- **Title** (600, 19-22px, 1.05, -0.005em): readout figures. Seat life on a frame (22px, -0.01em); player-bar slot values (19px); the clock sentence one step down (16px). A short window steps these to 19/16/14px.
- **Body** (400, 13px, 1.35): prose, prompts, answer buttons, the deck name in the rail (15px), the scorecard deck name (20px) and verdict sentence (17px, 1.3). Card names and player text are `overflow-wrap: anywhere` with `unicode-bidi: isolate`.
- **Small body** (400, 12px, 1.3-1.4): captions, sub-lines, log rows, trend words, table cells, the legal line, underlined action words.
- **Label** (500, 11px, 1.2, 0.16em, uppercase, muted): the printed label. Block titles (ACTIVE EVENT, the drawer heads), slot labels (TURN, MANA, LIFE), zone heads (LIBRARY, GRAVE), table heads, picker heads. Chips use the same recipe at 0.12em; the bar's tabs at 0.1em; narrow windows tighten chips to 0.06em.
- **Key** (600, 12px): the hotkey square, 18px tall, `rule` border.
- **Mono** (400, 12px, 1.45): the decklist textarea.

All headings h1-h6 are set in the grotesk at 600 with 0.01em tracking. The root declares `font-variant-numeric: tabular-nums lining-nums`, so every figure in the app inherits fixed-width numerals.

### Named Rules
**The Display-Face Rule.** Marcellus names things and never measures them: the wordmark, the share image's mark, and the three seat letters, which are chair names rather than figures and never change. Every heading, figure and verdict is IBM Plex Sans.

**The Tabular Figure Rule.** Every number sits in a printed slot and must not change width as it ticks; tabular lining numerals are set at the root and never overridden. The share image's canvas uses the same face for the same reason.

**The Printed Label Rule.** A label is 11px / 500 / 0.16em / uppercase / muted, above the value it names. Labels are the world's native device (a kneeboard's pre-printed slot names), not decoration: a label exists only where a figure or block needs naming.

## Layout

The shell is a three-row grid: a 44px title bar (38px under 820px of height), the body, and an auto-height legal footer carrying the full Fan Content line. The title bar holds the h1 wordmark, a bordered run chip (deck name, bracket, seed; truncates at the name), and a THEME toggle drawn as a printed label with a key square. The footer is ruled off with a hairline, never truncated.

**Live run.** One full-width column with no gap and no padding, in two rows: the table at `minmax(0, 1fr)` and the player bar at `auto`. The HUD overlay shares the table's grid cell, contributes no height to it, and takes no pointer events except on the panes themselves, so the board stays droppable everywhere a pane is not. The table is `ground` with no border and its own stacking context, so nothing inside it (a hovered hand card lifts to z-index 60) can climb over a pane. Inside it, the battlefield is split into two equal halves by height (nonland permanents above, lands below, a hairline between), and cards are sized to the largest width whose rows fit each half, the card unit at most down to a floor 0.6 of it (never under 84px), after which a half scrolls; it also carries `--hud-top` (82px, 72px in a short window) of top padding so no card is dealt onto the board already hidden under a frame. The bottom strip is `auto minmax(2.86 card units, 1fr) auto`: zone stacks, the hand (never hidden, never narrower than that floor), more stacks. Because the card scales with the window, the five zones and the hand's floor fit by construction at every width down to the declared 820px floor — the strip only gives up its own spacing below 1024px, never its card size. Under 820px — a 1440px screen at 200% zoom reports 720px — the card has bottomed out and the table scrolls horizontally rather than clipping the outer stacks off the edge; the hand keeps its width and the board above is untouched.

**Live HUD.** A three-column grid inset 10px from the board's edges and bounded at `--table-max`, centred over a board that keeps the full window; tracks at `clamp(212px, 19vw, 272px)` with `justify-content: space-between` — seat A left, B centred, C right, at the two ends and the middle of that bounded row rather than of the window, so the three readings stay comparable at a glance on an ultrawide. Row one is the three seat columns: the frame, the detail pane it opens, the seat's tells, and one dashed line per queued event. Row two holds the active event at `clamp(300px, 22vw, 320px)`, placed in the column of the seat that threw it and aligned to that frame's outer edge (`justify-self: start / center / end`), so it never leaves the window; it is one element moved between grid columns rather than between parents, because its reading is a live region. The drawer is a slide-over from the right edge of the board, 360px, `pane-strong`, closed by its own control or Escape; it stays flush with the window's edge rather than the bounded row's, because the tab group that opens it sits at that end of the player bar. The player bar is **one** row at the foot on `ground`, ruled off above and `nowrap` down to 1100px: TURN (with the phase caption), MANA, HAND, TAX, LIFE (swing, four life steps, `undo life`), CLOCK, then a spacer, the two turn buttons, and the tab group (LOG NOTES TOKENS JUDGE KEYS END RUN) in a hairline frame at the right end. A second line put the tabs somewhere the eye had to go looking for them, so the row holds: the spacer collapses first, then CLOCK — the one reading that is a sentence, and so the one allowed to ellipsise — while every other slot keeps its printed width. Only below 1100px does it wrap.

**Card unit.** Every card in the app is one width, `--card-w` in `tokens.css`, registered with `@property` so it resolves to a single length the stylesheet and the TypeScript both read, and rounded to the whole pixel so both read the same integer: `round(clamp(84px, min(11vw, 18.6vh), 158px), 1px)`. It scales with the window between a floor at which a card face is still readable and a cap past which a larger monitor buys more board rather than larger cards — 113px at 1024x768, 141px at 1280x800, the 158px cap at 1440x900 and every window wider than that. The height term is what binds on a short or a wide-and-short window: a 3440x1440 window has no more height than a 2560x1440 one. Card height is never a second token; it is this width times `CARD_ASPECT` (1.396), written as `aspect-ratio: 1 / 1.396` wherever the element is one card wide. The unit is the strip's card, the hand's card, the battlefield's ceiling, and the base for the browse cell (0.9), the battlefield floor (0.6, never under 84px), the hand's fan spacing (0.095 gap, 0.143 minimum step) and the preview panel (twice the unit, held between 240px and 340px). `--table-max` (2000px) is the second half of the rule: the HUD's frame row and the bottom strip's five zones are centred inside it while the battlefield and the ground behind them keep the whole window, so three seat readings and the graveyard-to-command-zone span stay inside one glance on an ultrawide.

**Between runs.** A 280px deck rail and a centre panel, both `surface` panels with a hairline border and 6px radius, 14px internal padding, separated by a 12px gap in 12px page padding. The scorecard lives in the centre panel as ruled sections: a verdict line, metric slots in an auto-fit grid of 170px minimum columns, chart, ledger table, seats, profile.

**Spacing rhythm.** Hairline rules at 1px; 2-4px inside a slot; 6-8px between rows and chips; 12px page gap; 14px panel and block padding; 16px title-bar and overlay padding; 24px column gap between cards on the battlefield. Pointer targets are held to a 24px minimum on the height axis by padding handed back as negative margin, so the printed size of a word or figure never grows to satisfy the target.

## Elevation & Depth

Flat at rest. Depth on the play surface is structural, not tonal: hairline rules separate blocks, and the only fills are the three neutral steps (`ground`, `surface`, `raised`) plus the HUD's two translucent versions of `ground`. Shadows exist only under things that float over the table: the drawer, pickers, pop menus, overlay panels, and a card while it is lifted or hovered in the hand. The HUD's frames and event pane are the exception in the other direction — they float and take no shadow at all, because the blur behind them is what separates them from the board. Selection and focus are 2px rings drawn as `box-shadow: 0 0 0 2px` or `outline: 2px solid`, never a glow.

### Shadow Vocabulary
- **Drawer** (`box-shadow: -10px 0 26px var(--shadow)`): the HUD's slide-over coming in from the right edge of the board.
- **Picker** (`box-shadow: 0 12px 26px var(--shadow)`): the event pane's card picker hanging down over the battlefield.
- **Menu** (`box-shadow: 0 12px 30px var(--shadow-strong)`): fixed-position pop menus on cards and stacks.
- **Overlay panel** (`box-shadow: 0 24px 60px var(--shadow-strong)`): the zone browser and the hotkey reference, over the scrim.
- **Lifted card** (`box-shadow: 0 14px 28px var(--shadow-strong)`): a card mid-drag; the hand hover uses `0 10px 22px var(--shadow-strong)` with a `translateY(-8px) scale(1.06)` lift.
- **Ring** (`box-shadow: 0 0 0 2px`): `accent` for the commander and keyboard focus, `ok` for a selected card, `ink` inset `0 -2px 0` under the open tab in the player bar.

### Named Rules
**The Only Floating Things Cast Shadows Rule.** A surface that sits in the layout has a rule, not a shadow. A surface that is positioned over the table has a shadow from the vocabulary above and nothing else.

**The Settle Rule.** On turn advance the seat frames settle in reading order, left to right: 240ms `cubic-bezier(0.16, 1, 0.3, 1)` from 0.3 opacity and 3px down, staggered 60ms (B) and 120ms (C), replayed by alternating `data-settle` between two identical keyframe names. A new event fades in over 140ms ease-out and the drawer slides 12px in over 140ms; drop targets, hover lifts and the history caret transition in 110-120ms ease. Every animation and transition is disabled by name under `prefers-reduced-motion: reduce`, and the settled state reads the same without it.

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
- **Quiet word:** `undo life`, `dismiss`, `add note`, `close · Esc`: 12px underlined muted text, no border, 24px tall box via padding and negative margin so the row keeps its rhythm.
- **Turn actions:** two equal-width square outlined buttons with a key square inside (Next phase / Space, Next turn / T).
- **Life steps:** -5 -1 +1 +5 as 12px muted text, transparent border that becomes `line` on hover, 24px tall.

### Chips
- **Style:** a word in 11px / 0.12em uppercase, `rule` border, no radius, no fill, `muted` text, 2px 6px.
- **State:** OUT, CLOCK, ARMED n+ and the event's seat chip stay in `rule`/`muted`. HIT is the only accent chip. The player's own OUT is `danger`. The event class chip wears its mana colour on border and text and prints the class name.
- **Between runs:** result chips (WIN in `ok`, LOSS / CONCEDE in `danger`, ABANDONED in `muted`) and ledger event chips are 999px pills with a `currentColor` border.

### Printed Slot (signature)
The unit of every reading. A label (11px / 500 / 0.16em / uppercase / muted) beside or above its figure (19-24px / 600 / tabular); no fill, no side borders, no radius. On the player bar the pairs run along one row (`gap: 4px 14px`, `nowrap` down to 1100px), label then figure then caption on the baseline: LIFE carries its delta in 13px muted (`danger` when down), the four life steps and `undo life`; CLOCK is a sentence at 16px, `danger` when it is the last turn, and prints its seat as the bare letter (`A · T10 · 2 turns`) with the full "Seat A" wording kept in the tooltip and in a visually-hidden span for assistive tech. The scorecard's metric slots are the same element stacked, with a 24px figure, 7px 18px 9px 0 padding and a 1px `line` on `border-top`; an unmeasurable value reads in `muted` at 400 and 16px.

### Seat Frame (signature)
A `pane` over the top edge of the board at `--hud-frame-w` (`clamp(212px, 19vw, 272px)`), 7px 10px 8px, 6px row gap, and one button end to end: nothing inside it is interactive, because the whole of it is the pin target. Its border is `rule` rather than `line` — it is a control edge, and a `line` hairline over a board of card art was not a frame at all — going to `ink` on hover. Line one is the seat letter in Marcellus (20px / 400 / 0.06em, `ink`), life (22px / 600), the `life` caption (dropped below 1100px) and the state chips right-aligned. Three chips do not fit a narrow frame, and CLOCK + HIT is the ordinary pairing because the seat to hit is the clock seat whenever there is one, so below 1280px the HIT chip is dropped — the accent already runs round the whole frame, and the `aria-label` says "the seat to hit" at every width. `.rd-chips` wraps as the floor under that rather than running out of the pane. Line two is the ten-segment threat meter (9px tall segments, `rule` outline, `ink` fill when on, restated in system colours under forced colours), the numeral and the trend word. The frame carries the whole reading in one `aria-label` and everything inside it is `aria-hidden`. The seat to hit takes the HIT chip and the `accent` on the frame's own border. An eliminated seat is 0.6 opacity with a 1px `rule` through line one and never moves.

**Detail pane.** Hover or focus reads it, a click pins it (`aria-expanded`); one seat is pinned at a time and a pinned pane never closes on mouse-out. A `pane` of the same width hanging **out of flow under the whole column** — `position: absolute; top: 100%; z-index: 5` against `.hud-col`, so it opens below the frame, the tells and the queue and covers none of them. Out of flow is the whole point: a detail that took part in the frame grid's row heights pushed the event pane under a *different* seat down by its own height every time the pointer crossed a frame. It holds the silhouette (creatures, power, artifacts, open mana), then `cmdr dmg n/21` with the +1 / +3 buttons, then the four life steps; un-pinned it prints `click to adjust` where the buttons would be.

The one thing it can still reach is the event pane in row two. When the seat that threw the event is the seat whose detail is open, that pane — and only that pane, so no other column moves — steps down past it: `is-under-detail` sets `margin-top: calc(12px + var(--hud-detail-h))`, the height measured by a `ResizeObserver` on the detail because the silhouette wraps and the pinned state adds a row. The event is never raised over the detail instead; the detail holds the buttons, so the detail stays on top.

### Event Pane (signature)
A `pane-strong` at `--hud-event-w` (`clamp(300px, 22vw, 320px)`) with an `accent` border, hung in the frame grid's second row under the seat that threw the event and aligned to that frame's outer edge. 8px 10px 9px, 7px row gap. Head label ACTIVE EVENT in `accent` (muted when only a race clock is standing), then the seat chip and class chip, then the prompt (13px, capped at 2.8em and scrolling inside its slot, printed through `<Glossed>`), then the cited card line (the card name in ink at 13px/500 with an 18px key-square mana-value badge, and the card's true effect in 12px muted clamped to three lines, two in a short window), then two equal-width response buttons whose labels clamp to two lines and carry key squares 1 and 2, then extras (a right-aligned numeric field, a target name clamped to two lines, `add note`). The card picker hangs down over the battlefield on the side the pane is anchored to, in a `surface` panel with the class colour as its border. Everything waiting behind the active event prints under its own seat as a dashed one-line `queued: <class>`, and a seat's tells print under it as a one-line `pane` with a 2px left rule. Both live inside that seat's always-mounted `role="status"` slot: an event landing behind the one in front is news, and outside a live region it was news nobody was told. Neither takes the pointer — a line of text must never be the reason a card under it cannot be hovered or right-clicked — only the hint's `dismiss` button does. With nothing standing the event pane is hidden the visually-hidden way (1px, `clip-path: inset(50%)`, out of flow) rather than collapsed to 0x0, which some screen readers treat as unrendered and which cost the first event of a run its announcement.

**Glossed prose.** Every line of rules text the player reads under the clock goes through `<Glossed>`: the event's prompt, the cited card's effect, and the post-wipe survivor hint. Answer-button labels do not — they are labels, not rules text, and a dotted underline inside the one control the table is waiting on would read as a second thing to click.

### Cards / Containers
- **Pane:** `pane` (or `pane-strong` where it holds controls), 1px border (`line`, or `rule` where the pane is a control edge), no radius, no shadow. The only four-sided border on the play surface. The fill and the `backdrop-filter: blur(8px)` ride on a `::before` at `inset: -1px` with `z-index: -1`, never on the pane element itself: `backdrop-filter` makes an element the containing block for every fixed-position descendant, which silently moved the glossary's fixed keyword tooltip by the pane's own offset. The pseudo-element has no descendants to capture. It falls back to solid `ground` where the blur is unsupported and under forced colours.
- **Panel:** `surface`, 1px `line` border, 6px radius, 14px padding (between-runs rail and centre).
- **Zone stack:** 92px wide, `surface`, 1px `rule` frame, square, 6px padding, printed-label head with a tabular count in `ink`; 80x112 slot in `raised` with a dashed `rule` border when empty; the library is a plain `raised` slab carrying its count at 26px.
- **Card:** 5px radius, `raised` fallback, 1px `line` edge, Scryfall image `object-fit: cover`; tapped rotates 90deg; ghost at 0.32 opacity; an 18px square mana-value badge in `raised` with a `rule` border at the top-right corner.
- **Drawer:** a 360px slide-over from the right edge of the board: `pane-strong`, one hairline on its left edge, drawer shadow, a 7px 14px head ruled off below, 10px 14px body, entering on a 140ms 12px slide.
- **Pop menu:** `surface`, 6px radius, menu shadow, 4px padding, 12px items with 4px radius `raised` hover, printed-label group heads.
- **Overlay:** `scrim` backdrop, 32px padding, `surface` panel up to 1040px (440px for the hotkey reference) with 12px 16px head and 8px 16px foot ruled off.

### Inputs / Fields
- **Style:** `ground` fill, 1px `rule` border, 6px radius, 5px 8px, inherits body type. Numeric fields are right-aligned and tabular (62px wide in the dock, 46px in the token bar). The decklist textarea is `mono` at 12px / 1.45, 220px minimum height.
- **Focus:** `outline: 2px solid var(--accent)`, offset 1px.
- **Error / Warning:** a printed word (ERROR, WARNING) in label type above the message, ruled on the left by 1px `rule`; error text in `danger`, warning in `muted`. Scorecard banners use the same left rule in `ok`, `accent` or `danger`.

### Navigation
- **Title bar:** wordmark, run chip, spacer, THEME toggle; ruled off below by a hairline, no fill of its own.
- **Tabs:** six tabs in a hairline frame at the right of the player bar, 26px tall, 11px / 500 / 0.1em uppercase with 8px sides (6px below 1280px), hairline between tabs, `muted` text going `ink` on hover; the open tab is `ink` with a 2px inset `ink` underline (redrawn as a Highlight border under forced colours). END RUN prints as END below 1100px.
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
- **Do** keep the hand visible at every width and never narrower than 2.86 card units; size every card from `--card-w` and let it, not any one surface, be what gives when the window does.
- **Do** keep the HUD's containers inert and give `pointer-events: auto` to the panes that hold controls alone. A pane that is only a reading — a tell, a queued line — hands the pointer back to the board, and only the controls inside it take it again, so no line of text becomes a lid over the cards beneath it.
- **Do** print a state whose chip has been folded for width somewhere else that survives greyscale (the frame's accent border) and keep the word itself in the `aria-label`.

### Don't:
- **Don't** use Marcellus for anything but a name: the wordmark, the share mark and the seat letters. Headings, verdicts and figures are IBM Plex Sans.
- **Don't** draw instruments: no gauges, needles, lamps, dials, hatched card backs or rendered props. A meter is filled-or-outlined segments.
- **Don't** add glow, bloom, bevels, neon, gradients, textures or paper; no `filter` on any surface, and no `backdrop-filter` anywhere but a HUD pane's `::before`, where it is 8px of blur behind the theme's own ground and never touches a card face. Putting it on the pane element itself makes that pane the containing block for every fixed-position descendant and breaks the glossary tooltips inside it.
- **Don't** box a metric: no KPI tiles with fill, four-sided border and radius on the scorecard or the player bar. A HUD pane is a sheet, not a tile: it fills with the ground itself and carries readings, not one figure.
- **Don't** dim `muted` further with opacity; the token clears AA at full strength and loses it when multiplied.
- **Don't** put a literal hex, rgb or rgba in component CSS, or fork the palette into a script; read the custom properties.
- **Don't** give a seat a second accent chip; CLOCK and ARMED print in `rule`.
- **Don't** make `danger` and `mana-r` the same hue; a life loss and a combat event must read as different signals.
- **Don't** add clicks or modal interruptions to the play loop, or hide the hand to make room.
