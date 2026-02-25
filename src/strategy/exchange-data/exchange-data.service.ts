import { Injectable, OnModuleInit, Logger } from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';
import { MongoRepository } from 'typeorm';

import { OrdersService } from 'src/orders/orders.service';
import { MarketService } from 'src/market/market.service';

import { ExchangeOrder } from './exchange-entities/exchange-order.entity';
import { ExchangeTrade } from './exchange-entities/exchange-trade.entity';
import { ExchangeNetPosition } from './exchange-entities/exchange-net-position.entity';

import { Cron } from '@nestjs/schedule';

@Injectable()
export class ExchangeDataService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeDataService.name);

  // ⭐ queue lock
  private syncPromise: Promise<void> = Promise.resolve();

  // ⭐ memory cache
  private orderCache: any[] = [];
  private tradeCache: any[] = [];
  private netPositionCache: any[] = [];

  constructor(
    @InjectRepository(ExchangeOrder)
    private readonly orderRepo: MongoRepository<ExchangeOrder>,

    @InjectRepository(ExchangeTrade)
    private readonly tradeRepo: MongoRepository<ExchangeTrade>,

    @InjectRepository(ExchangeNetPosition)
    private readonly netPositionRepo: MongoRepository<ExchangeNetPosition>,

    private readonly ordersService: OrdersService,
    private readonly marketService: MarketService,
  ) {}

  // --------------------------------
  // MODULE INIT
  // --------------------------------

  async onModuleInit() {
    try {
      this.logger.log('ExchangeDataService initialized');

      await this.queueSync(async () => {
        await this.safeSync(() => this.syncOrderBook());
        await this.safeSync(() => this.syncTradeBook());
        await this.safeSync(() => this.syncNetPositions());
      });

      await this.loadAllCachesFromDB();
    } catch (err) {
      this.logger.error('Module init failed', err?.stack || err);
    }
  }

  // --------------------------------
  // SAFE QUEUE
  // --------------------------------

  async queueSync(fn: () => Promise<void>) {
    this.syncPromise = this.syncPromise
      .then(() => fn())
      .catch((err) => {
        this.logger.error('Queue error', err?.stack || err);
      });

    return this.syncPromise;
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
  // SCHEDULER EVERY 2 SEC
  // --------------------------------

  @Cron('*/2 * * * * *')
  async autoSyncScheduler() {
    try {
      await this.queueSync(async () => {
        await this.safeSync(() => this.syncOrderBook());
        await this.safeSync(() => this.syncTradeBook());
        await this.safeSync(() => this.syncNetPositions());

        await this.safeSync(() => this.loadAllCachesFromDB());
      });
    } catch (err) {
      this.logger.error('Scheduler error', err?.stack || err);
    }
  }

  // --------------------------------
  // CACHE LOADER
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
  // GETTERS for local cache (fast access for strategies)
  // --------------------------------

  getOrders() {
    return this.orderCache;
  }

  getTrades() {
    return this.tradeCache;
  }

  getNetPositions() {
    return this.netPositionCache;
  }

  // --------------------------------
  // SYNC METHODS
  // --------------------------------

  private async syncOrderBook() {
    const data = await this.ordersService.getOrderBook();
    const trades = data?.trades ?? [];

    await this.syncCollection(this.orderRepo, trades);
  }

  private async syncTradeBook() {
    const data = await this.ordersService.getTradeBook();
    const trades = data?.trades ?? [];

    await this.syncCollection(this.tradeRepo, trades);
  }

  private async syncNetPositions() {
    const response = await this.ordersService.getNetPositions();
    const positions = response?.data ?? [];

    await this.netPositionRepo.deleteMany({});

    if (!positions.length) return;

    await this.netPositionRepo.insertMany(
      positions.map((pos) => ({
        token: pos.token,
        tsym: pos.tsym,
        raw: pos,
      })),
    );
  }

  private async syncCollection(repo: MongoRepository<any>, trades: any[]) {
    try {
      const today = new Date().toISOString().split('T')[0];

      // cleanup old data
      await repo.deleteMany({
        tradeDate: { $ne: today } as any,
      });

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
  // PUBLIC FORCE SYNC (Websocket trigger)
  // --------------------------------

  async forceSyncFromWebsocket() {
    try {
      this.logger.log('Websocket triggered exchange sync');

      await this.queueSync(async () => {
        await this.safeSync(() => this.syncOrderBook());

        await this.safeSync(() => this.syncTradeBook());

        await this.safeSync(() => this.syncNetPositions());

        await this.safeSync(() => this.loadAllCachesFromDB());
      });

      const orders = this.getOrders();
      const trades = this.getTrades();
      const netPositions = this.getNetPositions();

      this.logger.log(
        `Sync complete. Orders: ${orders.length}, Trades: ${trades.length}, NetPositions: ${netPositions.length}`,
      );
    } catch (err) {
      this.logger.error('forceSyncFromWebsocket failed', err?.stack || err);
    }
  }
}
