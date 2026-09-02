import type { Game, Scene } from "../game";
import { C, button, fillRound, panel, text, vignette, type Frame } from "../core/ui";
import { VH, VW } from "../core/renderer";
import { ASSIST_BLURB, ASSIST_LABEL, type AssistLevel } from "../state/session";
import { money } from "../core/math";
import { FloorScene } from "./floor";
import { TrainerScene } from "./trainer";
import { PrimerScene } from "./primer";

const STAKES: { label: string; bankroll: number; unit: number }[] = [
  { label: "Tourist", bankroll: 1000, unit: 10 },
  { label: "Grinder", bankroll: 2500, unit: 25 },
  { label: "Backed player", bankroll: 10000, unit: 100 },
];

export class MenuScene implements Scene {
  private stake = 1;

  constructor(private game: Game) {}

  frame(f: Frame): void {
    const { ctx } = f;
    const g = ctx.createLinearGradient(0, 0, 0, VH);
    g.addColorStop(0, "#10161d");
    g.addColorStop(1, "#080b0f");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);

    // Felt sweep behind the title.
    ctx.save();
    ctx.globalAlpha = 0.5;
    const felt = ctx.createRadialGradient(VW / 2, 130, 40, VW / 2, 130, 620);
    felt.addColorStop(0, "#12613f");
    felt.addColorStop(1, "rgba(8,12,16,0)");
    ctx.fillStyle = felt;
    ctx.fillRect(0, 0, VW, 420);
    ctx.restore();

    text(ctx, "RUNNING COUNT", VW / 2, 118, {
      size: 62,
      weight: "800",
      align: "center",
      color: C.text,
    });
    text(ctx, "learn to count cards, then try to get away with it", VW / 2, 152, {
      size: 17,
      align: "center",
      color: C.dim,
    });

    const session = this.game.session;

    // ---- difficulty -------------------------------------------------
    const left = { x: 120, y: 210, w: 520, h: 300 };
    panel(f, left, "How much help do you want");
    const levels: AssistLevel[] = ["full", "partial", "none"];
    levels.forEach((lv, i) => {
      const r = { x: left.x + 16, y: left.y + 44 + i * 52, w: 200, h: 42 };
      if (button(f, r, ASSIST_LABEL[lv], { active: session.assist === lv, accent: C.gold })) {
        session.assist = lv;
        session.save();
      }
    });
    const blurbY = left.y + 48;
    wrapText(ctx, ASSIST_BLURB[session.assist], left.x + 236, blurbY, 268, 18, {
      size: 13,
      color: C.dim,
    });

    const devR = { x: left.x + 16, y: left.y + 212, w: 300, h: 38 };
    if (
      button(f, devR, `Index plays (Illustrious 18): ${session.useDeviations ? "ON" : "OFF"}`, {
        small: true,
        accent: C.purple,
        active: session.useDeviations,
      })
    ) {
      session.useDeviations = !session.useDeviations;
      session.save();
    }
    text(
      ctx,
      "Deviations earn more and look more suspicious.",
      left.x + 16,
      left.y + 272,
      { size: 12, color: C.faint },
    );

    // ---- stakes -----------------------------------------------------
    const right = { x: 664, y: 210, w: 496, h: 300 };
    panel(f, right, "Bankroll");
    STAKES.forEach((s, i) => {
      const r = { x: right.x + 16, y: right.y + 44 + i * 52, w: 464, h: 42 };
      const active = this.stake === i;
      if (
        button(f, r, `${s.label}  ·  ${money(s.bankroll)} bankroll  ·  ${money(s.unit)} unit`, {
          active,
          accent: C.green,
        })
      ) {
        this.stake = i;
      }
    });
    text(
      ctx,
      "Your unit is the yardstick the pit uses. Spread too far above it and you get noticed.",
      right.x + 16,
      right.y + 216,
      { size: 12, color: C.faint },
    );
    text(
      ctx,
      `Career best bankroll: ${money(session.best.bankroll)}   ·   Sessions: ${session.best.sessions}`,
      right.x + 16,
      right.y + 244,
      { size: 12, color: C.faint },
    );

    // ---- actions ----------------------------------------------------
    const playR = { x: 120, y: 552, w: 520, h: 62 };
    if (button(f, playR, "Walk into the casino", { accent: C.green, hotkey: "ENTER" }) ||
      f.input.consume("Enter")) {
      const s = STAKES[this.stake];
      session.reset(s.bankroll, s.unit);
      session.best.sessions++;
      session.save();
      const floor = new FloorScene(this.game);
      this.game.setScene(floor);
      return;
    }
    const trainR = { x: 664, y: 552, w: 240, h: 62 };
    if (button(f, trainR, "Training room", { accent: C.blue, hotkey: "T" }) || f.input.consume("t")) {
      this.game.setScene(new TrainerScene(this.game, () => this.game.setScene(new MenuScene(this.game))));
      return;
    }
    const howR = { x: 920, y: 552, w: 240, h: 62 };
    if (button(f, howR, "How counting works", { accent: C.purple, hotkey: "H" }) || f.input.consume("h")) {
      this.game.setScene(new PrimerScene(this.game, () => this.game.setScene(new MenuScene(this.game))));
      return;
    }

    fillRound(f.ctx, { x: 120, y: 640, w: 1040, h: 40 }, 8, "rgba(20,28,36,0.6)", C.line);
    text(
      ctx,
      "WASD / arrows to walk · E to interact · this is a simulation, not gambling advice",
      VW / 2,
      661,
      { size: 13, color: C.faint, align: "center", baseline: "middle" },
    );

    vignette(ctx, VW, VH, 0.45);
  }
}

export function wrapText(
  ctx: CanvasRenderingContext2D,
  str: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  opts: { size?: number; color?: string; weight?: string } = {},
): number {
  const size = opts.size ?? 14;
  ctx.font = `${opts.weight ?? "500"} ${size}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = opts.color ?? C.text;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const words = str.split(/\s+/);
  let line = "";
  let cy = y;
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, cy);
      line = w;
      cy += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) {
    ctx.fillText(line, x, cy);
    cy += lineHeight;
  }
  return cy - y;
}
