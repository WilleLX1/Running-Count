import type { Game, Scene } from "../game";
import { VH, VW } from "../core/renderer";
import { C, button, fillRound, panel, text, vignette, type Frame } from "../core/ui";
import { wrapText } from "./menu";
import { drawCard } from "../render/cards";
import type { Card, Rank } from "../blackjack/cards";
import { DEFAULT_RAMP } from "../blackjack/counting";
import { ACTION_LABEL, DEVIATIONS } from "../blackjack/strategy";

interface Page {
  title: string;
  body: string[];
  draw?: (f: Frame, x: number, y: number, w: number) => void;
}

function card(rank: Rank, suit: Card["suit"], id: number): Card {
  return { rank, suit, id };
}

export class PrimerScene implements Scene {
  private page = 0;
  private pages: Page[];

  constructor(private game: Game, private onBack: () => void) {
    this.pages = buildPages();
  }

  frame(f: Frame): void {
    const { ctx } = f;
    ctx.fillStyle = "#0a0e13";
    ctx.fillRect(0, 0, VW, VH);

    const p = this.pages[this.page];
    text(ctx, `${this.page + 1} / ${this.pages.length}`, VW - 120, 60, {
      size: 13,
      color: C.faint,
      align: "right",
    });
    text(ctx, p.title, 120, 78, { size: 34, weight: "700" });

    const body = { x: 120, y: 110, w: 1040, h: 460 };
    panel(f, body);
    let y = body.y + 46;
    for (const para of p.body) {
      y += wrapText(ctx, para, body.x + 28, y, body.w - 56, 24, { size: 16, color: C.dim });
      y += 12;
    }
    p.draw?.(f, body.x + 28, y + 6, body.w - 56);

    const backR = { x: 120, y: 600, w: 180, h: 50 };
    const prevR = { x: 760, y: 600, w: 180, h: 50 };
    const nextR = { x: 960, y: 600, w: 200, h: 50 };
    if (button(f, backR, "Back", { hotkey: "ESC" }) || f.input.consume("Escape")) {
      this.onBack();
      return;
    }
    if (
      (button(f, prevR, "Previous", { enabled: this.page > 0 }) || f.input.consume("arrowleft")) &&
      this.page > 0
    ) {
      this.page--;
    }
    if (this.page < this.pages.length - 1) {
      if (button(f, nextR, "Next", { accent: C.green, hotkey: "→" }) || f.input.consume("arrowright", " ")) {
        this.page++;
      }
    } else if (button(f, nextR, "Go practice", { accent: C.green })) {
      this.onBack();
      return;
    }

    vignette(ctx, VW, VH, 0.4);
  }
}

function buildPages(): Page[] {
  return [
    {
      title: "Why counting works",
      body: [
        "A deck rich in tens and aces is good for you and bad for the house. You get paid 3:2 on a natural and the dealer does not. You can stand on 16 when the shoe is full of tens; the dealer must hit and bust. You can double down when a ten is likely; the dealer cannot.",
        "Off the top of a fresh six-deck shoe the house has about a 0.5% edge. As small cards leave the shoe, that edge slides toward you at roughly half a percent for every point of true count. At a true count of +2 you are playing an even game. At +4 you have about a 1.5% edge -- which is why you bet more there and only there.",
        "Counting is not memorising cards. It is one number that tracks whether what is left is rich or poor.",
      ],
    },
    {
      title: "The Hi-Lo tags",
      body: [
        "Every card you see gets a tag. Add them up as they come off the shoe. That total is the running count. Low cards leaving the shoe is good news for you, so they count +1.",
        "Practise until you are not adding, just feeling the number move. Then practise cancelling pairs -- a 5 and a king arriving together are zero, so do not count them one at a time.",
      ],
      draw: (f, x, y, w) => {
        const groups: { cards: Card[]; tag: string; label: string; color: string }[] = [
          {
            cards: [card("2", "S", 1), card("3", "H", 2), card("4", "D", 3), card("5", "C", 4), card("6", "S", 5)],
            tag: "+1",
            label: "low cards",
            color: C.green,
          },
          {
            cards: [card("7", "H", 6), card("8", "D", 7), card("9", "C", 8)],
            tag: "0",
            label: "neutral",
            color: C.dim,
          },
          {
            cards: [card("T", "S", 9), card("J", "H", 10), card("Q", "D", 11), card("K", "C", 12), card("A", "S", 13)],
            tag: "-1",
            label: "tens and aces",
            color: C.red,
          },
        ];
        let cx = x;
        for (const g of groups) {
          g.cards.forEach((c, i) => drawCard(f.ctx, c, cx + i * 30, y, 44, 62));
          const gw = (g.cards.length - 1) * 30 + 44;
          text(f.ctx, g.tag, cx + gw / 2, y + 82, {
            size: 20,
            weight: "800",
            color: g.color,
            align: "center",
          });
          text(f.ctx, g.label, cx + gw / 2, y + 100, { size: 12, color: C.faint, align: "center" });
          cx += gw + 64;
        }
        void w;
      },
    },
    {
      title: "Running count to true count",
      body: [
        "A running count of +6 means very different things with six decks left and with one deck left. Divide the running count by the decks still to be dealt and you get the true count -- the number that actually predicts your edge.",
        "You estimate decks remaining by looking at the discard tray, not by doing arithmetic. Learn what one deck, two decks and three decks look like stacked up. In this game the tray next to the shoe shows exactly that, and the training room drills it.",
        "Convention: round toward zero. A running count of +7 with 2.5 decks left is +2.8, which you play as +2.",
      ],
      draw: (f, x, y, w) => {
        const rows = [
          ["Running count", "+6", "+6", "+6"],
          ["Decks remaining", "6", "3", "1.5"],
          ["True count", "+1", "+2", "+4"],
          ["Your edge", "0.0%", "+0.5%", "+1.5%"],
        ];
        const colW = (w - 220) / 3;
        rows.forEach((r, ri) => {
          const ry = y + ri * 26;
          text(f.ctx, r[0], x, ry, { size: 14, color: C.faint });
          for (let ci = 1; ci < 4; ci++) {
            text(f.ctx, r[ci], x + 220 + (ci - 1) * colW + colW / 2, ry, {
              size: 15,
              weight: ri === 2 || ri === 3 ? "700" : "500",
              color: ri === 3 ? C.green : ri === 2 ? C.gold : C.text,
              align: "center",
            });
          }
        });
      },
    },
    {
      title: "The bet ramp is the whole game",
      body: [
        "Playing decisions are worth a fraction of a percent. Betting is worth everything. You win money by having a big bet out when the count is high and the table minimum out when it is not.",
        "This is also exactly what surveillance looks for. A pit boss does not need to know Hi-Lo -- they only need to notice that your bet goes up when the deck is good. That correlation is the thing that gets you barred, so cover it: raise after a win, keep a big bet out for one flat hand after the count drops, and do not jump from one unit to twelve in a single hand.",
      ],
      draw: (f, x, y, w) => {
        const barW = (w - 60) / DEFAULT_RAMP.length;
        const maxUnits = Math.max(...DEFAULT_RAMP.map((r) => r.units));
        DEFAULT_RAMP.forEach((step, i) => {
          const h = (step.units / maxUnits) * 96;
          const bx = x + i * barW;
          fillRound(f.ctx, { x: bx, y: y + 110 - h, w: barW - 18, h }, 4, i >= 3 ? C.gold : C.blue);
          text(f.ctx, `${step.units}u`, bx + (barW - 18) / 2, y + 128, {
            size: 13,
            color: C.text,
            align: "center",
          });
          text(
            f.ctx,
            step.tc < -50 ? "TC ≤ 1" : `TC ${step.tc}+`,
            bx + (barW - 18) / 2,
            y + 146,
            { size: 11, color: C.faint, align: "center" },
          );
        });
      },
    },
    {
      title: "Index plays and insurance",
      body: [
        "Basic strategy assumes an average shoe. When the count is extreme, some decisions flip. Standing on 16 against a ten is a coin flip at true count 0 and clearly right above it. Insurance is a terrible bet -- until a third of the shoe is tens, which is what true count +3 means.",
        "The Illustrious 18 are the eighteen deviations worth more than all the others combined. They are listed below; the training room drills them one at a time.",
      ],
      draw: (f, x, y, w) => {
        const up = (v: number) => (v === 11 ? "A" : String(v));
        const rows: { hand: string; play: string; when: string; gold?: boolean }[] = [
          { hand: "Insurance", play: "Take it", when: "TC ≥ +3", gold: true },
          ...DEVIATIONS.slice(0, 17).map((d) => ({
            hand:
              d.pair != null
                ? `${d.pair === 10 ? "10,10" : `${d.pair},${d.pair}`} v ${up(d.up)}`
                : `${d.total} v ${up(d.up)}`,
            play: ACTION_LABEL[d.action],
            when: `TC ${d.above ? "≥" : "≤"} ${d.index > 0 ? "+" : ""}${d.index}`,
          })),
        ];
        const perCol = Math.ceil(rows.length / 2);
        const colW = w / 2;
        rows.forEach((r, i) => {
          const cx = x + Math.floor(i / perCol) * colW;
          const cy = y + (i % perCol) * 22;
          const color = r.gold ? C.gold : C.text;
          text(f.ctx, r.hand, cx, cy, { size: 13, color, weight: "600" });
          text(f.ctx, r.play, cx + 96, cy, { size: 13, color: r.gold ? C.gold : C.purple });
          text(f.ctx, r.when, cx + 190, cy, { size: 13, color: C.faint, mono: true });
        });
      },
    },
    {
      title: "What the eye in the sky sees",
      body: [
        "You are not caught for counting -- counting is just thinking. You are caught for betting like a counter. The pit tracks your spread, whether your bets track the count, how fast you are winning, and whether you appear only when the shoe is good.",
        "Countermeasures come in stages: the dealer glances at your rack, a floor supervisor drifts over, the pit boss calls upstairs, and then two people in suits explain that you are welcome to play any game except this one.",
        "Cover costs money and buys time. Tip the dealer. Order a drink. Talk. Flat bet through a hot shoe once in a while. Leave a table before you are asked to. Take a walk. And when the suits start moving, cash out before they arrive -- once you are backed off, the house remembers your face.",
      ],
      draw: (f, x, y, w) => {
        const stages = [
          { label: "Clear", color: C.green },
          { label: "Noticed", color: "#9ecf4a" },
          { label: "Watched", color: C.gold },
          { label: "Pit called", color: C.heat },
          { label: "Backed off", color: C.red },
        ];
        const segW = w / stages.length;
        stages.forEach((s, i) => {
          fillRound(f.ctx, { x: x + i * segW, y, w: segW - 10, h: 24 }, 6, s.color);
          text(f.ctx, s.label, x + i * segW + (segW - 10) / 2, y + 12, {
            size: 12,
            color: "#0b1015",
            weight: "700",
            align: "center",
            baseline: "middle",
          });
        });
      },
    },
  ];
}
