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
import { MarketService } from './../../market/market.service';
import { fileURLToPath } from 'url';

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
    private readonly marketService: MarketService,
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
        // GET LIMIT PRICES
        // ==============================

        const [priceA, priceB] = await Promise.all([
          qtyA > 0
            ? this.getLimitPrice(legA.exch, legA.tokenNumber, legA.side)
            : Promise.resolve(undefined),

          qtyB > 0
            ? this.getLimitPrice(legB.exch, legB.tokenNumber, legB.side)
            : Promise.resolve(undefined),
        ]);

        // ==============================
        // VALIDATE BOTH LEG PRICES
        // ==============================

        const legAPriceMissing = qtyA > 0 && priceA === undefined;
        const legBPriceMissing = qtyB > 0 && priceB === undefined;

        if (legAPriceMissing || legBPriceMissing) {
          if (legAPriceMissing) {
            this.logger.error(
              `Price not available for LEG A → ${legA.tradingSymbol} (${legA.tokenNumber})`,
            );
          }

          if (legBPriceMissing) {
            this.logger.error(
              `Price not available for LEG B → ${legB.tradingSymbol} (${legB.tokenNumber})`,
            );
          }

          this.logger.error(
            'Both leg prices are required. Skipping order placement.',
          );

          break; // Exit loop safely
        }
        // ==============================
        // PLACE LIMIT ORDERS
        // ==============================

        const [orderResA, orderResB] = await Promise.all([
          qtyA > 0
            ? this.ordersService.placeOrder({
                buy_or_sell: legA.side === 'BUY' ? 'B' : 'S',
                product_type: this.resolveProductType(config.productType),
                exchange: legA.exch,
                tradingsymbol: legA.tradingSymbol,
                quantity: qtyA,
                price_type: 'LMT',
                price: priceA,
                trigger_price: 0,
                discloseqty: 0,
                retention: 'DAY',
                amo: 'NO',
                remarks: `AUTO STRADLE A`,
              })
            : Promise.resolve(undefined),

          qtyB > 0
            ? this.ordersService.placeOrder({
                buy_or_sell: legB.side === 'BUY' ? 'B' : 'S',
                product_type: this.resolveProductType(config.productType),
                exchange: legB.exch,
                tradingsymbol: legB.tradingSymbol,
                quantity: qtyB,
                price_type: 'LMT',
                price: priceB,
                trigger_price: 0,
                discloseqty: 0,
                retention: 'DAY',
                amo: 'NO',
                remarks: `AUTO STRADLE B`,
              })
            : Promise.resolve(undefined),
        ]);

        this.logger.debug(
          `Order placement response A: ${JSON.stringify(orderResA)} | B: ${JSON.stringify(orderResB)}`,
        );

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
          // ⭐ Log remaining lots so it's clear from logs alone how much
          // was actually left unfilled when the loop stopped early
          this.logger.error(
            `Position did not update. Stopping to prevent duplicate execution. ` +
              `Remaining A=${remainingALots} B=${remainingBLots} (config=${config._id})`,
          );
          break;
        }

        // ==============================
        // CHECK REJECTIONS — only for orders from THIS batch, not any
        // rejection in a rolling window (which could belong to a
        // different, unrelated order and wrongly abort the whole run)
        // ==============================

        const latestOrders = await this.exchangeDataService.getOrders();

        const thisBatchRejected = this.hasThisOrderRejected(
          latestOrders,
          orderResA,
          orderResB,
        );

        if (thisBatchRejected) {
          this.logger.error(
            `This batch's order was rejected. Stopping execution. ` +
              `Remaining A=${remainingALots} B=${remainingBLots} (config=${config._id})`,
          );
          break;
        }
        // // ==============================
        // // PLACE LIMIT ORDERS
        // // ==============================

        // await Promise.all([
        //   qtyA > 0
        //     ? this.ordersService.placeOrder({
        //         buy_or_sell: legA.side === 'BUY' ? 'B' : 'S',
        //         product_type: this.resolveProductType(config.productType),
        //         exchange: legA.exch,
        //         tradingsymbol: legA.tradingSymbol,
        //         quantity: qtyA,
        //         price_type: 'LMT',
        //         price: priceA,
        //         trigger_price: 0,
        //         discloseqty: 0,
        //         retention: 'DAY',
        //         amo: 'NO',
        //         remarks: `AUTO STRADLE A`,
        //       })
        //     : Promise.resolve(),

        //   qtyB > 0
        //     ? this.ordersService.placeOrder({
        //         buy_or_sell: legB.side === 'BUY' ? 'B' : 'S',
        //         product_type: this.resolveProductType(config.productType),
        //         exchange: legB.exch,
        //         tradingsymbol: legB.tradingSymbol,
        //         quantity: qtyB,
        //         price_type: 'LMT',
        //         price: priceB,
        //         trigger_price: 0,
        //         discloseqty: 0,
        //         retention: 'DAY',
        //         amo: 'NO',
        //         remarks: `AUTO STRADLE B`,
        //       })
        //     : Promise.resolve(),
        // ]);

        // // // ==============================
        // // // PLACE ORDERS
        // // // ==============================

        // // await Promise.all([
        // //   qtyA > 0
        // //     ? this.ordersService.placeOrder({
        // //         buy_or_sell: legA.side === 'BUY' ? 'B' : 'S',
        // //         product_type: this.resolveProductType(config.productType),
        // //         exchange: legA.exch,
        // //         tradingsymbol: legA.tradingSymbol,
        // //         quantity: qtyA,
        // //         price_type: 'MKT',
        // //         price: 0,
        // //         trigger_price: 0,
        // //         discloseqty: 0,
        // //         retention: 'DAY',
        // //         amo: 'NO',
        // //         remarks: `AUTO STRADLE A`,
        // //       })
        // //     : Promise.resolve(),

        // //   qtyB > 0
        // //     ? this.ordersService.placeOrder({
        // //         buy_or_sell: legB.side === 'BUY' ? 'B' : 'S',
        // //         product_type: this.resolveProductType(config.productType),
        // //         exchange: legB.exch,
        // //         tradingsymbol: legB.tradingSymbol,
        // //         quantity: qtyB,
        // //         price_type: 'MKT',
        // //         price: 0,
        // //         trigger_price: 0,
        // //         discloseqty: 0,
        // //         retention: 'DAY',
        // //         amo: 'NO',
        // //         remarks: `AUTO STRADLE B`,
        // //       })
        // //     : Promise.resolve(),
        // // ]);

        // // ==============================
        // // WAIT FOR UPDATE
        // // ==============================

        // const changed = await this.waitForPositionUpdate(
        //   legA,
        //   legB,
        //   netAUnits,
        //   netBUnits,
        //   8000,
        // );

        // if (!changed) {
        //   this.logger.error(
        //     'Position did not update. Stopping to prevent duplicate execution.',
        //   );
        //   break;
        // }

        // // ==============================
        // // CHECK REJECTIONS
        // // ==============================

        // const latestOrders = await this.exchangeDataService.getOrders();

        // if (this.hasRecentRejection(latestOrders, legA, legB, 60)) {
        //   this.logger.error(
        //     'Recent rejection detected (within 1 minute). Stopping execution.',
        //   );
        //   break;
        // }
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

  // helper to convert date string to epoch seconds (if needed for time comparisons)
  private convertISTToEpoch(dateTimeStr: string): string {
    try {
      // Treat input as IST
      const istDate = new Date(
        new Date(dateTimeStr).toLocaleString('en-US', {
          timeZone: 'Asia/Kolkata',
        }),
      );

      return Math.floor(istDate.getTime() / 1000).toString();
    } catch (err) {
      this.logger.error('convertISTToEpoch error', err?.stack || err);
      return '';
    }
  }

  private getDefaultISTStartEndEpoch() {
    try {
      const nowIST = new Date(
        new Date().toLocaleString('en-US', {
          timeZone: 'Asia/Kolkata',
        }),
      );

      const yyyy = nowIST.getFullYear();
      const mm = String(nowIST.getMonth() + 1).padStart(2, '0');
      const dd = String(nowIST.getDate()).padStart(2, '0');

      const startIST = new Date(`${yyyy}-${mm}-${dd}T09:00:00`);
      const endIST = new Date(`${yyyy}-${mm}-${dd}T09:45:00`);

      return {
        starttime: Math.floor(startIST.getTime() / 1000).toString(),
        endtime: Math.floor(endIST.getTime() / 1000).toString(),
      };
    } catch (err) {
      this.logger.error('getDefaultISTStartEndEpoch error', err?.stack || err);
      return { starttime: '', endtime: '' };
    }
  }

  // main function to genrate highest high and low of the day from time series data for given token and exchange
  async getHighLowFromTimeSeries(params: {
    exchange: string;
    token: string;
    startDateTime?: string;
    endDateTime?: string;
  }) {
    try {
      let starttime: string;
      let endtime: string;

      // ⭐ if dates missing → default range
      if (!params.startDateTime || !params.endDateTime) {
        const def = this.getDefaultISTStartEndEpoch();
        starttime = def.starttime;
        endtime = def.endtime;
      } else {
        starttime = this.convertISTToEpoch(params.startDateTime);
        endtime = this.convertISTToEpoch(params.endDateTime);
      }

      const data = await this.marketService.getTimePriceSeries({
        exchange: params.exchange,
        token: params.token,
        starttime,
        endtime,
        interval: '5',
      });

      if (!Array.isArray(data) || !data.length) {
        this.logger.warn('No time series data received');
        return null;
      }

      let highestHigh = -Infinity;
      let highestHighTime = '';

      let lowestLow = Infinity;
      let lowestLowTime = '';

      for (const candle of data) {
        const high = Number(candle.inth);
        const low = Number(candle.intl);

        if (!isNaN(high) && high > highestHigh) {
          highestHigh = high;
          highestHighTime = candle.time;
        }

        if (!isNaN(low) && low < lowestLow) {
          lowestLow = low;
          lowestLowTime = candle.time;
        }
      }

      return {
        highestHigh,
        highestHighTime,
        lowestLow,
        lowestLowTime,
      };
    } catch (err) {
      this.logger.error('getHighLowFromTimeSeries error', err?.stack || err);
      return null;
    }
  }

  // =====================================================
  // GET LIMIT PRICE FROM QUOTES
  // =====================================================
  private async getLimitPrice(
    exch: string,
    token: string,
    side: 'BUY' | 'SELL',
  ): Promise<number | undefined> {
    try {
      const quote = await this.marketService.getQuotes({ exch, token });

      if (!quote || quote.stat !== 'Ok') {
        this.logger.error('Quote fetch failed', quote);
        return undefined;
      }

      const tickSize = Number(quote.ti) || 0.05;
      const upperCircuit = Number(quote.uc);
      const lowerCircuit = Number(quote.lc);
      const ltp = Number(quote.lp);

      // Aggressive buffer to cross the spread and improve fill probability
      // during fast moves (2 ticks here — tune per instrument if needed)
      const buffer = tickSize * 2;

      let price: number | undefined;

      if (side === 'BUY') {
        const bestAsk = Number(quote.sp5);
        if (!isNaN(bestAsk) && bestAsk > 0) {
          price = bestAsk + buffer; // cross the ask to guarantee priority
        } else if (!isNaN(ltp) && ltp > 0) {
          this.logger.warn(
            `No ask depth for ${quote.tsym}, falling back to LTP`,
          );
          price = ltp + buffer;
        }
      } else {
        const bestBid = Number(quote.bp5);
        if (!isNaN(bestBid) && bestBid > 0) {
          price = bestBid - buffer;
        } else if (!isNaN(ltp) && ltp > 0) {
          this.logger.warn(
            `No bid depth for ${quote.tsym}, falling back to LTP`,
          );
          price = ltp - buffer;
        }
      }

      if (price === undefined || isNaN(price)) {
        this.logger.error(`Unable to derive price for ${quote.tsym}`);
        return undefined;
      }

      // Never breach exchange circuit limits
      if (!isNaN(upperCircuit) && upperCircuit > 0 && price > upperCircuit) {
        price = upperCircuit;
      }
      if (!isNaN(lowerCircuit) && price < lowerCircuit) {
        price = lowerCircuit;
      }

      // Snap to valid tick size
      price = Math.round(price / tickSize) * tickSize;

      this.logger.debug(
        `${side} limit price for ${quote.tsym}: ${price} (bp1=${quote.bp1}, sp1=${quote.sp1}, lp=${quote.lp})`,
      );

      return price;
    } catch (err) {
      this.logger.error('getLimitPrice error', err?.stack || err);
      return undefined;
    }
  }
  // old wokring with simple bp5 sp5
  // private async getLimitPrice(
  //   exch: string,
  //   token: string,
  //   side: 'BUY' | 'SELL',
  // ): Promise<number | undefined> {
  //   try {
  //     const quote = await this.marketService.getQuotes({
  //       exch,
  //       token,
  //     });

  //     if (!quote || quote.stat !== 'Ok') {
  //       this.logger.error('Quote fetch failed', quote);
  //       return undefined;
  //     }

  //     let price: number | undefined;

  //     if (side === 'BUY') {
  //       // price = Number(quote.uc);
  //       price = Number(quote.sp5);
  //       this.logger.debug(
  //         `BUY side - using sell price (sp5): ${price} for ${quote.tsym}`,
  //       );
  //     } else {
  //       // price = Number(quote.lc);
  //       price = Number(quote.bp5);
  //       this.logger.debug(
  //         `SELL side - using buy price (bp5): ${price} for ${quote.tsym}`,
  //       );
  //     }

  //     return isNaN(price) ? undefined : price;
  //   } catch (err) {
  //     this.logger.error('getLimitPrice error', err?.stack || err);
  //     return undefined;
  //   }
  // }

  //=====================================================
  // GET ACTIVE AUTO STRADLE TRADE DATA
  //=====================================================
  // =====================================================
  // GET ACTIVE AUTO STRADLE TRADE DATA
  // =====================================================

  async getActiveTradeData() {
    try {
      this.logger.debug('Fetching active trade data...');
      const folderPath = path.join(process.cwd(), 'data', 'AutoStradleTrade');

      // Folder not exists
      if (!fs.existsSync(folderPath)) {
        return {
          success: false,
          message: 'No trade running',
          data: null,
        };
      }

      const files = fs
        .readdirSync(folderPath)
        .filter((file) => file.endsWith('.json'));

      // No json files found
      if (!files.length) {
        return {
          success: false,
          message: 'No trade running',
          data: null,
        };
      }

      const tradeData: {
        fileName: string;
        data: any;
      }[] = [];

      for (const file of files) {
        try {
          const filePath = path.join(folderPath, file);

          const content = fs.readFileSync(filePath, 'utf8');

          tradeData.push({
            fileName: file,
            data: JSON.parse(content),
          });
        } catch (err) {
          this.logger.error(`Failed reading ${file}`, err?.stack || err);
        }
      }

      if (!tradeData.length) {
        return {
          success: false,
          message: 'No trade running',
          data: null,
        };
      }

      return {
        success: true,
        message: 'Active trade data found',
        data: tradeData,
      };
    } catch (err) {
      this.logger.error('getActiveTradeData error', err?.stack || err);

      return {
        success: false,
        message: 'Failed to fetch trade data',
        data: null,
      };
    }
  }

  // =====================================================
  // Check if a SPECIFIC order (by order ID) was rejected
  // =====================================================
  private hasThisOrderRejected(
    orders: ExchangeOrder[],
    orderResA: any,
    orderResB: any,
  ): boolean {
    try {
      const idA = orderResA?.norenordno || orderResA?.orderId;
      const idB = orderResB?.norenordno || orderResB?.orderId;

      if (!idA && !idB) return false;

      return orders.some((o: any) => {
        const oid = o.raw?.norenordno;
        return (oid === idA || oid === idB) && o.raw?.status === 'REJECTED';
      });
    } catch (err) {
      this.logger.error('hasThisOrderRejected error', err?.stack || err);
      return false;
    }
  }
}
