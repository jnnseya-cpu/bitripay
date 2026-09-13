/**
 * Passkeys / biometric login (WebAuthn). Users register a platform authenticator (Face ID, Touch ID,
 * Windows Hello, Android biometrics); it is then used to sign in without a password and to confirm
 * payments (a short-lived step-up token replaces the transaction PIN).
 */
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { getDb } from '../db';
import { uuid, now } from '../lib/ids';
import { badRequest, unauthorized } from '../lib/errors';
import { parseJson } from '../lib/json';
import { config } from '../config';
import { signToken, verifyToken } from '../lib/jwt';
import { findUserById, updateUser, type UserRow } from './users';

function rp() {
  const web = new URL(config.webUrl);
  const rpID = config.webauthn.rpId || web.hostname;
  const origins = Array.from(new Set([config.webUrl, config.adminUrl, ...config.webauthn.origins]));
  return { rpID, rpName: config.appName, origins };
}

function storeChallenge(purpose: string, challenge: string, userId?: string | null) {
  const db = getDb();
  db.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').run(now());
  const id = uuid();
  db.prepare('INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    userId ?? null,
    purpose,
    challenge,
    new Date(Date.now() + 5 * 60_000).toISOString(),
    now(),
  );
  return id;
}

function consumeChallenge(id: string, purpose: string): { challenge: string; user_id: string | null } {
  const db = getDb();
  const row = db.prepare('SELECT * FROM webauthn_challenges WHERE id = ? AND purpose = ? AND expires_at > ?').get(id, purpose, now()) as any;
  if (!row) throw badRequest('Challenge expired – please try again', 'challenge_expired');
  db.prepare('DELETE FROM webauthn_challenges WHERE id = ?').run(id);
  return row;
}

export function listPasskeys(userId: string) {
  return (getDb().prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC').all(userId) as any[]).map((r) => ({
    id: r.id,
    deviceName: r.device_name,
    deviceType: r.device_type,
    backedUp: !!r.backed_up,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

export async function registrationOptions(user: UserRow) {
  const { rpID, rpName } = rp();
  const existing = getDb().prepare('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?').all(user.id) as any[];
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email || user.phone || user.tag,
    userDisplayName: user.full_name,
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: parseJson<AuthenticatorTransportFuture[]>(c.transports, []) })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  const challengeId = storeChallenge('register', options.challenge, user.id);
  return { challengeId, options };
}

export async function verifyRegistration(user: UserRow, challengeId: string, response: any, deviceName?: string | null) {
  const { rpID, origins } = rp();
  const { challenge } = consumeChallenge(challengeId, 'register');
  const verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origins, expectedRPID: rpID, requireUserVerification: false });
  if (!verification.verified || !verification.registrationInfo) throw badRequest('Passkey registration could not be verified', 'webauthn_failed');
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const id = uuid();
  getDb()
    .prepare('INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, device_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      id,
      user.id,
      credential.id,
      Buffer.from(credential.publicKey).toString('base64url'),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      deviceName ?? null,
      now(),
    );
  return listPasskeys(user.id);
}

export function deletePasskey(userId: string, id: string) {
  getDb().prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(id, userId);
}

/** Options for login (discoverable credential, no username) or step-up (bound to the signed-in user). */
export async function authenticationOptions(purpose: 'login' | 'step_up', user?: UserRow | null) {
  const { rpID } = rp();
  const allow = user ? (getDb().prepare('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?').all(user.id) as any[]) : [];
  if (user && allow.length === 0) throw badRequest('No passkey registered on this account', 'no_passkey');
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials: user ? allow.map((c) => ({ id: c.credential_id, transports: parseJson<AuthenticatorTransportFuture[]>(c.transports, []) })) : undefined,
  });
  const challengeId = storeChallenge(purpose, options.challenge, user?.id ?? null);
  return { challengeId, options };
}

export async function verifyAuthentication(purpose: 'login' | 'step_up', challengeId: string, response: any, expectedUser?: UserRow | null): Promise<UserRow> {
  const { rpID, origins } = rp();
  const { challenge, user_id } = consumeChallenge(challengeId, purpose);
  const cred = getDb().prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?').get(response?.id) as any;
  if (!cred) throw unauthorized('Unknown passkey', 'unknown_passkey');
  if ((expectedUser && cred.user_id !== expectedUser.id) || (user_id && cred.user_id !== user_id)) throw unauthorized('Passkey does not belong to this account', 'passkey_mismatch');
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origins,
    expectedRPID: rpID,
    requireUserVerification: false,
    credential: { id: cred.credential_id, publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')), counter: cred.counter, transports: parseJson(cred.transports, []) },
  });
  if (!verification.verified) throw unauthorized('Biometric verification failed', 'webauthn_failed');
  getDb().prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(verification.authenticationInfo.newCounter, now(), cred.id);
  const user = findUserById(cred.user_id);
  if (!user) throw unauthorized();
  if (purpose === 'login') updateUser(user.id, { last_login_at: now() });
  return user;
}

/** Short-lived token proving a fresh biometric check; accepted anywhere a transaction PIN is required. */
export function issueStepUpToken(user: UserRow): { stepUpToken: string; expiresAt: string } {
  return { stepUpToken: signToken({ sub: user.id, role: user.role, mfa: false, stepUp: true } as any, '5m'), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
}

export function verifyStepUpToken(user: UserRow, token?: string | null): boolean {
  if (!token) return false;
  const payload = verifyToken(token) as any;
  return !!payload && payload.sub === user.id && payload.stepUp === true;
}
