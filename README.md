# Small-Curve Dip Bounce — Pump.fun Replay Sprint Paper Bot

![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)
![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/robyaryansah42-art/pump-replay-bot/rank.svg)
![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/robyaryansah42-art/pump-replay-bot/reward.svg)

A paper-money trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun. It trades 10 SOL of paper money on a 24-hour replay of pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy: small-curve dip bounce

Most pump.fun curves bleed, so chasing launches, riding strength, or buying
deep crashes all lose money on the dev window. The one pocket with a real
edge in the data is **small curves (1.5–5 SOL of real reserves) after a
10–50% dip from their recent high**: forward returns there average +10–20%
over the next 30 trades with a ~70% win rate, while the same dip on big
curves (real SOL > 12) averages ~0%.

The bot (`strategy.ts`, run by `main.ts` via the vendored SDK in `vendor/`):

- buys only a 10–50% dip on a curve holding 1.5–5 SOL of real reserves;
- only while the curve's real SOL reserve has **not fallen** over the last
  24 trades (the reserve trend is the uptrend filter — a dip that is still
  bleeding reserves keeps falling);
- only when buyers are stepping back in (≥ 4 buys among the last 8 trades,
  ≥ 2 distinct buyers, the latest trade a buy);
- one small stake per coin (~0.012–0.05 SOL in practice, capped by the
  1%-of-real-reserve per-reply limit), no adds, no pyramiding;
- exits on +10% take-profit, −10% stop, or a 300-slot time stop.

It is a pure function of the batches the harness sends: no clock, no
randomness, no I/O, no network — the two graded executions produce
byte-identical action logs.

## Local backtest (dev window, all three dataset parts)

Run from the repo root with the kit unpacked next to it:

```
node tools/backtest.ts <kit dir>
```

Result with the shipped defaults:

| metric | value |
|---|---|
| net PnL | **+0.031660 SOL** |
| fills | 66 |
| coins traded | 30 |
| round trips | 33 (13 wins) |
| max drawdown | 0.0027 |
| deterministic (2 runs) | yes, byte-identical output |

Notes: the edge is thin — at 2× fees the same run is −0.0026 SOL, and the
per-part results range from −0.005 to +0.045 SOL, so the final window can
still go either way. The 20-coin guardrail is met on the full dev window
(30 coins with round trips ≥ 0.01 SOL), with modest margin.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`.
- `strategy.ts` — the strategy (all original work for this entry).
- `vendor/agentfun-bot.ts` — the kit's SDK shim, vendored byte-for-byte
  from the competition kit's `baselines/pilot/momentum/vendor/`
  (the kit ships no `sdk/ts/agentfun-bot.ts`).
- `tools/` — local validation only (a port of the kit's replay sim and a
  parameter sweep); the bot never imports these files.
- `.makefun/owner.json` — the claim file naming the entry wallet.
