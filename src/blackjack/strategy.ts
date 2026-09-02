import { cardValue, type Card } from "./cards";
import { handTotal, isPair, type Hand, type Legal } from "./hand";
import type { TableRules } from "./rules";

export type Action = "hit" | "stand" | "double" | "split" | "surrender";

export const ACTION_LABEL: Record<Action, string> = {
  hit: "Hit",
  stand: "Stand",
  double: "Double",
  split: "Split",
  surrender: "Surrender",
};

/**
 * Cell codes:
 *  H hit, S stand, D double else hit, T double else stand,
 *  P split, Q split if DAS else hit, R surrender else hit, U surrender else stand
 * Columns are dealer upcard 2,3,4,5,6,7,8,9,10,A.
 */
const HARD: Record<number, string> = {
  5: "HHHHHHHHHH",
  6: "HHHHHHHHHH",
  7: "HHHHHHHHHH",
  8: "HHHHHHHHHH",
  9: "HDDDDHHHHH",
  10: "DDDDDDDDHH",
  11: "DDDDDDDDDD",
  12: "HHSSSHHHHH",
  13: "SSSSSHHHHH",
  14: "SSSSSHHHHH",
  15: "SSSSSHHHRH",
  16: "SSSSSHHRRR",
  17: "SSSSSSSSSS",
  18: "SSSSSSSSSS",
  19: "SSSSSSSSSS",
  20: "SSSSSSSSSS",
  21: "SSSSSSSSSS",
};

/** Keyed by the non-ace card: 2 means A-2 (soft 13). */
const SOFT: Record<number, string> = {
  2: "HHHDDHHHHH",
  3: "HHHDDHHHHH",
  4: "HHDDDHHHHH",
  5: "HHDDDHHHHH",
  6: "HDDDDHHHHH",
  7: "TTTTTSSHHH",
  8: "SSSSSSSSSS",
  9: "SSSSSSSSSS",
};

/** Keyed by the value of one card of the pair; 11 = aces. */
const PAIRS: Record<number, string> = {
  2: "QQPPPPHHHH",
  3: "QQPPPPHHHH",
  4: "HHHQQHHHHH",
  5: "DDDDDDDDHH",
  6: "QPPPPHHHHH",
  7: "PPPPPPHHHH",
  8: "PPPPPPPPPP",
  9: "PPPPPSPPSS",
  10: "SSSSSSSSSS",
  11: "PPPPPPPPPP",
};

export function dealerIndex(up: Card): number {
  const v = cardValue(up.rank);
  return v === 11 ? 9 : v - 2;
}

export function dealerValue(up: Card): number {
  return cardValue(up.rank);
}

function resolve(code: string, legal: Legal, rules: TableRules): Action {
  switch (code) {
    case "H":
      return "hit";
    case "S":
      return "stand";
    case "D":
      return legal.double ? "double" : "hit";
    case "T":
      return legal.double ? "double" : "stand";
    case "P":
      return legal.split ? "split" : "hit";
    case "Q":
      return rules.doubleAfterSplit && legal.split ? "split" : "hit";
    case "R":
      return legal.surrender ? "surrender" : "hit";
    case "U":
      return legal.surrender ? "surrender" : "stand";
    default:
      return "stand";
  }
}

/** Composition-independent multi-deck basic strategy. */
export function basicStrategy(hand: Hand, up: Card, rules: TableRules, legal: Legal): Action {
  const di = dealerIndex(up);
  const upv = dealerValue(up);

  if (isPair(hand) && legal.split) {
    const pv = cardValue(hand.cards[0].rank);
    // H17: surrender 8,8 vs an ace rather than splitting into a dealer 21.
    if (rules.dealerHitsSoft17 && pv === 8 && upv === 11 && legal.surrender) return "surrender";
    const row = PAIRS[pv];
    if (row) {
      const code = row[di];
      if (code !== "S" || pv === 10) return resolve(code, legal, rules);
    }
  }

  const t = handTotal(hand.cards);
  if (t.soft && hand.cards.length >= 2) {
    const other = t.total - 11;
    const row = SOFT[other];
    if (row) {
      let code = row[di];
      // H17: soft 19 doubles against a 6, soft 18 doubles against a 2.
      if (rules.dealerHitsSoft17 && other === 8 && upv === 6) code = "T";
      return resolve(code, legal, rules);
    }
    if (t.total >= 19) return "stand";
  }

  const total = Math.max(5, Math.min(21, t.total));
  let code = (HARD[total] ?? "SSSSSSSSSS")[di];
  if (rules.dealerHitsSoft17) {
    if (total === 15 && upv === 11) code = "R";
    if (total === 17 && upv === 11) code = "U";
  }
  return resolve(code, legal, rules);
}

export interface Deviation {
  name: string;
  /** Hard total, or soft total when soft is true. */
  total?: number;
  soft?: boolean;
  /** Value of a single card of the pair. */
  pair?: number;
  up: number;
  index: number;
  /** true: play when TC >= index. false: play when TC <= index. */
  above: boolean;
  action: Action;
}

/** Illustrious 18 (insurance handled separately) plus the Fab 4 surrenders. */
export const DEVIATIONS: Deviation[] = [
  { name: "16 v 10 stand", total: 16, up: 10, index: 0, above: true, action: "stand" },
  { name: "15 v 10 stand", total: 15, up: 10, index: 4, above: true, action: "stand" },
  { name: "10,10 v 5 split", pair: 10, up: 5, index: 5, above: true, action: "split" },
  { name: "10,10 v 6 split", pair: 10, up: 6, index: 4, above: true, action: "split" },
  { name: "10 v 10 double", total: 10, up: 10, index: 4, above: true, action: "double" },
  { name: "12 v 3 stand", total: 12, up: 3, index: 2, above: true, action: "stand" },
  { name: "12 v 2 stand", total: 12, up: 2, index: 3, above: true, action: "stand" },
  { name: "11 v A double", total: 11, up: 11, index: 1, above: true, action: "double" },
  { name: "9 v 2 double", total: 9, up: 2, index: 1, above: true, action: "double" },
  { name: "10 v A double", total: 10, up: 11, index: 4, above: true, action: "double" },
  { name: "9 v 7 double", total: 9, up: 7, index: 3, above: true, action: "double" },
  { name: "16 v 9 stand", total: 16, up: 9, index: 5, above: true, action: "stand" },
  { name: "13 v 2 hit", total: 13, up: 2, index: -1, above: false, action: "hit" },
  { name: "12 v 4 hit", total: 12, up: 4, index: 0, above: false, action: "hit" },
  { name: "12 v 5 hit", total: 12, up: 5, index: -2, above: false, action: "hit" },
  { name: "12 v 6 hit", total: 12, up: 6, index: -1, above: false, action: "hit" },
  { name: "13 v 3 hit", total: 13, up: 3, index: -2, above: false, action: "hit" },
  { name: "14 v 10 surrender", total: 14, up: 10, index: 3, above: true, action: "surrender" },
  { name: "15 v 10 surrender", total: 15, up: 10, index: 0, above: true, action: "surrender" },
  { name: "15 v 9 surrender", total: 15, up: 9, index: 2, above: true, action: "surrender" },
  { name: "15 v A surrender", total: 15, up: 11, index: 1, above: true, action: "surrender" },
];

export const INSURANCE_INDEX = 3;

function actionAllowed(a: Action, legal: Legal): boolean {
  return (
    (a === "hit" && legal.hit) ||
    (a === "stand" && legal.stand) ||
    (a === "double" && legal.double) ||
    (a === "split" && legal.split) ||
    (a === "surrender" && legal.surrender)
  );
}

/** The index play in effect for this hand, if any. */
export function deviationFor(
  hand: Hand,
  up: Card,
  trueCount: number,
  legal: Legal,
): Deviation | null {
  const t = handTotal(hand.cards);
  const upv = dealerValue(up);
  const pairValue = isPair(hand) ? cardValue(hand.cards[0].rank) : null;
  // Surrender indices only apply to the first two cards.
  for (const d of DEVIATIONS) {
    if (d.up !== upv) continue;
    if (d.pair != null) {
      if (pairValue !== d.pair) continue;
    } else {
      if (t.soft || t.total !== d.total) continue;
      if (hand.cards.length !== 2 && (d.action === "double" || d.action === "surrender")) continue;
    }
    const on = d.above ? trueCount >= d.index : trueCount <= d.index;
    if (!on) continue;
    if (!actionAllowed(d.action, legal)) continue;
    return d;
  }
  return null;
}

/** Basic strategy, overridden by index plays when the count says so. */
export function correctAction(
  hand: Hand,
  up: Card,
  rules: TableRules,
  legal: Legal,
  trueCount: number,
  useDeviations: boolean,
): { action: Action; deviation: Deviation | null } {
  if (useDeviations) {
    const d = deviationFor(hand, up, trueCount, legal);
    if (d) return { action: d.action, deviation: d };
  }
  return { action: basicStrategy(hand, up, rules, legal), deviation: null };
}

export function shouldInsure(trueCount: number): boolean {
  return trueCount >= INSURANCE_INDEX;
}
