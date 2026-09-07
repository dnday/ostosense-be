import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { SensorService } from './sensor.service';
import { MqttService } from './mqtt.service';
import { TokenGuard } from '../auth/token.guard';

@Controller('api/sensor-series')
@UseGuards(TokenGuard)
export class SensorController {
  constructor(private readonly sensorService: SensorService) {}

  @Get()
  async getSeries() {
    return await this.sensorService.getSeries();
  }
}

// ponytail: gak pakai TokenGuard di sini — device gak punya cara login nakes,
// dan MQTT sendiri juga masih tanpa auth secara default (lihat mqtt.service.ts).
// Tambahkan API key per-device sebelum dipakai lebih luas dari sekadar testing.
@Controller('api/sensor/ingest')
export class SensorIngestController {
  constructor(private readonly mqttService: MqttService) {}

  @Post()
  async ingest(@Body() payload: any) {
    const result = await this.mqttService.ingestPayload(payload);
    if (!result.ok) throw new BadRequestException(result.error);
    return { received: true };
  }
}
