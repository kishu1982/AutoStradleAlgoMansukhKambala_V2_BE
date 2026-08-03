import { Injectable, OnModuleInit, Logger } from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';
import { MongoRepository } from 'typeorm';

import { OrdersService } from 'src/orders/orders.service';
import { MarketService } from 'src/market/market.service';

import { ExchangeOrder } from './exchange-entities/exchange-order.entity';
import { ExchangeTrade } from './exchange-entities/exchange-trade.entity';
import { ExchangeNetPosition } from './exchange-entities/exchange-net-position.entity';

import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ExchangeDataService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeDataService.name);
  private clientUid = ''; // for future use if needed in filter or anywhere else, can be set from env or config

  // ⭐ memory cache
  private orderCache: any[] = [];
  private tradeCache: any[] = [];
  private netPositionCache: any[] = [];

  // ⭐ three independent queues so a force-fetch of one resource
  // never waits behind an unrelated sync
  private orderSyncPromise: Promise<void> = Promise.resolve();
  private tradeSyncPromise: Promise<void> = Promise.resolve();
  private positionSyncPromise: Promise<void> = Promise.resolve();

  constructor(
    @InjectRepository(ExchangeOrder)
    private readonly orderRepo: MongoRepository<ExchangeOrder>,

    @InjectRepository(ExchangeTrade)
    private readonly tradeRepo: MongoRepository<ExchangeTrade>,

    @InjectRepository(ExchangeNetPosition)
    private readonly netPositionRepo: MongoRepository<ExchangeNetPosition>,

    private readonly ordersService: OrdersService,
    private readonly marketService: MarketService,
    private readonly configService: ConfigService,
  ) {
    this.clientUid = this.configService.get<string>('NOREN_CLIENT_ID') || '';
  }

  // --------------------------------
  // MODULE INIT
  // --------------------------------

  async onModuleInit() {
    try {
      this.logger.log('ExchangeDataService initialized');

      await Promise.all([
        this.queue('order', () => this.syncOrderBook()),
        this.queue('trade', () => this.syncTradeBook()),
        this.queue('position', () => this.syncNetPositions()),
      ]);
    } catch (err) {
      this.logger.error('Module init failed', err?.stack || err);
    }
  }

  // --------------------------------
  // SAFE EXECUTOR
  // --------------------------------

  private async safeSync(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      this.logger.error('Sync failed', err?.stack || err);
    }
  }

  // --------------------------------
  // PER-RESOURCE QUEUE
  // --------------------------------

  private queue(
    which: 'order' | 'trade' | 'position',
    fn: () => Promise<void>,
  ): Promise<void> {
    const prevMap = {
      order: this.orderSyncPromise,
      trade: this.tradeSyncPromise,
      position: this.positionSyncPromise,
    };
    const previous = prevMap[which];

    const current = previous.then(() => this.safeSync(fn));

    if (which === 'order') this.orderSyncPromise = current;
    if (which === 'trade') this.tradeSyncPromise = current;
    if (which === 'position') this.positionSyncPromise = current;

    return current;
  }

  // --------------------------------
  // SCHEDULER EVERY 2 SEC (background refresh for cached reads)
  // --------------------------------

  @Cron('*/2 * * * * *')
  async autoSyncScheduler() {
    try {
      // fire independently, don't serialize them behind each other
      this.queue('order', () => this.syncOrderBook());
      this.queue('trade', () => this.syncTradeBook());
      this.queue('position', () => this.syncNetPositions());
    } catch (err) {
      this.logger.error('Scheduler error', err?.stack || err);
    }
  }

  // --------------------------------
  // DAILY CLEANUP — was previously a deleteMany({tradeDate: {$ne: today}})
  // run on EVERY order/trade sync (i.e. every 2s, plus every getOrders/
  // getTrades call). That's an unindexed inequality scan on the whole
  // collection, paid every single call. Once a day is plenty.
  // --------------------------------

  @Cron('0 0 * * *') // midnight server time — adjust if you need IST specifically
  async cleanupStaleOrdersAndTrades() {
    try {
      const today = new Date().toISOString().split('T')[0];

      await Promise.all([
        this.orderRepo.deleteMany({ tradeDate: { $ne: today } as any }),
        this.tradeRepo.deleteMany({ tradeDate: { $ne: today } as any }),
      ]);

      this.logger.log('Daily cleanup of stale orders/trades complete');
    } catch (err) {
      this.logger.error(
        'cleanupStaleOrdersAndTrades failed',
        err?.stack || err,
      );
    }
  }

  // --------------------------------
  // CACHE LOADER (used only if you ever need to hydrate from DB, e.g. after a restart)
  // --------------------------------

  async loadAllCachesFromDB() {
    try {
      this.orderCache = await this.orderRepo.find();
      this.tradeCache = await this.tradeRepo.find();
      this.netPositionCache = await this.netPositionRepo.find();
    } catch (err) {
      this.logger.error('Cache load failed', err?.stack || err);
    }
  }

  // --------------------------------
  // FRESH GETTERS — always hit the broker, then return
  // Use these wherever staleness could cause a trading mistake
  // (execution decisions, RMS exit checks, reconciliation, etc.)
  // --------------------------------

  async getNetPositions() {
    await this.queue('position', () => this.syncNetPositions());
    return this.netPositionCache;
  }

  async getOrders() {
    await this.queue('order', () => this.syncOrderBook());
    return this.orderCache;
  }

  async getTrades() {
    await this.queue('trade', () => this.syncTradeBook());
    return this.tradeCache;
  }

  // --------------------------------
  // CACHED GETTERS — instant, no broker round trip
  // Use these for non-urgent reads (UI polling, logging, low-priority checks)
  // --------------------------------

  getCachedNetPositions() {
    return this.netPositionCache;
  }

  getCachedOrders() {
    return this.orderCache;
  }

  getCachedTrades() {
    return this.tradeCache;
  }

  // --------------------------------
  // SYNC METHODS
  // --------------------------------

  private async syncOrderBook() {
    const data = await this.ordersService.getOrderBook();
    const orders = data?.trades ?? [];

    // ⭐ Update memory cache FIRST — this is what getOrders() is waiting on.
    // DB persistence below does not block the getter.
    this.orderCache = orders.map((order) => ({
      norenordno: order.norenordno,
      exchordid: order.exchordid,
      tradeDate: new Date().toISOString().split('T')[0],
      raw: order,
    }));

    // fire-and-forget persistence — history/audit only, not on the read path
    this.syncCollection(this.orderRepo, orders).catch((err) =>
      this.logger.error('syncOrderBook persist failed', err?.stack || err),
    );
  }

  private async syncTradeBook() {
    const data = await this.ordersService.getTradeBook();
    const trades = data?.trades ?? [];

    // ⭐ Update memory cache FIRST — this is what getTrades() is waiting on.
    this.tradeCache = trades.map((trade) => ({
      norenordno: trade.norenordno,
      exchordid: trade.exchordid,
      tradeDate: new Date().toISOString().split('T')[0],
      raw: trade,
    }));

    // fire-and-forget persistence
    this.syncCollection(this.tradeRepo, trades).catch((err) =>
      this.logger.error('syncTradeBook persist failed', err?.stack || err),
    );
  }

  private async syncNetPositions() {
    this.logger.warn('SYNC NETPOS START');

    const response = await this.ordersService.getNetPositions();

    this.logger.warn('BROKER RESPONSE RECEIVED');

    const positions = response?.data ?? [];
    this.logger.warn(`POSITIONS = ${positions.length}`);

    await this.netPositionRepo.deleteMany({});

    if (positions.length) {
      const docs = positions.map((pos) => ({
        token: pos.token,
        tsym: pos.tsym,
        raw: pos,
      }));

      await this.netPositionRepo.insertMany(docs);

      // ⭐ Update cache immediately
      this.netPositionCache = docs;
    } else {
      this.netPositionCache = [];
    }
    this.logger.warn('SYNC NETPOS END');
  }

  // retry until broker reflects a non-zero position, or give up after maxRetry
  async waitForFreshNetPositions(maxRetry = 3) {
    for (let i = 1; i <= maxRetry; i++) {
      const positions = await this.getNetPositions();

      const hasLivePosition = positions.some(
        (p) => Number(p.raw?.netqty ?? 0) !== 0,
      );

      if (hasLivePosition) {
        return positions;
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    return this.getNetPositions();
  }

  private async syncCollection(repo: MongoRepository<any>, trades: any[]) {
    try {
      const today = new Date().toISOString().split('T')[0];

      // ⭐ IMPORTANT FIX
      if (!Array.isArray(trades) || trades.length === 0) {
        this.logger.debug('No trades received. Skipping bulkWrite.');
        return;
      }

      const operations = trades.map((trade) => ({
        updateOne: {
          filter: {
            norenordno: trade.norenordno,
            exchordid: trade.exchordid,
          },
          update: {
            $set: {
              norenordno: trade.norenordno,
              exchordid: trade.exchordid,
              tradeDate: today,
              raw: trade,
            },
          },
          upsert: true,
        },
      }));

      // extra safety
      if (!operations.length) {
        this.logger.debug('Bulk operations empty. Skipping.');
        return;
      }

      await repo.bulkWrite(operations);
    } catch (err) {
      this.logger.error('syncCollection failed', err?.stack || err);
    }
  }

  // --------------------------------
  // FOR GIVING CLIENT ID ON WHICH ALGO IS RUNNING
  // --------------------------------
  getClientUid() {
    return { AlgoId: this.clientUid };
  }

  // --------------------------------
  // PUBLIC FORCE SYNC (Websocket trigger)
  // --------------------------------

  async forceSyncFromWebsocket() {
    try {
      this.logger.log('Websocket triggered exchange sync');

      await Promise.all([
        this.queue('order', () => this.syncOrderBook()),
        this.queue('trade', () => this.syncTradeBook()),
        this.queue('position', () => this.syncNetPositions()),
      ]);

      const orders = this.getCachedOrders();
      const trades = this.getCachedTrades();
      const netPositions = this.getCachedNetPositions();

      this.logger.log(
        `Sync complete. Orders: ${orders.length}, Trades: ${trades.length}, NetPositions: ${netPositions.length}`,
      );
    } catch (err) {
      this.logger.error('forceSyncFromWebsocket failed', err?.stack || err);
    }
  }

  // kept as a thin explicit wrapper — same as calling getNetPositions(),
  // provided for readability at call sites that want to be explicit
  // about "force a fresh sync" intent
  async forceNetPositionSync() {
    await this.queue('position', () => this.syncNetPositions());
    return this.netPositionCache;
  }
}
