import { currentStepUpToken } from './passkeys';
export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const TOKEN_KEY = 'bitripay.token';
const ORGANISATION_KEY = 'bitripay.organisation';
export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || '';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** The workspace (organisation) this browser acts for when the person belongs to several; sent as X-Organisation-Id. */
export function getOrganisation(): string | null {
  try {
    return localStorage.getItem(ORGANISATION_KEY);
  } catch {
    return null;
  }
}
export function setOrganisation(id: string | null) {
  try {
    if (id) localStorage.setItem(ORGANISATION_KEY, id);
    else localStorage.removeItem(ORGANISATION_KEY);
  } catch {
    /* ignore */
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown, opts: { token?: string | null; raw?: boolean } = {}): Promise<T> {
  const token = opts.token === undefined ? getToken() : opts.token;
  const stepUp = method !== 'GET' ? currentStepUpToken() : null;
  const organisation = token ? getOrganisation() : null;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(stepUp ? { 'X-Step-Up-Token': stepUp } : {}),
      ...(organisation ? { 'X-Organisation-Id': organisation } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (opts.raw) return (await res.text()) as unknown as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json?.error ?? {};
    if (res.status === 401 && err.code === 'invalid_token') {
      setToken(null);
      window.dispatchEvent(new Event('bitripay:logout'));
    }
    throw new ApiError(res.status, err.code ?? 'error', err.message ?? `Request failed (${res.status})`, err.details);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, opts?: { token?: string | null }) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: { token?: string | null }) => request<T>('POST', path, body ?? {}, opts),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
