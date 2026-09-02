/**
 * All scenes draw into a fixed 1280x720 logical space which is scaled and
 * letterboxed into the real canvas. Keeps layout maths simple and identical on
 * every display.
 */
export const VW = 1280;
export const VH = 720;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  scale = 1;
  offsetX = 0;
  offsetY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas not supported");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    const s = Math.min(cssW / VW, cssH / VH);
    this.scale = s * dpr;
    this.offsetX = ((cssW - VW * s) / 2) * dpr;
    this.offsetY = ((cssH - VH * s) / 2) * dpr;
    this.cssScale = s;
    this.cssOffsetX = (cssW - VW * s) / 2;
    this.cssOffsetY = (cssH - VH * s) / 2;
  }

  private cssScale = 1;
  private cssOffsetX = 0;
  private cssOffsetY = 0;

  begin(): void {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VW, VH);
    ctx.clip();
  }

  end(): void {
    this.ctx.restore();
  }

  /** Convert canvas-relative CSS pixels to logical space. */
  toLogicalX(cssX: number): number {
    return (cssX - this.cssOffsetX) / this.cssScale;
  }

  toLogicalY(cssY: number): number {
    return (cssY - this.cssOffsetY) / this.cssScale;
  }
}
