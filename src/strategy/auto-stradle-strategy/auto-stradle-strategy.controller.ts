import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { AutoStradleStrategyService } from './auto-stradle-strategy.service';
import { CreateAutoStradleStrategyDto } from './dto/create-auto-stradle-strategy.dto';
import { AutoStradleDataEntity } from 'src/database/entities/auto-stradle-data.entity';

@Controller('strategy/auto-stradle')
@UsePipes(
  new ValidationPipe({
    transform: true,
    skipMissingProperties: false,
  }),
)
export class AutoStradleStrategyController {
  constructor(private readonly autoStradleStrategyService: AutoStradleStrategyService) {}

  /**
   * POST /strategy/auto-stradle
   * Create a new AutoStradleStrategy configuration
   */
  @Post()
  async create(@Body() dto: CreateAutoStradleStrategyDto): Promise<AutoStradleDataEntity> {
    return this.autoStradleStrategyService.create(dto);
  }

  /**
   * GET /strategy/auto-stradle
   * Get all AutoStradleStrategy configurations
   */
  @Get()
  async findAll(): Promise<AutoStradleDataEntity[]> {
    return this.autoStradleStrategyService.findAll();
  }

  /**
   * GET /strategy/auto-stradle/active
   * Get all active AutoStradleStrategy configurations
   */
  @Get('active')
  async findActive(): Promise<AutoStradleDataEntity[]> {
    return this.autoStradleStrategyService.findActive();
  }

  /**
   * GET /strategy/auto-stradle/subscriptions
   * Get a unique list of token numbers for WebSocket subscriptions
   * Format: EXCH|TOKEN
   */
  @Get('subscriptions')
  async getSubscriptions(): Promise<string[]> {
    return this.autoStradleStrategyService.getSubscriptionsList();
  }

  /**
   * GET /strategy/auto-stradle/:id
   * Get AutoStradleStrategy configuration by ID
   */
  @Get(':id')
  async findById(@Param('id') id: string): Promise<AutoStradleDataEntity> {
    return this.autoStradleStrategyService.findById(id);
  }

  /**
   * PUT /strategy/auto-stradle/:id
   * Update AutoStradleStrategy configuration by ID
   */
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: CreateAutoStradleStrategyDto,
  ): Promise<AutoStradleDataEntity> {
    return this.autoStradleStrategyService.update(id, dto);
  }

  /**
   * DELETE /strategy/auto-stradle/:id
   * Delete AutoStradleStrategy configuration by ID
   */
  @Delete(':id')
  async delete(@Param('id') id: string): Promise<{ message: string; deletedId: string }> {
    return this.autoStradleStrategyService.delete(id);
  }
}
