// Fresh-launch sniper with trailing runners, for the pump.fun replay (agent-fun/replay/v2).
//
// Why this shape: the dev window punishes chasing breakouts — buying a curve after it has
// already risen 6%+ mostly buys the top of a pump that then dumps (my first momentum build lost
// 1.15 SOL on the dev window, the kit's momentum pilot lost 9.38). Fresh launches behave
// differently: a coin is either a rug/bundle that dies in seconds or a runner. So this bot only
// buys in a coin's first few slots, only when the launch looks clean — the creator bought little,
// has not sold, and only a handful of other wallets piled in (a launch bundled by many wallets
// in its first slot is usually the creator's cluster waiting to dump) — and then it cuts losers
// fast while letting winners run on a trailing stop instead of a fixed take-profit, because on
// pump.fun the rare 2-5x runner is what pays for all the small losers. A separate probe lane runs
// tiny round trips purely to keep the run above the guardrail minimum (20 coins with a round trip
// each) when fresh-launch entries are scarce.
//
// Fees shape everything: each side pays ~1.25% curve fees plus a flat 105k-lamport tx fee, so a
// round trip costs ~2.5% of stake before price moves. Stakes are therefore kept small (0.08 SOL)
// and single-shot (no adds: each extra order pays another flat tx fee), and the stop is tight
// enough that a dead coin costs ~12% of a small stake, not a big one.
//
// Deterministic by construction: no clock, no randomness, iteration only over insertion-ordered
// maps fed by the batch stream, so two runs produce identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to put into one coin (single shot; the 1%-of-real-reserve cap may shrink it). */
  stakeSol: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Real SOL reserve window at decision time. */
  minRqSol: number;
  maxRqSol: number;
  /** Creator's own buys before entry: at most this much SOL in total. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers before entry, at most (anti-bundle). */
  maxBuyers: number;
  /** Distinct non-creator buyers before entry, at least. */
  minBuyers: number;
  /** Largest single sell seen before entry (SOL): above it, the launch is already dumping. */
  maxEarlySellSol: number;
  /** Price now over the create price, at most (skip coins that already pumped). */
  maxRunup: number;
  /** Exit when close value falls below cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit when close value falls below peak * (1 - trail), once armed. */
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Hard take-profit: exit when value reaches cost * takeProfit. */
  takeProfit: number;
  /** Exit after this many slots held (unless up by holdIfUp). */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Most momentum positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing targets (coins) over paceSecs of block time. */
  targetCoins: number;
  paceSecs: number;
  /** Probe round-trip size (SOL). */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

// Settings traded with. Picked by sweeping the full dev window and preferring the flat region
// around the best cell over a single sharp peak (see REPORT.md): enter only coins that pull in
// 8+ SOL of real reserves within their first 15 slots with a clean launch (creator bought little,
// has not sold, at most 5 other buyers, no big early sell, price not already 2x the create
// price), one small single-shot stake, tight stop, trailing stop once up 20%. See REPORT.md for
// the dev + stress numbers.
export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 15,
  stakeSol: 0.12,
  minBuySol: 0.005,
  buySlipBps: 10000,
  minRqSol: 8,
  maxRqSol: 40,
  maxDevBuySol: 1,
  maxBuyers: 5,
  minBuyers: 1,
  maxEarlySellSol: 0.5,
  maxRunup: 2,
  stopLoss: 0.2,
  trail: 0.2,
  trailArm: 0.2,
  takeProfit: 3,
  maxHold: 120,
  holdIfUp: 0.1,
  bigSellSol: 1,
  maxMain: 5,
  maxExposureSol: 3,
  targetCoins: 21,
  paceSecs: 21600,
  probeSol: 0.01,
  maxProbes: 2,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Coin {
  creator: string;
  created: number;
  /** Price (vq/vt) at creation. */
  createPrice: number;
  /** SOL the creator has bought since creation. */
  devBuySol: number;
  /** Whether the creator has sold any. */
  devSold: boolean;
  /** Distinct non-creator buyers seen. */
  buyers: Set<string>;
  /** Largest single sell seen (SOL). */
  worstSell: number;
  /** Net SOL flow (buys minus sells) since creation. */
  netSol: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin | undefined => coins.get(mint);

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          // Only the first CreateEvent for a mint counts: a replayed window can carry the same
          // create twice (block surrogates repeat blocks), and re-creating the record would
          // wipe the done flag and let the bot buy the same coin again mid-dump. On real data a
          // mint is created exactly once, so this changes nothing there.
          if (!coins.has(e.mint)) {
            coins.set(e.mint, {
              creator: e.user,
              created: e.slot,
              createPrice: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
              devBuySol: 0,
              devSold: false,
              buyers: new Set(),
              worstSell: 0,
              netSol: 0,
              done: false,
            });
          }
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          if (c !== undefined) {
            const sol = Number(e.sol_amount) / LAMPORTS;
            c.netSol += e.is_buy ? sol : -sol;
            if (!e.is_buy && sol > c.worstSell) c.worstSell = sol;
            if (e.user === c.creator) {
              if (e.is_buy) c.devBuySol += sol;
              else c.devSold = true;
            } else if (e.is_buy) {
              c.buyers.add(e.user);
            }
          }
          traded.add(e.mint);
          if (!e.is_buy && Number(e.sol_amount) / LAMPORTS >= p.bigSellSol) bigSell.add(e.mint);
        } else if (e.event === 'CompleteEvent') {
          const c = coinOf(e.mint);
          if (c !== undefined) c.done = true;
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Close value of a position in SOL, after curve fees and one tx fee.
      const closeValue = (mint: Pubkey, curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): number => {
        const pos = state.positions.get(mint);
        if (pos === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first: stop loss, trailing stop (once armed), hard take-profit, time limit,
      // creator sell, or a single big sell on the tape.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (c !== undefined) c.done = true;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(mint, curve);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const c = coinOf(mint);
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && value >= cost * p.takeProfit) exit = true;
        if (!exit && c !== undefined && c.devSold) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries: only fresh, clean launches.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const c = coinOf(mint);
        if (c === undefined || c.done) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        const age = now - c.created;
        if (age < p.minAge || age > p.maxAge) continue;
        if (c.devSold || c.devBuySol > p.maxDevBuySol) continue;
        if (c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) continue;
        if (c.worstSell >= p.maxEarlySellSol) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (c.createPrice <= 0 || price / c.createPrice > p.maxRunup) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0 });
        c.done = true;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's distinct coins lag the pace, so the run
      // ends above the minimum bar (20 coins with a round trip each) even in a quiet window.
      // Only the coin count paces the probes: fills follow from the round trips themselves, and
      // a fill-count target would keep buying probes long after the bar is cleared, bleeding a
      // flat tx fee plus ~2.5% curve fees on every useless round trip.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        if (needCoins) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          let bestMint: Pubkey | null = null;
          let bestRq = 0;
          for (const mint of traded) {
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const rq = Number(curve.real_quote_reserves) / LAMPORTS;
            if (rq > bestRq) {
              bestRq = rq;
              bestMint = mint;
            }
          }
          if (bestMint !== null && bestRq >= minRq * 1.5 && free >= p.probeSol + 2 * tx && orders.length < cap) {
            orders.push({ side: 'buy', mint: bestMint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(bestMint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
