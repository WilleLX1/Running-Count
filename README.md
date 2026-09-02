# Running Count

A top-down casino where you walk to a blackjack table, sit down, and try to count
cards without the pit noticing. It teaches Hi-Lo counting, then takes the training
wheels off and tests you against a surveillance model that watches your betting the
way a real pit does.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## What is in it

**A real blackjack engine.** Multi-deck shoe with a cut card and configurable
penetration, S17/H17, 3:2 or 6:5, double after split, resplits, late surrender,
dealer peek, insurance. NPCs occupy the other seats and burn cards, so the count
moves whether or not you are in the hand.

**Three levels of help.** Set on the menu:

| Level | What you get |
| --- | --- |
| Coached | Running count, true count, decks remaining, the correct play, and what the bet ramp wants. |
| Spotter | You keep the count yourself with `+` / `-`. The game converts it to a true count and rates your bets. |
| Live money | Nothing. Count in your head. A count check at every shuffle scores you. |

**A surveillance model that watches the right thing.** Suspicion is not "the game
knows you are counting". It is built from what a pit actually logs, and the
end-of-session screen breaks it down:

- bet spread (top bet over bottom bet)
- **correlation between your bet size and the true count** — the factor that
  dominates, because it is the one that gets people barred
- jumps between consecutive hands
- how fast you are winning, in table minimums
- wonging in and out of shoes
- play tells, like insurance at a high count

Cover plays push it back down: tip the dealer, order a drink, take a break, colour
up, change tables. Attention escalates through *noticed → watched → pit called →
backed off*, and you can see it coming in the pit boss's body language before the
meter tells you. Once the suits start walking you have seven seconds to colour up
and leave; if they reach you, you are backed off and the house remembers your face
into the next session.

**A training room** (back room of the casino, or straight from the menu) with six
drills: card tags, counting a deck against the clock, reading decks off the discard
tray, true-count conversion, basic strategy, and the Illustrious 18 index plays.

## Controls

| | |
| --- | --- |
| `WASD` / arrows | walk |
| `E` | sit at a table, use the bar, cashier, restroom, back room or exit |
| `1`–`4`, `SPACE` | add chips, deal |
| `H` `S` `D` `P` `R` | hit, stand, double, split, surrender |
| `Y` / `N` | insurance |
| `W` | sit the hand out (wong) |
| `T` | tip the dealer |
| `+` / `-` | adjust your own running count (Spotter mode) |
| `ESC` | stand up / back |

## Verifying the maths

The engine runs headless too, which is how the numbers below were checked and the
heat model was tuned:

```bash
npm run sim -- edge     # expected value by playing style
npm run sim -- heat     # how long each style lasts before a back-off
npm run sim -- diag     # outcome frequencies vs the textbook
npm run sim -- audit    # settlement arithmetic, hand by hand
```

Over 600,000 hands on the 6-deck S17 3:2 table:

| Style | EV per unit wagered |
| --- | --- |
| Flat bettor, basic strategy | **-0.20% ± 0.15%** (textbook for these rules: -0.34%) |
| Counter, 1-6 spread | **+0.53%** |
| Counter, 1-12 spread + indices | **+0.75%** |
| Back-counter, only plays TC +1 and up | **+2.80%** |

And how long each lasts before being backed off (5 runs each):

| Style | $10 table | High limit |
| --- | --- | --- |
| Flat bettor | never | never |
| 1-6 spread | ~113 bets | ~52 bets |
| 1-12 spread | ~74 bets | ~50 bets |
| Back-counter | ~18 bets | ~17 bets |

That gap between the 1-6 and 1-12 spread is the game: the bigger ramp earns more
per hand and buys you far fewer hands.

## Layout

```
src/
  core/        canvas renderer, fixed 1280x720 logical space, input, seeded RNG, immediate-mode UI
  blackjack/   cards, shoe, hand, rules, Hi-Lo counting, basic strategy + Illustrious 18, TableSim
  heat/        the surveillance model
  world/       casino floor: collision, tables, features, wandering crowd
  scenes/      menu, primer, floor, table, trainer, results
  state/       session, bankroll, stats
scripts/       headless simulation harness
```

`TableSim` is the whole game of blackjack in one class. It is deterministic given
`(seed, player actions)`, advanced only by `update(dt)`, holds no rendering state,
and reports everything through hooks — so a server can run the identical class and
broadcast its state.

## Co-op

The table is already modelled as N seats, each with its own hands, bets and
insurance, and NPCs drive the seats you are not in. Turning that into networked
co-op means:

1. Replace the single `playerSeat` / `pendingBet` / `betLocked` / `sittingOut`
   fields with per-seat versions — the rest of the state machine already iterates
   seats and does not care who is behind one.
2. Run `TableSim` on a Node process with the shoe's seed as the authority, and
   send `{seat, action}` messages up, snapshots down.
3. Reuse `SimHooks` as the broadcast points; every visible change already flows
   through them.

The heat model is per-player and would stay client-visible but server-owned, which
is what makes a co-op team interesting: one player spreads while the other flat
bets and calls the count.

## Notes

This is a simulation for learning a piece of applied probability. It is not
gambling advice, and the casinos in it are more forgiving than the real ones.
