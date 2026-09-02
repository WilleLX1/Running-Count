import type { Game, Scene } from "../game";
import { VH, VW } from "../core/renderer";
import { C, button, fillRound, panel, text, vignette, type Frame } from "../core/ui";
import { money } from "../core/math";
import { NetClient } from "../net/client";
import { MAX_PLAYERS } from "../net/protocol";
import { MenuScene } from "./menu";
import { FloorScene } from "./floor";
import { wrapText } from "./menu";

type Stage = "setup" | "connecting" | "room" | "error";

const STAKES: { label: string; bankroll: number; unit: number }[] = [
  { label: "Tourist", bankroll: 1000, unit: 10 },
  { label: "Grinder", bankroll: 2500, unit: 25 },
  { label: "Backed player", bankroll: 10000, unit: 100 },
];

/** Host a table or join one with a four letter code. */
export class LobbyScene implements Scene {
  private stage: Stage = "setup";
  private field: "name" | "code" = "name";
  private name = "";
  private code = "";
  private stake = 1;
  private error = "";
  private net: NetClient | null = null;

  constructor(private game: Game) {
    this.name = localStorage.getItem("running-count.name") ?? "";
  }

  exit(): void {
    // The floor scene takes ownership once we are in a room.
  }

  frame(f: Frame): void {
    const { ctx } = f;
    const g = ctx.createLinearGradient(0, 0, 0, VH);
    g.addColorStop(0, "#10161d");
    g.addColorStop(1, "#080b0f");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);

    text(ctx, "CO-OP", VW / 2, 96, { size: 48, weight: "800", align: "center" });
    text(ctx, "two to four counters, one casino, one pit watching all of you", VW / 2, 128, {
      size: 15,
      align: "center",
      color: C.dim,
    });

    switch (this.stage) {
      case "setup":
        this.setup(f);
        break;
      case "connecting":
        this.connecting(f);
        break;
      case "room":
        this.room(f);
        break;
      case "error":
        this.errorStage(f);
        break;
    }

    vignette(ctx, VW, VH, 0.45);
  }

  // ---------------------------------------------------------------- setup

  private setup(f: Frame): void {
    const { ctx } = f;
    this.typeInto(f);

    const left = { x: 150, y: 190, w: 460, h: 330 };
    panel(f, left, "Who are you");
    this.textField(f, { x: left.x + 20, y: left.y + 46, w: left.w - 40, h: 52 }, "name", this.name, "Your name");

    text(ctx, "BANKROLL", left.x + 20, left.y + 132, { size: 10, color: C.faint, weight: "700" });
    STAKES.forEach((s, i) => {
      const r = { x: left.x + 20, y: left.y + 146 + i * 52, w: left.w - 40, h: 44 };
      if (
        button(f, r, `${s.label}  ·  ${money(s.bankroll)}  ·  ${money(s.unit)} unit`, {
          active: this.stake === i,
          accent: C.green,
          small: true,
        })
      ) {
        this.stake = i;
      }
    });

    const right = { x: 650, y: 190, w: 480, h: 330 };
    panel(f, right, "Table");
    if (button(f, { x: right.x + 20, y: right.y + 46, w: right.w - 40, h: 60 }, "Host a new table", {
      accent: C.gold,
    })) {
      this.connect(undefined);
    }
    text(ctx, "You get a four letter code to pass around.", right.x + 20, right.y + 128, {
      size: 12,
      color: C.faint,
    });

    text(ctx, "OR JOIN ONE", right.x + 20, right.y + 164, { size: 10, color: C.faint, weight: "700" });
    this.textField(
      f,
      { x: right.x + 20, y: right.y + 178, w: 220, h: 56 },
      "code",
      this.code,
      "CODE",
      true,
    );
    if (
      button(f, { x: right.x + 256, y: right.y + 178, w: right.w - 276, h: 56 }, "Join", {
        accent: C.blue,
        enabled: this.code.length === 4,
      })
    ) {
      this.connect(this.code);
    }
    text(
      ctx,
      "Everyone must be on the same server. On a LAN, use the host's address.",
      right.x + 20,
      right.y + 268,
      { size: 12, color: C.faint },
    );

    if (button(f, { x: 150, y: 560, w: 220, h: 52 }, "Back", { hotkey: "ESC" }) || f.input.consume("Escape")) {
      this.game.setScene(new MenuScene(this.game));
    }
    text(
      ctx,
      "Team play: one of you spreads big while the other flat bets and calls the count. Heat is tracked per person.",
      150,
      648,
      { size: 13, color: C.faint },
    );
  }

  private textField(
    f: Frame,
    r: { x: number; y: number; w: number; h: number },
    which: "name" | "code",
    value: string,
    placeholder: string,
    upper = false,
  ): void {
    const active = this.field === which;
    fillRound(f.ctx, r, 8, "#0a0f14", active ? C.gold : C.line, active ? 2 : 1);
    const shown = value || placeholder;
    text(f.ctx, upper ? shown.toUpperCase() : shown, r.x + 14, r.y + r.h / 2 + 1, {
      size: upper ? 26 : 20,
      color: value ? C.text : C.faint,
      baseline: "middle",
      weight: upper ? "800" : "600",
      mono: upper,
    });
    if (active && Math.floor(f.time * 2) % 2 === 0) {
      const w = f.ctx.measureText(upper ? value.toUpperCase() : value).width;
      f.ctx.fillStyle = C.gold;
      f.ctx.fillRect(r.x + 16 + w, r.y + 12, 2, r.h - 24);
    }
    if (f.clicked && f.mx >= r.x && f.mx <= r.x + r.w && f.my >= r.y && f.my <= r.y + r.h) {
      this.field = which;
    }
  }

  private typeInto(f: Frame): void {
    if (f.input.consume("Tab")) this.field = this.field === "name" ? "code" : "name";
    for (const ch of f.input.drainTyped()) {
      if (ch === "Backspace") {
        if (this.field === "name") this.name = this.name.slice(0, -1);
        else this.code = this.code.slice(0, -1);
        continue;
      }
      if (this.field === "name") {
        if (this.name.length < 14 && /[\w .'-]/.test(ch)) this.name += ch;
      } else if (this.code.length < 4 && /[A-Za-z0-9]/.test(ch)) {
        this.code += ch.toUpperCase();
      }
    }
  }

  // ----------------------------------------------------------- connecting

  private connect(code: string | undefined): void {
    const stake = STAKES[this.stake];
    const name = this.name.trim() || "Player";
    localStorage.setItem("running-count.name", name);
    this.game.session.reset(stake.bankroll, stake.unit);

    const net = new NetClient({
      onWelcome: () => {
        this.stage = "room";
      },
      onError: (text) => {
        this.error = text;
        this.stage = "error";
      },
      onClosed: () => {
        this.error = "The server hung up.";
        this.stage = "error";
      },
    });
    this.net = net;
    this.game.net = net;
    this.stage = "connecting";
    net.connect(name, code, stake.bankroll, stake.unit);
  }

  private connecting(f: Frame): void {
    const dots = ".".repeat(1 + (Math.floor(f.time * 2) % 3));
    text(f.ctx, `Walking in${dots}`, VW / 2, 340, { size: 24, align: "center", color: C.dim });
    if (button(f, { x: VW / 2 - 110, y: 420, w: 220, h: 50 }, "Cancel", { hotkey: "ESC" }) ||
      f.input.consume("Escape")) {
      this.net?.close();
      this.game.net = null;
      this.stage = "setup";
    }
  }

  private errorStage(f: Frame): void {
    const r = { x: VW / 2 - 320, y: 250, w: 640, h: 180 };
    fillRound(f.ctx, r, 12, C.panel, C.red, 2);
    text(f.ctx, "That did not work", VW / 2, r.y + 52, {
      size: 24,
      align: "center",
      weight: "700",
      color: C.red,
    });
    wrapText(f.ctx, this.error, r.x + 40, r.y + 88, r.w - 80, 22, { size: 15, color: C.dim });
    if (button(f, { x: VW / 2 - 110, y: r.y + 210, w: 220, h: 50 }, "Try again", { hotkey: "ESC" }) ||
      f.input.consume("Escape", "Enter")) {
      this.game.net = null;
      this.stage = "setup";
    }
  }

  // ----------------------------------------------------------------- room

  private room(f: Frame): void {
    const { ctx } = f;
    const net = this.net!;
    const players = net.room?.players ?? [];

    const codeR = { x: VW / 2 - 200, y: 180, w: 400, h: 120 };
    fillRound(ctx, codeR, 12, C.panel, C.gold, 2);
    text(ctx, "TABLE CODE", VW / 2, codeR.y + 32, {
      size: 11,
      color: C.faint,
      align: "center",
      weight: "700",
    });
    text(ctx, net.code, VW / 2, codeR.y + 88, {
      size: 56,
      align: "center",
      weight: "800",
      color: C.gold,
      mono: true,
    });

    text(ctx, `IN THE ROOM  (${players.length}/${MAX_PLAYERS})`, VW / 2 - 300, 350, {
      size: 11,
      color: C.faint,
      weight: "700",
    });
    players.forEach((p, i) => {
      const r = { x: VW / 2 - 300, y: 366 + i * 54, w: 600, h: 46 };
      fillRound(ctx, r, 8, C.panel, p.id === net.youId ? C.gold : C.line);
      ctx.beginPath();
      ctx.arc(r.x + 28, r.y + 23, 12, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${p.hue} 70% 55%)`;
      ctx.fill();
      text(ctx, p.name + (p.id === net.youId ? "  (you)" : ""), r.x + 52, r.y + 28, {
        size: 16,
        weight: "600",
      });
      text(ctx, money(p.bankroll), r.x + r.w - 20, r.y + 28, {
        size: 15,
        align: "right",
        color: C.gold,
        mono: true,
      });
    });

    if (
      button(f, { x: VW / 2 - 160, y: 610, w: 320, h: 58 }, "Walk onto the floor", {
        accent: C.green,
        hotkey: "ENTER",
      }) ||
      f.input.consume("Enter", " ")
    ) {
      this.game.setScene(new FloorScene(this.game, net));
      return;
    }
    if (button(f, { x: VW / 2 + 200, y: 610, w: 160, h: 58 }, "Leave")) {
      net.close();
      this.game.net = null;
      this.game.setScene(new MenuScene(this.game));
      return;
    }
    text(ctx, "Others can join at any time, even once you are inside.", VW / 2, 690, {
      size: 12,
      color: C.faint,
      align: "center",
    });
  }
}
