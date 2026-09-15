/**
 * Test accounts for a demonstration: `npm run demo-accounts -- --customer +243… --merchant +243… --agent +243…`
 * (root, runs inside the API container on a deployed host) or `npx tsx src/demoAccounts.ts …` here.
 * Each role takes a phone number or an email (the person who will use the account during the test); optional
 * `--<role>-email`, `--password`, `--pin`, `--country`. Sandbox compliance mode only; idempotent per account.
 */
import { bootstrap } from './app';
import { createDemoAccounts, type DemoAccountInput, type DemoRole } from './services/demoAccounts';
import { formatMoney } from '@bitripay/shared';
import { getCurrency } from './services/currencies';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = 'true';
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const roles: DemoRole[] = ['customer', 'merchant', 'agent'];
  const inputs: DemoAccountInput[] = roles
    .filter((r) => args[r] || args[`${r}-email`])
    .map((r) => {
      const contact = args[r] ?? '';
      const isEmail = contact.includes('@');
      return {
        role: r,
        phone: !isEmail && contact ? contact : null,
        email: isEmail ? contact : (args[`${r}-email`] ?? null),
        fullName: args[`${r}-name`] ?? null,
        businessName: args[`${r}-business`] ?? null,
        tag: args[`${r}-tag`] ?? null,
        country: args.country ?? null,
        password: args.password ?? null,
        pin: args.pin ?? null,
      };
    });
  if (!inputs.length) {
    console.error('Usage: npm run demo-accounts -- --customer <phone|email> --merchant <phone|email> --agent <phone|email> [--password …] [--pin 1234] [--country CD]');
    console.error('       optional per role: --customer-name, --merchant-business, --agent-business, --<role>-tag, --<role>-email');
    process.exit(2);
  }
  bootstrap();
  const results = createDemoAccounts(inputs);
  console.log('');
  for (const r of results) {
    console.log(`${r.role.toUpperCase()} — ${r.created ? 'created' : 'already existed (unchanged)'}`);
    console.log(`  name      ${r.fullName}${r.businessName ? ` · ${r.businessName}` : ''}   @${r.tag}`);
    console.log(`  sign in   ${r.loginUrl}   with ${[r.phone, r.email].filter(Boolean).join(' or ')}`);
    if (r.created) console.log(`  password  ${r.password}   PIN ${r.pin}   (shown once; change them after the test)`);
    console.log(`  balances  ${r.balances.map((b) => formatMoney(b.balance, getCurrency(b.currency))).join(' · ') || 'none'}`);
  }
  console.log('\nSandbox balances have no real-world value; the platform stays in sandbox compliance mode.');
}

main();
