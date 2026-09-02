import { Controller, Get, UseGuards } from '@nestjs/common';
import { SensorService } from './sensor.service';
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
