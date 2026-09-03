import { C, fillRound, text, type Frame } from "../core/ui";
import type { Rect } from "../core/math";

export interface Series {
  label: string;
  color: string;
  /** null leaves a gap rather than drawing through a missing value. */
  values: (number | null)[];
  /** Draw as a filled area under the line. */
  fill?: boolean;
  dashed?: boolean;
}

export interface ChartOpts {
  title?: string;
  min?: number;
  max?: number;
  /** Force zero into range and draw a line on it. */
  zero?: boolean;
  format?: (v: number) => string;
  /** One label per point; only a few are drawn. */
  xLabels?: string[];
  /** Fuller label per point, used only in the hover readout. */
  xTooltips?: string[];
  /** Points worth calling out, by index. */
  markers?: { index: number; color: string }[];
  /** Horizontal reference line, e.g. the back-off threshold. */
  guide?: { at: number; color: string; label: string };
  legend?: boolean;
  empty?: string;
}

const PAD_L = 52;
const PAD_B = 22;
const PAD_T = 30;

interface Plot {
  x: number;
  y: number;
  w: number;
  h: number;
  toX: (i: number) => number;
  toY: (v: number) => number;
  n: number;
}

function frameOf(f: Frame, r: Rect, opts: ChartOpts, n: number, lo: number, hi: number): Plot {
  const plot = {
    x: r.x + PAD_L,
    y: r.y + PAD_T,
    w: r.w - PAD_L - 16,
    h: r.h - PAD_T - PAD_B,
  };
  const span = Math.max(1e-6, hi - lo);
  return {
    ...plot,
    n,
    toX: (i) => (n <= 1 ? plot.x + plot.w / 2 : plot.x + (i / (n - 1)) * plot.w),
    toY: (v) => plot.y + plot.h - ((v - lo) / span) * plot.h,
  };
}

function bounds(series: Series[], opts: ChartOpts): { lo: number; hi: number } {
  const all: number[] = [];
  for (const s of series) for (const v of s.values) if (v !== null && Number.isFinite(v)) all.push(v);
  if (opts.guide) all.push(opts.guide.at);
  if (all.length === 0) return { lo: 0, hi: 1 };
  let lo = opts.min ?? Math.min(...all);
  let hi = opts.max ?? Math.max(...all);
  if (opts.zero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (hi - lo < 1e-6) {
    hi += 1;
    lo -= 1;
  } else {
    const pad = (hi - lo) * 0.12;
    if (opts.max === undefined) hi += pad;
    if (opts.min === undefined) {
      const allPositive = all.every((v) => v >= 0);
      // Don't invent negative headroom for a quantity that cannot go negative.
      lo = allPositive ? Math.max(0, lo - pad) : lo - pad;
    }
  }
  return { lo, hi };
}

function shell(f: Frame, r: Rect, opts: ChartOpts): void {
  fillRound(f.ctx, r, 10, C.panel, C.line);
  if (opts.title) {
    text(f.ctx, opts.title.toUpperCase(), r.x + 16, r.y + 20, {
      size: 9,
      color: C.faint,
      weight: "700",
    });
  }
}

function axes(f: Frame, r: Rect, p: Plot, lo: number, hi: number, opts: ChartOpts): void {
  const { ctx } = f;
  const fmt = opts.format ?? ((v: number) => String(Math.round(v)));
  const ticks = [hi, (hi + lo) / 2, lo];
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  for (const t of ticks) {
    const y = p.toY(t);
    ctx.beginPath();
    ctx.moveTo(p.x, y);
    ctx.lineTo(p.x + p.w, y);
    ctx.stroke();
    text(ctx, fmt(t), p.x - 8, y + 4, { size: 10, color: C.faint, align: "right", mono: true });
  }
  if (opts.zero && lo < 0 && hi > 0) {
    const y = p.toY(0);
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.moveTo(p.x, y);
    ctx.lineTo(p.x + p.w, y);
    ctx.stroke();
  }
  if (opts.guide) {
    const y = p.toY(opts.guide.at);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = opts.guide.color;
    ctx.beginPath();
    ctx.moveTo(p.x, y);
    ctx.lineTo(p.x + p.w, y);
    ctx.stroke();
    ctx.restore();
    text(ctx, opts.guide.label, p.x + p.w, y - 6, {
      size: 10,
      color: opts.guide.color,
      align: "right",
      weight: "700",
    });
  }
  // A first, middle and last x label is enough to orient without clutter.
  if (opts.xLabels && opts.xLabels.length > 0) {
    const picks = p.n <= 2 ? [0, p.n - 1] : [0, Math.floor((p.n - 1) / 2), p.n - 1];
    for (const i of new Set(picks)) {
      const label = opts.xLabels[i];
      if (!label) continue;
      text(ctx, label, p.toX(i), r.y + r.h - 7, {
        size: 10,
        color: C.faint,
        align: i === 0 ? "left" : i === p.n - 1 ? "right" : "center",
      });
    }
  }
}

function legend(f: Frame, r: Rect, series: Series[], startX: number): void {
  let x = startX;
  for (const s of series) {
    if (s.values.every((v) => v === null)) continue;
    f.ctx.fillStyle = s.color;
    f.ctx.fillRect(x, r.y + 15, 10, 3);
    text(f.ctx, s.label, x + 15, r.y + 20, { size: 10, color: C.dim });
    x += 22 + f.ctx.measureText(s.label).width;
  }
}

/** Vertical guide plus a readout for whichever point the mouse is nearest. */
function hover(f: Frame, r: Rect, p: Plot, series: Series[], opts: ChartOpts): void {
  if (f.mx < p.x - 6 || f.mx > p.x + p.w + 6 || f.my < r.y || f.my > r.y + r.h) return;
  const t = p.n <= 1 ? 0 : (f.mx - p.x) / p.w;
  const i = Math.max(0, Math.min(p.n - 1, Math.round(t * (p.n - 1))));
  const { ctx } = f;
  const gx = p.toX(i);
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(gx, p.y);
  ctx.lineTo(gx, p.y + p.h);
  ctx.stroke();
  ctx.restore();

  const fmt = opts.format ?? ((v: number) => String(Math.round(v)));
  const lines: { label: string; value: string; color: string }[] = [];
  for (const s of series) {
    const v = s.values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    ctx.beginPath();
    ctx.arc(gx, p.toY(v), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = s.color;
    ctx.fill();
    lines.push({ label: s.label, value: fmt(v), color: s.color });
  }
  if (lines.length === 0) return;

  const head = opts.xTooltips?.[i] ?? opts.xLabels?.[i] ?? `#${i + 1}`;
  ctx.font = '700 10px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
  const w = Math.max(132, Math.min(280, ctx.measureText(head).width + 18));
  const h = 22 + lines.length * 15;
  const bx = Math.min(Math.max(r.x + 6, gx + 12), r.x + r.w - w - 6);
  const by = Math.max(r.y + 6, Math.min(f.my - 10, r.y + r.h - h - 6));
  fillRound(ctx, { x: bx, y: by, w, h }, 6, "rgba(6,10,14,0.95)", C.line);
  text(ctx, head, bx + 8, by + 15, { size: 10, color: C.faint, weight: "700" });
  lines.forEach((l, k) => {
    const y = by + 30 + k * 15;
    ctx.fillStyle = l.color;
    ctx.fillRect(bx + 8, y - 4, 8, 3);
    text(ctx, l.label, bx + 21, y, { size: 10, color: C.dim });
    text(ctx, l.value, bx + w - 8, y, { size: 10, color: C.text, align: "right", mono: true });
  });
}

export function lineChart(f: Frame, r: Rect, series: Series[], opts: ChartOpts = {}): void {
  shell(f, r, opts);
  const n = Math.max(...series.map((s) => s.values.length), 0);
  if (n === 0) {
    text(f.ctx, opts.empty ?? "Nothing here yet.", r.x + r.w / 2, r.y + r.h / 2, {
      size: 14,
      color: C.faint,
      align: "center",
      baseline: "middle",
    });
    return;
  }
  const { lo, hi } = bounds(series, opts);
  const p = frameOf(f, r, opts, n, lo, hi);
  axes(f, r, p, lo, hi, opts);
  if (opts.legend !== false && series.length > 1) {
    // Start the legend clear of the title, however long it is.
    f.ctx.font = '700 9px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
    const titleW = opts.title ? f.ctx.measureText(opts.title.toUpperCase()).width : 0;
    legend(f, r, series, r.x + 16 + titleW + 22);
  }

  const { ctx } = f;
  for (const s of series) {
    if (s.fill) {
      ctx.beginPath();
      let started = false;
      s.values.forEach((v, i) => {
        if (v === null) return;
        const x = p.toX(i);
        const y = p.toY(v);
        if (!started) {
          ctx.moveTo(x, p.y + p.h);
          ctx.lineTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      });
      if (started) {
        ctx.lineTo(p.toX(n - 1), p.y + p.h);
        ctx.closePath();
        ctx.globalAlpha = 0.14;
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.save();
    if (s.dashed) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      const x = p.toX(i);
      const y = p.toY(v);
      if (!pen) {
        ctx.moveTo(x, y);
        pen = true;
      } else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // A single point would be invisible as a line.
    if (n === 1 && s.values[0] !== null) {
      ctx.beginPath();
      ctx.arc(p.toX(0), p.toY(s.values[0]!), 4, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
    }
  }

  for (const m of opts.markers ?? []) {
    const v = series[0]?.values[m.index];
    if (v === null || v === undefined) continue;
    ctx.beginPath();
    ctx.arc(p.toX(m.index), p.toY(v), 4.5, 0, Math.PI * 2);
    ctx.fillStyle = m.color;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  hover(f, r, p, series, opts);
}

export function barChart(f: Frame, r: Rect, values: number[], opts: ChartOpts = {}): void {
  shell(f, r, opts);
  if (values.length === 0) {
    text(f.ctx, opts.empty ?? "Nothing here yet.", r.x + r.w / 2, r.y + r.h / 2, {
      size: 14,
      color: C.faint,
      align: "center",
      baseline: "middle",
    });
    return;
  }
  const series: Series[] = [{ label: opts.title ?? "", color: C.blue, values }];
  const { lo, hi } = bounds(series, { ...opts, zero: true });
  const p = frameOf(f, r, opts, values.length, lo, hi);
  axes(f, r, p, lo, hi, { ...opts, zero: true });

  const { ctx } = f;
  const slot = p.w / values.length;
  const bw = Math.max(1.5, Math.min(26, slot - 3));
  const zeroY = p.toY(0);
  values.forEach((v, i) => {
    const cx = p.x + slot * (i + 0.5);
    const y = p.toY(v);
    const top = Math.min(y, zeroY);
    const h = Math.max(1.5, Math.abs(y - zeroY));
    ctx.fillStyle = v >= 0 ? C.green : C.red;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(cx - bw / 2, top, bw, h);
    ctx.globalAlpha = 1;
  });

  hover(f, r, p, series, opts);
}
