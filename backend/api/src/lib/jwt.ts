import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface TokenPayload {
  sub: string;
  role: string;
  /** Partial token: user still needs to complete 2FA. */
  mfa?: boolean;
  /** Issued-at (seconds), set by jsonwebtoken; sessions issued before `users.sessions_invalidated_at` are refused. */
  iat?: number;
}

export function signToken(payload: TokenPayload, expiresIn: string = '7d'): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: expiresIn as any });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as TokenPayload;
  } catch {
    return null;
  }
}
