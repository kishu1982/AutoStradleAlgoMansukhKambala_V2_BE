import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AutoStradleStrategyService } from './auto-stradle-strategy.service';
import { AutoStradleExecutionService } from './auto-stradle-execution.service';
import { ExchangeDataService } from '../exchange-data/exchange-data.service';
import { AutoStradleDataEntity } from 'src/database/entities/auto-stradle-data.entity';

interface RunningLeg {
  leg: any;
  lotSize: number;
  livePrice: number;
  liveValue: number;
  valueRatio: number; // from the RMS json
}

@Injectable()
export class AutoStradleNeutralizeDeltaService {
  private readonly logger = new Logger(AutoStradleNeutralizeDeltaService.name);

  private isRunning = false;
  private lastCheckAt = new Map<string, number>();
  private lastOrderAt = new Map<string, number>();
  private readonly MIN_GAP_AFTER_ORDER_MS = 8000; // JSON must refresh after a fill
  private readonly MAX_JSON_AGE_MS = 20000; // ignore stale RMS data

  constructor(
    private readonly strategyService: AutoStradleStrategyService,
    private readonly executionService: AutoStradleExecutionService,
    private readonly exchangeDataService: ExchangeDataService,
    private readonly configService: ConfigService,
  ) {}

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

  // condition with weaker leg side
  // private async processConfig(config: AutoStradleDataEntity): Promise<void> {
  //   const id = config._id.toString();
  //   const tag = `[ND ${config.strategyName}]`;

  //   if (this.executionService.isExecutionRunning(config)) {
  //     this.logger.debug(`${tag} skip: entry execution still running`);
  //     return;
  //   }
  //   if (
  //     Date.now() - (this.lastOrderAt.get(id) ?? 0) <
  //     this.MIN_GAP_AFTER_ORDER_MS
  //   ) {
  //     this.logger.debug(`${tag} skip: waiting after last neutralize order`);
  //     return;
  //   }

  //   // 1) running legs from RMS json
  //   const running = await this.getRunningLegsFromJson(config, tag);
  //   if (!running) return; // reason already logged

  //   const [a, b] = running;
  //   const weak = a.liveValue <= b.liveValue ? a : b;
  //   const strong = weak === a ? b : a;
  //   if (strong.liveValue <= 0) {
  //     this.logger.debug(`${tag} skip: strong leg liveValue <= 0`);
  //     return;
  //   }

  //   // 2) live ratio (<= 1) == smaller valueRatio in json
  //   const ratio = weak.liveValue / strong.liveValue;

  //   // 3) trigger
  //   const triggerValue = config.neutralizeTriggerRatio ?? 0.91;
  //   const direction = config.neutralizeTriggerDirection ?? 'BELOW';
  //   const triggered =
  //     direction === 'BELOW' ? ratio < triggerValue : ratio > triggerValue;

  //   this.logger.debug(
  //     `${tag} ratio=${ratio.toFixed(3)} (${direction} ${triggerValue}) triggered=${triggered} ` +
  //       `weak=${weak.leg.tradingSymbol}:${weak.liveValue.toFixed(0)} strong=${strong.leg.tradingSymbol}:${strong.liveValue.toFixed(0)}`,
  //   );
  //   if (!triggered) return;

  //   // 4) qty = lot size * lots per trade
  //   const lots = config.neutralizeLotsPerTrade ?? 1;
  //   const qty = weak.lotSize * lots;
  //   if (qty <= 0) {
  //     this.logger.warn(
  //       `${tag} skip: qty<=0 (lotSize=${weak.lotSize}, lots=${lots})`,
  //     );
  //     return;
  //   }

  //   // 5) max live investment guard
  //   // const maxInvest = config.neutralizeMaxInvestment ?? 150000;
  //   // const totalLive = weak.liveValue + strong.liveValue;
  //   // const projected = totalLive + qty * weak.livePrice;
  //   // if (projected > maxInvest) {
  //   //   this.logger.warn(
  //   //     `${tag} TRIGGERED but max investment reached: live=${totalLive.toFixed(0)} ` +
  //   //       `projected=${projected.toFixed(0)} max=${maxInvest} - skipping`,
  //   //   );
  //   //   return;
  //   // }
  //   // 5) max live investment guard - per leg (only the leg being added to)
  //   const maxInvest = config.neutralizeMaxInvestment ?? 150000;
  //   const legLive = weak.liveValue;
  //   const projectedLeg = legLive + qty * weak.livePrice;
  //   if (projectedLeg > maxInvest) {
  //     this.logger.warn(
  //       `${tag} TRIGGERED but leg cap reached on ${weak.leg.tradingSymbol}: ` +
  //         `legLive=${legLive.toFixed(0)} projected=${projectedLeg.toFixed(0)} max=${maxInvest} - skipping`,
  //     );
  //     return;
  //   }

  //   // 6) one IOC order on the weak leg (same symbol / exchange / side)
  //   const remarks = `NEUTRALIZED DELTA r=${ratio.toFixed(3)} ${direction} ${triggerValue}`;
  //   // this.logger.warn(
  //   //   `${tag} placing ${weak.leg.side} ${qty} ${weak.leg.tradingSymbol} | ${remarks} | ` +
  //   //     `livePrice=${weak.livePrice} totalLive=${totalLive.toFixed(0)}`,
  //   // );
  //   this.logger.warn(
  //     `${tag} placing ${weak.leg.side} ${qty} ${weak.leg.tradingSymbol} | ${remarks} | ` +
  //       `livePrice=${weak.livePrice} legLive=${legLive.toFixed(0)}`,
  //   );

  //   this.lastOrderAt.set(id, Date.now());
  //   const res = await this.executionService.placeSingleLegIoc(
  //     config,
  //     weak.leg,
  //     qty,
  //     remarks,
  //   );
  //   this.logger.debug(`${tag} order response: ${JSON.stringify(res)}`);
  // }

  // conditions with stronger leg side.
  private async processConfig(config: AutoStradleDataEntity): Promise<void> {
    const id = config._id.toString();
    const tag = `[ND ${config.strategyName}]`;

    if (this.executionService.isExecutionRunning(config)) {
      this.logger.debug(`${tag} skip: entry execution still running`);
      return;
    }
    if (
      Date.now() - (this.lastOrderAt.get(id) ?? 0) <
      this.MIN_GAP_AFTER_ORDER_MS
    ) {
      this.logger.debug(`${tag} skip: waiting after last neutralize order`);
      return;
    }

    // 1) running legs from RMS json
    const running = await this.getRunningLegsFromJson(config, tag);
    if (!running) return; // reason already logged

    const [a, b] = running;
    if (a.liveValue <= 0 || b.liveValue <= 0) {
      this.logger.debug(`${tag} skip: a leg liveValue <= 0`);
      return;
    }

    // 2) per-leg live ratio = this leg liveValue / other leg liveValue
    //    (same as "valueRatio" in the json)
    // const ratioA = a.liveValue / b.liveValue;
    // const ratioB = b.liveValue / a.liveValue;
    // use the json valueRatio when present, fall back to our own calculation
    const ratioA = a.valueRatio > 0 ? a.valueRatio : a.liveValue / b.liveValue;
    const ratioB = b.valueRatio > 0 ? b.valueRatio : b.liveValue / a.liveValue;

    // 3) trigger: find the leg whose own ratio satisfies the condition
    const triggerValue = config.neutralizeTriggerRatio ?? 0.91;
    const direction = config.neutralizeTriggerDirection ?? 'BELOW';
    const isHit = (r: number) =>
      direction === 'BELOW' ? r < triggerValue : r > triggerValue;

    // this.logger.debug(
    //   `${tag} ${a.leg.tradingSymbol} ratio=${ratioA.toFixed(3)} | ` +
    //     `${b.leg.tradingSymbol} ratio=${ratioB.toFixed(3)} | ${direction} ${triggerValue}`,
    // );
    this.logger.warn(
      `${tag} ${a.leg.tradingSymbol} ratio=${ratioA.toFixed(3)} | ` +
        `${b.leg.tradingSymbol} ratio=${ratioB.toFixed(3)} | ${direction} ${triggerValue}`,
    );

    const candidates = [
      { rl: a, ratio: ratioA },
      { rl: b, ratio: ratioB },
    ].filter((c) => isHit(c.ratio));

    if (!candidates.length) return; // not triggered

    // if both legs ever qualify (e.g. ABOVE with trigger < 1), take the most extreme
    candidates.sort((x, y) =>
      direction === 'BELOW' ? x.ratio - y.ratio : y.ratio - x.ratio,
    );
    const target = candidates[0].rl;
    const ratio = candidates[0].ratio;

    // 4) qty = lot size * lots per trade
    const lots = config.neutralizeLotsPerTrade ?? 1;
    const qty = target.lotSize * lots;
    if (qty <= 0) {
      this.logger.warn(
        `${tag} skip: qty<=0 (lotSize=${target.lotSize}, lots=${lots})`,
      );
      return;
    }

    // 5) max live investment guard - per leg (only the leg being added to)
    const maxInvest = config.neutralizeMaxInvestment ?? 150000;
    const legLive = target.liveValue;
    const projectedLeg = legLive + qty * target.livePrice;
    if (projectedLeg > maxInvest) {
      this.logger.warn(
        `${tag} TRIGGERED but leg cap reached on ${target.leg.tradingSymbol}: ` +
          `legLive=${legLive.toFixed(0)} projected=${projectedLeg.toFixed(0)} max=${maxInvest} - skipping`,
      );
      return;
    }

    // 6) one IOC order on the triggered leg (same symbol / exchange / side)
    const remarks = `NEUTRALIZED DELTA r=${ratio.toFixed(3)} ${direction} ${triggerValue}`;
    this.logger.warn(
      `${tag} placing ${target.leg.side} ${qty} ${target.leg.tradingSymbol} | ${remarks} | ` +
        `livePrice=${target.livePrice} legLive=${legLive.toFixed(0)}`,
    );

    this.lastOrderAt.set(id, Date.now());
    // const res = await this.executionService.placeSingleLegIoc(
    //   config,
    //   target.leg,
    //   qty,
    //   remarks,
    // );
    // this.logger.debug(`${tag} order response: ${JSON.stringify(res)}`);
    const res: any = await this.executionService.placeSingleLegIoc(
      config,
      target.leg,
      qty,
      remarks,
    );
    if (!res || (res.stat && res.stat !== 'Ok')) {
      this.logger.error(`${tag} order NOT accepted: ${JSON.stringify(res)}`);
    } else {
      this.logger.warn(`${tag} order accepted: ${JSON.stringify(res)}`);
    }
  }
  // =====================================================
  // Read running legs from the RMS trade json (data/AutoStradleTrade)
  // =====================================================
  private async getRunningLegsFromJson(
    config: AutoStradleDataEntity,
    tag: string,
  ): Promise<RunningLeg[] | null> {
    try {
      const res = await this.executionService.getActiveTradeData();
      if (!res?.success || !Array.isArray(res.data)) {
        this.logger.debug(`${tag} skip: no trade json found`);
        return null;
      }

      const id = config._id.toString();
      const entry = res.data.find((f: any) => String(f.data?._id) === id);
      const tradeJson = entry?.data;
      if (!tradeJson) {
        this.logger.debug(`${tag} skip: no trade json for this config`);
        return null;
      }

      // staleness guard
      const updatedStr = tradeJson.underlyingDayRange?.lastUpdatedIST;
      const updatedMs = updatedStr ? new Date(updatedStr).getTime() : NaN;
      if (
        !Number.isNaN(updatedMs) &&
        Date.now() - updatedMs > this.MAX_JSON_AGE_MS
      ) {
        this.logger.warn(
          `${tag} skip: trade json stale (${Math.round((Date.now() - updatedMs) / 1000)}s old)`,
        );
        return null;
      }

      const legs = tradeJson.legsData;
      if (!Array.isArray(legs) || legs.length < 2) {
        this.logger.debug(`${tag} skip: json has <2 legs`);
        return null;
      }

      const result: RunningLeg[] = [];
      for (const leg of legs) {
        const openQty = Math.abs(Number(leg.openNetQty ?? 0));
        const liveValue = Number(leg.liveValue);
        const livePrice = Number(leg.livePrice);

        if (!(openQty > 0)) {
          this.logger.debug(
            `${tag} skip: ${leg.tradingSymbol} not open (openNetQty=${leg.openNetQty})`,
          );
          return null;
        }
        if (!(liveValue > 0) || !(livePrice > 0)) {
          this.logger.debug(
            `${tag} skip: ${leg.tradingSymbol} liveValue/livePrice missing`,
          );
          return null;
        }

        result.push({
          leg,
          lotSize: await this.resolveLotSize(leg),
          livePrice,
          liveValue,
          valueRatio: Number(leg.valueRatio),
        });
      }
      return result;
    } catch (err: any) {
      this.logger.error(
        `${tag} getRunningLegsFromJson error`,
        err?.stack || err,
      );
      return null;
    }
  }

  // lot size: instruments map first, then net position "ls"
  private async resolveLotSize(leg: any): Promise<number> {
    const fromMap = this.executionService.getLotSizeFor(
      leg.tokenNumber,
      leg.exch,
    );
    if (fromMap > 1) return fromMap;

    try {
      const positions = await this.exchangeDataService.getNetPositions();
      const pos = Array.isArray(positions)
        ? positions.find(
            (p: any) =>
              String(p.token ?? '').trim() === String(leg.tokenNumber).trim() &&
              String(p.raw?.exch ?? '')
                .trim()
                .toUpperCase() === String(leg.exch).trim().toUpperCase(),
          )
        : undefined;
      return Number(pos?.raw?.ls) || fromMap;
    } catch {
      return fromMap;
    }
  }

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
