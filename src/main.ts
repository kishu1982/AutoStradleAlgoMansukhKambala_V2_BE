import { setServers } from 'node:dns/promises';
// Force Node.js to use public DNS to resolve SRV records
setServers(['1.1.1.1', '8.8.8.8']);

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io'; // 👈 ADD THIS

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // IMPORTANT: enables correct client IP from x-forwarded-for
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', true);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true, // 🔴 REQUIRED
      },
    }),
  ); // defining gloabally

  // fixing cors for nextjs frontend
  app.enableCors({
    origin: true, // your NextJS frontend alows all origins, you can specify your frontend URL here
    // origin: 'http://localhost:3001', // your NextJS frontend
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true, // if using cookies/auth
  });

  app.useWebSocketAdapter(new IoAdapter(app)); // 👈 ADD THIS LINE

  // for heap memory fixture
  // ⭐ ADD THIS BLOCK — heap trend monitor, runs for the whole app lifetime
  const memLogger = new Logger('MemoryMonitor');
  setInterval(() => {
    const m = process.memoryUsage();
    memLogger.warn(
      `heapUsed=${(m.heapUsed / 1024 / 1024).toFixed(0)}MB rss=${(m.rss / 1024 / 1024).toFixed(0)}MB`,
    );
  }, 60_000);
  // heap memory fixture closed

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
