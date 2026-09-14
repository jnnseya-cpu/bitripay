/**
 * Go-live command: `npm run go-live` (root) or `npx tsx src/goLive.ts` here.
 * Boots the platform against the configured database, provisions the optional external rails whose credentials are in
 * the environment (connectivity-checked, enabled only when the check passes), prints the go-live checklist and the
 * gate-to-scale metrics, and exits 1 while a blocking item is open. Money movement itself (transfers, QR, cross-payments,
 * remittance) runs on the BitriPay digital rail and needs no bank, mobile-money or BTCPay API, so an empty environment
 * is a valid one. Nothing here invents readiness: an unconfigured rail stays off.
 */
import { bootstrap } from './app';
import { provisionRailsFromEnvironment } from './payments';
import { goLiveChecklist } from './services/goLive';
import { config } from './config';

async function main() {
  bootstrap();
  const rails = await provisionRailsFromEnvironment();
  console.log(`\nBitriPay go-live · ${config.env} · web ${config.webUrl} · admin ${config.adminUrl} · api ${config.apiUrl}\n`);
  console.log('Money movement: BitriPay digital rail (ledger, direct operator numbers, bank instructions, payout devices, agents) · no bank, mobile-money or BTCPay API required');
  const configured = rails.filter((r) => r.outcome !== 'skipped');
  console.log(`Optional external rails from the environment${configured.length ? '' : ': none (nothing required)'}`);
  for (const r of configured) console.log(`  ${r.outcome === 'enabled' || r.outcome === 'configured' ? '✓' : '✗'} ${r.gatewayId.padEnd(12)} ${r.outcome.padEnd(11)} ${r.mode.padEnd(8)} ${r.message}`);
  const check = goLiveChecklist();
  console.log(`\nChecklist (compliance mode: ${check.mode})`);
  for (const i of check.items) console.log(`  ${i.ok ? '✓' : i.blocking ? '✗' : '!'} ${i.label}\n      ${i.detail}${i.ok ? '' : `\n      → ${i.fix}`}`);
  console.log(`\nGate to scale: ${check.gateToScale.ready ? 'ready' : 'not yet'}`);
  for (const i of check.gateToScale.items) console.log(`  ${i.ok ? '✓' : '·'} ${i.label}: ${i.detail}`);
  console.log(`\n${check.readyForLive ? 'READY: every blocking item is green.' : 'NOT READY: fix the ✗ items above, then run again.'}`);
  process.exit(check.readyForLive ? 0 : 1);
}

void main().catch((err) => {
  console.error('[go-live] failed', (err as Error).message);
  process.exit(2);
});
