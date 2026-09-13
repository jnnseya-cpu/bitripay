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
};

export const getModules = () => getSetting<ModuleFlags>('modules', DEFAULT_MODULES);
