import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
// import { EventEmitter2 } from '@nestjs/event-emitter';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    // private readonly eventEmitter: EventEmitter2, // TEMP
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // @Get('test-emit') // TEMP route
  // testEmit() {
  //   const fakeTick = { lp: 999.99, tk: 'TEST', e: 'NSE' };
  //   console.log('🧪 Manually emitting market.tick');
  //   this.eventEmitter.emit('market.tick', fakeTick);
  //   return { emitted: true };
  // }
}
