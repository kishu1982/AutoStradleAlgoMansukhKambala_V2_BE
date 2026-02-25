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
    dto: CreateAutoStradleStrategyDto,
  ): Promise<AutoStradleDataEntity> {
    // this.logger.debug(
    //   `[UPDATE] Starting update of AutoStradleStrategy with ID: ${id}`,
    // );

    try {
      // Get existing config
      // this.logger.debug(
      //   `[UPDATE] Fetching existing configuration with ID: ${id}`,
      // );
      const config = await this.findById(id);
      // this.logger.debug(
      //   `[UPDATE] Existing configuration found: strategyName=${config.strategyName}`,
      // );

      // Validate legs count if legsData is provided
      if (dto.legsData) {
        // this.logger.debug(
        //   `[UPDATE] Validating legs count: expected=${dto.legs}, received=${dto.legsData.length}`,
        // );
        this.validateLegsCount(dto.legs, dto.legsData.length);
        // this.logger.debug(`[UPDATE] Legs count validation passed`);
      }

      // Check for duplicate main signal (only if main signal fields are being changed)
      const isMainSignalChanged =
        dto.tokenNumber !== config.tokenNumber ||
        dto.exchange !== config.exchange ||
        dto.symbolName !== config.symbolName ||
        dto.side !== config.side;

      if (isMainSignalChanged) {
        // this.logger.debug(
        //   `[UPDATE] Main signal fields changed. Checking for duplicates: tokenNumber=${dto.tokenNumber}, exchange=${dto.exchange}, symbolName=${dto.symbolName}, side=${dto.side}`,
        // );

        const existing = await this.autoStradleRepo.findOne({
          where: {
            tokenNumber: dto.tokenNumber,
            exchange: dto.exchange,
            symbolName: dto.symbolName,
            side: dto.side,
          },
        });

        if (existing && existing._id.toString() !== id) {
          this.logger.warn(
            `[UPDATE] Duplicate main signal detected during update: existingId=${existing._id}, targetId=${id}`,
          );
          throw new BadRequestException(
            `Another AutoStradleStrategy configuration already exists for tokenNumber: ${dto.tokenNumber}, exchange: ${dto.exchange}, symbolName: ${dto.symbolName}, side: ${dto.side}`,
          );
        }
        // this.logger.debug(`[UPDATE] No duplicate found for new main signal`);
      } else {
        this.logger.debug(`[UPDATE] No changes to main signal fields`);
      }

      // Update entity
      // this.logger.debug(`[UPDATE] Updating configuration fields`);
      config.strategyName = dto.strategyName;
      config.tokenNumber = dto.tokenNumber;
      config.exchange = dto.exchange;
      config.symbolName = dto.symbolName.toUpperCase();
      config.quantityLots = dto.quantityLots;
      config.side = dto.side;
      config.productType = dto.productType;
      config.legs = dto.legs;
      config.legsData = dto.legsData;
      config.amountForLotCalEachLeg = dto.amountForLotCalEachLeg;
      config.profitBookingPercentage = dto.profitBookingPercentage;
      config.stoplossBookingPercentage = dto.stoplossBookingPercentage;
      config.otmDifference = dto.otmDifference;
      config.status = dto.status || config.status;
      // ⭐ ADD THIS LINE
      config.ltp = dto.ltp ?? config.ltp;

      const result = await this.autoStradleRepo.save(config);

      // Handle both single entity and array return types
      const updatedConfig = Array.isArray(result) ? result[0] : result;

      // this.logger.debug(
      //   `[UPDATE] ✅ AutoStradleStrategy configuration updated successfully: id=${updatedConfig._id}, strategyName=${updatedConfig.strategyName}`,
      // );
      return updatedConfig;
    } catch (error) {
      this.logger.error(
        `[UPDATE] ❌ Error updating AutoStradleStrategy configuration with ID ${id}: error=${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

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
}
