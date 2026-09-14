import { getDb } from './db';
import { upsertBiller, upsertOperator, upsertGiftProduct } from './services/services';

/** Starter catalogs so bill pay, top-up and gift cards work out of the box. Admins edit them in the panel. */
export function seedDefaultCatalogs() {
  const db = getDb();
  if ((db.prepare('SELECT COUNT(*) c FROM billers').get() as any).c === 0) {
    const billers = [
      ['electricity', 'National Power Company', 'US', 'USD', 500, 500000, 0, 'Meter number', '#f59e0b'],
      ['water', 'City Water Utility', 'US', 'USD', 500, 200000, 0, 'Customer ID', '#0ea5e9'],
      ['internet', 'FiberNet Broadband', 'US', 'USD', 1000, 100000, 0, 'Account number', '#6366f1'],
      ['tv', 'StreamTV Subscription', 'US', 'USD', 500, 50000, 0, 'Smartcard number', '#ec4899'],
      ['electricity', 'Ikeja Electric', 'NG', 'NGN', 100000, 50000000, 0, 'Meter number', '#f59e0b'],
      ['tv', 'DStv', 'NG', 'NGN', 200000, 5000000, 0, 'Smartcard number', '#ec4899'],
      ['electricity', 'Kenya Power (KPLC)', 'KE', 'KES', 10000, 5000000, 0, 'Meter number', '#f59e0b'],
      ['water', 'Nairobi Water', 'KE', 'KES', 10000, 2000000, 0, 'Account number', '#0ea5e9'],
      ['electricity', 'ECG PowerPay', 'GH', 'GHS', 500, 500000, 0, 'Meter number', '#f59e0b'],
    ] as const;
    for (const [category, name, country, currency, min, max, fee, label, color] of billers)
      upsertBiller({ category, name, country, currency, minAmount: min, maxAmount: max, feeBps: fee, accountLabel: label, enabled: true, color });
  }
  if ((db.prepare('SELECT COUNT(*) c FROM topup_operators').get() as any).c === 0) {
    const ops = [
      ['AT&T Prepaid', 'US', 'USD', 500, 10000, [1000, 2000, 3000, 5000], '#0ea5e9'],
      ['T-Mobile Prepaid', 'US', 'USD', 500, 10000, [1000, 2500, 5000], '#ec4899'],
      ['MTN', 'NG', 'NGN', 10000, 2000000, [10000, 20000, 50000, 100000], '#facc15'],
      ['Airtel', 'NG', 'NGN', 10000, 2000000, [10000, 20000, 50000, 100000], '#ef4444'],
      ['Glo', 'NG', 'NGN', 10000, 2000000, [10000, 20000, 50000], '#22c55e'],
      ['Safaricom', 'KE', 'KES', 1000, 1000000, [5000, 10000, 20000, 50000], '#16a34a'],
      ['Airtel Kenya', 'KE', 'KES', 1000, 1000000, [5000, 10000, 20000], '#ef4444'],
      ['MTN Ghana', 'GH', 'GHS', 100, 100000, [500, 1000, 2000, 5000], '#facc15'],
      ['Vodafone Ghana', 'GH', 'GHS', 100, 100000, [500, 1000, 2000], '#dc2626'],
      ['Jio', 'IN', 'INR', 1000, 500000, [14900, 23900, 29900, 66600], '#1d4ed8'],
      ['Grameenphone', 'BD', 'BDT', 1000, 500000, [2000, 5000, 10000], '#0ea5e9'],
      ['Globe', 'PH', 'PHP', 1000, 500000, [5000, 10000, 30000], '#1d4ed8'],
    ] as const;
    for (const [name, country, currency, min, max, den, color] of ops) upsertOperator({ name, country, currency, minAmount: min, maxAmount: max, denominations: [...den], enabled: true, color });
  }
  if ((db.prepare('SELECT COUNT(*) c FROM gift_card_products').get() as any).c === 0) {
    const products = [
      ['Amazon', 'Amazon Gift Card', 'shopping', 'USD', [1000, 2500, 5000, 10000], '#f59e0b', 'Shop millions of items on Amazon.com'],
      ['Apple', 'App Store & iTunes', 'entertainment', 'USD', [1000, 2500, 5000, 10000], '#111827', 'Apps, games, music and more'],
      ['Google Play', 'Google Play Gift Code', 'entertainment', 'USD', [1000, 2500, 5000], '#16a34a', 'Apps, games and digital content'],
      ['Netflix', 'Netflix Gift Card', 'entertainment', 'USD', [2500, 5000, 10000], '#dc2626', 'Stream movies and series'],
      ['Spotify', 'Spotify Premium', 'entertainment', 'USD', [1000, 3000, 6000], '#22c55e', 'Ad-free music streaming'],
      ['Steam', 'Steam Wallet Code', 'gaming', 'USD', [2000, 5000, 10000], '#1e3a8a', 'PC games and in-game items'],
      ['PlayStation', 'PlayStation Store', 'gaming', 'USD', [1000, 2500, 5000, 10000], '#1d4ed8', 'Games, add-ons and subscriptions'],
      ['Uber', 'Uber Gift Card', 'travel', 'USD', [2500, 5000, 10000], '#111827', 'Rides and Uber Eats'],
      ['Jumia', 'Jumia Voucher', 'shopping', 'NGN', [500000, 1000000, 2500000], '#f97316', "Africa's leading online marketplace"],
    ] as const;
    for (const [brand, name, category, currency, den, color, description] of products)
      upsertGiftProduct({ brand, name, category, currency, denominations: [...den], color, enabled: true, description });
  }
  ensureDrcCatalogs();
}

/**
 * Home-market catalogues for the Democratic Republic of the Congo, added by name whenever missing (also on a database
 * seeded before they existed); an administrator's edits or deletions of other entries are never touched. Amounts are
 * CDF minor units (1 CDF = 100). Stable ids keep re-runs idempotent.
 */
export function ensureDrcCatalogs() {
  const db = getDb();
  const hasBiller = db.prepare("SELECT 1 FROM billers WHERE country = 'CD' AND name = ?");
  const billers = [
    ['drc_snel', 'electricity', "SNEL (Société nationale d'électricité)", 100_000, 500_000_000, 'Numéro de compteur / police', '#f59e0b'],
    ['drc_regideso', 'water', 'REGIDESO', 100_000, 200_000_000, "Numéro d'abonné", '#0ea5e9'],
    ['drc_canalplus', 'tv', 'Canal+ Afrique', 500_000, 100_000_000, 'Numéro de décodeur', '#111827'],
    ['drc_dstv', 'tv', 'DStv (MultiChoice)', 500_000, 100_000_000, 'Numéro de smartcard', '#ec4899'],
    ['drc_startimes', 'tv', 'StarTimes', 200_000, 50_000_000, 'Numéro de smartcard', '#f97316'],
    ['drc_vodanet', 'internet', 'Vodacom Internet (Vodanet)', 200_000, 100_000_000, 'Numéro de compte', '#dc2626'],
    ['drc_orange_internet', 'internet', 'Orange Internet', 200_000, 100_000_000, 'Numéro de compte', '#f97316'],
    ['drc_liquid_home', 'internet', 'Liquid Home Fibre', 500_000, 200_000_000, 'Numéro de compte', '#6366f1'],
    ['drc_dgi', 'government', 'DGI (Direction générale des impôts)', 100_000, 2_000_000_000, 'Numéro de note de perception', '#0f766e'],
  ] as const;
  for (const [id, category, name, min, max, label, color] of billers)
    if (!hasBiller.get(name) && !db.prepare('SELECT 1 FROM billers WHERE id = ?').get(id))
      upsertBiller({ id, category, name, country: 'CD', currency: 'CDF', minAmount: min, maxAmount: max, feeBps: 0, accountLabel: label, enabled: true, color });
  const hasOperator = db.prepare("SELECT 1 FROM topup_operators WHERE country = 'CD' AND name = ?");
  const ops = [
    ['drc_vodacom', 'Vodacom', [50_000, 100_000, 200_000, 500_000, 1_000_000], '#dc2626'],
    ['drc_orange', 'Orange', [50_000, 100_000, 200_000, 500_000, 1_000_000], '#f97316'],
    ['drc_airtel', 'Airtel', [50_000, 100_000, 200_000, 500_000, 1_000_000], '#ef4444'],
    ['drc_africell', 'Africell', [50_000, 100_000, 200_000, 500_000], '#7c3aed'],
  ] as const;
  for (const [id, name, den, color] of ops)
    if (!hasOperator.get(name) && !db.prepare('SELECT 1 FROM topup_operators WHERE id = ?').get(id))
      upsertOperator({ id, name, country: 'CD', currency: 'CDF', minAmount: 50_000, maxAmount: 5_000_000, denominations: [...den], enabled: true, color });
  const hasProduct = db.prepare('SELECT 1 FROM gift_card_products WHERE brand = ? AND currency = ?');
  const products = [
    ['drc_canalplus_voucher', 'Canal+ Afrique', 'Abonnement Canal+ (code de recharge)', 'entertainment', [1_500_000, 2_500_000, 4_500_000], '#111827', "Recharge d'abonnement Canal+ Afrique en RDC"],
    ['drc_dstv_voucher', 'DStv', 'DStv RDC (code de recharge)', 'entertainment', [1_500_000, 3_000_000, 6_000_000], '#ec4899', "Recharge d'abonnement DStv en RDC"],
    ['drc_snel_prepaid', 'SNEL', 'SNEL prépayé (jeton CashPower)', 'utilities', [500_000, 1_000_000, 2_500_000], '#f59e0b', "Jeton d'électricité prépayée pour compteur SNEL"],
  ] as const;
  for (const [id, brand, name, category, den, color, description] of products)
    if (!hasProduct.get(brand, 'CDF') && !db.prepare('SELECT 1 FROM gift_card_products WHERE id = ?').get(id))
      upsertGiftProduct({ id, brand, name, category, currency: 'CDF', denominations: [...den], color, enabled: true, description });
}
