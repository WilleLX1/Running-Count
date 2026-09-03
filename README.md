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

**A training room** (back room of the casino, or straight from the menu) with ten
drills, built around the fact that counting is not one skill but three — tagging a
card, chunking what you see, and holding a number:

| Drill | What it trains |
| --- | --- |
| Card tags | The reflex. One card, +1 / 0 / −1. |
| Cancel the pair | Chunking. Two to four cards at once and you call the net, never adding card by card. Grows with your streak, and times you. |
| Count a deck | Speed. Cards flash by, one, two or three at a time, and you call the running count at the end. |
| Count down a deck | Retention. One real deck dealt out bar the last card — a deck sums to zero, so your count names the card you cannot see. Self-verifying and impossible to game. |
| Net the table | Scanning. A genuinely simulated settled table, every card face up, and you call the net before it is swept. Shows you the per-hand nets afterwards. |
| Read the tray | Deck estimation off the discard tray. |
| True count | Conversion, rounding toward zero. |
| Basic strategy | Every hand against every upcard. |
| Index plays | The Illustrious 18 with a true count attached. |
| **Live table** | All of it at once, under a dealer who does not wait. |

The live table is the one that carries the rest. It is a real dealer working a real
shoe on the game's own engine and felt — you pick the number of players, the decks,
the penetration and the dealer's speed, and then you do nothing but keep the count.
No bets, no decisions. Hands play out with hits, splits and doubles, so the number
of cards per round moves around the way it does at a table, which is the thing that
actually breaks a count.

- The dealer **asks for the running count between hands**, while the bets are
  going out, as often as you like. Never mid-deal — that is not a thing that
  happens, and it is not when the number is any use to you. At the cut card there
  is always a final check, and that one also asks for decks remaining and the
  true count.
- A **speed ramp** winds the dealer up as the shoe goes on, and again on the next
  shoe, so you are always sitting just past comfortable.
- **Hold `C` to peek** at the count. It is tracked and shown in your score, so you
  can watch yourself wean off it.
- A **manual counter** on `+` / `−`, in three settings, because tagging a card
  and holding a total are two different skills and it is worth training them
  apart:
  - **Visible** — somewhere to put the number, so you are adding rather than
    remembering. Checks come pre-filled with whatever it says, and a check you
    get wrong puts it back on the true number.
  - **Blind** — the presses still land, but the total is masked. Checks ask what
    you *remember* and score your presses separately, so the review can tell you
    which half failed: *"Not your eyes. Your memory. Your presses tracked the
    shoe the whole way — what you could not do was hold the total."*
  - **Off** — nothing to lean on.
- **Cancellation hints**, off by default: a strip of the last nine cards out with
  the pairs that come to nothing bracketed and greyed, and what the remainder is
  worth. Training wheels for reading the shoe in chunks rather than one card at a
  time.
- Afterwards you get a **drift replay**: the count plotted across the whole shoe
  with every check marked, and the exact run of cards between the last check you
  got right and the first you got wrong — *"You were right at card 83, then −1 out
  by card 94. These are the 11 cards in between. They add up to −4."*

With the manual counter on, the replay gets much sharper, because the game knows
your number on **every** card rather than only at the checks. It draws your line
over the shoe's and names the exact card the two parted on — *"Card 33 is where
your counter and the shoe parted. You had −5 where the shoe had −4 — 1 low card
went past you"* — with the cards either side of it and the culprit marked. One
card of reaction time is forgiven, since you are pressing a key rather than
reading a number.

**A history of everything**, from the menu or the end-of-session screen. Every
night in the casino, every drill run and every training shoe is written to local
storage and plotted.

One point on a graph is **one session**, not one day. Each record keeps the wall
clock from when you walked in to when you walked out, so three sessions in an
evening are three points with their own times, and the axis reads `28/8 16:12`
rather than just `28/8`. Hovering gives you the whole span — *"30/8 00:12 → 00:56
· 45 min"* — and the log lists when each one started and how long it lasted.
Casino records keep both the wall-clock length and the time actually spent at a
table, which is why the volume chart has two lines.

Five tabs:

- **Money** — bankroll session by session with the back-offs marked, cumulative
  win and loss, result per session as bars, and your rate per hundred hands
  against your average bet.
- **Skill** — playing decisions, bet sizing, count checks and index plays as four
  lines over time, so you can see which one is actually holding you back. Plus
  volume per session, and your live-table shoes with recall and tagging split
  apart.
- **Heat** — peak heat per session against the back-off threshold, and the six
  surveillance factors over time. Watching *bet tracks the count* climb session
  after session is the clearest possible picture of a counter getting greedy.
- **Training** — pick a drill and see its accuracy and speed over time; below it,
  live-table volume, peeking, dealer speed and average miss.
- **Log** — every record, newest first, scrollable.

Every chart has a hover readout, so you can point at a session and get its
numbers rather than squinting at the line.

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
| `+` / `-` | adjust your own running count (Spotter mode, and the live table drill) |
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
  render/      cards and the chart primitives the history screen draws with
  table/       the controller seam: LocalTable (solo) and RemoteTable (co-op)
  scenes/      menu, lobby, primer, floor, table, trainer, live table, results, history, signals
  state/       session, bankroll, stats, saved history
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
