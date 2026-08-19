import { Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'crypto';

// ponytail: hardcoded demo nakes account, in-memory tokens. Swap for Supabase Auth + users table when real accounts exist.
const DEMO_USERS = [
  {
    email: 'nakes@ostosense.id',
    password: 'ostosense123',
    name: 'Ns. Sari Wijaya',
    role: 'nakes',
  },
];

export const activeTokens = new Set<string>();

@Controller('api/auth')
export class AuthController {
  @Post('login')
  login(@Body() body: { email?: string; password?: string }) {
    const user = DEMO_USERS.find(
      (u) => u.email === body?.email && u.password === body?.password,
    );
    if (!user) {
      throw new UnauthorizedException('Email atau password salah');
    }
    const token = randomBytes(24).toString('hex');
    activeTokens.add(token);
    return {
      token,
      user: { email: user.email, name: user.name, role: user.role },
    };
  }
}
