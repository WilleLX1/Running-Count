import type { Game, Scene } from "../game";
import { VH, VW } from "../core/renderer";
import { C, bar, button, fillRound, panel, roundRect, text, vignette, type Frame } from "../core/ui";
import { Casino, WORLD_H, WORLD_W, type CasinoTable, type Interaction } from "../world/casino";
import { clamp, damp, money } from "../core/math";
import { mulberry32, randomSeed } from "../core/rng";
import { rulesSummary } from "../blackjack/rules";
import { TableScene } from "./table";
import { TrainerScene } from "./trainer";
import { ResultsScene } from "./results";

const PLAYER_SPEED = 175;
const PLAYER_R = 13;
/** Game minutes per real second. */
const TIME_SCALE = 12;

export class FloorScene implements Scene {
  casino: Casino;
  player = { x: WORLD_W / 2 - 250, y: WORLD_H - 120, vx: 0, vy: 0, face: 1, step: 0 };
  camX = WORLD_W / 2 - 250;
  camY = WORLD_H - 120;
  /** Minutes since 20:00. */
  clock = 0;
  private prompt: Interaction | null = null;
  private carpet: CanvasPattern | null = null;
  private note = "";
  private noteT = 0;
  private suitsT = 0;

  constructor(private game: Game) {
    const rng = mulberry32(randomSeed());
    this.casino = new Casino(rng, this.game.session, (table) => ({
      onRoundEnd: (s) => {
        if (!table.sim.playerSeated) return;
        this.game.session.recordRound(s);
        this.game.session.surveillance.observe(s, table.rules, this.game.session.unit);
      },
    }));
  }

  enter(): void {
    this.game.returnScene = this;
  }

  /** Called by the table scene when the player stands up. */
  placeAtTable(table: CasinoTable): void {
    this.player.x = table.useX;
    this.player.y = table.useY + 34;
  }

  advanceClock(minutes: number): void {
    this.clock += minutes;
    for (const t of this.casino.tables) t.awaySeconds += minutes * 60;
  }

  private say(msg: string): void {
    this.note = msg;
    this.noteT = 4;
  }

  frame(f: Frame): void {
    const dt = f.dt;
    const session = this.game.session;
    this.clock += dt * TIME_SCALE;
    this.noteT -= dt;

    // ---------------------------------------------------------- simulation
    session.stats.timePlayed += dt;
    session.surveillance.update(dt, false);
    this.casino.updateNpcs(dt);
    for (const t of this.casino.tables) t.awaySeconds += dt;

    let dx = 0;
    let dy = 0;
    if (f.input.isDown("a", "arrowleft")) dx -= 1;
    if (f.input.isDown("d", "arrowright")) dx += 1;
    if (f.input.isDown("w", "arrowup")) dy -= 1;
    if (f.input.isDown("s", "arrowdown")) dy += 1;
    const len = Math.hypot(dx, dy) || 1;
    const moving = dx !== 0 || dy !== 0;
    if (moving) {
      const sp = PLAYER_SPEED * dt;
      const moved = this.casino.moveCircle(
        this.player.x,
        this.player.y,
        (dx / len) * sp,
        (dy / len) * sp,
        PLAYER_R,
      );
      this.player.x = moved.x;
      this.player.y = moved.y;
      this.player.step += dt * 9;
      if (dx !== 0) this.player.face = Math.sign(dx);
    }

    this.camX = damp(this.camX, clamp(this.player.x, VW / 2, WORLD_W - VW / 2), 8, dt);
    this.camY = damp(this.camY, clamp(this.player.y, VH / 2, WORLD_H - VH / 2), 8, dt);

    this.prompt = this.casino.nearestInteraction(this.player.x, this.player.y);

    // Pit boss drifts toward the player as heat climbs.
    const heat = session.surveillance.suspicion;
    const pb = this.casino.pitBoss;
    if (heat > 40) {
      pb.tx = this.player.x;
      pb.ty = this.player.y - 90;
    } else {
      pb.tx = WORLD_W / 2;
      pb.ty = 340;
    }
    pb.x = damp(pb.x, pb.tx, heat > 40 ? 0.9 : 0.4, dt);
    pb.y = damp(pb.y, pb.ty, heat > 40 ? 0.9 : 0.4, dt);

    if (session.surveillance.backoffPending) {
      this.suitsT += dt;
      if (this.suitsT > 6) {
        session.surveillance.backoffPending = false;
        session.stats.backoffs++;
        this.game.setScene(new ResultsScene(this.game, "backoff"));
        return;
      }
    }

    if (session.bankroll < 5) {
      this.game.setScene(new ResultsScene(this.game, "broke"));
      return;
    }

    // ------------------------------------------------------------- render
    const { ctx } = f;
    ctx.save();
    ctx.translate(Math.round(VW / 2 - this.camX), Math.round(VH / 2 - this.camY));
    this.drawFloor(f);
    this.drawFeatures(f);
    for (const t of this.casino.tables) this.drawTable(f, t);
    this.drawCrowd(f);
    this.drawPlayer(f);
    ctx.restore();

    vignette(ctx, VW, VH, 0.55);
    this.drawHud(f);
    this.handleInteraction(f);
  }

  // ------------------------------------------------------------- rendering

  private drawFloor(f: Frame): void {
    const { ctx } = f;
    if (!this.carpet) this.carpet = makeCarpet(ctx);
    ctx.fillStyle = this.carpet ?? C.carpet;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    // Warm pools of light under each table.
    for (const t of this.casino.tables) {
      const g = ctx.createRadialGradient(t.x, t.y, 20, t.x, t.y, 260);
      g.addColorStop(0, "rgba(255,214,150,0.14)");
      g.addColorStop(1, "rgba(255,214,150,0)");
      ctx.fillStyle = g;
      ctx.fillRect(t.x - 260, t.y - 260, 520, 520);
    }
  }

  private drawFeatures(f: Frame): void {
    const { ctx } = f;
    for (const feat of this.casino.features) {
      const r = feat.rect;
      switch (feat.kind) {
        case "slots": {
          fillRound(ctx, r, 6, "#1b1f2b", "#2c3242");
          const cols = Math.max(1, Math.floor(r.w / 44));
          const rows = Math.max(1, Math.floor(r.h / 52));
          for (let i = 0; i < cols; i++) {
            for (let j = 0; j < rows; j++) {
              const sx = r.x + 8 + i * 44;
              const sy = r.y + 8 + j * 52;
              fillRound(ctx, { x: sx, y: sy, w: 32, h: 40 }, 4, "#262c3a");
              ctx.fillStyle = `hsl(${(i * 47 + j * 91) % 360} 70% 55% / 0.75)`;
              ctx.fillRect(sx + 5, sy + 6, 22, 14);
            }
          }
          break;
        }
        case "bar": {
          fillRound(ctx, r, 8, "#3a2418", "#57351f", 2);
          fillRound(ctx, { x: r.x + 10, y: r.y + 10, w: r.w - 20, h: 26 }, 4, "#191f26");
          for (let i = 0; i < 10; i++) {
            ctx.fillStyle = `hsl(${(i * 33) % 360} 55% 45%)`;
            ctx.fillRect(r.x + 20 + i * 26, r.y + 14, 8, 18);
          }
          label(ctx, "BAR", r.x + r.w / 2, r.y + r.h - 16);
          break;
        }
        case "cashier": {
          fillRound(ctx, r, 8, "#232a33", "#3a4553", 2);
          for (let i = 0; i < 9; i++) {
            ctx.fillStyle = "#4a5666";
            ctx.fillRect(r.x + 16 + i * 28, r.y + 12, 4, r.h - 24);
          }
          label(ctx, "CASHIER", r.x + r.w / 2, r.y + r.h - 14);
          break;
        }
        case "restroom": {
          fillRound(ctx, r, 8, "#1e2630", "#33404e", 2);
          label(ctx, "RESTROOM", r.x + r.w / 2, r.y + r.h / 2);
          break;
        }
        case "training": {
          fillRound(ctx, r, 8, "#1c2c26", "#2f5a49", 2);
          label(ctx, "BACK ROOM", r.x + r.w / 2, r.y + r.h / 2);
          break;
        }
        case "exit": {
          fillRound(ctx, r, 4, "#2c2118", "#6b5533", 2);
          label(ctx, "EXIT", r.x + r.w / 2, r.y + r.h / 2, C.gold);
          break;
        }
        case "pit": {
          fillRound(ctx, r, 6, "#2a2018", "#4a3a28", 2);
          label(ctx, "PIT", r.x + r.w / 2, r.y + r.h / 2, "#c9a06a");
          break;
        }
        default:
          break;
      }
    }
  }

  private drawTable(f: Frame, t: CasinoTable): void {
    const { ctx } = f;
    ctx.save();
    // Felt.
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    ctx.beginPath();
    ctx.ellipse(t.x, t.y, t.rw / 2, t.rh / 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = C.felt;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.ellipse(t.x, t.y, t.rw / 2, t.rh / 2, 0, 0, Math.PI * 2);
    ctx.strokeStyle = "#7a5a2e";
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(t.x, t.y + 4, t.rw / 2 - 22, t.rh / 2 - 18, 0, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.13)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Dealer.
    const dy = t.y - t.rh / 2 - 20;
    ctx.beginPath();
    ctx.arc(t.x, dy, 12, 0, Math.PI * 2);
    ctx.fillStyle = "#dfe6ee";
    ctx.fill();
    ctx.fillStyle = "#1b2129";
    ctx.fillRect(t.x - 9, dy + 8, 18, 10);

    // Seats with whoever is in them.
    const seats = t.sim.seats;
    seats.forEach((s, i) => {
      const a = Math.PI * (0.15 + (0.7 * (i + 0.5)) / seats.length);
      const sx = t.x - Math.cos(a) * (t.rw / 2 + 16);
      const sy = t.y + Math.sin(a) * (t.rh / 2 + 22);
      ctx.beginPath();
      ctx.arc(sx, sy, 11, 0, Math.PI * 2);
      if (s.kind === "npc") {
        ctx.fillStyle = `hsl(${(i * 67 + t.x) % 360} 45% 55%)`;
      } else if (s.kind === "player") {
        ctx.fillStyle = C.gold;
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.13)";
      }
      ctx.fill();
    });

    // Placard.
    const ls = `${money(t.rules.minBet)}-${money(t.rules.maxBet)}`;
    fillRound(ctx, { x: t.x - 44, y: t.y - 12, w: 88, h: 24 }, 5, "rgba(8,14,10,0.55)");
    text(ctx, ls, t.x, t.y + 1, {
      size: 13,
      color: "#dfe6ee",
      align: "center",
      baseline: "middle",
      weight: "700",
    });
    text(ctx, t.rules.dealerHitsSoft17 ? "H17" : "S17", t.x, t.y + 22, {
      size: 10,
      color: "rgba(223,230,238,0.6)",
      align: "center",
      baseline: "middle",
    });
  }

  private drawCrowd(f: Frame): void {
    const { ctx } = f;
    for (const n of this.casino.npcs) {
      const bobY = Math.sin(n.bob) * 1.5;
      ctx.beginPath();
      ctx.ellipse(n.x, n.y + 12, 11, 5, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(n.x, n.y + bobY, 11, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${n.hue} 40% 52%)`;
      ctx.fill();
    }
    // Pit boss: dark suit, always facing you.
    const pb = this.casino.pitBoss;
    ctx.beginPath();
    ctx.ellipse(pb.x, pb.y + 13, 12, 5, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pb.x, pb.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = "#20262f";
    ctx.fill();
    ctx.strokeStyle = "#59677a";
    ctx.lineWidth = 2;
    ctx.stroke();
    text(ctx, "pit boss", pb.x, pb.y - 20, {
      size: 10,
      color: "rgba(200,212,225,0.6)",
      align: "center",
    });
  }

  private drawPlayer(f: Frame): void {
    const { ctx } = f;
    const p = this.player;
    const bob = Math.sin(p.step) * 1.6;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + 13, 12, 5, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y + bob, PLAYER_R, 0, Math.PI * 2);
    ctx.fillStyle = C.gold;
    ctx.fill();
    ctx.strokeStyle = "#8a6b1f";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x + p.face * 6, p.y + bob - 2, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#3b2c07";
    ctx.fill();
  }

  // ------------------------------------------------------------------ HUD

  private drawHud(f: Frame): void {
    const { ctx } = f;
    const session = this.game.session;

    fillRound(ctx, { x: 16, y: 14, w: 330, h: 66 }, 10, "rgba(12,17,22,0.86)", C.line);
    text(ctx, "BANKROLL", 32, 36, { size: 10, color: C.faint, weight: "700" });
    text(ctx, money(session.bankroll), 32, 62, { size: 26, weight: "700", color: C.gold });
    const net = session.bankroll - session.startingBankroll;
    text(ctx, `${net >= 0 ? "+" : "-"}${money(Math.abs(net))}`, 200, 62, {
      size: 16,
      weight: "700",
      color: net >= 0 ? C.green : C.red,
    });
    text(ctx, clockString(this.clock), 330, 36, {
      size: 14,
      color: C.dim,
      align: "right",
      weight: "600",
    });

    // Heat: presented as body language plus a coarse meter.
    const s = session.surveillance;
    fillRound(ctx, { x: VW - 366, y: 14, w: 350, h: 66 }, 10, "rgba(12,17,22,0.86)", C.line);
    text(ctx, "THE PIT", VW - 350, 36, { size: 10, color: C.faint, weight: "700" });
    bar(f, { x: VW - 350, y: 44, w: 318, h: 12 }, s.suspicion / 100, heatColor(s.suspicion));
    text(ctx, s.tellText(), VW - 350, 74, { size: 12, color: C.dim, maxWidth: 330 });

    if (this.noteT > 0) {
      const w = Math.min(700, ctx.measureText(this.note).width + 260);
      fillRound(ctx, { x: VW / 2 - w / 2, y: 96, w, h: 34 }, 8, "rgba(12,17,22,0.9)", C.line);
      text(ctx, this.note, VW / 2, 113, { size: 14, color: C.text, align: "center", baseline: "middle" });
    }

    if (this.game.session.surveillance.backoffPending) {
      const a = 0.25 + Math.sin(f.time * 6) * 0.12;
      ctx.fillStyle = `rgba(224,85,75,${a})`;
      ctx.fillRect(0, 0, VW, VH);
      text(ctx, "Two suits are walking toward you. Get to the exit.", VW / 2, VH - 150, {
        size: 20,
        weight: "700",
        align: "center",
        color: "#ffd9d5",
      });
    }
  }

  private handleInteraction(f: Frame): void {
    const p = this.prompt;
    if (!p) return;
    const { ctx } = f;
    const sx = VW / 2 + (p.x - this.camX);
    const sy = VH / 2 + (p.y - this.camY);
    ctx.save();
    ctx.globalAlpha = 0.85;
    roundRect(ctx, sx - 18, sy - 18, 36, 36, 8);
    ctx.strokeStyle = C.gold;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    const lines = this.promptLines(p);
    const w = 440;
    const h = 30 + lines.length * 20;
    const bx = VW / 2 - w / 2;
    const by = VH - h - 96;
    fillRound(ctx, { x: bx, y: by, w, h }, 10, "rgba(12,17,22,0.92)", C.gold);
    lines.forEach((l, i) => {
      text(ctx, l, bx + 18, by + 26 + i * 20, {
        size: i === 0 ? 15 : 13,
        color: i === 0 ? C.text : C.dim,
        weight: i === 0 ? "700" : "500",
      });
    });
    text(ctx, "E", bx + w - 26, by + 26, { size: 15, color: C.gold, weight: "800", align: "right" });

    if (!f.input.consume("e")) return;
    this.activate(p);
  }

  private promptLines(p: Interaction): string[] {
    if (p.kind === "table" && p.table) {
      const t = p.table;
      const free = t.sim.freeSeats().length;
      return [
        `Sit at ${t.rules.name}`,
        rulesSummary(t.rules),
        free > 0 ? `${free} open seat${free === 1 ? "" : "s"}` : "Table is full",
      ];
    }
    switch (p.kind) {
      case "bar":
        return ["Order a drink", "Costs $15 and 15 minutes. Cover play: the pit relaxes a little."];
      case "restroom":
        return ["Take a break", "20 minutes away from the floor. Heat cools, and the shoes move on without you."];
      case "cashier":
        return ["Cashier cage", "Colour up your chips. Cashing out over $10,000 gets your name written down."];
      case "training":
        return ["Back room", "Drills: card tags, running count, deck estimation, strategy and index plays."];
      case "exit":
        return ["Leave for the night", "Bank what you have and end the session."];
      default:
        return [p.label];
    }
  }

  private activate(p: Interaction): void {
    const session = this.game.session;
    switch (p.kind) {
      case "table": {
        const t = p.table!;
        const free = t.sim.freeSeats();
        if (free.length === 0) {
          this.say("No open seats. Try another table.");
          return;
        }
        // Hands you did not watch have moved the count without you.
        t.sim.burnUnseen(Math.floor(t.awaySeconds / 45));
        t.awaySeconds = 0;
        this.game.setScene(new TableScene(this.game, this, t));
        break;
      }
      case "bar": {
        if (session.bankroll < 15) {
          this.say("You cannot even cover a drink.");
          return;
        }
        session.bankroll -= 15;
        session.surveillance.applyCover(9, "ordered a drink");
        this.advanceClock(15);
        this.say("You nurse a drink and look like everyone else. -9 heat.");
        break;
      }
      case "restroom": {
        session.surveillance.applyCover(15, "took a break");
        this.advanceClock(20);
        this.say("Twenty minutes off the floor. The pit's attention drifts. -15 heat.");
        break;
      }
      case "cashier": {
        session.surveillance.applyCover(5, "coloured up");
        this.advanceClock(10);
        if (session.bankroll >= 10000) {
          session.surveillance.recognition = Math.min(100, session.surveillance.recognition + 12);
          this.say("They fill out a currency transaction report. Your name is on file now.");
        } else {
          this.say("You colour up into blacks and purples. -5 heat.");
        }
        break;
      }
      case "training": {
        this.game.setScene(new TrainerScene(this.game, () => this.game.setScene(this)));
        break;
      }
      case "exit": {
        this.game.setScene(new ResultsScene(this.game, "walked"));
        break;
      }
      default:
        break;
    }
  }
}

function heatColor(v: number): string {
  if (v < 22) return C.green;
  if (v < 45) return "#9ecf4a";
  if (v < 70) return C.gold;
  if (v < 92) return C.heat;
  return C.red;
}

function clockString(minutes: number): string {
  const total = Math.floor(20 * 60 + minutes);
  const h = Math.floor(total / 60) % 24;
  const m = Math.floor(total % 60);
  const ampm = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, "0")} ${ampm}`;
}

function label(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color = "#9fb0c2"): void {
  text(ctx, s, x, y, { size: 12, color, align: "center", baseline: "middle", weight: "700" });
}

function makeCarpet(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const c = document.createElement("canvas");
  c.width = 96;
  c.height = 96;
  const g = c.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#3d1a25";
  g.fillRect(0, 0, 96, 96);
  g.strokeStyle = "rgba(226,178,96,0.10)";
  g.lineWidth = 2;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const cx = 24 + i * 48;
      const cy = 24 + j * 48;
      g.beginPath();
      g.moveTo(cx, cy - 16);
      g.lineTo(cx + 16, cy);
      g.lineTo(cx, cy + 16);
      g.lineTo(cx - 16, cy);
      g.closePath();
      g.stroke();
    }
  }
  g.fillStyle = "rgba(120,40,60,0.35)";
  for (let i = 0; i < 40; i++) {
    g.fillRect(Math.random() * 96, Math.random() * 96, 2, 2);
  }
  return ctx.createPattern(c, "repeat");
}
