import { Surveillance } from "../heat/surveillance";
import type { RoundSummary } from "../blackjack/sim";
import type { Action } from "../blackjack/strategy";

/** How much the game does the counting for you. */
export type AssistLevel = "full" | "partial" | "none";

export const ASSIST_LABEL: Record<AssistLevel, string> = {
  full: "Coached",
  partial: "Spotter",
  none: "Live money",
};

export const ASSIST_BLURB: Record<AssistLevel, string> = {
  full: "Running count, true count, correct play and the bet ramp are all shown. Learn the moves here.",
  partial: "You keep the count yourself with +/-. The game only tells you when you drift off.",
  none: "No count, no hints. Count checks at the shuffle. This is the real thing.",
};

export interface DecisionRecord {
  correct: boolean;
  chosen: Action;
  expected: Action;
  wasDeviation: boolean;
  total: string;
  up: string;
}

export interface Stats {
  roundsPlayed: number;
  handsPlayed: number;
  wagered: number;
  net: number;
  decisions: number;
  decisionsCorrect: number;
  deviationsHit: number;
  deviationsMissed: number;
  betsRated: number;
  betsGood: number;
  countChecks: number;
  countChecksCorrect: number;
  biggestWin: number;
  biggestLoss: number;
  backoffs: number;
  timePlayed: number;
}

export function emptyStats(): Stats {
  return {
    roundsPlayed: 0,
    handsPlayed: 0,
    wagered: 0,
    net: 0,
    decisions: 0,
    decisionsCorrect: 0,
    deviationsHit: 0,
    deviationsMissed: 0,
    betsRated: 0,
    betsGood: 0,
    countChecks: 0,
    countChecksCorrect: 0,
    biggestWin: 0,
    biggestLoss: 0,
    backoffs: 0,
    timePlayed: 0,
  };
}

const SAVE_KEY = "running-count.save.v1";

export class Session {
  bankroll = 2000;
  startingBankroll = 2000;
  /** Betting unit -- the yardstick for the ramp and for heat. */
  unit = 10;
  assist: AssistLevel = "full";
  useDeviations = true;
  stats: Stats = emptyStats();
  surveillance = new Surveillance();
  recentDecisions: DecisionRecord[] = [];

  /** The count the player is holding in their own head (test modes). */
  playerRunning = 0;
  /** Set when a hand-in count check is on screen. */
  pendingCountCheck = false;

  /** Career numbers that survive a session. */
  best = { bankroll: 2000, countAccuracy: 0, sessions: 0 };

  reset(bankroll = 2000, unit = 10): void {
    this.bankroll = bankroll;
    this.startingBankroll = bankroll;
    this.unit = unit;
    this.stats = emptyStats();
    this.surveillance = new Surveillance();
    this.recentDecisions = [];
    this.playerRunning = 0;
  }

  recordRound(s: RoundSummary): void {
    if (s.satOut) return;
    this.stats.roundsPlayed++;
    this.stats.handsPlayed += s.handsPlayed;
    this.stats.wagered += s.bet;
    this.stats.net += s.net;
    if (s.net > this.stats.biggestWin) this.stats.biggestWin = s.net;
    if (s.net < this.stats.biggestLoss) this.stats.biggestLoss = s.net;
  }

  recordDecision(d: DecisionRecord): void {
    this.stats.decisions++;
    if (d.correct) this.stats.decisionsCorrect++;
    if (d.wasDeviation) {
      if (d.correct) this.stats.deviationsHit++;
      else this.stats.deviationsMissed++;
    }
    this.recentDecisions.unshift(d);
    if (this.recentDecisions.length > 8) this.recentDecisions.pop();
  }

  recordBet(good: boolean): void {
    this.stats.betsRated++;
    if (good) this.stats.betsGood++;
  }

  recordCountCheck(correct: boolean): void {
    this.stats.countChecks++;
    if (correct) this.stats.countChecksCorrect++;
  }

  get decisionAccuracy(): number {
    return this.stats.decisions ? this.stats.decisionsCorrect / this.stats.decisions : 1;
  }

  get countAccuracy(): number {
    return this.stats.countChecks ? this.stats.countChecksCorrect / this.stats.countChecks : 1;
  }

  get betAccuracy(): number {
    return this.stats.betsRated ? this.stats.betsGood / this.stats.betsRated : 1;
  }

  save(): void {
    try {
      localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({ best: this.best, assist: this.assist, useDeviations: this.useDeviations }),
      );
    } catch {
      /* storage can be unavailable; the game still runs */
    }
  }

  load(): void {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as Partial<Session> & { best?: Session["best"] };
      if (data.best) this.best = { ...this.best, ...data.best };
      if (data.assist) this.assist = data.assist;
      if (typeof data.useDeviations === "boolean") this.useDeviations = data.useDeviations;
    } catch {
      /* corrupt save -- ignore */
    }
  }
}
