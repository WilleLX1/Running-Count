import { clamp, dist, type Rect } from "../core/math";
import { pick, randRange, type Rng } from "../core/rng";
import { TABLE_PRESETS, type TableRules } from "../blackjack/rules";
import { TableSim, type SimHooks } from "../blackjack/sim";

export const WORLD_W = 1760;
export const WORLD_H = 1180;

export type FeatureKind =
  | "cashier"
  | "bar"
  | "restroom"
  | "exit"
  | "training"
  | "slots"
  | "pit"
  | "wall";

export interface Feature {
  kind: FeatureKind;
  rect: Rect;
  label: string;
  /** Where the player must stand to use it. */
  useX: number;
  useY: number;
}

export interface CasinoTable {
  id: string;
  x: number;
  y: number;
  rw: number;
  rh: number;
  rules: TableRules;
  /** Preset id, so a table can be named on the wire without shipping its rules. */
  rulesId: string;
  sim: TableSim;
  /** Seconds of game time since the player last watched this shoe. */
  awaySeconds: number;
  useX: number;
  useY: number;
}

export interface WanderNpc {
  x: number;
  y: number;
  tx: number;
  ty: number;
  speed: number;
  hue: number;
  pause: number;
  bob: number;
}

export interface Interaction {
  kind: FeatureKind | "table";
  label: string;
  table?: CasinoTable;
  feature?: Feature;
  x: number;
  y: number;
}

export class Casino {
  solids: Rect[] = [];
  features: Feature[] = [];
  tables: CasinoTable[] = [];
  npcs: WanderNpc[] = [];
  /** Pit boss walks toward the player's table as heat rises. */
  pitBoss = { x: WORLD_W / 2, y: 200, tx: WORLD_W / 2, ty: 200 };

  constructor(
    private rng: Rng,
    hooksFor: (table: CasinoTable) => SimHooks = () => ({}),
  ) {
    this.buildWalls();
    this.buildFeatures();
    this.buildTables(hooksFor);
    this.buildNpcs();
  }

  private buildWalls(): void {
    const t = 28;
    this.solids.push({ x: 0, y: 0, w: WORLD_W, h: t });
    this.solids.push({ x: 0, y: WORLD_H - t, w: WORLD_W, h: t });
    this.solids.push({ x: 0, y: 0, w: t, h: WORLD_H });
    this.solids.push({ x: WORLD_W - t, y: 0, w: t, h: WORLD_H });
  }

  private addFeature(f: Feature): void {
    this.features.push(f);
    this.solids.push(f.rect);
  }

  private buildFeatures(): void {
    this.addFeature({
      kind: "cashier",
      label: "Cashier cage",
      rect: { x: WORLD_W - 300, y: 28, w: 272, h: 96 },
      useX: WORLD_W - 164,
      useY: 158,
    });
    this.addFeature({
      kind: "bar",
      label: "Bar",
      rect: { x: 28, y: 28, w: 300, h: 92 },
      useX: 178,
      useY: 152,
    });
    this.addFeature({
      kind: "training",
      label: "Training room",
      rect: { x: WORLD_W / 2 - 90, y: 28, w: 180, h: 60 },
      useX: WORLD_W / 2,
      useY: 122,
    });
    this.addFeature({
      kind: "restroom",
      label: "Restroom",
      rect: { x: 28, y: WORLD_H - 190, w: 150, h: 162 },
      useX: 210,
      useY: WORLD_H - 110,
    });
    this.addFeature({
      kind: "exit",
      label: "Exit to the street",
      rect: { x: WORLD_W / 2 - 110, y: WORLD_H - 60, w: 220, h: 32 },
      useX: WORLD_W / 2,
      useY: WORLD_H - 100,
    });
    this.addFeature({
      kind: "pit",
      label: "Pit podium",
      rect: { x: WORLD_W / 2 - 70, y: 250, w: 140, h: 62 },
      useX: WORLD_W / 2,
      useY: 340,
    });

    // Decorative slot banks that also shape the walking routes.
    const slotRects: Rect[] = [
      { x: WORLD_W - 190, y: 300, w: 130, h: 220 },
      { x: WORLD_W - 190, y: 600, w: 130, h: 220 },
      { x: 60, y: 320, w: 130, h: 200 },
      { x: 60, y: 600, w: 130, h: 160 },
    ];
    for (const r of slotRects) {
      this.addFeature({
        kind: "slots",
        label: "Slot machines",
        rect: r,
        useX: r.x + r.w / 2,
        useY: r.y + r.h + 40,
      });
    }
  }

  private buildTables(hooksFor: (t: CasinoTable) => SimHooks): void {
    const layout = [
      { x: 470, y: 470, preset: 0 },
      { x: 900, y: 470, preset: 1 },
      { x: 1330, y: 470, preset: 3 },
      { x: 470, y: 860, preset: 1 },
      { x: 900, y: 860, preset: 0 },
      { x: 1330, y: 860, preset: 2 },
    ];
    let n = 0;
    for (const spot of layout) {
      const rules = TABLE_PRESETS[spot.preset];
      const rw = 200;
      const rh = 118;
      const table: CasinoTable = {
        id: `t${n++}`,
        x: spot.x,
        y: spot.y,
        rw,
        rh,
        rules,
        rulesId: rules.id,
        sim: null as unknown as TableSim,
        awaySeconds: 999,
        useX: spot.x,
        useY: spot.y + rh / 2 + 46,
      };
      table.sim = new TableSim(rules, this.rng, hooksFor(table));
      this.tables.push(table);
      this.solids.push({ x: spot.x - rw / 2, y: spot.y - rh / 2, w: rw, h: rh });
    }
  }

  private buildNpcs(): void {
    for (let i = 0; i < 14; i++) {
      const p = this.randomWalkable();
      this.npcs.push({
        x: p.x,
        y: p.y,
        tx: p.x,
        ty: p.y,
        speed: randRange(this.rng, 35, 70),
        hue: Math.floor(randRange(this.rng, 0, 360)),
        pause: randRange(this.rng, 0, 3),
        bob: randRange(this.rng, 0, 6.28),
      });
    }
  }

  randomWalkable(): { x: number; y: number } {
    for (let i = 0; i < 80; i++) {
      const x = randRange(this.rng, 60, WORLD_W - 60);
      const y = randRange(this.rng, 160, WORLD_H - 60);
      if (this.isFree(x, y, 16)) return { x, y };
    }
    return { x: WORLD_W / 2, y: WORLD_H - 160 };
  }

  isFree(x: number, y: number, r: number): boolean {
    for (const s of this.solids) {
      if (x + r > s.x && x - r < s.x + s.w && y + r > s.y && y - r < s.y + s.h) return false;
    }
    return true;
  }

  /** Circle-vs-rect resolve, one axis at a time so sliding feels right. */
  moveCircle(x: number, y: number, dx: number, dy: number, r: number): { x: number; y: number } {
    let nx = x + dx;
    if (!this.isFree(nx, y, r)) nx = x;
    let ny = y + dy;
    if (!this.isFree(nx, ny, r)) ny = y;
    return {
      x: clamp(nx, r, WORLD_W - r),
      y: clamp(ny, r, WORLD_H - r),
    };
  }

  updateNpcs(dt: number): void {
    for (const n of this.npcs) {
      n.bob += dt * 6;
      if (n.pause > 0) {
        n.pause -= dt;
        continue;
      }
      const d = dist(n.x, n.y, n.tx, n.ty);
      if (d < 8) {
        const p = this.randomWalkable();
        n.tx = p.x;
        n.ty = p.y;
        n.pause = randRange(this.rng, 0.4, 4);
        continue;
      }
      const vx = ((n.tx - n.x) / d) * n.speed * dt;
      const vy = ((n.ty - n.y) / d) * n.speed * dt;
      const moved = this.moveCircle(n.x, n.y, vx, vy, 12);
      if (Math.abs(moved.x - n.x) < 0.01 && Math.abs(moved.y - n.y) < 0.01) {
        const p = this.randomWalkable();
        n.tx = p.x;
        n.ty = p.y;
      }
      n.x = moved.x;
      n.y = moved.y;
    }
  }

  nearestInteraction(x: number, y: number, range = 62): Interaction | null {
    let best: Interaction | null = null;
    let bestD = range;
    for (const t of this.tables) {
      const d = dist(x, y, t.useX, t.useY);
      if (d < bestD) {
        bestD = d;
        best = {
          kind: "table",
          label: `${t.rules.name}`,
          table: t,
          x: t.useX,
          y: t.useY,
        };
      }
    }
    for (const f of this.features) {
      if (f.kind === "slots" || f.kind === "wall" || f.kind === "pit") continue;
      const d = dist(x, y, f.useX, f.useY);
      if (d < bestD) {
        bestD = d;
        best = { kind: f.kind, label: f.label, feature: f, x: f.useX, y: f.useY };
      }
    }
    return best;
  }

  randomTableName(): string {
    return pick(this.tables, this.rng).rules.name;
  }
}
