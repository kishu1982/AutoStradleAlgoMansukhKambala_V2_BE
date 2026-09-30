import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path'; // ⭐ adjust path if different
import { AutoStradleStrategyService } from './auto-stradle-strategy.service';
import { InstrumentInfo } from './interfaces/local-instrumentInfo-interface';
import { MarketService } from 'src/market/market.service';

interface UnderlyingDef {
  name: string;
  spotExchange: string; // exchange of the spot index (as stored in config.exchange)
  spotToken: string; // token of the spot index (as stored in config.tokenNumber)
  optExchange: 'NFO' | 'BFO'; // where its options trade
  optSymbol: string; // `symbol` field in instruments.json
}

interface SyntheticResult {
  name: string;
  spot: number;
  expiry: string;
  atmStrike: number;
  callPremium: number;
  putPremium: number;
  syntheticFuture: number;
  difference: number; // syntheticFuture - spot
}

const MONTHS: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

@Injectable()
export class AutoStradleUnderlyingDiffService {
  private readonly logger = new Logger(AutoStradleUnderlyingDiffService.name);

  private readonly UNDERLYINGS: UnderlyingDef[] = [
    {
      name: 'NIFTY',
      spotExchange: 'NSE',
      spotToken: '26000',
      optExchange: 'NFO',
      optSymbol: 'NIFTY',
    },
    {
      name: 'BANKNIFTY',
      spotExchange: 'NSE',
      spotToken: '26009',
      optExchange: 'NFO',
      optSymbol: 'BANKNIFTY',
    },
    {
      name: 'SENSEX',
      spotExchange: 'BSE',
      spotToken: '1',
      optExchange: 'BFO',
      optSymbol: 'SENSEX',
    },
  ];

  // Safety: ignore a computed difference bigger than this % of spot (bad quote protection)
  private readonly MAX_ABS_DIFF_PCT_OF_SPOT = 1;

  private optionRows: InstrumentInfo[] = [];
  private instrumentsMtime = 0;
  private isRunning = false;

  private readonly instrumentsPath = path.join(
    process.cwd(),
    'data',
    'instrumentinfo',
    'instruments.json',
  );

  constructor(
    private readonly marketService: MarketService,
    private readonly strategyService: AutoStradleStrategyService,
    private readonly configService: ConfigService,
  ) {}

  // =====================================================
  // CRON — every 5 minutes
  // =====================================================
  @Cron('0 */5 * * * *')
  async scheduledRun(): Promise<void> {
    if (!this.isAutoUpdateEnabled()) return;
    if (!this.isMarketOpenIST()) return;
    await this.runOnce();
  }

  // =====================================================
  // MAIN RUN (also callable manually, e.g. from a controller for testing)
  // =====================================================
  async runOnce(): Promise<SyntheticResult[]> {
    if (this.isRunning) return [];
    this.isRunning = true;
    const results: SyntheticResult[] = [];

    try {
      this.loadInstrumentsIfChanged();
      const configs = await this.strategyService.findAll();

      for (const u of this.UNDERLYINGS) {
        try {
          const r = await this.computeForUnderlying(u);
          results.push(r);

          this.logger.log(
            `${r.name}: spot=${r.spot} expiry=${r.expiry} ATM=${r.atmStrike} ` +
              `CE=${r.callPremium} PE=${r.putPremium} synthFut=${r.syntheticFuture} diff=${r.difference}`,
          );

          const matching = configs.filter(
            (c) =>
              c.exchange === u.spotExchange &&
              String(c.tokenNumber) === u.spotToken,
          );

          for (const c of matching) {
            if (c.underlyingDifference === r.difference) continue; // no change, skip write
            await this.strategyService.updateUnderlyingDifference(
              c._id.toString(),
              r.difference,
            );
            this.logger.log(
              `Updated underlyingDifference for ${c.strategyName} (${c._id}) -> ${r.difference}`,
            );
          }
        } catch (err: any) {
          // one underlying failing must not block the others
          this.logger.error(
            `Synthetic future calc failed for ${u.name}: ${err?.message || err}`,
          );
        }
      }
    } catch (err: any) {
      this.logger.error(`runOnce error`, err?.stack || err);
    } finally {
      this.isRunning = false;
    }

    return results;
  }

  // =====================================================
  // CALC: synthetic future = ATM strike + CE premium - PE premium
  // =====================================================
  private async computeForUnderlying(
    u: UnderlyingDef,
  ): Promise<SyntheticResult> {
    // 1) spot
    const spotQuote = await this.marketService.getQuotes({
      exch: u.spotExchange,
      token: u.spotToken,
    });
    const spot = this.extractPrice(spotQuote);
    if (!spot) throw new Error(`No spot price for ${u.name}`);

    // 2) nearest expiry from local instrument data
    const rows = this.optionRows.filter(
      (i) => i.exchange === u.optExchange && i.symbol === u.optSymbol,
    );
    if (!rows.length)
      throw new Error(`No option instruments found for ${u.name}`);

    const todayIST = this.todayISTUtcMidnight();
    let nearestExpiry: string | undefined;
    let nearestTs = Infinity;
    for (const r of rows) {
      const ts = this.parseExpiry(r.expiry);
      if (ts !== null && ts >= todayIST && ts < nearestTs) {
        nearestTs = ts;
        nearestExpiry = r.expiry;
      }
    }
    if (!nearestExpiry)
      throw new Error(`No upcoming expiry found for ${u.name}`);

    // 3) strikes on that expiry that have BOTH a CE and a PE; pick closest to spot
    const byStrike = new Map<
      number,
      { ce?: InstrumentInfo; pe?: InstrumentInfo }
    >();
    for (const r of rows) {
      if (r.expiry !== nearestExpiry) continue;
      if (r.strikePrice === undefined || r.strikePrice === null) continue; // ⭐ add
      const entry = byStrike.get(r.strikePrice) ?? {};
      if (r.optionType === 'CE') entry.ce = r;
      if (r.optionType === 'PE') entry.pe = r;
      byStrike.set(r.strikePrice, entry);
    }

    let atmStrike: number | undefined;
    let best = Infinity;
    for (const [strike, e] of byStrike) {
      if (!e.ce || !e.pe) continue;
      const d = Math.abs(strike - spot);
      if (d < best) {
        best = d;
        atmStrike = strike;
      }
    }
    if (atmStrike === undefined)
      throw new Error(`No ATM CE/PE pair for ${u.name}`);

    const { ce, pe } = byStrike.get(atmStrike)!;

    // 4) premiums via getQuotes (in parallel)
    const [ceQuote, peQuote] = await Promise.all([
      this.marketService.getQuotes({ exch: u.optExchange, token: ce!.token }),
      this.marketService.getQuotes({ exch: u.optExchange, token: pe!.token }),
    ]);
    const callPremium = this.extractPrice(ceQuote);
    const putPremium = this.extractPrice(peQuote);
    if (!callPremium || !putPremium) {
      throw new Error(`Missing CE/PE premium for ${u.name} @ ${atmStrike}`);
    }

    // 5) synthetic future & difference vs spot
    const syntheticFuture = atmStrike + callPremium - putPremium;
    const difference = Math.round((syntheticFuture - spot) * 100) / 100;

    if (Math.abs(difference) > spot * (this.MAX_ABS_DIFF_PCT_OF_SPOT / 100)) {
      throw new Error(
        `Difference ${difference} exceeds ${this.MAX_ABS_DIFF_PCT_OF_SPOT}% of spot ${spot} — ignored as suspicious`,
      );
    }

    return {
      name: u.name,
      spot,
      expiry: nearestExpiry,
      atmStrike,
      callPremium,
      putPremium,
      syntheticFuture: Math.round(syntheticFuture * 100) / 100,
      difference,
    };
  }

  // =====================================================
  // HELPERS
  // =====================================================
  private isAutoUpdateEnabled(): boolean {
    const raw = this.configService.get<string>(
      'AUTO_UPDATE_UNDERLYING_DIFFERENCE',
      'false',
    );
    return String(raw).trim().toLowerCase() === 'true';
  }

  /** Mon–Fri, 09:16–15:30 IST (server timezone independent) */
  private isMarketOpenIST(): boolean {
    const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const day = ist.getUTCDay();
    if (day === 0 || day === 6) return false;
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return mins >= 9 * 60 + 16 && mins <= 15 * 60 + 30;
  }

  private todayISTUtcMidnight(): number {
    const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  }

  /** "29-OCT-2026" -> UTC-midnight timestamp */
  private parseExpiry(s?: string): number | null {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec((s || '').trim());
    if (!m) return null;
    const mon = MONTHS[m[2].toUpperCase()];
    if (mon === undefined) return null;
    return Date.UTC(Number(m[3]), mon, Number(m[1]));
  }

  /** lp if valid, else mid of best bid/ask */
  private extractPrice(q: any): number | undefined {
    const lp = Number(q?.lp);
    if (lp > 0) return lp;
    const bid = Number(q?.bp1);
    const ask = Number(q?.sp1);
    if (bid > 0 && ask > 0) return (bid + ask) / 2;
    return undefined;
  }

  /** Reload instruments.json only when the file changed (it's refreshed daily) */
  private loadInstrumentsIfChanged(): void {
    const stat = fs.statSync(this.instrumentsPath);
    if (stat.mtimeMs === this.instrumentsMtime && this.optionRows.length)
      return;

    const all: InstrumentInfo[] = JSON.parse(
      fs.readFileSync(this.instrumentsPath, 'utf-8'),
    );
    const symbols = new Set(this.UNDERLYINGS.map((u) => u.optSymbol));

    // keep only what we need, to save memory
    this.optionRows = all.filter(
      (i) =>
        (i.exchange === 'NFO' || i.exchange === 'BFO') &&
        i.instrument === 'OPTIDX' &&
        (i.optionType === 'CE' || i.optionType === 'PE') &&
        symbols.has(i.symbol),
    );
    this.instrumentsMtime = stat.mtimeMs;
    this.logger.log(
      `Loaded ${this.optionRows.length} option rows for synthetic calc`,
    );
  }
}
