import type { Hand } from "../blackjack/hand";
import type { TableRules } from "../blackjack/rules";
import type { TableSim } from "../blackjack/sim";
import type { Action } from "../blackjack/strategy";
import { viewTable } from "../net/serialize";
import type { SeatView, TableView } from "../net/protocol";
import type { NetClient } from "../net/client";

/**
 * The table scene talks to this and never to a simulation directly, so solo
 * play and co-op render and behave identically.
 */
export interface TableController {
  readonly id: string;
  readonly rules: TableRules;
  readonly playerId: string;
  readonly online: boolean;
  /** Fresh snapshot for this frame. */
  view(): TableView | null;
  /** Chips this player has pushed out but not committed. */
  pendingBet(): number;
  update(dt: number): void;
  setBet(amount: number): void;
  addBet(delta: number): void;
  confirmBet(): void;
  setSittingOut(v: boolean): void;
  act(action: Action): void;
  answerInsurance(take: boolean): void;
  leave(): void;
}

export const LOCAL_PLAYER_ID = "you";

// ---------------------------------------------------------------- helpers

export function seatOf(view: TableView | null, playerId: string): SeatView | null {
  if (!view) return null;
  return view.seats.find((s) => s.kind === "human" && s.playerId === playerId) ?? null;
}

export function turnOf(
  view: TableView | null,
  playerId: string,
): { hand: Hand; index: number; seat: SeatView } | null {
  if (!view || view.phase !== "playing" || !view.actor) return null;
  const seat = view.seats[view.actor.seat];
  if (!seat || seat.kind !== "human" || seat.playerId !== playerId) return null;
  const hand = seat.hands[view.actor.hand];
  if (!hand || hand.cards.length < 2) return null;
  return { hand, index: view.actor.hand, seat };
}

export function isOfferingInsurance(view: TableView | null, playerId: string): boolean {
  if (!view || view.phase !== "insurance") return false;
  const seat = seatOf(view, playerId);
  return !!seat && seat.bet > 0 && !seat.insuranceAnswered;
}

export function trueCountOf(view: TableView | null): number {
  if (!view) return 0;
  return view.runningCount / Math.max(0.25, view.decksRemaining);
}

export function freeSeatCount(view: TableView | null): number {
  if (!view) return 0;
  return view.seats.filter((s) => s.kind === "empty").length;
}

// ------------------------------------------------------------------ solo

export class LocalTable implements TableController {
  readonly playerId = LOCAL_PLAYER_ID;
  readonly online = false;

  constructor(
    readonly id: string,
    private sim: TableSim,
    private rulesId: string,
  ) {}

  get rules(): TableRules {
    return this.sim.rules;
  }

  view(): TableView {
    return viewTable(this.id, this.rulesId, this.sim);
  }

  pendingBet(): number {
    return this.sim.seatOf(this.playerId)?.pendingBet ?? 0;
  }

  update(dt: number): void {
    this.sim.update(dt);
  }

  setBet(amount: number): void {
    this.sim.setBet(this.playerId, amount);
  }

  addBet(delta: number): void {
    this.sim.addBet(this.playerId, delta);
  }

  confirmBet(): void {
    this.sim.confirmBet(this.playerId);
  }

  setSittingOut(v: boolean): void {
    this.sim.setSittingOut(this.playerId, v);
  }

  act(action: Action): void {
    this.sim.act(this.playerId, action);
  }

  answerInsurance(take: boolean): void {
    this.sim.answerInsurance(this.playerId, take);
  }

  leave(): void {
    this.sim.standUp(this.playerId);
  }
}

// ---------------------------------------------------------------- co-op

export class RemoteTable implements TableController {
  readonly online = true;

  constructor(
    readonly id: string,
    private net: NetClient,
    private rulesRef: TableRules,
  ) {}

  get rules(): TableRules {
    return this.rulesRef;
  }

  get playerId(): string {
    return this.net.youId;
  }

  view(): TableView | null {
    return this.net.table(this.id);
  }

  /** Local intent, so chip clicks respond without waiting for a round trip. */
  pendingBet(): number {
    return this.net.pendingBet;
  }

  update(): void {
    /* the server owns the clock */
  }

  setBet(amount: number): void {
    this.net.setPendingBet(amount);
    this.net.send({ t: "bet", amount });
  }

  addBet(delta: number): void {
    this.setBet(this.net.pendingBet + delta);
  }

  confirmBet(): void {
    this.net.send({ t: "deal" });
  }

  setSittingOut(v: boolean): void {
    this.net.send({ t: "sitout", v });
  }

  act(action: Action): void {
    this.net.send({ t: "act", action });
  }

  answerInsurance(take: boolean): void {
    this.net.send({ t: "insurance", take });
  }

  leave(): void {
    this.net.send({ t: "stand" });
  }
}
