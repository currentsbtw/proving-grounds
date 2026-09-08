---
name: Proving Grounds
description: Solo Commander playtest trainer; pressure is typographic weather on a paper-white field, one grotesk over untouched card faces.
colors:
  ground: "#f6f5f1"
  raised: "#efeee9"
  line: "#d9dbde"
  rule: "#101010"
  ink: "#101010"
  muted: "#6b6f76"
  rain: "#b9bdc4"
  silver: "#d8dde3"
  danger: "#9c1f45"
  ok: "#2f6b45"
  mana-w: "#6f6224"
  mana-u: "#275b80"
  mana-b: "#57406d"
  mana-r: "#9d3b1f"
  mana-g: "#2f6b45"
  mana-c: "#454c56"
  scrim: "rgb(246 245 241 / 78%)"
  night-ground: "#101010"
  night-raised: "#1a1a1a"
  night-line: "#2a2c30"
  night-ink: "#f6f5f1"
  night-muted: "#a2a6ad"
  night-rain: "#4f5358"
  night-silver: "#6d737b"
  night-danger: "#f0899f"
  night-ok: "#8fc49e"
typography:
  front:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "min(76px, calc(var(--hud-frame-w) / var(--pgf-n) * 1.3))"
    fontWeight: 900
    lineHeight: 0.8
    letterSpacing: "0.025em"
  monumental:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "min(64px, calc(var(--hud-frame-w) / var(--name-chars) * 1.25))"
    fontWeight: 900
    lineHeight: 0.78
    letterSpacing: "-0.02em"
  figure-l:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "32px"
    fontWeight: 700
    lineHeight: 0.78
    letterSpacing: "-0.015em"
  figure-m:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.01em"
  figure-s:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1
  headline:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "normal"
  small:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.35
  label:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.16em"
  chip:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.16em"
  key:
    fontFamily: "'Archivo Variable', 'Archivo', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  none: "0"
  card: "5px"
spacing:
  hairline-gap: "6px"
  row: "8px"
  block: "10px"
  gap: "12px"
  panel: "14px"
  shell: "16px"
components:
  button-plate:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "4px 8px 4px 5px"
  button-edge:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "5px 10px"
  button-edge-hover:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
  button-word:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.small}"
    rounded: "{rounded.none}"
    padding: "0 2px"
  chip-state:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.chip}"
    rounded: "{rounded.none}"
    padding: "2px 6px"
  key-square:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.key}"
    rounded: "{rounded.none}"
    padding: "0 4px"
    height: "18px"
  input-field:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "5px 8px"
  sheet:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "10px 12px 11px"
  card-face:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.card}"
---

# Design System: Proving Grounds

## Overview

**Creative North Star: "The Weather"**

Pressure is typographic weather. The whole app is one paper-white field with one grotesk on it, and the only mass on screen is type: three seat names set monumental across the top of the board, each seat's readings sitting inside its own name's measure, and an event's class word (BOARD WIPE, REMOVAL, COUNTERSPELL, COMBAT, RACE CLOCK, RESOURCE, HATE PIECE) gathering over the seat that cast it, coming apart into a short rain of its own letters, then turning rain grey with a strike once it is answered or resolved. The Scryfall card faces are the only image in the world and are never treated; the type stands beside and above them, on the same paper.

Nothing here is a panel. There are no fills, no shadows, no radii, no gradients, no blur and no glass. Structure is a 1px hairline where a block needs a rule, a 2px ink rule where a block is the one thing asking to be read, and exactly one reversed ink plate per screen (the active event's key-1 response during a run; the deck rail's Start run between runs). Emphasis is weight, tracking and that one plate; "act now" is not a colour. The world admits two hues, danger and ok, and both always print their word. Mana colours exist only as a mnemonic beside the word or letter they name.

Density is a reading, not a dashboard: every figure is lining and tabular, sized by rank (32 / 24 / 19 at 700), labelled by an 11px tracked caption beside or under it, and the whole HUD stands in the board's own margins rather than in a rail. The night field (`data-theme="dark"`) is the same design with every token swapped; no rule anywhere knows which theme is up. Confirmed anti-references: the previous "Kneeboard" world (dark matte, IBM Plex Sans with a Marcellus wordmark, brass accent, translucent HUD panes, printed label-over-figure slots), literal instruments of any kind (gauges, needles, dials, lamps, rendered props), and the dark gaming client with panels laid over the table.

**Key Characteristics:**
- One surface: `--ground` is every surface, including the board, the strip, the rail, inputs and overlays; `--surface` equals `--ground` by design.
- One family: Archivo Variable (self-hosted, wdth build), 400 through 900; weight, size and tracking carry rank.
- One rule, one plate: a single 2px storm rule and a single reversed ink plate per screen.
- Two hues plus mnemonics: `--danger` and `--ok` always beside their word; mana colours only beside the class word or colour letter.
- No depth at all: `--shadow` tokens resolve to transparent; a floating thing is separated by a 1px border on opaque paper.
- Weather is the only authored motion: the forming front (560ms), its rain, its strike, and the fronts' settle on turn advance (240ms).

## Colors

A paper field and a storm-black ink, two greys for time (muted for captions, rain for what has passed), one silver for a word mid-change, two signal hues that always print their word, and six mana mnemonics.

### Primary
- **Storm Ink** (`--ink`, `#101010`): every figure, name, prose line and control edge, the filled threat cells, the focus ring, the one reversed plate's fill. `--accent` and `--rule` are both this same value on purpose: the accent of this world is ink at full weight, and a rule is drawn with the same black as the type.

### Neutral
- **Paper** (`--ground`, `#f6f5f1`): the field. Also `--surface`, `--pane` and `--pane-strong` (opaque, 100%); the blocks that must occlude a card face (the event sheet, a seat's detail, the drawer, pickers, overlays) are the paper itself, fully opaque, never blurred.
- **Raised Paper** (`--raised`, `#efeee9`): the single tonal step, spent only where a slab must read as a slab with no border: a missing card face, the library slab, a hovered row or button, a key square at rest.
- **Hairline** (`--line`, `#d9dbde`): the 1px rule that separates blocks and edges a card face; carries no meaning.
- **Caption Grey** (`--muted`, `#6b6f76`): labels, captions, secondary prose, resting title-bar controls. Clears 4.5:1 on paper; never dimmed further.
- **Rain** (`--rain`, `#b9bdc4`): spent things only: an answered event's word and its strike, the PASSED margin strip, an eliminated seat's name and readings. Never live prose.
- **Silver** (`--silver`, `#d8dde3`): the flash on the last letters of a word still forming. A motion state; it never carries information on its own.
- **Mist** (`--scrim`, `rgb(246 245 241 / 78%)`): the ground at 78% behind an overlay, so an overlay reads as the page continuing rather than a dark box.

### Signals
- **Loss** (`--danger`, `#9c1f45`): life leaving (the player bar's delta, life and damage log lines), the losing verdict, END RUN and Delete words, the scorecard banner text after the word ERROR. Never a resting button's fill.
- **Win** (`--ok`, `#2f6b45`): the winning verdict and the Win choice at end of run, answered events in the ledger.

### Mana mnemonics
- **W / U / B / R / G / C** (`--mana-w #6f6224`, `--mana-u #275b80`, `--mana-b #57406d`, `--mana-r #9d3b1f`, `--mana-g #2f6b45`, `--mana-c #454c56`): the event-class chip's 10px swatch (wipe W, removal and resource B, counter U, combat R, clock G, hate piece C), the 2px top rule of the answer picker that hangs under that chip, a seat's colour letters on its front, the log's class words, and the scorecard timeline's event marks. Always beside the class word or the letter it names.

### Night field
Under `data-theme="dark"` every token swaps and nothing else changes: ground `#101010`, raised `#1a1a1a`, line `#2a2c30`, ink and rule and accent `#f6f5f1`, muted `#a2a6ad`, rain `#4f5358`, silver `#6d737b`, danger `#f0899f`, ok `#8fc49e`, mana lifted to `#e5d9a5 / #8fc1e8 / #bba9c9 / #e58a76 / #8fc49e / #ccd0d8`, scrim `rgb(16 16 16 / 78%)`. Paper ships by default; the choice is stored under `pg-theme-v2`.

### Named Rules
**The One Plate Rule.** Exactly one element per screen is reversed (ink fill, paper letters, 2px ink edge): the active event's key-1 response during a run, the deck rail's Start run between runs. The answer picker's picked row reverses only while the picker is open on its own. Nothing else on the field carries a fill.

**The Word Beside It Rule.** No colour stands alone. Danger and ok print beside their word (LIFE -5, WIN, ERROR); a mana colour appears only as a swatch or letter next to the class word or colour letter it names; a spent front is grey and struck, an eliminated seat is grey and struck and says OUT.

**The Rain Rule.** `--rain` marks what has passed and nothing else. Anything the player still has to act on is set in ink or muted.

## Typography

**Display Font:** Archivo Variable at 900 (with Archivo, Segoe UI, Helvetica, Arial, sans-serif)
**Body Font:** Archivo Variable at 400 through 700 (same stack)
**Label/Mono Font:** ui-monospace stack, for the decklist paste box only

**Character:** One grotesk carries the whole app; the display voice is the body face with weight on it, never a second family and never a serif. The wdth build is self-hosted from `@fontsource-variable/archivo` so no figure ever renders in a fallback face. Every numeral is lining and tabular (`font-variant-numeric: tabular-nums lining-nums` on the root) so a reading never changes width as it ticks.

### Hierarchy
- **Front word** (900, `min(76px, column width / letter count * 1.3)`, line-height 0.8, tracking 0.025em, uppercase): the forming class word over the casting seat. `--pgf-n` is the glyph count the component prints, so COUNTERSPELL always sets smaller than REMOVAL inside the same column. Ceiling steps to 64px below 1280px and 52px below 1100px; 60px in a window under 820px tall.
- **Monumental** (900 for the acting seat and the seat to hit, 700 otherwise; `min(64px, column width / name characters * 1.25)`, line-height 0.78, tracking -0.02em, uppercase): the three seat names across the top of the board. `--name-chars` is set from the seat id plus archetype so the name fills its column and never overflows it. The seat to hit opens its tracking to 0.12em. Ceiling steps to 56px below 1280px and 44px below 1100px, and to 56px under 820px tall.
- **Figure L** (700, 32px, line-height 0.78, tracking -0.015em): a seat's life, the library count, scorecard metric values. 26px in a short window.
- **Figure M** (700, 24px, line-height 1): player-bar readings on a wide window, commander damage.
- **Figure S** (700, 19px): threat numbers; player-bar readings below 1280px and in short windows.
- **Headline** (700, 20px, line-height 1.1 to 1.2, tracking -0.01em): the wordmark (at 900, tracking -0.005em), the scorecard's deck name and verdict, the empty-table hint.
- **Body** (400, 14px, line-height 1.35; 13px in dense tables, buttons and picker rows; 15px for the event prompt): prose, tells, card names in the cited line at 500.
- **Small** (400, 12px, line-height 1.35): captions, card effect text, the run line in the title bar, spent-weather rows, the legal footer at 11px.
- **Label** (500, 11px, line-height 1.2, tracking 0.16em, uppercase, `--muted`): every printed label (LIFE, THREAT, TURN, MANA, block heads, zone heads, tab names, the title bar's KEYBOARD and THEME). Labels sit beside or under their figure, inside the name's measure; the active event's head label is set in ink because it is the one label asking for an answer.
- **Chip** (500, 10px, tracking 0.16em, uppercase, ink): state words inside a hairline box.
- **Key** (700, 11px, line-height 1): the character inside an 18px key square.

### Named Rules
**The Weight Carries Rank Rule.** Hierarchy is weight and size in one family: 900 for a name or a front, 700 for a figure or a heading, 500 for a label or a chip, 400 for prose. A second family, a serif, or an italic display voice is outside the world.

**The Measure Rule.** A monumental name and a front word are sized to the column they stand in, by character count, never by a breakpoint alone; a long name gets smaller, it never wraps and never covers a card face.

## Layout

The shell is a three-row grid: a 44px title bar (38px under 820px tall) with a hairline below it, the body, and the legal footer with a hairline above it. Between runs the body is a 280px deck rail beside the centre panel with a 12px gap and 12px padding; both are flat paper with 14px internal padding and no box, and a panel's heading is a label with a hairline under it.

During a run the board takes the whole body and the HUD stands over it in the board's own margins, with the body as the containing block. Three fixed columns sit across the top edge inside a 2000px table maximum (A left, B centred, C right), each `clamp(300px, 26vw, 420px)` wide with the slack between them so a seat is always in the same place. The forming word occupies the casting seat's column between the fronts and the first card row; the board spends `--hud-top` (208px; 182px in a short window) as top padding so no card is ever dealt under a name or under the weather. The event sheet is `clamp(300px, 22vw, 420px)` wide, justified start / centre / end to its seat, in the grid's second row. The spent-weather strip stands in a 100px left margin that the board reserves as padding (126px including the inset); it hides below 1100px and the margin closes. The five-zone strip and the player bar hold the bottom rows, ruled off with a hairline.

The card unit is one registered custom property, `--card-w: round(clamp(84px, min(11vw, 18.6vh), 158px), 1px)`, read by CSS and by JavaScript alike; every card-sized thing derives from it and the height is width times the card aspect. Past 1440px a bigger window buys more board, not bigger cards.

Spacing runs on a small even rhythm: 6px between a rule and the thing it rules, 8px between rows, 10px inside a block, 12px as the shell gap, 14px panel padding, 16px title-bar padding. Breakpoints are 1280px and 1100px on width (names, figures and the front step down; the HIT chip is dropped below 1280px while the name's tracking still says it) and 820px on height (shell chrome tightens first, then the names). The hand never collapses at any width down to 1024px; 390px is out of scope by decision.

## Elevation & Depth

There is no depth. `--shadow` and `--shadow-strong` resolve to `transparent`, no element sets a box-shadow, and there is no backdrop-filter anywhere. Everything is one sheet of paper; a thing that has to stand over a card face (the event sheet, a seat's detail, the log drawer, the answer picker, a pop menu, the browse overlay, the hotkey and judge overlays) is the paper itself at full opacity, separated by a 1px `--line` or `--rule` border, and an overlay sits on the 78% mist. The one tonal step, `--raised`, is a slab, not a lift.

### Named Rules
**The No Shadow Rule.** A floating thing is separated by its border, never by a shadow, a blur or a translucent pane. If a block must be read over card art, it is opaque paper.

**The One Rule Rule.** Exactly one 2px ink rule per screen: the storm rule across the top of the active event sheet. The open tab's underline and the commander's ring are also 2px ink but are outlines of a state, not a second sheet. Every other rule is a 1px hairline.

## Shapes

Nothing is rounded. `--radius` is 0 and every control, chip, key square, field, slab, sheet and overlay has square corners. The single exception is a card face, which keeps Scryfall's own 5px corner set locally (the thumbnail in the cited-card line and the preview keep it too; the drag ghost uses 4px). Borders are hairlines: 1px `--line` for structure and card edges, 1px `--rule` for a control edge or a chip, 1px dashed `--rule` for an empty pile, a queued event's line and a drop target, 2px solid `--ink` for the commander's ring and a focus ring (offset 2px), 2px dashed `--ink` for a selected card. The strike is a 1px `--rain` line at 54% of the front word's height, or a 2px `--ink` line through an eliminated seat's name. Threat is ten small filled-or-outlined cells in a row beside the number and the trend word. Chips are square, borders only, uppercase words. There are no icons in the world: the one glyph is a hairline chevron drawn on the select, and every action is a word or a key square.

## Components

### Buttons
Controls are an edge drawn around a word: no fill, no radius, nothing to make them a plate.
- **Shape:** square (0 radius), 1px `--rule` edge.
- **Edge (default):** transparent, ink text, 13px to 14px, `5px 10px` (4px 9px in the pressure layer). Key squares ride inside where the action has a hotkey (Next phase Space, Next turn T, the response keys 1 and 2).
- **Hover / Focus:** hover takes the raised paper behind the label and the edge goes to full ink; nothing moves. Focus is a 2px ink outline offset 2px, standing off the control so it reads over a card face. Disabled is 0.45 opacity.
- **Plate (the one reversed control):** ink fill, paper letters and paper key square, 2px ink edge with padding pulled in by 1px so it stands the same height as the edge control beside it. During a run it is the active event's key-1 response; between runs it is Start run (700, 13px, `3px 10px`).
- **Word (link-style):** an underlined 12px word in `--muted` with no edge, coming up to ink on hover; padded to a 24px hit target with the growth handed back as negative margin. Used for add note, Drill hands, Edit, Import deck, pick different target, Close. Delete and END RUN set in `--danger`.

### Chips
- **Style:** square, 1px `--rule` border, no fill, 10px 500 uppercase tracked 0.16em, ink text, `2px 6px` (5px and 0.1em tracking below 1280px). State words: TURN, HIT, ARMED n+, OUT, CONC, B3.
- **Class chip:** the one chip that carries colour, as a 10px square swatch in the class's mana colour beside the class word; text stays ink.
- **Spent:** an eliminated seat's chips go to `--rain` text and border.

### Key squares
An 18px box (min-width 18px, `0 4px`), 1px `--rule` edge, 11px 700 ink character, tabular. The same recipe for a hotkey beside its action, a card's mana value at its top-right corner (raised paper behind it), and the response keys 1 and 2 (the key-1 square reverses with its plate).

### Cards / Containers
- **Card face:** 5px radius, 1px `--line` edge, untouched image on paper; tapped rotates a quarter turn (110ms); ghost at 0.32 opacity; the commander wears a 2px ink outline, a selected card a 2px dashed ink outline, a drop target a 1px dashed hairline inside its edge; a face still loading is a `--raised` slab.
- **Sheet (the event block):** opaque paper, a 2px `--rule` across the top and no other border, `10px 12px 11px` inside with 6px to 8px row gaps, fading in over 140ms; contains the head label, the seat and class chips, the 15px prompt (three lines then scrolls), the cited card (56x78 face, name at 500, mana-value key square, effect at 12px muted, consequence at 12px ink), and the two equal-width responses.
- **Pane (detail, drawer, picker, pop menu, overlay):** opaque paper, 1px `--line` (detail, drawer) or `--rule` (picker, pop menu, overlay) border, no shadow; the picker also carries the class colour as its 2px top rule and its rows are ruled by hairlines with a raised-paper hover.
- **Zone cell:** a label beside a figure over a hairline-ruled cell with no fill; an empty pile is a dashed rule with the word EMPTY; the library is a raised slab with the count at Figure L.
- **Between-runs block:** no box; a label heading with a hairline under it, ruled rows beneath (deck rows, history rows, scorecard readings as label-beside-figure rows, review rows, dense 13px tables).

### Inputs / Fields
- **Style:** paper background, 1px `--rule` edge, 0 radius, `5px 8px`, inherited type; the select draws its own hairline chevron; a checkbox is a 14px square that reverses to an ink plate with a paper tick when checked.
- **Focus:** 2px ink outline offset 2px; the caret is ink; selection is the page reversed.
- **Error:** the scorecard banner prints the word ERROR and its text in `--danger` with a danger left rule; there is no red field state.

### Navigation
The title bar is a wordmark (900, 20px), a 12px muted run line with the seed alone in 700 ink, and the KEYBOARD and THEME controls as labels with a key square, no edge of their own. The player bar's tab group (LOG, NOTES, TOKENS, JUDGE, KEYS, END RUN) is a row of labels; the open tab takes a 2px ink underline, END RUN is set in `--danger`. Hover on a label goes muted to ink.

### The Seat Front (signature)
A seat is one button with no box: the name at Monumental, bottom-aligned in a fixed-height box with a 2px transparent bottom rule that fills with ink on hover; under it, inside the name's measure, one row of life at Figure L with its LIFE label, ten threat cells with the number and trend word, and the seat's colour letters in their mana colours; under that its state chips. Hover or focus opens the detail pane beneath the whole column; the pin makes it act. A tell or a queued line prints under the front as bare 13px ink prose or a dashed 10px QUEUED: CLASS line, with no box. An eliminated seat stays in its slot: the name drops to 700 in `--rain` with a 2px ink strike at 0.38em from its floor, the readings go to rain, and the chip says OUT. On turn advance the three fronts settle in reading order (opacity 0.3 to 1, 3px rise, 240ms, `cubic-bezier(0.16, 1, 0.3, 1)`, delayed 60ms and 120ms for B and C), driven by alternating `data-settle` keyframe names; reduced motion reads the settled state.

### The Forming Front (signature)
A new event's class word forms over the seat that cast it, in the seat's column inside the board's top clearance, taking no pointer. Each letter starts a scattered offset above its baseline in `--silver` and settles to ink over 560ms with `cubic-bezier(0.16, 1, 0.3, 1)`, staggered 24ms per letter and capped at 300ms total; the last letters hold the silver flash until 84% of the way in. Under the word a 40px strip, pulled 12px up into the word's line box, holds 14 to 20 small letterforms drawn from the class word itself, scattered across its measure, a quarter of them in ink and the rest in rain, falling 12px and fading in over the same 560ms; the strip clips so the rain never reaches a card. The word then rolls into the event sheet (140ms fade). Answered or resolved, the whole front goes `--rain` and a 1px rain strike draws left to right across it in 180ms, and the run's passed fronts accumulate in the left margin as struck 12px rain lines (T4 · COMBAT · resolved) under a rain PASSED label, newest at the foot. Reduced motion shows the formed word in ink and the strike already drawn; nothing is lost.

### The Receipt (share image)
The 1200x600 canvas reads `--ground`, `--ink` and `--muted` off the root at render time so it draws the paper world in whichever theme is up: the mark PROVING GROUNDS at 900, figures at 700, class letters as the event marks. It is the same system, not a second one.

## Do's and Don'ts

### Do:
- **Do** set every surface on `--ground`; the board, the strip, the rail, inputs and overlays are the same paper.
- **Do** carry rank with weight in one family: 900 names and fronts, 700 figures and headings, 500 labels and chips, 400 prose.
- **Do** size a monumental name by its column and character count (`--name-chars`) and a front word by its glyph count (`--pgf-n`), so long words get smaller rather than wrapping or covering a face.
- **Do** print a label beside or under its figure, 11px 500 uppercase tracked 0.16em in `--muted`.
- **Do** draw structure as 1px hairlines, and spend the single 2px ink rule on the active event sheet.
- **Do** reverse exactly one element per screen: the key-1 response during a run, Start run between runs.
- **Do** put every state in a word: OUT, HIT, TURN, ARMED 4+, QUEUED: COMBAT, WIN, ERROR; a colour, a strike or a grey never stands alone.
- **Do** make an occluding block opaque paper with a hairline edge and no shadow, and keep the forming word inside the board's top clearance so it never covers a card.
- **Do** keep `--rain` for what has passed and `--silver` for a word still forming.
- **Do** ship every authored motion with a reduced-motion fallback that shows the finished state.

### Don't:
- **Don't** add a fill, a shadow, a blur, a gradient, a glow, a grain or a radius; card faces alone keep their 5px corner.
- **Don't** use a second type family, a serif, or the old Marcellus wordmark; the wordmark is the body face at 900.
- **Don't** make `--accent` or `--rule` differ from `--ink`; emphasis is weight, tracking and the one plate.
- **Don't** use a mana colour as a fill, a border or a word colour anywhere but beside the class word or colour letter it names.
- **Don't** use `--danger` on a resting control or as a fill; it is life leaving, the losing verdict, and text after the word ERROR.
- **Don't** draw pill chips, tiles, cards-with-borders or a translucent pane over a Scryfall face.
- **Don't** add literal instruments (gauges, needles, dials, lamps) or icon glyphs; every action is a word, a key square, or a hairline mark.
- **Don't** hide the hand or add motion that interrupts play; hover changes only an edge or a colour, and nothing moves.
