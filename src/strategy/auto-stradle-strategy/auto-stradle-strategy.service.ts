import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MongoRepository } from 'typeorm';
import { ObjectId } from 'mongodb';
import { AutoStradleDataEntity } from 'src/database/entities/auto-stradle-data.entity';
import { CreateAutoStradleStrategyDto } from './dto/create-auto-stradle-strategy.dto';
import { UpdateAutoStradleStrategyDto } from './dto/UpdateAutoStradleStrategyDto';

@Injectable()
export class AutoStradleStrategyService {
  private readonly logger = new Logger(AutoStradleStrategyService.name);

  constructor(
    @InjectRepository(AutoStradleDataEntity)
    private readonly autoStradleRepo: MongoRepository<AutoStradleDataEntity>,
  ) {}

  /**
   * Create a new AutoStradleStrategy configuration
   * Validates unique constraint on tokenNumber + exchange + symbolName + side
   * Validates that legsData length matches legs count
   */
  async create(
    dto: CreateAutoStradleStrategyDto,
  ): Promise<AutoStradleDataEntity> {
    this.logger.log(
      `[CREATE] Starting creation of AutoStradleStrategy: strategyName=${dto.strategyName}, token=${dto.tokenNumber}, exchange=${dto.exchange}, symbol=${dto.symbolName}, side=${dto.side}, legs=${dto.legs}`,
    );

    try {
      // Validate that legs array length matches legs count
      this.validateLegsCount(dto.legs, dto.legsData.length);
      // this.logger.debug(
      //   `[CREATE] Legs count validation passed: expected=${dto.legs}, received=${dto.legsData.length}`,
      // );

      // Check for duplicate main signal (unique constraint on tokenNumber + exchange + symbolName + side)
      // this.logger.debug(
      //   `[CREATE] Checking for duplicate configuration with tokenNumber=${dto.tokenNumber}, exchange=${dto.exchange}, symbolName=${dto.symbolName}, side=${dto.side}`,
      // );

      const existing = await this.autoStradleRepo.findOne({
        where: {
          tokenNumber: dto.tokenNumber,
          exchange: dto.exchange,
          symbolName: dto.symbolName,
          side: dto.side,
        },
      });

      if (existing) {
        this.logger.warn(
          `[CREATE] Duplicate configuration detected: tokenNumber=${dto.tokenNumber}, exchange=${dto.exchange}, symbolName=${dto.symbolName}, side=${dto.side}, existingId=${existing._id}`,
        );
        throw new BadRequestException(
          `AutoStradleStrategy configuration already exists for tokenNumber: ${dto.tokenNumber}, exchange: ${dto.exchange}, symbolName: ${dto.symbolName}, side: ${dto.side}`,
        );
      }

      this.logger.debug(
        `[CREATE] No duplicate found. Proceeding with creation.`,
      );

      // Create new entity from DTO
      const newConfig = this.autoStradleRepo.create({
        strategyName: dto.strategyName.toUpperCase(),
        tokenNumber: dto.tokenNumber,
        exchange: dto.exchange,
        symbolName: dto.symbolName,
        quantityLots: dto.quantityLots,
        side: dto.side,
        productType: dto.productType,
        legs: dto.legs,
        legsData: dto.legsData,
        amountForLotCalEachLeg: dto.amountForLotCalEachLeg,
        profitBookingPercentage: dto.profitBookingPercentage,
        stoplossBookingPercentage: dto.stoplossBookingPercentage,
        otmDifference: dto.otmDifference,
        status: dto.status || 'ACTIVE',
        ceAmountMultiplier: dto.ceAmountMultiplier ?? 1,
        peAmountMultiplier: dto.peAmountMultiplier ?? 1,
        exitRatio: dto.exitRatio ?? 1.75,
      });

      const savedConfig = await this.autoStradleRepo.save(newConfig);
      this.logger.log(
        `[CREATE] ✅ AutoStradleStrategy configuration created successfully: id=${savedConfig._id}, strategyName=${savedConfig.strategyName}`,
      );

      return savedConfig;
    } catch (error) {
      this.logger.error(
        `[CREATE] ❌ Error creating AutoStradleStrategy configuration: strategyName=${dto.strategyName}, error=${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get all AutoStradleStrategy configurations
   */
  async findAll(): Promise<AutoStradleDataEntity[]> {
    this.logger.log(
      `[FIND_ALL] Fetching all AutoStradleStrategy configurations`,
    );

    try {
      const configs = await this.autoStradleRepo.find();
      this.logger.log(
        `[FIND_ALL] ✅ Successfully retrieved ${configs.length} AutoStradleStrategy configurations`,
      );
      return configs;
    } catch (error) {
      this.logger.error(
        `[FIND_ALL] ❌ Error fetching all AutoStradleStrategy configurations: error=${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get AutoStradleStrategy configuration by ID
   */
  async findById(id: string): Promise<AutoStradleDataEntity> {
    // this.logger.debug(
    //   `[FIND_BY_ID] Searching for AutoStradleStrategy configuration with ID: ${id}`,
    // );

    try {
      if (!ObjectId.isValid(id)) {
        this.logger.warn(`[FIND_BY_ID] Invalid ObjectId format: ${id}`);
        throw new BadRequestException(`Invalid ID format: ${id}`);
      }

      // this.logger.debug(
      //   `[FIND_BY_ID] Valid ObjectId format verified for ID: ${id}`,
      // );

      const config = await this.autoStradleRepo.findOne({
        where: { _id: new ObjectId(id) },
      });

      if (!config) {
        this.logger.warn(`[FIND_BY_ID] Configuration not found with ID: ${id}`);
        throw new NotFoundException(
          `AutoStradleStrategy configuration not found with ID: ${id}`,
        );
      }

      // this.logger.debug(
      //   `[FIND_BY_ID] ✅ AutoStradleStrategy configuration found: id=${config._id}, strategyName=${config.strategyName}`,
      // );
      return config;
    } catch (error) {
      this.logger.error(
        `[FIND_BY_ID] ❌ Error finding configuration with ID ${id}: error=${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Get active AutoStradleStrategy configurations
   */
  async findActive(): Promise<AutoStradleDataEntity[]> {
    // this.logger.log(
    //   `[FIND_ACTIVE] Fetching all active AutoStradleStrategy configurations (status=ACTIVE)`,
    // );

    try {
      const activeConfigs = await this.autoStradleRepo.find({
        where: { status: 'ACTIVE' },
      });

      // this.logger.log(
      //   `[FIND_ACTIVE] ✅ Successfully retrieved ${activeConfigs.length} active AutoStradleStrategy configurations`,
      // );
      return activeConfigs;
    } catch (error) {
      this.logger.error(
        `[FIND_ACTIVE] ❌ Error fetching active AutoStradleStrategy configurations: error=${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Update AutoStradleStrategy configuration by ID
   * Validates legs count if legsData is being updated
   */
  async update(
    id: string,
    dto: UpdateAutoStradleStrategyDto,
    source: 'API' | 'CRON' = 'API', // ⭐ NEW — default 'API' so controller calls need no change
  ): Promise<AutoStradleDataEntity> {
    // ⭐ NEW — cron writers back off entirely if an API update is in flight
    if (source === 'CRON' && this.isConfigLocked(id)) {
      this.logger.debug(
        `[UPDATE] Skipped CRON update for ID ${id} — locked by a recent API update`,
      );
      return this.findById(id);
    }

    // ⭐ NEW — API updates claim the lock for the duration of this call
    if (source === 'API') {
      this.lockConfig(id, this.API_LOCK_DURATION_MS);
    }

    const MAX_RETRIES = 2;
    let attempt = 0;
    // let latestConfig: AutoStradleDataEntity;
    let latestConfig: AutoStradleDataEntity = await this.findById(id); // ✅ initialized here
    let verified = false;

    try {
      // Compute once — same across all retries, since these are exactly the
      // fields the caller wants force-updated
      const providedFields = this.getProvidedFields(dto);
      const providedKeys = Object.keys(providedFields);

      if (providedKeys.length === 0) {
        this.logger.warn(
          `[UPDATE] No updatable fields provided in payload for ID: ${id}`,
        );
        return this.findById(id);
      }

      this.logger.log(
        `[UPDATE] Fields to force-update for ID ${id}: ${providedKeys.join(', ')}`,
      );

      // legsData/legs must be consistent with each other ONLY if either is provided
      if (providedFields.legsData || providedFields.legs !== undefined) {
        const current = await this.findById(id);
        const effectiveLegs =
          providedFields.legs !== undefined
            ? providedFields.legs
            : current.legs;
        const effectiveLegsData = providedFields.legsData ?? current.legsData;
        this.validateLegsCount(effectiveLegs, effectiveLegsData.length);
      }

      while (attempt < MAX_RETRIES && !verified) {
        attempt++;
        this.logger.log(
          `[UPDATE] Attempt ${attempt}/${MAX_RETRIES} for ID: ${id}`,
        );

        // Always fetch fresh — a cron job may have written since our last read
        const config = await this.findById(id);

        // ⭐ NEW: if legsData was provided, merge structural fields onto the
        // CURRENT DB leg data, preserving cron-owned computed fields
        let effectiveProvidedFields = providedFields;
        if (providedFields.legsData) {
          effectiveProvidedFields = {
            ...providedFields,
            legsData: this.mergeLegsData(
              providedFields.legsData,
              config.legsData,
            ),
          };
        }

        // Duplicate main-signal check — only if any of those fields were sent,
        // and only meaningful on the first attempt
        if (attempt === 1) {
          const mainSignalKeys = [
            'tokenNumber',
            'exchange',
            'symbolName',
            'side',
          ] as const;
          const mainSignalTouched = mainSignalKeys.some(
            (k) => providedFields[k] !== undefined,
          );

          if (mainSignalTouched) {
            const targetTokenNumber =
              providedFields.tokenNumber ?? config.tokenNumber;
            const targetExchange = providedFields.exchange ?? config.exchange;
            const targetSymbolName =
              providedFields.symbolName ?? config.symbolName;
            const targetSide = providedFields.side ?? config.side;

            const existing = await this.autoStradleRepo.findOne({
              where: {
                tokenNumber: targetTokenNumber,
                exchange: targetExchange,
                symbolName: targetSymbolName,
                side: targetSide,
              },
            });

            if (existing && existing._id.toString() !== id) {
              this.logger.warn(
                `[UPDATE] Duplicate main signal detected: existingId=${existing._id}, targetId=${id}`,
              );
              throw new BadRequestException(
                `Another AutoStradleStrategy configuration already exists for tokenNumber: ${targetTokenNumber}, exchange: ${targetExchange}, symbolName: ${targetSymbolName}, side: ${targetSide}`,
              );
            }
          }
        }

        // Force-apply ONLY the provided fields — everything else on `config`
        // stays exactly as it was read from DB (including whatever cron jobs
        // may have written a moment ago)
        for (const key of providedKeys) {
          (config as any)[key] = providedFields[key];
        }

        const result = await this.autoStradleRepo.save(config);
        const savedConfig = Array.isArray(result) ? result[0] : result;

        // Don't trust the save() return value alone — re-read from DB to be sure
        const verifyConfig = await this.findById(id);
        latestConfig = verifyConfig;

        // Only verify the fields we actually intended to change — comparing
        // the whole document would false-fail if a cron job touched an
        // unrelated field (e.g. ltp) between our save and this read
        // verified = providedKeys.every((key) =>
        //   this.isDeepEqual((verifyConfig as any)[key], providedFields[key]),
        // );

        // Verify against the MERGED expected values, not the raw incoming
        // payload — the merge is intentional, so comparing against the raw
        // computed fields would always mismatch
        verified = providedKeys.every((key) =>
          this.isDeepEqual(
            (verifyConfig as any)[key],
            effectiveProvidedFields[key],
          ),
        );

        if (verified) {
          this.logger.log(
            `[UPDATE] ✅ Verified update persisted on attempt ${attempt} for ID: ${id}`,
          );
          break;
        }

        this.logger.warn(
          `[UPDATE] ⚠️ Update not verified on attempt ${attempt} for ID: ${id}, retrying...`,
        );

        if (attempt < MAX_RETRIES) {
          await this.sleep(150 * attempt); // 150ms, 300ms, 450ms backoff
        }
      }

      if (!verified) {
        this.logger.error(
          `[UPDATE] ❌ Update NOT verified after ${MAX_RETRIES} attempts for ID: ${id}. Returning latest DB state anyway.`,
        );
      }

      return latestConfig;
    } catch (error) {
      this.logger.error(
        `[UPDATE] ❌ Error updating AutoStradleStrategy configuration with ID ${id}: error=${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
  // old with old dto type
  // async update(
  //   id: string,
  //   dto: CreateAutoStradleStrategyDto,
  // ): Promise<AutoStradleDataEntity> {
  //   // this.logger.debug(
  //   //   `[UPDATE] Starting update of AutoStradleStrategy with ID: ${id}`,
  //   // );

  //   try {
  //     // Get existing config
  //     // this.logger.debug(
  //     //   `[UPDATE] Fetching existing configuration with ID: ${id}`,
  //     // );
  //     const config = await this.findById(id);
  //     // this.logger.debug(
  //     //   `[UPDATE] Existing configuration found: strategyName=${config.strategyName}`,
  //     // );

  //     // Validate legs count if legsData is provided
  //     if (dto.legsData) {
  //       // this.logger.debug(
  //       //   `[UPDATE] Validating legs count: expected=${dto.legs}, received=${dto.legsData.length}`,
  //       // );
  //       this.validateLegsCount(dto.legs, dto.legsData.length);
  //       // this.logger.debug(`[UPDATE] Legs count validation passed`);
  //     }

  //     // Check for duplicate main signal (only if main signal fields are being changed)
  //     const isMainSignalChanged =
  //       dto.tokenNumber !== config.tokenNumber ||
  //       dto.exchange !== config.exchange ||
  //       dto.symbolName !== config.symbolName ||
  //       dto.side !== config.side;

  //     if (isMainSignalChanged) {
  //       // this.logger.debug(
  //       //   `[UPDATE] Main signal fields changed. Checking for duplicates: tokenNumber=${dto.tokenNumber}, exchange=${dto.exchange}, symbolName=${dto.symbolName}, side=${dto.side}`,
  //       // );

  //       const existing = await this.autoStradleRepo.findOne({
  //         where: {
  //           tokenNumber: dto.tokenNumber,
  //           exchange: dto.exchange,
  //           symbolName: dto.symbolName,
  //           side: dto.side,
  //         },
  //       });

  //       if (existing && existing._id.toString() !== id) {
  //         this.logger.warn(
  //           `[UPDATE] Duplicate main signal detected during update: existingId=${existing._id}, targetId=${id}`,
  //         );
  //         throw new BadRequestException(
  //           `Another AutoStradleStrategy configuration already exists for tokenNumber: ${dto.tokenNumber}, exchange: ${dto.exchange}, symbolName: ${dto.symbolName}, side: ${dto.side}`,
  //         );
  //       }
  //       // this.logger.debug(`[UPDATE] No duplicate found for new main signal`);
  //     } else {
  //       this.logger.debug(`[UPDATE] No changes to main signal fields`);
  //     }

  //     // Update entity
  //     // this.logger.debug(`[UPDATE] Updating configuration fields`);
  //     config.strategyName = dto.strategyName;
  //     config.tokenNumber = dto.tokenNumber;
  //     config.exchange = dto.exchange;
  //     config.symbolName = dto.symbolName.toUpperCase();
  //     config.quantityLots = dto.quantityLots;
  //     config.side = dto.side;
  //     config.productType = dto.productType;
  //     config.legs = dto.legs;
  //     config.legsData = dto.legsData;
  //     config.amountForLotCalEachLeg = dto.amountForLotCalEachLeg;
  //     config.profitBookingPercentage = dto.profitBookingPercentage;
  //     config.stoplossBookingPercentage = dto.stoplossBookingPercentage;
  //     config.otmDifference = dto.otmDifference;
  //     config.status = dto.status || config.status;
  //     // ⭐ ADD THIS LINE
  //     config.ltp = dto.ltp ?? config.ltp;
  //     // adding new data of amount multipliers and exit ratio
  //     config.ceAmountMultiplier =
  //       dto.ceAmountMultiplier ?? config.ceAmountMultiplier ?? 1;
  //     config.peAmountMultiplier =
  //       dto.peAmountMultiplier ?? config.peAmountMultiplier ?? 1;
  //     config.exitRatio = dto.exitRatio ?? config.exitRatio ?? 1.75;

  //     const result = await this.autoStradleRepo.save(config);

  //     // Handle both single entity and array return types
  //     const updatedConfig = Array.isArray(result) ? result[0] : result;

  //     // this.logger.debug(
  //     //   `[UPDATE] ✅ AutoStradleStrategy configuration updated successfully: id=${updatedConfig._id}, strategyName=${updatedConfig.strategyName}`,
  //     // );
  //     return updatedConfig;
  //   } catch (error) {
  //     this.logger.error(
  //       `[UPDATE] ❌ Error updating AutoStradleStrategy configuration with ID ${id}: error=${error.message}`,
  //       error.stack,
  //     );
  //     throw error;
  //   }
  // }

  /**
   * Delete AutoStradleStrategy configuration by ID
   */
  async delete(id: string): Promise<{ message: string; deletedId: string }> {
    this.logger.log(
      `[DELETE] Starting deletion of AutoStradleStrategy configuration with ID: ${id}`,
    );

    try {
      // this.logger.debug(`[DELETE] Fetching configuration with ID: ${id}`);
      const config = await this.findById(id);
      // this.logger.debug(
      //   `[DELETE] Configuration found: strategyName=${config.strategyName}`,
      // );

      // this.logger.debug(`[DELETE] Removing configuration from database`);
      await this.autoStradleRepo.remove(config);

      this.logger.log(
        `[DELETE] ✅ AutoStradleStrategy configuration deleted successfully: id=${id}, strategyName=${config.strategyName}`,
      );

      return {
        message: 'AutoStradleStrategy configuration deleted successfully',
        deletedId: id,
      };
    } catch (error) {
      this.logger.error(
        `[DELETE] ❌ Error deleting AutoStradleStrategy configuration with ID ${id}: error=${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Fetch all unique token numbers from main and legs
   * Prepares a unique list for websocket subscription
   * Format: EXCH|TOKEN
   */
  async getSubscriptionsList(): Promise<string[]> {
    try {
      const configs = await this.autoStradleRepo.find();
      const subscriptions = new Set<string>();

      configs.forEach((config) => {
        // ===============================
        // 1️⃣ MAIN TOKEN
        // ===============================
        if (config.exchange && config.tokenNumber) {
          subscriptions.add(`${config.exchange}|${config.tokenNumber}`);
        }

        // ===============================
        // 2️⃣ LEG TOKENS
        // ===============================
        if (config.legsData && Array.isArray(config.legsData)) {
          config.legsData.forEach((leg) => {
            if (leg.exch && leg.tokenNumber && leg.tokenNumber !== null) {
              subscriptions.add(`${leg.exch}|${leg.tokenNumber}`);
            }
          });
        }
      });

      const list = Array.from(subscriptions);

      return list;
    } catch (error) {
      this.logger.error(
        `[GET_SUBSCRIPTIONS] Error generating list`,
        error?.stack || error,
      );
      return [];
    }
  }

  /**
   * Private helper method to validate legs count
   * Ensures that the provided legsData array length matches the legs count
   */
  private validateLegsCount(legsCount: number, legsDataLength: number): void {
    // this.logger.debug(
    //   `[VALIDATE_LEGS] Validating legs count: expected=${legsCount}, received=${legsDataLength}`,
    // );

    if (legsDataLength !== legsCount) {
      this.logger.warn(
        `[VALIDATE_LEGS] Legs count mismatch: expected=${legsCount}, received=${legsDataLength}`,
      );
      throw new BadRequestException(
        `Invalid legs configuration. Expected ${legsCount} legs, but received ${legsDataLength}. The legsData array length must match the legs count.`,
      );
    }

    // this.logger.debug(`[VALIDATE_LEGS] Legs count validation passed`);
  }

  /**
   * Deep equality check (handles nested objects/arrays like legsData)
   */
  private isDeepEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;
    if (typeof a !== 'object') return a === b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      return a.every((item, idx) => this.isDeepEqual(item, b[idx]));
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => this.isDeepEqual(a[key], b[key]));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * List of fields eligible for update via the API.
   * Keep this in sync with CreateAutoStradleStrategyDto's field names.
   */
  private readonly UPDATABLE_FIELDS = [
    'strategyName',
    'tokenNumber',
    'exchange',
    'symbolName',
    'quantityLots',
    'side',
    'productType',
    'legs',
    'legsData',
    'amountForLotCalEachLeg',
    'profitBookingPercentage',
    'stoplossBookingPercentage',
    'otmDifference',
    'status',
    'ltp',
    'ceAmountMultiplier',
    'peAmountMultiplier',
    'exitRatio',
  ] as const;

  /**
   * Returns only the fields that were actually present (non-undefined) in the
   * incoming payload. This is what makes the update "partial" — anything not
   * sent is simply not in this object, so it never touches the DB record.
   */
  private getProvidedFields(
    dto: UpdateAutoStradleStrategyDto,
  ): Partial<Record<(typeof this.UPDATABLE_FIELDS)[number], any>> {
    const provided: Record<string, any> = {};
    for (const field of this.UPDATABLE_FIELDS) {
      if (dto[field] !== undefined) {
        provided[field] =
          field === 'symbolName' ? dto[field].toUpperCase() : dto[field];
      }
    }
    return provided;
  }

  /**
   * Builds the field values we expect to see in DB after applying this update.
   * Fields explicitly sent in the DTO always win (force update).
   * Fields not sent fall back to whatever the current DB state has (so cron-owned
   * fields like ltp/status that weren't part of this request aren't fought over).
   */
  private buildExpectedValues(
    dto: CreateAutoStradleStrategyDto,
    current: AutoStradleDataEntity,
  ) {
    return {
      strategyName: dto.strategyName,
      tokenNumber: dto.tokenNumber,
      exchange: dto.exchange,
      symbolName: dto.symbolName.toUpperCase(),
      quantityLots: dto.quantityLots,
      side: dto.side,
      productType: dto.productType,
      legs: dto.legs,
      legsData: dto.legsData,
      amountForLotCalEachLeg: dto.amountForLotCalEachLeg,
      profitBookingPercentage: dto.profitBookingPercentage,
      stoplossBookingPercentage: dto.stoplossBookingPercentage,
      otmDifference: dto.otmDifference,
      status: dto.status || current.status,
      ltp: dto.ltp ?? current.ltp,
      ceAmountMultiplier:
        dto.ceAmountMultiplier ?? current.ceAmountMultiplier ?? 1,
      peAmountMultiplier:
        dto.peAmountMultiplier ?? current.peAmountMultiplier ?? 1,
      exitRatio: dto.exitRatio ?? current.exitRatio ?? 1.75,
    };
  }
  /**
   * Fields inside each leg that are live-computed by the tick-driven cron
   * (AutoStradleRuntimeHelper) and must NEVER be settable via this API —
   * regardless of what a stale frontend payload echoes back.
   */
  private readonly LEG_COMPUTED_FIELDS = [
    'tokenNumber',
    'tradingSymbol',
    'legLtp',
    'quantityLots',
    'ratio',
  ] as const;

  /**
   * Merges an incoming legsData array onto the CURRENT (fresh) DB legsData.
   * Structural fields (exch/instrument/optionType/expiry/side) come from the
   * incoming payload — the user can edit these. Computed fields always come
   * from the current DB record — the cron owns these exclusively.
   *
   * Matches legs by index; assumes leg order/count is stable (already
   * enforced elsewhere via validateLegsCount).
   */
  private mergeLegsData(incomingLegs: any[], currentLegs: any[]): any[] {
    return incomingLegs.map((incomingLeg, idx) => {
      const currentLeg = currentLegs?.[idx] || {};
      const merged: any = { ...incomingLeg };

      for (const field of this.LEG_COMPUTED_FIELDS) {
        merged[field] = currentLeg[field] ?? null;
      }

      return merged;
    });
  }

  /**
   * Per-config lock: while a config's ID is present here with a future
   * unlockAt timestamp, cron-originated writes (source === 'CRON') are
   * skipped for that config. This gives explicit API updates a clear
   * window to persist without racing the tick-driven cron.
   */
  private readonly configLocks = new Map<string, number>(); // id -> unlockAt (ms epoch)

  private readonly API_LOCK_DURATION_MS = 1000; // block cron writes for 1s after an API update starts

  private isConfigLocked(id: string): boolean {
    const unlockAt = this.configLocks.get(id);
    if (unlockAt === undefined) return false;
    if (Date.now() >= unlockAt) {
      this.configLocks.delete(id); // expired — clean up
      return false;
    }
    return true;
  }

  private lockConfig(id: string, durationMs: number): void {
    this.configLocks.set(id, Date.now() + durationMs);
  }

  private unlockConfig(id: string): void {
    this.configLocks.delete(id);
  }
}
