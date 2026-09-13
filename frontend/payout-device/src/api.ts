import { signRequest } from './protocol';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function handle(res: Response) {
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? `Request failed (${res.status})`);
  return json;
}

/** Calls made as the enrolling agent (bearer token) – only during setup. */
export async function agentCall<T>(apiUrl: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return handle(res);
}

/** Calls made as the device itself – authenticated by the device key, never by a user token. */
export async function deviceCall<T>(apiUrl: string, privateKeyHex: string, deviceId: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...signRequest(privateKeyHex, deviceId, method, path) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handle(res);
}

/** Evidence submissions carry their own signature in the body. */
export async function postEvidence<T>(apiUrl: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return handle(res);
}
