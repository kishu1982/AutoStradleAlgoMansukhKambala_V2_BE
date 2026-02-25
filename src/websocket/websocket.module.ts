import { Module } from '@nestjs/common';
import { WebsocketService } from './websocket.service';
import { TokenModule } from 'src/token/token.module';
import { StrategyModule } from 'src/strategy/strategy.module';
import { AutoStradleStrategyModule } from 'src/strategy/auto-stradle-strategy';
import { ExchangeDataModule } from 'src/strategy/exchange-data/exchange-data.module';

@Module({
  imports: [
    TokenModule,
    StrategyModule,
    AutoStradleStrategyModule, // 🔴 REQUIRED (used by WebsocketService)
    ExchangeDataModule, // 🔴 REQUIRED (used by WebsocketService)
    
  ],
  providers: [WebsocketService],
  exports: [WebsocketService],
})
export class WebsocketModule {}
