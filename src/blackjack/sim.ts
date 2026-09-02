import { cardValue, type Card } from "./cards";
import { CountState } from "./counting";
import {
  handTotal,
  isBlackjack,
  legalActions,
  newHand,
  type Hand,
  type HandResult,
} from "./hand";
import type { TableRules } from "./rules";
import { Shoe } from "./shoe";
import { basicStrategy, dealerValue, type Action } from "./strategy";
import { pick, randRange, type Rng } from "../core/rng";

export type Phase =
  | "betting"
  | "dealing"
  | "insurance"
  | "playing"
  | "dealer"
  | "settle"
  | "shuffle";

export interface NpcBrain {
  /** 0..1 chance of playing correct basic strategy. */
  skill: number;
  /** Bet size multiplier vs table minimum. */
  aggression: number;
  /** Drives insurance, hunches and chatter. */
  superstition: number;
}

export interface PlayerAccount {
  bankroll: number;
}

export interface Seat {
  index: number;
  kind: "empty" | "human" | "npc";
  name: string;
  /** Set for human seats. Local solo play uses the id "you". */
  playerId: string | null;
  /** Chips in the circle for the round in progress. */
  bet: number;
  /** Chips pushed out but not yet committed. */
  pendingBet: number;
  betLocked: boolean;
  sittingOut: boolean;
  hands: Hand[];
  active: number;
  insurance: number;
  insuranceAnswered: boolean;
  /** NPC chip tray. Humans draw on their own account. */
  chips: number;
  account: PlayerAccount | null;
  npc?: NpcBrain;
  flash?: { text: string; color: string; t: number };
  /** Everything this seat has put at risk this round, insurance included. */
  staked: number;
  queuedAction: Action | null;
  /**
   * Stood up while their cards were already out. The hand is played to the end
   * and paid to their account, then the seat empties.
   */
  leaving: boolean;
}

export interface RoundSummary {
  round: number;
  seatIndex: number;
  playerId: string | null;
  bet: number;
  net: number;
  /** True count at the moment the bet was locked in -- what surveillance correlates against. */
  trueCountAtBet: number;
  runningCountAtBet: number;
  decksRemaining: number;
  results: HandResult[];
  insuranceTaken: boolean;
  handsPlayed: number;
  satOut: boolean;
}

export interface SimHooks {
  onCardRevealed?: (c: Card) => void;
  /** Fires once per seated human per round, including rounds they sat out. */
  onRoundEnd?: (s: RoundSummary) => void;
  /** Carries the running count as it stood before the wash. */
  onShuffle?: (runningBefore: number) => void;
  onPhase?: (p: Phase) => void;
  onMessage?: (text: string, color: string) => void;
}

export interface SitRequest {
  playerId: string;
  name: string;
  account: PlayerAccount;
}

const NPC_NAMES = [
  "Delores",
  "Big Ray",
  "Tomas",
  "Sun-Hee",
  "Krishnan",
  "Wanda",
  "Marco",
  "Old Pete",
  "Bev",
  "Andrei",
  "Lucia",
  "Chip",
];

/** Seconds a table will wait on a human before dealing around them. */
const BET_CLOCK = 20;
const DECISION_CLOCK = 30;
const INSURANCE_CLOCK = 12;

/**
 * Drives one blackjack table with any mix of humans and NPCs in the seats.
 * Deterministic given (seed, seat actions) and advanced purely by update(dt),
 * so the co-op server runs this exact class and broadcasts the result.
 */
export class TableSim {
  readonly shoe: Shoe;
  readonly count = new CountState();
  phase: Phase = "betting";
  seats: Seat[] = [];
  dealer: { cards: Card[]; holeHidden: boolean } = { cards: [], holeHidden: true };

  round = 0;
  timer = 0;
  /** Counts down while the table waits on a human. Infinity when it will wait forever. */
  clock = Infinity;

  private dt = 0;
  private dealQueue: { seat: number; hidden: boolean }[] = [];
  private trueCountAtBet = 0;
  private runningCountAtBet = 0;
  private decksAtBet = 0;
  private dealerPeeked = false;

  constructor(
    public rules: TableRules,
    private rng: Rng,
    public hooks: SimHooks = {},
  ) {
    this.shoe = new Shoe(rules.decks, rules.penetration, rng);
    this.seats = Array.from({ length: rules.seats }, (_, i) => this.makeSeat(i));
    this.populateNpcs();
  }

  // ---------------------------------------------------------------- seating

  private makeSeat(index: number): Seat {
    return {
      index,
      kind: "empty",
      name: "",
      playerId: null,
      bet: 0,
      pendingBet: 0,
      betLocked: false,
      sittingOut: false,
      hands: [],
      active: 0,
      insurance: 0,
      insuranceAnswered: false,
      chips: 0,
      account: null,
      staked: 0,
      queuedAction: null,
      leaving: false,
    };
  }

  private populateNpcs(): void {
    const used = new Set<string>();
    for (const seat of this.seats) {
      if (this.rng() < 0.55) {
        let name = pick(NPC_NAMES, this.rng);
        let guard = 0;
        while (used.has(name) && guard++ < 20) name = pick(NPC_NAMES, this.rng);
        used.add(name);
        this.makeNpc(seat, name);
      }
    }
  }

  private makeNpc(seat: Seat, name: string): void {
    seat.kind = "npc";
    seat.name = name;
    seat.playerId = null;
    seat.account = null;
    seat.chips = this.rules.minBet * randRange(this.rng, 15, 60);
    seat.npc = {
      skill: randRange(this.rng, 0.5, 0.97),
      aggression: randRange(this.rng, 1, 3.5),
      superstition: this.rng(),
    };
  }

  freeSeats(): number[] {
    return this.seats.filter((s) => s.kind === "empty").map((s) => s.index);
  }

  humans(): Seat[] {
    return this.seats.filter((s) => s.kind === "human");
  }

  /** Includes a seat whose owner has walked but whose hand is still live. */
  private seatFor(playerId: string): Seat | null {
    return this.seats.find((s) => s.kind === "human" && s.playerId === playerId) ?? null;
  }

  seatOf(playerId: string): Seat | null {
    const seat = this.seatFor(playerId);
    return seat && !seat.leaving ? seat : null;
  }

  /**
   * Sit a human down. With bumpNpc the table will move an NPC along so that
   * teammates can get onto the same felt.
   */
  sit(index: number, who: SitRequest, bumpNpc = false): boolean {
    const seat = this.seats[index];
    if (!seat) return false;
    if (seat.kind === "human") return false;
    if (seat.kind === "npc") {
      if (!bumpNpc || seat.hands.length > 0) return false;
      this.message(`${seat.name} colours up and wanders off.`, "#8fa3b5");
    }
    const keep = this.makeSeat(index);
    Object.assign(seat, keep);
    seat.kind = "human";
    seat.name = who.name;
    seat.playerId = who.playerId;
    seat.account = who.account;
    seat.pendingBet = Math.max(this.rules.minBet, Math.min(who.account.bankroll, this.rules.minBet));
    // Joining mid-round means watching this one out.
    seat.sittingOut = this.phase !== "betting";
    return true;
  }

  /** Best open seat for a newcomer: third base first, then anywhere. */
  bestFreeSeat(): number | null {
    const free = this.freeSeats();
    if (free.length > 0) return free[free.length - 1];
    return null;
  }

  standUp(playerId: string): void {
    const seat = this.seatFor(playerId);
    if (!seat) return;
    if (this.phase === "betting" || seat.bet <= 0) {
      Object.assign(seat, this.makeSeat(seat.index));
      return;
    }
    // You cannot pull a bet back once the cards are out. The dealer plays the
    // hand for you and the seat clears at the end of the round.
    seat.leaving = true;
    seat.queuedAction = null;
    this.message(`${seat.name} leaves their bet in the circle.`, "#8fa3b5");
  }

  // ------------------------------------------------------------ player API

  setBet(playerId: string, amount: number): void {
    const seat = this.seatOf(playerId);
    if (!seat || this.phase !== "betting" || seat.betLocked) return;
    const bankroll = seat.account?.bankroll ?? 0;
    seat.pendingBet = Math.max(0, Math.min(this.rules.maxBet, Math.min(amount, bankroll)));
  }

  addBet(playerId: string, delta: number): void {
    const seat = this.seatOf(playerId);
    if (!seat) return;
    this.setBet(playerId, seat.pendingBet + delta);
  }

  confirmBet(playerId: string): boolean {
    const seat = this.seatOf(playerId);
    if (!seat || this.phase !== "betting") return false;
    if (seat.pendingBet < this.rules.minBet) return false;
    if (seat.pendingBet > (seat.account?.bankroll ?? 0)) return false;
    seat.betLocked = true;
    seat.sittingOut = false;
    return true;
  }

  /** Wong out: skip this round but keep watching the shoe. */
  setSittingOut(playerId: string, v: boolean): void {
    const seat = this.seatOf(playerId);
    if (!seat || this.phase !== "betting") return;
    seat.sittingOut = v;
    if (v) seat.betLocked = false;
  }

  act(playerId: string, action: Action): void {
    if (this.phase !== "playing") return;
    const actor = this.currentActor();
    if (!actor) return;
    const seat = this.seats[actor.seat];
    if (seat.kind !== "human" || seat.playerId !== playerId || seat.leaving) return;
    seat.queuedAction = action;
  }

  answerInsurance(playerId: string, take: boolean): void {
    const seat = this.seatOf(playerId);
    if (!seat || this.phase !== "insurance" || seat.insuranceAnswered) return;
    if (take) {
      const amount = Math.floor(seat.bet / 2);
      if (amount > 0 && (seat.account?.bankroll ?? 0) >= amount) {
        seat.account!.bankroll -= amount;
        seat.staked += amount;
        seat.insurance = amount;
        this.message(`${seat.name} takes insurance.`, "#f0c14b");
      }
    }
    seat.insuranceAnswered = true;
  }

  /** True when this seat still owes the table an insurance decision. */
  offeringInsuranceTo(playerId: string): boolean {
    if (this.phase !== "insurance") return false;
    const seat = this.seatOf(playerId);
    return !!seat && seat.bet > 0 && !seat.insuranceAnswered;
  }

  // ------------------------------------------------------------- main loop

  update(dt: number): void {
    this.dt = dt;
    if (this.timer > 0) {
      this.timer -= dt;
      if (this.timer > 0) {
        this.tickFlashes(dt);
        return;
      }
      this.timer = 0;
    }
    this.tickFlashes(dt);

    switch (this.phase) {
      case "betting":
        this.stepBetting();
        break;
      case "dealing":
        this.stepDealing();
        break;
      case "insurance":
        this.stepInsurance();
        break;
      case "playing":
        this.stepPlaying();
        break;
      case "dealer":
        this.stepDealer();
        break;
      case "settle":
        this.stepSettle();
        break;
      case "shuffle":
        this.stepShuffle();
        break;
    }
  }

  private tickFlashes(dt: number): void {
    for (const s of this.seats) {
      if (s.flash) {
        s.flash.t -= dt;
        if (s.flash.t <= 0) s.flash = undefined;
      }
    }
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.hooks.onPhase?.(p);
  }

  private message(text: string, color = "#e7edf3"): void {
    this.hooks.onMessage?.(text, color);
  }

  /**
   * A lone human gets all the time in the world; once there is a team at the
   * table the dealer starts counting, so nobody can stall the shoe.
   */
  private startClock(seconds: number): void {
    this.clock = this.humans().length > 1 ? seconds : Infinity;
  }

  // ------------------------------------------------------------ phase steps

  private stepBetting(): void {
    for (const s of this.seats) {
      if (s.kind === "npc" && s.bet === 0) s.bet = this.npcBet(s);
    }

    const waiting = this.seats.filter(
      (s) => s.kind === "human" && !s.betLocked && !s.sittingOut,
    );
    if (waiting.length > 0) {
      if (this.clock === Infinity) return;
      this.clock -= this.dt;
      if (this.clock > 0) return;
      for (const s of waiting) {
        s.sittingOut = true;
        this.message(`${s.name} misses the hand.`, "#8fa3b5");
      }
    }
    this.clock = Infinity;

    for (const seat of this.seats) {
      if (seat.kind !== "human") continue;
      if (seat.betLocked && seat.pendingBet >= this.rules.minBet) {
        seat.bet = seat.pendingBet;
        seat.account!.bankroll -= seat.pendingBet;
        seat.staked = seat.pendingBet;
      } else {
        seat.bet = 0;
        seat.staked = 0;
      }
    }

    this.trueCountAtBet = this.count.trueCount(this.shoe.decksRemaining);
    this.runningCountAtBet = this.count.running;
    this.decksAtBet = this.shoe.decksRemaining;

    this.dealer = { cards: [], holeHidden: true };
    this.dealerPeeked = false;
    for (const s of this.seats) {
      s.hands = [];
      s.active = 0;
      s.insurance = 0;
      s.insuranceAnswered = false;
      s.queuedAction = null;
      if (s.bet > 0) s.hands.push(newHand(s.bet));
    }

    const live = this.seats.filter((s) => s.bet > 0).map((s) => s.index);
    this.dealQueue = [];
    for (const i of live) this.dealQueue.push({ seat: i, hidden: false });
    this.dealQueue.push({ seat: -1, hidden: false });
    for (const i of live) this.dealQueue.push({ seat: i, hidden: false });
    this.dealQueue.push({ seat: -1, hidden: true });

    if (live.length === 0) {
      // Nobody has a bet out -- the table idles rather than burning the shoe.
      this.timer = 0.6;
      return;
    }

    this.round++;
    this.setPhase("dealing");
    this.timer = 0.25;
  }

  private stepDealing(): void {
    const next = this.dealQueue.shift();
    if (!next) {
      this.afterDeal();
      return;
    }
    const card = this.shoe.draw();
    if (next.seat === -1) {
      this.dealer.cards.push(card);
      if (next.hidden) this.dealer.holeHidden = true;
      else this.reveal(card);
    } else {
      this.seats[next.seat].hands[0].cards.push(card);
      this.reveal(card);
    }
    this.timer = this.rules.dealSpeed;
  }

  private afterDeal(): void {
    const up = this.dealer.cards[0];
    if (dealerValue(up) === 11) {
      for (const s of this.seats) {
        if (s.kind === "npc" && s.bet > 0 && s.npc && this.rng() < s.npc.superstition * 0.5) {
          s.insurance = Math.floor(s.bet / 2);
          s.chips -= s.insurance;
        }
        s.insuranceAnswered = s.kind !== "human" || s.bet <= 0 || s.leaving;
      }
      this.setPhase("insurance");
      this.startClock(INSURANCE_CLOCK);
      this.timer = this.seats.some((s) => !s.insuranceAnswered) ? 0 : 0.8;
      return;
    }
    this.peekAndContinue();
  }

  private stepInsurance(): void {
    const pending = this.seats.filter((s) => !s.insuranceAnswered);
    if (pending.length > 0) {
      if (this.clock === Infinity) return;
      this.clock -= this.dt;
      if (this.clock > 0) return;
      for (const s of pending) s.insuranceAnswered = true;
    }
    this.clock = Infinity;
    this.peekAndContinue();
  }

  /** US-style peek on ten or ace. */
  private peekAndContinue(): void {
    const up = this.dealer.cards[0];
    const upv = dealerValue(up);
    if (!this.dealerPeeked && (upv === 10 || upv === 11)) {
      this.dealerPeeked = true;
      const hole = this.dealer.cards[1];
      if (cardValue(up.rank) + cardValue(hole.rank) === 21) {
        this.dealer.holeHidden = false;
        this.reveal(hole);
        this.message("Dealer has blackjack.", "#e0554b");
        this.setPhase("settle");
        this.timer = 0.9;
        return;
      }
    }
    this.setPhase("playing");
    this.startClock(DECISION_CLOCK);
    this.timer = 0.35;
  }

  currentActor(): { seat: number; hand: number } | null {
    for (const s of this.seats) {
      if (s.bet <= 0) continue;
      for (let h = 0; h < s.hands.length; h++) {
        if (!s.hands[h].done) return { seat: s.index, hand: h };
      }
    }
    return null;
  }

  private stepPlaying(): void {
    const actor = this.currentActor();
    if (!actor) {
      this.setPhase("dealer");
      this.timer = 0.5;
      return;
    }
    const seat = this.seats[actor.seat];
    seat.active = actor.hand;
    const hand = seat.hands[actor.hand];

    // A hand fresh out of a split needs its second card.
    if (hand.cards.length === 1) {
      const card = this.shoe.draw();
      hand.cards.push(card);
      this.reveal(card);
      if (hand.fromSplit && hand.cards[0].rank === "A" && !this.rules.hitSplitAces) hand.done = true;
      if (handTotal(hand.cards).total === 21) hand.done = true;
      this.timer = this.rules.dealSpeed;
      return;
    }

    const t = handTotal(hand.cards);
    if (t.total >= 21 || isBlackjack(hand)) {
      hand.done = true;
      this.timer = 0.15;
      return;
    }

    if (seat.kind === "human" && !seat.leaving) {
      const action = seat.queuedAction;
      if (!action) {
        if (this.clock === Infinity) return;
        this.clock -= this.dt;
        if (this.clock > 0) return;
        this.message(`${seat.name} takes too long. The dealer stands them.`, "#8fa3b5");
        hand.done = true;
        this.startClock(DECISION_CLOCK);
        return;
      }
      seat.queuedAction = null;
      this.applyAction(seat, actor.hand, action);
      this.startClock(DECISION_CLOCK);
      return;
    }

    // A walked-away seat is finished off by the book, not by hunches.
    if (seat.leaving) {
      const bankroll = seat.account?.bankroll ?? 0;
      const legal = legalActions(hand, seat.hands.length, this.rules, bankroll);
      this.applyAction(seat, actor.hand, basicStrategy(hand, this.dealer.cards[0], this.rules, legal));
      return;
    }

    const legal = legalActions(hand, seat.hands.length, this.rules, seat.chips);
    const brain = seat.npc!;
    let action: Action;
    if (this.rng() < brain.skill) {
      action = basicStrategy(hand, this.dealer.cards[0], this.rules, legal);
    } else {
      action = this.rng() < 0.5 ? "hit" : "stand";
      if (t.total >= 17) action = "stand";
      if (t.total <= 11) action = "hit";
    }
    this.applyAction(seat, actor.hand, action);
    this.timer = randRange(this.rng, 0.45, 1.1);
  }

  private applyAction(seat: Seat, handIndex: number, action: Action): void {
    const hand = seat.hands[handIndex];
    const bankroll = seat.kind === "human" ? (seat.account?.bankroll ?? 0) : seat.chips;
    const legal = legalActions(hand, seat.hands.length, this.rules, bankroll);

    switch (action) {
      case "hit": {
        if (!legal.hit) return;
        const c = this.shoe.draw();
        hand.cards.push(c);
        this.reveal(c);
        if (handTotal(hand.cards).total >= 21) hand.done = true;
        this.timer = this.rules.dealSpeed;
        break;
      }
      case "stand": {
        hand.done = true;
        this.timer = 0.2;
        break;
      }
      case "double": {
        if (!legal.double) return;
        this.takeChips(seat, hand.bet);
        hand.bet *= 2;
        hand.doubled = true;
        const c = this.shoe.draw();
        hand.cards.push(c);
        this.reveal(c);
        hand.done = true;
        this.timer = this.rules.dealSpeed + 0.2;
        break;
      }
      case "split": {
        if (!legal.split) return;
        this.takeChips(seat, hand.bet);
        const moved = hand.cards.pop()!;
        hand.fromSplit = true;
        const extra = newHand(hand.bet, true);
        extra.cards.push(moved);
        seat.hands.splice(handIndex + 1, 0, extra);
        this.timer = 0.35;
        break;
      }
      case "surrender": {
        if (!legal.surrender) return;
        hand.surrendered = true;
        hand.done = true;
        this.timer = 0.3;
        break;
      }
    }
  }

  private takeChips(seat: Seat, amount: number): void {
    if (seat.kind === "human") {
      seat.account!.bankroll -= amount;
      seat.staked += amount;
    } else {
      seat.chips -= amount;
    }
  }

  private stepDealer(): void {
    if (this.dealer.holeHidden) {
      this.dealer.holeHidden = false;
      this.reveal(this.dealer.cards[1]);
      this.timer = 0.55;
      return;
    }
    const anyLive = this.seats.some((s) =>
      s.hands.some((h) => !h.surrendered && handTotal(h.cards).total <= 21 && !isBlackjack(h)),
    );
    const t = handTotal(this.dealer.cards);
    const mustHit =
      anyLive && (t.total < 17 || (t.total === 17 && t.soft && this.rules.dealerHitsSoft17));
    if (mustHit) {
      const c = this.shoe.draw();
      this.dealer.cards.push(c);
      this.reveal(c);
      this.timer = this.rules.dealSpeed + 0.15;
      return;
    }
    this.setPhase("settle");
    this.timer = 0.4;
  }

  private stepSettle(): void {
    const dealerTotal = handTotal(this.dealer.cards).total;
    const dealerBJ = this.dealer.cards.length === 2 && dealerTotal === 21;

    for (const seat of this.seats) {
      const seated = seat.kind === "human";
      if (seat.bet <= 0) {
        if (seated) this.emitSummary(seat, 0, []);
        continue;
      }
      let seatPayout = 0;
      const results: HandResult[] = [];

      if (seat.insurance > 0) {
        if (dealerBJ) seatPayout += seat.insurance * 3;
        if (seated) {
          this.flash(
            seat,
            dealerBJ ? "Insurance pays" : "Insurance lost",
            dealerBJ ? "#3fbf6f" : "#e0554b",
          );
        }
      }

      for (const hand of seat.hands) {
        const total = handTotal(hand.cards).total;
        const natural = isBlackjack(hand);
        let result: HandResult;
        let payout = 0;
        if (hand.surrendered) {
          result = "surrender";
          payout = hand.bet / 2;
        } else if (total > 21) {
          result = "bust";
        } else if (natural && !dealerBJ) {
          result = "blackjack";
          payout = hand.bet * (1 + this.rules.blackjackPayout);
        } else if (natural && dealerBJ) {
          result = "push";
          payout = hand.bet;
        } else if (dealerBJ) {
          result = "lose";
        } else if (dealerTotal > 21 || total > dealerTotal) {
          result = "win";
          payout = hand.bet * 2;
        } else if (total === dealerTotal) {
          result = "push";
          payout = hand.bet;
        } else {
          result = "lose";
        }
        hand.result = result;
        hand.payout = payout;
        seatPayout += payout;
        results.push(result);
      }

      if (seated) {
        seat.account!.bankroll += seatPayout;
        const net = seatPayout - seat.staked;
        this.flash(
          seat,
          net > 0 ? `+$${Math.round(net)}` : net < 0 ? `-$${Math.abs(Math.round(net))}` : "push",
          net > 0 ? "#3fbf6f" : net < 0 ? "#e0554b" : "#8fa3b5",
        );
        this.emitSummary(seat, seatPayout, results);
      } else {
        seat.chips += seatPayout;
        const staked = seat.hands.reduce((a, h) => a + h.bet, 0) + seat.insurance;
        const net = seatPayout - staked;
        this.flash(
          seat,
          net > 0 ? `+${Math.round(net)}` : net < 0 ? `${Math.round(net)}` : "push",
          net > 0 ? "#3fbf6f" : net < 0 ? "#e0554b" : "#8fa3b5",
        );
        if (seat.chips < this.rules.minBet) {
          const index = seat.index;
          Object.assign(seat, this.makeSeat(index));
        }
      }
    }

    for (const s of this.seats) {
      if (s.leaving) {
        Object.assign(s, this.makeSeat(s.index));
        continue;
      }
      s.bet = 0;
      s.betLocked = false;
      s.staked = 0;
      if (s.kind === "human" && s.account) {
        s.pendingBet = Math.min(s.pendingBet, s.account.bankroll);
      }
    }

    if (this.shoe.cutCardOut) {
      this.setPhase("shuffle");
      this.timer = 1.8;
    } else {
      this.setPhase("betting");
      // A seated human gets a real window to get a bet out -- long enough to
      // wong back in when the count turns, short enough to feel like a dealer.
      this.timer = this.humans().length > 0 ? 3.2 : 1.6;
      this.startClock(BET_CLOCK);
    }
  }

  private emitSummary(seat: Seat, payout: number, results: HandResult[]): void {
    const summary: RoundSummary = {
      round: this.round,
      seatIndex: seat.index,
      playerId: seat.playerId,
      bet: seat.staked,
      net: payout - seat.staked,
      trueCountAtBet: this.trueCountAtBet,
      runningCountAtBet: this.runningCountAtBet,
      decksRemaining: this.decksAtBet,
      results,
      insuranceTaken: seat.insurance > 0,
      handsPlayed: seat.hands.length,
      satOut: seat.staked === 0,
    };
    this.hooks.onRoundEnd?.(summary);
  }

  private stepShuffle(): void {
    const runningBefore = this.count.running;
    this.shoe.reshuffle();
    this.count.reset();
    this.hooks.onShuffle?.(runningBefore);
    this.message("Shuffle. The count resets to zero.", "#5aa9e6");
    for (const s of this.seats) {
      s.hands = [];
      s.bet = 0;
    }
    this.dealer = { cards: [], holeHidden: true };
    this.setPhase("betting");
    this.timer = 1.4;
    this.startClock(BET_CLOCK);
  }

  private flash(seat: Seat, textVal: string, color: string): void {
    seat.flash = { text: textVal, color, t: 1.9 };
  }

  private reveal(c: Card): void {
    this.count.see(c);
    this.hooks.onCardRevealed?.(c);
  }

  private npcBet(seat: Seat): number {
    const brain = seat.npc!;
    const base = this.rules.minBet * brain.aggression;
    const noise = randRange(this.rng, 0.7, 1.6);
    const raw = Math.round((base * noise) / this.rules.minBet) * this.rules.minBet;
    return Math.max(this.rules.minBet, Math.min(this.rules.maxBet, Math.min(raw, seat.chips)));
  }

  /**
   * Hands that were dealt while nobody was watching. The count moves and the
   * player does not get to see it -- which is exactly the point.
   */
  burnUnseen(rounds: number): void {
    if (rounds <= 0) return;
    const players = Math.max(1, this.seats.filter((s) => s.kind === "npc").length);
    const cards = Math.round(rounds * (players + 1) * 2.8);
    for (let i = 0; i < cards; i++) {
      if (this.shoe.cutCardOut) {
        this.shoe.reshuffle();
        this.count.reset();
      }
      this.count.see(this.shoe.draw());
    }
  }

  // ------------------------------------------------------------- accessors

  get trueCount(): number {
    return this.count.trueCount(this.shoe.decksRemaining);
  }

  get dealerUpcard(): Card | null {
    return this.dealer.cards[0] ?? null;
  }

  /** The hand this player may act on right now, if it is their turn. */
  turnOf(playerId: string): { hand: Hand; index: number } | null {
    if (this.phase !== "playing") return null;
    const actor = this.currentActor();
    if (!actor) return null;
    const seat = this.seats[actor.seat];
    if (seat.kind !== "human" || seat.playerId !== playerId || seat.leaving) return null;
    const hand = seat.hands[actor.hand];
    if (hand.cards.length < 2) return null;
    return { hand, index: actor.hand };
  }
}
