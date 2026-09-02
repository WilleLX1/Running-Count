export type Suit = "S" | "H" | "D" | "C";
export type Rank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "T" | "J" | "Q" | "K";

export interface Card {
  rank: Rank;
  suit: Suit;
  /** Unique within a shoe, used as a render key. */
  id: number;
}

export const SUITS: readonly Suit[] = ["S", "H", "D", "C"];
export const RANKS: readonly Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];

/** Ace counts 11 here; soft-total logic downgrades it later. */
export function cardValue(rank: Rank): number {
  if (rank === "A") return 11;
  if (rank === "T" || rank === "J" || rank === "Q" || rank === "K") return 10;
  return Number(rank);
}

/** Hi-Lo tag: 2-6 = +1, 7-9 = 0, 10-A = -1. */
export function hiLo(rank: Rank): number {
  const v = cardValue(rank);
  if (v >= 2 && v <= 6) return 1;
  if (v >= 7 && v <= 9) return 0;
  return -1;
}

export function suitSymbol(s: Suit): string {
  return s === "S" ? "♠" : s === "H" ? "♥" : s === "D" ? "♦" : "♣";
}

export function suitIsRed(s: Suit): boolean {
  return s === "H" || s === "D";
}

export function rankLabel(r: Rank): string {
  return r === "T" ? "10" : r;
}

export function cardName(c: Card): string {
  return rankLabel(c.rank) + suitSymbol(c.suit);
}
