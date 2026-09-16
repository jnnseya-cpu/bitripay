import { getSetting } from './settings';

export interface ModuleFlags {
  transfers: boolean;
  qrPayments: boolean;
  paymentLinks: boolean;
  moneyRequests: boolean;
  addMoney: boolean;
  withdrawals: boolean;
  agents: boolean;
  remittance: boolean;
  exchange: boolean;
  virtualCards: boolean;
  giftCards: boolean;
  billPay: boolean;
  mobileTopup: boolean;
  referrals: boolean;
  p2p: boolean;
  support: boolean;
  liveChat: boolean;
  merchantGateway: boolean;
  kyc: boolean;
  /** Goal savings on the wallet (issuer function). */
  savings: boolean;
  /** Informational credit-readiness score. */
  creditScore: boolean;
  /** Linked bank accounts, income verification, pay by bank, mandates. */
  openBanking: boolean;
  /** Restricted-purpose wallets (issuer function). */
  restrictedWallets: boolean;
}

export const DEFAULT_MODULES: ModuleFlags = {
  transfers: true,
  qrPayments: true,
  paymentLinks: true,
  moneyRequests: true,
  addMoney: true,
  withdrawals: true,
  agents: true,
  remittance: true,
  exchange: true,
  virtualCards: true,
  giftCards: true,
  billPay: true,
  mobileTopup: true,
  referrals: true,
  p2p: true,
  support: true,
  liveChat: true,
  merchantGateway: true,
  kyc: true,
  savings: true,
  creditScore: true,
  openBanking: true,
  restrictedWallets: true,
};

/** Stored flags may predate a key: an absent key means "on", exactly as the console shows it. */
export const getModules = (): ModuleFlags => ({ ...DEFAULT_MODULES, ...getSetting<Partial<ModuleFlags>>('modules', DEFAULT_MODULES) });

/**
 * The aggregator perimeter of Instructions n°42 (art. 1 (4) and 9: a technical payment service provider for
 * financial institutions) and n°58 of the Banque Centrale du Congo: acceptance (QR, links, requests, merchant
 * gateway and API), identity checks and support stay on; every function of an issuer or an acquirer (wallet
 * funding, transfers, withdrawals, agents, remittances, exchange, cards, vouchers, bills and airtime paid from a
 * wallet, savings, restricted wallets, open banking, credit score, P2P, referral rewards) is switched off until the
 * corresponding authorisation exists or an authorised issuer operates it on the platform.
 */
export const AGGREGATOR_PERIMETER_ON: (keyof ModuleFlags)[] = ['qrPayments', 'paymentLinks', 'moneyRequests', 'merchantGateway', 'kyc', 'support', 'liveChat'];
export const AGGREGATOR_PERIMETER_OFF: (keyof ModuleFlags)[] = [
  'transfers',
  'addMoney',
  'withdrawals',
  'agents',
  'remittance',
  'exchange',
  'virtualCards',
  'giftCards',
  'billPay',
  'mobileTopup',
  'referrals',
  'p2p',
  'savings',
  'creditScore',
  'openBanking',
  'restrictedWallets',
];
export function aggregatorPerimeterFlags(): ModuleFlags {
  const flags = { ...getModules() };
  for (const k of AGGREGATOR_PERIMETER_ON) flags[k] = true;
  for (const k of AGGREGATOR_PERIMETER_OFF) flags[k] = false;
  return flags;
}
/** True when every out-of-perimeter module is off (what the console and the go-live checklist report). */
export const aggregatorPerimeterApplied = (flags: ModuleFlags = getModules()) => AGGREGATOR_PERIMETER_OFF.every((k) => flags[k] === false);

export const MODULE_OFF_MESSAGE = 'This service will be available after the authorisation of the Banque Centrale du Congo; it is switched off by the administrator';
