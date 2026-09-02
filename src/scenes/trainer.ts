import type { Game, Scene } from "../game";
import { VH, VW } from "../core/renderer";
import { C, button, fillRound, text, vignette, type Frame } from "../core/ui";
import { drawCard, drawHand } from "../render/cards";
import { RANKS, SUITS, cardValue, hiLo, type Card, type Rank } from "../blackjack/cards";
import { mulberry32, pick, randInt, randomSeed, type Rng } from "../core/rng";
import { newHand, type Hand } from "../blackjack/hand";
import { legalActions } from "../blackjack/hand";
import { ACTION_LABEL, DEVIATIONS, basicStrategy, correctAction, type Action } from "../blackjack/strategy";
import { TABLE_PRESETS } from "../blackjack/rules";
import { floorTrueCount } from "../blackjack/counting";
import { signed } from "../core/math";
import { wrapText } from "./menu";

type DrillId = "menu" | "tags" | "speed" | "decks" | "truecount" | "strategy" | "index";

const RULES = TABLE_PRESETS[0];

interface DrillInfo {
  id: DrillId;
  name: string;
  blurb: string;
  accent: string;
}

const DRILLS: DrillInfo[] = [
  { id: "tags", name: "Card tags", blurb: "One card at a time. +1, 0 or −1. Build the reflex.", accent: C.green },
  { id: "speed", name: "Count a deck", blurb: "Cards flash by. Keep the running count and call it at the end.", accent: C.blue },
  { id: "decks", name: "Read the tray", blurb: "Estimate how many decks are in the discard tray.", accent: C.gold },
  { id: "truecount", name: "True count", blurb: "Running count plus a tray. Convert, rounding toward zero.", accent: C.purple },
  { id: "strategy", name: "Basic strategy", blurb: "Every hand, every upcard, until it is automatic.", accent: C.green },
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

  // speed drill
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

  private setDrill(id: DrillId): void {
    this.drill = id;
    this.score = { right: 0, total: 0, streak: 0, best: 0 };
    this.lastCorrect = null;
    this.explain = "";
    this.answerT = 0;
    this.speedState = "setup";
    this.next();
  }

  private menu(f: Frame): void {
    this.header(f, "Training room", "No money, no pit boss. Just repetitions.");
    DRILLS.forEach((d, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const r = { x: 60 + col * 390, y: 150 + row * 200, w: 360, h: 170 };
      const hover = f.mx >= r.x && f.mx <= r.x + r.w && f.my >= r.y && f.my <= r.y + r.h;
      fillRound(f.ctx, r, 12, hover ? C.panelHi : C.panel, hover ? d.accent : C.line, hover ? 2 : 1);
      text(f.ctx, d.name, r.x + 22, r.y + 44, { size: 22, weight: "700", color: d.accent });
      wrapText(f.ctx, d.blurb, r.x + 22, r.y + 76, r.w - 44, 20, { size: 14, color: C.dim });
      text(f.ctx, `${i + 1}`, r.x + r.w - 22, r.y + 40, { size: 14, color: C.faint, align: "right", weight: "700" });
      if ((hover && f.clicked) || f.input.consume(String(i + 1))) this.setDrill(d.id);
    });
  }

  private randomCard(): Card {
    return { rank: pick(RANKS, this.rng), suit: pick(SUITS, this.rng), id: Math.floor(this.rng() * 1e9) };
  }

  private mark(correct: boolean, explain = ""): void {
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
    switch (this.drill) {
      case "tags":
        this.card = this.randomCard();
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
      default:
        break;
    }
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
      case "strategy":
      case "index":
        this.strategyDrill(f);
        break;
      default:
        break;
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

      text(ctx, "A dealer at a full table puts out about one card every 0.6 seconds.", 300, 340, {
        size: 13,
        color: C.faint,
      });

      if (button(f, { x: 300, y: 400, w: 240, h: 60 }, "Start", { accent: C.green, hotkey: "SPACE" }) ||
        f.input.consume(" ", "Enter")) {
        this.speedCards = Array.from({ length: this.speedCount }, () => this.randomCard());
        this.runningTruth = this.speedCards.reduce((a, c) => a + hiLo(c.rank), 0);
        this.speedIndex = 0;
        this.speedTimer = 0;
        this.entry = 0;
        this.speedState = "running";
      }
      return;
    }

    if (this.speedState === "running") {
      this.speedTimer -= f.dt;
      if (this.speedTimer <= 0) {
        this.speedIndex++;
        this.speedTimer = this.speedInterval;
      }
      if (this.speedIndex >= this.speedCards.length) {
        this.speedState = "answer";
        return;
      }
      const c = this.speedCards[this.speedIndex];
      drawCard(ctx, c, VW / 2 - 70, 190, 140, 198);
      text(ctx, `${this.speedIndex + 1} / ${this.speedCards.length}`, VW / 2, 430, {
        size: 15,
        color: C.faint,
        align: "center",
        mono: true,
      });
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
