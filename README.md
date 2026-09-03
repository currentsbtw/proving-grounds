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
| `J`     | Ask the judge (advisory only)            |
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

npm run judge         # start the local judge proxy
npm run judge:corpus  # download the Comprehensive Rules text the judge reads
```

The judge is advisory: it answers a rules question with citations, or it declines. It never
enforces anything and never touches the table. With the proxy stopped the drawer says so and
the rest of the app is unaffected.

### Judge drivers

The judge reaches Claude one of two ways. Both run the same prompt through the same code and
the same eval scripts; the only difference is who pays for the call.

- **`claude-code`** runs the Claude Code CLI on your machine in print mode, so answers are
  covered by your existing Claude subscription and cost nothing per question. This driver
  never uses an API key: it removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the
  CLI's environment before spawning it, so a key exported in your shell cannot quietly be
  billed by the free path.
- **`api`** uses the Anthropic SDK and bills Console credits against `ANTHROPIC_API_KEY`.

With nothing configured the proxy picks `api` when `ANTHROPIC_API_KEY` (or
`ANTHROPIC_AUTH_TOKEN`) is set, otherwise `claude-code` when it can find the CLI. Set the
variables in the shell that runs `npm run judge`:

| Variable | Default | What it does |
| --- | --- | --- |
| `JUDGE_DRIVER` | auto | `api` or `claude-code`, overriding the choice above |
| `JUDGE_MODEL` | `claude-opus-5` | Model id for whichever driver runs |
| `JUDGE_GROUNDING` | `retrieval` | `retrieval` sends only the rules a question needs; `full` sends the whole corpus |
| `JUDGE_CLAUDE_BIN` | auto | Path to `claude.exe`, when the search below does not find yours |

`retrieval` is the default because it is the path a player gets for free: it picks the slice of
the Comprehensive Rules a question actually needs, which costs roughly fifteen times less and
works the same on a driver with no cache control. `full` sends the megabyte of rules text every
time. Only the `api` driver can cache that between questions, so `full` is effectively the paid
option; on `claude-code` it is a megabyte of prompt per question with no cache behind it.

The eval scripts take the same choice as `--driver api|claude-code` and `--model <id>`, and
`npm run eval:judge` also takes `--grounding full|retrieval`. On the `claude-code` driver they
run two calls at a time and say that usage is drawing on your subscription.

**One-time login for the subscription path.** The CLI needs its own login once; after that the
judge just works. On Windows the desktop app ships the CLI inside its MSIX package, so from
your own terminal use the `Packages` path:

```powershell
& "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code\<version>\claude.exe" auth login
& "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code\<version>\claude.exe" auth status
```

`auth status` should report that you are logged in. (`%APPDATA%\Claude\claude-code\<version>\claude.exe`
is the same file as seen from inside the app's own sandbox; from a normal terminal that
directory looks empty, which is why the `Packages` path is the one to type.) The driver looks
for the binary in this order: `JUDGE_CLAUDE_BIN`, then `claude` on your `PATH`, then both of
those install roots, newest version first. On Windows only a real `.exe` is used from `PATH` —
if yours is an npm `claude.cmd` shim, point `JUDGE_CLAUDE_BIN` at an executable.

At startup the proxy asks the CLI `auth status` once and reports the answer as `hasKey` on
`/api/judge/health`, so the drawer knows before your first question whether the judge is usable.
That probe is a local read of the stored credentials: it costs nothing and calls no model. Until
the login happens the drawer says `Judge is not logged in. Run claude /login once, then ask
again.` and the proxy answers 503 `no_login`; a login that expires mid-session is caught on the
next question and reported the same way.

## Fan content notice

Proving Grounds is unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. Card data and imagery are provided via Scryfall. Not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. © Wizards of the Coast LLC.
