import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { activeTokens } from './auth.controller';

@Injectable()
export class TokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header = request.headers['authorization'];
    const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : undefined;
    if (!token || !activeTokens.has(token)) {
      throw new UnauthorizedException('Token tidak valid, silakan login ulang');
    }
    return true;
  }
}
