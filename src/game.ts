import type { Frame } from "./core/ui";
import type { NetClient } from "./net/client";
import { Session } from "./state/session";

export interface Scene {
  /** Update and draw in one pass -- the UI layer is immediate-mode. */
  frame(f: Frame): void;
  enter?(): void;
  exit?(): void;
}

export interface Toast {
  text: string;
  color: string;
  t: number;
}

export class Game {
  scene: Scene | null = null;
  session = new Session();
  /** Set while a co-op session is live; null in solo. */
  net: NetClient | null = null;
  toasts: Toast[] = [];
  /** Set by the floor scene so the table scene knows where to go back to. */
  returnScene: Scene | null = null;

  setScene(s: Scene): void {
    this.scene?.exit?.();
    this.scene = s;
    s.enter?.();
  }

  toast(text: string, color = "#e7edf3"): void {
    this.toasts.unshift({ text, color, t: 4.5 });
    if (this.toasts.length > 6) this.toasts.pop();
  }

  tickToasts(dt: number): void {
    for (const t of this.toasts) t.t -= dt;
    this.toasts = this.toasts.filter((t) => t.t > 0);
  }
}
