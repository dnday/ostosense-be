import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AiService } from './ai.service';
import { TokenGuard } from '../auth/token.guard';

@Controller('api/ai')
@UseGuards(TokenGuard)
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('ingest')
  async ingest(@Body() body: unknown) {
    const result = await this.aiService.ingest(body);
    if (!result.ok) throw new BadRequestException(result.error);
    return result.row;
  }
}
