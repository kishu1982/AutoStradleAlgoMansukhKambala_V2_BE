import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { AutoStradleRMSService } from './auto-stradle-rms.service';
import { AutoSquareOffAllPositionsService } from './Auto-square-off-all-positions.service';

type SquareOffMode = 'CONFIG_ONLY' | 'ALL_POSITIONS' | 'BOTH';

@Injectable()
export class AutoSquareOffService implements OnModuleInit {
  private readonly logger = new Logger(AutoSquareOffService.name);

  private isActive = false;
  private squareOffTimes: string[] = []; // e.g. ['14:10:00', '15:25:00']
  private windowMinutes = 5; // how long each slot stays "live" after target time
  private mode: SquareOffMode = 'BOTH'; // ⭐ NEW — which square-off path(s) to run

  // tracks which (date_time) slots have fully closed (window elapsed), so we stop polling them
  private closedSlots = new Set<string>();
  private lastResetDate = '';

  constructor(
    private readonly configService: ConfigService,
    private readonly autoStradleRMSService: AutoStradleRMSService,
    private readonly autoSquareOffAllPositionsService: AutoSquareOffAllPositionsService, // ⭐ NEW
  ) {}

  onModuleInit() {
    this.isActive =
      String(
        this.configService.get('ACTIVATE_AUTO_SQUARE_OFF', 'false'),
      ).toLowerCase() === 'true';

    const rawTimes = this.configService.get(
      'AUTO_SQUARE_OFF_TIMES',
      '15:28:00',
    );

    this.squareOffTimes = String(rawTimes)
      .split(',')
      .map((t) => t.trim())
      .filter((t) => /^\d{2}:\d{2}:\d{2}$/.test(t))
      .sort();

    const rawWindow = this.configService.get(
      'AUTO_SQUARE_OFF_WINDOW_MINUTES',
      '5',
    );
    const parsedWindow = Number(rawWindow);
    this.windowMinutes =
      Number.isFinite(parsedWindow) && parsedWindow >= 0 ? parsedWindow : 5;

    // ⭐ NEW — CONFIG_ONLY | ALL_POSITIONS | BOTH (default BOTH — safest,
    // closes straddle configs via RMS ratio-close AND sweeps any other
    // open position on the account)
    const rawMode = String(
      this.configService.get('AUTO_SQUARE_OFF_MODE', 'BOTH'),
    ).toUpperCase();

    this.mode = ['CONFIG_ONLY', 'ALL_POSITIONS', 'BOTH'].includes(rawMode)
      ? (rawMode as SquareOffMode)
      : 'BOTH';

    this.logger.log(
      `AutoSquareOffService init | active=${this.isActive} | times=[${this.squareOffTimes.join(
        ', ',
      )}] | windowMinutes=${this.windowMinutes} | mode=${this.mode}`,
    );
  }

  @Interval(5000)
  async checkAutoSquareOff() {
    try {
      if (!this.isActive) return;
      if (!this.squareOffTimes.length) return;

      const { dateStr, timeStr } = this.getISTNow();

      if (this.lastResetDate !== dateStr) {
        this.closedSlots.clear();
        this.lastResetDate = dateStr;
      }

      for (const targetTime of this.squareOffTimes) {
        const slotKey = `${dateStr}_${targetTime}`;
        if (this.closedSlots.has(slotKey)) continue; // window already elapsed today

        const windowEndTime = this.addMinutes(targetTime, this.windowMinutes);

        if (timeStr < targetTime) continue; // window not started yet

        if (timeStr > windowEndTime) {
          // window just elapsed — close it and stop polling for today
          this.closedSlots.add(slotKey);
          this.logger.warn(
            `⏹ Auto square-off window closed: target=${targetTime} window=${this.windowMinutes}m (ended ${windowEndTime} IST)`,
          );
          continue;
        }

        // inside the active window — safe to call repeatedly
        await this.runSquareOffForSlot(targetTime, timeStr, windowEndTime);
      }
    } catch (error) {
      this.logger.error('checkAutoSquareOff error', error?.stack || error);
    }
  }

  // ⭐ NEW — runs whichever square-off path(s) are configured for this mode
  private async runSquareOffForSlot(
    targetTime: string,
    timeStr: string,
    windowEndTime: string,
  ) {
    const reason = `AUTO_SQUARE_OFF_${targetTime}`;

    // -----------------------------
    // 1) CONFIG-BASED (RMS) CLOSE
    // -----------------------------
    if (this.mode === 'CONFIG_ONLY' || this.mode === 'BOTH') {
      try {
        const result =
          await this.autoStradleRMSService.triggerTimeBasedSquareOff(reason);

        if (result.triggered > 0) {
          this.logger.warn(
            `⏰ [CONFIG] Auto square-off fired within window: target=${targetTime} current=${timeStr} windowEnd=${windowEndTime} (IST) | configsTriggered=${result.triggered}`,
          );
        }
      } catch (error) {
        this.logger.error(
          '[CONFIG] triggerTimeBasedSquareOff failed',
          error?.stack || error,
        );
      }
    }

    // -----------------------------
    // 2) ALL-POSITIONS SWEEP (any open position, config or not)
    // -----------------------------
    if (this.mode === 'ALL_POSITIONS' || this.mode === 'BOTH') {
      try {
        const result =
          await this.autoSquareOffAllPositionsService.closeAllOpenPositions(
            reason,
          );

        if (result.attempted > 0) {
          this.logger.warn(
            `⏰ [ALL POSITIONS] Auto square-off sweep: target=${targetTime} current=${timeStr} windowEnd=${windowEndTime} (IST) | attempted=${result.attempted} closed=${result.closed} failed=${result.failed}`,
          );
        }
      } catch (error) {
        this.logger.error(
          '[ALL POSITIONS] closeAllOpenPositions failed',
          error?.stack || error,
        );
      }
    }
  }

  // adds minutes to an HH:mm:ss string, wrapping safely across midnight
  private addMinutes(timeStr: string, minutes: number): string {
    const [h, m, s] = timeStr.split(':').map(Number);
    const totalSeconds = h * 3600 + m * 60 + s + minutes * 60;
    const wrapped = ((totalSeconds % 86400) + 86400) % 86400;
    const hh = Math.floor(wrapped / 3600);
    const mm = Math.floor((wrapped % 3600) / 60);
    const ss = wrapped % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  }

  private getISTNow(): { dateStr: string; timeStr: string } {
    const istString = new Date().toLocaleString('sv-SE', {
      timeZone: 'Asia/Kolkata',
    });
    const [dateStr, timeStr] = istString.split(' ');
    return { dateStr, timeStr };
  }
}
