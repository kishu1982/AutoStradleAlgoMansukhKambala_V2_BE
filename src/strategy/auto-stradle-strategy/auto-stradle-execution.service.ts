import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrdersService } from 'src/orders/orders.service';
import { AutoStradleStrategyService } from './auto-stradle-strategy.service';
import { ExchangeDataService } from '../exchange-data/exchange-data.service';

import * as fs from 'fs';
import * as path from 'path';
import { InstrumentInfo } from './interfaces/local-instrumentInfo-interface';
import { ExchangeOrder } from '../exchange-data/exchange-entities/exchange-order.entity';
import { AutoStradleRMSService } from './auto-stradle-rms.service';

@Injectable()
export class AutoStradleExecutionService implements OnModuleInit {
  private readonly logger = new Logger(AutoStradleExecutionService.name);

  private executionEnabled: boolean;

  private activeExecutions = new Set<string>();
  // ⭐ strongly typed map
  private instrumentMap = new Map<string, InstrumentInfo>();

  constructor(
    private readonly configService: ConfigService,
    private readonly ordersService: OrdersService,
    private readonly autoStradleService: AutoStradleStrategyService,
    private readonly exchangeDataService: ExchangeDataService,
    private readonly rmsService: AutoStradleRMSService,
  ) {
    this.executionEnabled =
      this.configService.get<string>('ACTIVATE_STRADLE_EXECUTION', 'false') ===
      'true';
  }

  // =====================================================
  // INIT
  // =====================================================

  onModuleInit() {
    this.loadInstrumentData();
  }

  // =====================================================
  // MAIN ENTRY FUNCTION
  // =====================================================

  async executeSignal(body: {
    strategyName: string;
    tokenNumber: string;
    exchange: string;
    side: 'BUY' | 'SELL';
  }) {
    try {
      if (!this.executionEnabled) {
        this.logger.warn('Execution disabled');
        return;
      }

      const activeConfigs = await this.autoStradleService.findActive();

      const matched = activeConfigs.filter(
        (c) =>
          c.strategyName === body.strategyName &&
          c.tokenNumber === body.tokenNumber &&
          c.exchange === body.exchange &&
          c.side === body.side,
      );

      if (!matched.length) {
        this.logger.warn('No matching strategy found');
        return;
      }

      for (const config of matched) {
        const execKey = this.buildExecutionKey(config);

        // ⭐ Prevent duplicate execution
        if (this.activeExecutions.has(execKey)) {
          this.logger.warn(`Execution already running: ${execKey}`);
          continue;
        }

        this.activeExecutions.add(execKey);

        this.executeStradle(config).finally(() => {
          this.activeExecutions.delete(execKey);
        });
      }
      // old working
      // for (const config of matched) {
      //   await this.executeStradle(config);
      // }
    } catch (err) {
      this.logger.error('executeSignal error', err?.stack || err);
    }
  }

  // =====================================================
  // STRADLE EXECUTION
  // =====================================================

  private async executeStradle(config: any) {
    try {
      const [legA, legB] = config.legsData;
      if (!legA || !legB) return;

      const lotA = this.getLotSize(legA.tokenNumber, legA.exch);
      const lotB = this.getLotSize(legB.tokenNumber, legB.exch);

      const desiredALots = legA.quantityLots;
      const desiredBLots = legB.quantityLots;

      const sideMultiplierA = legA.side === 'BUY' ? 1 : -1;
      const sideMultiplierB = legB.side === 'BUY' ? 1 : -1;

      let loopCount = 0;
      const MAX_LOOP = 10;

      while (true) {
        loopCount++;

        if (loopCount > MAX_LOOP) {
          this.logger.error('Max loop reached. Stopping execution.');
          break;
        }

        // ==============================
        // GET LATEST POSITIONS
        // ==============================

        const netPositions = await this.exchangeDataService.getNetPositions();

        const netAUnits = this.getNetPositionQty(
          netPositions,
          legA.tokenNumber,
          legA.exch,
        );

        const netBUnits = this.getNetPositionQty(
          netPositions,
          legB.tokenNumber,
          legB.exch,
        );

        const netALots = (netAUnits * sideMultiplierA) / lotA;
        const netBLots = (netBUnits * sideMultiplierB) / lotB;

        const remainingALots = Math.max(0, desiredALots - netALots);

        const remainingBLots = Math.max(0, desiredBLots - netBLots);

        this.logger.log(
          `Net lots A:${netALots} B:${netBLots} | Remaining A:${remainingALots} B:${remainingBLots}`,
        );

        // ==============================
        // STOP IF DONE
        // ==============================

        if (remainingALots === 0 && remainingBLots === 0) {
          this.logger.log('Target achieved. Exiting.');
          break;
        }

        const batch = this.calculateBatch(
          legA,
          legB,
          remainingALots,
          remainingBLots,
        );

        const qtyA = batch[legA.tokenNumber] * lotA;
        const qtyB = batch[legB.tokenNumber] * lotB;

        if (qtyA <= 0 && qtyB <= 0) {
          this.logger.warn('No quantity left to execute.');
          break;
        }

        // ==============================
        // PLACE ORDERS
        // ==============================

        await Promise.all([
          qtyA > 0
            ? this.ordersService.placeOrder({
                buy_or_sell: legA.side === 'BUY' ? 'B' : 'S',
                product_type: this.resolveProductType(config.productType),
                exchange: legA.exch,
                tradingsymbol: legA.tradingSymbol,
                quantity: qtyA,
                price_type: 'MKT',
                price: 0,
                trigger_price: 0,
                discloseqty: 0,
                retention: 'DAY',
                amo: 'NO',
                remarks: `AUTO STRADLE A`,
              })
            : Promise.resolve(),

          qtyB > 0
            ? this.ordersService.placeOrder({
                buy_or_sell: legB.side === 'BUY' ? 'B' : 'S',
                product_type: this.resolveProductType(config.productType),
                exchange: legB.exch,
                tradingsymbol: legB.tradingSymbol,
                quantity: qtyB,
                price_type: 'MKT',
                price: 0,
                trigger_price: 0,
                discloseqty: 0,
                retention: 'DAY',
                amo: 'NO',
                remarks: `AUTO STRADLE B`,
              })
            : Promise.resolve(),
        ]);

        // ==============================
        // WAIT FOR UPDATE
        // ==============================

        const changed = await this.waitForPositionUpdate(
          legA,
          legB,
          netAUnits,
          netBUnits,
          8000,
        );

        if (!changed) {
          this.logger.error(
            'Position did not update. Stopping to prevent duplicate execution.',
          );
          break;
        }

        // ==============================
        // CHECK REJECTIONS
        // ==============================

        const latestOrders = await this.exchangeDataService.getOrders();

        if (this.hasRecentRejection(latestOrders, legA, legB, 60)) {
          this.logger.error(
            'Recent rejection detected (within 1 minute). Stopping execution.',
          );
          break;
        }
      }
    } catch (err) {
      this.logger.error('executeStradle error', err?.stack || err);
    }
  }

  // =====================================================
  // HELPERS
  // =====================================================

  private getLotSize(token: string, exchange: string): number {
    try {
      const key = `${exchange}|${token}`;

      const instrument = this.instrumentMap.get(key);

      if (!instrument) {
        this.logger.warn(`LotSize not found for ${key}`);
        return 1;
      }

      return Number(instrument.lotSize || 1);
    } catch (error) {
      this.logger.error('getLotSize error', error?.stack || error);

      return 1;
    }
  }

  private getNetPositionQty(
    netPositions: any,
    token: string,
    exchange: string,
  ): number {
    try {
      if (!Array.isArray(netPositions)) {
        this.logger.warn('Positions array missing');
        return 0;
      }

      const normalizedToken = String(token).trim();
      const normalizedExchange = String(exchange).trim().toUpperCase();

      const matched = netPositions.filter((p: any) => {
        const pToken = String(p.token ?? '').trim();

        const pExchange = String(p.raw?.exch ?? '')
          .trim()
          .toUpperCase();

        return pToken === normalizedToken && pExchange === normalizedExchange;
      });

      const total = matched.reduce(
        (sum: number, p: any) => sum + Number(p.raw?.netqty ?? 0),
        0,
      );

      return total;
    } catch (err) {
      this.logger.error('getNetPositionQty error', err?.stack);
      return 0;
    }
  }

  private resolveProductType(productType: string): 'I' | 'C' | 'M' {
    if (productType === 'INTRADAY') return 'I';
    if (productType === 'DELIVERY') return 'C';

    return 'M';
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // =====================================================
  // LOAD INSTRUMENT DATA
  // =====================================================

  private loadInstrumentData() {
    try {
      const filePath = path.join(
        process.cwd(),
        'data',
        'instrumentinfo',
        'instruments.json',
      );

      const fileContent = fs.readFileSync(filePath, 'utf-8');

      const instruments: InstrumentInfo[] = JSON.parse(fileContent);

      for (const inst of instruments) {
        const key = `${inst.exchange}|${inst.token}`;

        this.instrumentMap.set(key, inst);
      }

      this.logger.log(`✅ Loaded ${this.instrumentMap.size} instruments`);
    } catch (error) {
      this.logger.error('Failed loading instruments', error?.stack || error);
    }
  }

  // =====================================================
  // Calculate batch sizes for legs based on ratios
  // =====================================================
  private calculateBatch(legA, legB, remainingA: number, remainingB: number) {
    try {
      const ratioA = legA.ratio || 1;
      const ratioB = legB.ratio || 1;

      // ⭐ batch = ratio itself
      let batchA = ratioA;
      let batchB = ratioB;

      // clamp by remaining lots
      batchA = Math.min(batchA, remainingA);
      batchB = Math.min(batchB, remainingB);

      return {
        [legA.tokenNumber]: batchA,
        [legB.tokenNumber]: batchB,
      };
    } catch (error) {
      this.logger.error('calculateBatch error', error?.stack || error);

      return {
        [legA.tokenNumber]: 0,
        [legB.tokenNumber]: 0,
      };
    }
  }

  // =====================================================
  // count recent rejects for a given token and exchange
  // =====================================================
  private countRecentRejects(
    orderBook: ExchangeOrder[],
    token: string,
    exch: string,
  ): number {
    try {
      return orderBook.filter(
        (o) =>
          o.raw?.token === token &&
          o.raw?.exch === exch &&
          o.raw?.status === 'REJECTED',
      ).length;
    } catch (err) {
      this.logger.error('countRecentRejects error', err?.stack);

      return 0;
    }
  }

  //Create unique execution key
  private buildExecutionKey(config: any): string {
    const [legA, legB] = config.legsData;

    return `${config.strategyName}_${legA.exch}_${legA.tokenNumber}_${legB.exch}_${legB.tokenNumber}`;
  }

  // wait for position update by polling net positions until change is detected or timeout occurs
  private async waitForPositionUpdate(
    legA,
    legB,
    prevNetA: number,
    prevNetB: number,
    timeout = 8000,
  ): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      await this.sleep(500);

      const netPositions = await this.exchangeDataService.getNetPositions();
      // this.logger.log('Checking for position update...', netPositions);

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

      if (newNetA !== prevNetA || newNetB !== prevNetB) {
        this.logger.log(
          `Position updated A:${prevNetA}->${newNetA} B:${prevNetB}->${newNetB}`,
        );
        return true;
      }
    }

    return false;
  }

  // =====================================================
  // Check if any rejection happened in last X seconds
  // =====================================================
  private hasRecentRejection(
    orders: ExchangeOrder[],
    legA,
    legB,
    windowSeconds = 60,
  ): boolean {
    try {
      const now = Date.now();

      return orders.some((o: any) => {
        // Must be rejected
        if (o.raw?.status !== 'REJECTED') return false;

        // Must belong to current legs
        if (
          o.raw?.token !== legA.tokenNumber &&
          o.raw?.token !== legB.tokenNumber
        ) {
          return false;
        }

        // Extract order time (adjust field if needed)
        const orderTimeStr =
          o.raw?.norentm || o.raw?.ordenttm || o.raw?.exch_tm || null;

        if (!orderTimeStr) return false;

        // ⚠️ If broker sends DD-MM-YYYY HH:mm:ss format,
        // you may need proper parsing.
        const orderTime = new Date(orderTimeStr).getTime();

        if (isNaN(orderTime)) return false;

        return now - orderTime <= windowSeconds * 1000;
      });
    } catch (err) {
      this.logger.error('hasRecentRejection error', err?.stack || err);
      return false;
    }
  }
}
