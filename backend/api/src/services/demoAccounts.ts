/**
 * Test accounts for a demonstration: one customer, one merchant and one agent, created on the platform's own
 * database with verified KYC, a transaction PIN and sandbox balances. Refused outside sandbox compliance mode: these
 * balances are an administrator issuance approved by the same administrator, which the four-eyes rule forbids once
 * real money is in play. Idempotent per @tag: running it again reports the existing accounts and tops nothing up.
 * The contact details (phone or email) come from the operator; nothing is invented.
 */
import { badRequest, notFound } from '../lib/errors';
import { hashPassword } from '../lib/password';
import { randomBytes } from 'node:crypto';
import { createUser, findUserByEmail, findUserByPhone, findUserByTag, getUserById, updateUser, type UserRow } from './users';
import { upgradeToMerchant } from './merchant';
import { ensureOrganisation } from './organisations';
import { ensureWallet, listWallets } from './wallets';
import { proposeVerification, approveVerification } from './verification';
import { getComplianceSettings } from './settings';
import { config } from '../config';
import { recordEvent } from './events';

export type DemoRole = 'customer' | 'merchant' | 'agent';
export interface DemoAccountInput {
  role: DemoRole;
  /** Phone (E.164) and/or email of the person who will use the account during the test. */
  phone?: string | null;
  email?: string | null;
  /** Defaults: Client Test / Marché Test / Agent Test with tags clienttest / marchandtest / agenttest. */
  fullName?: string | null;
  tag?: string | null;
  businessName?: string | null;
  country?: string | null;
  password?: string | null;
  pin?: string | null;
}
export interface DemoAccountResult {
  role: DemoRole;
  created: boolean;
  id: string;
  tag: string;
  fullName: string;
  businessName: string | null;
  email: string | null;
  phone: string | null;
  /** Only present when the account was created in this run; never stored in clear. */
  password: string | null;
  pin: string | null;
  balances: { currency: string; balance: number }[];
  loginUrl: string;
}

const DEFAULTS: Record<DemoRole, { fullName: string; tag: string; businessName: string | null; funding: Record<string, number> }> = {
  customer: { fullName: 'Client Test', tag: 'clienttest', businessName: null, funding: { USD: 50_000, CDF: 50_000_000 } },
  merchant: { fullName: 'Marché Test', tag: 'marchandtest', businessName: 'Marché Test Kinshasa', funding: { USD: 20_000, CDF: 20_000_000 } },
  agent: { fullName: 'Agent Test', tag: 'agenttest', businessName: 'Agent Test Kinshasa', funding: { USD: 100_000, CDF: 100_000_000 } },
};

export function assertSandboxForDemoAccounts(): void {
  const mode = getComplianceSettings().mode;
  if (mode !== 'sandbox') throw badRequest(`Test accounts with sandbox balances are created in sandbox compliance mode only (current mode: ${mode})`, 'sandbox_required');
}

function fund(admin: UserRow, userId: string, currency: string, amountMinor: number): void {
  ensureWallet(userId, currency);
  const v = proposeVerification(admin, userId, {
    subjectType: 'issuance',
    action: 'confirm',
    note: 'Sandbox test-account funding',
    payload: { direction: 'credit', amount: amountMinor, currency, reason: 'Sandbox test-account funding (no real-world value)' },
  });
  // Sandbox only (asserted by the caller): the bootstrap administrator approves its own proposal.
  approveVerification(admin, v.id, undefined, { headers: {}, body: {} }, true);
}

/** Creates (or reports) one test account. `admin` is the administrator whose issuance funds it. */
export function createDemoAccount(admin: UserRow, input: DemoAccountInput): DemoAccountResult {
  assertSandboxForDemoAccounts();
  const d = DEFAULTS[input.role];
  const tag = (input.tag ?? d.tag).toLowerCase();
  const fullName = input.fullName?.trim() || d.fullName;
  const businessName = input.role === 'customer' ? null : input.businessName?.trim() || d.businessName;
  const country = (input.country ?? 'CD').toUpperCase(); // the demonstration market, whatever the seed country of the environment
  const loginUrl = `${config.webUrl}/login`;
  const existing = findUserByTag(tag) ?? (input.email ? findUserByEmail(input.email) : undefined) ?? (input.phone ? findUserByPhone(input.phone) : undefined);
  if (existing) {
    return {
      role: input.role,
      created: false,
      id: existing.id,
      tag: existing.tag,
      fullName: existing.full_name,
      businessName: existing.business_name ?? null,
      email: existing.email,
      phone: existing.phone,
      password: null,
      pin: null,
      balances: listWallets(existing.id).map((w) => ({ currency: w.currency, balance: w.balance })),
      loginUrl,
    };
  }
  if (!input.phone && !input.email) throw badRequest(`The ${input.role} test account needs the phone number or email of the person who will use it`, 'contact_required');
  const password = input.password?.trim() || `Test-${randomBytes(6).toString('base64url')}`;
  const pin = input.pin?.trim() || '1234';
  if (!/^\d{4,6}$/.test(pin)) throw badRequest('The PIN is 4 to 6 digits', 'invalid_pin');
  const role = input.role === 'customer' ? 'user' : input.role;
  let user = createUser({ email: input.email ?? null, phone: input.phone ?? null, fullName, role, tag, country, businessName, password, emailVerified: !!input.email, phoneVerified: !!input.phone });
  updateUser(user.id, { pin_hash: hashPassword(pin), kyc_status: 'verified', kyc_tier: 2 } as any);
  if (input.role === 'merchant') upgradeToMerchant(getUserById(user.id), businessName!);
  user = getUserById(user.id);
  if (input.role !== 'customer') ensureOrganisation(user); // the merchant's organisation and the agent's team
  for (const [currency, amount] of Object.entries(d.funding)) fund(admin, user.id, currency, amount);
  recordEvent('admin', user.id, 'demo_account.created', { type: 'admin', id: admin.id }, { role: input.role, tag, country, funding: d.funding });
  return {
    role: input.role,
    created: true,
    id: user.id,
    tag: user.tag,
    fullName: user.full_name,
    businessName: user.business_name ?? null,
    email: user.email,
    phone: user.phone,
    password,
    pin,
    balances: listWallets(user.id).map((w) => ({ currency: w.currency, balance: w.balance })),
    loginUrl,
  };
}

/** The three accounts of a demonstration in one go, funded by the bootstrap administrator. */
export function createDemoAccounts(inputs: DemoAccountInput[], adminEmail = config.admin.email): DemoAccountResult[] {
  assertSandboxForDemoAccounts();
  const admin = findUserByEmail(adminEmail);
  if (!admin || admin.role !== 'admin') throw notFound(`Administrator ${adminEmail} not found`, 'admin_not_found');
  return inputs.map((i) => createDemoAccount(admin, i));
}
