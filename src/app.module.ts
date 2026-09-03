import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DashboardModule } from './dashboard/dashboard.module';
import { AiModule } from './ai/ai.module';
import { AuthController } from './auth/auth.controller';
import { SensorController } from './sensor/sensor.controller';
import { SensorService } from './sensor/sensor.service';
import { MqttService } from './sensor/mqtt.service'; // <-- Import baru

@Module({
  imports: [DashboardModule, AiModule],
  controllers: [AppController, AuthController, SensorController],
  providers: [AppService, SensorService, MqttService], // <-- Daftarkan MqttService
})
export class AppModule {}
