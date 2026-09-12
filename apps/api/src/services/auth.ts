import { getDb } from '../db';
import { badRequest, forbidden, unauthorized, conflict } from '../lib/errors';
import { hashPassword, verifyPassword } from '../lib/password';
import { signToken } from '../lib/jwt';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp';
import { encrypt, decrypt } from '../lib/crypto';
import { now } from '../lib/ids';
import { config } from '../config';
import {
  createUser,
  findUserByEmail,
  findUserByPhone,
  normalizeEmail,
  normalizePhone,
  toUser,
  updateUser,
  type UserRow,
  type CreateUserInput,
} from './users';
import { issueOtp, verifyOtp } from './otp';
import { getAppSettings, getSetting } from './settings';
import { notify } from './notifications';
import { onUserRegistered } from './referrals';
import { verifyStepUpToken } from './webauthn';

export interface AuthResult {
  token: string;
  user: ReturnType<typeof toUser>;
  requiresTwoFactor?: boolean;
}

function assertCountryAllowed(country?: string | null) {
  if (!country) return;
  const restriction = getSetting<{ mode: 'none' | 'allow' | 'block'; countries: string[] }>('countries', { mode: 'none', countries: [] });
  const code = country.toUpperCase();
  if (restriction.mode === 'allow' && restriction.countries.length && !restriction.countries.includes(code)) {
    throw forbidden('Registrations from your country are not currently supported', 'country_restricted');
  }
  if (restriction.mode === 'block' && restriction.countries.includes(code)) {
    throw forbidden('Registrations from your country are not currently supported', 'country_restricted');
  }
}

export function register(input: CreateUserInput & { password: string }): AuthResult {
  const app = getAppSettings();
  if (!app.registrationOpen) throw forbidden('Registration is currently closed', 'registration_closed');
  if (input.role && !['user', 'merchant', 'agent'].includes(input.role)) throw badRequest('Invalid role');
  if (input.password.length < 8) throw badRequest('Password must be at least 8 characters');
  assertCountryAllowed(input.country);
  const user = createUser(input);
  onUserRegistered(user);
  notify(user.id, `Welcome to ${config.appName}!`, 'Your wallet is ready. Add money to get started.', { kind: 'welcome' });
  return { token: signToken({ sub: user.id, role: user.role }), user: toUser(user) };
}

export function login(identifier: string, password: string): AuthResult {
  const email = normalizeEmail(identifier);
  const row = identifier.includes('@') ? findUserByEmail(email!) : findUserByPhone(identifier) || findUserByEmail(identifier);
  if (!row || !verifyPassword(password, row.password_hash)) throw unauthorized('Invalid credentials', 'invalid_credentials');
  return finishLogin(row);
}

export function finishLogin(row: UserRow): AuthResult {
  if (row.status === 'suspended') throw forbidden('Your account has been suspended. Contact support.', 'account_suspended');
  if (row.two_factor_enabled) {
    return { token: signToken({ sub: row.id, role: row.role, mfa: true }, '10m'), user: toUser(row), requiresTwoFactor: true };
  }
  updateUser(row.id, { last_login_at: now() });
  return { token: signToken({ sub: row.id, role: row.role }), user: toUser(row) };
}

export function completeTwoFactor(row: UserRow, code: string): AuthResult {
  if (!row.two_factor_enabled || !row.two_factor_secret) throw badRequest('Two-factor authentication is not enabled');
  if (!verifyTotp(decrypt(row.two_factor_secret), code)) throw unauthorized('Invalid authentication code', 'invalid_2fa');
  updateUser(row.id, { last_login_at: now() });
  return { token: signToken({ sub: row.id, role: row.role }), user: toUser(row) };
}

/** Phone / email OTP login: step 1 sends the code. */
export async function requestOtpLogin(identifier: string) {
  const isEmail = identifier.includes('@');
  const target = isEmail ? normalizeEmail(identifier)! : normalizePhone(identifier)!;
  const row = isEmail ? findUserByEmail(target) : findUserByPhone(target);
  if (!row) throw unauthorized('No account found for this ' + (isEmail ? 'email' : 'phone number'), 'account_not_found');
  return issueOtp(isEmail ? 'email' : 'sms', target, 'login', row.id);
}

/** Phone / email OTP login: step 2 verifies the code and issues a token. */
export function verifyOtpLogin(identifier: string, code: string): AuthResult {
  const isEmail = identifier.includes('@');
  const target = isEmail ? normalizeEmail(identifier)! : normalizePhone(identifier)!;
  const row = isEmail ? findUserByEmail(target) : findUserByPhone(target);
  if (!row) throw unauthorized('Account not found', 'account_not_found');
  if (!verifyOtp(target, 'login', code)) throw unauthorized('Invalid or expired code', 'invalid_otp');
  updateUser(row.id, isEmail ? { email_verified: 1 } : { phone_verified: 1 });
  return finishLogin(row);
}

export async function requestVerification(row: UserRow, channel: 'email' | 'sms') {
  const target = channel === 'email' ? row.email : row.phone;
  if (!target) throw badRequest(`No ${channel === 'email' ? 'email address' : 'phone number'} on your account`);
  return issueOtp(channel, target, channel === 'email' ? 'verify_email' : 'verify_phone', row.id);
}

export function confirmVerification(row: UserRow, channel: 'email' | 'sms', code: string) {
  const target = channel === 'email' ? row.email : row.phone;
  if (!target) throw badRequest('Nothing to verify');
  if (!verifyOtp(target, channel === 'email' ? 'verify_email' : 'verify_phone', code)) throw badRequest('Invalid or expired code', 'invalid_otp');
  return updateUser(row.id, channel === 'email' ? { email_verified: 1 } : { phone_verified: 1 });
}

export async function requestPasswordReset(identifier: string) {
  const isEmail = identifier.includes('@');
  const target = isEmail ? normalizeEmail(identifier)! : normalizePhone(identifier)!;
  const row = isEmail ? findUserByEmail(target) : findUserByPhone(target);
  if (!row) return { sent: false, via: 'none', expiresAt: null }; // do not leak account existence
  return issueOtp(isEmail ? 'email' : 'sms', target, 'reset_password', row.id);
}

export function resetPassword(identifier: string, code: string, newPassword: string) {
  const isEmail = identifier.includes('@');
  const target = isEmail ? normalizeEmail(identifier)! : normalizePhone(identifier)!;
  const row = isEmail ? findUserByEmail(target) : findUserByPhone(target);
  if (!row || !verifyOtp(target, 'reset_password', code)) throw badRequest('Invalid or expired code', 'invalid_otp');
  if (newPassword.length < 8) throw badRequest('Password must be at least 8 characters');
  updateUser(row.id, { password_hash: hashPassword(newPassword), password_changed_at: new Date().toISOString() } as any);
}

export function changePassword(row: UserRow, current: string, next: string) {
  if (row.password_hash && !verifyPassword(current, row.password_hash)) throw badRequest('Current password is incorrect', 'invalid_password');
  if (next.length < 8) throw badRequest('Password must be at least 8 characters');
  updateUser(row.id, { password_hash: hashPassword(next), password_changed_at: new Date().toISOString() } as any);
}

export function setPin(row: UserRow, pin: string, currentPin?: string) {
  if (!/^\d{4,6}$/.test(pin)) throw badRequest('PIN must be 4-6 digits', 'invalid_pin');
  if (row.pin_hash && !verifyPassword(currentPin ?? '', row.pin_hash)) throw badRequest('Current PIN is incorrect', 'invalid_pin');
  updateUser(row.id, { pin_hash: hashPassword(pin) });
}

/**
 * Authorize a money movement: a fresh biometric step-up token (passkey / device biometrics) or the
 * transaction PIN. The token may arrive in the X-Step-Up-Token header or as `stepUpToken` in the body.
 */
export function assertPin(row: UserRow, pin?: string, req?: { headers?: Record<string, unknown>; body?: any }) {
  const token = (req?.headers?.['x-step-up-token'] as string | undefined) || req?.body?.stepUpToken;
  if (token && verifyStepUpToken(row, token)) return;
  if (!row.pin_hash) throw badRequest('Set a transaction PIN in security settings before sending money', 'pin_required');
  if (!pin || !verifyPassword(pin, row.pin_hash)) throw forbidden('Incorrect transaction PIN', 'invalid_pin');
}

export function beginTwoFactorSetup(row: UserRow) {
  if (row.two_factor_enabled) throw conflict('Two-factor authentication is already enabled');
  const secret = generateTotpSecret();
  updateUser(row.id, { two_factor_secret: encrypt(secret) });
  const account = row.email || row.phone || row.tag;
  return { secret, otpauth: otpauthUrl(config.appName, account, secret) };
}

export function enableTwoFactor(row: UserRow, code: string) {
  if (!row.two_factor_secret) throw badRequest('Start 2FA setup first');
  if (!verifyTotp(decrypt(row.two_factor_secret), code)) throw badRequest('Invalid authentication code', 'invalid_2fa');
  updateUser(row.id, { two_factor_enabled: 1 });
}

export function disableTwoFactor(row: UserRow, code: string) {
  if (!row.two_factor_enabled || !row.two_factor_secret) throw badRequest('Two-factor authentication is not enabled');
  if (!verifyTotp(decrypt(row.two_factor_secret), code)) throw badRequest('Invalid authentication code', 'invalid_2fa');
  updateUser(row.id, { two_factor_enabled: 0, two_factor_secret: null });
}

export function ensureAdminExists() {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_system = 0 LIMIT 1").get();
  if (existing) return;
  const admin = createUser({
    email: config.admin.email,
    password: config.admin.password,
    fullName: config.admin.name,
    role: 'admin',
    tag: 'admin',
    emailVerified: true,
  });
  db.prepare("UPDATE users SET kyc_status = 'verified' WHERE id = ?").run(admin.id);
  if (!config.isTest) console.log(`[bootstrap] admin account created: ${config.admin.email}`);
}
