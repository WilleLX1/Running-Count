import { Input } from "./core/input";
import { Renderer, VH, VW } from "./core/renderer";
import { C, fillRound, text, type Frame } from "./core/ui";
import { Game } from "./game";
import { MenuScene } from "./scenes/menu";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const input = new Input(canvas);
const game = new Game();
game.session.load();
game.history.load();
game.setScene(new MenuScene(game));

if (import.meta.env.DEV) {
  // Handy for poking at state from the console during development, and for
  // driving frames by hand when rAF is throttled (headless previews).
  const w = window as unknown as { game: Game; tick: (frames?: number, dt?: number) => void };
  w.game = game;
  w.tick = (frames = 1, dt = 1 / 60) => {
    for (let i = 0; i < frames; i++) step(dt);
  };
}

let last = performance.now();
let time = 0;

function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  step(dt);
  requestAnimationFrame(loop);
}

function step(dt: number): void {
  time += dt;

  const f: Frame = {
    ctx: renderer.ctx,
    input,
    mx: renderer.toLogicalX(input.mouseX),
    my: renderer.toLogicalY(input.mouseY),
    mouseDown: input.mouseDown,
    clicked: input.mouseClicked,
    time,
    dt,
  };

  renderer.begin();
  try {
    game.scene?.frame(f);
    game.tickToasts(dt);
    drawToasts(f);
  } catch (err) {
    console.error(err);
    drawCrash(f, err);
  }
  renderer.end();
  input.endFrame();
}

function drawToasts(f: Frame): void {
  game.toasts.forEach((t, i) => {
    const alpha = Math.min(1, t.t / 0.8);
    const w = 520;
    const x = VW / 2 - w / 2;
    const y = 90 + i * 40;
    f.ctx.globalAlpha = alpha;
    fillRound(f.ctx, { x, y, w, h: 34 }, 8, "rgba(10,15,20,0.92)", C.line);
    text(f.ctx, t.text, x + w / 2, y + 17, {
      size: 14,
      color: t.color,
      align: "center",
      baseline: "middle",
    });
    f.ctx.globalAlpha = 1;
  });
}

let crashShown = false;
function drawCrash(f: Frame, err: unknown): void {
  if (!crashShown) {
    crashShown = true;
  }
  fillRound(f.ctx, { x: 40, y: VH / 2 - 60, w: VW - 80, h: 120 }, 10, "rgba(40,12,12,0.95)", C.red, 2);
  text(f.ctx, "Something broke in the render loop", VW / 2, VH / 2 - 20, {
    size: 20,
    align: "center",
    weight: "700",
    color: "#ffd9d5",
  });
  text(f.ctx, String(err).slice(0, 140), VW / 2, VH / 2 + 12, {
    size: 13,
    align: "center",
    color: "#ffb3ac",
  });
}

requestAnimationFrame(loop);
