import { startAuthentication, startRegistration, browserSupportsWebAuthn, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';
import { api } from './api';

let stepUp: { token: string; expiresAt: number } | null = null;

/** Attached by the API client to money-movement requests so the server accepts it instead of the PIN. */
export function currentStepUpToken(): string | null {
  if (stepUp && stepUp.expiresAt > Date.now() + 5000) return stepUp.token;
  stepUp = null;
  return null;
}

export const passkeysSupported = () => browserSupportsWebAuthn();
export const biometricsAvailable = () => platformAuthenticatorIsAvailable().catch(() => false);

export async function registerPasskey(deviceName?: string) {
  const { challengeId, options } = await api.post<{ challengeId: string; options: any }>('/api/account/passkeys/register/options');
  const response = await startRegistration({ optionsJSON: options });
  return api.post<{ items: any[] }>('/api/account/passkeys/register/verify', { challengeId, response, deviceName: deviceName || navigator.platform || null });
}

/** Passwordless sign-in with a discoverable passkey. */
export async function loginWithPasskey() {
  const { challengeId, options } = await api.post<{ challengeId: string; options: any }>('/api/auth/passkey/options', {}, { token: null });
  const response = await startAuthentication({ optionsJSON: options });
  return api.post<{ token: string; user: any }>('/api/auth/passkey/verify', { challengeId, response }, { token: null });
}

/** Biometric confirmation for a payment: yields a 5-minute step-up token. */
export async function biometricStepUp(): Promise<string> {
  const { challengeId, options } = await api.post<{ challengeId: string; options: any }>('/api/account/passkeys/step-up/options');
  const response = await startAuthentication({ optionsJSON: options });
  const r = await api.post<{ stepUpToken: string; expiresAt: string }>('/api/account/passkeys/step-up/verify', { challengeId, response });
  stepUp = { token: r.stepUpToken, expiresAt: new Date(r.expiresAt).getTime() };
  return r.stepUpToken;
}
