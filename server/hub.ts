import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { Room, type Conn } from "./room";
import { randomSeed } from "../src/core/rng";
import {
  PROTOCOL_VERSION,
  SNAPSHOT_HZ,
  TICK_HZ,
  makeRoomCode,
  type ClientMessage,
  type ServerMessage,
} from "../src/net/protocol";

const ROOM_IDLE_MS = 10 * 60 * 1000;
const DROP_GRACE_MS = 45 * 1000;

interface Session {
  roomCode: string;
  playerId: string;
}

/**
 * Holds the rooms and pumps them. One process can host several tables' worth of
 * friends; rooms are thrown away once everyone has gone home.
 */
export class Hub {
  private rooms = new Map<string, Room>();
  private sessions = new Map<WebSocket, Session>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private snapshotAccumulator = 0;

  attach(server: import("node:http").Server, path = "/coop"): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req: IncomingMessage, socket, head) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
      } catch {
        return;
      }
      if (url.pathname !== path) return;
      wss.handleUpgrade(req, socket as never, head, (ws) => wss.emit("connection", ws, req));
    });
    wss.on("connection", (ws) => this.onConnection(ws));
    this.start();
    return wss;
  }

  start(): void {
    if (this.tickHandle) return;
    const dt = 1 / TICK_HZ;
    this.tickHandle = setInterval(() => this.tick(dt), 1000 / TICK_HZ);
  }

  stop(): void {
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = null;
  }

  private tick(dt: number): void {
    this.snapshotAccumulator += dt;
    const sendSnapshot = this.snapshotAccumulator >= 1 / SNAPSHOT_HZ;
    if (sendSnapshot) this.snapshotAccumulator = 0;

    const now = Date.now();
    for (const [code, room] of this.rooms) {
      room.tick(dt);

      for (const p of [...room.players.values()]) {
        if (!p.online && p.droppedAt !== null && now - p.droppedAt > DROP_GRACE_MS) {
          room.remove(p.id);
        }
      }

      if (sendSnapshot && room.players.size > 0) {
        const msg: ServerMessage = { t: "snapshot", room: room.snapshot() };
        room.broadcast(msg);
      }

      if (room.empty && now - room.lastActivity > ROOM_IDLE_MS) {
        this.rooms.delete(code);
      }
    }
  }

  private onConnection(ws: WebSocket): void {
    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return;
      }
      this.onMessage(ws, msg);
    });
    ws.on("close", () => {
      const s = this.sessions.get(ws);
      if (!s) return;
      this.sessions.delete(ws);
      this.rooms.get(s.roomCode)?.disconnect(s.playerId);
    });
    ws.on("error", () => ws.close());
  }

  private onMessage(ws: WebSocket, msg: ClientMessage): void {
    const session = this.sessions.get(ws);
    if (!session) {
      if (msg.t !== "hello") return;
      this.onHello(ws, msg);
      return;
    }
    const room = this.rooms.get(session.roomCode);
    if (!room) {
      send(ws, { t: "error", text: "That room is gone." });
      ws.close();
      return;
    }
    room.handle(session.playerId, msg);
  }

  private onHello(ws: WebSocket, msg: Extract<ClientMessage, { t: "hello" }>): void {
    if (msg.version !== PROTOCOL_VERSION) {
      send(ws, { t: "error", text: "Client and server versions do not match. Reload the page." });
      ws.close();
      return;
    }

    let room: Room;
    if (msg.code) {
      const code = String(msg.code).toUpperCase().trim();
      const found = this.rooms.get(code);
      if (!found) {
        send(ws, { t: "error", text: `No table found with code ${code}.` });
        ws.close();
        return;
      }
      if (found.full) {
        send(ws, { t: "error", text: "That table is full." });
        ws.close();
        return;
      }
      room = found;
    } else {
      let code = makeRoomCode(Math.random);
      let guard = 0;
      while (this.rooms.has(code) && guard++ < 50) code = makeRoomCode(Math.random);
      room = new Room(code, randomSeed());
      this.rooms.set(code, room);
    }

    const conn: Conn = {
      send: (m) => send(ws, m),
      close: () => ws.close(),
    };
    const player = room.join(conn, msg.name, msg.bankroll, msg.unit);
    this.sessions.set(ws, { roomCode: room.code, playerId: player.id });
    send(ws, {
      t: "welcome",
      code: room.code,
      youId: player.id,
      seed: room.seed,
      room: room.snapshot(),
    });
  }

  get roomCount(): number {
    return this.rooms.size;
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}
