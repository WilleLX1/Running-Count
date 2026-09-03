import type { Game, Scene } from "../game";
import { VH, VW } from "../core/renderer";
import { C, button, chipStack, fillRound, text, vignette, type Frame } from "../core/ui";
import { drawHand } from "../render/cards";
import { hiLo, type Card } from "../blackjack/cards";
import { TableSim } from "../blackjack/sim";
import { TABLE_PRESETS, type TableRules } from "../blackjack/rules";
import { handTotal, isBlackjack } from "../blackjack/hand";
import { estimateDecksRemaining, floorTrueCount } from "../blackjack/counting";
import { mulberry32, randInt, randomSeed, randRange, type Rng } from "../core/rng";
import { clamp, signed } from "../core/math";
import { wrapText } from "./menu";

type Stage = "setup" | "running" | "spot" | "final" | "review";

/**
 * off     -- nothing to lean on, the number lives in your head
 * on      -- a counter you can add into and read back
 * blind   -- a counter you can add into but cannot read, which is the rung
 *            between the two: the tagging stays trained, the remembering does not
 *            get done for you
 */
type CounterMode = "off" | "on" | "blind";

const COUNTER_MODES: { id: CounterMode; label: string; blurb: string }[] = [
  {
    id: "off",
    label: "Off",
    blurb: "Nothing to lean on. Tag the card and hold the number yourself.",
  },
  {
    id: "on",
    label: "Visible",
    blurb: "Somewhere to put the number, so you are adding rather than remembering.",
  },
  {
    id: "blind",
    label: "Blind",
    blurb:
      "You add into it with + and −, but you cannot read it back. Checks ask what you remember, and score your presses separately.",
  },
];

interface Checkpoint {
  at: number;
  truth: number;
  answer: number;
  correct: boolean;
  kind: "spot" | "final";
  /** Blind mode: what your key presses added up to, regardless of what you recalled. */
  counter?: number;
  counterCorrect?: boolean;
}

const FREQUENCIES = [
  { id: "off", label: "Never", gap: [0, 0] },
  { id: "rare", label: "Rare", gap: [55, 105] },
  { id: "normal", label: "Normal", gap: [28, 58] },
  { id: "often", label: "Often", gap: [14, 32] },
] as const;

const DECK_CHOICES = [1, 2, 4, 6, 8];
const MIN_SPEED = 0.12;

/**
 * A real table dealt by a real dealer, with nothing to do but keep the count.
 * The engine and the felt are the game's own -- the only thing missing is your
 * money, which is the point: this is where the number gets automatic.
 */
export class LiveTableScene implements Scene {
  private stage: Stage = "setup";
  private rng: Rng = mulberry32(randomSeed());

  // --- configuration
  private players = 3;
  private deckIndex = 3;
  private penetration = 0.75;
  private baseSpeed = 0.45;
  private ramp = true;
  private freqIndex = 2;
  private counterMode: CounterMode = "off";
  private hints = false;

  // --- the shoe in progress
  private sim: TableSim | null = null;
  private rules: TableRules | null = null;
  private seen: Card[] = [];
  private trace: number[] = [];
  private checkpoints: Checkpoint[] = [];
  private nextCheckAt = 0;
  /** A check has come due and is waiting for the next betting window. */
  private checkDue = false;
  private roundsDealt = 0;
  private shoeIndex = 0;
  private paused = false;
  /** Wall clock when this shoe was dealt. */
  private shoeStartedAt = 0;

  // --- your own tally, when the manual counter is on
  private yourCount = 0;
  /**
   * Your count as each card came out. You have not seen card i yet at that
   * moment, so it should read the truth after card i-1.
   */
  private yourTrace: number[] = [];
  private counterFlash = 0;

  // --- peeking
  private peeking = false;
  private peekTime = 0;
  private peekCount = 0;
  private peekWasDown = false;

  // --- answering
  private entry = 0;
  private entryDecks = 3;
  private entryTrue = 0;
  private finalStep: "rc" | "decks" | "tc" | "done" = "rc";
  private finalTruth = { rc: 0, decks: 0, tc: 0 };
  private finalGot = { rc: false, decks: false, tc: false };
  private lastSpot: Checkpoint | null = null;
  private spotFeedback = 0;

  constructor(
    private game: Game,
    private onExit: () => void,
  ) {}

  private get frequency() {
    return FREQUENCIES[this.freqIndex];
  }

  /** Are + and − live at all? */
  private get manual(): boolean {
    return this.counterMode !== "off";
  }

  /** Can you add into the counter but not read it? */
  private get blind(): boolean {
    return this.counterMode === "blind";
  }

  frame(f: Frame): void {
    const { ctx } = f;
    ctx.fillStyle = "#0a0e13";
    ctx.fillRect(0, 0, VW, VH);

    switch (this.stage) {
      case "setup":
        this.drawSetup(f);
        break;
      case "running":
      case "spot":
      case "final":
        this.drawTable(f);
        if (this.stage === "running") this.updateRunning(f);
        if (this.stage === "spot") this.drawSpotCheck(f);
        if (this.stage === "final") this.drawFinalCheck(f);
        break;
      case "review":
        this.drawReview(f);
        break;
    }

    vignette(ctx, VW, VH, 0.4);
  }

  // ------------------------------------------------------------------ setup

  private drawSetup(f: Frame): void {
    const { ctx } = f;
    text(ctx, "Live table", 60, 66, { size: 30, weight: "700" });
    text(
      ctx,
      "A dealer, a shoe and a table full of people. You do not bet and you do not play -- you only count.",
      60,
      92,
      { size: 14, color: C.dim },
    );

    const row = (i: number) => 136 + i * 68;

    // Players
    text(ctx, "PLAYERS AT THE TABLE", 60, row(0), { size: 10, color: C.faint, weight: "700" });
    for (let n = 1; n <= 6; n++) {
      const r = { x: 60 + (n - 1) * 74, y: row(0) + 12, w: 64, h: 46 };
      if (button(f, r, String(n), { active: this.players === n, accent: C.green, small: true })) {
        this.players = n;
      }
    }
    text(ctx, `${this.players * 2 + 2} cards a round before anyone hits`, 520, row(0) + 42, {
      size: 12,
      color: C.faint,
    });

    // Decks
    text(ctx, "DECKS IN THE SHOE", 60, row(1), { size: 10, color: C.faint, weight: "700" });
    DECK_CHOICES.forEach((d, i) => {
      const r = { x: 60 + i * 74, y: row(1) + 12, w: 64, h: 46 };
      if (button(f, r, String(d), { active: this.deckIndex === i, accent: C.blue, small: true })) {
        this.deckIndex = i;
      }
    });
    text(ctx, "Fewer decks means the true count swings harder", 520, row(1) + 42, {
      size: 12,
      color: C.faint,
    });

    // Penetration
    text(ctx, "PENETRATION", 60, row(2), { size: 10, color: C.faint, weight: "700" });
    fillRound(ctx, { x: 60, y: row(2) + 12, w: 120, h: 46 }, 8, "#0a0f14", C.line);
    text(ctx, `${Math.round(this.penetration * 100)}%`, 120, row(2) + 38, {
      size: 22,
      align: "center",
      weight: "800",
      mono: true,
    });
    if (button(f, { x: 190, y: row(2) + 12, w: 56, h: 46 }, "−", { small: true }))
      this.penetration = clamp(this.penetration - 0.05, 0.4, 0.9);
    if (button(f, { x: 254, y: row(2) + 12, w: 56, h: 46 }, "+", { small: true }))
      this.penetration = clamp(this.penetration + 0.05, 0.4, 0.9);
    text(ctx, "How deep the dealer goes before shuffling", 520, row(2) + 42, {
      size: 12,
      color: C.faint,
    });

    // Speed
    text(ctx, "DEALER SPEED", 60, row(3), { size: 10, color: C.faint, weight: "700" });
    fillRound(ctx, { x: 60, y: row(3) + 12, w: 120, h: 46 }, 8, "#0a0f14", C.line);
    text(ctx, this.baseSpeed.toFixed(2) + "s", 120, row(3) + 38, {
      size: 22,
      align: "center",
      weight: "800",
      mono: true,
    });
    if (button(f, { x: 190, y: row(3) + 12, w: 56, h: 46 }, "−", { small: true }))
      this.baseSpeed = clamp(+(this.baseSpeed - 0.05).toFixed(2), MIN_SPEED, 1.2);
    if (button(f, { x: 254, y: row(3) + 12, w: 56, h: 46 }, "+", { small: true }))
      this.baseSpeed = clamp(+(this.baseSpeed + 0.05).toFixed(2), MIN_SPEED, 1.2);
    if (
      button(f, { x: 330, y: row(3) + 12, w: 190, h: 46 }, `Speed ramp: ${this.ramp ? "ON" : "OFF"}`, {
        small: true,
        accent: C.heat,
        active: this.ramp,
      })
    ) {
      this.ramp = !this.ramp;
    }
    text(ctx, "The ramp winds the dealer up as the shoe goes on", 540, row(3) + 42, {
      size: 12,
      color: C.faint,
    });

    // Spot checks
    text(ctx, "SPOT CHECKS", 60, row(4), { size: 10, color: C.faint, weight: "700" });
    FREQUENCIES.forEach((q, i) => {
      const r = { x: 60 + i * 110, y: row(4) + 12, w: 100, h: 46 };
      if (button(f, r, q.label, { active: this.freqIndex === i, accent: C.gold, small: true })) {
        this.freqIndex = i;
      }
    });
    text(ctx, "The dealer stops and asks. There is always one at the shuffle.", 540, row(4) + 42, {
      size: 12,
      color: C.faint,
    });

    // Manual counter
    text(ctx, "MANUAL COUNTER", 60, row(5), { size: 10, color: C.faint, weight: "700" });
    COUNTER_MODES.forEach((m, i) => {
      const r = { x: 60 + i * 130, y: row(5) + 12, w: 120, h: 46 };
      if (
        button(f, r, m.label, {
          active: this.counterMode === m.id,
          accent: C.purple,
          small: true,
        })
      ) {
        this.counterMode = m.id;
      }
    });
    wrapText(
      ctx,
      COUNTER_MODES.find((m) => m.id === this.counterMode)!.blurb,
      480,
      row(5) + 30,
      VW - 540,
      17,
      { size: 12, color: C.faint },
    );

    // Cancellation hints
    text(ctx, "CANCELLATION HINTS", 60, row(6), { size: 10, color: C.faint, weight: "700" });
    if (
      button(f, { x: 60, y: row(6) + 10, w: 210, h: 42 }, this.hints ? "ON" : "OFF", {
        active: this.hints,
        accent: C.green,
        small: true,
      })
    ) {
      this.hints = !this.hints;
    }
    text(
      ctx,
      "Shows the last few cards and links the ones that cancel, so your eye learns to spot a pair worth nothing.",
      480,
      row(6) + 36,
      { size: 12, color: C.faint },
    );

    if (
      button(f, { x: 60, y: VH - 104, w: 300, h: 60 }, "Deal the shoe", {
        accent: C.green,
        hotkey: "SPACE",
      }) ||
      f.input.consume(" ", "Enter")
    ) {
      this.startShoe(true);
    }
    if (button(f, { x: VW - 180, y: VH - 62, w: 140, h: 44 }, "Back", { hotkey: "ESC" }) ||
      f.input.consume("Escape")) {
      this.onExit();
    }
  }

  // ---------------------------------------------------------------- the run

  private startShoe(fresh: boolean): void {
    if (fresh) {
      this.shoeIndex = 0;
      this.peekCount = 0;
      this.peekTime = 0;
    }
    const decks = DECK_CHOICES[this.deckIndex];
    const base = TABLE_PRESETS[0];
    this.rules = {
      ...base,
      id: "livetable",
      name: "Training table",
      decks,
      penetration: this.penetration,
      dealSpeed: this.baseSpeed,
      seats: Math.max(this.players, 1),
    };
    const sim = new TableSim(this.rules, this.rng, {
      onCardRevealed: (c) => this.sawCard(c),
    });
    // Exactly the table we asked for: every seat an NPC, none of them broke.
    sim.seats.forEach((s, i) => {
      s.kind = "npc";
      s.name = `Seat ${i + 1}`;
      s.playerId = null;
      s.chips = 1e7;
      s.npc = {
        skill: randRange(this.rng, 0.75, 0.99),
        aggression: randRange(this.rng, 1, 2.4),
        superstition: this.rng() * 0.4,
      };
    });
    this.sim = sim;
    this.seen = [];
    this.trace = [];
    this.yourTrace = [];
    this.yourCount = 0;
    this.counterFlash = 0;
    this.checkpoints = [];
    this.checkDue = false;
    this.roundsDealt = 0;
    this.paused = false;
    this.shoeStartedAt = Date.now();
    this.lastSpot = null;
    this.spotFeedback = 0;
    this.scheduleCheck();
    this.stage = "running";
  }

  private scheduleCheck(): void {
    const [lo, hi] = this.frequency.gap;
    if (lo === 0) {
      this.nextCheckAt = Number.POSITIVE_INFINITY;
      return;
    }
    this.nextCheckAt = this.seen.length + randInt(this.rng, lo, hi);
  }

  private sawCard(c: Card): void {
    this.seen.push(c);
    this.trace.push(this.sim ? this.sim.count.running : 0);
    this.yourTrace.push(this.yourCount);
  }

  /** What your counter should have read when card i landed. */
  private expectedAt(i: number): number {
    return i >= 1 ? this.trace[i - 1] : 0;
  }

  /**
   * True if your counter was right when card i landed, allowing one card of
   * reaction time -- you are pressing a key, not reading a number off a screen.
   */
  private inStepAt(i: number): boolean {
    const yours = this.yourTrace[i];
    if (yours === this.expectedAt(i)) return true;
    return i >= 2 && yours === this.trace[i - 2];
  }

  /** The card where your count left the shoe behind and did not come back. */
  private firstDrift(): number | null {
    if (!this.manual || this.yourTrace.length < 4) return null;
    let run = 0;
    for (let i = 1; i < this.yourTrace.length; i++) {
      if (this.inStepAt(i)) {
        run = 0;
      } else {
        run++;
        if (run >= 3) return i - run + 1;
      }
    }
    return null;
  }

  private inStepFraction(): number {
    if (this.yourTrace.length < 2) return 1;
    let ok = 0;
    for (let i = 1; i < this.yourTrace.length; i++) if (this.inStepAt(i)) ok++;
    return ok / (this.yourTrace.length - 1);
  }

  private currentSpeed(): number {
    if (!this.ramp) return this.baseSpeed;
    const withinShoe = Math.pow(0.985, this.roundsDealt);
    const acrossShoes = Math.pow(0.88, this.shoeIndex);
    return clamp(this.baseSpeed * withinShoe * acrossShoes, MIN_SPEED, 2);
  }

  private updateRunning(f: Frame): void {
    const sim = this.sim;
    if (!sim || !this.rules) return;

    if (f.input.consume("Escape")) {
      this.onExit();
      return;
    }
    if (f.input.consume(" ")) this.paused = !this.paused;

    // Peeking is held, not toggled, and every second of it is on the record.
    const held = f.input.isDown("c");
    this.peeking = held;
    if (held && !this.peekWasDown) this.peekCount++;
    if (held) this.peekTime += f.dt;
    this.peekWasDown = held;

    // Your own tally. Works while paused too, so you can catch up on a freeze.
    if (this.manual) {
      if (f.input.consume("+", "=", "arrowup", "arrowright")) {
        this.yourCount++;
        this.counterFlash = 0.35;
      }
      if (f.input.consume("-", "arrowdown", "arrowleft")) {
        this.yourCount--;
        this.counterFlash = 0.35;
      }
      if (this.counterFlash > 0) this.counterFlash -= f.dt;
    }

    if (this.paused) return;

    this.rules.dealSpeed = this.currentSpeed();
    const before = sim.round;
    sim.update(f.dt);
    if (sim.round !== before) this.roundsDealt++;

    if (this.spotFeedback > 0) this.spotFeedback -= f.dt;

    // The shuffle is the end of the shoe: ask before the count is washed away.
    // Any spot check still queued is moot now.
    if (sim.phase === "shuffle") {
      this.checkDue = false;
      this.finalTruth = {
        rc: sim.count.running,
        decks: sim.shoe.decksRemaining,
        tc: floorTrueCount(sim.count.running / Math.max(0.25, sim.shoe.decksRemaining)),
      };
      this.entry = this.manual && !this.blind ? this.yourCount : 0;
      this.entryDecks = estimateDecksRemaining(sim.shoe.decksRemaining);
      this.entryTrue = 0;
      this.finalStep = "rc";
      this.finalGot = { rc: false, decks: false, tc: false };
      this.stage = "final";
      return;
    }

    if (this.seen.length >= this.nextCheckAt) this.checkDue = true;

    // The question waits for the betting window between rounds. That is the
    // moment the number is actually for something, and stopping the dealer
    // halfway through pitching a round is not a thing that happens.
    if (this.checkDue && sim.phase === "betting") {
      this.checkDue = false;
      this.entry = this.manual && !this.blind ? this.yourCount : 0;
      this.stage = "spot";
    }
  }

  // -------------------------------------------------------------- the felt

  private seatPos(i: number, n: number): { x: number; y: number } {
    if (n === 1) return { x: VW / 2 - 40, y: 470 };
    const spread = Math.min(860, 190 * (n - 1));
    const centre = VW / 2 - 40;
    const x = centre - spread / 2 + (spread * i) / (n - 1);
    const c = (n - 1) / 2;
    const y = 470 - 52 * (Math.abs(i - c) / Math.max(0.001, c));
    return { x, y };
  }

  private drawTable(f: Frame): void {
    const { ctx } = f;
    const sim = this.sim;
    if (!sim) return;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(VW / 2, 250, 620, 350, 0, 0, Math.PI * 2);
    const felt = ctx.createRadialGradient(VW / 2, 200, 60, VW / 2, 300, 620);
    felt.addColorStop(0, "#13704a");
    felt.addColorStop(1, C.feltDark);
    ctx.fillStyle = felt;
    ctx.fill();
    ctx.strokeStyle = "#7a5a2e";
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.restore();

    // Dealer.
    const dealerCards = sim.dealer.holeHidden ? sim.dealer.cards : sim.dealer.cards;
    const hideIndex = sim.dealer.holeHidden ? 1 : -1;
    const w = dealerCards.length ? (dealerCards.length - 1) * 30 + 62 : 0;
    drawHand(ctx, dealerCards, VW / 2 - w / 2, 88, { overlap: 30, hideIndex });
    if (dealerCards.length) {
      const shown = sim.dealer.holeHidden ? [dealerCards[0]] : dealerCards;
      const t = handTotal(shown).total;
      const label = sim.dealer.holeHidden ? `showing ${t}` : t > 21 ? `${t} bust` : String(t);
      fillRound(
        ctx,
        { x: VW / 2 - 50, y: 186, w: 100, h: 24 },
        6,
        t > 21 && !sim.dealer.holeHidden ? "rgba(120,30,26,0.8)" : "rgba(6,12,9,0.65)",
      );
      text(ctx, label, VW / 2, 198, {
        size: 14,
        color: "#dfe6ee",
        align: "center",
        baseline: "middle",
        weight: "600",
      });
    } else {
      text(ctx, "DEALER", VW / 2, 130, {
        size: 14,
        color: "rgba(255,255,255,0.3)",
        align: "center",
        weight: "700",
      });
    }

    // Seats.
    const n = sim.seats.length;
    sim.seats.forEach((seat, i) => {
      const { x, y } = this.seatPos(i, n);
      ctx.beginPath();
      ctx.arc(x, y, 24, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 2;
      ctx.stroke();
      if (seat.bet > 0) chipStack(ctx, x, y + 6, seat.bet, this.rules!.minBet);

      seat.hands.forEach((hand, hi) => {
        const scale = seat.hands.length > 1 ? 0.58 : 0.72;
        const overlap = 22 * (scale / 0.78);
        const hw = (hand.cards.length - 1) * overlap + 62 * scale;
        const offset = (hi - (seat.hands.length - 1) / 2) * (seat.hands.length > 1 ? 70 : 0);
        const active =
          sim.phase === "playing" &&
          sim.currentActor()?.seat === seat.index &&
          sim.currentActor()?.hand === hi;
        drawHand(ctx, hand.cards, x + offset - hw / 2, y - 104, {
          scale,
          overlap,
          highlight: active ? C.gold : undefined,
          dim: hand.result === "lose" || hand.result === "bust" || hand.surrendered,
        });
        if (hand.cards.length) {
          const t = handTotal(hand.cards);
          const badge = hand.surrendered
            ? "surr"
            : isBlackjack(hand)
              ? "BJ"
              : t.total > 21
                ? "bust"
                : t.soft
                  ? `s${t.total}`
                  : `${t.total}`;
          fillRound(
            ctx,
            { x: x + offset - 19, y: y - 104 + 96 * scale + 4, w: 38, h: 19 },
            5,
            t.total > 21 ? "rgba(120,30,26,0.8)" : "rgba(6,12,9,0.72)",
          );
          text(ctx, badge, x + offset, y - 104 + 96 * scale + 13.5, {
            size: 11,
            color: "#dfe6ee",
            align: "center",
            baseline: "middle",
            weight: "700",
          });
        }
      });
      text(ctx, seat.name, x, y + 42, {
        size: 11,
        color: "rgba(223,230,238,0.55)",
        align: "center",
        weight: "600",
      });
    });

    this.drawShoe(f);
    this.drawHud(f);
  }

  private drawShoe(f: Frame): void {
    const { ctx } = f;
    const sim = this.sim!;
    fillRound(ctx, { x: VW - 190, y: 108, w: 74, h: 54 }, 6, "#2a1f18", "#4b382a", 2);
    ctx.fillStyle = "#e8e2d6";
    const innerW = 62 * Math.max(0.04, 1 - sim.shoe.fractionDealt);
    ctx.fillRect(VW - 184, 116, innerW, 38);
    text(ctx, "SHOE", VW - 153, 176, {
      size: 10,
      color: "rgba(255,255,255,0.45)",
      align: "center",
      weight: "700",
    });

    const trayH = 110;
    const trayY = 214;
    fillRound(ctx, { x: VW - 178, y: trayY, w: 52, h: trayH }, 5, "rgba(10,20,16,0.7)", "#3d5a4c", 2);
    const filled = trayH * Math.min(1, sim.shoe.fractionDealt) - 6;
    if (filled > 0) {
      ctx.fillStyle = "#d9d2c4";
      ctx.fillRect(VW - 174, trayY + trayH - 3 - filled, 44, filled);
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      for (let y = trayY + trayH - 3 - filled; y < trayY + trayH - 3; y += 3) {
        ctx.beginPath();
        ctx.moveTo(VW - 174, y);
        ctx.lineTo(VW - 130, y);
        ctx.stroke();
      }
    }
    text(ctx, "DISCARDS", VW - 152, trayY + trayH + 16, {
      size: 10,
      color: "rgba(255,255,255,0.45)",
      align: "center",
      weight: "700",
    });
    if (sim.shoe.cutCardOut) {
      text(ctx, "CUT CARD", VW - 152, 196, {
        size: 10,
        color: C.red,
        align: "center",
        weight: "800",
      });
    }
  }

  /**
   * The last few cards in the order they came, with the pairs that cancel
   * bracketed together. Training wheels for reading the shoe in chunks instead
   * of one card at a time.
   */
  private drawCancelFeed(f: Frame): void {
    const { ctx } = f;
    const cards = this.seen.slice(-9);
    if (cards.length === 0) return;
    const cw = 32;
    const gap = 6;
    const w = cards.length * (cw + gap) - gap;
    const x0 = VW / 2 - w / 2;
    const y = VH - 96;

    // Pair off neighbours that come to nothing, left to right.
    const tags = cards.map((c) => hiLo(c.rank));
    const pairedWith = new Array<number>(cards.length).fill(-1);
    for (let i = 0; i + 1 < cards.length; i++) {
      if (pairedWith[i] !== -1) continue;
      if (tags[i] !== 0 && tags[i] + tags[i + 1] === 0) {
        pairedWith[i] = i + 1;
        pairedWith[i + 1] = i;
        i++;
      }
    }

    fillRound(ctx, { x: x0 - 14, y: y - 20, w: w + 28, h: 96 }, 10, "rgba(10,15,20,0.72)", C.line);
    text(ctx, "LAST CARDS OUT", VW / 2, y - 6, {
      size: 9,
      color: C.faint,
      align: "center",
      weight: "700",
    });

    let live = 0;
    cards.forEach((c, i) => {
      const cx = x0 + i * (cw + gap);
      const cancelled = pairedWith[i] !== -1;
      drawHand(ctx, [c], cx, y + 4, { scale: cw / 62, overlap: cw, dim: cancelled });
      const t = tags[i];
      if (!cancelled) live += t;
      text(ctx, t > 0 ? "+1" : t < 0 ? "−1" : "0", cx + cw / 2, y + 60, {
        size: 10,
        align: "center",
        weight: "700",
        color: cancelled ? C.faint : t > 0 ? C.green : t < 0 ? C.red : C.faint,
      });
      // A bracket under each cancelling pair.
      if (pairedWith[i] === i + 1) {
        const x1 = cx + cw / 2;
        const x2 = cx + cw + gap + cw / 2;
        ctx.strokeStyle = C.green;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1, y + 66);
        ctx.lineTo(x1, y + 70);
        ctx.lineTo(x2, y + 70);
        ctx.lineTo(x2, y + 66);
        ctx.stroke();
        text(ctx, "0", (x1 + x2) / 2, y + 68, {
          size: 9,
          align: "center",
          baseline: "middle",
          weight: "700",
          color: C.green,
        });
      }
    });
    text(ctx, `these nine move it ${signed(live)}`, VW / 2, y + 86, {
      size: 11,
      color: C.dim,
      align: "center",
    });
  }

  private peekLabel(): string {
    const n = this.peekCount;
    return `${n} peek${n === 1 ? "" : "s"} · ${this.peekTime.toFixed(1)}s`;
  }

  private drawHud(f: Frame): void {
    const { ctx } = f;
    const sim = this.sim!;
    const hits = this.checkpoints.filter((c) => c.correct).length;

    fillRound(ctx, { x: 12, y: 10, w: 330, h: 54 }, 9, "rgba(10,15,20,0.82)", C.line);
    text(ctx, "TRAINING TABLE", 28, 28, { size: 9, color: C.faint, weight: "700" });
    const decks = this.rules!.decks;
    text(
      ctx,
      `${decks} deck${decks === 1 ? "" : "s"} · ${this.players} player${this.players === 1 ? "" : "s"} · ${this.currentSpeed().toFixed(2)}s a card`,
      28,
      50,
      { size: 13, color: C.dim },
    );

    fillRound(ctx, { x: 354, y: 10, w: 250, h: 54 }, 9, "rgba(10,15,20,0.82)", C.line);
    text(ctx, "CARDS SEEN", 370, 28, { size: 9, color: C.faint, weight: "700" });
    text(ctx, `${this.seen.length}`, 370, 52, { size: 22, weight: "800", mono: true });
    text(ctx, `${Math.round(sim.shoe.fractionDealt * 100)}% dealt`, 470, 52, {
      size: 13,
      color: C.dim,
    });

    if (this.checkpoints.length > 0) {
      fillRound(ctx, { x: VW - 262, y: 10, w: 250, h: 54 }, 9, "rgba(10,15,20,0.82)", C.line);
      text(ctx, "CHECKS", VW - 246, 28, { size: 9, color: C.faint, weight: "700" });
      text(ctx, `${hits}/${this.checkpoints.length}`, VW - 246, 52, {
        size: 22,
        weight: "800",
        mono: true,
        color: hits === this.checkpoints.length ? C.green : C.gold,
      });
    }

    // Your own tally, if you asked for somewhere to put it.
    if (this.manual) {
      const mr = { x: 12, y: VH - 122, w: 250, h: 54 };
      const hot = this.counterFlash > 0;
      fillRound(
        ctx,
        mr,
        9,
        hot ? "rgba(169,139,214,0.18)" : "rgba(10,15,20,0.82)",
        hot ? C.purple : C.line,
        hot ? 2 : 1,
      );
      const hidden = this.blind && !this.peeking;
      text(ctx, hidden ? "YOUR COUNT · BLIND" : "YOUR COUNT", mr.x + 16, mr.y + 20, {
        size: 9,
        color: C.faint,
        weight: "700",
      });
      if (hidden) {
        // The presses still land; you just do not get to read the total back.
        text(ctx, "▪ ▪", mr.x + 16, mr.y + 44, { size: 24, weight: "800", color: C.purple });
        text(ctx, "keep it in your head", mr.x + 84, mr.y + 44, { size: 12, color: C.faint });
      } else {
        text(ctx, signed(this.yourCount), mr.x + 16, mr.y + 46, {
          size: 26,
          weight: "800",
          mono: true,
          color: this.yourCount > 0 ? C.green : this.yourCount < 0 ? C.red : C.text,
        });
        text(ctx, "+ / −  to adjust", mr.x + 120, mr.y + 44, { size: 12, color: C.faint });
      }
    }

    // The peek, and what it costs you.
    const peekR = { x: 12, y: VH - 62, w: 250, h: 48 };
    fillRound(
      ctx,
      peekR,
      9,
      this.peeking ? "rgba(240,193,75,0.16)" : "rgba(10,15,20,0.82)",
      this.peeking ? C.gold : C.line,
    );
    if (this.peeking) {
      text(ctx, "RUNNING COUNT", peekR.x + 16, peekR.y + 18, {
        size: 9,
        color: C.faint,
        weight: "700",
      });
      text(ctx, signed(sim.count.running), peekR.x + 16, peekR.y + 40, {
        size: 20,
        weight: "800",
        mono: true,
        color: C.gold,
      });
      text(ctx, this.peekLabel(), peekR.x + 120, peekR.y + 40, {
        size: 12,
        color: C.faint,
      });
    } else {
      text(ctx, "Hold C to peek at the count", peekR.x + 16, peekR.y + 22, {
        size: 13,
        color: C.dim,
      });
      text(ctx, this.peekLabel() + " so far", peekR.x + 16, peekR.y + 39, {
        size: 11,
        color: C.faint,
      });
    }

    if (this.hints) this.drawCancelFeed(f);

    text(ctx, "SPACE pause · ESC leave", VW - 20, VH - 22, {
      size: 12,
      color: C.faint,
      align: "right",
    });

    if (this.paused && this.stage === "running") {
      ctx.fillStyle = "rgba(4,7,10,0.55)";
      ctx.fillRect(0, 0, VW, VH);
      text(ctx, "PAUSED", VW / 2, VH / 2, {
        size: 44,
        weight: "800",
        align: "center",
        baseline: "middle",
        color: C.text,
      });
      text(ctx, "SPACE to carry on", VW / 2, VH / 2 + 40, {
        size: 15,
        align: "center",
        color: C.dim,
      });
    }

    if (this.spotFeedback > 0 && this.lastSpot) {
      const good = this.lastSpot.correct;
      ctx.globalAlpha = Math.min(1, this.spotFeedback);
      const miss = Math.abs(this.lastSpot.answer - this.lastSpot.truth);
      let line: string;
      if (this.blind && this.lastSpot.counter !== undefined) {
        // Name which half went wrong -- that is the whole point of blind mode.
        if (good) {
          line = "Right on the number.";
        } else if (this.lastSpot.counterCorrect) {
          line = `It was ${signed(this.lastSpot.truth)}. Your presses were right — the number slipped in your head.`;
        } else {
          line = `It was ${signed(this.lastSpot.truth)}, and your presses said ${signed(this.lastSpot.counter)}. A card got tagged wrong.`;
        }
      } else {
        line = good
          ? "Right on the number."
          : `Off by ${miss} — it was ${signed(this.lastSpot.truth)}${this.manual ? ". Your counter has been put right." : "."}`;
      }
      text(ctx, line, VW / 2, VH - 92, {
        size: 16,
        align: "center",
        weight: "700",
        color: good ? C.green : C.red,
        maxWidth: VW - 80,
      });
      ctx.globalAlpha = 1;
    }
  }

  // ------------------------------------------------------------ the checks

  private numberField(
    f: Frame,
    cx: number,
    y: number,
    value: string,
    onDown: () => void,
    onUp: () => void,
  ): void {
    fillRound(f.ctx, { x: cx - 90, y, w: 180, h: 62 }, 10, "#0a0f14", C.line);
    text(f.ctx, value, cx, y + 34, {
      size: 34,
      align: "center",
      weight: "800",
      mono: true,
    });
    if (button(f, { x: cx - 170, y: y + 8, w: 60, h: 44 }, "−", { accent: C.red })) onDown();
    if (button(f, { x: cx + 110, y: y + 8, w: 60, h: 44 }, "+", { accent: C.green })) onUp();
    if (f.input.consume("arrowdown", "arrowleft", "-")) onDown();
    if (f.input.consume("arrowup", "arrowright", "+", "=")) onUp();
  }

  private drawSpotCheck(f: Frame): void {
    const { ctx } = f;
    const sim = this.sim!;
    ctx.fillStyle = "rgba(4,7,10,0.82)";
    ctx.fillRect(0, 0, VW, VH);
    const r = { x: VW / 2 - 260, y: 214, w: 520, h: 258 };
    fillRound(ctx, r, 14, C.panel, C.gold, 2);
    text(ctx, `BETS ARE GOING OUT · ${this.seen.length} CARDS SEEN`, VW / 2, r.y + 36, {
      size: 12,
      color: C.faint,
      align: "center",
      weight: "800",
    });
    text(ctx, "Running count?", VW / 2, r.y + 70, { size: 22, align: "center", weight: "700" });
    text(ctx, "The hand is settled. This is where the number earns its keep.", VW / 2, r.y + 92, {
      size: 12,
      color: C.faint,
      align: "center",
    });
    this.numberField(
      f,
      VW / 2,
      r.y + 108,
      signed(this.entry),
      () => this.entry--,
      () => this.entry++,
    );
    if (
      button(f, { x: VW / 2 - 90, y: r.y + 194, w: 180, h: 44 }, "Call it", {
        accent: C.gold,
        hotkey: "ENTER",
      }) ||
      f.input.consume("Enter")
    ) {
      const truth = sim.count.running;
      const cp: Checkpoint = {
        at: this.seen.length,
        truth,
        answer: this.entry,
        correct: this.entry === truth,
        kind: "spot",
      };
      if (this.blind) {
        // Two separate skills, scored separately: did your fingers get the tags
        // right, and did your head hold on to the total?
        cp.counter = this.yourCount;
        cp.counterCorrect = this.yourCount === truth;
      }
      this.checkpoints.push(cp);
      this.lastSpot = cp;
      this.spotFeedback = 2.4;
      // Put your counter back on the true number, so the next stretch of shoe
      // is measured on its own rather than inheriting this mistake.
      if (this.manual) this.yourCount = truth;
      this.scheduleCheck();
      this.stage = "running";
    }
  }

  private drawFinalCheck(f: Frame): void {
    const { ctx } = f;
    ctx.fillStyle = "rgba(4,7,10,0.85)";
    ctx.fillRect(0, 0, VW, VH);
    const r = { x: VW / 2 - 280, y: 190, w: 560, h: 320 };
    fillRound(ctx, r, 14, C.panel, C.gold, 2);
    text(ctx, "CUT CARD · END OF THE SHOE", VW / 2, r.y + 36, {
      size: 12,
      color: C.faint,
      align: "center",
      weight: "800",
    });

    const steps: ("rc" | "decks" | "tc")[] = ["rc", "decks", "tc"];
    const at = this.finalStep === "done" ? steps.length : steps.indexOf(this.finalStep);
    steps.forEach((s, i) => {
      const done = at > i;
      const active = this.finalStep === s;
      fillRound(
        ctx,
        { x: VW / 2 - 90 + i * 60, y: r.y + 50, w: 48, h: 6 },
        3,
        active ? C.gold : done ? C.green : "#22303c",
      );
    });

    if (this.finalStep === "rc") {
      text(ctx, "Running count?", VW / 2, r.y + 96, { size: 22, align: "center", weight: "700" });
      this.numberField(f, VW / 2, r.y + 118, signed(this.entry), () => this.entry--, () => this.entry++);
      if (this.advance(f, r.y + 210, "Next")) {
        this.finalGot.rc = this.entry === this.finalTruth.rc;
        const cp: Checkpoint = {
          at: this.seen.length,
          truth: this.finalTruth.rc,
          answer: this.entry,
          correct: this.finalGot.rc,
          kind: "final",
        };
        if (this.blind) {
          cp.counter = this.yourCount;
          cp.counterCorrect = this.yourCount === this.finalTruth.rc;
        }
        this.checkpoints.push(cp);
        this.finalStep = "decks";
      }
    } else if (this.finalStep === "decks") {
      text(ctx, "Decks still to be dealt?", VW / 2, r.y + 96, {
        size: 22,
        align: "center",
        weight: "700",
      });
      text(ctx, "Read the discard tray, do not do arithmetic", VW / 2, r.y + 118, {
        size: 12,
        align: "center",
        color: C.faint,
      });
      this.numberField(
        f,
        VW / 2,
        r.y + 130,
        this.entryDecks.toFixed(2),
        () => (this.entryDecks = Math.max(0, +(this.entryDecks - 0.25).toFixed(2))),
        () => (this.entryDecks = Math.min(12, +(this.entryDecks + 0.25).toFixed(2))),
      );
      if (this.advance(f, r.y + 220, "Next")) {
        this.finalGot.decks = Math.abs(this.entryDecks - this.finalTruth.decks) <= 0.3;
        this.entryTrue = 0;
        this.finalStep = "tc";
      }
    } else if (this.finalStep === "tc") {
      text(ctx, "True count?", VW / 2, r.y + 96, { size: 22, align: "center", weight: "700" });
      text(
        ctx,
        `You called ${signed(this.entry)} running over ${this.entryDecks.toFixed(2)} decks`,
        VW / 2,
        r.y + 118,
        { size: 12, align: "center", color: C.faint },
      );
      this.numberField(
        f,
        VW / 2,
        r.y + 130,
        signed(this.entryTrue),
        () => this.entryTrue--,
        () => this.entryTrue++,
      );
      if (this.advance(f, r.y + 220, "Lock it in")) {
        this.finalGot.tc = this.entryTrue === this.finalTruth.tc;
        this.finalStep = "done";
        this.recordShoe();
        this.stage = "review";
      }
    }
  }

  private advance(f: Frame, y: number, label: string): boolean {
    return (
      button(f, { x: VW / 2 - 90, y, w: 180, h: 44 }, label, { accent: C.gold, hotkey: "ENTER" }) ||
      f.input.consume("Enter")
    );
  }

  private recordShoe(): void {
    const rated = this.checkpoints.filter((c) => c.counter !== undefined);
    const errors = this.checkpoints.map((c) => Math.abs(c.answer - c.truth));
    this.game.history.add({
      kind: "shoe",
      at: Date.now(),
      startedAt: this.shoeStartedAt || Date.now(),
      decks: this.rules?.decks ?? 0,
      players: this.players,
      speed: Math.round(this.currentSpeed() * 100) / 100,
      counter: this.counterMode,
      hints: this.hints,
      cardsSeen: this.seen.length,
      checks: this.checkpoints.length,
      checksCorrect: this.checkpoints.filter((c) => c.correct).length,
      tagChecks: rated.length,
      tagChecksCorrect: rated.filter((c) => c.counterCorrect).length,
      inStep: this.manual ? Math.round(this.inStepFraction() * 1000) / 1000 : -1,
      peeks: this.peekCount,
      peekSeconds: Math.round(this.peekTime * 10) / 10,
      avgMiss: errors.length
        ? Math.round((errors.reduce((a, b) => a + b, 0) / errors.length) * 100) / 100
        : 0,
      finalRc: this.finalGot.rc,
      finalDecks: this.finalGot.decks,
      finalTc: this.finalGot.tc,
    });
  }

  // ------------------------------------------------------------ the review

  private drawReview(f: Frame): void {
    const { ctx } = f;
    text(ctx, "How that shoe went", 60, 62, { size: 28, weight: "700" });

    const hits = this.checkpoints.filter((c) => c.correct).length;
    const errors = this.checkpoints.map((c) => Math.abs(c.answer - c.truth));
    const avgErr = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;

    const rated = this.checkpoints.filter((c) => c.counter !== undefined);
    const tagHits = rated.filter((c) => c.counterCorrect).length;
    const cards = [
      {
        label: this.blind ? "Remembered" : "Checks",
        value: `${hits}/${this.checkpoints.length}`,
        color: hits === this.checkpoints.length ? C.green : C.gold,
      },
      this.blind && rated.length > 0
        ? {
            label: "Tags right",
            value: `${tagHits}/${rated.length}`,
            color: tagHits === rated.length ? C.green : C.red,
          }
        : { label: "Cards seen", value: String(this.seen.length), color: C.text },
      { label: "Average miss", value: avgErr.toFixed(1), color: avgErr < 0.5 ? C.green : avgErr < 2 ? C.gold : C.red },
      { label: "Peeks", value: `${this.peekCount} · ${this.peekTime.toFixed(0)}s`, color: this.peekCount === 0 ? C.green : C.dim },
    ];
    cards.forEach((c, i) => {
      const r = { x: 60 + i * 186, y: 84, w: 170, h: 66 };
      fillRound(ctx, r, 10, C.panel, C.line);
      text(ctx, c.label.toUpperCase(), r.x + 14, r.y + 22, { size: 9, color: C.faint, weight: "700" });
      text(ctx, c.value, r.x + 14, r.y + 50, {
        size: 22,
        weight: "800",
        color: c.color,
        mono: true,
        maxWidth: r.w - 28,
      });
    });

    // The shuffle answers.
    const fin = { x: 60 + 4 * 186, y: 84, w: VW - 60 - (60 + 4 * 186), h: 66 };
    fillRound(ctx, fin, 10, C.panel, C.line);
    text(ctx, "AT THE CUT CARD", fin.x + 16, fin.y + 22, { size: 9, color: C.faint, weight: "700" });
    const bits: [string, boolean, string][] = [
      ["running", this.finalGot.rc, signed(this.finalTruth.rc)],
      ["decks", this.finalGot.decks, this.finalTruth.decks.toFixed(2)],
      ["true", this.finalGot.tc, signed(this.finalTruth.tc)],
    ];
    const colW = (fin.w - 32) / bits.length;
    bits.forEach(([label, ok, value], i) => {
      const bx = fin.x + 16 + i * colW;
      text(ctx, `${ok ? "✓" : "✗"} ${value}`, bx, fin.y + 44, {
        size: 15,
        weight: "700",
        color: ok ? C.green : C.red,
        mono: true,
      });
      text(ctx, label, bx, fin.y + 58, { size: 10, color: C.faint });
    });

    this.drawTrace(f, 60, 176, VW - 120, 150);
    this.drawDrift(f, 60, 356);

    if (
      button(f, { x: 60, y: VH - 66, w: 260, h: 50 }, "Deal another shoe", {
        accent: C.green,
        hotkey: "SPACE",
      }) ||
      f.input.consume(" ", "Enter")
    ) {
      this.shoeIndex++;
      this.startShoe(false);
      return;
    }
    if (button(f, { x: 336, y: VH - 66, w: 200, h: 50 }, "Change the table")) {
      this.stage = "setup";
      return;
    }
    if (button(f, { x: VW - 180, y: VH - 66, w: 140, h: 50 }, "Back", { hotkey: "ESC" }) ||
      f.input.consume("Escape")) {
      this.onExit();
    }
  }

  /** The count over the whole shoe, with every checkpoint marked on it. */
  private drawTrace(f: Frame, x: number, y: number, w: number, h: number): void {
    const { ctx } = f;
    fillRound(ctx, { x, y, w, h }, 10, C.panel, C.line);
    text(ctx, "THE COUNT THROUGH THE SHOE", x + 16, y + 22, {
      size: 9,
      color: C.faint,
      weight: "700",
    });
    if (this.manual) {
      const pctInStep = this.inStepFraction() * 100;
      text(ctx, "the shoe", x + 190, y + 22, { size: 10, color: C.blue, weight: "700" });
      text(ctx, "your counter", x + 250, y + 22, { size: 10, color: C.purple, weight: "700" });
      text(ctx, `in step for ${pctInStep.toFixed(0)}% of the shoe`, x + w - 16, y + 22, {
        size: 11,
        color: pctInStep > 97 ? C.green : pctInStep > 85 ? C.gold : C.red,
        align: "right",
        weight: "700",
      });
    }
    if (this.trace.length < 2) return;

    const padL = 46;
    const plot = { x: x + padL, y: y + 34, w: w - padL - 16, h: h - 50 };
    const all = this.manual ? [...this.trace, ...this.yourTrace] : this.trace;
    const lo = Math.min(0, ...all);
    const hi = Math.max(0, ...all);
    const span = Math.max(4, hi - lo);
    const toY = (v: number) => plot.y + plot.h - ((v - lo) / span) * plot.h;
    const toX = (i: number) => plot.x + (i / (this.trace.length - 1)) * plot.w;

    // Zero line.
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.x, toY(0));
    ctx.lineTo(plot.x + plot.w, toY(0));
    ctx.stroke();
    text(ctx, "0", plot.x - 10, toY(0) + 4, { size: 10, color: C.faint, align: "right" });
    text(ctx, signed(hi), plot.x - 10, toY(hi) + 4, { size: 10, color: C.faint, align: "right" });
    text(ctx, signed(lo), plot.x - 10, toY(lo) + 4, { size: 10, color: C.faint, align: "right" });

    ctx.beginPath();
    this.trace.forEach((v, i) => {
      const px = toX(i);
      const py = toY(v);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = C.blue;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Your own line, drawn over the shoe's so any gap between them is the story.
    if (this.manual) {
      ctx.beginPath();
      this.yourTrace.forEach((v, i) => {
        const px = toX(i);
        const py = toY(v);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = C.purple;
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.globalAlpha = 1;

      const drift = this.firstDrift();
      if (drift !== null) {
        const px = toX(drift);
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.moveTo(px, plot.y);
        ctx.lineTo(px, plot.y + plot.h);
        ctx.strokeStyle = "rgba(224,85,75,0.8)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    for (const cp of this.checkpoints) {
      const i = Math.min(this.trace.length - 1, Math.max(0, cp.at - 1));
      const px = toX(i);
      const py = toY(cp.truth);
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = cp.correct ? C.green : C.red;
      ctx.fill();
      if (!cp.correct) {
        const ay = toY(cp.answer);
        ctx.beginPath();
        ctx.arc(px, ay, 4, 0, Math.PI * 2);
        ctx.strokeStyle = C.red;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.setLineDash([3, 3]);
        ctx.moveTo(px, py);
        ctx.lineTo(px, ay);
        ctx.stroke();
        ctx.setLineDash([]);
        text(ctx, signed(cp.answer), px, ay - 9, {
          size: 10,
          color: C.red,
          align: "center",
          weight: "700",
        });
      }
    }
  }

  /** The stretch of cards between the last check you got right and the first you did not. */
  private drawDrift(f: Frame, x: number, y: number): void {
    const { ctx } = f;
    const w = VW - 120;
    const h = 244;
    fillRound(ctx, { x, y, w, h }, 10, C.panel, C.line);

    // With a manual counter the game knows your number on every card, so it can
    // name the exact one you went wrong on rather than the stretch it was in.
    const drift = this.firstDrift();

    // Blind mode with clean tagging but missed recalls is the most useful
    // diagnosis the drill can give: your eyes are fine, your memory is the gap.
    if (this.blind && drift === null) {
      const missed = this.checkpoints.filter((c) => !c.correct);
      const tagged = this.checkpoints.filter((c) => c.counterCorrect);
      if (missed.length > 0 && tagged.length === this.checkpoints.filter((c) => c.counter !== undefined).length) {
        text(ctx, "WHERE IT SLIPPED", x + 16, y + 22, { size: 9, color: C.faint, weight: "700" });
        text(ctx, "Not your eyes. Your memory.", x + 16, y + 52, {
          size: 20,
          weight: "700",
          color: C.gold,
        });
        wrapText(
          ctx,
          `Your presses tracked the shoe the whole way — every tag was right. What you could not do was hold the total: ${missed
            .map((c) => `at card ${c.at} you said ${signed(c.answer)} when it was ${signed(c.truth)}`)
            .slice(0, 3)
            .join(", ")}. That is the thing to drill, and it is a different exercise from tagging.`,
          x + 16,
          y + 84,
          w - 32,
          22,
          { size: 14, color: C.dim },
        );
        return;
      }
    }

    if (drift !== null) {
      const yours = this.yourTrace[drift];
      const truth = this.expectedAt(drift);
      const gap = yours - truth;
      const from = Math.max(0, drift - 9);
      const window = this.seen.slice(from, Math.min(this.seen.length, drift + 3));
      text(ctx, "WHERE IT SLIPPED", x + 16, y + 22, { size: 9, color: C.faint, weight: "700" });
      text(ctx, `Card ${drift} is where your counter and the shoe parted.`, x + 16, y + 48, {
        size: 17,
        weight: "700",
      });
      text(
        ctx,
        `You had ${signed(yours)} where the shoe had ${signed(truth)} — ${Math.abs(gap)} ${
          gap < 0 ? "low card" : "high card"
        }${Math.abs(gap) === 1 ? "" : "s"} went past you. Here are the cards either side of it.`,
        x + 16,
        y + 70,
        { size: 13, color: C.dim },
      );
      this.drawCardStrip(f, x + 16, y + 88, w - 32, window, from, drift);
      return;
    }

    const firstWrong = this.checkpoints.find((c) => !c.correct);
    if (!firstWrong) {
      text(ctx, "NOTHING TO REVIEW", x + 16, y + 22, { size: 9, color: C.faint, weight: "700" });
      text(ctx, "You held the count all the way through.", x + 16, y + 56, {
        size: 20,
        weight: "700",
        color: C.green,
      });
      text(
        ctx,
        this.peekCount > 0
          ? `You peeked ${this.peekCount} time${this.peekCount === 1 ? "" : "s"}. Try the next shoe without it.`
          : "No peeking either. Speed it up or add a player and go again.",
        x + 16,
        y + 84,
        { size: 14, color: C.dim },
      );
      return;
    }

    const prior = [...this.checkpoints].reverse().find((c) => c.correct && c.at < firstWrong.at);
    const from = prior ? prior.at : 0;
    const to = firstWrong.at;
    const window = this.seen.slice(from, to);
    const shown = window.slice(-72);
    const trimmed = window.length - shown.length;
    const gapAtCheck = firstWrong.answer - firstWrong.truth;

    text(ctx, "WHERE IT SLIPPED", x + 16, y + 22, { size: 9, color: C.faint, weight: "700" });
    text(
      ctx,
      prior
        ? `You were right at card ${from}, then ${signed(gapAtCheck)} out by card ${to}.`
        : `By card ${to} you were ${signed(gapAtCheck)} out.`,
      x + 16,
      y + 48,
      { size: 17, weight: "700", color: C.text },
    );
    text(
      ctx,
      `These are the ${window.length} cards in between${trimmed > 0 ? ` (last ${shown.length} shown)` : ""}. They add up to ${signed(
        window.reduce((a, c) => a + hiLo(c.rank), 0),
      )}.`,
      x + 16,
      y + 70,
      { size: 13, color: C.dim },
    );

    this.drawCardStrip(f, x + 16, y + 88, w - 32, shown, from + trimmed, -1);
  }

  /** Mini cards with their tags, optionally singling one card out. */
  private drawCardStrip(
    f: Frame,
    x: number,
    y: number,
    w: number,
    cards: Card[],
    startIndex: number,
    markIndex: number,
  ): void {
    const { ctx } = f;
    const cw = 30;
    const ch = 42;
    const perRow = Math.max(1, Math.floor(w / (cw + 4)));
    cards.forEach((c, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const cx = x + col * (cw + 4);
      const cy = y + row * (ch + 24);
      const marked = startIndex + i === markIndex;
      if (marked) {
        fillRound(ctx, { x: cx - 3, y: cy - 3, w: cw + 6, h: ch + 6 }, 5, "rgba(224,85,75,0.28)");
      }
      drawHand(ctx, [c], cx, cy, { scale: cw / 62, overlap: cw });
      const tag = hiLo(c.rank);
      text(ctx, tag > 0 ? "+1" : tag < 0 ? "−1" : "0", cx + cw / 2, cy + ch + 11, {
        size: 10,
        align: "center",
        weight: "700",
        color: tag > 0 ? C.green : tag < 0 ? C.red : C.faint,
      });
      if (marked) {
        text(ctx, "here", cx + cw / 2, cy + ch + 22, {
          size: 9,
          align: "center",
          weight: "700",
          color: C.red,
        });
      }
    });
  }
}
