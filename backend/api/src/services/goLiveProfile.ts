/**
 * Go-live profile: the operational records a launch needs (bank details, collection numbers, e-money programmes,
 * payout accounts, corridor arrangements, a second administrator, SMTP), written once as JSON and applied digitally
 * by `npm run go-live` or from the console, instead of a day of forms. Every value comes from the operator's file;
 * nothing is invented. Applying is idempotent: records are matched on their natural key and updated, never
 * duplicated. Actions that must stay human stay human: PINs and 2FA, clearing reserve funding, pressing Go live on a
 * corridor and enrolling a payout device are listed in `remaining`, never performed here.
 */
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { getDb } from '../db';
import { upsertGateway, getGateway } from '../payments';
import { listCurrencies, upsertCurrency } from './currencies';
import { provisionDirectRailsFromEnvironment } from './momo';
import { upsertProgramme, listProgrammes } from './emoney';
import { createPayoutAccount, listPayoutAccounts, updatePayoutAccount } from './liquidity';
import { upsertCorridor, listCorridors } from './corridors';
import { createUser, findUserByEmail, updateUser, type UserRow } from './users';
import { setSetting, getFees, getAppSettings } from './settings';
import { FEE_TYPES } from '@bitripay/shared';
import { hasPermission } from '../middleware/permissions';
import type { Actor } from './events';

const code = z
  .string()
  .length(3)
  .transform((v) => v.toUpperCase());
const country = z
  .string()
  .length(2)
  .transform((v) => v.toUpperCase());

export const goLiveProfileSchema = z.object({
  bankTransfer: z
    .object({
      bankName: z.string().min(2).max(120),
      accountName: z.string().min(2).max(120),
      accountNumber: z.string().min(4).max(64),
      swift: z.string().max(40).optional().nullable(),
      instructions: z.string().max(500).optional().nullable(),
    })
    .optional(),
  currencies: z.object({ enable: z.array(code).optional(), disable: z.array(code).optional() }).optional(),
  collectionNumbers: z.array(z.object({ operatorId: z.string().min(2), collectionNumber: z.string().min(5).max(24), collectionName: z.string().max(120).optional().nullable() })).optional(),
  emoneyProgrammes: z
    .array(
      z.object({
        currency: code,
        jurisdiction: country,
        issuerModel: z.enum(['own_authorisation', 'partner_issuer']),
        issuerName: z.string().min(2).max(160),
        licenceRef: z.string().min(2).max(120),
        regulator: z.string().min(2).max(160),
        safeguardingBank: z.string().min(2).max(160),
        safeguardingAccountRef: z.string().min(2).max(120),
      }),
    )
    .optional(),
  payoutAccounts: z
    .array(
      z.object({
        rail: z.enum(['mobile_money', 'bank']),
        operatorId: z.string().optional().nullable(),
        country,
        currency: code,
        label: z.string().min(2).max(120),
        msisdn: z.string().max(24).optional().nullable(),
        simIccid: z.string().max(32).optional().nullable(),
        bankName: z.string().max(120).optional().nullable(),
        accountNumber: z.string().max(64).optional().nullable(),
        dailyLimit: z.number().int().min(0).optional(),
        perTxLimit: z.number().int().min(0).optional(),
      }),
    )
    .optional(),
  corridors: z
    .array(
      z.object({
        sourceCountry: country.optional().nullable(),
        sourceCurrency: code,
        destCountry: country,
        destCurrency: code,
        rail: z.enum(['mobile_money', 'bank', 'agent']).default('mobile_money'),
        operatorId: z.string().optional().nullable(),
        collectionPartner: z.string().min(2).max(200),
        payoutPartner: z.string().min(2).max(200),
        licenceRef: z.string().min(2).max(200),
        licenceExpiresAt: z.string().datetime({ offset: true }),
        compliance: z.object({
          regulator: z.string().min(2),
          licenceType: z.string().min(2),
          licenceNumber: z.string().min(1),
          safeguardingAccount: z.string().min(2),
          amlProgrammeRef: z.string().min(1),
          dataProtectionRef: z.string().optional().nullable(),
          fxApprovalRef: z.string().optional().nullable(),
          consumerDisclosureUrl: z.string().url().optional().nullable(),
          agentSupervisionRef: z.string().optional().nullable(),
        }),
        payoutCurrencies: z.array(code).optional(),
        maxAmount: z.number().int().min(0).optional(),
        estimatedPayoutMinutes: z.number().int().min(1).optional(),
      }),
    )
    .optional(),
  administrators: z
    .array(
      z.object({
        fullName: z.string().min(2).max(120),
        email: z.string().email(),
        password: z.string().min(12).max(200).optional(),
        permissions: z.array(z.string()).default(['approvals', 'issuance', 'treasury', 'settings', 'gateways', 'kyc', 'users', 'transactions']),
      }),
    )
    .optional(),
  smtp: z.object({ host: z.string().min(2), port: z.number().int().min(1).max(65535).default(587), user: z.string().default(''), pass: z.string().default(''), from: z.string().min(3) }).optional(),
  /** Tariff grid per operation: fee in basis points, fixed part / amount band in base-currency minor units, agent commission in bps. */
  fees: z
    .record(
      z.enum(FEE_TYPES),
      z.object({
        bps: z.number().int().min(0).max(10000),
        fixed: z.number().int().min(0).default(0),
        minAmount: z.number().int().min(0).optional(),
        maxAmount: z.number().int().min(0).optional(),
        agentBps: z.number().int().min(0).max(10000).optional(),
      }),
    )
    .optional(),
  /** Platform-wide pricing knobs: P2P exchange trade fee, default agent commission and the FX margin, all in bps. */
  pricing: z
    .object({
      p2pFeeBps: z.number().int().min(0).max(10000).optional(),
      agentCommissionBps: z.number().int().min(0).max(10000).optional(),
      exchangeMarginBps: z.number().int().min(0).max(10000).optional(),
    })
    .optional(),
});
export type GoLiveProfile = z.infer<typeof goLiveProfileSchema>;

export interface ProfileLine {
  section: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped';
  subject: string;
  note?: string;
}
export interface ProfileReport {
  lines: ProfileLine[];
  /** Steps that stay with people: PINs, 2FA, clearing reserves, pressing Go live, enrolling devices. */
  remaining: string[];
  /** Generated passwords of administrators created without one; shown once, never stored in clear. */
  generatedPasswords: { email: string; password: string }[];
}

const generatePassword = () => randomBytes(15).toString('base64url');

/** Apply a validated profile. `admin` is the administrator applying it (CLI: the bootstrap administrator). */
export function applyGoLiveProfile(profile: GoLiveProfile, admin: UserRow): ProfileReport {
  const actor: Actor = { type: 'admin', id: admin.id };
  const lines: ProfileLine[] = [];
  const remaining: string[] = [];
  const generatedPasswords: { email: string; password: string }[] = [];

  if (profile.currencies) {
    const all = listCurrencies(false);
    for (const [flag, codes] of [
      [true, profile.currencies.enable ?? []],
      [false, profile.currencies.disable ?? []],
    ] as const) {
      for (const c of codes) {
        const row = all.find((x) => x.code === c);
        if (!row) {
          lines.push({ section: 'currencies', action: 'skipped', subject: c, note: 'unknown currency code' });
          continue;
        }
        if (row.enabled === flag) {
          lines.push({ section: 'currencies', action: 'unchanged', subject: c });
          continue;
        }
        upsertCurrency({ code: row.code, name: row.name, symbol: row.symbol, decimals: row.decimals, rateToBase: row.rateToBase, enabled: flag, sortOrder: row.sortOrder });
        lines.push({ section: 'currencies', action: 'updated', subject: c, note: flag ? 'enabled' : 'disabled' });
      }
    }
  }

  if (profile.bankTransfer) {
    const g = getGateway('manual_bank');
    const b = profile.bankTransfer;
    const credentials = { bankName: b.bankName, accountName: b.accountName, accountNumber: b.accountNumber, swift: b.swift ?? '', instructions: b.instructions ?? '' };
    upsertGateway({
      id: 'manual_bank',
      name: g?.name ?? 'Bank transfer',
      provider: 'manual_bank',
      enabled: true,
      methods: g?.methods ?? ['bank'],
      currencies: g?.currencies ?? [],
      countries: g?.countries,
      credentials,
      config: g?.config,
      sortOrder: g?.sortOrder ?? 6,
    });
    lines.push({ section: 'bankTransfer', action: g?.configuredKeys.includes('accountNumber') ? 'updated' : 'created', subject: `${b.bankName} · ${b.accountNumber}` });
  }

  if (profile.collectionNumbers?.length) {
    const r = provisionDirectRailsFromEnvironment(profile.collectionNumbers.map((c) => ({ operatorId: c.operatorId, collectionNumber: c.collectionNumber, collectionName: c.collectionName ?? null })));
    for (const c of profile.collectionNumbers) {
      const action = r.provisioned.includes(c.operatorId) ? 'created' : r.unknown.includes(c.operatorId) ? 'skipped' : r.kept.includes(c.operatorId) ? 'skipped' : 'unchanged';
      lines.push({
        section: 'collectionNumbers',
        action,
        subject: `${c.operatorId} ${c.collectionNumber}`,
        note: r.unknown.includes(c.operatorId) ? 'unknown operator id' : r.kept.includes(c.operatorId) ? 'an administrator already set a different number; kept theirs' : undefined,
      });
    }
  }

  if (profile.emoneyProgrammes?.length) {
    for (const p of profile.emoneyProgrammes) {
      const before = listProgrammes().find((x) => x.currency === p.currency && x.jurisdiction === p.jurisdiction);
      const prog = upsertProgramme({ ...(before ? { id: before.id } : {}), ...p }, admin);
      lines.push({
        section: 'emoneyProgrammes',
        action: before ? 'updated' : 'created',
        subject: `${prog.currency}/${prog.jurisdiction}`,
        note: prog.readiness.ready ? 'arrangements complete' : `missing: ${prog.readiness.missing.join(', ')}`,
      });
      remaining.push(`E-money ${prog.currency}: record the reserve funding (E-money → Reserves) and have the second administrator clear it with their PIN`);
    }
  }

  if (profile.payoutAccounts?.length) {
    for (const a of profile.payoutAccounts) {
      const existing = listPayoutAccounts().find((x) => x.label === a.label || (a.msisdn && x.msisdn === a.msisdn));
      if (existing) {
        updatePayoutAccount(
          existing.id,
          {
            label: a.label,
            msisdn: a.msisdn ?? existing.msisdn,
            simIccid: a.simIccid ?? existing.simIccid,
            dailyLimit: a.dailyLimit ?? existing.dailyLimit,
            perTxLimit: a.perTxLimit ?? existing.perTxLimit,
          },
          actor,
        );
        lines.push({ section: 'payoutAccounts', action: 'updated', subject: a.label });
      } else {
        try {
          createPayoutAccount(a, actor);
          lines.push({ section: 'payoutAccounts', action: 'created', subject: a.label });
        } catch (err) {
          lines.push({ section: 'payoutAccounts', action: 'skipped', subject: a.label, note: (err as Error).message });
          continue;
        }
      }
      remaining.push(`Payout account "${a.label}": prefund the float (Corridors → Liquidity → Prefund) and enrol the phone that holds the SIM with the payout-device app`);
    }
  }

  if (profile.corridors?.length) {
    for (const c of profile.corridors) {
      const before = listCorridors().find(
        (x) => x.sourceCurrency === c.sourceCurrency && x.destCountry === c.destCountry && x.destCurrency === c.destCurrency && x.rail === c.rail && (x.operatorId ?? null) === (c.operatorId ?? null),
      );
      const corridor = upsertCorridor({ ...(before ? { id: before.id } : {}), ...c, enabled: true }, actor);
      lines.push({
        section: 'corridors',
        action: before ? 'updated' : 'created',
        subject: `${corridor.sourceCurrency}→${corridor.destCountry} ${corridor.destCurrency}${corridor.operatorId ? ` via ${corridor.operatorId}` : ''}`,
        note: corridor.readiness.ready ? 'arrangements complete' : `missing: ${corridor.readiness.missing.join(', ')}`,
      });
      remaining.push(`Corridor ${corridor.sourceCurrency}→${corridor.destCountry}: press Go live (Corridors) with your PIN once the payout float is in place`);
    }
  }

  if (profile.administrators?.length) {
    for (const a of profile.administrators) {
      const existing = findUserByEmail(a.email);
      if (existing) {
        const merged = Array.from(new Set([...((JSON.parse((existing as any).permissions || '[]') as string[]) ?? []), ...a.permissions]));
        if (existing.role !== 'admin') {
          lines.push({ section: 'administrators', action: 'skipped', subject: a.email, note: `account exists with role ${existing.role}` });
          continue;
        }
        updateUser(existing.id, { permissions: JSON.stringify(merged) } as any);
        lines.push({ section: 'administrators', action: 'updated', subject: a.email, note: `permissions: ${merged.join(', ')}` });
      } else {
        const password = a.password ?? generatePassword();
        const user = createUser({ fullName: a.fullName, email: a.email, password, role: 'admin', emailVerified: true });
        updateUser(user.id, { permissions: JSON.stringify(a.permissions) } as any);
        if (!a.password) generatedPasswords.push({ email: a.email, password });
        lines.push({ section: 'administrators', action: 'created', subject: a.email, note: `permissions: ${a.permissions.join(', ')}` });
      }
      remaining.push(`${a.email}: sign in, set up two-factor authentication and save a step-up PIN (My profile)`);
    }
  }

  if (profile.smtp) {
    setSetting('smtp', { ...profile.smtp, secure: profile.smtp.port === 465 });
    lines.push({ section: 'smtp', action: 'updated', subject: `${profile.smtp.host}:${profile.smtp.port}` });
  }

  if (profile.fees) {
    const current = getFees();
    const next = { ...current };
    for (const [type, rule] of Object.entries(profile.fees)) {
      if (!rule) continue;
      const before = current[type];
      const same =
        before &&
        before.bps === rule.bps &&
        before.fixed === rule.fixed &&
        (before.minAmount ?? 0) === (rule.minAmount ?? 0) &&
        (before.maxAmount ?? 0) === (rule.maxAmount ?? 0) &&
        before.agentBps === rule.agentBps;
      next[type] = { fixed: rule.fixed, bps: rule.bps, minAmount: rule.minAmount, maxAmount: rule.maxAmount, agentBps: rule.agentBps };
      lines.push({
        section: 'fees',
        action: same ? 'unchanged' : 'updated',
        subject: type,
        note: `${rule.bps / 100}%${rule.fixed ? ` + fixed ${rule.fixed}` : ''}${rule.agentBps !== undefined ? ` · agent ${rule.agentBps / 100}%` : ''}`,
      });
    }
    setSetting('fees', next);
  }
  if (profile.pricing) {
    const app = getAppSettings();
    setSetting('app', { ...app, ...profile.pricing });
    lines.push({
      section: 'pricing',
      action: 'updated',
      subject: Object.entries(profile.pricing)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
    });
  }

  // The applying administrator's own human steps.
  if (!admin.pin_hash || !admin.two_factor_enabled) remaining.push(`${admin.email ?? admin.full_name}: set up two-factor authentication and save a step-up PIN (My profile)`);
  const approvers = (getDb().prepare("SELECT id, permissions, pin_hash FROM users WHERE role = 'admin' AND is_system = 0 AND status = 'active'").all() as any[]).filter(
    (u) => hasPermission(u, 'approvals') && u.pin_hash,
  );
  if (approvers.length < 2) remaining.push('Maker-checker: two administrators with the approvals and issuance permissions must each hold a PIN');
  return { lines, remaining: Array.from(new Set(remaining)), generatedPasswords };
}

/** Parse, validate and apply a profile document (JSON text or object). */
export function applyGoLiveProfileDocument(doc: unknown, admin: UserRow): ProfileReport {
  const parsed = goLiveProfileSchema.safeParse(typeof doc === 'string' ? JSON.parse(doc) : doc);
  if (!parsed.success) throw new Error(`Go-live profile is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return applyGoLiveProfile(parsed.data, admin);
}
