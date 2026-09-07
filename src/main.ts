import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: ['https://ostosense.my.id', 'https://app.ostosense.my.id'],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`Ostosense Backend is running on port ${port}`);
}
bootstrap();
