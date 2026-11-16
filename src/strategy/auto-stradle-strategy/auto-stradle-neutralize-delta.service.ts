import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AutoStradleStrategyService } from './auto-stradle-strategy.service';
import { AutoStradleExecutionService } from './auto-stradle-execution.service';
import { ExchangeDataService } from '../exchange-data/exchange-data.service';
import { MarketService } from 'src/market/market.service';
import { AutoStradleDataEntity } from 'src/database/entities/auto-stradle-data.entity';

interface RunningLeg {
  leg: any;
  netQty: number;
  lotSize: number;
  ltp: number;
  bid?: number;
  ask?: number;
  invested: number; // |netqty| * ltp
}

@Injectable()
export class AutoStradleNeutralizeDeltaService {
  private readonly logger = new Logger(AutoStradleNeutralizeDeltaService.name);

  private isRunning = false;
  private lastCheckAt = new Map<string, number>(); // configId -> ms
  private lastOrderAt = new Map<string, number>(); // configId -> ms
  private readonly MIN_GAP_AFTER_ORDER_MS = 5000; // let positions refresh before re-evaluating

  constructor(
    private readonly strategyService: AutoStradleStrategyService,
    private readonly executionService: AutoStradleExecutionService,
    private readonly exchangeDataService: ExchangeDataService,
    private readonly marketService: MarketService,
    private readonly configService: ConfigService,
  ) {}

  // ticks every second; each config is throttled by its own interval
  @Cron(CronExpression.EVERY_SECOND)
  async scheduledRun(): Promise<void> {
    if (this.isRunning) return;
    if (!this.isGloballyEnabled()) return;
    if (!this.isMarketOpenIST()) return;

    this.isRunning = true;
    try {
      const configs = await this.strategyService.findActive();
      for (const config of configs) {
        if (!config.neutralizeDeltaEnabled) continue;

        const id = config._id.toString();
        const intervalMs = (config.neutralizeCheckIntervalSec ?? 10) * 1000;
        if (Date.now() - (this.lastCheckAt.get(id) ?? 0) < intervalMs) continue;
        this.lastCheckAt.set(id, Date.now());

        await this.processConfig(config);
      }
    } catch (err: any) {
      this.logger.error('scheduledRun error', err?.stack || err);
    } finally {
      this.isRunning = false;
    }
  }

  private async processConfig(config: AutoStradleDataEntity): Promise<void> {
    const id = config._id.toString();

    // don't fight an entry order that is still being built
    if (this.executionService.isExecutionRunning(config)) return;
    if (
      Date.now() - (this.lastOrderAt.get(id) ?? 0) <
      this.MIN_GAP_AFTER_ORDER_MS
    )
      return;

    // 1) running legs + live values
    const running = await this.getRunningLegs(config);
    if (!running || running.length < 2) return; // both legs must be open

    const [a, b] = running;
    const weak = a.invested <= b.invested ? a : b;
    const strong = weak === a ? b : a;
    if (strong.invested <= 0) return;

    // 2) live ratio (<= 1)
    const ratio = weak.invested / strong.invested;

    // 3) trigger check
    const triggerValue = config.neutralizeTriggerRatio ?? 0.91;
    const direction = config.neutralizeTriggerDirection ?? 'BELOW';
    const triggered =
      direction === 'BELOW' ? ratio < triggerValue : ratio > triggerValue;

    this.logger.debug(
      `[ND ${config.strategyName}] ratio=${ratio.toFixed(3)} (${direction} ${triggerValue}) ` +
        `weak=${weak.leg.tradingSymbol}:${weak.invested.toFixed(0)} strong=${strong.leg.tradingSymbol}:${strong.invested.toFixed(0)}`,
    );
    if (!triggered) return;

    // 4) quantity = lot size (from net position) * lots per trade
    const lots = config.neutralizeLotsPerTrade ?? 1;
    const qty = weak.lotSize * lots;
    if (qty <= 0) return;

    // 5) max live investment guard (total of both legs + this order)
    const maxInvest = config.neutralizeMaxInvestment ?? 150000;
    const totalInvested = weak.invested + strong.invested;
    const projected = totalInvested + qty * weak.ltp;
    if (projected > maxInvest) {
      this.logger.warn(
        `[ND ${config.strategyName}] max investment reached: total=${totalInvested.toFixed(0)} ` +
          `projected=${projected.toFixed(0)} max=${maxInvest} - skipping`,
      );
      return;
    }

    // 6) one IOC order, same symbol / exchange / side as the running weak leg
    const remarks = `NEUTRALIZED DELTA r=${ratio.toFixed(3)} ${direction} ${triggerValue}`;
    this.logger.warn(
      `[ND ${config.strategyName}] placing ${weak.leg.side} ${qty} ${weak.leg.tradingSymbol} | ${remarks} ` +
        `| bid=${weak.bid} ask=${weak.ask} ltp=${weak.ltp} total=${totalInvested.toFixed(0)}`,
    );

    this.lastOrderAt.set(id, Date.now());
    const res = await this.executionService.placeSingleLegIoc(
      config,
      weak.leg,
      qty,
      remarks,
    );
    this.logger.debug(
      `[ND ${config.strategyName}] order response: ${JSON.stringify(res)}`,
    );
  }

  // =====================================================
  // Running legs data: netqty + live quote -> invested value
  // (swap this method if you prefer reading the trade JSON)
  // =====================================================
  private async getRunningLegs(
    config: AutoStradleDataEntity,
  ): Promise<RunningLeg[] | null> {
    try {
      const positions = await this.exchangeDataService.getNetPositions();
      if (!Array.isArray(positions)) return null;

      const result: RunningLeg[] = [];

      for (const leg of config.legsData || []) {
        if (!leg.tokenNumber || !leg.exch) return null;

        const pos = positions.find(
          (p: any) =>
            String(p.token ?? '').trim() === String(leg.tokenNumber).trim() &&
            String(p.raw?.exch ?? '')
              .trim()
              .toUpperCase() === String(leg.exch).trim().toUpperCase(),
        );
        const netQty = Number(pos?.raw?.netqty ?? 0);
        if (!pos || netQty === 0) return null; // leg not running -> nothing to neutralize

        // direction sanity: SELL leg must be net short, BUY leg net long
        if (
          (leg.side === 'SELL' && netQty > 0) ||
          (leg.side === 'BUY' && netQty < 0)
        ) {
          this.logger.warn(
            `[ND] ${leg.tradingSymbol} position direction != config side, skipping`,
          );
          return null;
        }

        const quote = await this.marketService.getQuotes({
          exch: leg.exch,
          token: leg.tokenNumber,
        });
        const ltp = Number(quote?.lp);
        if (!quote || quote.stat !== 'Ok' || !(ltp > 0)) return null;

        const lotSize =
          Number(pos.raw?.ls) ||
          this.executionService.getLotSizeFor(leg.tokenNumber, leg.exch);

        result.push({
          leg,
          netQty,
          lotSize,
          ltp,
          bid: Number(quote.bp1) || undefined,
          ask: Number(quote.sp1) || undefined,
          invested: Math.abs(netQty) * ltp,
        });
      }
      return result;
    } catch (err: any) {
      this.logger.error('getRunningLegs error', err?.stack || err);
      return null;
    }
  }

  // global kill switch from .env
  private isGloballyEnabled(): boolean {
    return (
      String(this.configService.get('AUTO_NEUTRALIZE_DELTA', 'false'))
        .trim()
        .toLowerCase() === 'true'
    );
  }

  /** Mon-Fri, 09:16-15:30 IST */
  private isMarketOpenIST(): boolean {
    const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const day = ist.getUTCDay();
    if (day === 0 || day === 6) return false;
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return mins >= 9 * 60 + 16 && mins <= 15 * 60 + 30;
  }
}
