import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AutoStradleStrategyService } from './auto-stradle-strategy.service';
import { ExchangeDataService } from '../exchange-data/exchange-data.service';
import { MarketTick } from './interfaces/market-tick-interface';

import * as fs from 'fs';
import * as path from 'path';
import { OrdersService } from 'src/orders/orders.service';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { TelegramService } from 'src/telegram/telegram.service';
@Injectable()
export class AutoStradleRMSService implements OnModuleInit {
  private readonly logger = new Logger(AutoStradleRMSService.name);

  private activeConfigs: any[] = [];
  private tokenIndex = new Map<string, any[]>();
  private underlyingIndex = new Map<string, any[]>();
  private priceMap = new Map<string, MarketTick>();
  private exitLocks = new Set<string>();

  private positionStability = new Map<
    string,
    { legs: Map<string, { netQty: number; stableSince: number }> }
  >(); // ⭐ ADD

  private readonly SAVE_PATH = path.join(
    process.cwd(),
    'data',
    'AutoStradleTrade',
  );

  private readonly thresholdRatio: number;
  private readonly underlyingMovePercent: number;
  private readonly stabilityWindowMs: number; // ⭐ ADD
  private readonly stepLots: number; // ⭐ For ratio

  constructor(
    private readonly autoStradleService: AutoStradleStrategyService,
    private readonly exchangeDataService: ExchangeDataService,
    private readonly telegramService: TelegramService,

    private readonly ordersService: OrdersService,
    private readonly configService: ConfigService,
  ) {
    this.thresholdRatio = Number(
      this.configService.get('STRADLE_RATIO_THRESHOLD', 1.25),
    );
    this.underlyingMovePercent = Number(
      this.configService.get('UNDERLYING_MOVE_EXIT_PCT', 2),
    ); // 2%

    this.stabilityWindowMs = Number(
      this.configService.get('RMS_POSITION_STABLE_MS', 2500),
    ); // ⭐ ADD — how long qty must be unchanged before RMS runs

    // ⭐ ADD — same env var as execution file, keeps entry/exit step size in sync
    this.stepLots = Number(this.configService.get('STRADLE_STEP_LOTS', 1)) || 1;
  }

  // =====================================================
  // INIT
  // =====================================================

  async onModuleInit() {
    this.ensureFolder();
    this.activeConfigs = await this.autoStradleService.findActive();
    this.buildIndex();
  }

  // also to update bulding index on regular bases
  @Interval(5000)
  async refreshIndexPeriodically() {
    try {
      this.activeConfigs = await this.autoStradleService.findActive();
      this.buildIndex();
    } catch (e) {
      this.logger.error('refreshIndexPeriodically error', e);
    }
  }
  // =====================================================
  // TICK RECEIVER
  // =====================================================

  handleTick(feed: MarketTick) {
    try {
      if (!feed?.e || !feed?.tk) {
        return;
      }

      const key = `${feed.e}|${feed.tk}`;
      // testing by sending price feed to telegram

      // this.logger.debug(`Received tick for ${key}`);
      // this.logger.debug(feed);
      this.logger.debug(`Tick received for key=${key}`);

      // ⭐ Merge tick safely
      const updatedTick = this.mergeTickData(key, feed);

      // ⭐ Process related straddles
      void this.processConfigsForToken(key);
    } catch (error) {
      this.logger.error('handleTick error', error?.stack || error);
    }
  }

  // =====================================================
  // UPDATE LIVE DATA
  // RETURNS TRUE IF POSITION EXISTS
  // =====================================================

  private async updateConfigLiveData(
    config: any,
    netPositions: any[],
  ): Promise<boolean> {
    try {
      this.logger.debug(`Processing config ${config._id}`);

      let totalLiveValue = 0;
      let totalInvestedValue = 0;
      let totalPnL = 0;
      let hasOpenPosition = false;

      const trades = this.exchangeDataService.getTrades();

      for (const leg of config.legsData) {
        const key = `${leg.exch}|${leg.tokenNumber}`;
        const tick = this.priceMap.get(key);
        // debug data logs
        if (!tick) {
          this.logger.warn(`Missing tick for ${key}`);
        }

        if (!tick) continue;

        const netQty = this.getNetQty(netPositions, leg);
        if (!netQty) {
          this.logger.warn(`NetQty ZERO for ${key} `);
        }
        if (!netQty) continue;

        hasOpenPosition = true;

        // 🔹 Direction-based exit price
        const exitPrice = this.resolveExitPrice(tick, netQty);

        // 🔹 Trade-based average (your corrected function)
        const avg = this.getAvgPriceFromTrades(trades, leg, netQty);

        const absQty = Math.abs(netQty);

        // 🔹 Live value
        const liveValue = exitPrice * absQty;

        // 🔹 Invested value
        const investedValue = avg * absQty;

        // 🔹 PnL calculation
        const pnl =
          netQty > 0 ? liveValue - investedValue : investedValue - liveValue;

        // 🔹 Update leg
        leg.livePrice = exitPrice;
        leg.openNetQty = netQty;
        leg.avgEntryPrice = avg;
        leg.liveValue = liveValue;
        leg.investedValue = investedValue;
        leg.livePnL = pnl;

        totalLiveValue += liveValue;
        totalInvestedValue += investedValue;
        totalPnL += pnl;
      }

      // ✅ UPDATE UNDERLYING INDEX PRICE
      this.updateUnderlyingPrice(config, hasOpenPosition);

      // 🔥 Strategy level values
      config.liveValue = totalLiveValue;
      config.investedValue = totalInvestedValue;
      config.totalPnL = totalPnL;

      config.totalPnLPercentage = totalInvestedValue
        ? (totalPnL / totalInvestedValue) * 100
        : 0;

      // ✅ ADD VALUE RATIO (NEW FIELD)
      this.updateLegValueRatios(config);

      // ✅ CHECK FOR RMS EXIT
      // await this.checkRatioExit(config);
      // void this.runExitChecks(config);

      // await this.runExitChecks(config);

      // ✅ CHECK FOR RMS EXIT
      // await this.checkRatioExit(config);
      // void this.runExitChecks(config);
      // if (this.isMinimumQuantityBuilt(config, netPositions)) {
      //   await this.runExitChecks(config);
      // } else {
      //   this.logger.debug(
      //     `⏳ Waiting for full required qty to build before RMS checks: ${config._id}`,
      //   );
      // }
      // ✅ CHECK FOR RMS EXIT
      if (this.isPositionStable(config, netPositions)) {
        await this.runExitChecks(config);
      } else {
        this.logger.debug(
          `⏳ Position still building/changing — RMS checks held for ${config._id}`,
        );
      }

      // ✅ RATIO CALCULATION
      const maxValue = Math.max(
        Math.abs(totalInvestedValue),
        Math.abs(totalLiveValue),
      );

      const minValue = Math.min(
        Math.abs(totalInvestedValue),
        Math.abs(totalLiveValue),
      );

      config.ratio = minValue > 0 ? maxValue / minValue : 0;

      config.totalPnLPercentage = totalInvestedValue
        ? (totalPnL / totalInvestedValue) * 100
        : 0;

      return hasOpenPosition;
    } catch (error) {
      this.logger.error('updateConfigLiveData error', error?.stack || error);
      return false;
    }
  }

  // =====================================================
  // PRICE RESOLUTION (DIRECTION BASED)
  // =====================================================

  private resolveExitPrice(tick: MarketTick, netQty: number): number {
    // LONG → use BID
    if (netQty > 0) {
      return tick.bp1 ?? tick.lp ?? 0;
    }

    // SHORT → use ASK
    if (netQty < 0) {
      return tick.sp1 ?? tick.lp ?? 0;
    }

    return tick.lp ?? 0;
  }

  // =====================================================
  // NET POSITION HELPERS
  // =====================================================

  private getNetQty(netPositions: any[], leg: any): number {
    const pos = netPositions.find(
      (p) => p.token === leg.tokenNumber && p.raw?.exch === leg.exch,
    );

    return Number(pos?.raw?.netqty || 0);
  }

  // private getAvgPrice(netPositions: any[], leg: any): number {
  //   const pos = netPositions.find(
  //     (p) => p.token === leg.tokenNumber && p.raw?.exch === leg.exch,
  //   );

  //   return Number(pos?.raw?.netavgprc || 0);
  // }

  // =====================================================
  // SAVE JSON IF OPEN
  // =====================================================

  private persistConfig(config: any) {
    try {
      const file = path.join(this.SAVE_PATH, `${config._id}.json`);

      fs.writeFileSync(file, JSON.stringify(config, null, 2));
      this.logger.debug(`Writing JSON file ${config._id}`);
    } catch (err) {
      this.logger.error('persistConfig error', err?.stack || err);
    }
  }

  // =====================================================
  // DELETE FILE IF CLOSED
  // =====================================================

  private removeConfigFile(config: any) {
    try {
      const file = path.join(this.SAVE_PATH, `${config._id}.json`);

      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        this.logger.log(`🧹 Removed closed trade file: ${config._id}`);
      }
    } catch (err) {
      this.logger.error('removeConfigFile error', err?.stack || err);
    }
  }

  // =====================================================
  // INDEX BUILDER
  // =====================================================

  private buildIndex() {
    this.tokenIndex.clear();
    this.underlyingIndex.clear(); // ⭐ ADD

    for (const config of this.activeConfigs) {
      // ======================
      // UNDERLYING INDEX
      // ======================

      const underlyingKey = `${config.exchange}|${config.tokenNumber}`;

      if (!this.underlyingIndex.has(underlyingKey)) {
        this.underlyingIndex.set(underlyingKey, []);
      }

      this.underlyingIndex.get(underlyingKey)!.push(config);

      // ======================
      // EXISTING TOKEN INDEX
      // ======================

      if (!this.tokenIndex.has(underlyingKey)) {
        this.tokenIndex.set(underlyingKey, []);
      }

      this.tokenIndex.get(underlyingKey)!.push(config);

      for (const leg of config.legsData || []) {
        const key = `${leg.exch}|${leg.tokenNumber}`;

        if (!this.tokenIndex.has(key)) {
          this.tokenIndex.set(key, []);
        }

        this.tokenIndex.get(key)!.push(config);
      }
    }
  }

  private ensureFolder() {
    if (!fs.existsSync(this.SAVE_PATH)) {
      fs.mkdirSync(this.SAVE_PATH, { recursive: true });
    }
  }

  // =====================================================
  // PRICE FEED MERGER HELPER
  // =====================================================
  private mergeTickData(key: string, feed: MarketTick): MarketTick {
    const existing =
      this.priceMap.get(key) ||
      ({
        e: feed.e,
        tk: feed.tk,
      } as MarketTick);

    const updated: MarketTick = {
      ...existing,

      t: feed.t ?? existing.t,

      lp: feed.lp !== undefined ? Number(feed.lp) : existing.lp,

      pc: feed.pc !== undefined ? Number(feed.pc) : existing.pc,

      v: feed.v !== undefined ? Number(feed.v) : existing.v,

      o: feed.o !== undefined ? Number(feed.o) : existing.o,

      h: feed.h !== undefined ? Number(feed.h) : existing.h,

      l: feed.l !== undefined ? Number(feed.l) : existing.l,

      c: feed.c !== undefined ? Number(feed.c) : existing.c,

      ap: feed.ap !== undefined ? Number(feed.ap) : existing.ap,

      oi: feed.oi !== undefined ? Number(feed.oi) : existing.oi,

      poi: feed.poi !== undefined ? Number(feed.poi) : existing.poi,

      toi: feed.toi !== undefined ? Number(feed.toi) : existing.toi,

      bq1: feed.bq1 !== undefined ? Number(feed.bq1) : existing.bq1,

      bp1: feed.bp1 !== undefined ? Number(feed.bp1) : existing.bp1,

      sq1: feed.sq1 !== undefined ? Number(feed.sq1) : existing.sq1,

      sp1: feed.sp1 !== undefined ? Number(feed.sp1) : existing.sp1,
    };

    this.priceMap.set(key, updated);

    return updated;
  }

  private async processConfigsForToken(key: string) {
    const relatedConfigs = this.tokenIndex.get(key);

    if (!relatedConfigs?.length) {
      // this.logger.warn(
      //   `No configs mapped for token ${key}  which can lead not making rms json file for closed position and not exiting on time, consider checking index mapping for this token`,
      // );
      return;
    }

    const netPositions = await this.exchangeDataService.getNetPositions();

    for (const config of relatedConfigs) {
      const hasOpenPosition = await this.updateConfigLiveData(
        config,
        netPositions,
      );

      if (hasOpenPosition) {
        this.logger.debug(
          `Persist decision: hasOpenPosition=${hasOpenPosition} for ${config._id}`,
        );
        this.persistConfig(config);
      } else {
        this.removeConfigFile(config);
      }
    }
  }

  // old working
  // private getAvgPriceFromTrades(
  //   trades: any[],
  //   leg: any,
  //   netQty: number,
  // ): number {
  //   try {
  //     if (!netQty || !trades?.length) return 0;

  //     const targetQty = Math.abs(netQty);

  //     // STEP 1 — filter matching token
  //     const tokenTrades = trades
  //       .filter(
  //         (t) =>
  //           String(t.raw?.token) === String(leg.tokenNumber) &&
  //           String(t.raw?.exch) === String(leg.exch),
  //       )
  //       .sort((a, b) => {
  //         const format = (str: string) => {
  //           const [datePart, timePart] = str.split(' ');
  //           const [dd, mm, yyyy] = datePart.split('-');
  //           return `${yyyy}${mm}${dd}${timePart.replace(/:/g, '')}`;
  //         };

  //         return format(b.raw.exch_tm).localeCompare(format(a.raw.exch_tm));
  //       }); // latest first
  //     // .sort(
  //     //   (a, b) =>
  //     //     new Date(b.raw.exch_tm).getTime() -
  //     //     new Date(a.raw.exch_tm).getTime(),
  //     // ); // 🔥 latest first

  //     if (!tokenTrades.length) return 0;
  //     // this.logger.debug(
  //     //   `Found ${tokenTrades.length} trades for token ${leg.tokenNumber}`,
  //     // );
  //     // this.logger.debug('last trade price', tokenTrades[0].raw.flprc);
  //     // this.logger.debug('last trade Time', tokenTrades[0].raw.exch_tm);

  //     let remaining = targetQty;
  //     let totalQty = 0;
  //     let totalValue = 0;

  //     // STEP 2 — walk from latest trades backward
  //     for (const t of tokenTrades) {
  //       if (remaining <= 0) break;

  //       const tradeSide = t.raw.trantype;
  //       const tradeQty = Number(t.raw.flqty || 0);
  //       const tradePrice = Number(t.raw.flprc || 0);

  //       // LONG position → consider BUY trades only
  //       if (netQty > 0 && tradeSide !== 'B') continue;

  //       // SHORT position → consider SELL trades only
  //       if (netQty < 0 && tradeSide !== 'S') continue;

  //       const usedQty = Math.min(tradeQty, remaining);

  //       totalQty += usedQty;
  //       totalValue += usedQty * tradePrice;

  //       remaining -= usedQty;
  //     }

  //     if (!totalQty) return 0;

  //     const avg = totalValue / totalQty;

  //     // this.logger.debug(
  //     //   `AVG CALC | token=${leg.tokenNumber} | netQty=${netQty} | avg=${avg}`,
  //     // );

  //     return avg;
  //   } catch (error) {
  //     this.logger.error('getAvgPriceFromTrades error', error);
  //     return 0;
  //   }
  // }

  private getAvgPriceFromTrades(
    trades: any[],
    leg: any,
    netQty: number,
  ): number {
    try {
      if (!netQty || !trades?.length) return 0;

      const parseTm = (str: string) => {
        const [datePart, timePart] = str.split(' ');
        const [dd, mm, yyyy] = datePart.split('-');
        return `${yyyy}${mm}${dd}${timePart.replace(/:/g, '')}`;
      };

      // STEP 1 — filter matching token, sort OLDEST -> NEWEST (chronological)
      const tokenTrades = trades
        .filter(
          (t) =>
            String(t.raw?.token) === String(leg.tokenNumber) &&
            String(t.raw?.exch) === String(leg.exch),
        )
        .sort((a, b) =>
          parseTm(a.raw.exch_tm).localeCompare(parseTm(b.raw.exch_tm)),
        );

      if (!tokenTrades.length) return 0;

      // STEP 2 — FIFO queue of currently-open lots
      const queue: { qty: number; price: number; side: 'B' | 'S' }[] = [];

      for (const t of tokenTrades) {
        // let qty = Number(t.raw.flqty || 0);
        let qty = Number(t.raw.qty || 0); // as trade data api send cumilitive quantity
        const price = Number(t.raw.flprc || 0);
        const side = t.raw.trantype as 'B' | 'S';

        if (!qty || !price || (side !== 'B' && side !== 'S')) continue;

        while (qty > 0) {
          const front = queue[0];

          if (!front || front.side === side) {
            // same direction (or empty book) -> opens/extends a lot
            queue.push({ qty, price, side });
            qty = 0;
          } else {
            // opposite direction -> closes existing lot(s) FIFO
            const matchQty = Math.min(front.qty, qty);
            front.qty -= matchQty;
            qty -= matchQty;
            if (front.qty <= 0) queue.shift();
          }
        }
      }

      if (!queue.length) return 0;

      // STEP 3 — sanity check vs broker netQty (log only, don't block)
      const queuedQty = queue.reduce((s, l) => s + l.qty, 0);
      const queuedSide = queue[0].side;
      const expectedSide = netQty > 0 ? 'B' : 'S';

      if (queuedSide !== expectedSide || queuedQty !== Math.abs(netQty)) {
        this.logger.warn(
          `AVG CALC mismatch | token=${leg.tokenNumber} broker netQty=${netQty} | FIFO queue side=${queuedSide} qty=${queuedQty}`,
        );
      }

      // STEP 4 — weighted average of whatever is left open
      let totalQty = 0;
      let totalValue = 0;

      for (const lot of queue) {
        totalQty += lot.qty;
        totalValue += lot.qty * lot.price;
      }

      return totalQty ? totalValue / totalQty : 0;
    } catch (error) {
      this.logger.error('getAvgPriceFromTrades error', error);
      return 0;
    }
  }

  // helper to get legs rations based on live value
  private updateLegValueRatios(config: any) {
    try {
      const legs = config.legsData || [];

      if (legs.length < 2) {
        // Not enough legs → reset valueRatio
        for (const leg of legs) {
          leg.valueRatio = 0;
        }
        return;
      }

      // Assuming straddle (2 legs)
      const [leg1, leg2] = legs;

      const v1 = Math.abs(leg1.liveValue || 0);
      const v2 = Math.abs(leg2.liveValue || 0);

      leg1.valueRatio = v2 > 0 ? v1 / v2 : 0;
      leg2.valueRatio = v1 > 0 ? v2 / v1 : 0;
    } catch (error) {
      this.logger.error('updateLegValueRatios error', error?.stack || error);
    }
  }

  // helper to convert time to IST format for file naming
  private getISTTime(): string {
    return (
      new Date()
        .toLocaleString('sv-SE', {
          timeZone: 'Asia/Kolkata',
        })
        .replace(' ', 'T') + '+05:30'
    );
  }
  // helper to update underling price and entry time (only if not set) on each tick
  private updateUnderlyingPrice(config: any, hasOpenPosition: boolean) {
    try {
      const key = `${config.exchange}|${config.tokenNumber}`;
      const tick = this.priceMap.get(key);
      if (!tick?.lp) return;

      if (!config.underlyingPrice) {
        config.underlyingPrice = {};
      }

      const nowIST = this.getISTTime();

      // ✅ Only capture entry price once position actually exists
      if (hasOpenPosition && !config.underlyingPrice.entryPrice) {
        config.underlyingPrice.entryPrice = Number(tick.lp);
        config.underlyingPrice.entryTimeIST = nowIST;
      }

      config.underlyingPrice.livePrice = Number(tick.lp);
      config.underlyingPrice.liveTimeIST = nowIST;
    } catch (error) {
      this.logger.error('updateUnderlyingPrice error', error?.stack || error);
    }
  }
  // private updateUnderlyingPrice(config: any) {
  //   try {
  //     const key = `${config.exchange}|${config.tokenNumber}`;
  //     const tick = this.priceMap.get(key);

  //     if (!tick?.lp) return;

  //     if (!config.underlyingPrice) {
  //       config.underlyingPrice = {};
  //     }

  //     const nowIST = this.getISTTime();

  //     // ✅ ENTRY PRICE — set only once
  //     if (!config.underlyingPrice.entryPrice) {
  //       config.underlyingPrice.entryPrice = Number(tick.lp);
  //       config.underlyingPrice.entryTimeIST = nowIST;
  //     }

  //     // ✅ LIVE PRICE — update always
  //     config.underlyingPrice.livePrice = Number(tick.lp);
  //     config.underlyingPrice.liveTimeIST = nowIST;
  //   } catch (error) {
  //     this.logger.error('updateUnderlyingPrice error', error?.stack || error);
  //   }
  // }

  // =====================================================
  // RATIO BASED RMS EXIT (NO EXECUTION SERVICE NEEDED)
  // =====================================================

  /*
  handleTick()
   ↓
updateConfigLiveData()
   ↓
updateLegValueRatios()
   ↓
runExitChecks()
       ↓
   multiple exit rules
       ↓
   squareOffConfig()
  */
  private async runExitChecks(config: any) {
    try {
      if (config.exitStatus === 'EXITING') return;

      await this.checkRatioExit(config);

      if (config.exitStatus === 'EXITING') return;

      await this.checkUnderlyingMoveExit(config);

      if (config.exitStatus === 'EXITING') return;

      await this.checkPnLExit(config);

      // future:
      // await this.checkStopLoss(config);
      // await this.checkTimeExit(config);
    } catch (error) {
      this.logger.error('runExitChecks error', error?.stack || error);
    }
  }
  // private async checkRatioExit(config: any) {
  //   const shouldExit = config.legsData.some(
  //     (leg) => Number(leg.valueRatio || 0) >= this.thresholdRatio,
  //   );

  //   if (!shouldExit) return;

  //   await this.squareOffConfig(config, 'RATIO_THRESHOLD');
  // }
  private async checkRatioExit(config: any) {
    // ⭐ Use per-strategy exitRatio from config instead of global env threshold.
    // Falls back to env-based thresholdRatio for any pre-existing config
    // saved before the exitRatio field existed (Mongo won't have the field).
    const ratioThreshold = Number(
      config.exitRatio ?? this.thresholdRatio ?? 1.75,
    );

    const shouldExit = config.legsData.some(
      (leg) => Number(leg.valueRatio || 0) >= ratioThreshold,
    );

    if (!shouldExit) return;

    await this.squareOffConfig(
      config,
      `RATIO_THRESHOLD(${ratioThreshold})`, // ⭐ include actual threshold used in exit reason for easier debugging/audit in logs & JSON file
    );
  }

  // =====================================================
  // UNDERLYING BASED RMS EXIT (NO EXECUTION SERVICE NEEDED)
  // =====================================================

  private async checkUnderlyingMoveExit(config: any) {
    const underlying = config.underlyingPrice;

    if (!underlying?.entryPrice || !underlying?.livePrice) return;

    const movePercent =
      ((underlying.livePrice - underlying.entryPrice) / underlying.entryPrice) *
      100;

    if (Math.abs(movePercent) < this.underlyingMovePercent) return;

    await this.squareOffConfig(config, 'UNDERLYING_MOVE');
  }

  private getNetPositionQty(
    netPositions: any[],
    token: string,
    exchange: string,
  ): number {
    const pos = netPositions.find(
      (p) => p.token === token && p.raw?.exch === exchange,
    );

    return Number(pos?.raw?.netqty || 0);
  }

  // =====================================================
  // UNIVERSAL SQUARE OFF FUNCTION
  // =====================================================

  /*
Exit trigger
   ↓
Ratio batch close
   ↓
Wait for position update
   ↓
Next batch
   ↓
Fully closed
/////////////////////////////////////
Manual exit arrives
   ↓
Lock acquired
   ↓
RMS auto exit tries
   ↓
LOCKED → ignored
*/

  private async squareOffConfig(config: any, reason: string) {
    const lockKey = String(config._id);

    if (this.exitLocks.has(lockKey)) {
      this.logger.warn(`⚠ Exit already locked ${config._id}`);
      return;
    }

    this.exitLocks.add(lockKey);

    try {
      if (!config?.legsData?.length) return;

      if (config.exitStatus === 'EXITED') {
        return;
      }

      config.exitStatus = 'EXITING';

      this.logger.warn(`🚨 RMS EXIT (${reason}) ${config._id}`);

      await this.executeRatioClose(config, reason);

      config.exitStatus = 'EXITED';
      this.clearPositionStability(config._id); // ⭐ ADD to clear positions stability
    } catch (error) {
      this.logger.error('squareOffConfig error', error?.stack || error);
    } finally {
      this.exitLocks.delete(lockKey); // ⭐ CRITICAL
    }
  }

  // old working
  // private async squareOffConfig(config: any, reason: string) {
  //   try {
  //     if (!config?.legsData?.length) return;

  //     // 🚫 Prevent duplicate execution
  //     if (config.exitStatus === 'EXITING') {
  //       this.logger.warn(`⚠ Exit already in progress for ${config._id}`);
  //       return;
  //     }

  //     if (config.exitStatus === 'EXITED') {
  //       this.logger.warn(`⚠ Config already exited ${config._id}`);
  //       return;
  //     }

  //     config.exitStatus = 'EXITING';

  //     this.logger.warn(`🚨 RMS EXIT triggered (${reason}) for ${config._id}`);

  //     const netPositions = await this.exchangeDataService.getNetPositions();

  //     // ===============================
  //     // STEP 1 — Place Exit Orders
  //     // ===============================

  //     for (const leg of config.legsData) {
  //       const netQty = this.getNetPositionQty(
  //         netPositions,
  //         leg.tokenNumber,
  //         leg.exch,
  //       );

  //       if (!netQty) continue;

  //       const exitSide = netQty > 0 ? 'S' : 'B';
  //       const qty = Math.abs(netQty);

  //       this.logger.warn(
  //         `📤 Placing exit order ${leg.tradingSymbol} qty=${qty}`,
  //       );

  //       await this.ordersService.placeOrder({
  //         buy_or_sell: exitSide,
  //         product_type: config.productType === 'INTRADAY' ? 'I' : 'M',
  //         exchange: leg.exch,
  //         tradingsymbol: leg.tradingSymbol,
  //         quantity: qty,
  //         price_type: 'MKT',
  //         price: 0,
  //         trigger_price: 0,
  //         discloseqty: 0,
  //         retention: 'DAY',
  //         amo: 'NO',
  //         remarks: `AUTO STRADLE RMS EXIT (${reason})`,
  //       });
  //     }

  //     // ===============================
  //     // STEP 2 — WAIT FOR CONFIRMATION
  //     // ===============================

  //     const maxWaitMs = 10000; // 10 sec
  //     const checkInterval = 500; // 500ms
  //     const startTime = Date.now();

  //     while (Date.now() - startTime < maxWaitMs) {
  //       await new Promise((res) => setTimeout(res, checkInterval));

  //       const latestPositions =
  //         await this.exchangeDataService.getNetPositions();

  //       const stillOpen = config.legsData.some((leg) => {
  //         const qty = this.getNetPositionQty(
  //           latestPositions,
  //           leg.tokenNumber,
  //           leg.exch,
  //         );
  //         return qty !== 0;
  //       });

  //       if (!stillOpen) {
  //         config.exitStatus = 'EXITED';
  //         this.logger.warn(
  //           `✅ Exit confirmed. Positions fully closed for ${config._id}`,
  //         );
  //         return;
  //       }

  //       this.logger.debug(`⏳ Waiting for exit confirmation ${config._id}`);
  //     }

  //     // Timeout fallback
  //     this.logger.error(
  //       `⚠ Exit confirmation timeout for ${config._id}. Manual check required.`,
  //     );
  //   } catch (error) {
  //     this.logger.error('squareOffConfig error', error?.stack || error);
  //   }
  // }

  /*

  Loop
   ↓
Calculate qty
   ↓
Place exit orders
   ↓
WAIT until BOTH legs update
   ↓
Recalculate
   ↓
Next batch

/////////////////////////////////////

Get net positions
   ↓
Convert to lots
   ↓
Calculate ratio batch size
   ↓
Limit to exchange max (25)
   ↓
Convert back to quantity
   ↓
Place order
   ↓
Wait for position update


////////////////////////////// new upcdate

ratio exit
↓
fallback exit
↓
only one leg left
↓
FINAL CLEANUP MODE
↓
close remaining qty safely
↓
loop ends only when BOTH zero

  */

  // ratio part for exit in batchs
  private async executeRatioClose(config: any, reason: string) {
    if (config.exitStatus !== 'EXITING') return;

    const [legA, legB] = config.legsData;
    if (!legA || !legB) return;

    const MAX_ORDER_LOTS = 25;
    // const STEP_LOTS = 1; // lots per leg per order while BOTH legs still open

    // ⭐ scale loop budget with actual position size so large positions
    // don't get cut off mid-exit by a fixed low ceiling
    const approxTotalLots =
      Number(legA.quantityLots || 0) + Number(legB.quantityLots || 0);
    const MAX_LOOP = Math.max(50, approxTotalLots + 20);

    let loopCount = 0;

    while (true) {
      loopCount++;

      if (loopCount > MAX_LOOP) {
        this.logger.error(`Exit max loop reached ${config._id}`);
        break;
      }

      const netPositions = await this.exchangeDataService.getNetPositions();

      const netA = this.getNetPositionQty(
        netPositions,
        legA.tokenNumber,
        legA.exch,
      );

      const netB = this.getNetPositionQty(
        netPositions,
        legB.tokenNumber,
        legB.exch,
      );

      // ======================
      // EXIT COMPLETE
      // ======================

      if (netA === 0 && netB === 0) {
        this.logger.warn(`Exit fully completed ${config._id}`);
        break;
      }

      const lotSizeA = this.getLotSizeFromPosition(
        netPositions,
        legA.tokenNumber,
        legA.exch,
      );

      const lotSizeB = this.getLotSizeFromPosition(
        netPositions,
        legB.tokenNumber,
        legB.exch,
      );

      if (!lotSizeA || !lotSizeB) {
        this.logger.error(`Lot size missing`);
        break;
      }

      const remainingALots = Math.floor(Math.abs(netA) / lotSizeA);
      const remainingBLots = Math.floor(Math.abs(netB) / lotSizeB);

      // let exitLotsA = 0;
      // let exitLotsB = 0;

      // ======================
      // FINAL CLEANUP MODE — only one leg still has qty
      // ======================

      // if (netA === 0 || netB === 0) {
      //   this.logger.warn(`Final cleanup mode`);

      //   // ⭐ cap even the single-leg cleanup, don't dump it all in one order
      //   exitLotsA = Math.min(remainingALots, MAX_ORDER_LOTS);
      //   exitLotsB = Math.min(remainingBLots, MAX_ORDER_LOTS);
      // } else {
      //   // ======================
      //   // BOTH LEGS STILL OPEN — step down together, one lot per leg
      //   // per order (mirrors entry-side execution logic)
      //   // ======================

      //   exitLotsA = Math.min(STEP_LOTS, remainingALots);
      //   exitLotsB = Math.min(STEP_LOTS, remainingBLots);

      //   this.logger.warn(`Stepped exit mode (1:1)`);
      // }
      const { exitLotsA, exitLotsB } = this.calculateExitBatch(
        legA,
        legB,
        remainingALots,
        remainingBLots,
        netA,
        netB,
        MAX_ORDER_LOTS,
        this.stepLots,
      );

      let qtyA = exitLotsA * lotSizeA;
      let qtyB = exitLotsB * lotSizeB;

      qtyA = Math.min(qtyA, Math.abs(netA));
      qtyB = Math.min(qtyB, Math.abs(netB));

      if (qtyA <= 0 && qtyB <= 0) {
        this.logger.warn(`Nothing to exit — stopping`);
        break;
      }

      this.logger.warn(
        `Exit batch | netA=${netA} qtyA=${qtyA} | netB=${netB} qtyB=${qtyB}`,
      );

      // ==============================
      // GET LIMIT PRICES FOR BOTH LEGS
      // ==============================

      const priceA =
        qtyA > 0 ? this.getRmsLimitPrice(legA, netA, netPositions) : undefined;

      const priceB =
        qtyB > 0 ? this.getRmsLimitPrice(legB, netB, netPositions) : undefined;

      // ==============================
      // VALIDATE BOTH PRICES
      // ==============================

      const legAPriceMissing = qtyA > 0 && priceA === undefined;
      const legBPriceMissing = qtyB > 0 && priceB === undefined;

      if (legAPriceMissing || legBPriceMissing) {
        if (legAPriceMissing) {
          this.logger.error(`EXIT price missing LEG A ${legA.tradingSymbol}`);
        }

        if (legBPriceMissing) {
          this.logger.error(`EXIT price missing LEG B ${legB.tradingSymbol}`);
        }

        this.logger.error(
          `Both exit prices required. Skipping batch for ${config._id}`,
        );

        break; // DO NOT PLACE PARTIAL EXIT
      }

      // ==============================
      // PLACE LIMIT EXIT ORDERS
      // ==============================

      await Promise.all([
        qtyA > 0
          ? this.ordersService.placeOrder({
              buy_or_sell: netA > 0 ? 'S' : 'B',
              product_type: config.productType === 'INTRADAY' ? 'I' : 'M',
              exchange: legA.exch,
              tradingsymbol: legA.tradingSymbol,
              quantity: qtyA,
              price_type: 'LMT',
              price: priceA,
              trigger_price: 0,
              discloseqty: 0,
              // retention: 'DAY',
              retention: 'IOC',
              amo: 'NO',
              remarks: `AUTO STRADLE EXIT A (${reason})`,
            })
          : Promise.resolve(),

        qtyB > 0
          ? this.ordersService.placeOrder({
              buy_or_sell: netB > 0 ? 'S' : 'B',
              product_type: config.productType === 'INTRADAY' ? 'I' : 'M',
              exchange: legB.exch,
              tradingsymbol: legB.tradingSymbol,
              quantity: qtyB,
              price_type: 'LMT',
              price: priceB,
              trigger_price: 0,
              discloseqty: 0,
              // retention: 'DAY',
              retention: 'IOC',
              amo: 'NO',
              remarks: `AUTO STRADLE EXIT B (${reason})`,
            })
          : Promise.resolve(),
      ]);

      const updated = await this.waitForPositionUpdate(
        config,
        legA,
        legB,
        netA,
        netB,
      );

      if (!updated) {
        this.logger.error(`Position not updated — stopping`);
        break;
      }
    }
  }

  // private async executeRatioClose(config: any, reason: string) {
  //   if (config.exitStatus !== 'EXITING') return;

  //   const [legA, legB] = config.legsData;
  //   if (!legA || !legB) return;

  //   const MAX_ORDER_LOTS = 25;
  //   const MAX_LOOP = 50;

  //   let loopCount = 0;

  //   while (true) {
  //     loopCount++;

  //     if (loopCount > MAX_LOOP) {
  //       this.logger.error(`Exit max loop reached ${config._id}`);
  //       break;
  //     }

  //     const netPositions = await this.exchangeDataService.getNetPositions();

  //     const netA = this.getNetPositionQty(
  //       netPositions,
  //       legA.tokenNumber,
  //       legA.exch,
  //     );

  //     const netB = this.getNetPositionQty(
  //       netPositions,
  //       legB.tokenNumber,
  //       legB.exch,
  //     );

  //     // ======================
  //     // EXIT COMPLETE
  //     // ======================

  //     if (netA === 0 && netB === 0) {
  //       this.logger.warn(`Exit fully completed ${config._id}`);
  //       break;
  //     }

  //     const lotSizeA = this.getLotSizeFromPosition(
  //       netPositions,
  //       legA.tokenNumber,
  //       legA.exch,
  //     );

  //     const lotSizeB = this.getLotSizeFromPosition(
  //       netPositions,
  //       legB.tokenNumber,
  //       legB.exch,
  //     );

  //     if (!lotSizeA || !lotSizeB) {
  //       this.logger.error(`Lot size missing`);
  //       break;
  //     }

  //     const remainingALots = Math.floor(Math.abs(netA) / lotSizeA);
  //     const remainingBLots = Math.floor(Math.abs(netB) / lotSizeB);

  //     let exitLotsA = 0;
  //     let exitLotsB = 0;

  //     // ======================
  //     // FINAL CLEANUP MODE
  //     // ======================

  //     if (netA === 0 || netB === 0) {
  //       this.logger.warn(`Final cleanup mode`);

  //       exitLotsA = remainingALots;
  //       exitLotsB = remainingBLots;
  //     } else {
  //       const ratioA = Number(legA.quantityLots || 1);
  //       const ratioB = Number(legB.quantityLots || 1);

  //       const maxRatioBatch = Math.min(
  //         Math.floor(remainingALots / ratioA),
  //         Math.floor(remainingBLots / ratioB),
  //       );

  //       if (maxRatioBatch > 0) {
  //         const allowedBatch = Math.min(
  //           maxRatioBatch,
  //           Math.floor(MAX_ORDER_LOTS / Math.max(ratioA, ratioB)),
  //         );

  //         exitLotsA = allowedBatch * ratioA;
  //         exitLotsB = allowedBatch * ratioB;

  //         this.logger.warn(`Ratio batch exit mode`);
  //       } else {
  //         this.logger.warn(`Fallback exit mode`);

  //         exitLotsA = Math.min(remainingALots, MAX_ORDER_LOTS);
  //         exitLotsB = Math.min(remainingBLots, MAX_ORDER_LOTS);
  //       }
  //     }

  //     let qtyA = exitLotsA * lotSizeA;
  //     let qtyB = exitLotsB * lotSizeB;

  //     qtyA = Math.min(qtyA, Math.abs(netA));
  //     qtyB = Math.min(qtyB, Math.abs(netB));

  //     if (qtyA <= 0 && qtyB <= 0) {
  //       this.logger.warn(`Nothing to exit — stopping`);
  //       break;
  //     }

  //     this.logger.warn(
  //       `Exit batch | netA=${netA} qtyA=${qtyA} | netB=${netB} qtyB=${qtyB}`,
  //     );

  //     // ==============================
  //     // GET LIMIT PRICES FOR BOTH LEGS
  //     // ==============================

  //     const priceA =
  //       qtyA > 0 ? this.getRmsLimitPrice(legA, netA, netPositions) : undefined;

  //     const priceB =
  //       qtyB > 0 ? this.getRmsLimitPrice(legB, netB, netPositions) : undefined;

  //     // ==============================
  //     // VALIDATE BOTH PRICES
  //     // ==============================

  //     const legAPriceMissing = qtyA > 0 && priceA === undefined;
  //     const legBPriceMissing = qtyB > 0 && priceB === undefined;

  //     if (legAPriceMissing || legBPriceMissing) {
  //       if (legAPriceMissing) {
  //         this.logger.error(`EXIT price missing LEG A ${legA.tradingSymbol}`);
  //       }

  //       if (legBPriceMissing) {
  //         this.logger.error(`EXIT price missing LEG B ${legB.tradingSymbol}`);
  //       }

  //       this.logger.error(
  //         `Both exit prices required. Skipping batch for ${config._id}`,
  //       );

  //       break; // DO NOT PLACE PARTIAL EXIT
  //     }

  //     // ==============================
  //     // PLACE LIMIT EXIT ORDERS
  //     // ==============================

  //     await Promise.all([
  //       qtyA > 0
  //         ? this.ordersService.placeOrder({
  //             buy_or_sell: netA > 0 ? 'S' : 'B',
  //             product_type: config.productType === 'INTRADAY' ? 'I' : 'M',
  //             exchange: legA.exch,
  //             tradingsymbol: legA.tradingSymbol,
  //             quantity: qtyA,
  //             price_type: 'LMT',
  //             price: priceA,
  //             trigger_price: 0,
  //             discloseqty: 0,
  //             retention: 'DAY',
  //             // retention: 'IOC',
  //             amo: 'NO',
  //             remarks: `AUTO STRADLE EXIT A (${reason})`,
  //           })
  //         : Promise.resolve(),

  //       qtyB > 0
  //         ? this.ordersService.placeOrder({
  //             buy_or_sell: netB > 0 ? 'S' : 'B',
  //             product_type: config.productType === 'INTRADAY' ? 'I' : 'M',
  //             exchange: legB.exch,
  //             tradingsymbol: legB.tradingSymbol,
  //             quantity: qtyB,
  //             price_type: 'LMT',
  //             price: priceB,
  //             trigger_price: 0,
  //             discloseqty: 0,
  //             retention: 'DAY',
  //             // retention: 'IOC',
  //             amo: 'NO',
  //             remarks: `AUTO STRADLE EXIT B (${reason})`,
  //           })
  //         : Promise.resolve(),
  //     ]);

  //     // await Promise.all([
  //     //   qtyA > 0
  //     //     ? this.ordersService.placeOrder({
  //     //         buy_or_sell: netA > 0 ? 'S' : 'B',
  //     //         product_type: config.productType === 'INTRADAY' ? 'I' : 'M',
  //     //         exchange: legA.exch,
  //     //         tradingsymbol: legA.tradingSymbol,
  //     //         quantity: qtyA,
  //     //         price_type: 'MKT',
  //     //         price: 0,
  //     //         trigger_price: 0,
  //     //         discloseqty: 0,
  //     //         retention: 'DAY',
  //     //         amo: 'NO',
  //     //         remarks: `AUTO STRADLE EXIT A (${reason})`,
  //     //       })
  //     //     : Promise.resolve(),

  //     //   qtyB > 0
  //     //     ? this.ordersService.placeOrder({
  //     //         buy_or_sell: netB > 0 ? 'S' : 'B',
  //     //         product_type: config.productType === 'INTRADAY' ? 'I' : 'M',
  //     //         exchange: legB.exch,
  //     //         tradingsymbol: legB.tradingSymbol,
  //     //         quantity: qtyB,
  //     //         price_type: 'MKT',
  //     //         price: 0,
  //     //         trigger_price: 0,
  //     //         discloseqty: 0,
  //     //         retention: 'DAY',
  //     //         amo: 'NO',
  //     //         remarks: `AUTO STRADLE EXIT B (${reason})`,
  //     //       })
  //     //     : Promise.resolve(),
  //     // ]);

  //     const updated = await this.waitForPositionUpdate(
  //       config,
  //       legA,
  //       legB,
  //       netA,
  //       netB,
  //     );

  //     if (!updated) {
  //       this.logger.error(`Position not updated — stopping`);
  //       break;
  //     }
  //   }
  // }

  // batch calculator

  // =====================================================
  // CALCULATE EXIT BATCH (single source of truth for exit sizing)
  // =====================================================
  private calculateExitBatch(
    legA: any,
    legB: any,
    remainingALots: number,
    remainingBLots: number,
    netA: number,
    netB: number,
    maxOrderLots: number,
    stepLots: number,
  ): { exitLotsA: number; exitLotsB: number; mode: string } {
    let exitLotsA = 0;
    let exitLotsB = 0;
    let mode: string;

    if (netA === 0 || netB === 0) {
      // Only one leg has qty left → cleanup, but still capped
      mode = 'CLEANUP';
      exitLotsA = Math.min(remainingALots, maxOrderLots);
      exitLotsB = Math.min(remainingBLots, maxOrderLots);
    } else {
      // Both legs still open → step together
      mode = 'STEPPED';
      exitLotsA = Math.min(stepLots, remainingALots);
      exitLotsB = Math.min(stepLots, remainingBLots);
    }

    this.logger.warn(
      `[calculateExitBatch] mode=${mode} | remainingALots=${remainingALots} remainingBLots=${remainingBLots} ` +
        `| netA=${netA} netB=${netB} | → exitLotsA=${exitLotsA} exitLotsB=${exitLotsB}`,
    );

    return { exitLotsA, exitLotsB, mode };
  }
  // private calculateExitBatch(legA, legB, remainingA, remainingB) {
  //   return {
  //     [legA.tokenNumber]: remainingA > 0 ? 1 : 0,
  //     [legB.tokenNumber]: remainingB > 0 ? 1 : 0,
  //   };
  // }
  // old working
  // private calculateExitBatch(legA, legB, remainingA, remainingB) {
  //   const ratioA = legA.quantityLots || 1;
  //   const ratioB = legB.quantityLots || 1;

  //   // calculate max batch possible while preserving ratio
  //   const maxBatch = Math.min(
  //     Math.floor(remainingA / ratioA),
  //     Math.floor(remainingB / ratioB),
  //   );

  //   if (maxBatch <= 0) {
  //     return {
  //       [legA.tokenNumber]: remainingA > 0 ? 1 : 0,
  //       [legB.tokenNumber]: remainingB > 0 ? 1 : 0,
  //     };
  //   }

  //   return {
  //     [legA.tokenNumber]: maxBatch * ratioA,
  //     [legB.tokenNumber]: maxBatch * ratioB,
  //   };
  // }

  /*
Controller API
      ↓
RMS.manualSquareOffByUnderlying()
      ↓
Find matching configs
      ↓
Verify open position
      ↓
squareOffConfig()
      ↓
executeRatioClose()
*/

  // new manual square off with 3 attemps
  public async manualSquareOff(params: {
    tokenNumber: string;
    exchange: string;
  }) {
    try {
      const exchange = String(params.exchange).trim().toUpperCase();
      const tokenNumber = String(params.tokenNumber).trim();

      const key = `${exchange}|${tokenNumber}`;

      this.logger.warn(`🚨 Manual squareoff request received for ${key}`);

      // ⭐ FAST lookup via underlyingIndex
      const matchedConfigs = this.underlyingIndex.get(key);

      if (!matchedConfigs?.length) {
        this.logger.warn(`No configs mapped for ${key}`);
        return {
          success: false,
          message: 'No matching stradle configs found',
        };
      }

      // Get latest real positions
      let netPositions = await this.exchangeDataService.getNetPositions();

      let triggeredCount = 0;
      let failedCount = 0;

      const MAX_ATTEMPTS = 3;
      const RETRY_DELAY_MS = 1500;

      for (const config of matchedConfigs) {
        // 🚫 Skip if already exiting (don't skip EXITED here — a stale
        // EXITED flag from a previous failed manual attempt must not block retry)
        if (config.exitStatus === 'EXITING') {
          this.logger.warn(`Skipping ${config._id} — exit already in progress`);
          continue;
        }

        // ⭐ Check actual open positions
        const hasOpenPosition = config.legsData.some((leg) => {
          const qty = this.getNetPositionQty(
            netPositions,
            leg.tokenNumber,
            leg.exch,
          );

          return qty !== 0;
        });

        if (!hasOpenPosition) {
          this.logger.warn(`Skipping ${config._id} — no open positions`);
          continue;
        }

        // =====================================================
        // ⭐ RETRY LOOP — attempt exit up to MAX_ATTEMPTS times,
        // re-verifying actual net position after each attempt
        // =====================================================
        let closed = false;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          this.logger.warn(
            `🚨 Manual squareoff attempt ${attempt}/${MAX_ATTEMPTS} for ${config._id}`,
          );

          // ⭐ Reset a stale EXITED flag from a prior failed attempt so
          // squareOffConfig() doesn't early-return on this retry
          if (config.exitStatus === 'EXITED') {
            config.exitStatus = undefined;
          }

          await this.squareOffConfig(config, `MANUAL_EXIT_ATTEMPT_${attempt}`);

          // ⭐ Re-fetch fresh positions and verify actual closure —
          // don't trust exitStatus alone, it can be 'EXITED' even on
          // a partial/failed close (see executeRatioClose early-breaks)
          netPositions = await this.exchangeDataService.getNetPositions();

          const stillOpen = config.legsData.some((leg) => {
            const qty = this.getNetPositionQty(
              netPositions,
              leg.tokenNumber,
              leg.exch,
            );
            return qty !== 0;
          });

          if (!stillOpen) {
            closed = true;
            this.logger.warn(
              `✅ Manual squareoff confirmed closed for ${config._id} on attempt ${attempt}`,
            );
            break;
          }

          this.logger.warn(
            `⚠ Position still open after attempt ${attempt} for ${config._id}`,
          );

          if (attempt < MAX_ATTEMPTS) {
            await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
          }
        }

        if (closed) {
          triggeredCount++;
        } else {
          failedCount++;
          this.logger.error(
            `❌ Manual squareoff FAILED to fully close ${config._id} after ${MAX_ATTEMPTS} attempts — manual check required`,
          );
        }
      }

      return {
        success: failedCount === 0,
        message: `Manual squareoff: ${triggeredCount} closed, ${failedCount} failed after retries (of ${matchedConfigs.length} matched)`,
      };
    } catch (error) {
      this.logger.error('manualSquareOff error', error?.stack || error);
      throw error;
    }
  }

  // old working
  // public async manualSquareOff(params: {
  //   tokenNumber: string;
  //   exchange: string;
  // }) {
  //   try {
  //     const exchange = String(params.exchange).trim().toUpperCase();
  //     const tokenNumber = String(params.tokenNumber).trim();

  //     const key = `${exchange}|${tokenNumber}`;

  //     this.logger.warn(`🚨 Manual squareoff request received for ${key}`);

  //     // ⭐ FAST lookup via underlyingIndex
  //     const matchedConfigs = this.underlyingIndex.get(key);

  //     if (!matchedConfigs?.length) {
  //       this.logger.warn(`No configs mapped for ${key}`);
  //       return {
  //         success: false,
  //         message: 'No matching stradle configs found',
  //       };
  //     }

  //     // Get latest real positions
  //     const netPositions = await this.exchangeDataService.getNetPositions();

  //     let triggeredCount = 0;

  //     for (const config of matchedConfigs) {
  //       // 🚫 Skip if already exiting/exited
  //       if (config.exitStatus === 'EXITING' || config.exitStatus === 'EXITED') {
  //         this.logger.warn(
  //           `Skipping ${config._id} — exit already in progress or completed`,
  //         );
  //         continue;
  //       }

  //       // ⭐ Check actual open positions
  //       const hasOpenPosition = config.legsData.some((leg) => {
  //         const qty = this.getNetPositionQty(
  //           netPositions,
  //           leg.tokenNumber,
  //           leg.exch,
  //         );

  //         return qty !== 0;
  //       });

  //       if (!hasOpenPosition) {
  //         this.logger.warn(`Skipping ${config._id} — no open positions`);
  //         continue;
  //       }

  //       // ⭐ Trigger existing RMS exit logic
  //       await this.squareOffConfig(config, 'MANUAL_EXIT');

  //       triggeredCount++;
  //     }

  //     return {
  //       success: true,
  //       message: `Manual squareoff triggered for ${triggeredCount} config(s)`,
  //     };
  //   } catch (error) {
  //     this.logger.error('manualSquareOff error', error?.stack || error);
  //     throw error;
  //   }
  // }

  // helper fuction to wait for position update after exit order

  /*
Place exit
Wait 800ms
Check position
Still same qty (because exchange delay)
Place exit again
*/

  private async waitForPositionUpdate(
    config: any,
    legA: any,
    legB: any,
    prevNetA: number,
    prevNetB: number,
  ): Promise<boolean> {
    const maxWaitMs = 4000;
    const interval = 500;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      await new Promise((res) => setTimeout(res, interval));

      const netPositions = await this.exchangeDataService.getNetPositions();

      const newNetA = this.getNetPositionQty(
        netPositions,
        legA.tokenNumber,
        legA.exch,
      );

      const newNetB = this.getNetPositionQty(
        netPositions,
        legB.tokenNumber,
        legB.exch,
      );

      // ✅ position reduced = success
      if (
        Math.abs(newNetA) < Math.abs(prevNetA) ||
        Math.abs(newNetB) < Math.abs(prevNetB)
      ) {
        this.logger.debug(`Position update detected for ${config._id}`);
        return true;
      }
    }

    this.logger.warn(`Position update timeout for ${config._id}`);
    return false;
  }

  // logic for pnl exit
  private async checkPnLExit(config: any) {
    try {
      if (config.exitStatus === 'EXITING' || config.exitStatus === 'EXITED') {
        return;
      }

      const profitPct = Number(config.profitBookingPercentage || 0);
      const stoplossPct = Number(config.stoplossBookingPercentage || 0);

      if (!profitPct && !stoplossPct) return;

      const pnlPct = Number(config.totalPnLPercentage || 0);

      // ✅ PROFIT BOOKING
      if (profitPct > 0 && pnlPct >= profitPct) {
        this.logger.warn(`💰 PROFIT TARGET HIT ${config._id} | PnL%=${pnlPct}`);

        await this.squareOffConfig(config, 'PROFIT_BOOKING');
        return;
      }

      // ❌ STOP LOSS
      if (stoplossPct > 0 && pnlPct <= -stoplossPct) {
        this.logger.warn(`🛑 STOPLOSS HIT ${config._id} | PnL%=${pnlPct}`);

        await this.squareOffConfig(config, 'STOPLOSS_BOOKING');
        return;
      }
    } catch (error) {
      this.logger.error('checkPnLExit error', error?.stack || error);
    }
  }

  // helper fucntion to get lots size from net positions
  private getLotSizeFromPosition(
    netPositions: any[],
    token: string,
    exchange: string,
  ): number {
    const pos = netPositions.find(
      (p) => p.token === token && p.raw?.exch === exchange,
    );

    return Number(pos?.raw?.ls || 0);
  }

  // =====================================================
  // RMS LIMIT PRICE RESOLVER (DEPTH BASED)
  // =====================================================
  // new with max 10% far price
  // =====================================================
  // RMS LIMIT PRICE RESOLVER (DEPTH BASED)
  // =====================================================
  private getRmsLimitPrice(
    leg: any,
    netQty: number,
    netPositions: any[],
  ): number | undefined {
    const key = `${leg.exch}|${leg.tokenNumber}`;
    const tick = this.priceMap.get(key);

    if (!tick) {
      this.logger.error(`No tick data for ${key}`);
      return undefined;
    }

    const tickSize = this.getTickSizeFromPosition(
      netPositions,
      leg.tokenNumber,
      leg.exch,
    );

    // ⭐ Max 10% aggressive buffer from best bid/ask — was 25%/33% before,
    // which could push the limit price past the circuit limit and get
    // the exit order rejected entirely.
    const MAX_PRICE_BUFFER = 0.1; // means 10% below best bid for exit sell, 10% above best ask for exit buy

    let rawPrice: number | undefined;

    // ===============================
    // LONG → exit SELL → aggressive bid, capped at 10% below
    // ===============================
    if (netQty > 0) {
      if (!tick.bp1) return undefined;

      rawPrice = Number(tick.bp1) * (1 - MAX_PRICE_BUFFER);

      this.logger.debug(
        `EXIT SELL rawPrice=${rawPrice} (bp1 * ${1 - MAX_PRICE_BUFFER})`,
      );

      rawPrice = this.roundToTick(rawPrice, tickSize, 'DOWN');
    }

    // ===============================
    // SHORT → exit BUY → aggressive ask, capped at 10% above
    // ===============================
    else if (netQty < 0) {
      if (!tick.sp1) return undefined;

      rawPrice = Number(tick.sp1) * (1 + MAX_PRICE_BUFFER);

      this.logger.debug(
        `EXIT BUY rawPrice=${rawPrice} (sp1 * ${1 + MAX_PRICE_BUFFER})`,
      );

      rawPrice = this.roundToTick(rawPrice, tickSize, 'UP');
    }

    if (!rawPrice || rawPrice <= 0 || isNaN(rawPrice)) {
      return undefined;
    }

    return Number(rawPrice.toFixed(8));
  }

  // old working with too far price entry
  // private getRmsLimitPrice(
  //   leg: any,
  //   netQty: number,
  //   netPositions: any[],
  // ): number | undefined {
  //   const key = `${leg.exch}|${leg.tokenNumber}`;
  //   const tick = this.priceMap.get(key);

  //   if (!tick) {
  //     this.logger.error(`No tick data for ${key}`);
  //     return undefined;
  //   }

  //   const tickSize = this.getTickSizeFromPosition(
  //     netPositions,
  //     leg.tokenNumber,
  //     leg.exch,
  //   );

  //   let rawPrice: number | undefined;

  //   // ===============================
  //   // LONG → exit SELL → aggressive bid
  //   // ===============================
  //   if (netQty > 0) {
  //     if (!tick.bp1) return undefined;

  //     rawPrice = Number(tick.bp1) * 0.75;

  //     this.logger.debug(`EXIT SELL rawPrice=${rawPrice} (bp1*0.75)`);

  //     rawPrice = this.roundToTick(rawPrice, tickSize, 'DOWN');
  //   }

  //   // ===============================
  //   // SHORT → exit BUY → aggressive ask
  //   // ===============================
  //   else if (netQty < 0) {
  //     if (!tick.sp1) return undefined;

  //     rawPrice = Number(tick.sp1) / 0.75;

  //     this.logger.debug(`EXIT BUY rawPrice=${rawPrice} (sp1/0.75)`);

  //     rawPrice = this.roundToTick(rawPrice, tickSize, 'UP');
  //   }

  //   if (!rawPrice || rawPrice <= 0 || isNaN(rawPrice)) {
  //     return undefined;
  //   }

  //   return Number(rawPrice.toFixed(8));
  // }

  // ============================================
  // GET TICK SIZE FROM NET POSITION
  // ============================================
  private getTickSizeFromPosition(
    netPositions: any[],
    token: string,
    exchange: string,
  ): number {
    const pos = netPositions.find(
      (p) => p.token === token && p.raw?.exch === exchange,
    );

    const ti = Number(pos?.raw?.ti || 0);

    return ti > 0 ? ti : 0.05; // fallback safe tick
  }
  // ============================================
  // ROUND PRICE TO VALID TICK
  // ============================================
  private roundToTick(
    price: number,
    tickSize: number,
    direction: 'UP' | 'DOWN',
  ): number {
    if (!tickSize || tickSize <= 0) return price;

    const factor = price / tickSize;

    if (direction === 'UP') {
      return Math.ceil(factor) * tickSize;
    }

    return Math.floor(factor) * tickSize;
  }
  // =====================================================
  // PUBLIC: TIME-BASED AUTO SQUARE OFF (called by AutoSquareOffService)
  // =====================================================
  public async triggerTimeBasedSquareOff(
    reason: string = 'TIME_BASED_SQUAREOFF',
  ): Promise<{ triggered: number }> {
    try {
      if (!this.activeConfigs?.length) {
        return { triggered: 0 };
      }

      const netPositions = await this.exchangeDataService.getNetPositions();
      let triggeredCount = 0;

      for (const config of this.activeConfigs) {
        // 🚫 Skip if already exiting/exited
        if (config.exitStatus === 'EXITING' || config.exitStatus === 'EXITED') {
          continue;
        }

        const hasOpenPosition = config.legsData?.some((leg) => {
          const qty = this.getNetPositionQty(
            netPositions,
            leg.tokenNumber,
            leg.exch,
          );
          return qty !== 0;
        });

        if (!hasOpenPosition) continue;

        this.logger.warn(
          `⏰ Auto square-off (${reason}) triggered for ${config._id}`,
        );

        await this.squareOffConfig(config, reason);
        triggeredCount++;
      }

      return { triggered: triggeredCount };
    } catch (error) {
      this.logger.error(
        'triggerTimeBasedSquareOff error',
        error?.stack || error,
      );
      return { triggered: 0 };
    }
  }

  // =====================================================
  // CHECK IF MINIMUM REQUIRED QTY (PER CONFIG) IS BUILT
  // =====================================================
  // private isMinimumQuantityBuilt(config: any, netPositions: any[]): boolean {
  //   try {
  //     const legs = config.legsData || [];
  //     if (!legs.length) return false;

  //     for (const leg of legs) {
  //       const requiredLots = Number(leg.quantityLots || 0);

  //       // no requirement configured for this leg -> skip check for it
  //       if (requiredLots <= 0) continue;

  //       const lotSize = this.getLotSizeFromPosition(
  //         netPositions,
  //         leg.tokenNumber,
  //         leg.exch,
  //       );

  //       if (!lotSize) {
  //         // can't verify yet (no position/lot info) -> treat as not ready
  //         return false;
  //       }

  //       const requiredQty = requiredLots * lotSize;
  //       const netQty = this.getNetQty(netPositions, leg);

  //       if (Math.abs(netQty) < requiredQty) {
  //         return false;
  //       }
  //     }

  //     return true;
  //   } catch (error) {
  //     this.logger.error('isMinimumQuantityBuilt error', error?.stack || error);
  //     return false;
  //   }
  // }

  // =====================================================
  // CHECK IF POSITION HAS STOPPED CHANGING (STABLE) FOR ALL LEGS
  // =====================================================
  // =====================================================
  // CHECK IF POSITION HAS STOPPED CHANGING (STABLE) FOR ALL LEGS
  // =====================================================
  private isPositionStable(config: any, netPositions: any[]): boolean {
    try {
      const legs = config.legsData || [];
      if (!legs.length) return false;

      const configId = String(config._id);
      if (!this.positionStability.has(configId)) {
        this.positionStability.set(configId, { legs: new Map() });
      }
      const tracker = this.positionStability.get(configId)!;

      const now = Date.now();
      let allStable = true;
      let anyOpen = false;

      for (const leg of legs) {
        const legKey = `${leg.exch}|${leg.tokenNumber}`;
        const netQty = this.getNetQty(netPositions, leg);

        if (netQty !== 0) anyOpen = true;

        const prev = tracker.legs.get(legKey);

        if (!prev || prev.netQty !== netQty) {
          // qty changed (or first time seeing it) → reset the stability timer
          tracker.legs.set(legKey, { netQty, stableSince: now });
          allStable = false;
          continue;
        }

        // qty unchanged since last check — check how long it's been stable
        if (now - prev.stableSince < this.stabilityWindowMs) {
          allStable = false;
        }
      }

      // Require at least one leg open AND all legs unchanged for the full window
      return anyOpen && allStable;
    } catch (error) {
      this.logger.error('isPositionStable error', error?.stack || error);
      return false;
    }
  }

  // =====================================================
  // CLEANUP STABILITY TRACKER (call on exit / config removal)
  // =====================================================
  private clearPositionStability(configId: string) {
    this.positionStability.delete(String(configId));
  }
}
