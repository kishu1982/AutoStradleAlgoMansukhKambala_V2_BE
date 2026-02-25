import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseConfig } from 'src/config/database.config';
import { SubscribedSymbolEntity } from './entities/subscribed-symbol.entity';
import { SubscribedSymbolsService } from './subscribedSymbols.service';
import { DatabaseController } from './database.controller';
import { TradingViewSignalService } from './services/tradingview-signal.service';
import { TradingViewSignalEntity } from './entities/tradingview-signal.entity';
import { TradingViewSignalRepository } from './repositories/tradingview-signal.repository';
import { AutoStradleDataEntity } from './entities/auto-stradle-data.entity';
@Global()
@Module({
  imports: [
    TypeOrmModule.forRoot(databaseConfig),
    TypeOrmModule.forFeature([SubscribedSymbolEntity, TradingViewSignalEntity, AutoStradleDataEntity]),
  ],
  providers: [
    DatabaseService,
    SubscribedSymbolsService,
    TradingViewSignalRepository, // 🔴 REQUIRED
    TradingViewSignalService,
  ],
  exports: [SubscribedSymbolsService, TradingViewSignalService],
  controllers: [DatabaseController],
})
export class DatabaseModule {}
