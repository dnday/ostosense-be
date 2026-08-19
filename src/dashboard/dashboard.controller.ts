import { Controller, Get } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('api/dashboard-summary')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  async getSummary() {
    return await this.dashboardService.getSummary();
  }
}
