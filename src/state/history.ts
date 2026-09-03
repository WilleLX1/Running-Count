import type { HeatBreakdown } from "../heat/surveillance";
import type { AssistLevel } from "./session";

/**
 * Everything that ever happened, kept in local storage so the graphs have
 * something to draw. Three kinds of record, because a night in the casino, a
 * drill and a training shoe are not the same shape.
 */
export interface CasinoRecord {
  kind: "casino";
  /** When the session ended. */
  at: number;
  /** When you walked in. */
  startedAt: number;
  reason: "walked" | "backoff" | "broke";
  coop: boolean;
  assist: AssistLevel;
  unit: number;
  startBankroll: number;
  endBankroll: number;
  rounds: number;
  hands: number;
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
  peakHeat: number;
  heat: HeatBreakdown;
  /** Wall clock from walking in to walking out. */
  minutes: number;
  /** Of that, how much was actually spent at a table or on the floor. */
  activeMinutes: number;
}

export interface DrillRecord {
  kind: "drill";
  at: number;
  startedAt: number;
  drill: string;
  right: number;
  total: number;
  bestStreak: number;
  /** Mean time to answer, in milliseconds. */
  msPerAnswer: number;
  /** Count-down-a-deck: seconds for the whole deck. */
  deckSeconds?: number;
  /** Cancel the pair: how many cards were arriving at once. */
  groupSize?: number;
  /** Count a deck: cards in the run, and how many at a time. */
  cards?: number;
  perFlash?: number;
}

export interface ShoeRecord {
  kind: "shoe";
  at: number;
  startedAt: number;
  decks: number;
  players: number;
  speed: number;
  counter: "off" | "on" | "blind";
  hints: boolean;
  cardsSeen: number;
  checks: number;
  checksCorrect: number;
  tagChecks: number;
  tagChecksCorrect: number;
  /** Fraction of cards your counter agreed with the shoe, or -1 with no counter. */
  inStep: number;
  peeks: number;
  peekSeconds: number;
  avgMiss: number;
  finalRc: boolean;
  finalDecks: boolean;
  finalTc: boolean;
}

export type HistoryRecord = CasinoRecord | DrillRecord | ShoeRecord;

const KEY = "running-count.history.v1";
const CAP = 400;

export class History {
  records: HistoryRecord[] = [];

  load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      this.records = parsed
        .filter((r) => r && typeof r.at === "number")
        .map((r: HistoryRecord) => {
          // Records written before sessions had a start time: reconstruct it
          // from the length we did save, so old rows still plot sensibly.
          if (typeof (r as { startedAt?: number }).startedAt === "number") return r;
          const minutes = r.kind === "casino" ? r.minutes : 0;
          return { ...r, startedAt: r.at - minutes * 60_000 };
        });
    } catch {
      /* corrupt or unavailable storage just means an empty history */
    }
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.records));
    } catch {
      /* nothing to be done about a full or blocked store */
    }
  }

  add(r: HistoryRecord): void {
    this.records.push(r);
    if (this.records.length > CAP) this.records.splice(0, this.records.length - CAP);
    this.save();
  }

  clear(): void {
    this.records = [];
    this.save();
  }

  get casino(): CasinoRecord[] {
    return this.records.filter((r): r is CasinoRecord => r.kind === "casino");
  }

  get shoes(): ShoeRecord[] {
    return this.records.filter((r): r is ShoeRecord => r.kind === "shoe");
  }

  drills(id?: string): DrillRecord[] {
    return this.records.filter(
      (r): r is DrillRecord => r.kind === "drill" && (!id || r.drill === id),
    );
  }

  /** Which drills have ever been played, most recent first. */
  drillIds(): string[] {
    const seen = new Set<string>();
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r.kind === "drill") seen.add(r.drill);
    }
    return [...seen];
  }

  get lifetime() {
    const c = this.casino;
    const sum = (pick: (r: CasinoRecord) => number) => c.reduce((a, r) => a + pick(r), 0);
    const rounds = sum((r) => r.rounds);
    return {
      sessions: c.length,
      net: sum((r) => r.net),
      rounds,
      hands: sum((r) => r.hands),
      wagered: sum((r) => r.wagered),
      minutes: sum((r) => r.minutes),
      backoffs: c.filter((r) => r.reason === "backoff").length,
      best: c.length ? Math.max(...c.map((r) => r.endBankroll)) : 0,
      perHundred: rounds > 0 ? (sum((r) => r.net) / rounds) * 100 : 0,
      drills: this.drills().length,
      shoes: this.shoes.length,
    };
  }
}

export function ratio(hit: number, total: number): number | null {
  return total > 0 ? hit / total : null;
}

export function dayLabel(at: number): string {
  const d = new Date(at);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function clockLabel(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function timeLabel(at: number): string {
  return `${dayLabel(at)} ${clockLabel(at)}`;
}

/** Short axis label: the day and the time the session began. */
export function sessionLabel(r: HistoryRecord): string {
  return `${dayLabel(r.startedAt)} ${clockLabel(r.startedAt)}`;
}

/** The whole span, for a hover readout or the log. */
export function spanLabel(r: HistoryRecord): string {
  const mins = Math.max(0, (r.at - r.startedAt) / 60_000);
  const same = new Date(r.startedAt).toDateString() === new Date(r.at).toDateString();
  const end = same ? clockLabel(r.at) : timeLabel(r.at);
  return `${timeLabel(r.startedAt)} → ${end}  ·  ${formatMinutes(mins)}`;
}

export function formatMinutes(mins: number): string {
  if (mins < 1) return `${Math.round(mins * 60)}s`;
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  return `${h}h ${Math.round(mins - h * 60)}m`;
}
