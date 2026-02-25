import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AutoStradleDataEntity } from 'src/database/entities/auto-stradle-data.entity';
import { AutoStradleStrategyController } from './auto-stradle-strategy.controller';
import { AutoStradleStrategyService } from './auto-stradle-strategy.service';
import { OrdersModule } from 'src/orders/orders.module';
import { MarketModule } from 'src/market/market.module';
import { AutoStradleRuntimeHelper } from './auto-stradle-runtime.helper';
import { AutoStradleExecutionService } from './auto-stradle-execution.service';
import { ExchangeDataModule } from '../exchange-data/exchange-data.module';
import { AutoStradleExecutionController } from './auto-stradle-execution.controller';
import { AutoStradleRMSService } from './auto-stradle-rms.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([AutoStradleDataEntity]),
    ScheduleModule.forRoot(),
    OrdersModule,
    MarketModule,
    ExchangeDataModule, // ⭐ ADD THIS
  ],
  controllers: [AutoStradleStrategyController, AutoStradleExecutionController],
  providers: [
    AutoStradleStrategyService,
    AutoStradleRuntimeHelper,
    AutoStradleExecutionService,
    AutoStradleRMSService, // ⭐ ADD THIS
  ],
  exports: [AutoStradleStrategyService, AutoStradleRuntimeHelper],
})
export class AutoStradleStrategyModule {}
