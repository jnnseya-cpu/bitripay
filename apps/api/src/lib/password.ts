import bcrypt from 'bcryptjs';

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain: string, hash: string | null | undefined): boolean {
  if (!hash) return false;
  return bcrypt.compareSync(plain, hash);
}
