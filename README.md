# Proving Grounds

Proving Grounds is a solo Commander (EDH) playtest trainer. You pilot your real decklist at a virtual table against three opponent seats (A, B, C) that exist only as life totals — there is no AI, no rules engine, and no legality checking. The app does the bookkeeping and keeps a complete, machine-readable log of everything that happens; you resolve the game honestly. Each game is a **run**: seeded so shuffles are reproducible, and instrumented so every mutation appends a log entry. That log is the source of all future scoring.

## M0 scope

The current milestone is the instrumented goldfish table:

- Deck import and storage (Dexie/IndexedDB)
- Virtual table with the six zones: library, hand, battlefield, graveyard, exile, command
- Turn and phase stepping with auto-untap and auto-draw
- First-class bookkeeping: four life totals, tokens, +1/+1 and loyalty counters, commander tax and commander damage, tap/untap-all
- Every state mutation appends a `LogEntry` to the active run

## Non-goals

- **No rules engine.** Nothing is validated, nothing resolves automatically.
- **No AI opponents.** Seats are life totals and elimination flags, nothing more.
- **No multiplayer.** Single player, local only.
- **No deck builder.** Import a finished list; build it elsewhere.

## Keyboard map

| Key     | Action                                   |
| ------- | ---------------------------------------- |
| `D`     | Draw a card                              |
| `S`     | Shuffle library                          |
| `U`     | Untap all                                |
| `Space` | Next phase                               |
| `T`     | Next turn                                |
| `M`     | Take a mulligan (opening hand only)      |
| `V`     | Preview the focused card                 |
| `C`     | Cast the focused card to the stack       |
| `R`     | Resolve the top of the stack             |
| `A`     | Push an ability or trigger to the stack  |
| `N`     | Add a run note                           |
| `1` `2` | Answer the active event                  |
| `?`     | Keyboard help (every key is rebindable)  |

Hotkeys are ignored while typing in an input, textarea, select, or contenteditable, and are no-ops when no run is active.

## Dev commands

```
npm install     # install dependencies
npm run dev     # start the dev server
npm run build   # typecheck and produce a production build
npm run preview # serve the production build
npm run lint    # oxlint

npm run verify:scorecard  # drive the store headlessly and check the scoring engine
```

## Fan content notice

Proving Grounds is unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. Card data and imagery are provided via Scryfall. Not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. © Wizards of the Coast LLC.
