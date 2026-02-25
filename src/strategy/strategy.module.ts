import { Module } from '@nestjs/common';
import { StrategyService } from './strategy.service';
import { DatabaseModule } from 'src/database/database.module';
import { MarketModule } from 'src/market/market.module';
import { OrdersModule } from 'src/orders/orders.module';
import { AutoStradleStrategyModule } from './auto-stradle-strategy/auto-stradle-strategy.module';
import { ExchangeDataModule } from './exchange-data/exchange-data.module';

@Module({
  imports: [DatabaseModule, MarketModule, OrdersModule, AutoStradleStrategyModule, ExchangeDataModule, ExchangeDataModule],
  controllers: [],
  providers: [StrategyService,  ], // 🔴 REQUIRED],
  exports: [StrategyService], // 👈 IMPORTANT (used by WebSocket module)
})
export class StrategyModule {}
