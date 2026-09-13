import { getDb } from '../db';
import { uuid, now, numericCode } from '../lib/ids';
import { sha256, safeEqual } from '../lib/crypto';
import { badRequest } from '../lib/errors';
import { sendEmail, sendSms } from './messaging';
import { config } from '../config';

export type OtpPurpose = 'verify_email' | 'verify_phone' | 'login' | 'reset_password' | 'register';

const TTL_MINUTES = 10;

export interface IssueOtpResult {
  sent: boolean;
  via: string;
  /** Only populated outside production so the sandbox flow can be completed without SMTP/SMS. */
  devCode?: string;
  expiresAt: string;
}

export async function issueOtp(channel: 'email' | 'sms', target: string, purpose: OtpPurpose, userId?: string | null): Promise<IssueOtpResult> {
  const db = getDb();
  const recent = db.prepare('SELECT COUNT(*) c FROM otp_codes WHERE target = ? AND purpose = ? AND created_at > ?').get(target, purpose, new Date(Date.now() - 60 * 1000).toISOString()) as any;
  if (recent.c >= 3) throw badRequest('Too many codes requested. Please wait a minute.', 'otp_rate_limited');
  db.prepare('UPDATE otp_codes SET consumed = 1 WHERE target = ? AND purpose = ? AND consumed = 0').run(target, purpose);
  const code = numericCode(6);
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000).toISOString();
  db.prepare('INSERT INTO otp_codes (id, user_id, channel, target, code_hash, purpose, expires_at, consumed, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)').run(
    uuid(),
    userId ?? null,
    channel,
    target,
    sha256(code),
    purpose,
    expiresAt,
    now(),
  );
  const message = `Your ${config.appName} verification code is ${code}. It expires in ${TTL_MINUTES} minutes.`;
  const result = channel === 'email' ? await sendEmail(target, `${config.appName} verification code`, message) : await sendSms(target, message);
  return {
    sent: result.delivered,
    via: result.via,
    devCode: config.isProduction ? undefined : code,
    expiresAt,
  };
}

export function verifyOtp(target: string, purpose: OtpPurpose, code: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT * FROM otp_codes WHERE target = ? AND purpose = ? AND consumed = 0 ORDER BY created_at DESC LIMIT 1').get(target, purpose) as any;
  if (!row) return false;
  if (row.expires_at < now()) return false;
  if (row.attempts >= 5) return false;
  db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
  if (!safeEqual(row.code_hash, sha256(code.trim()))) return false;
  db.prepare('UPDATE otp_codes SET consumed = 1 WHERE id = ?').run(row.id);
  return true;
}
