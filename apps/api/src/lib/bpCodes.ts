/**
 * Public error catalogue. Every API error keeps its descriptive `code`; the `bp` field adds the stable numeric
 * family partners can branch on: BP-1xxx authentication, 2xxx validation, 3xxx ledger, 4xxx rail, 5xxx compliance,
 * 6xxx intelligence / ACU. Unknown codes fall back to the family of their HTTP status.
 */
export const BP_CODES: Record<string, string> = {
  unauthorized: 'BP-1001',
  invalid_credentials: 'BP-1002',
  invalid_pin: 'BP-1003',
  pin_required: 'BP-1004',
  two_factor_required: 'BP-1005',
  scope_denied: 'BP-1006',
  forbidden: 'BP-1007',
  role_required: 'BP-1008',
  step_up_required: 'BP-1010',
  validation_error: 'BP-2001',
  bad_request: 'BP-2002',
  invalid_amount: 'BP-2003',
  invalid_json: 'BP-2004',
  idempotency_key_reused: 'BP-2005',
  not_found: 'BP-2006',
  conflict: 'BP-2007',
  insufficient_funds: 'BP-3001',
  wallet_frozen: 'BP-3002',
  limit_exceeded: 'BP-3003',
  daily_limit_exceeded: 'BP-3004',
  invalid_fee: 'BP-3005',
  guardian_halt: 'BP-3006',
  hold_released: 'BP-3007',
  cycle_not_payable: 'BP-3008',
  payout_unavailable: 'BP-4001',
  connector_unavailable: 'BP-4002',
  rail_unavailable: 'BP-4003',
  route_refused: 'BP-4004',
  degraded_mode: 'BP-4005',
  risk_blocked: 'BP-5001',
  velocity_limit: 'BP-5002',
  cooling_off: 'BP-5003',
  kyc_required: 'BP-5004',
  kyc_tier_limit: 'BP-5005',
  monthly_limit_exceeded: 'BP-5006',
  kyb_required: 'BP-5007',
  sanctions_hit: 'BP-5008',
  fraud_review: 'BP-5009',
  destination_cooling: 'BP-5010',
  destination_locked: 'BP-5011',
  compliance_hold: 'BP-5012',
  module_disabled: 'BP-5013',
  margin_protection_violation: 'BP-6001',
  neural_quota_exceeded: 'BP-6002',
  provider_unavailable: 'BP-6003',
  output_schema_invalid: 'BP-6004',
  rate_limited: 'BP-6005',
  addon_required: 'BP-6006',
};

export function bpCode(code: string, status: number): string {
  if (BP_CODES[code]) return BP_CODES[code];
  if (status === 401) return 'BP-1000';
  if (status === 403) return 'BP-1000';
  if (status === 400 || status === 404 || status === 409 || status === 413) return 'BP-2000';
  if (status === 422) return 'BP-3000';
  if (status === 429) return 'BP-6000';
  if (status === 502 || status === 503 || status === 504) return 'BP-4000';
  return 'BP-9000';
}
