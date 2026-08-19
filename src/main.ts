import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Izinkan Next.js mengakses API ini
  app.enableCors({
    origin: '*', 
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  });

  // Gunakan port 3001 agar tidak bentrok dengan Next.js (3000)
  await app.listen(process.env.PORT ?? 3001);
  console.log(`Ostosense Backend is running on: http://localhost:3001`);
}
bootstrap();
