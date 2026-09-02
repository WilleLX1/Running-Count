/**
 * Keyboard + mouse state. Edge-triggered presses live in a per-frame set that
 * scenes drain; held keys are queried directly.
 */
export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private typedBuffer: string[] = [];

  mouseX = 0;
  mouseY = 0;
  mouseDown = false;
  mouseClicked = false;
  wheel = 0;

  constructor(target: HTMLCanvasElement) {
    window.addEventListener("keydown", (e) => {
      const k = normalize(e.key);
      if (!e.repeat) this.pressed.add(k);
      this.held.add(k);
      if (e.key.length === 1 || e.key === "Backspace") this.typedBuffer.push(e.key);
      // Don't let the page scroll / activate browser find etc.
      if (SWALLOW.has(k)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => {
      this.held.delete(normalize(e.key));
    });
    window.addEventListener("blur", () => {
      this.held.clear();
      this.mouseDown = false;
    });
    const track = (e: MouseEvent) => {
      const r = target.getBoundingClientRect();
      this.mouseX = e.clientX - r.left;
      this.mouseY = e.clientY - r.top;
    };
    target.addEventListener("mousemove", track);
    target.addEventListener("mousedown", (e) => {
      track(e);
      if (e.button === 0) this.mouseDown = true;
    });
    window.addEventListener("mouseup", (e) => {
      track(e);
      if (e.button === 0 && this.mouseDown) {
        this.mouseDown = false;
        this.mouseClicked = true;
      }
    });
    target.addEventListener("contextmenu", (e) => e.preventDefault());
    target.addEventListener("wheel", (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
  }

  isDown(...keys: string[]): boolean {
    for (const k of keys) if (this.held.has(normalize(k))) return true;
    return false;
  }

  /** True once per physical key press. Consumes the press. */
  consume(...keys: string[]): boolean {
    for (const k of keys) {
      const n = normalize(k);
      if (this.pressed.has(n)) {
        this.pressed.delete(n);
        return true;
      }
    }
    return false;
  }

  /** Characters typed this frame (for text entry drills). */
  drainTyped(): string[] {
    const out = this.typedBuffer;
    this.typedBuffer = [];
    return out;
  }

  endFrame(): void {
    this.pressed.clear();
    this.mouseClicked = false;
    this.wheel = 0;
    this.typedBuffer.length = 0;
  }
}

const SWALLOW = new Set([
  " ",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "tab",
  "/",
]);

function normalize(key: string): string {
  const k = key.toLowerCase();
  if (k === "space" || k === "spacebar") return " ";
  if (k === "esc") return "escape";
  return k;
}
