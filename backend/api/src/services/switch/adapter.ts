/**
 * CMP-07 National switch adapter contract and the simulator (CMP-14).
 *
 * The internal interface is independent of the external protocol: nothing here presumes ISO 8583, ISO 20022, REST or
 * SOAP. The codec for the real switch is chosen only after the official profile (BCC-04) and lives in a separate
 * module loaded by path from `SWITCH_ADAPTER_MODULE`; it is used only by a connection whose certification is
 * CERTIFIED. The simulator reproduces the internal contract's behaviours (nominal, rejection, timeout after a
 * financial effect, provisional NOT_FOUND, unknown code, duplicate success, contradictory late reject, invalid
 * signature, ACK-only, authorisation without completion, slow pending) and labels everything SIMULATION. It never
 * attests certification.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { AppError } from '../../lib/errors';
import { config } from '../../config';
import type { SwitchConnection } from './connections';

export interface CanonicalPayment {
  paymentId: string;
  product: string;
  amountMinor: string;
  currency: string;
  debtor: { participantId: string; accountToken: string | null; routingId: string | null };
  creditor: { participantId: string; accountToken: string; routingId: string | null; merchantId: string };
  accessMode: 'DIRECT' | 'SPONSORED';
  participantId: string | null;
  sponsorId: string | null;
  schemeId: string | null;
  consentReference: string | null;
  occurredAt: string;
  description: string | null;
}
export type ObservationKind =
  | 'ACK'
  | 'PENDING'
  | 'AUTHORIZED'
  | 'COMPLETED'
  | 'REJECTED'
  | 'NOT_FOUND'
  | 'UNKNOWN'
  | 'MALFORMED'
  | 'REFUND_ACCEPTED'
  | 'REFUND_COMPLETED'
  | 'REFUND_REJECTED'
  | 'REVERSAL_COMPLETED'
  | 'REVERSAL_REJECTED';
export type ObservationAuthority = 'NETWORK' | 'SWITCH' | 'DEBTOR' | 'CREDITOR' | 'SPONSOR';
export interface ExternalObservation {
  kind: ObservationKind;
  externalCode: string;
  externalMessageId: string;
  stableMessageId: string | null;
  externalReference: string | null;
  correlationId: string | null;
  authority: ObservationAuthority;
  amountMinor: string | null;
  currency: string | null;
  occurredAt: string;
  receivedAt: string;
  reason: string | null;
  /** Whether the message's own integrity proof (MAC/signature) verified. */
  signatureValid: boolean;
  /** Raw bytes for the evidence vault (base64). */
  raw: string;
  /** Present when the observation resolves a prior authorisation (needed for AUTHORIZED → REJECTED). */
  resolvesAuthorization?: boolean;
  /** Whether a NOT_FOUND is contractually definitive for the referenced message. */
  definitive?: boolean;
  simulation?: boolean;
}
export interface ExternalReference {
  stableMessageId: string;
  externalReference?: string | null;
  correlationId?: string | null;
}
export interface ReversalCommand {
  paymentId: string;
  originalStableMessageId: string;
  originalExternalReference: string | null;
  stableMessageId: string;
  amountMinor: string;
  currency: string;
  reason: string;
}
export interface RefundCommand extends ReversalCommand {
  merchantId: string;
}
export interface TransportEvidence {
  source: ObservationAuthority;
  receivedAt: string;
  channel: string;
  remote: string | null;
}
export interface VerifiedObservation extends ExternalObservation {
  transport: TransportEvidence;
}
export interface VerifiedReport {
  source: 'SWITCH' | 'INSTITUTION' | 'SPONSOR';
  cycleRef: string;
  currency: string;
  periodFrom: string;
  periodTo: string;
  raw: string;
  signatureValid: boolean;
}
export interface ImportResult {
  lines: {
    externalReference: string;
    correlationId: string | null;
    debtorId: string | null;
    creditorId: string | null;
    amountMinor: string;
    currency: string;
    status: string;
    feeMinor: string | null;
    settlementRef: string | null;
    businessDate: string | null;
    occurredAt: string | null;
    raw: Record<string, unknown>;
  }[];
  controlTotalMinor: string;
  lineCount: number;
}
export interface LinkHealth {
  up: boolean;
  degraded?: boolean;
  inquiryOnly?: boolean;
  message: string;
  latencyMs?: number | null;
  sessions?: number | null;
  quota?: { perSecond: number; used: number } | null;
  simulation?: boolean;
}
export interface Capabilities {
  profileVersion: string;
  products: string[];
  currencies: string[];
  supportsInquiry: boolean;
  supportsReversal: boolean;
  supportsRefund: boolean;
  supportsDeferredCapture: boolean;
  notFoundDefinitiveAfterSeconds: number | null;
  simulation: boolean;
}

export interface NationalSwitchAdapter {
  capabilities(profileVersion: string): Promise<Capabilities>;
  submit(command: CanonicalPayment, stableMessageId: string): Promise<ExternalObservation>;
  inquire(reference: ExternalReference): Promise<ExternalObservation>;
  requestReversal(command: ReversalCommand): Promise<ExternalObservation>;
  requestRefund(command: RefundCommand): Promise<ExternalObservation>;
  verifyAndDecodeInbound(raw: Uint8Array, transport: TransportEvidence): VerifiedObservation;
  importReconciliation(input: VerifiedReport): Promise<ImportResult>;
  health(): Promise<LinkHealth>;
}

export class SwitchTimeoutError extends Error {
  constructor(
    public readonly stableMessageId: string,
    public readonly afterEffect: boolean,
  ) {
    super(`no response for ${stableMessageId} within the timeout`);
  }
}
export class CapabilityNotAvailable extends AppError {
  constructor(message: string) {
    super(422, 'CAPABILITY_NOT_AVAILABLE', message);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------------------------------------------------
/** Scenario per payer account token suffix (documented for integrators and QA). */
export const SIMULATOR_SCENARIOS: Record<string, string> = {
  tok_ok: 'ACK then COMPLETED synchronously (nominal)',
  tok_pending: 'ACK + PENDING; the first inquiry finds COMPLETED',
  tok_slow: 'PENDING for three inquiries, then COMPLETED',
  tok_reject: 'REJECTED by the debtor institution (R05 insufficient funds)',
  tok_timeout: 'timeout after a financial effect: the inquiry finds COMPLETED (never re-emit)',
  tok_timeout_nf: 'timeout, then provisional NOT_FOUND on inquiry; definitive NOT_FOUND on the third inquiry',
  tok_unknown_code: 'response with an unknown external code (quarantine)',
  tok_ack_only: 'technical ACK only, nothing else ever arrives',
  tok_authorized: 'AUTHORIZED without completion (never auto-completed)',
  tok_dup: 'COMPLETED delivered twice as inbound messages',
  tok_contradict: 'COMPLETED, then an authentic contradictory REJECTED arrives later',
  tok_badsig: 'inbound COMPLETED with an invalid signature',
  tok_refund_unknown: 'refund request times out (reservation kept)',
};

interface SimRecord {
  command: CanonicalPayment;
  stableMessageId: string;
  externalReference: string;
  correlationId: string;
  scenario: string;
  inquiries: number;
  effect: boolean;
  finalKind: ObservationKind | null;
}

const SIM_SECRET = 'bitripay-simulator-secret';
function simSign(payload: string): string {
  return createHmac('sha256', SIM_SECRET).update(payload).digest('hex');
}

export class SimulatorAdapter implements NationalSwitchAdapter {
  private store = new Map<string, SimRecord>();
  private refunds = new Map<string, { scenario: string; externalReference: string }>();
  private seq = 0;
  private up = true;
  constructor(private readonly connection: Pick<SwitchConnection, 'id' | 'schemeId' | 'profileVersion' | 'simulatorScenarios'>) {}

  /** Operations can take the simulated link down/up to exercise degraded mode and fencing tests. */
  setLink(up: boolean) {
    this.up = up;
  }

  private scenarioOf(token: string | null | undefined): string {
    const t = (token ?? '').toLowerCase();
    for (const k of Object.keys(SIMULATOR_SCENARIOS)) if (t.endsWith(k) || t === k) return k;
    return 'tok_ok';
  }
  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.seq}`;
  }
  private obs(kind: ObservationKind, code: string, rec: SimRecord | null, extra: Partial<ExternalObservation> = {}): ExternalObservation {
    const externalMessageId = extra.externalMessageId ?? this.nextId('SIMMSG');
    const body = {
      kind,
      code,
      externalMessageId,
      stableMessageId: rec?.stableMessageId ?? extra.stableMessageId ?? null,
      externalReference: rec?.externalReference ?? extra.externalReference ?? null,
      correlationId: rec?.correlationId ?? null,
      amountMinor: rec?.command.amountMinor ?? null,
      currency: rec?.command.currency ?? null,
      occurredAt: new Date().toISOString(),
      simulation: true,
    };
    const payload = JSON.stringify(body);
    const raw = Buffer.from(JSON.stringify({ body, mac: simSign(payload) })).toString('base64');
    return {
      kind,
      externalCode: code,
      externalMessageId,
      stableMessageId: body.stableMessageId,
      externalReference: body.externalReference,
      correlationId: body.correlationId,
      authority: extra.authority ?? (kind === 'ACK' ? 'NETWORK' : kind === 'REJECTED' ? 'DEBTOR' : kind === 'COMPLETED' ? 'CREDITOR' : 'SWITCH'),
      amountMinor: body.amountMinor,
      currency: body.currency,
      occurredAt: body.occurredAt,
      receivedAt: new Date().toISOString(),
      reason: extra.reason ?? null,
      signatureValid: true,
      raw,
      resolvesAuthorization: extra.resolvesAuthorization,
      definitive: extra.definitive,
      simulation: true,
    };
  }

  async capabilities(profileVersion: string): Promise<Capabilities> {
    return {
      profileVersion: profileVersion || this.connection.profileVersion || 'sim-1.0',
      products: ['MERCHANT_PAYMENT', 'REFUND', 'REVERSAL', 'INQUIRY'],
      currencies: ['CDF', 'USD'],
      supportsInquiry: true,
      supportsReversal: true,
      supportsRefund: true,
      supportsDeferredCapture: false,
      notFoundDefinitiveAfterSeconds: 120,
      simulation: true,
    };
  }

  async submit(command: CanonicalPayment, stableMessageId: string): Promise<ExternalObservation> {
    if (!this.up) throw new SwitchTimeoutError(stableMessageId, false);
    if (this.store.has(stableMessageId)) {
      // contractual deduplication: the same stable id returns the same observation, never a second effect
      const rec = this.store.get(stableMessageId)!;
      return this.obs(rec.finalKind ?? 'PENDING', rec.finalKind === 'COMPLETED' ? '000' : 'P01', rec);
    }
    const scenario = this.scenarioOf(command.debtor.accountToken);
    const rec: SimRecord = { command, stableMessageId, externalReference: this.nextId('SIMREF'), correlationId: this.nextId('SIMCOR'), scenario, inquiries: 0, effect: false, finalKind: null };
    this.store.set(stableMessageId, rec);
    switch (scenario) {
      case 'tok_reject':
        rec.finalKind = 'REJECTED';
        return this.obs('REJECTED', 'R05', rec, { reason: 'Insufficient funds at the debtor institution' });
      case 'tok_timeout':
        rec.effect = true;
        rec.finalKind = 'COMPLETED';
        throw new SwitchTimeoutError(stableMessageId, true);
      case 'tok_timeout_nf':
        rec.effect = false;
        throw new SwitchTimeoutError(stableMessageId, false);
      case 'tok_unknown_code':
        return this.obs('UNKNOWN', 'Z99', rec);
      case 'tok_ack_only':
        return this.obs('ACK', 'A00', rec);
      case 'tok_authorized':
        rec.finalKind = 'AUTHORIZED';
        return this.obs('AUTHORIZED', 'A10', rec, { authority: 'DEBTOR' });
      case 'tok_pending':
        rec.finalKind = 'COMPLETED';
        return this.obs('PENDING', 'P01', rec);
      case 'tok_slow':
        rec.finalKind = 'COMPLETED';
        return this.obs('PENDING', 'P01', rec);
      case 'tok_dup':
      case 'tok_contradict':
      case 'tok_badsig':
        rec.effect = true;
        rec.finalKind = 'COMPLETED';
        return this.obs('ACK', 'A00', rec);
      default:
        rec.effect = true;
        rec.finalKind = 'COMPLETED';
        return this.obs('COMPLETED', '000', rec);
    }
  }

  async inquire(reference: ExternalReference): Promise<ExternalObservation> {
    if (!this.up) throw new SwitchTimeoutError(reference.stableMessageId, false);
    const rec = this.store.get(reference.stableMessageId);
    if (!rec) return this.obs('NOT_FOUND', 'N01', null, { stableMessageId: reference.stableMessageId, definitive: false });
    rec.inquiries += 1;
    switch (rec.scenario) {
      case 'tok_timeout_nf':
        return this.obs('NOT_FOUND', rec.inquiries >= 3 ? 'N02' : 'N01', rec, {
          definitive: rec.inquiries >= 3,
          reason: rec.inquiries >= 3 ? 'no record of this message: definitive per scheme rules' : 'no record yet: provisional',
        });
      case 'tok_slow':
        return rec.inquiries >= 3 ? this.obs('COMPLETED', '000', rec) : this.obs('PENDING', 'P01', rec);
      case 'tok_ack_only':
        return this.obs('PENDING', 'P01', rec);
      case 'tok_authorized':
        return this.obs('AUTHORIZED', 'A10', rec, { authority: 'DEBTOR' });
      case 'tok_reject':
        return this.obs('REJECTED', 'R05', rec, { reason: 'Insufficient funds at the debtor institution' });
      case 'tok_unknown_code':
        return this.obs('UNKNOWN', 'Z99', rec);
      default:
        return rec.effect || rec.finalKind === 'COMPLETED' ? this.obs('COMPLETED', '000', rec) : this.obs('PENDING', 'P01', rec);
    }
  }

  async requestReversal(command: ReversalCommand): Promise<ExternalObservation> {
    if (!this.up) throw new SwitchTimeoutError(command.stableMessageId, false);
    const rec = this.store.get(command.originalStableMessageId);
    if (!rec || rec.finalKind !== 'COMPLETED') return this.obs('REVERSAL_REJECTED', 'V01', rec ?? null, { stableMessageId: command.stableMessageId, reason: 'original not completed' });
    return this.obs('REVERSAL_COMPLETED', 'V00', rec, { stableMessageId: command.stableMessageId, externalMessageId: this.nextId('SIMMSG') });
  }

  async requestRefund(command: RefundCommand): Promise<ExternalObservation> {
    if (!this.up) throw new SwitchTimeoutError(command.stableMessageId, false);
    const rec = this.store.get(command.originalStableMessageId);
    if (!rec || rec.finalKind !== 'COMPLETED') return this.obs('REFUND_REJECTED', 'F01', rec ?? null, { stableMessageId: command.stableMessageId, reason: 'original not completed' });
    if (rec.scenario === 'tok_refund_unknown' || (command.reason ?? '').includes('simulate-timeout')) {
      this.refunds.set(command.stableMessageId, { scenario: 'timeout', externalReference: this.nextId('SIMRF') });
      throw new SwitchTimeoutError(command.stableMessageId, true);
    }
    return this.obs('REFUND_COMPLETED', 'F00', rec, { stableMessageId: command.stableMessageId, externalMessageId: this.nextId('SIMMSG'), externalReference: this.nextId('SIMRF') });
  }

  verifyAndDecodeInbound(raw: Uint8Array, transport: TransportEvidence): VerifiedObservation {
    let parsed: { body: any; mac: string };
    try {
      parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      return {
        kind: 'MALFORMED',
        externalCode: 'MALFORMED',
        externalMessageId: `malformed-${Date.now()}`,
        stableMessageId: null,
        externalReference: null,
        correlationId: null,
        authority: transport.source,
        amountMinor: null,
        currency: null,
        occurredAt: transport.receivedAt,
        receivedAt: transport.receivedAt,
        reason: 'unparseable message',
        signatureValid: false,
        raw: Buffer.from(raw).toString('base64'),
        transport,
        simulation: true,
      };
    }
    const expected = simSign(JSON.stringify(parsed.body));
    const valid = typeof parsed.mac === 'string' && parsed.mac.length === expected.length && timingSafeEqual(Buffer.from(parsed.mac), Buffer.from(expected));
    const b = parsed.body ?? {};
    return {
      kind: b.kind ?? 'UNKNOWN',
      externalCode: b.code ?? 'Z99',
      externalMessageId: b.externalMessageId ?? `inb-${Date.now()}`,
      stableMessageId: b.stableMessageId ?? null,
      externalReference: b.externalReference ?? null,
      correlationId: b.correlationId ?? null,
      authority: transport.source,
      amountMinor: b.amountMinor ?? null,
      currency: b.currency ?? null,
      occurredAt: b.occurredAt ?? transport.receivedAt,
      receivedAt: transport.receivedAt,
      reason: b.reason ?? null,
      signatureValid: valid,
      raw: Buffer.from(raw).toString('base64'),
      resolvesAuthorization: !!b.resolvesAuthorization,
      transport,
      simulation: true,
    };
  }

  /** Build inbound raw messages for scenarios (duplicate success, contradictory reject, bad signature, unknown code). */
  inboundFor(
    stableMessageId: string,
    variant: 'completed' | 'completed_dup' | 'reject_contradiction' | 'bad_signature' | 'unknown_code' | 'pending_stale' | 'tampered_same_id',
    opts: { externalMessageId?: string } = {},
  ): { raw: Uint8Array; externalMessageId: string } {
    const rec = this.store.get(stableMessageId);
    if (!rec) throw new AppError(404, 'simulator_unknown_message', 'The simulator has no record of this message');
    const externalMessageId = opts.externalMessageId ?? this.nextId('SIMINB');
    const body: Record<string, unknown> = {
      kind: 'COMPLETED',
      code: '000',
      externalMessageId,
      stableMessageId,
      externalReference: rec.externalReference,
      correlationId: rec.correlationId,
      amountMinor: rec.command.amountMinor,
      currency: rec.command.currency,
      occurredAt: new Date().toISOString(),
      simulation: true,
    };
    if (variant === 'reject_contradiction') Object.assign(body, { kind: 'REJECTED', code: 'R99', reason: 'late contradictory rejection (SIMULATION)' });
    if (variant === 'unknown_code') Object.assign(body, { kind: 'UNKNOWN', code: 'Q42' });
    if (variant === 'pending_stale') Object.assign(body, { kind: 'PENDING', code: 'P01', occurredAt: new Date(Date.now() - 60_000).toISOString() });
    if (variant === 'tampered_same_id') Object.assign(body, { amountMinor: String(Number(rec.command.amountMinor) + 100) });
    const payload = JSON.stringify(body);
    const mac = variant === 'bad_signature' ? simSign(payload).replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) : simSign(payload);
    return { raw: new Uint8Array(Buffer.from(JSON.stringify({ body, mac }))), externalMessageId };
  }

  async importReconciliation(input: VerifiedReport): Promise<ImportResult> {
    const lines = JSON.parse(Buffer.from(input.raw, 'base64').toString('utf8')) as any[];
    const out = lines.map((l) => ({
      externalReference: String(l.externalReference ?? l.ref ?? ''),
      correlationId: l.correlationId ?? null,
      debtorId: l.debtorId ?? null,
      creditorId: l.creditorId ?? null,
      amountMinor: String(l.amountMinor ?? l.amount ?? '0'),
      currency: String(l.currency ?? input.currency),
      status: String(l.status ?? 'COMPLETED'),
      feeMinor: l.feeMinor != null ? String(l.feeMinor) : null,
      settlementRef: l.settlementRef ?? null,
      businessDate: l.businessDate ?? null,
      occurredAt: l.occurredAt ?? null,
      raw: l,
    }));
    const total = out.reduce((s, l) => s + Number(l.amountMinor), 0);
    return { lines: out, controlTotalMinor: String(total), lineCount: out.length };
  }

  async health(): Promise<LinkHealth> {
    return { up: this.up, message: this.up ? 'SIMULATION link up' : 'SIMULATION link down (operator-induced)', latencyMs: 12, sessions: 1, quota: { perSecond: 20, used: 0 }, simulation: true };
  }

  /** Records for the operations console. */
  records() {
    return [...this.store.values()].map((r) => ({
      stableMessageId: r.stableMessageId,
      scenario: r.scenario,
      externalReference: r.externalReference,
      correlationId: r.correlationId,
      inquiries: r.inquiries,
      effect: r.effect,
      finalKind: r.finalKind,
    }));
  }
}

const simulators = new Map<string, SimulatorAdapter>();
export function simulatorFor(connection: Pick<SwitchConnection, 'id' | 'schemeId' | 'profileVersion' | 'simulatorScenarios'>): SimulatorAdapter {
  let s = simulators.get(connection.id);
  if (!s) {
    s = new SimulatorAdapter(connection);
    simulators.set(connection.id, s);
  }
  return s;
}

const REQUIRED_METHODS: (keyof NationalSwitchAdapter)[] = ['capabilities', 'submit', 'inquire', 'requestReversal', 'requestRefund', 'verifyAndDecodeInbound', 'importReconciliation', 'health'];
let certified: { modulePath: string; adapter: NationalSwitchAdapter } | null = null;

/**
 * The certified adapter is a separate module (delivered with the official profile, message vectors and joint tests)
 * exporting `createAdapter(connection)`. It is loaded only for CERTIFIED connections; without the module the
 * connection cannot emit — there is no emulation of a real switch.
 */
export function loadCertifiedAdapter(connection: SwitchConnection): NationalSwitchAdapter {
  if (connection.certification.status !== 'CERTIFIED')
    throw new AppError(409, 'connector_not_certified', `Connection ${connection.id} is ${connection.certification.status}; the certified adapter is only loaded once certification is CERTIFIED`);
  const modulePath = config.switch.adapterModule;
  if (!modulePath) throw new AppError(503, 'adapter_not_available', 'SWITCH_ADAPTER_MODULE is not configured: the official codec has not been delivered');
  if (certified && certified.modulePath === modulePath) return certified.adapter;
  const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(process.cwd(), modulePath);
  const mod = require(resolved);
  const factory = mod.createAdapter ?? mod.default?.createAdapter;
  if (typeof factory !== 'function') throw new AppError(503, 'adapter_invalid', 'The switch adapter module must export createAdapter(connection)');
  const adapter = factory(connection) as NationalSwitchAdapter;
  for (const m of REQUIRED_METHODS) if (typeof (adapter as any)[m] !== 'function') throw new AppError(503, 'adapter_invalid', `The switch adapter is missing ${m}()`);
  certified = { modulePath, adapter };
  return adapter;
}

export function adapterFor(connection: SwitchConnection): NationalSwitchAdapter {
  if (connection.adapter === 'simulator') {
    if (connection.environment === 'production') throw new AppError(409, 'connector_not_certified', 'The simulator never serves production traffic');
    return simulatorFor(connection);
  }
  return loadCertifiedAdapter(connection);
}
