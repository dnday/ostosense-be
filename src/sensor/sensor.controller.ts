import { Controller, Get } from '@nestjs/common';
import { SensorService } from './sensor.service';

@Controller('api/sensor-series')
export class SensorController {
  constructor(private readonly sensorService: SensorService) {}

  @Get()
  async getSeries() {
    return await this.sensorService.getSeries();
  }
}
