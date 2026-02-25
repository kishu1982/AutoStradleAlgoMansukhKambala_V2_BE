import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TradingViewSignalService } from 'src/database/services/tradingview-signal.service';

@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);

  constructor(
    private readonly tradingViewSignalService: TradingViewSignalService,
  ) {}

  // to get data from webhook . pass it to trading view service also save it to database
  //🔁 Webhook → Service → Config → Final Trades

  /**
   * Called for every tick coming from WebSocket
   */
  onTick(tickData: any): void {
    // Raw tick logging
    //his.logger.log(`Tick Received: ${JSON.stringify(tickData)}`);
    // tickData.tk==='49229' && tickData.lp>0? this.logger.log(`Tick Received: ${JSON.stringify(tickData.lp)}`):"";
    // tickData.lp > 0
    //   ? this.logger.log(`Tick Received: ${JSON.stringify(tickData.lp)}`)
    //   : '';
    // tickData.lp > 0 || tickData.bp1 > 0 || tickData.sp1 > 0
    //   ? console.log('tick data : ', tickData.ltp)
    //   : '';
    // Later you can route to strategies:
    // this.runScalpingStrategy(tickData);
    // this.runVWAPStrategy(tickData);
  }

  // Example placeholder strategy
  private runScalpingStrategy(tick: any) {
    // logic here
  }
}
