/**
 * Wire format shared by the client and the co-op server.
 *
 * The server is authoritative for everything that can move money: shoes, hands,
 * payouts and heat. Positions on the casino floor are client-reported, because
 * nothing is at stake in where somebody is standing.
 */
import type { Card } from "../blackjack/cards";
import type { Hand } from "../blackjack/hand";
import type { Phase, RoundSummary } from "../blackjack/sim";
import type { Action } from "../blackjack/strategy";
import type { Attention, HeatBreakdown } from "../heat/surveillance";

export const PROTOCOL_VERSION = 1;
export const SNAPSHOT_HZ = 15;
export const TICK_HZ = 30;
export const MAX_PLAYERS = 4;

export interface SeatView {
  index: number;
  kind: "empty" | "human" | "npc";
  name: string;
  playerId: string | null;
  bet: number;
  pendingBet: number;
  betLocked: boolean;
  sittingOut: boolean;
  hands: Hand[];
  active: number;
  insurance: number;
  insuranceAnswered: boolean;
  flash?: { text: string; color: string; t: number };
}

export interface TableView {
  id: string;
  /** Index into TABLE_PRESETS -- rules are static, so only the id travels. */
  rules: string;
  phase: Phase;
  round: number;
  seats: SeatView[];
  dealer: { cards: Card[]; holeHidden: boolean };
  timer: number;
  /** Seconds left on the dealer's patience; -1 when the table will wait. */
  clock: number;
  runningCount: number;
  decksRemaining: number;
  decksDealt: number;
  fractionDealt: number;
  cutCardOut: boolean;
  actor: { seat: number; hand: number } | null;
}

export interface PlayerView {
  id: string;
  name: string;
  x: number;
  y: number;
  hue: number;
  bankroll: number;
  tableId: string | null;
  seat: number | null;
  suspicion: number;
  attention: Attention;
  breakdown: HeatBreakdown;
  online: boolean;
  /** Seconds until the suits arrive, or -1. */
  backoffIn: number;
}

export type SignalKind =
  | "count"
  | "hot"
  | "cold"
  | "shuffle"
  | "heat"
  | "leaving"
  | "joinme";

export const SIGNAL_TEXT: Record<SignalKind, string> = {
  count: "the count is",
  hot: "shoe is hot -- get money out",
  cold: "shoe is cold -- flat bet",
  shuffle: "cut card is close",
  heat: "heat is on me",
  leaving: "I'm colouring up",
  joinme: "open seat at my table",
};

export interface SignalView {
  from: string;
  fromName: string;
  hue: number;
  kind: SignalKind;
  running?: number;
  trueCount?: number;
  tableId: string | null;
  /** Server clock in seconds when it was sent. */
  at: number;
}

/** Enough to draw a table on the floor without shipping every card. */
export interface TableBrief {
  id: string;
  rules: string;
  seats: ("empty" | "human" | "npc")[];
  humans: string[];
}

export interface RoomView {
  code: string;
  /** Minutes since 20:00, shared so the whole team sees one clock. */
  clock: number;
  players: PlayerView[];
  /** Full detail, only for tables somebody is sitting at. */
  tables: TableView[];
  briefs: TableBrief[];
  signals: SignalView[];
  now: number;
}

export type CoverKind = "tip" | "drink" | "break" | "cashier";

export type ClientMessage =
  | { t: "hello"; version: number; name: string; code?: string; bankroll: number; unit: number }
  | { t: "move"; x: number; y: number }
  | { t: "sit"; tableId: string }
  | { t: "stand" }
  | { t: "bet"; amount: number }
  | { t: "deal" }
  | { t: "sitout"; v: boolean }
  | { t: "act"; action: Action }
  | { t: "insurance"; take: boolean }
  | { t: "cover"; kind: CoverKind }
  | { t: "signal"; kind: SignalKind; running?: number; trueCount?: number }
  | { t: "ping" };

export type ServerMessage =
  | { t: "welcome"; code: string; youId: string; seed: number; room: RoomView }
  | { t: "snapshot"; room: RoomView }
  | { t: "event"; text: string; color: string; playerId?: string }
  | { t: "round"; summary: RoundSummary }
  | { t: "shuffle"; tableId: string; runningBefore: number }
  | { t: "backoff"; playerId: string }
  | { t: "error"; text: string }
  | { t: "pong" };

/** JSON has no Infinity, so an unlimited clock travels as -1. */
export function clockToWire(clock: number): number {
  return Number.isFinite(clock) ? clock : -1;
}

export function makeRoomCode(rand: () => number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 4; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}
