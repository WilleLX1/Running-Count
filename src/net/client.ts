import type { RoundSummary } from "../blackjack/sim";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type PlayerView,
  type RoomView,
  type ServerMessage,
  type SignalKind,
  type TableView,
} from "./protocol";

export type NetStatus = "idle" | "connecting" | "joining" | "live" | "closed" | "error";

export interface NetEvents {
  onWelcome?: (code: string, youId: string) => void;
  onEvent?: (text: string, color: string, playerId?: string) => void;
  onRound?: (s: RoundSummary) => void;
  onShuffle?: (tableId: string, runningBefore: number) => void;
  onBackoff?: (playerId: string) => void;
  onError?: (text: string) => void;
  onClosed?: () => void;
}

function serverUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/coop`;
}

/**
 * Thin client: it holds the latest room snapshot and posts intents. Nothing in
 * here decides anything about the game.
 */
export class NetClient {
  status: NetStatus = "idle";
  code = "";
  youId = "";
  seed = 0;
  room: RoomView | null = null;
  lastError = "";
  /** Local betting intent, echoed ahead of the server for responsiveness. */
  pendingBet = 0;

  private ws: WebSocket | null = null;
  private moveTimer = 0;
  private lastSentX = -1;
  private lastSentY = -1;
  private lastPhase = new Map<string, string>();

  constructor(public events: NetEvents = {}) {}

  connect(name: string, code: string | undefined, bankroll: number, unit: number): void {
    this.close();
    this.status = "connecting";
    this.lastError = "";
    let ws: WebSocket;
    try {
      ws = new WebSocket(serverUrl());
    } catch (err) {
      this.fail(String(err));
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.status = "joining";
      this.send({ t: "hello", version: PROTOCOL_VERSION, name, code, bankroll, unit });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onerror = () => {
      if (this.status !== "live") this.fail("Could not reach the co-op server.");
    };
    ws.onclose = () => {
      if (this.status === "live") {
        this.status = "closed";
        this.events.onClosed?.();
      } else if (this.status !== "error") {
        this.fail("The connection closed before the table was ready.");
      }
      this.ws = null;
    };
  }

  private fail(text: string): void {
    this.status = "error";
    this.lastError = text;
    this.events.onError?.(text);
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.status = "live";
        this.code = msg.code;
        this.youId = msg.youId;
        this.seed = msg.seed;
        this.room = msg.room;
        this.events.onWelcome?.(msg.code, msg.youId);
        break;
      case "snapshot": {
        this.room = msg.room;
        // Re-sync the local bet intent whenever a new betting window opens.
        for (const t of msg.room.tables) {
          const was = this.lastPhase.get(t.id);
          this.lastPhase.set(t.id, t.phase);
          if (was !== "betting" && t.phase === "betting") {
            const seat = t.seats.find((s) => s.playerId === this.youId);
            if (seat) this.pendingBet = seat.pendingBet;
          }
        }
        break;
      }
      case "event":
        this.events.onEvent?.(msg.text, msg.color, msg.playerId);
        break;
      case "round":
        this.events.onRound?.(msg.summary);
        break;
      case "shuffle":
        this.events.onShuffle?.(msg.tableId, msg.runningBefore);
        break;
      case "backoff":
        this.events.onBackoff?.(msg.playerId);
        break;
      case "error":
        this.fail(msg.text);
        break;
      case "pong":
        break;
    }
  }

  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  setPendingBet(amount: number): void {
    this.pendingBet = Math.max(0, Math.round(amount));
  }

  /** Position updates are rate limited; nothing depends on them being exact. */
  reportPosition(x: number, y: number, dt: number): void {
    this.moveTimer -= dt;
    if (this.moveTimer > 0) return;
    if (Math.abs(x - this.lastSentX) < 2 && Math.abs(y - this.lastSentY) < 2) return;
    this.moveTimer = 1 / 12;
    this.lastSentX = x;
    this.lastSentY = y;
    this.send({ t: "move", x: Math.round(x), y: Math.round(y) });
  }

  signal(kind: SignalKind, running?: number, trueCount?: number): void {
    this.send({ t: "signal", kind, running, trueCount });
  }

  get me(): PlayerView | null {
    return this.room?.players.find((p) => p.id === this.youId) ?? null;
  }

  get teammates(): PlayerView[] {
    return this.room?.players.filter((p) => p.id !== this.youId) ?? [];
  }

  table(id: string): TableView | null {
    return this.room?.tables.find((t) => t.id === id) ?? null;
  }

  close(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.status = "idle";
    this.room = null;
    this.lastPhase.clear();
  }
}
