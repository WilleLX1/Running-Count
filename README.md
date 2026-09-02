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
| `C` / `Q` | co-op: call the count / open the callouts |
| `ESC` | stand up / back |

## Verifying the maths

The engine runs headless too, which is how the numbers below were checked and the
heat model was tuned:

```bash
npm run sim -- edge     # expected value by playing style
npm run sim -- heat     # how long each style lasts before a back-off
npm run sim -- diag     # outcome frequencies vs the textbook
npm run sim -- audit    # settlement arithmetic, hand by hand
npm run sim -- coop     # a real Room: a big player and a spotter on one shoe
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
| 1-6 spread | ~110 bets | ~55 bets |
| 1-12 spread | ~66 bets | ~50 bets |
| Back-counter | ~18 bets | ~20 bets |

That gap is the game. The 1-12 spread earns 1.4× as much per hand as the 1-6
spread and buys you 1.7× fewer hands before you are asked to leave, so the
greedier ramp actually makes less money per session. Back-counting earns the most
per hand of anything and gets you thrown out fastest.

## Layout

```
src/
  core/        canvas renderer, fixed 1280x720 logical space, input, seeded RNG, immediate-mode UI
  blackjack/   cards, shoe, hand, rules, Hi-Lo counting, basic strategy + Illustrious 18, TableSim
  heat/        the surveillance model
  world/       casino floor: collision, tables, features, wandering crowd
  net/         wire protocol, snapshot serialisation, WebSocket client
  table/       the controller seam: LocalTable (solo) and RemoteTable (co-op)
  scenes/      menu, lobby, primer, floor, table, trainer, results, signals
  state/       session, bankroll, stats
server/        room, hub, Vite dev plugin, standalone host
scripts/       headless simulation harness
```

`TableSim` is the whole game of blackjack in one class. It is deterministic given
`(seed, player actions)`, advanced only by `update(dt)`, holds no rendering state,
and reports everything through hooks — so a server can run the identical class and
broadcast its state.

## Co-op

Two to four counters in one casino, on one shoe, with **one pit watching all of
you separately**. Menu → *Play co-op with friends* → host a table and pass the
four letter code around, or type someone else's code to join. `npm run dev` is
all anyone needs: the room server rides along inside the Vite dev server.

Everyone walks the same floor and can sit at the same table. Seats are dealt in
order, so you act in turn, and the dealer keeps a clock: 20 seconds to get a bet
out, 30 to make a decision. Sit down at a table a teammate is already working and
the pit will move an NPC along to make room.

**Why play together.** Heat is tracked per person, and it is built almost entirely
out of how *your* bets track the count. So the classic team shape works exactly as
it should: one player flat bets the minimum, counts, and stays invisible; the
other sits down cold and pushes out eight units on a signal. The spotter's heat
never moves. The big player takes all of it — and when they get backed off, the
rest of the team keeps playing.

**Talking without talking.** `C` calls the count — you type in the number *you*
believe, not the one the game knows, so a bad count travels down the table like a
real one. `Q` opens the callouts: shoe is hot, shoe is cold, cut card is close,
heat is on me, open seat here, colouring up. The team panel shows every
teammate's name, the last few calls, and how the pit is reading each of them.

**When someone drops**, their seat and chips are held for 45 seconds so they can
come back. Stand up with cards already out and you cannot pull the bet back — the
dealer finishes your hand by the book and pays it to your account. Rooms clean
themselves up ten minutes after the last person leaves.

`npm run sim -- coop` runs the real server headlessly with two scripted players
on one shoe, which is where the team shape shows up plainly:

```
Ana     40 hands  peak heat  95  spread 0.55  correlation 0.55   BACKED OFF after 40 rounds
Bo     259 hands  peak heat   0  spread 0.00  correlation 0.00   still playing
```

To host for people outside your machine, build once and run the standalone
server, which serves the client and the rooms on one port:

```bash
npm run build && npm run serve
```

### How it is wired

- `TableSim` runs **only on the server**. It is the same class solo play uses,
  with seats that hold either humans or NPCs.
- The client sends intents (`bet`, `deal`, `act`, `insurance`, `sit`, `signal`)
  and renders whatever comes back. It never decides an outcome.
- Snapshots go out at 15 Hz: full detail for tables somebody is sitting at, a
  one-line summary for the rest, plus every player's position, bankroll and heat.
- The dealer's hole card is **not sent** until it is turned over, so the card is
  not in the client's memory to be read.
- Positions on the floor are client-reported, because nothing is at stake in
  where somebody is standing.
- `src/table/controller.ts` is the seam: `LocalTable` wraps a local `TableSim`,
  `RemoteTable` wraps the socket, and the table scene talks only to the interface.
  That is why solo and co-op look and behave identically.

## Notes

This is a simulation for learning a piece of applied probability. It is not
gambling advice, and the casinos in it are more forgiving than the real ones.
