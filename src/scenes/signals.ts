import { C, button, fillRound, text, type Frame } from "../core/ui";
import { VH, VW } from "../core/renderer";
import { signed } from "../core/math";
import type { NetClient } from "../net/client";
import { SIGNAL_TEXT, type SignalKind } from "../net/protocol";
import { attentionShort } from "../heat/surveillance";
import type { Session } from "../state/session";

const WHEEL: { kind: SignalKind; label: string; accent: string }[] = [
  { kind: "hot", label: "Shoe is hot", accent: C.green },
  { kind: "cold", label: "Shoe is cold", accent: C.blue },
  { kind: "shuffle", label: "Cut card close", accent: C.gold },
  { kind: "heat", label: "Heat is on me", accent: C.heat },
  { kind: "joinme", label: "Open seat here", accent: C.purple },
  { kind: "leaving", label: "Colouring up", accent: C.dim },
];

/**
 * Team callouts. A count call is typed in rather than read off the table, so
 * what you pass your partner is what you actually believe -- mistakes included.
 */
export class SignalPanel {
  wheelOpen = false;
  calling = false;
  callValue = 0;

  /** Handle the keys and draw whatever is open. Returns true if it ate input. */
  frame(f: Frame, net: NetClient, session: Session, suggestedCount: number | null): boolean {
    if (this.calling) {
      this.drawCaller(f, net);
      return true;
    }
    if (this.wheelOpen) {
      this.drawWheel(f, net);
      return true;
    }
    if (f.input.consume("c")) {
      this.calling = true;
      this.callValue =
        session.assist === "full" && suggestedCount !== null
          ? Math.round(suggestedCount)
          : session.playerRunning;
      return true;
    }
    if (f.input.consume("q")) {
      this.wheelOpen = true;
      return true;
    }
    return false;
  }

  private drawWheel(f: Frame, net: NetClient): void {
    const { ctx } = f;
    const w = 300;
    const h = 44 + WHEEL.length * 42;
    const r = { x: VW / 2 - w / 2, y: VH / 2 - h / 2, w, h };
    fillRound(ctx, { x: 0, y: 0, w: VW, h: VH }, 0, "rgba(4,7,10,0.55)");
    fillRound(ctx, r, 12, C.panel, C.blue, 2);
    text(ctx, "CALL SOMETHING OUT", r.x + w / 2, r.y + 28, {
      size: 11,
      color: C.faint,
      align: "center",
      weight: "700",
    });
    WHEEL.forEach((s, i) => {
      const br = { x: r.x + 16, y: r.y + 44 + i * 42, w: w - 32, h: 36 };
      if (button(f, br, s.label, { small: true, accent: s.accent, hotkey: String(i + 1) }) ||
        f.input.consume(String(i + 1))) {
        net.signal(s.kind);
        this.wheelOpen = false;
      }
    });
    if (f.input.consume("Escape", "q")) this.wheelOpen = false;
  }

  private drawCaller(f: Frame, net: NetClient): void {
    const { ctx } = f;
    const r = { x: VW / 2 - 220, y: VH / 2 - 110, w: 440, h: 220 };
    fillRound(ctx, { x: 0, y: 0, w: VW, h: VH }, 0, "rgba(4,7,10,0.55)");
    fillRound(ctx, r, 12, C.panel, C.gold, 2);
    text(ctx, "CALL THE COUNT", r.x + r.w / 2, r.y + 32, {
      size: 11,
      color: C.faint,
      align: "center",
      weight: "700",
    });
    text(ctx, "What do you make it?", r.x + r.w / 2, r.y + 62, {
      size: 17,
      align: "center",
      weight: "600",
    });
    fillRound(ctx, { x: r.x + r.w / 2 - 80, y: r.y + 78, w: 160, h: 62 }, 10, "#0a0f14", C.line);
    text(ctx, signed(this.callValue), r.x + r.w / 2, r.y + 112, {
      size: 34,
      align: "center",
      weight: "800",
      mono: true,
    });
    if (button(f, { x: r.x + r.w / 2 - 154, y: r.y + 86, w: 60, h: 44 }, "−", { accent: C.red }))
      this.callValue--;
    if (button(f, { x: r.x + r.w / 2 + 94, y: r.y + 86, w: 60, h: 44 }, "+", { accent: C.green }))
      this.callValue++;
    if (f.input.consume("arrowup", "+", "=")) this.callValue++;
    if (f.input.consume("arrowdown", "-")) this.callValue--;
    if (
      button(f, { x: r.x + r.w / 2 - 80, y: r.y + 156, w: 160, h: 44 }, "Call it", {
        accent: C.gold,
        hotkey: "ENTER",
      }) ||
      f.input.consume("Enter")
    ) {
      const view = net.room?.tables.find((t) =>
        t.seats.some((s) => s.playerId === net.youId),
      );
      const decks = view?.decksRemaining ?? 6;
      net.signal("count", this.callValue, this.callValue / Math.max(0.25, decks));
      this.calling = false;
    }
    if (f.input.consume("Escape")) this.calling = false;
  }
}

/** Recent callouts plus where each teammate stands with the pit. */
export function drawTeamPanel(f: Frame, net: NetClient, x: number, y: number, w: number): void {
  const { ctx } = f;
  const mates = net.teammates;
  const signals = net.room?.signals ?? [];
  const rows = mates.length + Math.min(3, signals.length);
  const h = 34 + rows * 22;
  fillRound(ctx, { x, y, w, h }, 10, "rgba(10,15,20,0.86)", C.line);
  text(ctx, `TEAM  ·  ${net.code}`, x + 14, y + 20, { size: 10, color: C.faint, weight: "700" });

  let row = 0;
  for (const p of mates) {
    const ry = y + 38 + row * 22;
    ctx.beginPath();
    ctx.arc(x + 20, ry - 4, 6, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${p.hue} 70% 55%)`;
    ctx.fill();
    text(ctx, p.name, x + 34, ry, { size: 12, color: p.online ? C.text : C.faint, weight: "600" });
    text(ctx, attentionShort(p.attention), x + w - 14, ry, {
      size: 11,
      align: "right",
      color: heatTint(p.suspicion),
    });
    row++;
  }
  for (const s of signals.slice(0, 3)) {
    const ry = y + 38 + row * 22;
    const body =
      s.kind === "count"
        ? `${SIGNAL_TEXT.count} ${signed(s.running ?? 0)}${
            s.trueCount !== undefined ? ` (${signed(s.trueCount, 1)} true)` : ""
          }`
        : SIGNAL_TEXT[s.kind];
    text(ctx, `${s.fromName}: ${body}`, x + 14, ry, {
      size: 11,
      color: C.dim,
      maxWidth: w - 28,
    });
    row++;
  }
  if (rows === 0) {
    text(ctx, "Nobody else here yet.", x + 14, y + 40, { size: 12, color: C.faint });
  }
}

export function heatTint(v: number): string {
  if (v < 22) return C.green;
  if (v < 45) return "#9ecf4a";
  if (v < 70) return C.gold;
  if (v < 92) return C.heat;
  return C.red;
}
