/**
 * Headless checks for the blackjack engine and the surveillance model.
 *
 *   npm run sim              -- everything
 *   npm run sim -- edge      -- expected value only
 *   npm run sim -- heat      -- how long different players last
 *
 * The engine here is exactly the one the game runs, driven without a renderer.
 */
import { TableSim, type PlayerAccount, type RoundSummary } from "../src/blackjack/sim";
import { TABLE_PRESETS, houseEdge, type TableRules } from "../src/blackjack/rules";
import { legalActions } from "../src/blackjack/hand";
import { correctAction } from "../src/blackjack/strategy";
import { floorTrueCount, recommendedBet } from "../src/blackjack/counting";
import { Surveillance } from "../src/heat/surveillance";
import { mulberry32 } from "../src/core/rng";

// Larger than any timer in the sim, so each update advances one step. The
// game logic is identical; it just runs about fifteen times faster.
const DT = 0.6;

interface PlayerPolicy {
  name: string;
  /** Bet for the coming round, or 0 to sit out. */
  bet(trueCount: number, rules: TableRules, unit: number): number;
  useDeviations: boolean;
}

const flat: PlayerPolicy = {
  name: "Flat bettor, basic strategy",
  bet: (_tc, rules, unit) => Math.max(rules.minBet, unit),
  useDeviations: false,
};

const counter: PlayerPolicy = {
  name: "Counter, 1-12 spread + indices",
  bet: (tc, rules, unit) => recommendedBet(tc, unit, rules.minBet, rules.maxBet),
  useDeviations: true,
};

const wonger: PlayerPolicy = {
  name: "Wonger, sits out below TC +1",
  bet: (tc, rules, unit) => (tc < 1 ? 0 : recommendedBet(tc, unit, rules.minBet, rules.maxBet)),
  useDeviations: true,
};

const camouflaged: PlayerPolicy = {
  name: "Counter, 1-6 spread only",
  bet: (tc, rules, unit) => {
    const units = tc >= 4 ? 6 : tc >= 3 ? 4 : tc >= 2 ? 2 : 1;
    return Math.min(rules.maxBet, Math.max(rules.minBet, units * unit));
  },
  useDeviations: true,
};

interface RunResult {
  rounds: number;
  wagered: number;
  net: number;
  summaries: RoundSummary[];
  roundsUntilBackoff: number | null;
  peakHeat: number;
}

function run(
  policy: PlayerPolicy,
  rules: TableRules,
  rounds: number,
  seed: number,
  unit: number,
  withHeat: boolean,
): RunResult {
  const account: PlayerAccount = { bankroll: 1e9 };
  const rng = mulberry32(seed);
  const summaries: RoundSummary[] = [];
  const heat = new Surveillance();
  let roundsUntilBackoff: number | null = null;
  let peakHeat = 0;

  const sim = new TableSim(rules, rng, account, {
    onRoundEnd: (s) => {
      summaries.push(s);
      if (withHeat) {
        heat.observe(s, rules, unit);
        peakHeat = Math.max(peakHeat, heat.suspicion);
        if (heat.attention === "backoff" && roundsUntilBackoff === null) {
          roundsUntilBackoff = summaries.filter((x) => !x.satOut).length;
        }
      }
    },
  });
  // Leave two NPCs in: a wonging player needs the table to keep dealing while
  // they sit out, and their cards move the count exactly as they would in game.
  sim.seats.forEach((s, i) => {
    if (i === 0) {
      s.kind = "empty";
      s.name = "";
    } else if (i <= 2) {
      if (s.kind !== "npc") {
        s.kind = "npc";
        s.name = `NPC${i}`;
        s.chips = 1e7;
        s.npc = { skill: 0.9, aggression: 1, superstition: 0.2 };
      } else {
        s.chips = 1e7;
      }
    } else {
      s.kind = "empty";
      s.name = "";
      s.hands = [];
    }
  });
  sim.sit(0);

  let played = 0;
  let guard = 0;
  const start = account.bankroll;
  let wagered = 0;

  while (played < rounds && guard++ < rounds * 4000) {
    if (sim.phase === "betting" && !sim.betLocked) {
      const tc = floorTrueCount(sim.trueCount);
      const bet = policy.bet(tc, rules, unit);
      if (bet <= 0) {
        sim.setSittingOut(true);
      } else {
        sim.setBet(bet);
        sim.confirmBet();
        wagered += bet;
      }
      played++;
    }

    if (sim.offeringInsurance) {
      const tc = floorTrueCount(sim.trueCount);
      sim.answerInsurance(policy.useDeviations && tc >= 3);
    }

    const turn = sim.playerTurn();
    if (turn) {
      const seat = sim.seat!;
      const legal = legalActions(turn.hand, seat.hands.length, rules, account.bankroll);
      const { action } = correctAction(
        turn.hand,
        sim.dealerUpcard!,
        rules,
        legal,
        floorTrueCount(sim.trueCount),
        policy.useDeviations,
      );
      sim.act(action);
    }

    if (withHeat) heat.update(DT, true);
    sim.update(DT);
  }

  return {
    rounds: summaries.filter((s) => !s.satOut).length,
    wagered,
    net: account.bankroll - start,
    summaries,
    roundsUntilBackoff,
    peakHeat,
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(3)}%`;
}

function edgeReport(): void {
  const rules = TABLE_PRESETS[0];
  const rounds = 150000;
  console.log(`\nEXPECTED VALUE  --  ${rules.name}`);
  console.log(`rules: ${rules.decks} decks, ${rules.dealerHitsSoft17 ? "H17" : "S17"}, ${rules.blackjackPayout === 1.5 ? "3:2" : "6:5"}, ${Math.round(rules.penetration * 100)}% pen`);
  console.log(`textbook house edge for these rules: ~${pct(houseEdge(rules))}\n`);
  const seeds = [12345, 777, 2024, 90210];
  for (const policy of [flat, camouflaged, counter, wonger]) {
    let hands = 0;
    let wagered = 0;
    let net = 0;
    for (const seed of seeds) {
      const r = run(policy, rules, rounds, seed, 25, false);
      hands += r.rounds;
      wagered += r.wagered;
      net += r.net;
    }
    const ev = net / Math.max(1, wagered);
    // Standard error on EV per unit wagered, assuming ~1.15 SD per unit hand.
    const se = 1.15 / Math.sqrt(Math.max(1, hands));
    console.log(
      `${policy.name.padEnd(34)} ${String(hands).padStart(7)} hands  ` +
        `EV/wagered ${pct(ev).padStart(9)} ± ${pct(se)}  net ${net >= 0 ? "+" : ""}${Math.round(net).toLocaleString()}`,
    );
  }
}

function heatReport(): void {
  console.log(`\nSURVEILLANCE  --  rounds survived before a back-off\n`);
  const tables = [TABLE_PRESETS[0], TABLE_PRESETS[2]];
  for (const rules of tables) {
    console.log(`${rules.name}  (scrutiny ${rules.scrutiny})`);
    for (const policy of [flat, camouflaged, counter, wonger]) {
      const runs = [1, 2, 3, 4, 5].map((s) => run(policy, rules, 600, s * 977, rules.minBet * 2, true));
      const caught = runs.filter((r) => r.roundsUntilBackoff !== null);
      const avg =
        caught.length > 0
          ? Math.round(caught.reduce((a, r) => a + (r.roundsUntilBackoff ?? 0), 0) / caught.length)
          : null;
      const peak = Math.round(runs.reduce((a, r) => a + r.peakHeat, 0) / runs.length);
      // Rounds spent at the table, including the ones sat out.
      const seen = Math.round(runs.reduce((a, r) => a + r.summaries.length, 0) / runs.length);
      console.log(
        `  ${policy.name.padEnd(34)} caught ${caught.length}/5  ` +
          `${avg === null ? "survived 600 bets" : `after ~${avg} bets`}`.padEnd(24) +
          `peak heat ${String(peak).padStart(3)}   ${seen} rounds at the table`,
      );
    }
    console.log("");
  }
}

/** Outcome frequencies, compared with the textbook numbers for 6-deck S17. */
function diagReport(): void {
  const rules = TABLE_PRESETS[0];
  const account: PlayerAccount = { bankroll: 1e9 };
  const rng = mulberry32(4242);
  const tally: Record<string, number> = {};
  let hands = 0;
  let dealerHands = 0;
  let dealerBust = 0;
  let dealerBJ = 0;
  let playerBJ = 0;
  let doubles = 0;
  let splits = 0;

  const sim = new TableSim(rules, rng, account, {
    onRoundEnd: (s) => {
      for (const r of s.results) {
        tally[r] = (tally[r] ?? 0) + 1;
        hands++;
      }
    },
  });
  sim.seats.forEach((s, i) => {
    if (i === 0) {
      s.kind = "empty";
    } else {
      s.kind = "npc";
      s.name = `NPC${i}`;
      s.chips = 1e7;
      s.npc = { skill: 0.95, aggression: 1, superstition: 0 };
    }
  });
  sim.sit(0);

  let lastRound = 0;
  let guard = 0;
  const target = 120000;
  while (hands < target && guard++ < target * 400) {
    if (sim.phase === "betting" && !sim.betLocked) {
      sim.setBet(rules.minBet);
      sim.confirmBet();
    }
    if (sim.offeringInsurance) sim.answerInsurance(false);
    const turn = sim.playerTurn();
    if (turn) {
      const seat = sim.seat!;
      const legal = legalActions(turn.hand, seat.hands.length, rules, account.bankroll);
      const { action } = correctAction(turn.hand, sim.dealerUpcard!, rules, legal, 0, false);
      if (action === "double") doubles++;
      if (action === "split") splits++;
      sim.act(action);
    }
    if (sim.phase === "settle" && sim.round !== lastRound) {
      lastRound = sim.round;
      dealerHands++;
      const t = sim.dealer.cards.reduce((a, c) => {
        return a;
      }, 0);
      void t;
      const dt = dealerTotal(sim);
      if (dt > 21) dealerBust++;
      if (sim.dealer.cards.length === 2 && dt === 21) dealerBJ++;
      const ph = sim.seat!.hands[0];
      if (ph && ph.cards.length === 2 && !ph.fromSplit && handValue(ph.cards) === 21) playerBJ++;
    }
    sim.update(DT);
  }

  console.log(`\nOUTCOME DIAGNOSTICS  --  ${hands.toLocaleString()} player hands\n`);
  const order = ["win", "lose", "push", "blackjack", "bust", "surrender"];
  const expected: Record<string, string> = {
    win: "~37%",
    lose: "~39%",
    push: "~8.5%",
    blackjack: "~4.7%",
    bust: "~16%",
    surrender: "~1%",
  };
  for (const k of order) {
    const n = tally[k] ?? 0;
    console.log(`  ${k.padEnd(11)} ${((n / hands) * 100).toFixed(2).padStart(6)}%   expected ${expected[k]}`);
  }
  console.log(
    `\n  dealer bust     ${((dealerBust / dealerHands) * 100).toFixed(2)}%   expected ~28.3% (S17)`,
  );
  console.log(`  dealer blackjack ${((dealerBJ / dealerHands) * 100).toFixed(2)}%   expected ~4.75%`);
  console.log(`  player blackjack ${((playerBJ / dealerHands) * 100).toFixed(2)}%   expected ~4.75%`);
  console.log(`  doubles ${doubles}  splits ${splits}`);
}

function dealerTotal(sim: TableSim): number {
  return handValue(sim.dealer.cards);
}

function handValue(cards: { rank: string }[]): number {
  let t = 0;
  let a = 0;
  for (const c of cards) {
    const v = c.rank === "A" ? 11 : ["T", "J", "Q", "K"].includes(c.rank) ? 10 : Number(c.rank);
    t += v;
    if (c.rank === "A") a++;
  }
  while (t > 21 && a > 0) {
    t -= 10;
    a--;
  }
  return t;
}

/**
 * Checks the settlement arithmetic hand by hand: every payout must match its
 * result, and the bankroll delta must equal payouts minus everything staked.
 */
function auditReport(): void {
  const rules = TABLE_PRESETS[0];
  const account: PlayerAccount = { bankroll: 1e9 };
  const rng = mulberry32(99);
  let rounds = 0;
  let badPayout = 0;
  let badLedger = 0;
  const byResult: Record<string, { n: number; net: number }> = {};
  let bankrollBefore = account.bankroll;
  let staked = 0;

  const sim = new TableSim(rules, rng, account, {});
  sim.seats.forEach((s, i) => {
    if (i === 0) s.kind = "empty";
    else {
      s.kind = "npc";
      s.name = `N${i}`;
      s.chips = 1e7;
      s.npc = { skill: 0.95, aggression: 1, superstition: 0 };
    }
  });
  sim.sit(0);

  let phaseWas = sim.phase;
  let guard = 0;
  while (rounds < 40000 && guard++ < 40000 * 400) {
    if (sim.phase === "betting" && !sim.betLocked) {
      bankrollBefore = account.bankroll;
      staked = 0;
      sim.setBet(rules.minBet);
      sim.confirmBet();
    }
    if (sim.offeringInsurance) sim.answerInsurance(false);
    const turn = sim.playerTurn();
    if (turn) {
      const seat = sim.seat!;
      const legal = legalActions(turn.hand, seat.hands.length, rules, account.bankroll);
      const { action } = correctAction(turn.hand, sim.dealerUpcard!, rules, legal, 0, false);
      sim.act(action);
    }
    sim.update(DT);

    // The settle step runs once and then moves the phase on.
    if (phaseWas === "settle" && sim.phase !== "settle") {
      rounds++;
      const seat = sim.seat!;
      let payouts = 0;
      staked = seat.insurance;
      for (const h of seat.hands) {
        staked += h.bet;
        const p = h.payout ?? 0;
        payouts += p;
        const bet = h.bet;
        const want =
          h.result === "surrender"
            ? bet / 2
            : h.result === "blackjack"
              ? bet * (1 + rules.blackjackPayout)
              : h.result === "win"
                ? bet * 2
                : h.result === "push"
                  ? bet
                  : 0;
        if (Math.abs(p - want) > 1e-9) badPayout++;
        const key = h.result ?? "?";
        byResult[key] = byResult[key] ?? { n: 0, net: 0 };
        byResult[key].n++;
        byResult[key].net += p - bet;
      }
      payouts += seat.insurance > 0 ? (sim.lastSummary?.net ?? 0) * 0 : 0;
      const ledger = account.bankroll - bankrollBefore;
      const expectedLedger = payouts - staked;
      if (Math.abs(ledger - expectedLedger) > 1e-6) badLedger++;
    }
    phaseWas = sim.phase;
  }

  console.log(`\nSETTLEMENT AUDIT  --  ${rounds.toLocaleString()} rounds\n`);
  console.log(`  payouts that did not match the result: ${badPayout}`);
  console.log(`  rounds where bankroll delta != payouts - staked: ${badLedger}\n`);
  let totalN = 0;
  let totalNet = 0;
  for (const [k, v] of Object.entries(byResult)) {
    totalN += v.n;
    totalNet += v.net;
    console.log(
      `  ${k.padEnd(11)} ${String(v.n).padStart(7)} hands  net/hand ${(v.net / v.n / rules.minBet).toFixed(3).padStart(7)} units`,
    );
  }
  console.log(
    `\n  overall  ${totalN.toLocaleString()} hands  ${(totalNet / totalN / rules.minBet).toFixed(4)} units per hand`,
  );
}

const arg = process.argv[2];
if (arg === "diag") diagReport();
if (arg === "audit") auditReport();
if (!arg || arg === "edge") edgeReport();
if (!arg || arg === "heat") heatReport();
