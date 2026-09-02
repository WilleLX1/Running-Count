import type { Input } from "./input";
import { pointInRect, type Rect } from "./math";

/** Per-frame drawing/input context handed to every scene. */
export interface Frame {
  ctx: CanvasRenderingContext2D;
  input: Input;
  /** Mouse position in logical (1280x720) space. */
  mx: number;
  my: number;
  mouseDown: boolean;
  clicked: boolean;
  /** Seconds since boot. */
  time: number;
  dt: number;
}

export const C = {
  bg: "#0c1116",
  panel: "#151c24",
  panelHi: "#1d2732",
  line: "#2b3947",
  text: "#e7edf3",
  dim: "#8fa3b5",
  faint: "#5c6f81",
  gold: "#f0c14b",
  green: "#3fbf6f",
  red: "#e0554b",
  blue: "#5aa9e6",
  purple: "#a98bd6",
  felt: "#0f5f3f",
  feltDark: "#0a4530",
  carpet: "#4a1f2c",
  heat: "#ff7a45",
};

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function fillRound(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  radius: number,
  fill: string,
  stroke?: string,
  lineWidth = 1,
): void {
  roundRect(ctx, r.x, r.y, r.w, r.h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

export interface TextOpts {
  size?: number;
  color?: string;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  weight?: string;
  mono?: boolean;
  maxWidth?: number;
}

export function text(
  ctx: CanvasRenderingContext2D,
  str: string,
  x: number,
  y: number,
  o: TextOpts = {},
): void {
  const size = o.size ?? 16;
  const family = o.mono
    ? 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace'
    : 'ui-sans-serif, system-ui, "Segoe UI", sans-serif';
  ctx.font = `${o.weight ?? "500"} ${size}px ${family}`;
  ctx.fillStyle = o.color ?? C.text;
  ctx.textAlign = o.align ?? "left";
  ctx.textBaseline = o.baseline ?? "alphabetic";
  if (o.maxWidth) ctx.fillText(str, x, y, o.maxWidth);
  else ctx.fillText(str, x, y);
}

export function panel(f: Frame, r: Rect, title?: string): void {
  fillRound(f.ctx, r, 10, C.panel, C.line, 1);
  if (title) {
    text(f.ctx, title.toUpperCase(), r.x + 14, r.y + 22, {
      size: 11,
      color: C.faint,
      weight: "700",
    });
  }
}

export interface ButtonOpts {
  enabled?: boolean;
  accent?: string;
  hotkey?: string;
  small?: boolean;
  active?: boolean;
}

export function button(f: Frame, r: Rect, label: string, o: ButtonOpts = {}): boolean {
  const enabled = o.enabled !== false;
  const hover = enabled && pointInRect(f.mx, f.my, r);
  const accent = o.accent ?? C.blue;
  const bg = !enabled ? "#161d25" : o.active ? accent : hover ? C.panelHi : C.panel;
  const border = !enabled ? "#222c36" : o.active ? accent : hover ? accent : C.line;
  fillRound(f.ctx, r, 8, bg, border, hover || o.active ? 2 : 1);
  const fg = !enabled ? "#4a5763" : o.active ? "#0b1015" : hover ? C.text : C.text;
  text(f.ctx, label, r.x + r.w / 2, r.y + r.h / 2 + 1, {
    size: o.small ? 13 : 15,
    color: fg,
    align: "center",
    baseline: "middle",
    weight: "600",
  });
  if (o.hotkey) {
    text(f.ctx, o.hotkey, r.x + r.w - 7, r.y + 12, {
      size: 10,
      color: enabled ? C.faint : "#3a4550",
      align: "right",
      baseline: "middle",
      weight: "700",
    });
  }
  return enabled && hover && f.clicked;
}

export function bar(
  f: Frame,
  r: Rect,
  fraction: number,
  fill: string,
  bg = "#0a0f14",
): void {
  fillRound(f.ctx, r, r.h / 2, bg, C.line, 1);
  const w = Math.max(0, Math.min(1, fraction)) * (r.w - 4);
  if (w > 1) {
    fillRound(f.ctx, { x: r.x + 2, y: r.y + 2, w, h: r.h - 4 }, (r.h - 4) / 2, fill);
  }
}

export function chipStack(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  amount: number,
  unit: number,
): void {
  if (amount <= 0) return;
  const count = Math.max(1, Math.min(9, Math.round(amount / Math.max(1, unit))));
  for (let i = 0; i < count; i++) {
    const cy = y - i * 4;
    ctx.beginPath();
    ctx.ellipse(x, cy, 13, 5.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = chipColor(amount, i);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

export function chipColor(amount: number, i = 0): string {
  const palette = ["#e8e8e8", "#e0554b", "#3fbf6f", "#2f6fd0", "#1a1a1a", "#f0c14b"];
  if (amount >= 1000) return palette[5];
  if (amount >= 500) return palette[4];
  if (amount >= 100) return palette[3];
  if (amount >= 50) return palette[2];
  if (amount >= 25) return palette[1];
  return palette[i % 2 === 0 ? 0 : 1];
}

export function shadowed(ctx: CanvasRenderingContext2D, blur: number, fn: () => void): void {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = blur;
  ctx.shadowOffsetY = blur * 0.3;
  fn();
  ctx.restore();
}

export function vignette(ctx: CanvasRenderingContext2D, w: number, h: number, strength = 0.5): void {
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}
