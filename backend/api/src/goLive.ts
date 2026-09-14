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
import { getAppSettings } from './services/settings';
import { rateFreshness, refreshRatesFromProvider } from './services/currencies';
import { refreshAllSources } from './services/risk/compliance';
import { applyGoLiveProfileDocument } from './services/goLiveProfile';
import { findUserByEmail } from './services/users';
import { readFileSync } from 'node:fs';

async function main() {
  bootstrap();
  const rails = await provisionRailsFromEnvironment();
  // The API loads live rates and the official sanctions lists in the background at start-up; the command waits for
  // those first loads so the checklist below reflects them (a failed fetch is reported on its line, never hidden).
  const app = getAppSettings();
  if (app.rateProvider !== 'manual' && !rateFreshness().live) {
    try {
      const r = await refreshRatesFromProvider();
      console.log(`Exchange rates: ${r.updated.length} refreshed from ${r.provider}`);
    } catch (err) {
      console.warn(`Exchange rates: refresh from ${app.rateProvider} failed (${(err as Error).message})`);
    }
  }
  const lists = await refreshAllSources({ onlyNeverRefreshed: true });
  if (lists.refreshed) console.log(`Sanctions lists: ${lists.refreshed} loaded`);
  if (lists.failed.length) console.warn(`Sanctions lists not loaded: ${lists.failed.join('; ')}`);
  // Go-live profile (GO_LIVE_PROFILE=/path/to/go-live.profile.json or first argument): the launch records, applied
  // digitally on behalf of the bootstrap administrator; the human-only steps are printed under "Still yours".
  const profilePath = process.argv[2] || process.env.GO_LIVE_PROFILE;
  if (profilePath) {
    const admin = findUserByEmail(config.admin.email);
    if (!admin) throw new Error(`bootstrap administrator ${config.admin.email} not found`);
    const report = applyGoLiveProfileDocument(readFileSync(profilePath, 'utf8'), admin);
    console.log(`\nGo-live profile ${profilePath}`);
    for (const l of report.lines)
      console.log(`  ${l.action === 'skipped' ? '✗' : l.action === 'unchanged' ? '·' : '✓'} ${l.section.padEnd(18)} ${l.action.padEnd(9)} ${l.subject}${l.note ? ` — ${l.note}` : ''}`);
    for (const g of report.generatedPasswords) console.log(`  ! ${g.email}: temporary password ${g.password} (shown once; they change it at first sign-in)`);
    if (report.remaining.length) {
      console.log('  Still yours (people, PINs, funds, phones):');
      for (const r of report.remaining) console.log(`    → ${r}`);
    }
  }
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
