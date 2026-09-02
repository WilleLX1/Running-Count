import { cardValue, type Card } from "./cards";
import type { TableRules } from "./rules";

export type HandResult = "win" | "lose" | "push" | "blackjack" | "bust" | "surrender";

export interface Hand {
  cards: Card[];
  bet: number;
  doubled: boolean;
  surrendered: boolean;
  /** Finished acting. */
  done: boolean;
  /** Came out of a split, so it can never be a natural. */
  fromSplit: boolean;
  result?: HandResult;
  payout?: number;
}

export function newHand(bet: number, fromSplit = false): Hand {
  return { cards: [], bet, doubled: false, surrendered: false, done: false, fromSplit };
}

export interface Total {
  total: number;
  soft: boolean;
}

export function handTotal(cards: Card[]): Total {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const v = cardValue(c.rank);
    total += v;
    if (c.rank === "A") aces++;
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  if (aces === 0) soft = false;
  return { total, soft };
}

export function isBlackjack(h: Hand): boolean {
  return !h.fromSplit && h.cards.length === 2 && handTotal(h.cards).total === 21;
}

export function isBust(h: Hand): boolean {
  return handTotal(h.cards).total > 21;
}

export function isPair(h: Hand): boolean {
  if (h.cards.length !== 2) return false;
  return cardValue(h.cards[0].rank) === cardValue(h.cards[1].rank);
}

export interface Legal {
  hit: boolean;
  stand: boolean;
  double: boolean;
  split: boolean;
  surrender: boolean;
}

export function legalActions(
  h: Hand,
  handCount: number,
  rules: TableRules,
  bankroll: number,
): Legal {
  const t = handTotal(h.cards);
  const fresh = h.cards.length === 2;
  const splitAces = h.fromSplit && h.cards[0]?.rank === "A";
  const frozen = h.done || t.total > 21 || (splitAces && !rules.hitSplitAces);
  if (frozen) {
    return { hit: false, stand: false, double: false, split: false, surrender: false };
  }
  const canAfford = bankroll >= h.bet;
  return {
    hit: true,
    stand: true,
    double: fresh && canAfford && (!h.fromSplit || rules.doubleAfterSplit),
    split:
      fresh &&
      isPair(h) &&
      canAfford &&
      handCount < rules.maxHands &&
      (h.cards[0].rank !== "A" || !h.fromSplit || rules.resplitAces),
    surrender: rules.lateSurrender && fresh && !h.fromSplit,
  };
}

export function describeTotal(cards: Card[]): string {
  if (cards.length === 0) return "--";
  const t = handTotal(cards);
  if (t.total > 21) return `${t.total} BUST`;
  return t.soft ? `soft ${t.total}` : `${t.total}`;
}
