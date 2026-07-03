/*
=====================================================================
AUTO SQUARE OFF — FLOW
=====================================================================

  onModuleInit()
       ↓
  Read ACTIVATE_AUTO_SQUARE_OFF from .env
       ↓
  Read AUTO_SQUARE_OFF_TIMES (comma separated HH:mm:ss, IST)
       ↓
  Parse + validate + store in squareOffTimes[]

  ---------------------------------------------------------------

  @Interval(5000)  →  checkAutoSquareOff()   (runs every 5 sec)
       ↓
  isActive === false ?
       ↓ NO                          ↓ YES
  Get current IST date + time     STOP (do nothing)
       ↓
  New IST calendar day ?
       ↓ YES
  Clear triggeredSlots (reset for the day)
       ↓
  Loop through each configured time in squareOffTimes[]
       ↓
  slotKey = date_time  →  already triggered today?
       ↓ YES                         ↓ NO
     skip                    currentTime >= targetTime ?
                                      ↓ NO         ↓ YES
                                    skip      mark slot as triggered
                                                    ↓
                                    autoStradleRMSService
                                       .triggerTimeBasedSquareOff()
                                                    ↓
                              Loop all activeConfigs in RMS service
                                                    ↓
                              exitStatus already EXITING/EXITED ?
                                      ↓ YES              ↓ NO
                                    skip config    Check open positions
                                                          ↓
                                                   any leg qty != 0 ?
                                                      ↓ NO      ↓ YES
                                                    skip     squareOffConfig()
                                                                  ↓
                                                          (existing RMS exit lock
                                                           + executeRatioClose flow)
                                                                  ↓
                                                          config.exitStatus = EXITED

  ---------------------------------------------------------------
  NOTE: Uses the SAME exitLocks + exitStatus guard as ratio /
  underlying / PnL exits — so time-based exit can never run
  concurrently with another exit trigger on the same config.
=====================================================================
*/

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { AutoStradleRMSService } from './auto-stradle-rms.service';

@Injectable()
export class AutoSquareOffService implements OnModuleInit {
  private readonly logger = new Logger(AutoSquareOffService.name);

  private isActive = false;
  private squareOffTimes: string[] = []; // e.g. ['14:10:00', '15:25:00']

  // tracks which (date_time) slots already fired, so we don't re-trigger every 5s
  private triggeredSlots = new Set<string>();
  private lastResetDate = '';

  constructor(
    private readonly configService: ConfigService,
    private readonly autoStradleRMSService: AutoStradleRMSService,
  ) {}

  onModuleInit() {
    this.isActive =
      String(
        this.configService.get('ACTIVATE_AUTO_SQUARE_OFF', 'false'),
      ).toLowerCase() === 'true';

    const rawTimes = this.configService.get(
      'AUTO_SQUARE_OFF_TIMES',
      '15:29:00',
    );

    //string rawtime "15:25:00"
    // split ["15:25:00"]
    // filter map // ["15:25:00"]
    // filter // passes regex, stays
    // sort  // still ["15:25:00"]

    this.squareOffTimes = String(rawTimes)
      .split(',')
      .map((t) => t.trim())
      .filter((t) => /^\d{2}:\d{2}:\d{2}$/.test(t))
      .sort(); // sorted asc, not strictly required but tidy in logs

    this.logger.log(
      `AutoSquareOffService init | active=${this.isActive} | times=[${this.squareOffTimes.join(', ')}]`,
    );
  }

  // Poll every 5s — same cadence as your index refresher.
  @Interval(5000)
  async checkAutoSquareOff() {
    try {
      if (!this.isActive) return;
      if (!this.squareOffTimes.length) return;

      const { dateStr, timeStr } = this.getISTNow();

      // reset the "already triggered" tracker on a new IST day
      if (this.lastResetDate !== dateStr) {
        this.triggeredSlots.clear();
        this.lastResetDate = dateStr;
      }

      for (const targetTime of this.squareOffTimes) {
        const slotKey = `${dateStr}_${targetTime}`;

        if (this.triggeredSlots.has(slotKey)) continue; // already handled today
        if (timeStr < targetTime) continue; // not reached yet

        // mark BEFORE awaiting, so overlapping ticks can't double-fire
        this.triggeredSlots.add(slotKey);

        this.logger.warn(
          `⏰ Auto square-off time reached: target=${targetTime} current=${timeStr} (IST)`,
        );

        const result =
          await this.autoStradleRMSService.triggerTimeBasedSquareOff(
            `AUTO_SQUARE_OFF_${targetTime}`,
          );

        this.logger.warn(
          `Auto square-off slot ${targetTime} done | configsTriggered=${result.triggered}`,
        );
      }
    } catch (error) {
      this.logger.error('checkAutoSquareOff error', error?.stack || error);
    }
  }

  private getISTNow(): { dateStr: string; timeStr: string } {
    // sv-SE locale gives 'YYYY-MM-DD HH:mm:ss' — same trick you already use elsewhere
    const istString = new Date().toLocaleString('sv-SE', {
      timeZone: 'Asia/Kolkata',
    });
    const [dateStr, timeStr] = istString.split(' ');
    return { dateStr, timeStr };
  }
}
