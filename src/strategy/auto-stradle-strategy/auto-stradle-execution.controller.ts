import { Controller, Post, Body } from '@nestjs/common';
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
}
