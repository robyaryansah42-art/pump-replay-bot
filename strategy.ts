// Small-curve dip bounce for the pump.fun replay (agent-fun/replay/v2).
//
// Idea (my own): most pump.fun curves bleed, so chasing launches, riding
// strength, or buying deep crashes all lose money on the dev window. The
// one pocket with a real edge in the data is small curves (1.5-5 SOL of
// real reserves) after a 10-50% dip from their recent high: forward returns
// there average +10-20% over the next 30 trades with a ~70% win rate,
// while the same dip on big curves (real SOL > 12) averages ~0%. So this
// bot only buys small curves, only after such a dip, only while the
// curve's real SOL reserve has NOT fallen over the last 24 trades (the
// reserve trend is the uptrend filter — a dip that is still bleeding
// reserves keeps falling), and only when buyers are stepping back in
// (at least 4 buys among the last 8 trades, at least 2 distinct buyers,
// the latest trade a buy). One small stake per coin (capped in practice
// by the 1%-of-real-reserve per-reply limit to ~0.012-0.05 SOL), a +10%
// take-profit, a -10% stop, and a 300-slot time stop; no adds, no
// pyramiding, no trailing stop (fixed exits only at these sizes).
//
// Pure function of the batches the harness sends: no clock, no randomness,
// no I/O, no network, iteration only in deterministic (sorted /
// insertion) order, so the two graded executions produce byte-identical
// action logs.

import type { Batch, BotState, Mark, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Trades scanned for the buy-flow check. */
  flowTrades: number;
  /** Of the last `flowTrades` trades at least `minBuys` must be buys. */
  minBuys: number;
  /** Net SOL bought over the last `flowTrades` trades must be >= this. */
  minNetFlow: bigint;
  /** Distinct buyers among the last `flowTrades` trades, at least. */
  minBuyers: number;
  /** Trades scanned for the recent high. */
  highTrades: number;
  /** Enter only when price is this far below the recent high (fraction)... */
  pullMin: number;
  /** ...and no further than this (a collapse, not a dip). */
  pullMax: number;
  /** Smallest tape length before a coin may be entered. */
  minTrades: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRq: bigint;
  maxRq: bigint;
  /** Trades back over which the real SOL reserve must not have fallen. */
  growthTrades: number;
  /** Real SOL must not have fallen by more than this over `growthTrades`. */
  minRqGrowth: bigint;
  /** Lamports per position (one fixed stake, no adds; the harness caps
      each buy at 1% of the curve's real SOL, so the effective stake on
      1.5-5 SOL curves is ~0.012-0.05 SOL). */
  stake: bigint;
  /** Smallest buy worth sending (tx fees are 105k lamports per order). */
  minBuy: bigint;
  /** Take profit when liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm)... */
  trailArm: number;
  /** ...and exits when value falls this far below its peak (fraction).
      Set to 1 to disable the trailing stop (fixed exits only). */
  trailDrop: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** After an exit, ignore the coin for this many slots. */
  cooldownSlots: number;
  /** Slippage tolerance on buys and on sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Most new entries per reply. */
  maxEntriesPerBatch: number;
  /** Exits are sent as this many equal sells in one reply. */
  sellSplits: number;
}

// Chosen from the middle of a flat region on the full dev window
// (minRq 1.2-2 SOL, pullMin 0.10-0.15, TP/SL 10% all land within a few
// thousandths of a SOL of each other): a 10-50% dip on a 1.5-5 SOL curve
// whose reserves are not falling, 0.05 SOL stakes, +10% take profit,
// -10% stop, 300-slot time stop.
export const DEFAULT_PARAMS: Params = {
  flowTrades: 8,
  minBuys: 4,
  minNetFlow: 0n,
  minBuyers: 2,
  highTrades: 60,
  pullMin: 0.1,
  pullMax: 0.5,
  minTrades: 24,
  minRq: 1_500_000_000n,
  maxRq: 5_000_000_000n,
  growthTrades: 24,
  minRqGrowth: 0n,
  stake: 50_000_000n,
  minBuy: 10_000_000n,
  takeProfit: 0.1,
  stopLoss: 0.1,
  trailArm: 1,
  trailDrop: 0.1,
  maxHoldSlots: 300,
  cooldownSlots: 100,
  buySlippageBps: 500,
  sellSlippageBps: 3000,
  maxEntriesPerBatch: 2,
  sellSplits: 1,
};

interface Tick {
  slot: number;
  /** virtual SOL / virtual tokens: the marginal price. */
  price: number;
  realSol: bigint;
  isBuy: boolean;
  sol: bigint;
  user: string;
}

interface Book {
  ticks: Tick[];
  /** Slot of the first fill decision of the current position. */
  entrySlot: number;
  /** Best liquidation value seen for the current position (fraction of cost). */
  peakGain: number;
  /** Slot until which the coin is ignored after an exit. */
  coolUntil: number;
  /** A sell is in flight: do not send another. */
  exiting: boolean;
}

const FEE_BPS = 125n;
const BPS = 10_000n;

/**
 * The per-reply buy cap, with a margin: the harness checks it against the
 * reserves shifted by our own earlier flow on the coin, which can sit a
 * little below the recorded ones the SDK keeps.
 */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

/**
 * What selling `tokens` would pay, curve fees deducted, against the reserves
 * the harness marks for the mint (the recorded reserves shifted by our own
 * net flow into the curve).
 */
function liquidationValue(mark: Mark | undefined, tokens: bigint): bigint {
  if (mark === undefined) return 0n;
  const vq = BigInt(mark.virtual_quote_reserves);
  const vt = BigInt(mark.virtual_token_reserves);
  const rq = BigInt(mark.real_quote_reserves);
  if (vt + tokens === 0n) return 0n;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const books = new Map<Pubkey, Book>();
  const book = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { ticks: [], entrySlot: -1, peakGain: 0, coolUntil: -1, exiting: false };
      books.set(mint, b);
    }
    return b;
  };

  return function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const touched: Pubkey[] = [];
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const b = book(e.mint);
      const vt = BigInt(e.virtual_token_reserves);
      const price = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
      b.ticks.push({
        slot,
        price,
        realSol: BigInt(e.real_quote_reserves),
        isBuy: e.is_buy,
        sol: BigInt(e.sol_amount),
        user: e.user,
      });
      if (b.ticks.length > 400) b.ticks.splice(0, b.ticks.length - 400);
      if (!touched.includes(e.mint)) touched.push(e.mint);
    }
    // A position whose sell resolved (or failed) may need another exit attempt.
    for (const f of batch.fills) {
      const b = books.get(f.mint);
      if (b === undefined) continue;
      if (f.side === 'sell') {
        b.exiting = false;
        if (!state.positions.has(f.mint)) {
          b.entrySlot = -1;
          b.peakGain = 0;
          b.coolUntil = slot + p.cooldownSlots;
        }
      } else if (f.status !== 'filled' && !state.positions.has(f.mint)) {
        // The opening buy never filled: forget the entry.
        let stillPending = false;
        for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
        if (!stillPending) b.entrySlot = -1;
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, Mark>();
    for (const m of batch.marks) marks.set(m.mint, m);
    const pendingMints = new Set<Pubkey>();
    for (const o of state.pending.values()) pendingMints.add(o.order.mint);

    // 1. Exits on held positions, in mint order (deterministic).
    const held = [...state.positions.keys()].sort();
    for (const mint of held) {
      if (orders.length >= cap) break;
      const h = state.positions.get(mint)!;
      const b = book(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (b.exiting) continue;
      const value = liquidationValue(marks.get(mint), h.token_amount);
      const gain = h.cost_lamports > 0n ? Number(value - h.cost_lamports) / Number(h.cost_lamports) : 0;
      if (gain > b.peakGain) b.peakGain = gain;
      const entrySlot = b.entrySlot < 0 ? slot : b.entrySlot;
      const tp = gain >= p.takeProfit;
      const sl = gain <= -p.stopLoss;
      const trail = b.peakGain >= p.trailArm && gain <= b.peakGain - p.trailDrop;
      const stale = slot - entrySlot >= p.maxHoldSlots;
      if (tp || sl || trail || stale) {
        if (pendingMints.has(mint)) continue;
        const n = BigInt(Math.max(1, Math.min(p.sellSplits, cap - orders.length)));
        const piece = h.token_amount / n;
        for (let i = 1n; i <= n; i++) {
          const amount = i === n ? h.token_amount - piece * (n - 1n) : piece;
          orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: p.sellSlippageBps });
        }
        b.exiting = true;
      }
    }

    // 2. New entries on coins that traded in this batch (slot).
    let entries = 0;
    let open = state.committedPositionCount();
    for (const mint of touched) {
      if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
      if (open >= state.hello.caps.max_open_positions) break;
      if (state.positions.has(mint) || pendingMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const b = book(mint);
      if (slot < b.coolUntil) continue;
      const ticks = b.ticks;
      if (ticks.length < Math.max(p.minTrades, p.growthTrades, p.highTrades)) continue;
      const last = ticks[ticks.length - 1]!;
      if (last.realSol < p.minRq || last.realSol > p.maxRq) continue;
      // Reserve trend: the curve's real SOL must not have fallen over the
      // growth window. A dip whose reserves are still bleeding keeps
      // falling; one whose reserves held is the bounce candidate.
      const oldRq = ticks[ticks.length - p.growthTrades]!.realSol;
      if (last.realSol - oldRq < p.minRqGrowth) continue;
      // The dip itself: 10-50% below the recent high.
      let hi = 0;
      for (let i = ticks.length - p.highTrades; i < ticks.length; i++) {
        if (ticks[i]!.price > hi) hi = ticks[i]!.price;
      }
      if (hi <= 0) continue;
      const pull = 1 - last.price / hi;
      if (pull < p.pullMin || pull > p.pullMax) continue;
      // Buyers stepping back in: recent flow, several distinct buyers, and
      // the most recent trade a buy.
      let buys = 0;
      let net = 0n;
      const buyers = new Set<string>();
      for (let i = ticks.length - p.flowTrades; i < ticks.length; i++) {
        const t = ticks[i]!;
        if (t.isBuy) {
          buys++;
          net += t.sol;
          buyers.add(t.user);
        } else {
          net -= t.sol;
        }
      }
      if (buys < p.minBuys || net < p.minNetFlow) continue;
      if (buyers.size < p.minBuyers) continue;
      if (!last.isBuy) continue;
      let amount = p.stake;
      const sizeCap = buyCap(state, mint);
      if (amount > sizeCap) amount = sizeCap;
      if (amount < p.minBuy) continue;
      if (state.freeCashLamports() - amount - tx < 0n) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      b.entrySlot = slot;
      b.peakGain = 0;
      b.exiting = false;
      pendingMints.add(mint);
      entries++;
      open++;
    }
    return orders;
  };
}
