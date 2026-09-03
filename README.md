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

### Eval resume and plan limits

A full `npm run eval:judge` is a few hundred model calls, and on the subscription path a plan's
session window can run out partway through. When that happens the run stops rather than
failing: nothing new is dispatched, the calls in flight are allowed to land, every item that
reached a verdict is written to `eval/results/`, and the last line says when the plan resets
(`Stopped: out of plan usage until 11:20pm (America/Los_Angeles)`). Items that were never asked
are simply absent from the results, not recorded as errors they did not commit. The exit code
is 1 and the gate reports the stop, so a partial run can never read as a pass. A login that
expires mid-run stops the same way. Every process on the machine shares one stored OAuth token,
so a `claude-code` call can also fail because another Claude Code process was renewing it at
that moment; that one is retried three times, at about 5, 15 and 30 seconds, jittered and with
one waiter at a time across the run, and only counts as a stop once all three are spent (the
summary then says the CLI could not refresh its login, not that it could not authenticate).
`npm run eval:build` behaves the same: finished work is on disk before it says why it stopped.

Runs resume by default, so the next run picks up where the stopped one left off. Before
dispatching anything, `eval:judge` looks for the newest results file that both stopped early and
was the same measurement, and carries over every item in it that reached a verdict. "The same
measurement" is the corpus date, the driver, the model, the grounding, and a `harness`
fingerprint stored in each file: a short hash of the policy prompt, the eval's request shape and
what retrieval selects. The fingerprint is the one that matters, because a verdict earned
against a bare question says nothing about the same question asked with the card's oracle text
under it; changing any of that invalidates every earlier file, deliberately. An automatic resume
also passes over a run that finished, or the first good run would make every later one grade
nothing and print PASS from old verdicts, and over a `--limit`, `--filter` or `--no-examples`
run, which measured a chosen part of the set. A resumed run that grades everything still
outstanding is a full run and can PASS. It prints `resumed N graded items from <file>`, marks
those rows `~` in the table, and reports their tokens and cost separately from what this run
spent.

Use `--resume <path>` to name a file. An explicit resume is allowed to pick up a completed run
as well, because a run can finish around a failure: it carries every graded verdict in the file
and re-asks exactly the items that finished without one, whether they errored or were never
asked. It still says why and exits non-zero rather than quietly grading everything if that file
is a different measurement, if every item in it already has a verdict, or if it was a `--limit`,
`--filter` or `--no-examples` subset whose handful of verdicts would leave the rest of the set
looking like this run's own work. `--no-resume` grades everything again, `--show-request <id or
card>` prints one item's question, card-text reference block and retrieved rules without calling
anything, `--mock --mock-limit-after <n>` exercises the stop path offline, and `--mock
--mock-error-at <n>` fails the nth call only, which exercises the errored-item path instead. One
known cost: an item whose judge call succeeded but whose grader call hit the limit is not
written, so its answer is bought again next run.

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
next question and reported the same way. A plan whose session window is spent is a different
answer: the proxy replies 503 `limit` and the drawer prints when it resets, because there is
nothing to fix and nothing to retry until then.

## Fan content notice

Proving Grounds is unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. Card data and imagery are provided via Scryfall. Not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. © Wizards of the Coast LLC.
