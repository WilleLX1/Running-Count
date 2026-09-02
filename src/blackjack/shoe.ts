import { RANKS, SUITS, type Card } from "./cards";
import { shuffle, type Rng } from "../core/rng";

export class Shoe {
  cards: Card[] = [];
  pos = 0;
  /** Index at which the cut card appears; the shoe finishes the current round. */
  cutIndex = 0;
  cutCardOut = false;
  shuffles = 0;

  constructor(
    public decks: number,
    public penetration: number,
    private rng: Rng,
  ) {
    this.reshuffle();
  }

  reshuffle(): void {
    const cards: Card[] = [];
    let id = 0;
    for (let d = 0; d < this.decks; d++) {
      for (const s of SUITS) {
        for (const r of RANKS) {
          cards.push({ rank: r, suit: s, id: id++ });
        }
      }
    }
    shuffle(cards, this.rng);
    this.cards = cards;
    this.pos = 0;
    this.cutCardOut = false;
    this.shuffles++;
    // Cut card placement wobbles a little, like a real hand cut.
    const jitter = (this.rng() - 0.5) * 0.05;
    this.cutIndex = Math.floor(cards.length * Math.max(0.4, Math.min(0.92, this.penetration + jitter)));
  }

  draw(): Card {
    if (this.pos >= this.cards.length) this.reshuffle();
    const c = this.cards[this.pos++];
    if (this.pos >= this.cutIndex) this.cutCardOut = true;
    return c;
  }

  /** Cards already dealt -- i.e. what is visible in the discard tray. */
  get dealt(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.cards.length - this.pos;
  }

  get decksRemaining(): number {
    return this.remaining / 52;
  }

  get decksDealt(): number {
    return this.pos / 52;
  }

  get fractionDealt(): number {
    return this.pos / this.cards.length;
  }
}
