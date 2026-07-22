import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  namespace: 'market-data', // clients connect to ws(s)://host:port/market-data
  cors: {
    origin: '*', // 🔒 tighten this to your Next.js app's domain in production
  },
})
export class MarketDataOutGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(MarketDataOutGateway.name);

  constructor() {
    this.logger.log('🏗️ MarketDataOutGateway constructed'); // TEMP
  }

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket) {
    this.logger.log(`🔌 Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`❌ Client disconnected: ${client.id}`);
  }

  // Listens for events emitted anywhere in the app via EventEmitter2
  @OnEvent('market.tick')
  handleTick(tick: any) {
    // broadcast to ALL connected clients on this namespace, as-is
    // this.logger.log(`📥 RECEIVED market.tick | ltp=${tick?.lp}`); // TEMP
    // this.logger.debug(`tick data for sending out: ${JSON.stringify(tick)}`);
    this.server.emit('tick', tick);
  }
}
