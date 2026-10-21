import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';

type Resource = 'orders' | 'trades' | 'netpositions';

@Injectable()
export class ExchangeLocalStoreHelper {
  private readonly logger = new Logger(ExchangeLocalStoreHelper.name);

  private readonly baseDir: string;
  private readonly clientCode: string;
  private readonly filterEnabled: boolean;

  // one write lock per file: read-modify-write must never interleave
  private locks: Record<Resource, Promise<unknown>> = {
    orders: Promise.resolve(),
    trades: Promise.resolve(),
    netpositions: Promise.resolve(),
  };

  // for net positions creation
  private lastNetPosJson = '';

  constructor(private readonly configService: ConfigService) {
    this.baseDir =
      this.configService.get<string>('EXCHANGE_DATA_DIR') ||
      path.join(process.cwd(), 'data', 'exchangeData');

    this.clientCode = (
      this.configService.get<string>('NOREN_CLIENT_ID') || ''
    ).trim();

    const flag = String(
      this.configService.get<string>('EXCHANGE_ACCOUNT_FILTER') ?? 'true',
    ).toLowerCase();

    this.filterEnabled = flag === 'true' && !!this.clientCode;

    if (flag === 'true' && !this.clientCode) {
      this.logger.warn(
        'EXCHANGE_ACCOUNT_FILTER is on but NOREN_CLIENT_ID is empty. Filter disabled.',
      );
    }
    this.logger.log(
      `Local store: dir=${this.baseDir}, filter=${this.filterEnabled ? this.clientCode : 'OFF'}`,
    );
  }

  // --------------------------------
  // PUBLIC INFO
  // --------------------------------

  isFilterEnabled() {
    return this.filterEnabled;
  }

  getClientCode() {
    return this.clientCode;
  }

  todayIST(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
    }).format(new Date()); // YYYY-MM-DD
  }

  // --------------------------------
  // ORDERS
  // --------------------------------

  readOrders(): Promise<any[]> {
    return this.read('orders');
  }

  /**
   * Takes the raw broker order book, keeps only our orders
   * (ui_dev_code === NOREN_CLIENT_ID when filter is on), and adds only the
   * norenordno values not already stored. Existing records are never touched.
   * Returns how many new orders were added.
   */
  async mergeOrders(rawOrders: any[]): Promise<number> {
    if (!Array.isArray(rawOrders) || !rawOrders.length) return 0;

    const candidates = this.filterEnabled
      ? rawOrders.filter((o) => o?.ui_dev_code === this.clientCode)
      : rawOrders;

    if (!candidates.length) return 0;

    return this.withLock('orders', async () => {
      const existing = await this.read('orders');
      const known = new Set(existing.map((o) => o.norenordno));
      const today = this.todayIST();

      const fresh: any[] = [];
      for (const o of candidates) {
        if (!o?.norenordno || known.has(o.norenordno)) continue;
        known.add(o.norenordno);
        fresh.push({
          norenordno: o.norenordno,
          exchordid: o.exchordid,
          tradeDate: today,
          raw: o,
        });
      }

      if (!fresh.length) return 0;

      // newest first, same order the broker returns them
      await this.write('orders', [...fresh, ...existing]);
      return fresh.length;
    });
  }

  // --------------------------------
  // DAILY CLEANUP (drops records whose tradeDate is not today IST)
  // --------------------------------

  async cleanupStale(resources: Resource[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    const today = this.todayIST();

    for (const r of resources) {
      result[r] = await this.withLock(r, async () => {
        const data = await this.read(r);
        const kept = data.filter((d) => d?.tradeDate === today);
        if (kept.length !== data.length) await this.write(r, kept);
        return data.length - kept.length;
      });
    }
    return result;
  }

  // --------------------------------
  // FULL RESET (called once on app start)
  // --------------------------------

  async resetAll(): Promise<void> {
    const resources: Resource[] = ['orders', 'trades', 'netpositions'];

    for (const r of resources) {
      await this.withLock(r, async () => {
        for (const f of [this.filePath(r), `${this.filePath(r)}.tmp`]) {
          try {
            await fs.unlink(f);
          } catch (err: any) {
            if (err?.code !== 'ENOENT') {
              this.logger.error(`reset ${r} failed`, err?.stack || err);
            }
          }
        }
      });
      this.lastNetPosJson = ''; // just to sync to null
    }

    this.logger.log(
      `Local exchange data cleared. Filter=${this.filterEnabled ? this.clientCode : 'OFF'}`,
    );
  }

  // --------------------------------
  // LOW LEVEL
  // --------------------------------

  private filePath(resource: Resource) {
    return path.join(this.baseDir, `${resource}.json`);
  }

  private async read(resource: Resource): Promise<any[]> {
    try {
      const txt = await fs.readFile(this.filePath(resource), 'utf8');
      const parsed = JSON.parse(txt);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        this.logger.error(`read ${resource} failed`, err?.stack || err);
      }
      return [];
    }
  }

  // atomic write: tmp file then rename, so a crash never leaves half a file
  private async write(resource: Resource, data: any[]) {
    await fs.mkdir(this.baseDir, { recursive: true });
    const file = this.filePath(resource);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, file);
  }

  private withLock<T>(resource: Resource, fn: () => Promise<T>): Promise<T> {
    const run = this.locks[resource].then(fn);
    this.locks[resource] = run.catch(() => undefined);
    return run;
  }
  //-----------------------------------------------------------------------
  // --------------------------------
  // TRADES
  // --------------------------------

  readTrades(): Promise<any[]> {
    return this.read('trades');
  }

  /**
   * Keeps only trades whose norenordno exists in the saved orders file,
   * then adds the ones not already stored. Unique key = norenordno + flid
   * (one order can fill in several parts). Returns the raw trades newly added.
   */
  async mergeTrades(rawTrades: any[]): Promise<any[]> {
    if (!Array.isArray(rawTrades) || !rawTrades.length) return [];

    const orders = await this.read('orders');
    const orderNos = new Set(orders.map((o) => o.norenordno));

    const candidates = rawTrades.filter(
      (t) => t?.norenordno && orderNos.has(t.norenordno),
    );
    if (!candidates.length) return [];

    const keyOf = (t: any) => `${t.norenordno}|${t.flid ?? t.exchordid ?? ''}`;

    return this.withLock('trades', async () => {
      const existing = await this.read('trades');
      const known = new Set(existing.map((d) => keyOf(d.raw ?? d)));
      const today = this.todayIST();

      const freshDocs: any[] = [];
      const freshRaw: any[] = [];

      for (const t of candidates) {
        const k = keyOf(t);
        if (known.has(k)) continue;
        known.add(k);
        freshRaw.push(t);
        freshDocs.push({
          norenordno: t.norenordno,
          exchordid: t.exchordid,
          tradeDate: today,
          raw: t,
        });
      }

      if (!freshDocs.length) return [];

      // newest first, same order the broker returns them
      await this.write('trades', [...freshDocs, ...existing]);
      return freshRaw;
    });
  }

  // --------------------------------
  // NET POSITIONS
  // --------------------------------

  readNetPositions(): Promise<any[]> {
    return this.read('netpositions');
  }

  /**
   * brokerDocs = [{ token, tsym, raw }] exactly as received from the broker.
   * Filter off -> saved as is.
   * Filter on  -> broker row kept, 7 fields recalculated from saved trades.
   * Skips the disk write when nothing changed since the last save.
   */
  async saveNetPositions(brokerDocs: any[]): Promise<void> {
    const docs = this.filterEnabled
      ? await this.buildFilteredNetPositions(brokerDocs)
      : (brokerDocs ?? []);

    const json = JSON.stringify(docs);

    await this.withLock('netpositions', async () => {
      if (json === this.lastNetPosJson) return;
      await this.write('netpositions', docs);
      this.lastNetPosJson = json;
    });
  }

  private posKey(r: any) {
    return `${r?.exch}|${r?.token}|${r?.prd}`;
  }

  private async buildFilteredNetPositions(brokerDocs: any[]): Promise<any[]> {
    const trades = await this.read('trades');
    if (!trades.length || !Array.isArray(brokerDocs) || !brokerDocs.length) {
      return [];
    }

    // 1) aggregate saved trades per position
    const agg = new Map<
      string,
      { buyQty: number; sellQty: number; buyAmt: number; sellAmt: number }
    >();

    for (const t of trades) {
      const r = t.raw ?? t;
      const qty = Number(r.flqty ?? r.fillshares ?? r.qty ?? 0);
      const price = Number(r.flprc ?? r.avgprc ?? r.prc ?? 0);
      if (!qty) continue;

      const key = this.posKey(r);
      let a = agg.get(key);
      if (!a) {
        a = { buyQty: 0, sellQty: 0, buyAmt: 0, sellAmt: 0 };
        agg.set(key, a);
      }

      if (r.trantype === 'B') {
        a.buyQty += qty;
        a.buyAmt += qty * price;
      } else if (r.trantype === 'S') {
        a.sellQty += qty;
        a.sellAmt += qty * price;
      }
    }

    // 2) keep the broker row, replace only the 7 calculated fields
    const out: any[] = [];

    for (const doc of brokerDocs) {
      const base = doc?.raw ?? {};
      const a = agg.get(this.posKey(base));
      if (!a) continue;

      const buyAvg = a.buyQty ? a.buyAmt / a.buyQty : 0;
      const sellAvg = a.sellQty ? a.sellAmt / a.sellQty : 0;
      const netQty = a.buyQty - a.sellQty;
      const netAvg = netQty > 0 ? buyAvg : netQty < 0 ? sellAvg : 0;
      const matched = Math.min(a.buyQty, a.sellQty);
      const rpnl = matched * (sellAvg - buyAvg);

      out.push({
        token: doc.token,
        tsym: doc.tsym,
        raw: {
          ...base,
          netqty: String(netQty),
          netavgprc: netAvg.toFixed(2),
          totbuyamt: a.buyAmt.toFixed(2),
          totsellamt: a.sellAmt.toFixed(2),
          totbuyavgprc: buyAvg.toFixed(2),
          totsellavgprc: sellAvg.toFixed(2),
          rpnl: rpnl.toFixed(2),
        },
      });
    }

    return out;
  }
}
