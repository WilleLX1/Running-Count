import { clamp, correlation } from "../core/math";
import type { RoundSummary } from "../blackjack/sim";
import type { TableRules } from "../blackjack/rules";

export type Attention = "clear" | "noticed" | "watching" | "pit" | "backoff" | "barred";

export const ATTENTION_LABEL: Record<Attention, string> = {
  clear: "Nobody is looking",
  noticed: "Dealer glanced at your chips",
  watching: "Floor supervisor is watching",
  pit: "Pit boss is on the phone to the eye",
  backoff: "You have been backed off",
  barred: "You are barred from the property",
};

/** What surveillance actually logs about a hand. */
export interface Observation {
  bet: number;
  trueCount: number;
  net: number;
  minBet: number;
  satOut: boolean;
  insurance: boolean;
  round: number;
}

export interface HeatBreakdown {
  spread: number;
  correlation: number;
  jump: number;
  winRate: number;
  wonging: number;
  tells: number;
}

const THRESHOLDS: { level: Attention; at: number }[] = [
  { level: "noticed", at: 22 },
  { level: "watching", at: 45 },
  { level: "pit", at: 70 },
  { level: "backoff", at: 92 },
];

export class Surveillance {
  /** 0..100 */
  suspicion = 0;
  attention: Attention = "clear";
  /** Persists across tables: the pit remembers a face. */
  recognition = 0;
  observations: Observation[] = [];
  breakdown: HeatBreakdown = {
    spread: 0,
    correlation: 0,
    jump: 0,
    winRate: 0,
    wonging: 0,
    tells: 0,
  };
  /** Seconds since the player last did something reassuring. */
  timeSinceCover = 0;
  lastEvent = "";
  backoffPending = false;
  barred = false;
  /** Session profit as seen by the pit, in table minimums. */
  private profitUnits = 0;
  private consecutiveSitOuts = 0;

  reset(): void {
    this.suspicion = 0;
    this.attention = "clear";
    this.observations = [];
    this.profitUnits = 0;
    this.consecutiveSitOuts = 0;
    this.backoffPending = false;
  }

  /** Called every frame; heat bleeds off slowly while you behave. */
  update(dt: number, atTable: boolean): void {
    this.timeSinceCover += dt;
    // Attention fades while you sit there behaving, and much faster once you
    // are away from the tables entirely.
    const decay = atTable ? 0.07 : 0.9;
    this.suspicion = Math.max(0, this.suspicion - decay * dt);
    this.recognition = Math.max(0, this.recognition - 0.03 * dt);
    this.refreshAttention();
  }

  /** Leaving the property entirely cools things down a lot. */
  leaveTable(): void {
    this.consecutiveSitOuts = 0;
    this.suspicion = Math.max(0, this.suspicion - 4);
  }

  /** Tipping, chatting, ordering a drink -- cheap cover plays. */
  applyCover(strength: number, label: string): void {
    this.suspicion = Math.max(0, this.suspicion - strength);
    this.timeSinceCover = 0;
    this.lastEvent = label;
    this.refreshAttention();
  }

  observe(summary: RoundSummary, rules: TableRules, unit: number): void {
    const obs: Observation = {
      bet: summary.bet,
      trueCount: summary.trueCountAtBet,
      net: summary.net,
      minBet: rules.minBet,
      satOut: summary.satOut,
      insurance: summary.insuranceTaken,
      round: summary.round,
    };
    this.observations.push(obs);
    if (this.observations.length > 60) this.observations.shift();

    const played = this.observations.filter((o) => !o.satOut);
    const scrutiny = rules.scrutiny;
    const b = this.breakdown;

    // 1. Raw spread. A 1-12 spread on a $10 table is a neon sign.
    const bets = played.map((o) => o.bet);
    const maxBet = bets.length ? Math.max(...bets) : 0;
    const minPlayed = bets.length ? Math.min(...bets) : rules.minBet;
    const spread = minPlayed > 0 ? maxBet / minPlayed : 1;
    b.spread = clamp((spread - 2.5) / 9, 0, 1) * scrutiny;

    // 2. The one that really gets you barred: does bet size track the count?
    if (played.length >= 8) {
      const r = correlation(
        played.slice(-25).map((o) => o.trueCount),
        played.slice(-25).map((o) => o.bet),
      );
      b.correlation = clamp((r - 0.3) / 0.5, 0, 1) * scrutiny;
    } else {
      b.correlation = 0;
    }

    // 3. Big jumps between consecutive hands.
    if (played.length >= 2) {
      const prev = played[played.length - 2].bet;
      const cur = played[played.length - 1].bet;
      const ratio = prev > 0 ? cur / prev : 1;
      b.jump = clamp((Math.max(ratio, 1 / Math.max(ratio, 0.001)) - 2.5) / 6, 0, 1) * scrutiny;
    }

    // 4. Winning fast draws eyes even if your play is clean.
    this.profitUnits += summary.net / Math.max(1, unit);
    b.winRate = clamp((this.profitUnits - 25) / 120, 0, 1) * scrutiny;

    // 5. Wonging: sitting out cold shoes and jumping in hot ones.
    if (summary.satOut) {
      this.consecutiveSitOuts++;
    } else {
      if (this.consecutiveSitOuts >= 2 && summary.trueCountAtBet >= 2) {
        b.wonging = clamp(b.wonging + 0.22 * scrutiny, 0, 1);
      }
      this.consecutiveSitOuts = 0;
    }
    b.wonging = Math.max(0, b.wonging - 0.01);

    // 6. Tells: insurance is a bet only a counter makes.
    if (summary.insuranceTaken && summary.trueCountAtBet >= 2.5) {
      b.tells = clamp(b.tells + 0.3 * scrutiny, 0, 1);
    }
    b.tells = Math.max(0, b.tells - 0.005);

    // Correlation dominates on purpose: the pit does not need to know Hi-Lo,
    // only that the money goes up when the shoe is good. Weights are tuned in
    // scripts/simulate.ts -- see `npm run sim -- heat`.
    const perRound =
      b.spread * 1.9 +
      b.correlation * 6.8 +
      b.jump * 1.5 +
      b.winRate * 2.0 +
      b.wonging * 2.6 +
      b.tells * 2.2;

    const coverBonus = this.timeSinceCover < 90 ? 0.75 : 1;
    this.suspicion = clamp(this.suspicion + perRound * coverBonus + this.recognition * 0.08, 0, 100);
    this.refreshAttention();
  }

  private refreshAttention(): void {
    if (this.barred) {
      this.attention = "barred";
      return;
    }
    let level: Attention = "clear";
    for (const t of THRESHOLDS) if (this.suspicion >= t.at) level = t.level;
    if (level === "backoff" && this.attention !== "backoff") {
      this.backoffPending = true;
      this.recognition = Math.min(100, this.recognition + 40);
    }
    this.attention = level;
  }

  /** Heat the player can actually perceive: body language, not a number. */
  tellText(): string {
    switch (this.attention) {
      case "clear":
        return "The pit is chatting about football.";
      case "noticed":
        return "The dealer keeps glancing at your chip tray.";
      case "watching":
        return "A floor supervisor drifted over and is not leaving.";
      case "pit":
        return "The pit boss is reading your play back to someone upstairs.";
      case "backoff":
        return "Two suits are walking toward your table.";
      case "barred":
        return "Security has your photograph.";
    }
  }
}
