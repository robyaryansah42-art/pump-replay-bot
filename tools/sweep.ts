// Local parameter sweep for strategy.ts on the kit dev window.
// Usage: node tools/sweep.ts <kit dir>
// Loads the dataset once, runs the local sim port over a small grid, prints
// the best cells by net PnL. Dev tooling only; the bot never imports it.

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/sweep.ts <kit dir>');
  process.exit(2);
}
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const sol = (x: bigint) => Number(x) / 1e9;

type Row = { net: number; coins: number; trips: number; wins: number; dd: number; params: Partial<Params> };
const rows: Row[] = [];
const run = (over: Partial<Params>) => {
  const params = { ...DEFAULT_PARAMS, ...over };
  const r = simulate(ds, hello, { onBatch: createStrategy(params) });
  rows.push({ net: sol(r.netPnl), coins: r.mints, trips: r.trips.length, wins: r.trips.filter((t) => t.pnl > 0n).length, dd: r.maxDrawdown, params: over });
};

// Stage 11: lower the reserve floor (rq<2 also showed a strong bounce in
// the forward stats) to add coins; the 1% reserve cap keeps buys >= 0.01
// SOL down to about 1.03 SOL of reserves.
for (const minRq of [1_200_000_000n, 1_500_000_000n, 2_000_000_000n]) {
  for (const pullMin of [0.1, 0.15]) {
    run({ minRq, maxRq: 5_000_000_000n, minRqGrowth: 0n, pullMin, pullMax: 0.5, takeProfit: 0.1, stopLoss: 0.1, maxHoldSlots: 300, stake: 50_000_000n, trailArm: 1, growthTrades: 24, highTrades: 60, minBuys: 4, minBuyers: 2, cooldownSlots: 100 });
  }
}
rows.sort((a, b) => b.net - a.net);
for (const r of rows.slice(0, 12)) {
  console.log(`net ${r.net.toFixed(4)} coins ${r.coins} trips ${r.trips} wins ${r.wins} dd ${r.dd.toFixed(3)} ${JSON.stringify(r.params, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
}
