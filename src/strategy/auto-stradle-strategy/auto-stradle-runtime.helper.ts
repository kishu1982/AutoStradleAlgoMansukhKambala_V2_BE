import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AutoStradleStrategyService } from './auto-stradle-strategy.service';
import { AutoStradleDataEntity } from 'src/database/entities/auto-stradle-data.entity';
import { MarketTick } from './interfaces/market-tick-interface';
import { InstrumentInfo } from './interfaces/local-instrumentInfo-interface';
import * as fs from 'fs';
import * as path from 'path';
import { AutoStradleRMSService } from './auto-stradle-rms.service';
import { ExchangeDataService } from '../exchange-data/exchange-data.service';

@Injectable()
export class AutoStradleRuntimeHelper implements OnModuleInit {
  private readonly logger = new Logger(AutoStradleRuntimeHelper.name);

  private activeConfigs: AutoStradleDataEntity[] = [];
  private marketDataMap: Map<string, MarketTick> = new Map();
  private instrumentData: InstrumentInfo[] = [];

  private isCronRunning = false; // prevent overlap

  private readonly indexMaster = [
    { exchange: 'NSE', symbol: 'NIFTY', token: 26000 },
    // { exchange: 'NSE', symbol: 'NIFTY 50', token: 26000 },
    { exchange: 'BSE', symbol: 'SENSEX', token: 1 },
    { exchange: 'NSE', symbol: 'BANKNIFTY', token: 26009 },
  ];

  constructor(
    private readonly autoStradleService: AutoStradleStrategyService,
    private readonly rmsService: AutoStradleRMSService,
    private readonly exchangeDataService: ExchangeDataService, // ⭐ ADD
  ) {}

  // =====================================================
  // INIT
  // =====================================================
  async onModuleInit() {
    try {
      this.loadInstrumentData();
      await this.refreshActiveConfigs();
    } catch (error) {
      this.logger.error(`onModuleInit error`, error?.stack || error);
    }
  }

  // =====================================================
  // REFRESH ACTIVE CONFIGS
  // =====================================================
  async refreshActiveConfigs(): Promise<void> {
    try {
      const active = await this.autoStradleService.findActive();
      this.activeConfigs = active;
      this.logger.log(`Loaded ${this.activeConfigs.length} active configs`);
    } catch (error) {
      this.logger.error(`refreshActiveConfigs error`, error?.stack || error);
    }
  }

  // =====================================================
  // WEBSOCKET TICK HANDLER (ONLY CACHE UPDATE)
  // =====================================================
  async handleWebsocketTick(feed: any): Promise<void> {
    try {
      this.updateMarketData(feed);
      // sending data to rms file for live pnl update and Riskmanagement
      this.rmsService.handleTick(feed);
    } catch (error) {
      this.logger.error(`handleWebsocketTick error`, error?.stack || error);
    }
  }

  // =====================================================
  // UPDATE MARKET CACHE
  // =====================================================
  private updateMarketData(feed: any): void {
    try {
      const exchange = feed?.e;
      const token = feed?.tk;
      if (!exchange || !token) return;

      const key = `${exchange}|${token}`;
      let existing = this.marketDataMap.get(key);

      if (!existing) {
        existing = { e: exchange, tk: token } as MarketTick;
      }

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

      this.marketDataMap.set(key, updated);
    } catch (error) {
      this.logger.error(`updateMarketData error`, error?.stack || error);
    }
  }

  // =====================================================
  // CRON RUNNER (EVERY 2 SECONDS)
  // =====================================================
  @Cron('*/2 * * * * *')
  async runtimeProcessor() {
    if (this.isCronRunning) return;

    this.isCronRunning = true;

    try {
      await this.refreshActiveConfigs();

      for (const config of this.activeConfigs) {
        await this.updateSingleStrategy(config);
      }
    } catch (error) {
      this.logger.error(`runtimeProcessor error`, error?.stack || error);
    } finally {
      this.isCronRunning = false;
    }
  }

  // =====================================================
  // SINGLE STRATEGY UPDATE
  // =====================================================
  private async updateSingleStrategy(config: AutoStradleDataEntity) {
    try {
      const mainKey = `${config.exchange}|${config.tokenNumber}`;
      const mainTick = this.marketDataMap.get(mainKey);
      if (!mainTick?.lp) return;

      const mainLtp = mainTick.lp;
      config.ltp = mainLtp;

      // this.logger.debug(
      //   `Main LTP for ${config.strategyName}: ${mainTick?.lp} and updated Main LTP in config: ${config.ltp}`,
      // );

      let isUpdated = false;

      for (const leg of config.legsData || []) {
        if (!['NFO', 'BFO', 'MCX'].includes(leg.exch)) continue;

        const diff = mainLtp * (config.otmDifference / 100);
        let strike = leg.optionType === 'PE' ? mainLtp - diff : mainLtp + diff;

        const isIndexToken = this.indexMaster.some(
          (i) => i.token.toString() === config.tokenNumber,
        );

        // const roundStep = isIndexToken ? 50 : 100;
        const roundStep = isIndexToken ? 100 : 100;
        strike = this.roundStrike(strike, roundStep);

        const instrument = this.instrumentData.find(
          (inst) =>
            inst.exchange === leg.exch &&
            inst.instrument === leg.instrument &&
            inst.optionType === leg.optionType &&
            inst.expiry === leg.expiry &&
            inst.strikePrice === strike &&
            inst.symbol ===
              this.indexMaster.find(
                (i) => i.token.toString() === config.tokenNumber,
              )?.symbol, // Match symbol from index master
          // inst.symbol === config.symbolName,
        );

        if (!instrument) continue;

        // leg.tokenNumber = String(instrument.token);
        // leg.tradingSymbol = instrument.tradingSymbol;
        // =====================================================
        // LOCK STRIKE IF POSITION ALREADY OPEN
        // =====================================================

        const isPositionOpen = await this.hasOpenPosition(
          leg.exch,
          leg.tokenNumber,
        );

        if (!isPositionOpen) {
          leg.tokenNumber = String(instrument.token);
          leg.tradingSymbol = instrument.tradingSymbol;
        } else {
          this.logger.debug(
            `Strike locked for ${leg.tradingSymbol} — position already open.`,
          );
        }

        // ⭐ CALCULATE QUANTITY
        const calculatedQty = this.calculateLegQuantity(
          config.amountForLotCalEachLeg,
          leg.legLtp,
          instrument.lotSize,
        );

        if (calculatedQty !== undefined) {
          leg.quantityLots = calculatedQty;
        }

        // ⭐ AFTER updating quantities for all legs adding ratio calculation based on quantity
        this.calculateLegRatios(config.legsData);

        const legKey = `${leg.exch}|${instrument.token}`;
        const legTick = this.marketDataMap.get(legKey);

        // this.logger.debug(`Leg ${leg.tradingSymbol} LTP: ${legTick?.lp}`);

        if (legTick) {
          leg.legLtp =
            leg.side === 'BUY'
              ? (legTick.sp1 ?? legTick.lp ?? undefined)
              : (legTick.bp1 ?? legTick.lp ?? undefined);
        }

        isUpdated = true;
      }

      if (isUpdated) {
        // this.logger.debug(
        //   `config data sending for update is : ${JSON.stringify(config)}`,
        // );
        await this.autoStradleService.update(
          config._id.toString(),
          config as any,
        );
      }
    } catch (error) {
      this.logger.error(`updateSingleStrategy error`, error?.stack || error);
    }
  }

  // =====================================================
  // ROUND STRIKE
  // =====================================================
  private roundStrike(value: number, step: number): number {
    try {
      return Math.round(value / step) * step;
    } catch {
      return value;
    }
  }

  // =====================================================
  // LOAD INSTRUMENT MASTER
  // =====================================================
  private loadInstrumentData(): void {
    try {
      const filePath = path.join(
        process.cwd(),
        'data',
        'instrumentinfo',
        'instruments.json',
      );

      const fileContent = fs.readFileSync(filePath, 'utf-8');
      this.instrumentData = JSON.parse(fileContent);

      this.logger.log(`Loaded ${this.instrumentData.length} instruments`);
    } catch (error) {
      this.logger.error(`loadInstrumentData error`, error?.stack || error);
    }
  }

  // =====================================================
  // calculate leg quantity based on amount, legLtp and lot size
  // =====================================================
  private calculateLegQuantity(
    amount: number,
    legLtp?: number,
    lotSize?: number,
  ): number | undefined {
    try {
      if (!amount || !legLtp || !lotSize) {
        return undefined;
      }

      const rawQty = amount / (lotSize * legLtp);

      const integerPart = Math.floor(rawQty);
      const decimalPart = rawQty - integerPart;

      if (decimalPart > 0.5) {
        return integerPart + 1;
      }

      return integerPart;
    } catch (error) {
      this.logger.error(`calculateLegQuantity error`, error?.stack || error);

      return undefined;
    }
  }

  // =====================================================
  // CALCULATE LEG RATIOS BASED ON QUANTITIES
  // =====================================================
  private calculateLegRatios(legs: any[]): void {
    try {
      if (!legs || legs.length < 2) return;

      const quantities = legs.map((l) => l.quantityLots);

      if (quantities.some((q) => typeof q !== 'number')) return;

      // ===============================
      // STEP 1: GCD reduce
      // ===============================

      let currentGcd = quantities[0];

      for (let i = 1; i < quantities.length; i++) {
        currentGcd = this.gcd(currentGcd, quantities[i]);
      }

      let ratios = quantities.map((q) => q / currentGcd);

      // ===============================
      // STEP 2: normalize to single digit
      // ===============================

      const maxRatio = Math.max(...ratios);

      if (maxRatio > 9) {
        const scaleFactor = Math.ceil(maxRatio / 9);

        ratios = ratios.map((r) => Math.floor(r / scaleFactor));
      }

      // ===============================
      // STEP 3: ensure minimum = 1
      // ===============================

      ratios = ratios.map((r) => (r < 1 ? 1 : r));

      // ===============================
      // assign back
      // ===============================

      legs.forEach((leg, index) => {
        leg.ratio = ratios[index];
      });
    } catch (error) {
      this.logger.error(`calculateLegRatios error`, error?.stack || error);
    }
  }

  // =====================================================
  // CALCULATE GCD (for ratio reduction)
  // =====================================================
  private gcd(a: number, b: number): number {
    while (b !== 0) {
      const temp = b;
      b = a % b;
      a = temp;
    }
    return a;
  }

  // =====================================================
  // CHECK IF POSITION IS OPEN FOR TOKEN
  // =====================================================
  private async hasOpenPosition(
    exchange?: string,
    token?: string,
  ): Promise<boolean> {
    try {
      if (!exchange || !token) return false;

      const netPositions = await this.exchangeDataService.getNetPositions();

      if (!Array.isArray(netPositions)) return false;

      const normalizedToken = String(token).trim();
      const normalizedExchange = String(exchange).trim().toUpperCase();

      return netPositions.some((p: any) => {
        const pToken = String(p.token ?? '').trim();
        const pExchange = String(p.raw?.exch ?? '')
          .trim()
          .toUpperCase();
        const netQty = Number(p.raw?.netqty ?? 0);

        return (
          pToken === normalizedToken &&
          pExchange === normalizedExchange &&
          netQty !== 0
        );
      });
    } catch (error) {
      this.logger.error(`hasOpenPosition error`, error?.stack || error);
      return false;
    }
  }
}
