import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string; webUrl?: string };
export const API_URL = (extra.apiUrl ?? 'http://localhost:4000').replace(/\/$/, '');
export const WEB_URL = (extra.webUrl ?? 'http://localhost:5173').replace(/\/$/, '');

let token: string | null = null;
const TOKEN_KEY = 'bitripay_token';

export async function loadToken() {
  token = await SecureStore.getItemAsync(TOKEN_KEY);
  return token;
}
export async function saveToken(t: string | null) {
  token = t;
  if (t) await SecureStore.setItemAsync(TOKEN_KEY, t);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}
export const getToken = () => token;

const listeners = new Set<() => void>();
export const onLogout = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

async function request<T>(method: string, path: string, body?: unknown, override?: string | null): Promise<T> {
  const auth = override === undefined ? token : override;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json?.error ?? {};
    if (res.status === 401 && err.code === 'invalid_token') {
      await saveToken(null);
      listeners.forEach((fn) => fn());
    }
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `Request failed (${res.status})`);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown, override?: string | null) => request<T>('POST', path, body ?? {}, override),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
