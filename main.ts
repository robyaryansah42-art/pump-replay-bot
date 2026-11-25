// Small-curve dip bounce for the pump.fun replay sprint (agent-fun/replay/v2).
// Run by the grader as `node /bot/main.ts`; the SDK shim is vendored byte
// for byte in vendor/ from the competition kit's baselines/pilot/momentum
// (the kit ships no sdk/ts/agentfun-bot.ts; the pilot copy is the official one).
//
// Strategy (see strategy.ts): buy only a 10-50% dip on a small curve
// (1.5-5 SOL real reserves) whose reserves have not fallen over the last
// 24 trades, with buyers stepping back in; one small stake per coin,
// +10% take-profit, -10% stop, 300-slot time stop. Paper money only;
// no network, no clock, no randomness, fully deterministic.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const onBatch = createStrategy(DEFAULT_PARAMS);

await runBot({ onBatch });
