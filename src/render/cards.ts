import { rankLabel, suitIsRed, suitSymbol, type Card } from "../blackjack/cards";
import { roundRect } from "../core/ui";

export const CARD_W = 62;
export const CARD_H = 88;

export function drawCard(
  ctx: CanvasRenderingContext2D,
  card: Card | null,
  x: number,
  y: number,
  w = CARD_W,
  h = CARD_H,
  opts: { faceDown?: boolean; dim?: boolean; highlight?: string } = {},
): void {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  roundRect(ctx, x, y, w, h, 6);
  ctx.fillStyle = opts.faceDown || !card ? "#8e2740" : "#f7f4ee";
  ctx.fill();
  ctx.restore();

  if (opts.highlight) {
    roundRect(ctx, x - 1.5, y - 1.5, w + 3, h + 3, 7);
    ctx.strokeStyle = opts.highlight;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  if (opts.faceDown || !card) {
    // Back pattern.
    ctx.save();
    roundRect(ctx, x + 5, y + 5, w - 10, h - 10, 4);
    ctx.clip();
    ctx.fillStyle = "#6d1c31";
    ctx.fillRect(x + 5, y + 5, w - 10, h - 10);
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    for (let i = -h; i < w; i += 7) {
      ctx.beginPath();
      ctx.moveTo(x + i, y + h);
      ctx.lineTo(x + i + h, y);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  const red = suitIsRed(card.suit);
  const color = red ? "#c0303a" : "#191c22";
  const label = rankLabel(card.rank);
  const sym = suitSymbol(card.suit);
  const scale = w / CARD_W;

  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = `700 ${Math.round(18 * scale)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(label, x + 6 * scale, y + 5 * scale);
  ctx.font = `${Math.round(14 * scale)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(sym, x + 6 * scale, y + 24 * scale);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(30 * scale)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.globalAlpha = 0.9;
  ctx.fillText(sym, x + w / 2, y + h / 2 + 2 * scale);
  ctx.globalAlpha = 1;

  ctx.save();
  ctx.translate(x + w - 6 * scale, y + h - 5 * scale);
  ctx.rotate(Math.PI);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = `700 ${Math.round(18 * scale)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(label, 0, 0);
  ctx.restore();

  if (opts.dim) {
    roundRect(ctx, x, y, w, h, 6);
    ctx.fillStyle = "rgba(6,10,14,0.45)";
    ctx.fill();
  }
}

/** Fan of cards for a hand; returns the width consumed. */
export function drawHand(
  ctx: CanvasRenderingContext2D,
  cards: Card[],
  x: number,
  y: number,
  opts: {
    scale?: number;
    hideIndex?: number;
    highlight?: string;
    dim?: boolean;
    overlap?: number;
  } = {},
): number {
  const s = opts.scale ?? 1;
  const w = CARD_W * s;
  const h = CARD_H * s;
  const step = opts.overlap ?? w * 0.42;
  cards.forEach((c, i) => {
    drawCard(ctx, c, x + i * step, y + (i % 2) * 1.5, w, h, {
      faceDown: opts.hideIndex === i,
      highlight: opts.highlight,
      dim: opts.dim,
    });
  });
  return Math.max(w, (cards.length - 1) * step + w);
}
