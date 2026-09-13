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
}
