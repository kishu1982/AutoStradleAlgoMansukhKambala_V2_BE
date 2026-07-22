// import { Module } from '@nestjs/common';
// import { MarketDataOutGateway } from './market-data-out.gateway';

// @Module({
//   providers: [MarketDataOutGateway],
// })
// export class MarketDataOutModule {}

import { Module } from '@nestjs/common';
import { MarketDataOutGateway } from './market-data-out.gateway';
import { EventEmitterModule } from '@nestjs/event-emitter';

@Module({
  imports: [EventEmitterModule], // 👈 try this, no .forRoot()
  providers: [MarketDataOutGateway],
})
export class MarketDataOutModule {}
