import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { TokenModule } from 'src/token/token.module';
import { TokenService } from 'src/token/token.service';

@Module({
  imports: [TokenModule],
  providers: [OrdersService, TokenService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
