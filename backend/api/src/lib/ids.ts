import { randomBytes, randomInt, randomUUID } from 'node:crypto';

export const uuid = () => randomUUID();

const ALPHANUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

export function shortCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHANUM[bytes[i] % ALPHANUM.length];
  return out;
}

export function numericCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

export function txReference(prefix = 'BP'): string {
  const date = new Date();
  const ymd = `${date.getUTCFullYear().toString().slice(2)}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  return `${prefix}-${ymd}-${shortCode(6)}`;
}

export function secretToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export const now = () => new Date().toISOString();
