import type { TableSim } from "../blackjack/sim";
import { clockToWire, type SeatView, type TableView } from "./protocol";

/**
 * Snapshot of a table. Everything the renderer needs and nothing it does not --
 * notably not the undealt shoe, which the client has no business seeing.
 */
export function viewTable(id: string, rulesId: string, sim: TableSim): TableView {
  return {
    id,
    rules: rulesId,
    phase: sim.phase,
    round: sim.round,
    seats: sim.seats.map(viewSeat),
    dealer: {
      cards: sim.dealer.holeHidden ? sim.dealer.cards.slice(0, 1) : sim.dealer.cards.slice(),
      holeHidden: sim.dealer.holeHidden,
    },
    timer: round2(sim.timer),
    clock: round2(clockToWire(sim.clock)),
    runningCount: sim.count.running,
    decksRemaining: round2(sim.shoe.decksRemaining),
    decksDealt: round2(sim.shoe.decksDealt),
    fractionDealt: round2(sim.shoe.fractionDealt),
    cutCardOut: sim.shoe.cutCardOut,
    actor: sim.currentActor(),
  };
}

function viewSeat(s: TableSim["seats"][number]): SeatView {
  return {
    index: s.index,
    kind: s.kind,
    name: s.name,
    playerId: s.playerId,
    bet: s.bet,
    pendingBet: s.pendingBet,
    betLocked: s.betLocked,
    sittingOut: s.sittingOut,
    hands: s.hands,
    active: s.active,
    insurance: s.insurance,
    insuranceAnswered: s.insuranceAnswered,
    flash: s.flash,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The hole card is withheld from the wire, so the client renders a face-down
 * placeholder in its slot.
 */
export function dealerCardsForRender(view: TableView): { cards: TableView["dealer"]["cards"]; hideIndex: number } {
  if (!view.dealer.holeHidden) return { cards: view.dealer.cards, hideIndex: -1 };
  const cards = view.dealer.cards.slice();
  if (cards.length === 1) {
    // Stand-in for the card the server is not sending us.
    cards.push({ rank: "A", suit: "S", id: -1 });
    return { cards, hideIndex: 1 };
  }
  return { cards, hideIndex: -1 };
}
