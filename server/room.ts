import { Casino, WORLD_H, WORLD_W, type CasinoTable } from "../src/world/casino";
import { Surveillance } from "../src/heat/surveillance";
import { mulberry32, randomSeed, type Rng } from "../src/core/rng";
import { viewTable } from "../src/net/serialize";
import { clamp } from "../src/core/math";
import type { RoundSummary } from "../src/blackjack/sim";
import {
  MAX_PLAYERS,
  SIGNAL_TEXT,
  type ClientMessage,
  type CoverKind,
  type PlayerView,
  type RoomView,
  type ServerMessage,
  type SignalView,
  type TableBrief,
} from "../src/net/protocol";

/** Minutes of casino time per real second. */
const TIME_SCALE = 12;
/** Seconds between the pit deciding and the suits arriving. */
const BACKOFF_GRACE = 7;
// Kept clear of the gold used for "you" so nobody is mistaken for themselves.
const HUES = [200, 320, 140, 25];

export interface Conn {
  send(msg: ServerMessage): void;
  close(): void;
}

export interface ServerPlayer {
  id: string;
  name: string;
  hue: number;
  conn: Conn | null;
  online: boolean;
  x: number;
  y: number;
  account: { bankroll: number };
  unit: number;
  tableId: string | null;
  heat: Surveillance;
  backoffAt: number | null;
  droppedAt: number | null;
}

let nextPlayerId = 1;

export class Room {
  readonly casino: Casino;
  readonly players = new Map<string, ServerPlayer>();
  clock = 0;
  now = 0;
  signals: SignalView[] = [];
  lastActivity = Date.now();

  private rng: Rng;

  constructor(
    readonly code: string,
    readonly seed: number = randomSeed(),
  ) {
    this.rng = mulberry32(seed);
    this.casino = new Casino(this.rng, (table) => ({
      onRoundEnd: (s) => this.onRoundEnd(table, s),
      onShuffle: (before) => this.onShuffle(table, before),
      onMessage: (text, color) => this.broadcast({ t: "event", text, color }),
    }));
  }

  get empty(): boolean {
    return this.players.size === 0;
  }

  get full(): boolean {
    return this.players.size >= MAX_PLAYERS;
  }

  // ------------------------------------------------------------- lifecycle

  join(conn: Conn, name: string, bankroll: number, unit: number): ServerPlayer {
    const id = `p${nextPlayerId++}`;
    const used = new Set([...this.players.values()].map((p) => p.hue));
    const hue = HUES.find((h) => !used.has(h)) ?? HUES[this.players.size % HUES.length];
    const player: ServerPlayer = {
      id,
      name: (name || "Player").slice(0, 14),
      hue,
      conn,
      online: true,
      x: WORLD_W / 2 - 250 + this.players.size * 46,
      y: WORLD_H - 120,
      account: { bankroll: Math.max(100, Math.round(bankroll)) },
      unit: Math.max(1, Math.round(unit)),
      tableId: null,
      heat: new Surveillance(),
      backoffAt: null,
      droppedAt: null,
    };
    this.players.set(id, player);
    this.lastActivity = Date.now();
    this.broadcast({
      t: "event",
      text: `${player.name} walks in.`,
      color: "#5aa9e6",
    });
    return player;
  }

  /** A dropped player keeps their seat and chips for a short grace period. */
  disconnect(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    p.online = false;
    p.conn = null;
    p.droppedAt = Date.now();
    this.broadcast({ t: "event", text: `${p.name} lost connection.`, color: "#e0554b" });
  }

  remove(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.standUp(p);
    this.players.delete(id);
  }

  // ---------------------------------------------------------------- input

  handle(id: string, msg: ClientMessage): void {
    const p = this.players.get(id);
    if (!p) return;
    this.lastActivity = Date.now();
    switch (msg.t) {
      case "move":
        p.x = clamp(Number(msg.x) || 0, 0, WORLD_W);
        p.y = clamp(Number(msg.y) || 0, 0, WORLD_H);
        break;
      case "sit":
        this.sit(p, String(msg.tableId));
        break;
      case "stand":
        this.standUp(p);
        break;
      case "bet": {
        const t = this.tableOf(p);
        t?.sim.setBet(p.id, Number(msg.amount) || 0);
        break;
      }
      case "deal": {
        const t = this.tableOf(p);
        t?.sim.confirmBet(p.id);
        break;
      }
      case "sitout": {
        const t = this.tableOf(p);
        t?.sim.setSittingOut(p.id, !!msg.v);
        break;
      }
      case "act": {
        const t = this.tableOf(p);
        t?.sim.act(p.id, msg.action);
        break;
      }
      case "insurance": {
        const t = this.tableOf(p);
        t?.sim.answerInsurance(p.id, !!msg.take);
        break;
      }
      case "cover":
        this.cover(p, msg.kind);
        break;
      case "signal":
        this.signal(p, msg);
        break;
      case "ping":
        p.conn?.send({ t: "pong" });
        break;
      default:
        break;
    }
  }

  private tableOf(p: ServerPlayer): CasinoTable | null {
    if (!p.tableId) return null;
    return this.casino.tables.find((t) => t.id === p.tableId) ?? null;
  }

  private sit(p: ServerPlayer, tableId: string): void {
    if (p.tableId) return;
    const table = this.casino.tables.find((t) => t.id === tableId);
    if (!table) return;
    if (p.heat.barred) {
      p.conn?.send({ t: "event", text: "The pit will not deal to you any more.", color: "#e0554b" });
      return;
    }
    const teammatesHere = table.sim.humans().length > 0;
    let index = table.sim.bestFreeSeat();
    if (index === null && teammatesHere) {
      // Make room so a team can work the same shoe together.
      const npc = table.sim.seats.find((s) => s.kind === "npc" && s.hands.length === 0);
      if (npc) index = npc.index;
    }
    if (index === null) {
      p.conn?.send({ t: "event", text: "No open seats at that table.", color: "#f0c14b" });
      return;
    }
    // Hands dealt while nobody was watching have moved the count.
    if (!teammatesHere && table.awaySeconds > 45) {
      table.sim.burnUnseen(Math.floor(table.awaySeconds / 45));
    }
    table.awaySeconds = 0;
    const ok = table.sim.sit(index, { playerId: p.id, name: p.name, account: p.account }, true);
    if (!ok) {
      p.conn?.send({ t: "event", text: "That seat was taken.", color: "#f0c14b" });
      return;
    }
    p.tableId = table.id;
    this.broadcast({
      t: "event",
      text: `${p.name} sits down at ${table.rules.name}.`,
      color: "#8fa3b5",
      playerId: p.id,
    });
  }

  private standUp(p: ServerPlayer): void {
    const table = this.tableOf(p);
    if (table) table.sim.standUp(p.id);
    p.tableId = null;
    p.heat.leaveTable();
    if (p.backoffAt !== null) {
      // Colouring up before they reach you costs you your anonymity, not your night.
      p.backoffAt = null;
      p.heat.backoffPending = false;
      p.heat.suspicion = 72;
      p.heat.recognition = Math.min(100, p.heat.recognition + 25);
      this.broadcast({
        t: "event",
        text: `${p.name} colours up and walks before the suits arrive.`,
        color: "#ff7a45",
      });
    }
  }

  private cover(p: ServerPlayer, kind: CoverKind): void {
    switch (kind) {
      case "tip": {
        const cost = Math.max(5, Math.round(p.unit / 2));
        if (p.account.bankroll <= cost) return;
        p.account.bankroll -= cost;
        p.heat.applyCover(6, "tipped the dealer");
        this.broadcast({ t: "event", text: `${p.name} tips the dealer.`, color: "#a98bd6" });
        break;
      }
      case "drink": {
        if (p.account.bankroll < 15) return;
        p.account.bankroll -= 15;
        p.heat.applyCover(9, "ordered a drink");
        this.advanceClock(15);
        this.broadcast({ t: "event", text: `${p.name} orders a drink.`, color: "#8fa3b5" });
        break;
      }
      case "break": {
        p.heat.applyCover(15, "took a break");
        this.advanceClock(20);
        this.broadcast({ t: "event", text: `${p.name} takes twenty off the floor.`, color: "#8fa3b5" });
        break;
      }
      case "cashier": {
        p.heat.applyCover(5, "coloured up");
        this.advanceClock(10);
        if (p.account.bankroll >= 10000) {
          p.heat.recognition = Math.min(100, p.heat.recognition + 12);
          p.conn?.send({
            t: "event",
            text: "They fill out a currency transaction report. Your name is on file now.",
            color: "#ff7a45",
          });
        }
        break;
      }
      default:
        break;
    }
  }

  private signal(p: ServerPlayer, msg: Extract<ClientMessage, { t: "signal" }>): void {
    const view: SignalView = {
      from: p.id,
      fromName: p.name,
      hue: p.hue,
      kind: msg.kind,
      running: typeof msg.running === "number" ? Math.round(msg.running) : undefined,
      trueCount:
        typeof msg.trueCount === "number" ? Math.round(msg.trueCount * 10) / 10 : undefined,
      tableId: p.tableId,
      at: this.now,
    };
    this.signals.unshift(view);
    if (this.signals.length > 6) this.signals.pop();
    const body =
      msg.kind === "count"
        ? `${SIGNAL_TEXT.count} ${view.running !== undefined ? signed(view.running) : "?"} running${
            view.trueCount !== undefined ? `, ${signed(view.trueCount)} true` : ""
          }`
        : SIGNAL_TEXT[msg.kind];
    this.broadcast({ t: "event", text: `${p.name}: ${body}`, color: "#5aa9e6", playerId: p.id });
  }

  advanceClock(minutes: number): void {
    this.clock += minutes;
    for (const t of this.casino.tables) {
      if (t.sim.humans().length === 0) t.awaySeconds += minutes * 60;
    }
  }

  // ----------------------------------------------------------------- tick

  tick(dt: number): void {
    this.now += dt;
    this.clock += dt * TIME_SCALE;

    for (const table of this.casino.tables) {
      if (table.sim.humans().length > 0) {
        table.sim.update(dt);
        table.awaySeconds = 0;
      } else {
        table.awaySeconds += dt;
      }
    }

    for (const p of this.players.values()) {
      p.heat.update(dt, p.tableId !== null);
      if (p.heat.backoffPending && p.backoffAt === null) {
        p.backoffAt = this.now;
        this.broadcast({
          t: "event",
          text: `Two suits are walking toward ${p.name}.`,
          color: "#e0554b",
          playerId: p.id,
        });
      }
      if (p.backoffAt !== null && this.now - p.backoffAt > BACKOFF_GRACE) {
        this.backOff(p);
      }
    }
  }

  private backOff(p: ServerPlayer): void {
    p.backoffAt = null;
    p.heat.backoffPending = false;
    p.heat.barred = true;
    const table = this.tableOf(p);
    if (table) table.sim.standUp(p.id);
    p.tableId = null;
    p.conn?.send({ t: "backoff", playerId: p.id });
    this.broadcast({
      t: "event",
      text: `${p.name} has been backed off. The rest of you are still welcome.`,
      color: "#e0554b",
      playerId: p.id,
    });
  }

  private onRoundEnd(table: CasinoTable, s: RoundSummary): void {
    if (!s.playerId) return;
    const p = this.players.get(s.playerId);
    if (!p) return;
    p.heat.observe(s, table.rules, p.unit);
    p.conn?.send({ t: "round", summary: s });
  }

  private onShuffle(table: CasinoTable, runningBefore: number): void {
    this.broadcast({ t: "shuffle", tableId: table.id, runningBefore });
  }

  // ------------------------------------------------------------- snapshots

  snapshot(): RoomView {
    const players: PlayerView[] = [];
    for (const p of this.players.values()) {
      const seat = p.tableId
        ? (this.tableOf(p)?.sim.seatOf(p.id)?.index ?? null)
        : null;
      players.push({
        id: p.id,
        name: p.name,
        x: Math.round(p.x),
        y: Math.round(p.y),
        hue: p.hue,
        bankroll: Math.round(p.account.bankroll),
        tableId: p.tableId,
        seat,
        suspicion: Math.round(p.heat.suspicion * 10) / 10,
        attention: p.heat.attention,
        breakdown: p.heat.breakdown,
        online: p.online,
        backoffIn:
          p.backoffAt === null ? -1 : Math.max(0, BACKOFF_GRACE - (this.now - p.backoffAt)),
      });
    }

    const tables = this.casino.tables
      .filter((t) => t.sim.humans().length > 0)
      .map((t) => viewTable(t.id, t.rulesId, t.sim));

    const briefs: TableBrief[] = this.casino.tables.map((t) => ({
      id: t.id,
      rules: t.rulesId,
      seats: t.sim.seats.map((s) => s.kind),
      humans: t.sim.seats.filter((s) => s.playerId).map((s) => s.playerId!),
    }));

    return {
      code: this.code,
      clock: Math.round(this.clock),
      players,
      tables,
      briefs,
      signals: this.signals,
      now: Math.round(this.now * 10) / 10,
    };
  }

  broadcast(msg: ServerMessage): void {
    for (const p of this.players.values()) p.conn?.send(msg);
  }
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
