import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { MarketService } from 'src/market/market.service';
import { AutoStradleStrategyService } from './auto-stradle-strategy.service';
import { isTradingAllowedForExchange } from 'src/common/utils/trading-time.util';

interface VwapCacheEntry {
  vwap: number;
  isFallback: boolean; // true if 'ap' was missing and we used 'lp' instead
  updatedAt: number;
}

@Injectable()
export class VwapCacheService {
  private readonly logger = new Logger(VwapCacheService.name);

  // key = `${exchange}|${token}` — one entry per unique underlying, not per config
  private readonly cache = new Map<string, VwapCacheEntry>();
  private isRunning = false;

  constructor(
    private readonly marketService: MarketService,
    private readonly autoStradleService: AutoStradleStrategyService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async refreshVwapCache() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const activeConfigs = await this.autoStradleService.findActive();
      if (!activeConfigs.length) return;

      // De-dupe: multiple strategies can share the same underlying token
      const uniqueKeys = new Map<string, { exch: string; token: string }>();
      for (const config of activeConfigs) {
        if (!isTradingAllowedForExchange(config.exchange, this.configService)) {
          continue; // getQuotes is only meaningful during session hours anyway
        }
        const key = `${config.exchange}|${config.tokenNumber}`;
        if (!uniqueKeys.has(key)) {
          uniqueKeys.set(key, {
            exch: config.exchange,
            token: config.tokenNumber,
          });
        }
      }

      for (const [key, { exch, token }] of uniqueKeys) {
        await this.refreshOne(key, exch, token);
      }

      // Persist the refreshed cache onto each active config's own record
      for (const config of activeConfigs) {
        const key = `${config.exchange}|${config.tokenNumber}`;
        const entry = this.cache.get(key);
        if (!entry) continue;
        if (config.vwapValue === entry.vwap) continue; // skip no-op writes

        await this.autoStradleService.updateVwapValue(
          config._id.toString(),
          entry.vwap,
        );
      }
    } catch (error) {
      this.logger.error(`refreshVwapCache error`, error?.stack || error);
    } finally {
      this.isRunning = false;
    }
  }

  private async refreshOne(key: string, exch: string, token: string) {
    try {
      const quote = await this.marketService.getQuotes({ exch, token });

      const ap = quote?.ap !== undefined ? Number(quote.ap) : NaN;
      const lp = quote?.lp !== undefined ? Number(quote.lp) : NaN;

      if (!Number.isNaN(ap) && ap > 0) {
        this.cache.set(key, {
          vwap: ap,
          isFallback: false,
          updatedAt: Date.now(),
        });
        return;
      }

      if (!Number.isNaN(lp) && lp > 0) {
        this.logger.warn(
          `VWAP (ap) missing for ${key} — falling back to lp=${lp}`,
        );
        this.cache.set(key, {
          vwap: lp,
          isFallback: true,
          updatedAt: Date.now(),
        });
        return;
      }

      this.logger.warn(
        `VWAP (ap) and lp both missing for ${key} — keeping last cached value`,
      );
    } catch (error) {
      this.logger.error(`refreshOne(${key}) error`, error?.stack || error);
    }
  }

  /** Optional: in-memory read without a DB round trip, if anything else needs it. */
  getCachedVwap(exchange: string, token: string): number | undefined {
    return this.cache.get(`${exchange}|${token}`)?.vwap;
  }
}
