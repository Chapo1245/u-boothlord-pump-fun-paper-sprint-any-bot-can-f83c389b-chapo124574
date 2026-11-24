[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Chapo1245/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-chapo124574/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Chapo1245/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-chapo124574/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint — Fresh-Launch Sniper

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. It trades 10 SOL of paper money on a 6-hour replay of real pump.fun bonding-curve activity, ranked by net PnL. No real money, no entry fee.

## Strategy

Chasing breakouts loses on pump.fun — buying after a curve has already risen mostly buys the top of a pump that then dumps. So this bot only buys in a coin's first 15 slots, and only when the launch looks clean:

- the curve pulled in **8+ SOL of real reserves** within its first slots (fast accumulation),
- the **creator bought little** (≤ 1 SOL) and **has not sold**,
- at most **5 other wallets** piled in (a launch bundled by many wallets is usually the creator's cluster waiting to dump),
- no big early sell, and the price has not already run 2x off its create price.

Each entry is one small single-shot stake (0.12 SOL, shrunk by the harness's 1%-of-real-reserve buy cap). Losers are cut fast (20% stop, creator-sell exit, big-sell exit, 120-slot time limit); winners run on a 20% trailing stop once up 20%, with a hard take-profit at 3x. A tiny probe lane runs 0.02 SOL round trips only to keep the run above the 20-coin guardrail minimum in a quiet window.

Everything is deterministic — no clock, no randomness — so two runs produce identical action logs.

## Run

```sh
node main.ts
```

Node 22.18+ (the grader runs Node 22.23.4; TypeScript runs as-is). The bot speaks `agent-fun/replay/v2` over NDJSON on stdin/stdout; the SDK shim is vendored byte for byte in `vendor/agentfun-bot.ts`.

## Layout

- `main.ts` — entrypoint: wires the strategy into the SDK shim.
- `strategy.ts` — the strategy (entry filter, exits, probe pacing).
- `vendor/agentfun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `REPORT.md` — dev score, stress numbers, and the sweep that picked the parameters.

<sub>Entered on [make.fun](https://make.fun/?ref=wtacm6ft&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
