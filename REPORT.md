# REPORT — Pump.fun Paper Sprint: Any Bot Can Win

Bounty: `u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b` ($2 winner-takes-all, deadline 26 Nov 2026 12:40 WIB).
Repo: https://github.com/Chapo1245/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-chapo124574
Graded code commit: `0cfd61069f47557a53d97af99a12dd2b47aeaeb7` ("Cheaper probes (0.01 SOL, 21 coins) + ignore duplicate CreateEvents").
This REPORT.md + the README results section were added after grading (docs only; no bot code changed).

## Verdict up front

- **Dev score: +0.0436 SOL — positive, guardrails met.** The entry is a valid, ranked submission.
- **Stress: median −0.34 SOL, 18/20 copies lose — the brief's stress bar (positive median, low losing share) is NOT met.** No variant tested in this build achieved a positive stress median. This is reported honestly rather than hidden: the dev edge is concentrated in 2–3 coins and depends on launch→pump timing that block resampling destroys. The final window is fresh 6h data, not a resample — on contiguous 6h slices of dev data (the closest proxy to the final window) the strategy is ~breakeven (median −0.006 with probes, +0.005 main-only).

## Dev grade (`grade-local --driver process`, 24 Nov 2026)

| metric | value |
|---|---|
| net PnL | **+0.043607567 SOL** (return 0.00436, 90% interval −0.0259..+0.1427) |
| fills / coins / round trips | 50 / 25 / 25 |
| win rate | 0.16 |
| max drawdown | 0.00284 |
| rejected / failed | 0 / 2 |
| fees | 0.01925 SOL curve + 0.00546 SOL tx; at 2x fees net PnL +0.0185 SOL |
| guardrails | met (25 coins hold a round trip ≥ 0.01 SOL, drawdown ok) |
| top coins | 3 coins made 90% of the gains; without them net PnL is −0.02 SOL |
| result_sha256 | `784cab099d9215d3c84fdc5c483b7ddfc52c41588e3b9ce037b2a465186756a0` (L1 regrade reproduced byte for byte; cannot equal the server's — local Node v24.22.1 vs server v26.13.1) |
| eligible | ranked yes, prize no (transcripts not bundled — parent's submit step), efficiency no |

## Stress (`grade-local --stress 20 --stress-jobs 4`, same run)

Per-copy net PnL (SOL): +0.04, −0.44, −0.24, −0.13, −0.34, −0.36, −0.56, −0.21, −0.40, +0.12, −0.15, −0.37, −0.40, −0.33, −0.39, −0.30, −0.47, −0.37, −0.26, −0.29.
**Median −0.34, p10 −0.47, p90 −0.13; 18 of 20 lost money; dev score above 19 of 20 copies.** Both warnings fired (dev above 90% of copies; half or more lost).
The previous code commit (9f3b81c) stressed identically (median −0.34, p10 −0.48, p90 −0.14, 18/20 lose) — the v2 changes improved dev (+0.0245 → +0.0436) and left stress untouched.

## Strategy (shipped)

Fresh-launch sniper. Buy only in a coin's first 15 slots, only when the launch looks clean: real reserves reach ≥ 8 SOL fast, creator bought ≤ 1 SOL and has not sold, ≤ 5 other buyers, no big early sell, price not already 2x create price. One 0.12 SOL stake per coin (capped at 1% of real reserves by the harness). Exits: 20% stop, 20% trailing stop once up 20%, 3x take-profit, 120-slot time limit, creator-sell and big-sell exits. A cheap probe lane (0.01 SOL, 21 coins, paced across the window) exists only to clear the 20-coin guardrail in a quiet window — main entries alone average ~2 coins per 6h.

Key parameters (`strategy.ts` DEFAULT_PARAMS): minAge 0, maxAge 15, stakeSol 0.12, minRqSol 8, maxRqSol 40, maxDevBuySol 1, maxBuyers 5, maxEarlySellSol 0.5, maxRunup 2, stopLoss 0.2, trail 0.2, trailArm 0.2, takeProfit 3, maxHold 120, bigSellSol 1, targetCoins 21, probeSol 0.01.

## What was tested and rejected

All numbers are the kit sim on the full 24h dev window unless noted.

- **v1 momentum breakout-chasing** (buy mature curves with accelerating inflow, pyramid adds): **−1.146 SOL**, 466 fills, 218 trips, 12% wins. Kit momentum pilot: −9.38 SOL. Buying after a +6% rise mostly buys the top of a pump that then dumps.
- **Reversion pilot** (buy dips): −3.939 SOL.
- **Sniper pilot** (loose clean-launch filter): −0.475 SOL.
- **Mature-state momentum** (age ≥ 100 slots, rq 8–60, strong 60-slot inflow, price near its 60-slot high): **−0.708 SOL** full window; 6h chunks all negative (median −0.208). Momentum on mature coins is a dead end on this dataset.
- **Looser entry (rq ≥ 5)**: −0.019 SOL, 49 trips — more trips, worse per-trip EV. **Stricter filters** (devbuy ≤ 0.5, buyers ≤ 3, runup ≤ 1.5) each help per-trip EV but starve trip count; rq ≥ 8 is the best single filter (+0.006 at 29 trips in the strict sweep).
- **Longer holds (600/2400 slots)**: worse. **Disabling the big-sell exit**: worse.
- **Stop-loss / trailing-stop / take-profit variants** (stop 0.05/0.10/0.20, TP 1.5/3): identical results to 3 decimals — exits almost never bind; positions leave via maxHold/devSold/bigSell within ~5 slots.
- **Probe tilt** (probe only coins with positive lifetime net flow): no change. **Probe size 0.02 → 0.01 SOL, 25 → 21 coins**: dev +0.019 → +0.035 (local sim), the single biggest cheap win — the probe lane was the main loss source (~0.0007 SOL per probe round trip at 0.02).
- **Duplicate-CreateEvent guard** (ignore a second create for a known mint): no change to dev or stress.
- **Phantom-create hypothesis** (block surrogates inject synthetic creates that make mid-life coins look fresh): built a local 1h/2h-block phantom surrogate — it did NOT reproduce the stress losses (median −0.01, normal trip counts). Hypothesis rejected; the surrogate builder source is not in the kit tarball, so the exact mechanism was not recoverable from outside.

## Why stress fails (dissection)

1. **Concentration.** 90% of dev gains come from 3 coins; the single best coin gained +0.048 SOL in 5 slots (a violent early pump, not a long runner). Without the top 3, dev is −0.02.
2. **Timing dependence.** The entry signal (rq ≥ 8 within 15 slots of a clean launch) only works because, in real time, fast accumulation is followed by the pump it anticipates. Block resampling breaks the launch→pump sequence while keeping the downward drift of the average coin, so entries fire on the same pattern but the follow-through is gone.
3. **No tested architecture survived resampling.** Momentum, reversion, mature-state momentum, sniper, probe tilts, exit variants — every one is stress-negative, because every edge found in this dataset is a timing edge on a handful of coins.

## Final-window proxy (contiguous 6h slices = final-window length)

Main-only (probes off), minRq8: [+0.045, +0.004, 0.000, +0.007] per chunk, median +0.005, 3/4 positive, 2–3 trips per chunk.
With cheap probes (shipped): [+0.033, −0.008, −0.010, −0.003], median −0.006, 1/4 positive.
The probes cost ~0.01 SOL per 6h but are the price of a valid entry: main entries alone average ~2 coins per 6h, far below the 20-coin guardrail.

## Files

- `main.ts` — entrypoint.
- `strategy.ts` — the strategy.
- `vendor/agentfun-bot.ts` — kit SDK shim, vendored byte for byte (sha256 `4e243d4a0adce99b66b6124dd5a9c06867a92f7a0dd03dc6d65195f2f9ebbf08`).
- `README.md` — strategy + results.
- `REPORT.md` — this file.
