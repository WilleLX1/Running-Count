import type { Game, Scene } from "../game";
import { VH, VW } from "../core/renderer";
import { C, button, fillRound, text, vignette, type Frame } from "../core/ui";
import { drawCard, drawHand } from "../render/cards";
import { RANKS, SUITS, cardValue, hiLo, type Card, type Rank } from "../blackjack/cards";
import { mulberry32, pick, randInt, randomSeed, shuffle, type Rng } from "../core/rng";
import { newHand, type Hand } from "../blackjack/hand";
import { legalActions } from "../blackjack/hand";
import { ACTION_LABEL, DEVIATIONS, basicStrategy, correctAction, type Action } from "../blackjack/strategy";
import { TABLE_PRESETS } from "../blackjack/rules";
import { TableSim } from "../blackjack/sim";
import { floorTrueCount } from "../blackjack/counting";
import { signed } from "../core/math";
import { wrapText } from "./menu";
import { LiveTableScene } from "./livetable";

type DrillId =
  | "menu"
  | "live"
  | "tags"
  | "pairs"
  | "speed"
  | "deckdown"
  | "board"
  | "decks"
  | "truecount"
  | "strategy"
  | "index";

const RULES = TABLE_PRESETS[0];

interface DrillInfo {
  id: DrillId;
  name: string;
  blurb: string;
  accent: string;
}

const DRILLS: DrillInfo[] = [
  {
    id: "live",
    name: "Live table",
    blurb: "A real dealer and a real shoe. No betting, no decisions — just hold the count.",
    accent: C.gold,
  },
  { id: "tags", name: "Card tags", blurb: "One card. +1, 0 or −1. Build the reflex.", accent: C.green },
  {
    id: "pairs",
    name: "Cancel the pair",
    blurb: "Two cards at once — call the net, do not add them one by one.",
    accent: C.blue,
  },
  { id: "speed", name: "Count a deck", blurb: "Cards flash by. Hold the count, call it at the end.", accent: C.blue },
  {
    id: "deckdown",
    name: "Count down a deck",
    blurb: "One deck, last card face down. Name it from your count alone.",
    accent: C.purple,
  },
  {
    id: "board",
    name: "Net the table",
    blurb: "A settled table, every card face up. Scan it and call the net.",
    accent: C.blue,
  },
  { id: "decks", name: "Read the tray", blurb: "Estimate the decks in the discard tray.", accent: C.gold },
  { id: "truecount", name: "True count", blurb: "Running count over a tray. Convert toward zero.", accent: C.purple },
  { id: "strategy", name: "Basic strategy", blurb: "Every hand, every upcard, until automatic.", accent: C.green },
  { id: "index", name: "Index plays", blurb: "The Illustrious 18 with a true count attached.", accent: C.heat },
];

export class TrainerScene implements Scene {
  private drill: DrillId = "menu";
  private rng: Rng = mulberry32(randomSeed());
  private score = { right: 0, total: 0, streak: 0, best: 0 };

  // shared per-drill state
  private card: Card | null = null;
  private answerT = 0;
  private lastCorrect: boolean | null = null;
  private explain = "";

  /** Wall clock when this drill run began. */
  private drillStartedAt = 0;
  /** When the current question went up, and how long recent answers took. */
  private askedAt = 0;
  private answerTimes: number[] = [];

  // cancel-the-pair drill
  private pairSize = 2;
  private pairProgressive = true;
  private pairCards: Card[] = [];
  private pairAsked = 0;
  private pairTimes: number[] = [];

  // count-down-a-deck drill
  private downCards: Card[] = [];
  private downIndex = 0;
  private downTimer = 0;
  private downInterval = 0.6;
  private downState: "setup" | "running" | "answer" | "result" = "setup";
  private downElapsed = 0;

  // net-the-table drill
  private boardDealer: Card[] = [];
  private boardHands: Card[][] = [];
  private boardSeats = 4;
  private boardTruth = 0;

  // speed drill
  private speedPer = 1;
  private speedCards: Card[] = [];
  private speedIndex = 0;
  private speedTimer = 0;
  private speedInterval = 0.9;
  private speedCount = 26;
  private speedState: "setup" | "running" | "answer" | "result" = "setup";
  private entry = 0;
  private runningTruth = 0;

  // tray drills
  private trayDecks = 2;
  private trayGuess = 2;
  private rcGiven = 0;

  // strategy drills
  private hand: Hand | null = null;
  private up: Card | null = null;
  private trueCount = 0;
  private expected: Action = "hit";
  private deviationName = "";

  constructor(private game: Game, private onExit: () => void) {}

  frame(f: Frame): void {
    const { ctx } = f;
    ctx.fillStyle = "#0a0e13";
    ctx.fillRect(0, 0, VW, VH);

    if (this.drill === "menu") this.menu(f);
    else this.runDrill(f);

    vignette(ctx, VW, VH, 0.4);
  }

  private header(f: Frame, title: string, sub: string): void {
    const { ctx } = f;
    text(ctx, title, 60, 66, { size: 30, weight: "700" });
    text(ctx, sub, 60, 92, { size: 14, color: C.dim });
    if (this.drill !== "menu") {
      const acc = this.score.total ? (this.score.right / this.score.total) * 100 : 0;
      text(ctx, `${this.score.right}/${this.score.total}  ·  ${acc.toFixed(0)}%  ·  streak ${this.score.streak} (best ${this.score.best})`, VW - 60, 66, {
        size: 15,
        align: "right",
        color: C.dim,
        mono: true,
      });
    }
    if (button(f, { x: VW - 180, y: VH - 62, w: 140, h: 44 }, this.drill === "menu" ? "Back" : "Drill list", { hotkey: "ESC" }) ||
      f.input.consume("Escape")) {
      if (this.drill === "menu") this.onExit();
      else this.setDrill("menu");
    }
  }

  exit(): void {
    this.flush();
  }

  /** Write the run just finished into the history, if there was one. */
  private flush(): void {
    if (this.drill === "menu" || this.score.total === 0) return;
    const times = this.answerTimes;
    const msPerAnswer = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    this.game.history.add({
      kind: "drill",
      at: Date.now(),
      startedAt: this.drillStartedAt || Date.now(),
      drill: this.drill,
      right: this.score.right,
      total: this.score.total,
      bestStreak: this.score.best,
      msPerAnswer,
      ...(this.drill === "deckdown" && this.downElapsed > 0
        ? { deckSeconds: this.downElapsed }
        : {}),
      ...(this.drill === "pairs" ? { groupSize: this.pairCards.length } : {}),
      ...(this.drill === "speed" ? { cards: this.speedCount, perFlash: this.speedPer } : {}),
    });
  }

  private setDrill(id: DrillId): void {
    if (id === "live") {
      // Its own scene: it renders a whole table rather than a single prompt.
      this.game.setScene(new LiveTableScene(this.game, () => this.game.setScene(this)));
      return;
    }
    this.flush();
    this.drill = id;
    this.score = { right: 0, total: 0, streak: 0, best: 0 };
    this.lastCorrect = null;
    this.explain = "";
    this.answerT = 0;
    this.answerTimes = [];
    this.askedAt = 0;
    this.drillStartedAt = Date.now();
    this.speedState = "setup";
    this.next();
  }

  private menu(f: Frame): void {
    this.header(f, "Training room", "No money, no pit boss. Just repetitions.");
    const cols = 4;
    const cw = (VW - 120 - (cols - 1) * 14) / cols;
    DRILLS.forEach((d, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const r = { x: 60 + col * (cw + 14), y: 130 + row * 168, w: cw, h: 146 };
      const hover = f.mx >= r.x && f.mx <= r.x + r.w && f.my >= r.y && f.my <= r.y + r.h;
      fillRound(f.ctx, r, 12, hover ? C.panelHi : C.panel, hover ? d.accent : C.line, hover ? 2 : 1);
      wrapText(f.ctx, d.name, r.x + 18, r.y + 38, r.w - 46, 24, {
        size: 20,
        weight: "700",
        color: d.accent,
      });
      wrapText(f.ctx, d.blurb, r.x + 18, r.y + 74, r.w - 36, 19, { size: 13, color: C.dim });
      // Keys 1-9 then 0 for the tenth.
      const key = i < 9 ? String(i + 1) : "0";
      text(f.ctx, key, r.x + r.w - 18, r.y + 34, {
        size: 14,
        color: C.faint,
        align: "right",
        weight: "700",
      });
      if ((hover && f.clicked) || f.input.consume(key)) this.setDrill(d.id);
    });
  }

  private randomCard(): Card {
    return { rank: pick(RANKS, this.rng), suit: pick(SUITS, this.rng), id: Math.floor(this.rng() * 1e9) };
  }

  /**
   * A card that does not look like the one before it. Repeats read as a glitch
   * and a repeated rank lets you coast on the previous tag instead of reading
   * the new card, so both are avoided where possible.
   */
  private nextDistinctCard(prev: Card | null): Card {
    if (!prev) return this.randomCard();
    for (let i = 0; i < 40; i++) {
      const c = this.randomCard();
      if (c.rank !== prev.rank && c.suit !== prev.suit) return c;
    }
    let c = this.randomCard();
    while (c.rank === prev.rank && c.suit === prev.suit) c = this.randomCard();
    return c;
  }

  /**
   * A run of cards dealt off real decks rather than drawn with replacement, so
   * no card can come round twice in a row, and never two of the same rank or
   * suit back to back while the shoe still has an alternative.
   */
  private buildRun(count: number): Card[] {
    const decks = Math.max(2, Math.ceil(count / 40));
    const pool: Card[] = [];
    let id = 0;
    for (let d = 0; d < decks; d++) {
      for (const s of SUITS) for (const r of RANKS) pool.push({ rank: r, suit: s, id: id++ });
    }
    shuffle(pool, this.rng);

    const out: Card[] = [];
    let prev: Card | null = null;
    for (let i = 0; i < count && pool.length > 0; i++) {
      let at = 0;
      if (prev) {
        const last = prev;
        // The pool is shuffled, so the first card matching a rule is a random one.
        at = pool.findIndex((c) => c.rank !== last.rank && c.suit !== last.suit);
        if (at < 0) at = pool.findIndex((c) => c.rank !== last.rank);
        if (at < 0) at = pool.findIndex((c) => c.suit !== last.suit);
        if (at < 0) at = 0;
      }
      prev = pool.splice(at, 1)[0];
      out.push(prev);
    }
    return out;
  }

  private mark(correct: boolean, explain = ""): void {
    if (this.askedAt > 0) {
      this.answerTimes.push(performance.now() - this.askedAt);
      if (this.answerTimes.length > 40) this.answerTimes.shift();
    }
    this.score.total++;
    if (correct) {
      this.score.right++;
      this.score.streak++;
      this.score.best = Math.max(this.score.best, this.score.streak);
    } else {
      this.score.streak = 0;
    }
    this.lastCorrect = correct;
    this.explain = explain;
    this.answerT = correct ? 0.5 : 2.2;
  }

  private next(): void {
    this.lastCorrect = null;
    this.explain = "";
    this.askedAt = performance.now();
    switch (this.drill) {
      case "tags":
        this.card = this.nextDistinctCard(this.card);
        break;
      case "decks":
        this.trayDecks = randInt(this.rng, 2, 20) / 4;
        this.trayGuess = 3;
        break;
      case "truecount":
        this.trayDecks = randInt(this.rng, 2, 20) / 4;
        this.rcGiven = randInt(this.rng, -14, 16);
        this.entry = 0;
        break;
      case "strategy":
        this.dealStrategyHand(false);
        break;
      case "index":
        this.dealStrategyHand(true);
        break;
      case "speed":
        this.speedState = "setup";
        break;
      case "pairs": {
        const size = this.pairProgressive
          ? Math.min(4, 2 + Math.floor(this.score.streak / 8))
          : this.pairSize;
        this.pairCards = this.buildGroup(size);
        this.pairAsked = performance.now();
        break;
      }
      case "deckdown":
        this.downState = "setup";
        break;
      case "board":
        this.dealBoard();
        break;
      default:
        break;
    }
  }

  /** A short run of cards, none of them looking like their neighbour. */
  private buildGroup(n: number): Card[] {
    const out: Card[] = [];
    let prev: Card | null = null;
    for (let i = 0; i < n; i++) {
      prev = this.nextDistinctCard(prev);
      out.push(prev);
    }
    return out;
  }

  private tagsOf(cards: Card[]): number {
    return cards.reduce((a, c) => a + hiLo(c.rank), 0);
  }

  // ------------------------------------------------------------- the drills

  private runDrill(f: Frame): void {
    switch (this.drill) {
      case "tags":
        this.tagDrill(f);
        break;
      case "speed":
        this.speedDrill(f);
        break;
      case "decks":
        this.deckDrill(f);
        break;
      case "truecount":
        this.trueCountDrill(f);
        break;
      case "pairs":
        this.pairDrill(f);
        break;
      case "deckdown":
        this.deckDownDrill(f);
        break;
      case "board":
        this.boardDrill(f);
        break;
      case "strategy":
      case "index":
        this.strategyDrill(f);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------- cancel the pair

  private pairDrill(f: Frame): void {
    const { ctx } = f;
    const size = this.pairCards.length || 2;
    const avg = this.pairTimes.length
      ? this.pairTimes.reduce((a, b) => a + b, 0) / this.pairTimes.length
      : 0;
    this.header(
      f,
      "Cancel the pair",
      "Read the group as one number. A five and a king are nothing — do not add them one at a time.",
    );

    if (avg > 0) {
      text(ctx, `${(avg / 1000).toFixed(2)}s a group`, VW - 60, 92, {
        size: 13,
        color: C.faint,
        align: "right",
        mono: true,
      });
    }

    // Group size controls.
    const sizes = [2, 3, 4];
    sizes.forEach((n, i) => {
      const r = { x: 60 + i * 62, y: 118, w: 56, h: 34 };
      if (
        button(f, r, String(n), {
          small: true,
          accent: C.blue,
          active: !this.pairProgressive && this.pairSize === n,
        })
      ) {
        this.pairProgressive = false;
        this.pairSize = n;
        this.next();
      }
    });
    if (
      button(f, { x: 250, y: 118, w: 150, h: 34 }, "Progressive", {
        small: true,
        accent: C.gold,
        active: this.pairProgressive,
      })
    ) {
      this.pairProgressive = true;
      this.next();
    }
    if (this.pairProgressive) {
      text(ctx, `grows with your streak — ${size} at a time now`, 416, 140, {
        size: 12,
        color: C.faint,
      });
    }

    // The group.
    const cw = 96;
    const gap = 14;
    const totalW = size * cw + (size - 1) * gap;
    const startX = VW / 2 - totalW / 2;
    this.pairCards.forEach((c, i) => {
      drawCard(ctx, c, startX + i * (cw + gap), 186, cw, cw * 1.42);
    });

    // Answer buttons: every net the group can produce.
    const nets: number[] = [];
    for (let v = -size; v <= size; v++) nets.push(v);
    const bw = Math.min(96, (VW - 240) / nets.length - 10);
    const rowW = nets.length * (bw + 10) - 10;
    let picked: number | null = null;
    nets.forEach((v, i) => {
      const r = { x: VW / 2 - rowW / 2 + i * (bw + 10), y: 424, w: bw, h: 62 };
      const label = v > 0 ? `+${v}` : String(v);
      const hot = String(i + 1);
      if (
        button(f, r, label, {
          accent: v > 0 ? C.green : v < 0 ? C.red : C.dim,
          hotkey: hot,
        })
      ) {
        picked = v;
      }
      if (f.input.consume(hot)) picked = v;
    });

    if (this.answerT > 0) {
      this.answerT -= f.dt;
      this.drawVerdict(f, 534);
      if (this.answerT <= 0) this.next();
      return;
    }
    if (picked !== null) {
      const truth = this.tagsOf(this.pairCards);
      this.pairTimes.push(performance.now() - this.pairAsked);
      if (this.pairTimes.length > 20) this.pairTimes.shift();
      const parts = this.pairCards
        .map((c) => {
          const t = hiLo(c.rank);
          return `${c.rank === "T" ? "10" : c.rank} ${t > 0 ? "+1" : t < 0 ? "−1" : "0"}`;
        })
        .join("   ");
      this.mark(picked === truth, `${parts}   →   ${signed(truth)}`);
    }
  }

  // ----------------------------------------------------- count down a deck

  private deckDownDrill(f: Frame): void {
    const { ctx } = f;
    this.header(
      f,
      "Count down a deck",
      "One deck, dealt out bar the last card. A whole deck sums to zero, so your count names the card you cannot see.",
    );

    if (this.downState === "setup") {
      text(ctx, "Seconds per card", 300, 226, { size: 14, color: C.faint });
      text(ctx, this.downInterval.toFixed(2), 300, 266, { size: 34, weight: "800", mono: true });
      if (button(f, { x: 440, y: 232, w: 46, h: 40 }, "−"))
        this.downInterval = Math.max(0.1, +(this.downInterval - 0.05).toFixed(2));
      if (button(f, { x: 494, y: 232, w: 46, h: 40 }, "+"))
        this.downInterval = Math.min(2, +(this.downInterval + 0.05).toFixed(2));
      text(
        ctx,
        "Under thirty seconds for the deck is the benchmark counters aim at.",
        300,
        320,
        { size: 13, color: C.faint },
      );
      if (
        button(f, { x: 300, y: 380, w: 240, h: 60 }, "Deal", { accent: C.green, hotkey: "SPACE" }) ||
        f.input.consume(" ", "Enter")
      ) {
        this.downCards = this.buildDeck();
        this.downIndex = 0;
        this.downTimer = 0;
        this.downElapsed = 0;
        this.downState = "running";
      }
      return;
    }

    if (this.downState === "running") {
      this.downTimer -= f.dt;
      this.downElapsed += f.dt;
      if (this.downTimer <= 0) {
        this.downIndex++;
        this.downTimer = this.downInterval;
      }
      // The last card is never shown -- it is the answer.
      if (this.downIndex >= this.downCards.length - 1) {
        this.downState = "answer";
        return;
      }
      drawCard(ctx, this.downCards[this.downIndex], VW / 2 - 70, 190, 140, 198);
      text(ctx, `${this.downIndex + 1} / ${this.downCards.length - 1}`, VW / 2, 430, {
        size: 15,
        color: C.faint,
        align: "center",
        mono: true,
      });
      text(ctx, `${this.downElapsed.toFixed(1)}s`, VW / 2, 452, {
        size: 13,
        color: C.dim,
        align: "center",
        mono: true,
      });
      const w = 600 * (this.downIndex / (this.downCards.length - 1));
      fillRound(ctx, { x: VW / 2 - 300, y: 466, w: 600, h: 6 }, 3, "#182029");
      fillRound(ctx, { x: VW / 2 - 300, y: 466, w, h: 6 }, 3, C.purple);
      return;
    }

    const last = this.downCards[this.downCards.length - 1];
    const truth = hiLo(last.rank);

    if (this.downState === "answer") {
      text(ctx, "What is the last card?", VW / 2, 230, {
        size: 26,
        align: "center",
        weight: "700",
      });
      text(
        ctx,
        `You counted ${this.downCards.length - 1} cards in ${this.downElapsed.toFixed(1)}s. Your count is the negative of the card left face down.`,
        VW / 2,
        258,
        { size: 13, align: "center", color: C.faint },
      );
      drawCard(ctx, null, VW / 2 - 50, 280, 100, 142, { faceDown: true });
      const opts: { label: string; value: number; accent: string; key: string }[] = [
        { label: "Low  2–6", value: 1, accent: C.green, key: "1" },
        { label: "Neutral  7–9", value: 0, accent: C.dim, key: "2" },
        { label: "High  10–A", value: -1, accent: C.red, key: "3" },
      ];
      let picked: number | null = null;
      opts.forEach((o, i) => {
        const r = { x: VW / 2 - 300 + i * 204, y: 452, w: 192, h: 66 };
        if (button(f, r, o.label, { accent: o.accent, hotkey: o.key })) picked = o.value;
        if (f.input.consume(o.key)) picked = o.value;
      });
      if (picked !== null) {
        this.mark(
          picked === truth,
          `It was the ${last.rank === "T" ? "10" : last.rank} of ${suitName(last.suit)} — ${signed(truth)}.`,
        );
        this.downState = "result";
      }
      return;
    }

    // result
    drawCard(ctx, last, VW / 2 - 60, 210, 120, 170);
    this.drawVerdict(f, 424);
    text(
      ctx,
      `Your count through the other ${this.downCards.length - 1} cards must have been ${signed(-truth)}.`,
      VW / 2,
      478,
      { size: 14, align: "center", color: C.dim },
    );
    if (
      button(f, { x: VW / 2 - 110, y: 504, w: 220, h: 52 }, "Again", {
        accent: C.green,
        hotkey: "SPACE",
      }) ||
      f.input.consume(" ", "Enter")
    ) {
      this.downState = "setup";
    }
  }

  /** One genuine 52-card deck, so the tags really do sum to zero. */
  private buildDeck(): Card[] {
    const pool: Card[] = [];
    let id = 0;
    for (const s of SUITS) for (const r of RANKS) pool.push({ rank: r, suit: s, id: id++ });
    shuffle(pool, this.rng);
    return pool;
  }

  // -------------------------------------------------------- net the table

  private dealBoard(): void {
    const rules = { ...RULES, seats: this.boardSeats, dealSpeed: 0.01 };
    const sim = new TableSim(rules, this.rng, {});
    sim.seats.forEach((s, i) => {
      s.kind = "npc";
      s.name = `Seat ${i + 1}`;
      s.playerId = null;
      s.chips = 1e7;
      s.npc = { skill: 0.9, aggression: 1, superstition: 0.2 };
    });
    let guard = 0;
    while (guard++ < 4000) {
      sim.update(0.5);
      if (sim.phase === "settle" && !sim.dealer.holeHidden) break;
    }
    this.boardDealer = sim.dealer.cards.slice();
    this.boardHands = sim.seats
      .filter((s) => s.hands.length > 0)
      .map((s) => s.hands.flatMap((h) => h.cards));
    this.boardTruth =
      this.tagsOf(this.boardDealer) + this.boardHands.reduce((a, h) => a + this.tagsOf(h), 0);
    this.entry = 0;
  }

  private boardDrill(f: Frame): void {
    const { ctx } = f;
    this.header(
      f,
      "Net the table",
      "The hand is over and every card is face up. Sweep it and call the net before the dealer clears it.",
    );

    const seats = [3, 4, 5, 6];
    seats.forEach((n, i) => {
      const r = { x: 60 + i * 62, y: 118, w: 56, h: 34 };
      if (button(f, r, String(n), { small: true, accent: C.blue, active: this.boardSeats === n })) {
        this.boardSeats = n;
        this.next();
      }
    });
    text(ctx, "seats", 60 + seats.length * 62 + 8, 140, { size: 12, color: C.faint });

    // Dealer, then the hands in a row.
    const dw = (this.boardDealer.length - 1) * 26 + 54;
    drawHand(ctx, this.boardDealer, VW / 2 - dw / 2, 168, { scale: 0.86, overlap: 26 });
    text(ctx, "DEALER", VW / 2, 168 + 88 + 14, {
      size: 10,
      color: C.faint,
      align: "center",
      weight: "700",
    });

    const n = this.boardHands.length;
    const slot = Math.min(220, (VW - 160) / Math.max(1, n));
    this.boardHands.forEach((hand, i) => {
      const cx = VW / 2 - (n * slot) / 2 + slot * i + slot / 2;
      const hw = (hand.length - 1) * 22 + 46;
      drawHand(ctx, hand, cx - hw / 2, 306, { scale: 0.74, overlap: 22 });
      if (this.answerT > 0) {
        const net = this.tagsOf(hand);
        text(ctx, signed(net), cx, 306 + 78, {
          size: 15,
          weight: "800",
          align: "center",
          color: net > 0 ? C.green : net < 0 ? C.red : C.faint,
        });
      }
    });
    if (this.answerT > 0) {
      const dn = this.tagsOf(this.boardDealer);
      text(ctx, signed(dn), VW / 2 + dw / 2 + 24, 168 + 44, {
        size: 15,
        weight: "800",
        color: dn > 0 ? C.green : dn < 0 ? C.red : C.faint,
      });
    }

    text(ctx, "Net", 480, 452, { size: 14, color: C.faint });
    fillRound(ctx, { x: 480, y: 464, w: 150, h: 58 }, 8, "#0a0f14", C.line);
    text(ctx, signed(this.entry), 555, 502, { size: 32, weight: "800", mono: true, align: "center" });
    if (button(f, { x: 646, y: 468, w: 56, h: 50 }, "−")) this.entry--;
    if (button(f, { x: 710, y: 468, w: 56, h: 50 }, "+")) this.entry++;
    if (f.input.consume("arrowdown", "arrowleft", "-")) this.entry--;
    if (f.input.consume("arrowup", "arrowright", "+", "=")) this.entry++;

    if (this.answerT > 0) {
      this.answerT -= f.dt;
      this.drawVerdict(f, 566);
      if (this.answerT <= 0) this.next();
      return;
    }
    if (
      button(f, { x: 790, y: 468, w: 150, h: 50 }, "Call it", { accent: C.gold, hotkey: "ENTER" }) ||
      f.input.consume("Enter", " ")
    ) {
      this.mark(this.entry === this.boardTruth, `The felt was worth ${signed(this.boardTruth)}.`);
    }
  }

  private tagDrill(f: Frame): void {
    this.header(f, "Card tags", "Left −1, Down 0, Right +1. Speed matters more than thinking.");
    const { ctx } = f;
    if (this.card) drawCard(ctx, this.card, VW / 2 - 60, 170, 120, 170);

    const opts: { label: string; value: number; key: string; accent: string }[] = [
      { label: "−1", value: -1, key: "←", accent: C.red },
      { label: "0", value: 0, key: "↓", accent: C.dim },
      { label: "+1", value: 1, key: "→", accent: C.green },
    ];
    let picked: number | null = null;
    opts.forEach((o, i) => {
      const r = { x: VW / 2 - 285 + i * 190, y: 400, w: 170, h: 76 };
      if (button(f, r, o.label, { accent: o.accent, hotkey: o.key })) picked = o.value;
    });
    if (f.input.consume("arrowleft")) picked = -1;
    if (f.input.consume("arrowdown")) picked = 0;
    if (f.input.consume("arrowright")) picked = 1;

    if (this.answerT > 0) {
      this.answerT -= f.dt;
      this.drawVerdict(f, 520);
      if (this.answerT <= 0) this.next();
      return;
    }
    if (picked !== null && this.card) {
      const truth = hiLo(this.card.rank);
      this.mark(picked === truth, `${this.card.rank === "T" ? "10" : this.card.rank} is ${signed(truth)}`);
    }
  }

  private speedDrill(f: Frame): void {
    this.header(f, "Count a deck", "Keep the running count as the cards go by.");
    const { ctx } = f;

    if (this.speedState === "setup") {
      text(ctx, "Cards", 300, 240, { size: 14, color: C.faint });
      text(ctx, String(this.speedCount), 300, 280, { size: 34, weight: "800", mono: true });
      if (button(f, { x: 380, y: 246, w: 46, h: 40 }, "−")) this.speedCount = Math.max(10, this.speedCount - 6);
      if (button(f, { x: 434, y: 246, w: 46, h: 40 }, "+")) this.speedCount = Math.min(104, this.speedCount + 6);

      text(ctx, "Seconds per card", 620, 240, { size: 14, color: C.faint });
      text(ctx, this.speedInterval.toFixed(2), 620, 280, { size: 34, weight: "800", mono: true });
      if (button(f, { x: 760, y: 246, w: 46, h: 40 }, "−"))
        this.speedInterval = Math.max(0.15, +(this.speedInterval - 0.1).toFixed(2));
      if (button(f, { x: 814, y: 246, w: 46, h: 40 }, "+"))
        this.speedInterval = Math.min(2, +(this.speedInterval + 0.1).toFixed(2));

      text(ctx, "Cards at a time", 300, 350, { size: 14, color: C.faint });
      [1, 2, 3].forEach((n, i) => {
        const r = { x: 300 + i * 62, y: 362, w: 56, h: 40 };
        if (button(f, r, String(n), { small: true, accent: C.blue, active: this.speedPer === n })) {
          this.speedPer = n;
        }
      });
      text(
        ctx,
        this.speedPer === 1
          ? "One at a time. Tag, add, hold."
          : "Read the group as one number instead of adding it card by card.",
        500,
        388,
        { size: 13, color: C.faint },
      );

      text(ctx, "A dealer at a full table puts out about one card every 0.6 seconds.", 300, 440, {
        size: 13,
        color: C.faint,
      });

      if (button(f, { x: 300, y: 470, w: 240, h: 60 }, "Start", { accent: C.green, hotkey: "SPACE" }) ||
        f.input.consume(" ", "Enter")) {
        this.speedCards = this.buildRun(this.speedCount);
        this.runningTruth = this.speedCards.reduce((a, c) => a + hiLo(c.rank), 0);
        this.speedIndex = 0;
        this.speedTimer = 0;
        this.entry = 0;
        this.speedState = "running";
      }
      return;
    }

    if (this.speedState === "running") {
      const per = this.speedPer;
      this.speedTimer -= f.dt;
      if (this.speedTimer <= 0) {
        this.speedIndex += per;
        // A group of two takes a little longer than a single card, not double.
        this.speedTimer = this.speedInterval * (1 + (per - 1) * 0.7);
      }
      if (this.speedIndex >= this.speedCards.length) {
        this.speedState = "answer";
        return;
      }
      const group = this.speedCards.slice(this.speedIndex, this.speedIndex + per);
      const cw = per === 1 ? 140 : per === 2 ? 120 : 104;
      const gap = 16;
      const totalW = group.length * cw + (group.length - 1) * gap;
      group.forEach((c, i) => {
        drawCard(ctx, c, VW / 2 - totalW / 2 + i * (cw + gap), 190, cw, cw * 1.42);
      });
      text(
        ctx,
        `${Math.min(this.speedIndex + per, this.speedCards.length)} / ${this.speedCards.length}`,
        VW / 2,
        430,
        { size: 15, color: C.faint, align: "center", mono: true },
      );
      const w = 600 * (this.speedIndex / this.speedCards.length);
      fillRound(ctx, { x: VW / 2 - 300, y: 452, w: 600, h: 6 }, 3, "#182029");
      fillRound(ctx, { x: VW / 2 - 300, y: 452, w, h: 6 }, 3, C.blue);
      return;
    }

    if (this.speedState === "answer") {
      text(ctx, "Running count?", VW / 2, 240, { size: 26, align: "center", weight: "700" });
      fillRound(ctx, { x: VW / 2 - 90, y: 270, w: 180, h: 74 }, 10, "#0a0f14", C.line);
      text(ctx, signed(this.entry), VW / 2, 318, { size: 42, align: "center", weight: "800", mono: true });
      if (button(f, { x: VW / 2 - 180, y: 284, w: 70, h: 46 }, "−", { accent: C.red })) this.entry--;
      if (button(f, { x: VW / 2 + 110, y: 284, w: 70, h: 46 }, "+", { accent: C.green })) this.entry++;
      if (f.input.consume("arrowdown", "arrowleft", "-")) this.entry--;
      if (f.input.consume("arrowup", "arrowright", "+", "=")) this.entry++;
      if (button(f, { x: VW / 2 - 90, y: 372, w: 180, h: 50 }, "Call it", { accent: C.gold, hotkey: "ENTER" }) ||
        f.input.consume("Enter", " ")) {
        this.mark(this.entry === this.runningTruth, `The count was ${signed(this.runningTruth)}.`);
        this.speedState = "result";
      }
      return;
    }

    // result
    this.drawVerdict(f, 300);
    text(ctx, `You said ${signed(this.entry)}, the shoe said ${signed(this.runningTruth)}.`, VW / 2, 360, {
      size: 16,
      align: "center",
      color: C.dim,
    });
    if (button(f, { x: VW / 2 - 110, y: 410, w: 220, h: 52 }, "Again", { accent: C.green, hotkey: "SPACE" }) ||
      f.input.consume(" ", "Enter")) {
      this.speedState = "setup";
    }
  }

  private drawTray(f: Frame, x: number, y: number, decks: number, totalDecks = 6): void {
    const { ctx } = f;
    const h = 240;
    const w = 110;
    fillRound(ctx, { x, y, w, h }, 8, "rgba(10,20,16,0.75)", "#3d5a4c", 2);
    const filled = (decks / totalDecks) * (h - 12);
    ctx.fillStyle = "#d9d2c4";
    ctx.fillRect(x + 6, y + h - 6 - filled, w - 12, filled);
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = 1;
    for (let yy = y + h - 6 - filled; yy < y + h - 6; yy += 3) {
      ctx.beginPath();
      ctx.moveTo(x + 6, yy);
      ctx.lineTo(x + w - 6, yy);
      ctx.stroke();
    }
    text(ctx, "DISCARD TRAY", x + w / 2, y + h + 18, {
      size: 11,
      color: C.faint,
      align: "center",
      weight: "700",
    });
  }

  private deckDrill(f: Frame): void {
    this.header(f, "Read the tray", "Six deck shoe. How many decks are in the tray?");
    this.drawTray(f, 220, 150, this.trayDecks);

    const { ctx } = f;
    text(ctx, "Your estimate", 460, 200, { size: 14, color: C.faint });
    text(ctx, `${this.trayGuess.toFixed(2)} decks`, 460, 250, { size: 40, weight: "800", mono: true });
    if (button(f, { x: 460, y: 280, w: 70, h: 46 }, "−¼")) this.trayGuess = Math.max(0, this.trayGuess - 0.25);
    if (button(f, { x: 540, y: 280, w: 70, h: 46 }, "+¼")) this.trayGuess = Math.min(6, this.trayGuess + 0.25);
    if (f.input.consume("arrowdown", "arrowleft", "-")) this.trayGuess = Math.max(0, this.trayGuess - 0.25);
    if (f.input.consume("arrowup", "arrowright", "+", "=")) this.trayGuess = Math.min(6, this.trayGuess + 0.25);

    if (this.answerT > 0) {
      this.answerT -= f.dt;
      this.drawVerdict(f, 420);
      text(ctx, `Decks remaining in the shoe: ${(6 - this.trayDecks).toFixed(2)}`, 460, 470, {
        size: 14,
        color: C.dim,
      });
      if (this.answerT <= 0) this.next();
      return;
    }
    if (button(f, { x: 640, y: 280, w: 160, h: 46 }, "Lock in", { accent: C.gold, hotkey: "ENTER" }) ||
      f.input.consume("Enter", " ")) {
      const off = Math.abs(this.trayGuess - this.trayDecks);
      this.mark(off <= 0.25, `Tray held ${this.trayDecks.toFixed(2)} decks — you were ${off.toFixed(2)} off.`);
    }
  }

  private trueCountDrill(f: Frame): void {
    this.header(f, "True count", "Running count over decks remaining, rounded toward zero.");
    this.drawTray(f, 220, 150, this.trayDecks);
    const { ctx } = f;
    const remaining = 6 - this.trayDecks;
    const truth = floorTrueCount(this.rcGiven / Math.max(0.25, remaining));

    text(ctx, "Running count", 460, 200, { size: 14, color: C.faint });
    text(ctx, signed(this.rcGiven), 460, 248, { size: 40, weight: "800", mono: true, color: C.gold });
    text(ctx, "True count", 460, 310, { size: 14, color: C.faint });
    fillRound(ctx, { x: 460, y: 324, w: 170, h: 62 }, 8, "#0a0f14", C.line);
    text(ctx, signed(this.entry), 545, 366, { size: 36, weight: "800", mono: true, align: "center" });
    if (button(f, { x: 646, y: 328, w: 60, h: 54 }, "−")) this.entry--;
    if (button(f, { x: 714, y: 328, w: 60, h: 54 }, "+")) this.entry++;
    if (f.input.consume("arrowdown", "arrowleft", "-")) this.entry--;
    if (f.input.consume("arrowup", "arrowright", "+", "=")) this.entry++;

    if (this.answerT > 0) {
      this.answerT -= f.dt;
      this.drawVerdict(f, 470);
      if (this.answerT <= 0) {
        this.next();
      }
      return;
    }
    if (button(f, { x: 810, y: 328, w: 150, h: 54 }, "Lock in", { accent: C.gold, hotkey: "ENTER" }) ||
      f.input.consume("Enter", " ")) {
      this.mark(
        this.entry === truth,
        `${signed(this.rcGiven)} over ${remaining.toFixed(2)} decks is ${(this.rcGiven / remaining).toFixed(2)} → ${signed(truth)}`,
      );
    }
  }

  private dealStrategyHand(withIndex: boolean): void {
    const rng = this.rng;
    let hand = newHand(10);
    let up: Card;
    let tc = 0;

    if (withIndex) {
      const d = pick(DEVIATIONS, rng);
      tc = d.above ? d.index + randInt(rng, -2, 3) : d.index + randInt(rng, -3, 2);
      up = { rank: valueToRank(d.up, rng), suit: pick(SUITS, rng), id: 1 };
      if (d.pair != null) {
        const r = valueToRank(d.pair, rng);
        hand.cards = [
          { rank: r, suit: "S", id: 2 },
          { rank: r, suit: "H", id: 3 },
        ];
      } else {
        hand.cards = buildTotal(d.total!, rng);
      }
    } else {
      up = { rank: pick(RANKS, rng), suit: pick(SUITS, rng), id: 1 };
      const roll = rng();
      if (roll < 0.2) {
        const r = pick(RANKS, rng);
        hand.cards = [
          { rank: r, suit: "S", id: 2 },
          { rank: r, suit: "D", id: 3 },
        ];
      } else if (roll < 0.42) {
        const other = RANKS[randInt(rng, 1, 8)];
        hand.cards = [
          { rank: "A", suit: "H", id: 2 },
          { rank: other, suit: "C", id: 3 },
        ];
      } else {
        hand.cards = buildTotal(randInt(rng, 5, 19), rng);
      }
    }

    const legal = legalActions(hand, 1, RULES, 100000);
    const res = correctAction(hand, up, RULES, legal, tc, withIndex);
    this.hand = hand;
    this.up = up;
    this.trueCount = tc;
    this.expected = withIndex ? res.action : basicStrategy(hand, up, RULES, legal);
    this.deviationName = res.deviation?.name ?? "";
  }

  private strategyDrill(f: Frame): void {
    const isIndex = this.drill === "index";
    this.header(
      f,
      isIndex ? "Index plays" : "Basic strategy",
      isIndex
        ? "Same hands, but the count is talking. Deviate only when it says so."
        : "Six decks, dealer stands on soft 17, double after split allowed.",
    );
    const { ctx } = f;
    if (!this.hand || !this.up) return;

    text(ctx, "DEALER SHOWS", 302, 170, { size: 11, color: C.faint, weight: "700", align: "center" });
    drawCard(ctx, this.up, 260, 186, 84, 118);

    text(ctx, "YOUR HAND", 800, 170, { size: 11, color: C.faint, weight: "700", align: "center" });
    drawHand(ctx, this.hand.cards, 720, 186, { scale: 1.35, overlap: 60 });

    if (isIndex) {
      fillRound(ctx, { x: 490, y: 196, w: 170, h: 62 }, 10, C.panel, C.purple, 2);
      text(ctx, "TRUE COUNT", 575, 218, { size: 10, color: C.faint, align: "center", weight: "700" });
      text(ctx, signed(this.trueCount), 575, 244, {
        size: 26,
        weight: "800",
        align: "center",
        mono: true,
        color: this.trueCount >= 0 ? C.green : C.red,
      });
    }

    const legal = legalActions(this.hand, 1, RULES, 100000);
    const opts: { a: Action; label: string; key: string; on: boolean; accent: string }[] = [
      { a: "hit", label: "Hit", key: "H", on: true, accent: C.blue },
      { a: "stand", label: "Stand", key: "S", on: true, accent: C.green },
      { a: "double", label: "Double", key: "D", on: legal.double, accent: C.gold },
      { a: "split", label: "Split", key: "P", on: legal.split, accent: C.purple },
      { a: "surrender", label: "Surrender", key: "R", on: legal.surrender, accent: C.red },
    ];
    let picked: Action | null = null;
    opts.forEach((o, i) => {
      const r = { x: 140 + i * 200, y: 400, w: 180, h: 68 };
      if (button(f, r, o.label, { enabled: o.on, accent: o.accent, hotkey: o.key })) picked = o.a;
      if (o.on && f.input.consume(o.key.toLowerCase())) picked = o.a;
    });

    if (this.answerT > 0) {
      this.answerT -= f.dt;
      this.drawVerdict(f, 520);
      if (this.answerT <= 0) this.next();
      return;
    }
    if (picked) {
      const chosen = picked as Action;
      const why = this.deviationName
        ? `${ACTION_LABEL[this.expected]} — index play: ${this.deviationName}`
        : `${ACTION_LABEL[this.expected]} is basic strategy here`;
      this.mark(chosen === this.expected, why);
    }
  }

  private drawVerdict(f: Frame, y: number): void {
    const { ctx } = f;
    if (this.lastCorrect === null) return;
    text(ctx, this.lastCorrect ? "Correct" : "No", VW / 2, y, {
      size: 30,
      weight: "800",
      align: "center",
      color: this.lastCorrect ? C.green : C.red,
    });
    if (this.explain) {
      text(ctx, this.explain, VW / 2, y + 30, { size: 15, color: C.dim, align: "center" });
    }
  }
}

function valueToRank(v: number, rng: Rng): Rank {
  if (v === 11) return "A";
  if (v === 10) return pick(["T", "J", "Q", "K"] as Rank[], rng);
  return String(v) as Rank;
}

/** Two or three cards that add up to `total` without going soft. */
function buildTotal(total: number, rng: Rng): Card[] {
  for (let attempt = 0; attempt < 200; attempt++) {
    const a = RANKS[randInt(rng, 1, 12)];
    const av = cardValue(a);
    const need = total - av;
    if (need < 2 || need > 10) continue;
    const b = need === 10 ? pick(["T", "J", "Q", "K"] as Rank[], rng) : (String(need) as Rank);
    if (cardValue(a) === cardValue(b) && rng() < 0.7) continue;
    return [
      { rank: a, suit: pick(SUITS, rng), id: 2 },
      { rank: b, suit: pick(SUITS, rng), id: 3 },
    ];
  }
  return [
    { rank: "T", suit: "S", id: 2 },
    { rank: String(Math.max(2, Math.min(10, total - 10))) as Rank, suit: "H", id: 3 },
  ];
}

function suitName(s: Card["suit"]): string {
  return s === "S" ? "spades" : s === "H" ? "hearts" : s === "D" ? "diamonds" : "clubs";
}
