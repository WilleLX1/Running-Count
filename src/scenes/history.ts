import type { Game, Scene } from "../game";
import { VH, VW } from "../core/renderer";
import { C, button, fillRound, text, vignette, type Frame } from "../core/ui";
import { money } from "../core/math";
import { barChart, lineChart } from "../render/chart";
import {
  formatMinutes,
  ratio,
  sessionLabel,
  spanLabel,
  timeLabel,
  type HistoryRecord,
} from "../state/history";

type Tab = "money" | "skill" | "heat" | "training" | "log";

const TABS: { id: Tab; label: string }[] = [
  { id: "money", label: "Money" },
  { id: "skill", label: "Skill" },
  { id: "heat", label: "Heat" },
  { id: "training", label: "Training" },
  { id: "log", label: "Log" },
];

const DRILL_NAMES: Record<string, string> = {
  tags: "Card tags",
  pairs: "Cancel the pair",
  speed: "Count a deck",
  deckdown: "Count down a deck",
  board: "Net the table",
  decks: "Read the tray",
  truecount: "True count",
  strategy: "Basic strategy",
  index: "Index plays",
};

/** Everything that has happened, plotted. */
export class HistoryScene implements Scene {
  private tab: Tab = "money";
  private drillPick = "";
  private logScroll = 0;
  private confirmClear = false;

  constructor(
    private game: Game,
    private onExit: () => void,
  ) {}

  frame(f: Frame): void {
    const { ctx } = f;
    ctx.fillStyle = "#0a0e13";
    ctx.fillRect(0, 0, VW, VH);

    const h = this.game.history;
    text(ctx, "Your history", 60, 60, { size: 28, weight: "700" });

    this.drawTotals(f);
    this.drawTabs(f);

    const body = { x: 60, y: 216, w: VW - 120, h: 424 };
    switch (this.tab) {
      case "money":
        this.money(f, body);
        break;
      case "skill":
        this.skill(f, body);
        break;
      case "heat":
        this.heat(f, body);
        break;
      case "training":
        this.training(f, body);
        break;
      case "log":
        this.log(f, body);
        break;
    }

    if (button(f, { x: 60, y: VH - 62, w: 160, h: 46 }, "Back", { hotkey: "ESC" }) ||
      f.input.consume("Escape")) {
      this.onExit();
      return;
    }
    if (h.records.length > 0) {
      if (this.confirmClear) {
        text(ctx, "Wipe all of it?", VW - 372, VH - 32, {
          size: 13,
          color: C.red,
          align: "right",
        });
        if (button(f, { x: VW - 240, y: VH - 62, w: 100, h: 46 }, "Yes", { accent: C.red })) {
          h.clear();
          this.confirmClear = false;
        }
        if (button(f, { x: VW - 130, y: VH - 62, w: 100, h: 46 }, "No")) this.confirmClear = false;
      } else if (
        button(f, { x: VW - 200, y: VH - 62, w: 140, h: 46 }, "Clear history", { small: true })
      ) {
        this.confirmClear = true;
      }
    }

    vignette(ctx, VW, VH, 0.4);
  }

  private drawTotals(f: Frame): void {
    const { ctx } = f;
    const l = this.game.history.lifetime;
    const cards: { label: string; value: string; color: string }[] = [
      { label: "Sessions", value: String(l.sessions), color: C.text },
      {
        label: "Lifetime net",
        value: `${l.net >= 0 ? "+" : "-"}${money(Math.abs(l.net))}`,
        color: l.net >= 0 ? C.green : C.red,
      },
      { label: "Rounds", value: l.rounds.toLocaleString(), color: C.text },
      { label: "Time at it", value: formatMinutes(l.minutes), color: C.dim },
      {
        label: "Per 100 hands",
        value: l.rounds > 0 ? `${l.perHundred >= 0 ? "+" : "-"}${money(Math.abs(l.perHundred))}` : "--",
        color: l.perHundred >= 0 ? C.green : C.red,
      },
      { label: "Best bankroll", value: l.best > 0 ? money(l.best) : "--", color: C.gold },
      { label: "Backed off", value: String(l.backoffs), color: l.backoffs > 0 ? C.red : C.green },
      { label: "Drills", value: String(l.drills), color: C.blue },
      { label: "Shoes", value: String(l.shoes), color: C.purple },
    ];
    const w = (VW - 120 - (cards.length - 1) * 8) / cards.length;
    cards.forEach((c, i) => {
      const r = { x: 60 + i * (w + 8), y: 78, w, h: 58 };
      fillRound(ctx, r, 9, C.panel, C.line);
      text(ctx, c.label.toUpperCase(), r.x + 12, r.y + 20, {
        size: 8,
        color: C.faint,
        weight: "700",
      });
      text(ctx, c.value, r.x + 12, r.y + 44, {
        size: 17,
        weight: "800",
        color: c.color,
        mono: true,
        maxWidth: w - 24,
      });
    });
  }

  private drawTabs(f: Frame): void {
    TABS.forEach((t, i) => {
      const r = { x: 60 + i * 132, y: 156, w: 124, h: 42 };
      if (
        button(f, r, t.label, { active: this.tab === t.id, accent: C.gold, small: true }) ||
        f.input.consume(String(i + 1))
      ) {
        this.tab = t.id;
        this.logScroll = 0;
      }
    });
  }

  // ----------------------------------------------------------------- money

  private money(f: Frame, r: { x: number; y: number; w: number; h: number }): void {
    const rows = this.game.history.casino;
    const labels = rows.map(sessionLabel);
    const spans = rows.map(spanLabel);
    const markers = rows
      .map((x, i) => ({ index: i, reason: x.reason }))
      .filter((m) => m.reason !== "walked")
      .map((m) => ({
        index: m.index,
        color: m.reason === "backoff" ? C.red : C.heat,
      }));

    let running = 0;
    const cumulative = rows.map((x) => (running += x.net));

    const half = (r.w - 16) / 2;
    lineChart(
      f,
      { x: r.x, y: r.y, w: half, h: 200 },
      [{ label: "Bankroll at cash out", color: C.gold, values: rows.map((x) => x.endBankroll), fill: true }],
      {
        title: "Bankroll, session by session",
        xLabels: labels,
        xTooltips: spans,
        format: (v) => money(v),
        markers,
        empty: "No nights out yet. The red dots will be the back-offs.",
      },
    );
    lineChart(
      f,
      { x: r.x + half + 16, y: r.y, w: half, h: 200 },
      [{ label: "Cumulative", color: C.green, values: cumulative, fill: true }],
      {
        title: "Money won and lost, all told",
        xLabels: labels,
        xTooltips: spans,
        zero: true,
        format: (v) => money(v),
        empty: "Nothing banked yet.",
      },
    );
    barChart(
      f,
      { x: r.x, y: r.y + 216, w: half, h: 200 },
      rows.map((x) => x.net),
      { title: "Result per session", xLabels: labels,
        xTooltips: spans, format: (v) => money(v) },
    );
    lineChart(
      f,
      { x: r.x + half + 16, y: r.y + 216, w: half, h: 200 },
      [
        {
          label: "Per 100 hands",
          color: C.blue,
          values: rows.map((x) => (x.rounds > 0 ? (x.net / x.rounds) * 100 : null)),
        },
        {
          label: "Average bet",
          color: C.purple,
          values: rows.map((x) => (x.rounds > 0 ? x.wagered / x.rounds : null)),
        },
      ],
      { title: "Rate and bet size", xLabels: labels,
        xTooltips: spans, zero: true, format: (v) => money(v) },
    );
  }

  // ----------------------------------------------------------------- skill

  private skill(f: Frame, r: { x: number; y: number; w: number; h: number }): void {
    const rows = this.game.history.casino;
    const labels = rows.map(sessionLabel);
    const spans = rows.map(spanLabel);
    const pct = (v: number | null) => (v === null ? null : v * 100);
    const half = (r.w - 16) / 2;

    lineChart(
      f,
      { x: r.x, y: r.y, w: r.w, h: 200 },
      [
        {
          label: "Playing decisions",
          color: C.green,
          values: rows.map((x) => pct(ratio(x.decisionsCorrect, x.decisions))),
        },
        {
          label: "Bet sizing",
          color: C.gold,
          values: rows.map((x) => pct(ratio(x.betsGood, x.betsRated))),
        },
        {
          label: "Count checks",
          color: C.blue,
          values: rows.map((x) => pct(ratio(x.countChecksCorrect, x.countChecks))),
        },
        {
          label: "Index plays",
          color: C.purple,
          values: rows.map((x) => pct(ratio(x.deviationsHit, x.deviationsHit + x.deviationsMissed))),
        },
      ],
      {
        title: "Accuracy at the table",
        xLabels: labels,
        xTooltips: spans,
        min: 0,
        max: 100,
        format: (v) => `${Math.round(v)}%`,
        empty: "Play a session and these four lines start telling you what to work on.",
      },
    );

    lineChart(
      f,
      { x: r.x, y: r.y + 216, w: half, h: 200 },
      [
        { label: "Rounds", color: C.blue, values: rows.map((x) => x.rounds) },
        { label: "Minutes in", color: C.dim, values: rows.map((x) => x.minutes) },
        {
          label: "At the table",
          color: C.faint,
          values: rows.map((x) => x.activeMinutes ?? null),
          dashed: true,
        },
      ],
      { title: "Volume per session", xLabels: labels },
    );

    const shoes = this.game.history.shoes;
    lineChart(
      f,
      { x: r.x + half + 16, y: r.y + 216, w: half, h: 200 },
      [
        {
          label: "Checks recalled",
          color: C.blue,
          values: shoes.map((s) => pct(ratio(s.checksCorrect, s.checks))),
        },
        {
          label: "Tags right",
          color: C.green,
          values: shoes.map((s) => pct(ratio(s.tagChecksCorrect, s.tagChecks))),
        },
        {
          label: "In step",
          color: C.purple,
          values: shoes.map((s) => (s.inStep < 0 ? null : s.inStep * 100)),
          dashed: true,
        },
      ],
      {
        title: "Live table shoes",
        xLabels: shoes.map(sessionLabel),
        xTooltips: shoes.map(spanLabel),
        min: 0,
        max: 100,
        format: (v) => `${Math.round(v)}%`,
        empty: "Deal a training shoe to see memory and tagging split apart.",
      },
    );
  }

  // ------------------------------------------------------------------ heat

  private heat(f: Frame, r: { x: number; y: number; w: number; h: number }): void {
    const rows = this.game.history.casino;
    const labels = rows.map(sessionLabel);
    const spans = rows.map(spanLabel);
    const half = (r.w - 16) / 2;

    lineChart(
      f,
      { x: r.x, y: r.y, w: r.w, h: 200 },
      [{ label: "Peak heat", color: C.heat, values: rows.map((x) => x.peakHeat), fill: true }],
      {
        title: "How hot you got",
        xLabels: labels,
        xTooltips: spans,
        min: 0,
        max: 100,
        guide: { at: 92, color: C.red, label: "backed off" },
        markers: rows
          .map((x, i) => ({ index: i, reason: x.reason }))
          .filter((m) => m.reason === "backoff")
          .map((m) => ({ index: m.index, color: C.red })),
        empty: "No pit has looked at you yet.",
      },
    );

    lineChart(
      f,
      { x: r.x, y: r.y + 216, w: half, h: 200 },
      [
        { label: "Bet tracks count", color: C.red, values: rows.map((x) => x.heat.correlation * 100) },
        { label: "Spread", color: C.gold, values: rows.map((x) => x.heat.spread * 100) },
        { label: "Winning fast", color: C.green, values: rows.map((x) => x.heat.winRate * 100) },
        { label: "Wonging", color: C.purple, values: rows.map((x) => x.heat.wonging * 100) },
      ],
      {
        title: "What gave you away",
        xLabels: labels,
        xTooltips: spans,
        min: 0,
        max: 100,
        format: (v) => `${Math.round(v)}%`,
      },
    );

    lineChart(
      f,
      { x: r.x + half + 16, y: r.y + 216, w: half, h: 200 },
      [
        {
          label: "Spread used",
          color: C.blue,
          values: rows.map((x) => (x.unit > 0 && x.rounds > 0 ? x.wagered / x.rounds / x.unit : null)),
        },
      ],
      {
        title: "Average bet in units",
        xLabels: labels,
        xTooltips: spans,
        format: (v) => `${v.toFixed(1)}u`,
      },
    );
  }

  // -------------------------------------------------------------- training

  private training(f: Frame, r: { x: number; y: number; w: number; h: number }): void {
    const { ctx } = f;
    const hist = this.game.history;
    const ids = hist.drillIds();
    if (this.drillPick === "" && ids.length > 0) this.drillPick = ids[0];

    // Drill picker.
    ids.forEach((id, i) => {
      const w = 158;
      const br = { x: r.x + i * (w + 8), y: r.y, w, h: 34 };
      if (br.x + w > r.x + r.w) return;
      if (
        button(f, br, DRILL_NAMES[id] ?? id, {
          small: true,
          accent: C.blue,
          active: this.drillPick === id,
        })
      ) {
        this.drillPick = id;
      }
    });
    if (ids.length === 0) {
      text(ctx, "No drills run yet.", r.x, r.y + 24, { size: 15, color: C.faint });
    }

    const runs = hist.drills(this.drillPick);
    const labels = runs.map(sessionLabel);
    const spans = runs.map(spanLabel);
    const half = (r.w - 16) / 2;

    lineChart(
      f,
      { x: r.x, y: r.y + 48, w: half, h: 172 },
      [
        {
          label: "Accuracy",
          color: C.green,
          values: runs.map((x) => (x.total > 0 ? (x.right / x.total) * 100 : null)),
          fill: true,
        },
      ],
      {
        title: `${DRILL_NAMES[this.drillPick] ?? this.drillPick} — accuracy`,
        xLabels: labels,
        xTooltips: spans,
        min: 0,
        max: 100,
        format: (v) => `${Math.round(v)}%`,
        empty: "Run this drill to start a line.",
      },
    );
    lineChart(
      f,
      { x: r.x + half + 16, y: r.y + 48, w: half, h: 172 },
      [
        {
          label: "Seconds to answer",
          color: C.gold,
          values: runs.map((x) => (x.msPerAnswer > 0 ? x.msPerAnswer / 1000 : null)),
        },
        {
          label: "Deck time",
          color: C.purple,
          values: runs.map((x) => x.deckSeconds ?? null),
        },
      ],
      {
        title: "Speed",
        xLabels: labels,
        xTooltips: spans,
        format: (v) => `${v.toFixed(2)}s`,
        empty: "Speed shows up once you have answered a few.",
      },
    );

    const shoes = hist.shoes;
    lineChart(
      f,
      { x: r.x, y: r.y + 236, w: half, h: 172 },
      [
        { label: "Cards seen", color: C.blue, values: shoes.map((s) => s.cardsSeen) },
        { label: "Peeks", color: C.red, values: shoes.map((s) => s.peeks) },
      ],
      {
        title: "Live table — volume and peeking",
        xLabels: shoes.map(sessionLabel),
        xTooltips: shoes.map(spanLabel),
      },
    );
    lineChart(
      f,
      { x: r.x + half + 16, y: r.y + 236, w: half, h: 172 },
      [
        { label: "Seconds a card", color: C.gold, values: shoes.map((s) => s.speed) },
        { label: "Average miss", color: C.red, values: shoes.map((s) => s.avgMiss) },
      ],
      {
        title: "Live table — dealer speed and error",
        xLabels: shoes.map(sessionLabel),
        xTooltips: shoes.map(spanLabel),
        format: (v) => v.toFixed(2),
      },
    );
  }

  // ------------------------------------------------------------------- log

  private log(f: Frame, r: { x: number; y: number; w: number; h: number }): void {
    const { ctx } = f;
    const all = [...this.game.history.records].reverse();
    fillRound(ctx, r, 10, C.panel, C.line);
    if (all.length === 0) {
      text(ctx, "Nothing recorded yet.", r.x + r.w / 2, r.y + r.h / 2, {
        size: 15,
        color: C.faint,
        align: "center",
        baseline: "middle",
      });
      return;
    }

    const rowH = 26;
    const visible = Math.floor((r.h - 46) / rowH);
    const maxScroll = Math.max(0, all.length - visible);
    if (f.input.wheel !== 0) this.logScroll += f.input.wheel;
    if (f.input.consume("arrowdown")) this.logScroll++;
    if (f.input.consume("arrowup")) this.logScroll--;
    this.logScroll = Math.max(0, Math.min(maxScroll, this.logScroll));

    text(ctx, "STARTED", r.x + 18, r.y + 24, { size: 9, color: C.faint, weight: "700" });
    text(ctx, "LASTED", r.x + 124, r.y + 24, { size: 9, color: C.faint, weight: "700" });
    text(ctx, "WHAT", r.x + 202, r.y + 24, { size: 9, color: C.faint, weight: "700" });
    text(ctx, "DETAIL", r.x + 372, r.y + 24, { size: 9, color: C.faint, weight: "700" });
    text(ctx, "RESULT", r.x + r.w - 18, r.y + 24, {
      size: 9,
      color: C.faint,
      weight: "700",
      align: "right",
    });

    all.slice(this.logScroll, this.logScroll + visible).forEach((rec, i) => {
      const y = r.y + 48 + i * rowH;
      if (i % 2 === 0) {
        fillRound(ctx, { x: r.x + 8, y: y - 15, w: r.w - 16, h: rowH - 2 }, 4, "rgba(255,255,255,0.02)");
      }
      const { what, detail, result, color } = describe(rec);
      const lasted = formatMinutes((rec.at - rec.startedAt) / 60_000);
      text(ctx, timeLabel(rec.startedAt), r.x + 18, y, { size: 12, color: C.faint, mono: true });
      text(ctx, lasted, r.x + 124, y, { size: 12, color: C.dim, mono: true });
      text(ctx, what, r.x + 202, y, { size: 12, color: C.text, weight: "600" });
      text(ctx, detail, r.x + 372, y, { size: 12, color: C.dim, maxWidth: r.w - 470 });
      text(ctx, result, r.x + r.w - 18, y, { size: 12, color, align: "right", mono: true, weight: "700" });
    });

    if (maxScroll > 0) {
      text(
        ctx,
        `${this.logScroll + 1}–${Math.min(all.length, this.logScroll + visible)} of ${all.length}  ·  scroll or arrows`,
        r.x + r.w / 2,
        r.y + r.h - 10,
        { size: 10, color: C.faint, align: "center" },
      );
    }
  }
}

function describe(rec: HistoryRecord): {
  what: string;
  detail: string;
  result: string;
  color: string;
} {
  if (rec.kind === "casino") {
    const reason =
      rec.reason === "walked" ? "walked out" : rec.reason === "backoff" ? "backed off" : "tapped out";
    return {
      what: rec.coop ? "Co-op session" : "Casino session",
      detail: `${rec.rounds} rounds · ${reason} · peak heat ${Math.round(rec.peakHeat)}`,
      result: `${rec.net >= 0 ? "+" : "-"}${money(Math.abs(rec.net))}`,
      color: rec.net >= 0 ? C.green : C.red,
    };
  }
  if (rec.kind === "shoe") {
    const acc = ratio(rec.checksCorrect, rec.checks);
    return {
      what: "Training shoe",
      detail: `${rec.decks}D · ${rec.players}p · ${rec.speed.toFixed(2)}s · counter ${rec.counter}${
        rec.inStep >= 0 ? ` · in step ${Math.round(rec.inStep * 100)}%` : ""
      }`,
      result: acc === null ? "--" : `${rec.checksCorrect}/${rec.checks}`,
      color: acc === null ? C.dim : acc > 0.9 ? C.green : acc > 0.6 ? C.gold : C.red,
    };
  }
  const acc = ratio(rec.right, rec.total);
  const bits: string[] = [];
  if (rec.groupSize) bits.push(`${rec.groupSize} at a time`);
  if (rec.cards) bits.push(`${rec.cards} cards${rec.perFlash && rec.perFlash > 1 ? ` · ${rec.perFlash} at a time` : ""}`);
  if (rec.deckSeconds) bits.push(`${rec.deckSeconds.toFixed(1)}s for the deck`);
  if (rec.msPerAnswer > 0) bits.push(`${(rec.msPerAnswer / 1000).toFixed(2)}s an answer`);
  bits.push(`best streak ${rec.bestStreak}`);
  return {
    what: DRILL_NAMES[rec.drill] ?? rec.drill,
    detail: bits.join(" · "),
    result: `${rec.right}/${rec.total}`,
    color: acc === null ? C.dim : acc > 0.9 ? C.green : acc > 0.7 ? C.gold : C.red,
  };
}

