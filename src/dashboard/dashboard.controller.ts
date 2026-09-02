import { Controller, Get, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { TokenGuard } from '../auth/token.guard';

@Controller('api/dashboard-summary')
@UseGuards(TokenGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  async getSummary() {
    return await this.dashboardService.getSummary();
  }
}
