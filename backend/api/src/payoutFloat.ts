/**
 * Prefunded payout float for a demonstration:
 *   npm run payout-float -- --operator orange_cd --msisdn +243… --amount 1000000 [--currency CDF] [--label …] [--reference …]
 * (root, runs inside the API container on a deployed host) or `npx tsx src/payoutFloat.ts …` here.
 * Creates the payout account for that operator SIM if it does not exist, adds the float, and re-queues every
 * transfer waiting for liquidity on that operator. Sandbox compliance mode only.
 */
import { bootstrap } from './app';
import { ensurePayoutFloat } from './services/payoutFloat';
import { getCurrency } from './services/currencies';
import { getOperator } from './services/momo';
import { formatMoney, toMinor } from '@bitripay/shared';

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
  if (!args.operator || !args.msisdn || !args.amount) {
    console.error('Usage: npm run payout-float -- --operator orange_cd --msisdn +243… --amount 1000000 [--currency CDF] [--country CD] [--label "Orange Money DRC – SIM 1"] [--reference …]');
    process.exit(2);
  }
  bootstrap();
  const op = getOperator(args.operator);
  const cur = getCurrency((args.currency ?? op.currency).toUpperCase());
  const r = ensurePayoutFloat({
    operatorId: op.id,
    msisdn: args.msisdn,
    currency: cur.code,
    country: args.country ?? null,
    label: args.label ?? null,
    amountMinor: toMinor(args.amount, cur.decimals),
    reference: args.reference ?? null,
  });
  console.log('');
  console.log(`PAYOUT ACCOUNT — ${r.created ? 'created' : 'already existed'}`);
  console.log(`  label     ${r.account.label}   (${r.account.operatorName} · ${r.account.country} · ${r.account.currency})`);
  console.log(`  SIM       ${r.account.msisdn}`);
  console.log(`  float     +${formatMoney(r.prefunded, cur)} → balance ${formatMoney(r.account.balance, cur)}`);
  console.log(`  re-queued ${r.requeued} transfer(s) that were waiting for liquidity`);
  console.log('\nTransfers to this operator now land in the console under Corridors, liquidity & payouts → Payout instructions.');
  console.log('Sandbox float has no real-world value; the platform stays in sandbox compliance mode.');
}

main();
