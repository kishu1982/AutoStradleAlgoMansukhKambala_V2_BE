import { Controller, Post, Body, Get, Query } from '@nestjs/common';
import { AutoStradleExecutionService } from './auto-stradle-execution.service';
import { AutoStradleRMSService } from './auto-stradle-rms.service';

@Controller('auto-stradle')
export class AutoStradleExecutionController {
  constructor(
    private readonly executionService: AutoStradleExecutionService,
    private readonly rmsService: AutoStradleRMSService,
  ) {}

  // // to execute signal for auto stradle strategy, this will be used in rms service
  // @Post('execute')
  // async executeSignal(
  //   @Body()
  //   body: {
  //     strategyName: string;
  //     tokenNumber: string;
  //     exchange: string;
  //     side: 'BUY' | 'SELL';
  //   },
  // ) {
  //   return this.executionService.executeSignal(body);
  // }

  // // to execute manual square off for a particular token and exchange, this will be used in rms service
  // @Post('manual-squareoff')
  // manualSquareOff(@Body() body: { tokenNumber: string; exchange: string }) {
  //   return this.rmsService.manualSquareOff(body);
  // }

  // merging both into one endpoint, if side is BUY or SELL then execute signal, else manual square off
  @Post('execute')
  async executeSignal(
    @Body()
    body: {
      strategyName?: string;
      tokenNumber: string;
      exchange: string;
      side: string;
    },
  ) {
    const side = body.side?.toUpperCase();

    if (side === 'BUY' || side === 'SELL') {
      if (!body.strategyName) {
        throw new Error('strategyName is required for BUY/SELL');
      }

      return this.executionService.executeSignal({
        strategyName: body.strategyName, // now TypeScript knows it's a string
        tokenNumber: body.tokenNumber,
        exchange: body.exchange,
        side: side as 'BUY' | 'SELL',
      });
    }

    return this.rmsService.manualSquareOff({
      tokenNumber: body.tokenNumber,
      exchange: body.exchange,
    });
  }

  @Get('high-low')
  async getHighLow(
    @Query('exchange') exchange: string,
    @Query('token') token: string,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    return this.executionService.getHighLowFromTimeSeries({
      exchange,
      token,
      startDateTime: start,
      endDateTime: end,
    });
  }

  // --------------------------------
  // get active trades (for auto stradle strategy)
  // --------------------------------

  @Get('active-trades')
  async getActiveTrades() {
    // console.log('Received request for active trades'); // 🔥 DEBUG
    return await this.executionService.getActiveTradeData();
  }
}
