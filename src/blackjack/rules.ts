export interface TableRules {
  id: string;
  name: string;
  minBet: number;
  maxBet: number;
  decks: number;
  /** Fraction of the shoe dealt before the cut card comes out. */
  penetration: number;
  dealerHitsSoft17: boolean;
  /** 1.5 = 3:2, 1.2 = 6:5. */
  blackjackPayout: number;
  doubleAfterSplit: boolean;
  maxHands: number;
  resplitAces: boolean;
  hitSplitAces: boolean;
  lateSurrender: boolean;
  /** Seconds between dealt cards -- fast tables are harder to count. */
  dealSpeed: number;
  seats: number;
  /** How closely this pit watches the money. 0..1 */
  scrutiny: number;
}

export const TABLE_PRESETS: TableRules[] = [
  {
    id: "green",
    name: "Green Felt $10",
    minBet: 10,
    maxBet: 500,
    decks: 6,
    penetration: 0.75,
    dealerHitsSoft17: false,
    blackjackPayout: 1.5,
    doubleAfterSplit: true,
    maxHands: 4,
    resplitAces: false,
    hitSplitAces: false,
    lateSurrender: true,
    dealSpeed: 0.42,
    seats: 5,
    scrutiny: 0.55,
  },
  {
    id: "grind",
    name: "The Grind $5",
    minBet: 5,
    maxBet: 200,
    decks: 8,
    penetration: 0.68,
    dealerHitsSoft17: true,
    blackjackPayout: 1.2,
    doubleAfterSplit: true,
    maxHands: 4,
    resplitAces: false,
    hitSplitAces: false,
    lateSurrender: false,
    dealSpeed: 0.34,
    seats: 5,
    scrutiny: 0.35,
  },
  {
    id: "highlimit",
    name: "High Limit $100",
    minBet: 100,
    maxBet: 5000,
    decks: 6,
    penetration: 0.8,
    dealerHitsSoft17: false,
    blackjackPayout: 1.5,
    doubleAfterSplit: true,
    maxHands: 4,
    resplitAces: true,
    hitSplitAces: false,
    lateSurrender: true,
    dealSpeed: 0.5,
    seats: 4,
    scrutiny: 0.82,
  },
  {
    id: "double",
    name: "Double Deck $25",
    minBet: 25,
    maxBet: 1000,
    decks: 2,
    penetration: 0.65,
    dealerHitsSoft17: true,
    blackjackPayout: 1.5,
    doubleAfterSplit: false,
    maxHands: 2,
    resplitAces: false,
    hitSplitAces: false,
    lateSurrender: false,
    dealSpeed: 0.36,
    seats: 4,
    scrutiny: 0.8,
  },
];

export function rulesSummary(r: TableRules): string {
  const parts = [
    `${r.decks}D`,
    r.dealerHitsSoft17 ? "H17" : "S17",
    r.blackjackPayout === 1.5 ? "3:2" : "6:5",
    r.doubleAfterSplit ? "DAS" : "NDAS",
    r.lateSurrender ? "LS" : "NoS",
    `${Math.round(r.penetration * 100)}% pen`,
  ];
  return parts.join(" · ");
}

/**
 * Rough per-hand house edge off the top, for the results screen.
 * Baseline is 6 decks, S17, DAS, late surrender, 3:2, resplit to four.
 */
export function houseEdge(r: TableRules): number {
  let edge = 0.0034;
  if (r.dealerHitsSoft17) edge += 0.0022;
  if (r.blackjackPayout < 1.5) edge += 0.0139;
  if (!r.doubleAfterSplit) edge += 0.0014;
  if (!r.lateSurrender) edge += 0.0008;
  if (r.decks >= 8) edge += 0.0006;
  else if (r.decks <= 2) edge -= 0.0019;
  return edge;
}
