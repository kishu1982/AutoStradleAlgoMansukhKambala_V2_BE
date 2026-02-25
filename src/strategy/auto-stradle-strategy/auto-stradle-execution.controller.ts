import { Controller, Post, Body, Get, Query } from '@nestjs/common';
import { AutoStradleExecutionService } from './auto-stradle-execution.service';

@Controller('auto-stradle')
export class AutoStradleExecutionController {
  constructor(private readonly executionService: AutoStradleExecutionService) {}

  @Post('execute')
  async executeSignal(
    @Body()
    body: {
      strategyName: string;
      tokenNumber: string;
      exchange: string;
      side: 'BUY' | 'SELL';
    },
  ) {
    return this.executionService.executeSignal(body);
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
}
