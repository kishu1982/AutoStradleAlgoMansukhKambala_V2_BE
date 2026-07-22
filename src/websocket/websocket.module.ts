import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { WebsocketService } from './websocket.service';
import { TokenModule } from 'src/token/token.module';
import { StrategyModule } from 'src/strategy/strategy.module';
import { AutoStradleStrategyModule } from 'src/strategy/auto-stradle-strategy';
import { ExchangeDataModule } from 'src/strategy/exchange-data/exchange-data.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(), // safe to call again,
    TokenModule,
    StrategyModule,
    AutoStradleStrategyModule, // 🔴 REQUIRED (used by WebsocketService)
    ExchangeDataModule, // 🔴 REQUIRED (used by WebsocketService)
  ],
  providers: [WebsocketService],
  exports: [WebsocketService],
})
export class WebsocketModule {}
