/**
 * Forwarder: turns an operator SMS into signed evidence and delivers it to the right endpoint.
 *
 *  - payout device with a payout IN_PROGRESS on this device  → POST /api/payouts/device/:id/evidence (settles only if the server verifies it)
 *  - anything else (collection device, or no payout in progress) → POST /api/evidence/sms so the raw evidence is preserved server-side
 *
 * Delivery failures never lose evidence: the signed payload is queued in app storage and retried until the API accepts it
 * (or refuses it for a reason that will not change, e.g. an invalid signature or a revoked device).
 */
import { buildEvidence } from './protocol';
import { postEvidence, ApiError } from './api';
import { appendLog, loadPending, savePending, type Enrolment, type PendingEvidence } from './store';
import { nonce } from './crypto';
import { matchesFilters } from './rules';

export { matchesFilters };

export interface IncomingSms {
  id: string;
  from: string;
  text: string;
  /** Epoch millis when the device received it. */
  receivedAt: number;
}

export interface ForwardContext {
  enrolment: Enrolment;
  privateKeyHex: string;
  /** Payout instruction currently claimed and in progress on this device, if any. */
  activePayoutId: string | null;
}

/** Permanent refusals: retrying cannot help, so the item is dropped from the retry queue but kept in the log. */
const PERMANENT = new Set(['invalid_signature', 'device_revoked', 'evidence_replay', 'validation_error', 'device_not_found', 'payout_not_found', 'invalid_stage_transition']);

export function endpointFor(ctx: ForwardContext): { path: string; payoutId: string | null } {
  if (ctx.enrolment.kind === 'payout' && ctx.activePayoutId) return { path: `/api/payouts/device/${ctx.activePayoutId}/evidence`, payoutId: ctx.activePayoutId };
  return { path: '/api/evidence/sms', payoutId: null };
}

export function signSms(ctx: ForwardContext, sms: IncomingSms): Record<string, unknown> {
  const e = ctx.enrolment;
  const fields = { deviceId: e.deviceId, nonce: nonce(), receivedAt: new Date(sms.receivedAt).toISOString(), from: sms.from, operatorId: e.operatorId, text: sms.text };
  const full = buildEvidence(ctx.privateKeyHex, fields, { simIdentity: e.simMsisdn ?? e.simIccid ?? null });
  // /api/evidence/sms accepts only the core fields; the payout endpoint takes the extra SIM / hash checks.
  return endpointFor(ctx).payoutId ? full : { deviceId: full.deviceId, nonce: full.nonce, receivedAt: full.receivedAt, from: full.from, operatorId: full.operatorId, text: full.text, signature: full.signature };
}

export interface DeliveryResult {
  delivered: boolean;
  queued: boolean;
  outcome?: string;
  stage?: string;
  reasons?: string[];
  error?: string;
}

async function deliver(apiUrl: string, path: string, payload: Record<string, unknown>): Promise<{ outcome?: string; stage?: string; reasons?: string[] }> {
  const res: any = await postEvidence(apiUrl, path, payload);
  return { outcome: res?.evidence?.outcome, stage: res?.payout?.stage, reasons: res?.evidence?.reasons ?? [] };
}

/** Sign and forward one SMS; queue it on transient failure. */
export async function forwardSms(ctx: ForwardContext, sms: IncomingSms): Promise<DeliveryResult> {
  const { path, payoutId } = endpointFor(ctx);
  const payload = signSms(ctx, sms);
  try {
    const r = await deliver(ctx.enrolment.apiUrl, path, payload);
    await appendLog({ level: r.stage === 'SETTLED' || r.outcome === 'matched' || r.outcome === 'settled' ? 'ok' : 'info', text: `${payoutId ? `Payout ${payoutId.slice(0, 8)}` : 'SMS'} from ${sms.from}: ${r.outcome ?? 'received'}${r.stage ? ` → ${r.stage}` : ''}${r.reasons?.length ? ` (${r.reasons.join(', ')})` : ''}` });
    return { delivered: true, queued: false, ...r };
  } catch (err) {
    const e = err as ApiError;
    if (e instanceof ApiError && PERMANENT.has(e.code)) {
      await appendLog({ level: 'error', text: `Evidence refused (${e.code}): ${e.message}` });
      return { delivered: false, queued: false, error: e.message };
    }
    const pending = await loadPending();
    pending.push({ id: `${sms.id}:${Date.now()}`, payoutId, path, payload, attempts: 1, lastError: (err as Error).message, createdAt: new Date().toISOString() });
    await savePending(pending);
    await appendLog({ level: 'warn', text: `Could not deliver evidence from ${sms.from} – queued for retry (${(err as Error).message})` });
    return { delivered: false, queued: true, error: (err as Error).message };
  }
}

/** Retry queued evidence; returns how many were delivered. Signatures are reused verbatim – the nonce makes each payload single-use, so a delivered item is never resent. */
export async function flushPending(apiUrl: string): Promise<{ delivered: number; remaining: number }> {
  const pending = await loadPending();
  if (!pending.length) return { delivered: 0, remaining: 0 };
  const keep: PendingEvidence[] = [];
  let delivered = 0;
  for (const item of pending) {
    try {
      const r = await deliver(apiUrl, item.path, item.payload);
      delivered++;
      await appendLog({ level: 'ok', text: `Queued evidence delivered: ${r.outcome ?? 'received'}${r.stage ? ` → ${r.stage}` : ''}` });
    } catch (err) {
      const e = err as ApiError;
      if (e instanceof ApiError && PERMANENT.has(e.code)) {
        await appendLog({ level: 'error', text: `Queued evidence refused (${e.code}): ${e.message}` });
        continue;
      }
      keep.push({ ...item, attempts: item.attempts + 1, lastError: (err as Error).message });
    }
  }
  await savePending(keep);
  return { delivered, remaining: keep.length };
}
