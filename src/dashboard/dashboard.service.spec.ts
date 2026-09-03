import { Test, TestingModule } from '@nestjs/testing';
import { DashboardService } from './dashboard.service';
import { AiService } from '../ai/ai.service';

describe('DashboardService', () => {
  let service: DashboardService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardService,
        { provide: AiService, useValue: { getLatestPerSession: jest.fn().mockResolvedValue([]) } },
      ],
    }).compile();

    service = module.get<DashboardService>(DashboardService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
