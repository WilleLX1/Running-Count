import type { Game, Scene } from "../game";
import { VH, VW } from "../core/renderer";
import { C, bar, button, chipStack, fillRound, roundRect, text, vignette, type Frame } from "../core/ui";
import { money, signed } from "../core/math";
import { drawCard, drawHand } from "../render/cards";
import type { CasinoTable } from "../world/casino";
import type { FloorScene } from "./floor";
import { ResultsScene } from "./results";
import {
  describeTotal,
  handTotal,
  isBlackjack,
  legalActions,
  type Hand,
} from "../blackjack/hand";
import {
  ACTION_LABEL,
  correctAction,
  shouldInsure,
  type Action,
} from "../blackjack/strategy";
import { estimateDecksRemaining, floorTrueCount, recommendedBet } from "../blackjack/counting";
import { rulesSummary } from "../blackjack/rules";
import type { Phase } from "../blackjack/sim";

interface CountCheck {
  answer: number;
  entry: number;
  typed: string;
  resolved: boolean;
  correct: boolean;
}

interface Feedback {
  text: string;
  color: string;
  t: number;
}

export class TableScene implements Scene {
  private sim;
  private feedback: Feedback[] = [];
  private countCheck: CountCheck | null = null;
  private backoffT = 0;
  private tipped = 0;
  private lastPhase: Phase = "betting";
  private hintAction: Action | null = null;
  private hintNote = "";

  constructor(
    private game: Game,
    private floor: FloorScene,
    private table: CasinoTable,
  ) {
    this.sim = table.sim;
  }

  enter(): void {
    const free = this.sim.freeSeats();
    if (free.length > 0) this.sim.sit(free[free.length - 1]);
    this.sim.hooks.onMessage = (t, color) => this.push(t, color);
    this.sim.hooks.onShuffle = () => {
      this.push("New shoe. Your count goes back to zero.", C.blue);
      this.game.session.playerRunning = 0;
    };
    this.sim.hooks.onPhase = (p) => this.onPhase(p);
    this.sim.pendingBet = Math.max(this.sim.rules.minBet, Math.min(this.game.session.unit, this.game.session.bankroll));
  }

  exit(): void {
    this.sim.standUp();
    this.sim.hooks.onMessage = undefined;
    this.sim.hooks.onPhase = undefined;
    this.sim.hooks.onShuffle = undefined;
    this.game.session.surveillance.leaveTable();
    this.table.awaySeconds = 0;
  }

  private push(t: string, color = C.text): void {
    this.feedback.unshift({ text: t, color, t: 4 });
    if (this.feedback.length > 5) this.feedback.pop();
  }

  private onPhase(p: Phase): void {
    if (p === "shuffle" && this.game.session.assist !== "full") {
      // Ask for the count before the shoe is washed.
      this.countCheck = {
        answer: this.sim.count.running,
        entry: this.game.session.assist === "partial" ? this.game.session.playerRunning : 0,
        typed: "",
        resolved: false,
        correct: false,
      };
    }
    this.lastPhase = p;
  }

  // ------------------------------------------------------------------ loop

  frame(f: Frame): void {
    const session = this.game.session;
    const sim = this.sim;
    const dt = f.dt;

    session.stats.timePlayed += dt;
    for (const fb of this.feedback) fb.t -= dt;
    this.feedback = this.feedback.filter((x) => x.t > 0);

    const modal = this.countCheck !== null;
    if (!modal) {
      sim.update(dt);
      session.surveillance.update(dt, true);
    }

    // Suits on the way.
    if (session.surveillance.backoffPending) {
      this.backoffT += dt;
      if (this.backoffT > 7) {
        session.stats.backoffs++;
        this.game.setScene(new ResultsScene(this.game, "backoff"));
        return;
      }
    } else {
      this.backoffT = 0;
    }

    if (session.bankroll < sim.rules.minBet && sim.phase === "betting" && !sim.betLocked) {
      if (session.bankroll < 5) {
        this.game.setScene(new ResultsScene(this.game, "broke"));
        return;
      }
    }

    this.draw(f);
    if (!modal) this.controls(f);
    else this.drawCountCheck(f);

    if (f.input.consume("Escape")) this.leave();
  }

  private leave(): void {
    const s = this.game.session.surveillance;
    if (s.backoffPending) {
      s.backoffPending = false;
      s.suspicion = 72;
      s.recognition = Math.min(100, s.recognition + 25);
      this.game.toast("You colour up and walk before they reach the table. They saw you leave.", C.heat);
    }
    this.floor.placeAtTable(this.table);
    this.game.setScene(this.floor);
  }

  // --------------------------------------------------------------- drawing

  private draw(f: Frame): void {
    const { ctx } = f;
    const sim = this.sim;

    // Room and felt.
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(0, 0, VW, VH);

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

    // Table arc text.
    text(ctx, "BLACKJACK PAYS " + (sim.rules.blackjackPayout === 1.5 ? "3 TO 2" : "6 TO 5"), VW / 2, 330, {
      size: 15,
      color: "rgba(255,255,255,0.32)",
      align: "center",
      weight: "700",
    });
    text(
      ctx,
      sim.rules.dealerHitsSoft17 ? "Dealer must hit soft 17" : "Dealer must stand on all 17s",
      VW / 2,
      352,
      { size: 12, color: "rgba(255,255,255,0.24)", align: "center" },
    );

    this.drawShoe(f);
    this.drawDealer(f);
    this.drawSeats(f);
    this.drawTopBar(f);
    this.drawCountPanel(f);
    this.drawFeedback(f);

    if (this.game.session.surveillance.backoffPending) {
      const a = 0.18 + Math.sin(f.time * 7) * 0.1;
      ctx.fillStyle = `rgba(224,85,75,${a})`;
      ctx.fillRect(0, 0, VW, VH);
      text(ctx, "The pit boss and a suit are walking over.", VW / 2, 402, {
        size: 18,
        weight: "700",
        align: "center",
        color: "#ffd9d5",
      });
      text(ctx, `ESC to colour up and leave  ·  ${(7 - this.backoffT).toFixed(1)}s`, VW / 2, 426, {
        size: 14,
        align: "center",
        color: "#ffd9d5",
      });
    }

    vignette(ctx, VW, VH, 0.5);
  }

  private drawTopBar(f: Frame): void {
    const { ctx } = f;
    const session = this.game.session;
    fillRound(ctx, { x: 12, y: 10, w: 420, h: 54 }, 9, "rgba(10,15,20,0.82)", C.line);
    text(ctx, this.sim.rules.name, 28, 32, { size: 16, weight: "700" });
    text(ctx, rulesSummary(this.sim.rules), 28, 52, { size: 11, color: C.faint });

    fillRound(ctx, { x: 446, y: 10, w: 250, h: 54 }, 9, "rgba(10,15,20,0.82)", C.line);
    text(ctx, "BANKROLL", 462, 28, { size: 9, color: C.faint, weight: "700" });
    text(ctx, money(session.bankroll), 462, 52, { size: 22, weight: "700", color: C.gold });

    const s = session.surveillance;
    fillRound(ctx, { x: VW - 372, y: 10, w: 360, h: 54 }, 9, "rgba(10,15,20,0.82)", C.line);
    text(ctx, "THE PIT", VW - 356, 26, { size: 9, color: C.faint, weight: "700" });
    bar(f, { x: VW - 356, y: 32, w: 328, h: 10 }, s.suspicion / 100, heatColor(s.suspicion));
    text(ctx, s.tellText(), VW - 356, 57, { size: 11, color: C.dim, maxWidth: 330 });
  }

  private drawShoe(f: Frame): void {
    const { ctx } = f;
    const sim = this.sim;
    // Shoe on the dealer's right.
    fillRound(ctx, { x: VW - 190, y: 108, w: 74, h: 54 }, 6, "#2a1f18", "#4b382a", 2);
    const remainFrac = 1 - sim.shoe.fractionDealt;
    // The block of undealt cards still sitting in the shoe.
    ctx.fillStyle = "#e8e2d6";
    const innerW = 62 * Math.max(0.04, remainFrac);
    ctx.fillRect(VW - 184, 116, innerW, 38);
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    for (let i = 0; i < innerW; i += 4) {
      ctx.beginPath();
      ctx.moveTo(VW - 184 + i, 116);
      ctx.lineTo(VW - 184 + i, 154);
      ctx.stroke();
    }
    text(ctx, "SHOE", VW - 153, 176, { size: 10, color: "rgba(255,255,255,0.45)", align: "center", weight: "700" });

    // Discard tray -- the thing you actually estimate decks from.
    const trayH = 96;
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
    if (this.game.session.assist === "full") {
      text(ctx, `${sim.shoe.decksDealt.toFixed(1)} decks`, VW - 152, trayY + trayH + 32, {
        size: 11,
        color: C.gold,
        align: "center",
      });
    }
    if (sim.shoe.cutCardOut) {
      text(ctx, "CUT CARD", VW - 152, 196, { size: 10, color: C.red, align: "center", weight: "800" });
    }
  }

  private drawDealer(f: Frame): void {
    const { ctx } = f;
    const sim = this.sim;
    const cards = sim.dealer.cards;
    const hideIndex = sim.dealer.holeHidden ? 1 : -1;
    const w = cards.length ? (cards.length - 1) * 30 + 62 : 0;
    const x = VW / 2 - w / 2;
    drawHand(ctx, cards, x, 88, { overlap: 30, hideIndex });

    if (cards.length) {
      const shown = sim.dealer.holeHidden ? [cards[0]] : cards;
      const label = sim.dealer.holeHidden ? `showing ${handTotal(shown).total}` : describeTotal(cards);
      fillRound(ctx, { x: VW / 2 - 60, y: 186, w: 120, h: 24 }, 6, "rgba(6,12,9,0.65)");
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
  }

  private seatPos(i: number, n: number): { x: number; y: number } {
    // Kept clear of the shoe and discard tray on the right.
    const spread = 820;
    const centre = VW / 2 - 40;
    const x = centre - spread / 2 + (spread * i) / Math.max(1, n - 1);
    const c = (n - 1) / 2;
    const y = 470 - 52 * (Math.abs(i - c) / Math.max(0.001, c));
    return { x, y };
  }

  private drawSeats(f: Frame): void {
    const { ctx } = f;
    const sim = this.sim;
    const n = sim.seats.length;
    const actor = sim.currentActor();

    sim.seats.forEach((seat, i) => {
      const { x, y } = this.seatPos(i, n);
      const isPlayer = seat.kind === "player";

      // Betting circle.
      ctx.beginPath();
      ctx.arc(x, y, 26, 0, Math.PI * 2);
      ctx.strokeStyle = isPlayer ? "rgba(240,193,75,0.85)" : "rgba(255,255,255,0.22)";
      ctx.lineWidth = 2;
      ctx.stroke();

      if (seat.kind === "empty") {
        text(ctx, "open", x, y + 4, {
          size: 11,
          color: "rgba(255,255,255,0.25)",
          align: "center",
          weight: "600",
        });
        return;
      }

      const totalBet = seat.hands.reduce((a, h) => a + h.bet, 0) || seat.bet;
      if (totalBet > 0) chipStack(ctx, x, y + 6, totalBet, sim.rules.minBet);

      // Cards for each hand.
      const hands = seat.hands;
      hands.forEach((hand, hi) => {
        const scale = hands.length > 1 ? 0.62 : 0.78;
        const overlap = 22 * (scale / 0.78);
        const hw = (hand.cards.length - 1) * overlap + 62 * scale;
        const offset = (hi - (hands.length - 1) / 2) * (hands.length > 1 ? 78 : 0);
        const hx = x + offset - hw / 2;
        const hy = y - 108 - (hands.length > 1 ? 0 : 0);
        const isActive =
          actor != null && actor.seat === seat.index && actor.hand === hi && sim.phase === "playing";
        drawHand(ctx, hand.cards, hx, hy, {
          scale,
          overlap,
          highlight: isActive ? C.gold : undefined,
          dim: hand.result === "lose" || hand.result === "bust" || hand.surrendered,
        });
        if (hand.cards.length) {
          const t = handTotal(hand.cards);
          const bj = isBlackjack(hand);
          const badge = hand.surrendered
            ? "surr"
            : bj
              ? "BJ"
              : t.total > 21
                ? "bust"
                : t.soft
                  ? `s${t.total}`
                  : `${t.total}`;
          const bw = 40;
          fillRound(
            ctx,
            { x: x + offset - bw / 2, y: hy + 96 * scale + 4, w: bw, h: 20 },
            5,
            t.total > 21 || hand.surrendered ? "rgba(120,30,26,0.8)" : "rgba(6,12,9,0.72)",
          );
          text(ctx, badge, x + offset, hy + 96 * scale + 14, {
            size: 12,
            color: bj ? C.gold : "#dfe6ee",
            align: "center",
            baseline: "middle",
            weight: "700",
          });
        }
      });

      // Name plate.
      const nameY = y + 44;
      text(ctx, isPlayer ? "YOU" : seat.name, x, nameY, {
        size: 12,
        color: isPlayer ? C.gold : "rgba(223,230,238,0.65)",
        align: "center",
        weight: "700",
      });
      if (seat.insurance > 0) {
        text(ctx, `ins ${money(seat.insurance)}`, x, nameY + 15, {
          size: 10,
          color: C.blue,
          align: "center",
        });
      }
      if (seat.flash) {
        const a = Math.min(1, seat.flash.t);
        ctx.globalAlpha = a;
        text(ctx, seat.flash.text, x, y - 140, {
          size: 18,
          color: seat.flash.color,
          align: "center",
          weight: "800",
        });
        ctx.globalAlpha = 1;
      }
    });
  }

  private drawFeedback(f: Frame): void {
    const { ctx } = f;
    this.feedback.forEach((fb, i) => {
      const a = Math.min(1, fb.t / 1.2);
      ctx.globalAlpha = a;
      text(ctx, fb.text, 24, 560 - i * 20, { size: 13, color: fb.color });
      ctx.globalAlpha = 1;
    });
  }

  // -------------------------------------------------------- count / assist

  private drawCountPanel(f: Frame): void {
    const { ctx } = f;
    const session = this.game.session;
    const sim = this.sim;
    const r = { x: 12, y: 580, w: 300, h: 128 };
    fillRound(ctx, r, 10, "rgba(10,15,20,0.9)", C.line);

    const decksExact = sim.shoe.decksRemaining;
    const decksEst = estimateDecksRemaining(decksExact);

    if (session.assist === "full") {
      const rc = sim.count.running;
      const tc = sim.trueCount;
      text(ctx, "RUNNING", r.x + 16, r.y + 26, { size: 9, color: C.faint, weight: "700" });
      text(ctx, signed(rc), r.x + 16, r.y + 56, {
        size: 30,
        weight: "800",
        color: rc > 0 ? C.green : rc < 0 ? C.red : C.text,
        mono: true,
      });
      text(ctx, "TRUE", r.x + 118, r.y + 26, { size: 9, color: C.faint, weight: "700" });
      text(ctx, signed(tc, 1), r.x + 118, r.y + 56, {
        size: 30,
        weight: "800",
        color: tc >= 2 ? C.green : tc <= -1 ? C.red : C.text,
        mono: true,
      });
      text(ctx, "DECKS", r.x + 226, r.y + 26, { size: 9, color: C.faint, weight: "700" });
      text(ctx, decksExact.toFixed(1), r.x + 226, r.y + 56, { size: 30, weight: "800", mono: true });
      const rec = recommendedBet(tc, session.unit, sim.rules.minBet, sim.rules.maxBet);
      const units = Math.round(rec / session.unit);
      text(ctx, `Ramp says bet ${money(rec)}  (${units} unit${units === 1 ? "" : "s"})`, r.x + 16, r.y + 84, {
        size: 13,
        color: C.gold,
      });
      const edge = -0.005 + tc * 0.005;
      text(ctx, `Your edge right now: ${(edge * 100).toFixed(2)}%`, r.x + 16, r.y + 106, {
        size: 12,
        color: edge > 0 ? C.green : C.dim,
      });
    } else if (session.assist === "partial") {
      const rc = session.playerRunning;
      const tc = rc / Math.max(0.25, decksEst);
      text(ctx, "YOUR COUNT", r.x + 16, r.y + 26, { size: 9, color: C.faint, weight: "700" });
      text(ctx, signed(rc), r.x + 16, r.y + 60, { size: 34, weight: "800", mono: true });
      text(ctx, "+ / -  to adjust", r.x + 16, r.y + 80, { size: 11, color: C.faint });
      text(ctx, "EST. TRUE", r.x + 150, r.y + 26, { size: 9, color: C.faint, weight: "700" });
      text(ctx, signed(tc, 1), r.x + 150, r.y + 60, {
        size: 34,
        weight: "800",
        mono: true,
        color: tc >= 2 ? C.green : tc <= -1 ? C.red : C.text,
      });
      text(ctx, `Tray reads about ${decksEst.toFixed(2)} decks left`, r.x + 16, r.y + 106, {
        size: 12,
        color: C.dim,
      });
    } else {
      text(ctx, "NO HELP", r.x + 16, r.y + 26, { size: 9, color: C.faint, weight: "700" });
      text(ctx, "Keep it in your head.", r.x + 16, r.y + 56, { size: 17, color: C.dim, weight: "600" });
      text(ctx, "A count check comes at the shuffle.", r.x + 16, r.y + 82, { size: 12, color: C.faint });
      text(ctx, `Shoe is ${Math.round(sim.shoe.fractionDealt * 100)}% dealt`, r.x + 16, r.y + 104, {
        size: 12,
        color: C.faint,
      });
    }

    // Hint line for the current decision.
    if (this.hintAction && session.assist === "full") {
      fillRound(ctx, { x: 324, y: 580, w: 268, h: 60 }, 10, "rgba(10,15,20,0.9)", C.gold);
      text(ctx, "CORRECT PLAY", 340, 600, { size: 9, color: C.faint, weight: "700" });
      text(ctx, ACTION_LABEL[this.hintAction].toUpperCase(), 340, 626, {
        size: 20,
        weight: "800",
        color: C.gold,
      });
      if (this.hintNote) {
        text(ctx, this.hintNote, 340, 646, { size: 11, color: C.purple });
      }
    }
  }

  private drawCountCheck(f: Frame): void {
    const { ctx } = f;
    const cc = this.countCheck!;
    ctx.fillStyle = "rgba(4,7,10,0.82)";
    ctx.fillRect(0, 0, VW, VH);
    const r = { x: VW / 2 - 260, y: 220, w: 520, h: 260 };
    fillRound(ctx, r, 14, C.panel, C.gold, 2);
    text(ctx, "COUNT CHECK", VW / 2, r.y + 40, {
      size: 13,
      color: C.faint,
      align: "center",
      weight: "800",
    });
    text(ctx, "What was the running count?", VW / 2, r.y + 74, {
      size: 20,
      align: "center",
      weight: "700",
    });

    if (!cc.resolved) {
      fillRound(ctx, { x: VW / 2 - 90, y: r.y + 96, w: 180, h: 66 }, 10, "#0a0f14", C.line);
      text(ctx, signed(cc.entry), VW / 2, r.y + 140, {
        size: 40,
        align: "center",
        weight: "800",
        mono: true,
      });
      if (button(f, { x: VW / 2 - 170, y: r.y + 108, w: 60, h: 42 }, "−", { accent: C.red })) cc.entry--;
      if (button(f, { x: VW / 2 + 110, y: r.y + 108, w: 60, h: 42 }, "+", { accent: C.green })) cc.entry++;
      if (f.input.consume("arrowup", "+", "=")) cc.entry++;
      if (f.input.consume("arrowdown", "-")) cc.entry--;
      if (button(f, { x: VW / 2 - 90, y: r.y + 180, w: 180, h: 46 }, "Lock it in", { accent: C.gold, hotkey: "ENTER" }) ||
        f.input.consume("Enter")) {
        cc.correct = cc.entry === cc.answer;
        cc.resolved = true;
        this.game.session.recordCountCheck(cc.correct);
      }
    } else {
      const good = cc.correct;
      text(ctx, good ? "Dead on." : `Off by ${Math.abs(cc.entry - cc.answer)}.`, VW / 2, r.y + 132, {
        size: 26,
        align: "center",
        weight: "800",
        color: good ? C.green : C.red,
      });
      text(ctx, `True running count was ${signed(cc.answer)}. You said ${signed(cc.entry)}.`, VW / 2, r.y + 164, {
        size: 14,
        align: "center",
        color: C.dim,
      });
      text(
        ctx,
        `Session count accuracy: ${(this.game.session.countAccuracy * 100).toFixed(0)}%`,
        VW / 2,
        r.y + 186,
        { size: 13, align: "center", color: C.faint },
      );
      if (button(f, { x: VW / 2 - 90, y: r.y + 202, w: 180, h: 42 }, "Continue", { accent: C.green, hotkey: "ENTER" }) ||
        f.input.consume("Enter", " ")) {
        this.countCheck = null;
        this.game.session.playerRunning = 0;
      }
    }
  }

  // -------------------------------------------------------------- controls

  private controls(f: Frame): void {
    const sim = this.sim;
    const session = this.game.session;
    const seat = sim.seat;

    // Manual count keys.
    if (session.assist === "partial") {
      if (f.input.consume("+", "=")) session.playerRunning++;
      if (f.input.consume("-")) session.playerRunning--;
    }

    // Always available.
    if (button(f, { x: VW - 150, y: VH - 54, w: 138, h: 42 }, "Stand up", { small: true, hotkey: "ESC" })) {
      this.leave();
      return;
    }
    const tipR = { x: VW - 300, y: VH - 54, w: 138, h: 42 };
    const tipCost = Math.max(5, Math.round(session.unit / 2));
    if (
      button(f, tipR, `Tip ${money(tipCost)}`, { small: true, accent: C.purple, enabled: session.bankroll > tipCost }) ||
      f.input.consume("t")
    ) {
      if (session.bankroll > tipCost) {
        session.bankroll -= tipCost;
        this.tipped += tipCost;
        session.surveillance.applyCover(6, "tipped the dealer");
        this.push("You toss the dealer a chip. The pit likes tippers.", C.purple);
      }
    }

    if (!seat) return;

    if (sim.phase === "betting" && !sim.betLocked) {
      this.bettingControls(f);
      return;
    }

    if (sim.phase === "insurance" && sim.offeringInsurance) {
      this.insuranceControls(f);
      return;
    }

    const turn = sim.playerTurn();
    if (turn) {
      this.actionControls(f, turn.hand);
    } else {
      this.hintAction = null;
      this.hintNote = "";
    }
  }

  private bettingControls(f: Frame): void {
    const sim = this.sim;
    const session = this.game.session;
    const y = VH - 128;
    const denoms = [sim.rules.minBet, sim.rules.minBet * 5, sim.rules.minBet * 10, sim.rules.minBet * 50];

    fillRound(f.ctx, { x: 604, y: y - 34, w: 664, h: 116 }, 10, "rgba(10,15,20,0.9)", C.line);
    text(f.ctx, "YOUR BET", 620, y - 12, { size: 9, color: C.faint, weight: "700" });
    text(f.ctx, money(sim.pendingBet), 620, y + 22, { size: 32, weight: "800", color: C.gold });
    text(
      f.ctx,
      `table ${money(sim.rules.minBet)} – ${money(sim.rules.maxBet)}`,
      620,
      y + 44,
      { size: 11, color: C.faint },
    );

    denoms.forEach((d, i) => {
      const r = { x: 790 + i * 78, y: y - 6, w: 70, h: 46 };
      if (button(f, r, `+${money(d)}`, { small: true, accent: C.blue, hotkey: String(i + 1) }) ||
        f.input.consume(String(i + 1))) {
        sim.addBet(d);
      }
    });
    if (button(f, { x: 790, y: y + 46, w: 148, h: 32 }, "Clear", { small: true }) || f.input.consume("backspace")) {
      sim.setBet(0);
    }
    if (button(f, { x: 946, y: y + 46, w: 148, h: 32 }, "Min bet", { small: true })) {
      sim.setBet(sim.rules.minBet);
    }

    const canDeal = sim.pendingBet >= sim.rules.minBet && sim.pendingBet <= session.bankroll;
    if (
      button(f, { x: 1106, y: y - 6, w: 146, h: 84 }, "DEAL", {
        accent: C.green,
        enabled: canDeal,
        hotkey: "SPACE",
      }) ||
      (canDeal && f.input.consume(" ", "Enter"))
    ) {
      this.rateBet(sim.pendingBet);
      sim.confirmBet();
    }

    // Wong out, and a countdown so jumping back in is a real decision.
    if (sim.sittingOut) {
      fillRound(f.ctx, { x: 604, y: y + 46, w: 170, h: 32 }, 8, "rgba(255,122,69,0.16)", C.heat);
      text(f.ctx, `Dealing in ${sim.timer.toFixed(1)}s`, 689, y + 63, {
        size: 13,
        color: C.heat,
        align: "center",
        baseline: "middle",
        weight: "700",
      });
    } else if (
      button(f, { x: 604, y: y + 46, w: 170, h: 32 }, "Sit this one out", { small: true, accent: C.heat }) ||
      f.input.consume("w")
    ) {
      sim.setSittingOut(true);
      this.push("You wave the hand off and watch the cards.", C.heat);
    }
  }

  private rateBet(amount: number): void {
    const session = this.game.session;
    const sim = this.sim;
    const tc = sim.trueCount;
    const rec = recommendedBet(tc, session.unit, sim.rules.minBet, sim.rules.maxBet);
    const ratio = amount / Math.max(1, rec);
    const good = ratio >= 0.6 && ratio <= 1.7;
    session.recordBet(good);
    if (session.assist === "full" && !good) {
      this.push(
        `Ramp wanted ${money(rec)} at true ${signed(tc, 1)} — you put out ${money(amount)}.`,
        C.gold,
      );
    } else if (session.assist === "partial" && !good) {
      this.push("That bet does not match the shoe.", C.gold);
    }
  }

  private insuranceControls(f: Frame): void {
    const { ctx } = f;
    const sim = this.sim;
    const session = this.game.session;
    const r = { x: VW / 2 - 230, y: VH - 156, w: 460, h: 96 };
    fillRound(ctx, r, 10, "rgba(10,15,20,0.94)", C.gold, 2);
    text(ctx, "Insurance?", r.x + 20, r.y + 30, { size: 18, weight: "700" });
    text(
      ctx,
      `Costs ${money(Math.floor((sim.seat?.bet ?? 0) / 2))}. Pays 2:1 if the dealer has blackjack.`,
      r.x + 20,
      r.y + 52,
      { size: 12, color: C.dim },
    );
    if (session.assist === "full") {
      const tc = sim.trueCount;
      text(
        ctx,
        shouldInsure(tc) ? `True count ${signed(tc, 1)} — take it.` : `True count ${signed(tc, 1)} — decline.`,
        r.x + 20,
        r.y + 72,
        { size: 12, color: shouldInsure(tc) ? C.green : C.red, weight: "700" },
      );
    }
    const yes = button(f, { x: r.x + 250, y: r.y + 22, w: 92, h: 52 }, "Yes", { accent: C.green, hotkey: "Y" });
    const no = button(f, { x: r.x + 352, y: r.y + 22, w: 92, h: 52 }, "No", { accent: C.red, hotkey: "N" });
    if (yes || f.input.consume("y")) {
      const tc = sim.trueCount;
      if (!shouldInsure(tc)) this.push("Insurance is a bet on tens. That was not the spot.", C.red);
      sim.answerInsurance(true);
    } else if (no || f.input.consume("n")) {
      sim.answerInsurance(false);
    }
  }

  private actionControls(f: Frame, hand: Hand): void {
    const sim = this.sim;
    const session = this.game.session;
    const up = sim.dealerUpcard;
    if (!up) return;
    const seat = sim.seat!;
    const legal = legalActions(hand, seat.hands.length, sim.rules, session.bankroll);
    const tc = sim.trueCount;
    const { action: expected, deviation } = correctAction(
      hand,
      up,
      sim.rules,
      legal,
      floorTrueCount(tc),
      session.useDeviations,
    );
    this.hintAction = expected;
    this.hintNote = deviation ? `index play: ${deviation.name}` : "";

    const buttons: { a: Action; label: string; key: string; on: boolean; accent: string }[] = [
      { a: "hit", label: "Hit", key: "H", on: legal.hit, accent: C.blue },
      { a: "stand", label: "Stand", key: "S", on: legal.stand, accent: C.green },
      { a: "double", label: "Double", key: "D", on: legal.double, accent: C.gold },
      { a: "split", label: "Split", key: "P", on: legal.split, accent: C.purple },
      { a: "surrender", label: "Surrender", key: "R", on: legal.surrender, accent: C.red },
    ];

    // Sits to the right of the count panel and the correct-play hint.
    const bw = 118;
    const gap = 8;
    const startX = 634;
    let chosen: Action | null = null;
    buttons.forEach((b, i) => {
      const r = { x: startX + i * (bw + gap), y: VH - 116, w: bw, h: 58 };
      if (button(f, r, b.label, { enabled: b.on, accent: b.accent, hotkey: b.key })) chosen = b.a;
      if (b.on && f.input.consume(b.key.toLowerCase())) chosen = b.a;
    });

    text(
      f.ctx,
      `Your hand: ${describeTotal(hand.cards)} against dealer ${up.rank === "T" ? "10" : up.rank}`,
      startX,
      VH - 130,
      { size: 13, color: C.dim, align: "left" },
    );

    if (!chosen) return;
    const picked = chosen as Action;
    const correct = picked === expected;
    session.recordDecision({
      correct,
      chosen: picked,
      expected,
      wasDeviation: deviation !== null,
      total: describeTotal(hand.cards),
      up: up.rank,
    });
    if (!correct && session.assist !== "none") {
      this.push(
        `${describeTotal(hand.cards)} vs ${up.rank}: ${ACTION_LABEL[expected]} was right${deviation ? ` (${deviation.name})` : ""}.`,
        C.red,
      );
    } else if (correct && deviation && session.assist !== "none") {
      this.push(`Index play: ${deviation.name}.`, C.purple);
    }
    sim.act(picked);
    this.hintAction = null;
  }
}

function heatColor(v: number): string {
  if (v < 22) return C.green;
  if (v < 45) return "#9ecf4a";
  if (v < 70) return C.gold;
  if (v < 92) return C.heat;
  return C.red;
}
