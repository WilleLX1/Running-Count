import { hiLo, type Card } from "./cards";

/**
 * Hi-Lo count bookkeeping. The sim keeps a perfect count internally; the player
 * keeps their own in their head (or via the manual counter in test mode).
 */
export class CountState {
  running = 0;
  seen = 0;

  reset(): void {
    this.running = 0;
    this.seen = 0;
  }

  see(card: Card): void {
    this.running += hiLo(card.rank);
    this.seen++;
  }

  /** Standard Hi-Lo conversion: running count / decks remaining. */
  trueCount(decksRemaining: number): number {
    return this.running / Math.max(0.25, decksRemaining);
  }
}

/** What a human at the table can actually estimate: decks in quarter-deck steps. */
export function estimateDecksRemaining(exact: number): number {
  return Math.max(0.25, Math.round(exact * 4) / 4);
}

/** Floor toward zero -- the conservative convention most counters use. */
export function floorTrueCount(tc: number): number {
  return tc >= 0 ? Math.floor(tc) : Math.ceil(tc);
}

export interface BetRamp {
  /** True count at or above which this level applies. */
  tc: number;
  units: number;
}

/** A 1-12 spread. Aggressive enough to earn, aggressive enough to get caught. */
export const DEFAULT_RAMP: BetRamp[] = [
  { tc: -99, units: 1 },
  { tc: 1, units: 1 },
  { tc: 2, units: 2 },
  { tc: 3, units: 4 },
  { tc: 4, units: 8 },
  { tc: 5, units: 12 },
];

export function unitsForCount(tc: number, ramp: BetRamp[] = DEFAULT_RAMP): number {
  let units = 1;
  for (const step of ramp) if (tc >= step.tc) units = step.units;
  return units;
}

/** Player advantage estimate: roughly -0.5% off the top, +0.5% per true count. */
export function playerEdge(trueCount: number, baseEdge: number): number {
  return -baseEdge + trueCount * 0.005;
}

/**
 * A "correct" bet for the count, snapped to the table's chip denominations.
 * Used for the trainer's feedback, never forced on the player.
 */
export function recommendedBet(
  trueCount: number,
  unit: number,
  min: number,
  max: number,
  ramp: BetRamp[] = DEFAULT_RAMP,
): number {
  const raw = unitsForCount(Math.floor(trueCount), ramp) * unit;
  return Math.max(min, Math.min(max, Math.round(raw / min) * min));
}
