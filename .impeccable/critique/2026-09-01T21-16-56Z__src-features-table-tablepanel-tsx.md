---
target: Proving Grounds play surface (table + HUD + pressure + scorecard)
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 4
target_identity: "file:C:\\Users\\acevi\\Development\\proving-grounds\\src\\features\\table\\TablePanel.tsx"
target_fingerprint: "sha256:57d521c7a1f3fcd210cfcfb5d82304bf1716716c879c28de98572344d24027a5"
target_path: "C:\\Users\\acevi\\Development\\proving-grounds\\src\\features\\table\\TablePanel.tsx"
timestamp: 2026-09-01T21-16-56Z
slug: src-features-table-tablepanel-tsx
closed: true
---
Method: dual-agent (A: design-review subagent · B: detector subagent). Target: src/features/table/TablePanel.tsx (play surface: table, HUD, pressure layer, left rail, scorecard). Mode: Operate.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Deferred events pile up silently behind a `+N more` pip that is a count, not a control (EventDock.tsx:188). |
| 2 | Match System / Real World | 3 | Vocabulary right. App shows Seat A's open mana, never the player's own. |
| 3 | User Control and Freedom | 2 | Undo covers life only. Clock expiry ends the run on a `t` keypress with no confirm and no way back. |
| 4 | Consistency and Standards | 2 | Zone stacks take keyboard input, cards do not. Share PNG relabels four metrics and drops one. |
| 5 | Error Prevention | 3 | Inline confirms and import validation solid. Deck delete never says its runs lose replay. |
| 6 | Recognition Rather Than Recall | 3 | Six of seven phase labels ellipsize at default rail width (hud.css:77). |
| 7 | Flexibility and Efficiency | 2 | Eight hotkeys, none plays a card or resolves an event. |
| 8 | Aesthetic and Minimalist Design | 2 | 57 visible controls on live table, 43 in HUD rail. Clock deadline 11px; static life totals 20px+. |
| 9 | Error Recovery | 3 | Import errors specific. Wipe-aftermath hint hides whenever another event is queued (EventDock.tsx:380). |
| 10 | Help and Documentation | 3 | `?` overlay and tile sub-lines good. Nothing explains bracket, log shorthand, or the honor system. |
| **Total** | | **26/40** | **Acceptable (65%)** |

## Design Specificity Verdict

LLM: authored in the details (Marcellus numerals, overlapping hand preserving MV badges, anchored lands row, hand-drawn silhouette glyphs, seat-attributed event copy), category-interchangeable in the composition (stock 280/fluid/320 three-column admin shell; three seats as identical sidebar cards; scorecard is a KPI-tile dashboard).

Deterministic scan: CLI 3 side-tab findings (pressure.css:69 clock 5px green = real; pressure.css:123 dock 6px = real; scorecard.css:279 2px neutral = false positive). In-page: 1 finding empty table, 118 live table, 44 scorecard; dominant undersized-ui-text (83 table, 33 scorecard: "BOARD WIPE" 9px, "YOUR THREAT" 9px, profile labels 10px); text-overflow on hand tip (186px), phase pill, frame name; em-dash-overuse (26); repeating-stripes-gradient and first-viewport-column-overflow on scorecard. False positives: library-sprite back-face contrast/occlusion; card-face typeline sizes.

Agreement: A found the colour-blind text channel set at the smallest type; detector counted 116 undersized labels. Detector caught what A missed: the two side-tab stripes, em-dash density, decorative stripe gradient. Overlays rendered in the detector tab (screenshot-confirmed); live server stopped.

## Priority Issues

1. [P0] Hand and mulligan bar collapse below ~1150px: at 1100x800 hand 21px, Mulligan/Keep bar 17px, graveyard/exile overlap both; keep decision impossible. Fix: `.tbl-strip` (table.css:93) hand column minmax(260px,1fr); first width media query collapsing right rail below ~1300px; don't reserve 320px for an empty rail during scorecard. Command: layout.
2. [P1] No keyboard path for playing a card or resolving an event; hand cards are inert role=button (CardView.tsx:161, no onKeyDown in src/features/table). Fix: hand cursor (arrows/Enter/zone letters), onKeyDown on CardFrame, dock bindings resolve/answer/defer, registered in HOTKEY_ACTIONS. Command: harden.
3. [P1] Scorecard states no finding: seven equal tiles + 12-metric flat profile, no ranking, no not-applicable state ("WIPE RECOVERY 1" off an empty board). Fix: one headline sentence naming the worst thing; tiles demoted to evidence, dimmed when fine; explicit not-enough-data state; reconcile answer-rate denominator with ledger. Command: distill.
4. [P1] Fan Content line absent from app and share PNG (four-word stub at App.tsx:27 and shareImage.ts:559; Scryfall credited nowhere visible). Fix: full line in app footer and baked into PNG. Command: clarify.
5. [P1] Timeline chart distinguishes event types by colour alone at 3.2px (TimelineChart.tsx:190); class chips carrying the text channel are 9-9.5px; zero-state silhouette cells ~1.9:1 (hud.css:336); --danger equals --mana-r (tokens.css:12,19). Fix: letter caps on markers, 11px floor + type scale in tokens.css, real dim token above 4.5:1, separate danger from red. Command: audit.

## Persona Red Flags

Alex: eight bindings never touch the hand; hotkeys blur focus so no keyboard cursor exists; +6 more pip cannot expand; end-run controls below fold of a rail scrolling at 900px; 3s confirm expiry.
Sam: 16 inert focus stops in a full hand; zone stacks keyboard-active with no focus ring (two :focus-visible rules total); event dock not a live region, run log announces every phase step; chart is sealed role=img. Works: threat meters, life labels, ledger table, reduced-motion.
Devi (brewer without pod, first run): bracket unexplained; honor system never stated on screen; first wipe hides "drag back survivors" hint when a combat event is queued; never learns own open mana; scorecard does not answer "weak to what"; profile at 2 runs prints WIN RATE 0% with a one-turn concede weighted like a full game.

## Minor Observations

Phase strip reads "U… U… Dr… M… C… M… End" at default width. Chart axis duplicate ticks when max <= 2 (TimelineChart.tsx:80). Share PNG renames metrics and drops KEEP, fixed 1200x600 no reflow. Seed field unlabeled (DeckList.tsx:72). Deck delete doesn't disclose runs losing replay. Answer rate "3 of 3" above a ledger with six unresolved rows. No transient emphasis on life change. Counter tell shares a 10px line with the static play tip. 26 em-dashes in body copy. Three simultaneous empty states on cold start. Console clean throughout.

## Questions to Consider

- If the scorecard opened with one sentence and the tiles were evidence beneath it, what would the tile grid be protecting?
- The app does Seat A's open-mana arithmetic and not yours; which arithmetic is it choosing to do for the pilot, and why that one?
- "Loss" requires a 3s-armed confirm; clock expiry destroys the run on a keypress with none. Which does the app treat as the dangerous action?
