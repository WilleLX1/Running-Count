import type { Game, Scene } from "../game";
import { VH, VW } from "../core/renderer";
import { C, bar, button, fillRound, panel, text, vignette, type Frame } from "../core/ui";
import { money } from "../core/math";
import { MenuScene } from "./menu";
import { wrapText } from "./menu";

export type EndReason = "walked" | "backoff" | "broke";

const HEADLINE: Record<EndReason, { title: string; sub: string; color: string }> = {
  walked: {
    title: "You walked out on your own",
    sub: "The best way to leave a casino is early and quietly.",
    color: C.green,
  },
  backoff: {
    title: "Backed off",
    sub: "\"You're welcome to play anything but blackjack, sir.\" Your photograph is now in a database shared across the strip.",
    color: C.red,
  },
  broke: {
    title: "Tapped out",
    sub: "The edge is thin and variance is not. This is what an undercapitalised bankroll looks like.",
    color: C.heat,
  },
};

export class ResultsScene implements Scene {
  constructor(private game: Game, private reason: EndReason) {}

  enter(): void {
    const s = this.game.session;
    if (s.bankroll > s.best.bankroll) s.best.bankroll = s.bankroll;
    s.best.countAccuracy = Math.max(s.best.countAccuracy, s.countAccuracy);
    s.save();
  }

  frame(f: Frame): void {
    const { ctx } = f;
    const s = this.game.session;
    ctx.fillStyle = "#0a0e13";
    ctx.fillRect(0, 0, VW, VH);

    const h = HEADLINE[this.reason];
    text(ctx, h.title, 80, 90, { size: 40, weight: "800", color: h.color });
    wrapText(ctx, h.sub, 80, 122, 1000, 22, { size: 15, color: C.dim });

    const net = s.bankroll - s.startingBankroll;
    const minutes = Math.max(0.01, s.stats.timePlayed / 60);

    // ---- money ------------------------------------------------------
    const money1 = { x: 80, y: 180, w: 500, h: 230 };
    panel(f, money1, "The money");
    const rows: [string, string, string][] = [
      ["Bankroll", money(s.bankroll), C.gold],
      ["Net", `${net >= 0 ? "+" : "-"}${money(Math.abs(net))}`, net >= 0 ? C.green : C.red],
      ["Total wagered", money(s.stats.wagered), C.text],
      ["Rounds played", String(s.stats.roundsPlayed), C.text],
      [
        "Per 100 hands",
        s.stats.roundsPlayed > 0
          ? `${net >= 0 ? "+" : "-"}${money(Math.abs((net / s.stats.roundsPlayed) * 100))}`
          : "--",
        C.dim,
      ],
      ["Session length", `${minutes.toFixed(1)} min real time`, C.dim],
    ];
    rows.forEach((r, i) => {
      const y = money1.y + 58 + i * 28;
      text(ctx, r[0], money1.x + 20, y, { size: 14, color: C.dim });
      text(ctx, r[1], money1.x + money1.w - 20, y, {
        size: 15,
        color: r[2],
        align: "right",
        weight: "700",
        mono: true,
      });
    });

    // ---- skill ------------------------------------------------------
    const skill = { x: 604, y: 180, w: 596, h: 230 };
    panel(f, skill, "The skill");
    const bars: [string, number, string, string][] = [
      ["Playing decisions", s.decisionAccuracy, `${s.stats.decisionsCorrect}/${s.stats.decisions}`, C.green],
      ["Bet sizing vs the ramp", s.betAccuracy, `${s.stats.betsGood}/${s.stats.betsRated}`, C.gold],
      ["Count checks", s.countAccuracy, `${s.stats.countChecksCorrect}/${s.stats.countChecks}`, C.blue],
      [
        "Index plays",
        s.stats.deviationsHit + s.stats.deviationsMissed > 0
          ? s.stats.deviationsHit / (s.stats.deviationsHit + s.stats.deviationsMissed)
          : 1,
        `${s.stats.deviationsHit}/${s.stats.deviationsHit + s.stats.deviationsMissed}`,
        C.purple,
      ],
    ];
    bars.forEach((b, i) => {
      const y = skill.y + 52 + i * 44;
      text(ctx, b[0], skill.x + 20, y, { size: 14, color: C.dim });
      text(ctx, `${(b[1] * 100).toFixed(0)}%  (${b[2]})`, skill.x + skill.w - 20, y, {
        size: 13,
        color: C.faint,
        align: "right",
        mono: true,
      });
      bar(f, { x: skill.x + 20, y: y + 8, w: skill.w - 40, h: 12 }, b[1], b[3]);
    });

    // ---- heat -------------------------------------------------------
    const heat = { x: 80, y: 424, w: 1120, h: 206 };
    panel(f, heat, "What the pit saw");
    const bd = s.surveillance.breakdown;
    const factors: [string, number, string][] = [
      ["Bet spread", bd.spread, "How far your top bet sat above your bottom bet."],
      ["Bet tracks the count", bd.correlation, "The one that actually gets people barred."],
      ["Jumps between hands", bd.jump, "One unit to eight in a single hand is a tell."],
      ["Winning too fast", bd.winRate, "Nobody investigates a loser."],
      ["Wonging in and out", bd.wonging, "Appearing only when the shoe is good."],
      ["Play tells", bd.tells, "Insurance at a high count, odd-looking correct plays."],
    ];
    factors.forEach((fac, i) => {
      const x = heat.x + 24;
      const y = heat.y + 56 + i * 26;
      text(ctx, fac[0], x, y, { size: 13, color: C.text, weight: "600" });
      bar(f, { x: x + 210, y: y - 11, w: 220, h: 13 }, fac[1], fac[1] > 0.6 ? C.red : fac[1] > 0.3 ? C.gold : C.green);
      text(ctx, fac[2], x + 452, y, { size: 12, color: C.faint });
    });

    // ---- buttons ----------------------------------------------------
    if (button(f, { x: 80, y: 648, w: 260, h: 52 }, "Back to the menu", { accent: C.blue, hotkey: "ESC" }) ||
      f.input.consume("Escape", "Enter")) {
      this.game.setScene(new MenuScene(this.game));
      return;
    }
    text(
      ctx,
      this.reason === "backoff"
        ? "Next session the pit starts a little more interested in you."
        : "Career best bankroll: " + money(s.best.bankroll),
      366,
      680,
      { size: 13, color: C.faint },
    );

    vignette(ctx, VW, VH, 0.4);
  }
}
