import { Injectable, Logger } from '@nestjs/common';
import { ExchangeDataService } from '../exchange-data/exchange-data.service';
import { OrdersService } from 'src/orders/orders.service';

/*
=====================================================================
AUTO SQUARE OFF — ALL POSITIONS HELPER
=====================================================================
Purpose:
  Unlike AutoStradleRMSService.triggerTimeBasedSquareOff(), which only
  acts on tokens present in an activeConfig's legsData, this service
  reads raw broker net positions directly and closes EVERYTHING open
  — manually placed trades, orphaned legs from deleted/inactive
  configs, anything. It has zero knowledge of straddle configs.

  Called by AutoSquareOffService as an additional/alternate step
  during the square-off window.

Flow:
  closeAllOpenPositions(reason)   ← called every 5s while in the square-off window
       ↓
  getNetPositions() → filter netqty !== 0
       ↓
  for each open position:
       ↓
     closeSinglePositionOnce()
       ↓
     re-fetch THIS position fresh, build LMT price from its own lp/ti
       ↓
     place ONE LMT/IOC order opposite side, full qty
       ↓
     return — no internal retry loop
       ↓
  (any position still open gets picked up fresh on the NEXT 5s tick,
   once the broker's position snapshot has had time to settle)
=====================================================================
*/

@Injectable()
export class AutoSquareOffAllPositionsService {
  private readonly logger = new Logger(AutoSquareOffAllPositionsService.name);

  private readonly MAX_ORDERS_PER_SECOND = 10;
  private orderCounter = 0;
  private windowStart = Date.now();

  // ⭐ NEW — run-lock. AutoSquareOffService's @Interval(5000) can call
  // closeAllOpenPositions() again before a prior call (which may take
  // longer than 5s across multiple positions/retries) has finished.
  // Without this lock, overlapping calls each run their own independent
  // retry loop on the SAME position, resulting in duplicate/excess orders.
  private isRunning = false;

  constructor(
    private readonly exchangeDataService: ExchangeDataService,
    private readonly ordersService: OrdersService,
  ) {}

  // =====================================================
  // PUBLIC ENTRY POINT
  // =====================================================
  public async closeAllOpenPositions(
    reason: string = 'AUTO_SQUARE_OFF_ALL_POSITIONS',
  ): Promise<{ attempted: number; closed: number; failed: number }> {
    if (this.isRunning) {
      this.logger.warn(
        `[ALL POSITIONS] Skipped — previous run still in progress (reason=${reason})`,
      );
      return { attempted: 0, closed: 0, failed: 0 };
    }

    this.isRunning = true;

    try {
      //   const netPositions = await this.exchangeDataService.getNetPositions();
      const netPositions =
        await this.exchangeDataService.waitForFreshNetPositions(2); // wait for up to 2 retries to get fresh data

      const openPositions = (netPositions || []).filter(
        (p) => Number(p.raw?.netqty || 0) !== 0,
      );

      if (!openPositions.length) {
        return { attempted: 0, closed: 0, failed: 0 };
      }

      this.logger.warn(
        `🚨 [ALL POSITIONS] Found ${openPositions.length} open position(s) to square off | reason=${reason}`,
      );

      let closed = 0;
      let stillOpenOrPlaced = 0;

      // sequential on purpose — throttleOrders() below still caps rate,
      // but sequential keeps logging simple to reason about for what is
      // effectively a last-resort safety net
      for (const pos of openPositions) {
        const result = await this.closeSinglePositionOnce(pos, reason);
        if (result === 'ALREADY_FLAT') closed++;
        else stillOpenOrPlaced++;
      }

      this.logger.warn(
        `[ALL POSITIONS] Done | attempted=${openPositions.length} alreadyFlat=${closed} ordersPlacedOrSkipped=${stillOpenOrPlaced} (any still open gets re-checked with fresh data on next tick)`,
      );

      return {
        attempted: openPositions.length,
        closed,
        failed: stillOpenOrPlaced,
      };
    } catch (error) {
      this.logger.error('closeAllOpenPositions error', error?.stack || error);
      return { attempted: 0, closed: 0, failed: 0 };
    } finally {
      this.isRunning = false; // ⭐ CRITICAL — always release, even on error
    }
  }

  // Aggressive buffer applied to lp when building the LMT price, since we
  // only have last-traded-price here (no bid/ask depth like priceMap gives
  // the RMS service). 1% is enough to jump the touch on most liquid F&O /
  // large-cap equity without straying into circuit-limit rejection territory.
  private readonly LMT_PRICE_BUFFER = 0.01;

  // =====================================================
  // CLOSE ONE POSITION — SINGLE ATTEMPT ONLY (no internal retry loop)
  // =====================================================
  // ⭐ REWRITTEN — the previous version retried up to 3x with only a 500ms
  // gap between checks. exchangeDataService.getNetPositions() lags behind
  // actual fills (caching/polling delay on the broker side), so a 500ms
  // re-check often reads STALE qty and fires a SECOND full-size order for
  // a position the FIRST order had already closed — overshooting to the
  // opposite side. The next call then "corrects" that overshoot the same
  // way, snowballing (this is exactly the 2→3→4→7→13→25→46 lot-size
  // pattern seen on ONGC-EQ in the trade log: sell 1, sell 1 again on
  // stale data, now short, buy back too much, etc).
  //
  // Fix: place AT MOST ONE order per position per call. Let
  // AutoSquareOffService's natural 5-second @Interval tick be the retry
  // mechanism — 5 real seconds is far more time for the broker's position
  // snapshot to settle than 500ms, so each check reflects reality instead
  // of racing stale data.
  private async closeSinglePositionOnce(
    pos: any,
    reason: string,
  ): Promise<'ALREADY_FLAT' | 'ORDER_PLACED' | 'SKIPPED'> {
    // VERIFY these field names against your actual NetPosition.raw shape
    const tradingsymbol = pos.raw?.tsym;
    const exchange = pos.raw?.exch;
    const token = pos.raw?.token ?? pos.token;
    const productType = pos.raw?.prd || 'I';

    if (!tradingsymbol || !exchange || !token) {
      this.logger.error(
        `[ALL POSITIONS] Missing tsym/exch/token on position — skipping. raw=${JSON.stringify(
          pos.raw,
        )}`,
      );
      return 'SKIPPED';
    }

    // Fetch the freshest snapshot right before deciding — always pull
    // required fields (netqty, side, lp, ti) straight from this, never
    // from a value carried over between ticks.
    const currentPositions = await this.exchangeDataService.getNetPositions();
    const livePos = this.findPosition(
      currentPositions,
      token,
      exchange,
      productType,
    );
    const netQty = Number(livePos?.raw?.netqty || 0);

    if (netQty === 0) {
      this.logger.warn(
        `[ALL POSITIONS] Already flat: ${tradingsymbol} (${exchange})`,
      );
      return 'ALREADY_FLAT';
    }

    const side: 'B' | 'S' = netQty > 0 ? 'S' : 'B';
    const qty = Math.abs(netQty);

    // Build a LMT price from the position's own lp/ti fields — this
    // broker rejects MKT orders on the NSE/BSE equity (cash) segment
    // ("Order type is rejected"), so LMT is required universally here.
    const lmtPrice = this.buildLimitPrice(livePos, side);

    if (lmtPrice === undefined) {
      this.logger.error(
        `[ALL POSITIONS] No lp available to build LMT price for ${tradingsymbol} (${exchange}) — will retry on next tick`,
      );
      return 'SKIPPED';
    }

    this.logger.warn(
      `[ALL POSITIONS] Closing ${tradingsymbol} (${exchange}) qty=${qty} side=${side} lmtPrice=${lmtPrice}`,
    );

    try {
      await this.throttleOrders(1);

      const orderRes = await this.ordersService.placeOrder({
        buy_or_sell: side,
        product_type: productType,
        exchange,
        tradingsymbol,
        quantity: qty,
        price_type: 'LMT',
        price: lmtPrice,
        trigger_price: 0,
        discloseqty: 0,
        retention: 'IOC',
        amo: 'NO',
        remarks: `AUTO_SQUARE_OFF_ALL_POSITIONS (${reason})`,
      });

      // Broker APIs like Shoonya/Finvasia typically DON'T throw on a
      // rejected order — they return HTTP 200 with { stat: 'Not_Ok', emsg }.
      const stat = (orderRes as any)?.stat;
      if (stat && String(stat).toLowerCase() !== 'ok') {
        this.logger.error(
          `[ALL POSITIONS] Broker REJECTED order for ${tradingsymbol} (${exchange}) prd=${productType} | response=${JSON.stringify(
            orderRes,
          )}`,
        );
      } else {
        this.logger.debug(
          `[ALL POSITIONS] Order accepted for ${tradingsymbol} | response=${JSON.stringify(
            orderRes,
          )}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[ALL POSITIONS] placeOrder threw for ${tradingsymbol}`,
        err?.stack || err,
      );
    }

    // ⭐ Exactly ONE order placed for this position this call. No
    // immediate re-check-and-retry here — that's what caused the
    // overshoot. The next 5s tick re-fetches positions (now settled)
    // and decides fresh whether anything is still open.
    return 'ORDER_PLACED';
  }

  private findPosition(
    netPositions: any[],
    token: string,
    exchange: string,
    productType: string,
  ): any | undefined {
    // ⭐ CRITICAL — must match on productType too. The broker tracks CNC
    // ("C") and NRML ("M") as SEPARATE positions even for the identical
    // token/exchange (see ITC-EQ: one entry prd=C netqty=0, another
    // prd=M netqty=2, both token=1660/exch=NSE simultaneously). Matching
    // by token+exchange alone can silently resolve to the WRONG entry
    // (e.g. the flat CNC one) while the real open NRML position never
    // gets picked up — which is exactly what caused "Already flat"
    // to be logged while the position stayed open indefinitely.
    return netPositions.find(
      (p) =>
        (p.token === token || p.raw?.token === token) &&
        p.raw?.exch === exchange &&
        p.raw?.prd === productType,
    );
  }

  // Builds an aggressive LMT price from the position's own lp/ti,
  // no priceMap/tick-feed subscription required.
  private buildLimitPrice(pos: any, side: 'B' | 'S'): number | undefined {
    const lp = Number(pos?.raw?.lp || 0);
    const tickSize = Number(pos?.raw?.ti || 0) || 0.05;

    if (!lp || lp <= 0) return undefined;

    let raw: number;

    if (side === 'S') {
      // exiting a LONG → sell aggressively below lp
      raw = lp * (1 - this.LMT_PRICE_BUFFER);
      raw = Math.floor(raw / tickSize) * tickSize;
    } else {
      // exiting a SHORT → buy aggressively above lp
      raw = lp * (1 + this.LMT_PRICE_BUFFER);
      raw = Math.ceil(raw / tickSize) * tickSize;
    }

    if (!raw || raw <= 0 || isNaN(raw)) return undefined;

    return Number(raw.toFixed(2));
  }

  // same 10-orders/sec throttle pattern as AutoStradleRMSService
  private async throttleOrders(orderCount: number) {
    const now = Date.now();

    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.orderCounter = 0;
    }

    if (this.orderCounter + orderCount > this.MAX_ORDERS_PER_SECOND) {
      const wait = 1000 - (now - this.windowStart);
      if (wait > 0) {
        this.logger.log(
          `[ALL POSITIONS] Rate limit reached. Waiting ${wait} ms.`,
        );
        await this.sleep(wait);
      }
      this.windowStart = Date.now();
      this.orderCounter = 0;
    }

    this.orderCounter += orderCount;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
