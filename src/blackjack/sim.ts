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

export interface Seat {
  index: number;
  kind: "empty" | "player" | "npc";
  name: string;
  bet: number;
  hands: Hand[];
  active: number;
  insurance: number;
  chips: number;
  npc?: NpcBrain;
  flash?: { text: string; color: string; t: number };
}

export interface RoundSummary {
  round: number;
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

export interface PlayerAccount {
  bankroll: number;
}

export interface SimHooks {
  onCardRevealed?: (c: Card) => void;
  onRoundEnd?: (s: RoundSummary) => void;
  onShuffle?: () => void;
  onPhase?: (p: Phase) => void;
  onMessage?: (text: string, color: string) => void;
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

/**
 * Drives one blackjack table. Deterministic given (seed, player actions) and
 * advanced purely by update(dt), so an authoritative server can run the exact
 * same class later and broadcast its state.
 */
export class TableSim {
  readonly shoe: Shoe;
  readonly count = new CountState();
  phase: Phase = "betting";
  seats: Seat[] = [];
  dealer: { cards: Card[]; holeHidden: boolean } = { cards: [], holeHidden: true };

  playerSeat: number | null = null;
  /** Chips the player has pushed out for the next round. */
  pendingBet = 0;
  betLocked = false;
  sittingOut = false;

  offeringInsurance = false;
  insuranceResolved = false;

  round = 0;
  roundsAtTable = 0;
  timer = 0;
  /** Cards dealt this round, for pacing the "dealer is talking" beats. */
  private dealQueue: { seat: number; hidden: boolean }[] = [];
  private queuedPlayerAction: Action | null = null;
  private trueCountAtBet = 0;
  private runningCountAtBet = 0;
  private decksAtBet = 0;
  private stakedThisRound = 0;
  private dealerPeeked = false;

  lastSummary: RoundSummary | null = null;

  constructor(
    public rules: TableRules,
    private rng: Rng,
    private account: PlayerAccount,
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
      bet: 0,
      hands: [],
      active: 0,
      insurance: 0,
      chips: 0,
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
        seat.kind = "npc";
        seat.name = name;
        seat.chips = this.rules.minBet * randRange(this.rng, 15, 60);
        seat.npc = {
          skill: randRange(this.rng, 0.5, 0.97),
          aggression: randRange(this.rng, 1, 3.5),
          superstition: this.rng(),
        };
      }
    }
  }

  get playerSeated(): boolean {
    return this.playerSeat !== null;
  }

  freeSeats(): number[] {
    return this.seats.filter((s) => s.kind === "empty").map((s) => s.index);
  }

  sit(index: number, name = "You"): boolean {
    const seat = this.seats[index];
    if (!seat || seat.kind !== "empty") return false;
    seat.kind = "player";
    seat.name = name;
    this.playerSeat = index;
    this.sittingOut = this.phase !== "betting";
    this.roundsAtTable = 0;
    this.message(`You sit down at seat ${index + 1}.`, "#8fa3b5");
    return true;
  }

  standUp(): void {
    if (this.playerSeat === null) return;
    const seat = this.seats[this.playerSeat];
    seat.kind = "empty";
    seat.name = "";
    seat.hands = [];
    seat.bet = 0;
    this.playerSeat = null;
    this.pendingBet = 0;
    this.betLocked = false;
  }

  get seat(): Seat | null {
    return this.playerSeat === null ? null : this.seats[this.playerSeat];
  }

  // ------------------------------------------------------------ player API

  setBet(amount: number): void {
    if (this.phase !== "betting" || this.betLocked) return;
    const clamped = Math.max(0, Math.min(this.rules.maxBet, Math.min(amount, this.account.bankroll)));
    this.pendingBet = clamped;
  }

  addBet(delta: number): void {
    this.setBet(this.pendingBet + delta);
  }

  confirmBet(): boolean {
    if (this.phase !== "betting" || this.playerSeat === null) return false;
    if (this.pendingBet < this.rules.minBet) return false;
    if (this.pendingBet > this.account.bankroll) return false;
    this.betLocked = true;
    this.sittingOut = false;
    return true;
  }

  /** Wong out: skip this round but keep watching the shoe. */
  setSittingOut(v: boolean): void {
    if (this.phase !== "betting") return;
    this.sittingOut = v;
    if (v) this.betLocked = false;
  }

  act(action: Action): void {
    if (this.phase !== "playing") return;
    const actor = this.currentActor();
    if (!actor || this.seats[actor.seat].kind !== "player") return;
    this.queuedPlayerAction = action;
  }

  answerInsurance(take: boolean): void {
    if (!this.offeringInsurance || this.playerSeat === null) return;
    const seat = this.seats[this.playerSeat];
    if (take) {
      const amount = Math.floor(seat.bet / 2);
      if (amount > 0 && this.account.bankroll >= amount) {
        this.account.bankroll -= amount;
        this.stakedThisRound += amount;
        seat.insurance = amount;
        this.message("Insurance taken.", "#f0c14b");
      }
    }
    this.offeringInsurance = false;
    this.timer = 0.35;
  }

  // ------------------------------------------------------------- main loop

  update(dt: number): void {
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

  // ------------------------------------------------------------ phase steps

  private stepBetting(): void {
    // NPCs post their bets first, then we wait on the player.
    for (const s of this.seats) {
      if (s.kind === "npc" && s.bet === 0) {
        s.bet = this.npcBet(s);
      }
    }
    const waitingOnPlayer = this.playerSeat !== null && !this.betLocked && !this.sittingOut;
    if (waitingOnPlayer) return;

    const playerSeat = this.seat;
    if (playerSeat) {
      if (this.betLocked && this.pendingBet >= this.rules.minBet) {
        playerSeat.bet = this.pendingBet;
        this.account.bankroll -= this.pendingBet;
        this.stakedThisRound = this.pendingBet;
      } else {
        playerSeat.bet = 0;
        this.stakedThisRound = 0;
      }
    } else {
      this.stakedThisRound = 0;
    }

    this.trueCountAtBet = this.count.trueCount(this.shoe.decksRemaining);
    this.runningCountAtBet = this.count.running;
    this.decksAtBet = this.shoe.decksRemaining;

    // Build hands and the deal order.
    this.dealer = { cards: [], holeHidden: true };
    this.dealerPeeked = false;
    this.insuranceResolved = false;
    for (const s of this.seats) {
      s.hands = [];
      s.active = 0;
      s.insurance = 0;
      if (s.bet > 0) s.hands.push(newHand(s.bet));
    }

    const live = this.seats.filter((s) => s.bet > 0).map((s) => s.index);
    this.dealQueue = [];
    for (const i of live) this.dealQueue.push({ seat: i, hidden: false });
    this.dealQueue.push({ seat: -1, hidden: false });
    for (const i of live) this.dealQueue.push({ seat: i, hidden: false });
    this.dealQueue.push({ seat: -1, hidden: true });

    if (live.length === 0) {
      // Nobody is betting -- table idles briefly.
      this.timer = 0.6;
      return;
    }

    this.round++;
    if (this.seat && this.seat.bet > 0) this.roundsAtTable++;
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
      if (next.hidden) {
        this.dealer.holeHidden = true;
      } else {
        this.reveal(card);
      }
    } else {
      const seat = this.seats[next.seat];
      seat.hands[0].cards.push(card);
      this.reveal(card);
    }
    this.timer = this.rules.dealSpeed;
  }

  private afterDeal(): void {
    const up = this.dealer.cards[0];
    if (dealerValue(up) === 11) {
      // Ace showing: offer insurance to everyone still breathing.
      for (const s of this.seats) {
        if (s.kind === "npc" && s.bet > 0 && s.npc && this.rng() < s.npc.superstition * 0.5) {
          s.insurance = Math.floor(s.bet / 2);
          s.chips -= s.insurance;
        }
      }
      this.offeringInsurance = this.playerSeat !== null && (this.seat?.bet ?? 0) > 0;
      this.setPhase("insurance");
      this.timer = this.offeringInsurance ? 0 : 0.8;
      return;
    }
    this.peekAndContinue();
  }

  private stepInsurance(): void {
    if (this.offeringInsurance) return; // waiting on the player
    this.peekAndContinue();
  }

  /** US-style peek on ten or ace. */
  private peekAndContinue(): void {
    const up = this.dealer.cards[0];
    const upv = dealerValue(up);
    if (!this.dealerPeeked && (upv === 10 || upv === 11)) {
      this.dealerPeeked = true;
      const hole = this.dealer.cards[1];
      const total = cardValue(up.rank) + cardValue(hole.rank);
      if (total === 21) {
        this.dealer.holeHidden = false;
        this.reveal(hole);
        this.message("Dealer has blackjack.", "#e0554b");
        this.setPhase("settle");
        this.timer = 0.9;
        return;
      }
    }
    this.setPhase("playing");
    this.timer = 0.35;
  }

  currentActor(): { seat: number; hand: number } | null {
    for (const s of this.seats) {
      if (s.bet <= 0) continue;
      for (let h = 0; h < s.hands.length; h++) {
        const hand = s.hands[h];
        if (!hand.done) return { seat: s.index, hand: h };
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
      if (hand.fromSplit && hand.cards[0].rank === "A" && !this.rules.hitSplitAces) {
        hand.done = true;
      }
      const t = handTotal(hand.cards);
      if (t.total === 21) hand.done = true;
      this.timer = this.rules.dealSpeed;
      return;
    }

    // Naturals and 21s never act.
    const t = handTotal(hand.cards);
    if (t.total >= 21 || isBlackjack(hand)) {
      hand.done = true;
      this.timer = 0.15;
      return;
    }

    if (seat.kind === "player") {
      const action = this.queuedPlayerAction;
      if (!action) return; // block until the player decides
      this.queuedPlayerAction = null;
      this.applyAction(seat, actor.hand, action);
      return;
    }

    // NPC turn.
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
    const bankroll = seat.kind === "player" ? this.account.bankroll : seat.chips;
    const legal = legalActions(hand, seat.hands.length, this.rules, bankroll);

    switch (action) {
      case "hit": {
        if (!legal.hit) return;
        const c = this.shoe.draw();
        hand.cards.push(c);
        this.reveal(c);
        const t = handTotal(hand.cards);
        if (t.total >= 21) hand.done = true;
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
    if (seat.kind === "player") {
      this.account.bankroll -= amount;
      this.stakedThisRound += amount;
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
    const dealerBJ =
      this.dealer.cards.length === 2 && dealerTotal === 21;
    let playerPayout = 0;
    const results: HandResult[] = [];

    for (const seat of this.seats) {
      if (seat.bet <= 0) continue;
      let seatPayout = 0;

      if (seat.insurance > 0) {
        if (dealerBJ) seatPayout += seat.insurance * 3;
        if (seat.kind === "player") {
          this.flash(seat, dealerBJ ? "Insurance pays" : "Insurance lost", dealerBJ ? "#3fbf6f" : "#e0554b");
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
        if (seat.kind === "player") results.push(result);
      }

      if (seat.kind === "player") {
        playerPayout = seatPayout;
        this.account.bankroll += seatPayout;
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
          // Broke NPCs go find an ATM.
          seat.kind = "empty";
          seat.name = "";
          seat.hands = [];
        }
      }
    }

    const net = playerPayout - this.stakedThisRound;
    if (this.seat && this.stakedThisRound > 0) {
      this.flash(
        this.seat,
        net > 0 ? `+$${Math.round(net)}` : net < 0 ? `-$${Math.abs(Math.round(net))}` : "push",
        net > 0 ? "#3fbf6f" : net < 0 ? "#e0554b" : "#8fa3b5",
      );
    }

    const summary: RoundSummary = {
      round: this.round,
      bet: this.stakedThisRound,
      net,
      trueCountAtBet: this.trueCountAtBet,
      runningCountAtBet: this.runningCountAtBet,
      decksRemaining: this.decksAtBet,
      results,
      insuranceTaken: (this.seat?.insurance ?? 0) > 0,
      handsPlayed: this.seat?.hands.length ?? 0,
      satOut: this.stakedThisRound === 0,
    };
    this.lastSummary = summary;
    this.hooks.onRoundEnd?.(summary);

    for (const s of this.seats) s.bet = 0;
    this.pendingBet = Math.min(this.pendingBet, this.account.bankroll);
    this.betLocked = false;
    this.stakedThisRound = 0;

    if (this.shoe.cutCardOut) {
      this.setPhase("shuffle");
      this.timer = 1.8;
    } else {
      this.setPhase("betting");
      // A seated player gets a real window to get a bet out -- long enough to
      // wong back in when the count turns, short enough to feel like a dealer.
      this.timer = this.seat ? 3.2 : 1.6;
    }
  }

  private stepShuffle(): void {
    this.shoe.reshuffle();
    this.count.reset();
    this.hooks.onShuffle?.();
    this.message("Shuffle. Count resets to zero.", "#5aa9e6");
    for (const s of this.seats) {
      s.hands = [];
      s.bet = 0;
    }
    this.dealer = { cards: [], holeHidden: true };
    this.setPhase("betting");
    this.timer = 1.4;
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
   * Hands that were dealt while the player was away from the table. The count
   * moves and they do not get to see it -- which is exactly the point.
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

  /** Cards the player is allowed to act on right now, if it's their turn. */
  playerTurn(): { hand: Hand; index: number } | null {
    if (this.phase !== "playing" || this.playerSeat === null) return null;
    const actor = this.currentActor();
    if (!actor || actor.seat !== this.playerSeat) return null;
    const seat = this.seats[actor.seat];
    const hand = seat.hands[actor.hand];
    if (hand.cards.length < 2) return null;
    return { hand, index: actor.hand };
  }
}
