# Tester brief

Proving Grounds is a solo Commander playtest trainer. You pilot your real deck at
a virtual four-seat table; the app injects adversity (wraths, removal, counters,
combat, a race clock, resource attacks, standing hate pieces) on a seeded,
bracket-scaled schedule, records everything you do, and scores the run. There
are no opponents with decks, no rules engine and no enforcement: you resolve
everything honestly, the app counts.

This is a first outside look. Nothing about the tuning has been checked by
anyone but the author, so blunt feedback on feel is exactly what is wanted.

## Setup (five minutes)

1. Open the link you were given in a desktop browser (Chrome or Edge, a window at
   least 1280px wide). No account, no install. Card data comes from Scryfall.
2. Click **Import deck** and paste a Moxfield, Archidekt or MTGO text export of a
   deck you actually play. Pick the commander when asked.
3. Choose a bracket (1 to 5; 3 is a normal casual pod) and **Start run**.
4. Press `?` for the hotkey overlay. The ones you need: `D` draw, `Space` next
   phase, `T` next turn, `1` answer the event in front of you, `2` let it
   resolve, `J` judge (offline in this build), `N` notes.
5. Play until the run ends or turn 10, whichever comes first. Then read the
   scorecard. Play at least two runs, one of them with the same seed after a
   deck edit if you can (the deck panel offers **Replay** and **Compare**).

## What to report

Answer as many of these as you have an opinion on. One line each is fine.

1. **Threat meters.** Each seat carries a threat number that rises over windows,
   jumps on events and falls when you hit it. Did it move at a believable rate?
   Too fast, too slow, or did you stop reading it?
2. **Pod combat.** Seats attack each other as well as you, and a seat can be
   knocked down to 1 life but never killed by the pod. Did that read as honest,
   or would you rather see the pod finish a seat?
3. **Hate pieces.** When a seat casts Rest in Peace, Blood Moon, Thalia and the
   like, a one-line tell stays under that seat until you remove it. Was the tell
   enough to honour the piece by hand, or did you forget it was there?
4. **Silhouettes.** A seat's board is an aggregate (creature count, total power,
   artifacts and enchantments, open mana). Did you want per-creature sizes, or
   was the aggregate enough to decide attacks and blocks?
5. **Event plausibility.** Every event cites a real card the seat "cast". Did
   any citation feel wrong for the seat's colours, the turn or the bracket?
6. **Speed.** The product promise is faster than Moxfield's playtest. Where did
   it slow you down: a modal, a click that should be a key, a zone that was hard
   to reach?
7. **Scorecard.** Did any tile make you want to change a card in the deck? Which
   one, and what would you cut or add? Did any tile read as wrong?
8. **Stack tray.** If you used it (cast to the tray, push a trigger, resolve the
   top), did it help or get in the way?
9. **Anything broken.** A card that landed in the wrong zone, a hand that did not
   fit, a number that did not add up. Seed and turn number if you have them (the
   seed is printed in the top bar).

## What not to bother with

- The judge drawer is offline in the shared build; it needs a local proxy.
- Mobile layout is out of scope.
- Rules disputes: the app never adjudicates, so "it let me do something illegal"
  is by design.

## How to send it

Reply to whoever sent you the link, or open an issue on the repo if you were
given access. A scorecard PNG (the **Share** button on the scorecard) with your
notes is ideal.
