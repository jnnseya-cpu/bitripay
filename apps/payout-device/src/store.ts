/**
 * Device state. The private key lives only in the platform keystore-backed secure store; everything
 * else (enrolment, pending evidence, log) is plain app storage.
 */
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface Enrolment {
  apiUrl: string;
  deviceId: string;
  deviceName: string;
  kind: 'payout' | 'collection';
  payoutAccountId: string | null;
  payoutAccountLabel: string | null;
  operatorId: string | null;
  simMsisdn: string | null;
  simIccid: string | null;
  /** Sender ids the operator uses for confirmations (e.g. "MPESA", "OrangeMoney"). Empty = forward everything. */
  senderFilters: string[];
  enrolledAt: string;
}

export interface PendingEvidence {
  id: string;
  payoutId: string | null;
  path: string;
  payload: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

const KEY_PRIV = 'bitripay.device.privateKey';
const KEY_ENROL = 'bitripay.device.enrolment';
const KEY_PENDING = 'bitripay.device.pending';
const KEY_LOG = 'bitripay.device.log';

export const secure = {
  getPrivateKey: () => SecureStore.getItemAsync(KEY_PRIV, { requireAuthentication: false }),
  setPrivateKey: (hex: string) => SecureStore.setItemAsync(KEY_PRIV, hex, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  clearPrivateKey: () => SecureStore.deleteItemAsync(KEY_PRIV),
};

export async function loadEnrolment(): Promise<Enrolment | null> {
  const raw = await AsyncStorage.getItem(KEY_ENROL);
  return raw ? (JSON.parse(raw) as Enrolment) : null;
}
export const saveEnrolment = (e: Enrolment | null) => (e ? AsyncStorage.setItem(KEY_ENROL, JSON.stringify(e)) : AsyncStorage.removeItem(KEY_ENROL));

export async function loadPending(): Promise<PendingEvidence[]> {
  const raw = await AsyncStorage.getItem(KEY_PENDING);
  return raw ? (JSON.parse(raw) as PendingEvidence[]) : [];
}
export const savePending = (items: PendingEvidence[]) => AsyncStorage.setItem(KEY_PENDING, JSON.stringify(items));

export interface LogEntry {
  at: string;
  level: 'info' | 'ok' | 'warn' | 'error';
  text: string;
}
export async function appendLog(entry: Omit<LogEntry, 'at'>) {
  const raw = await AsyncStorage.getItem(KEY_LOG);
  const items: LogEntry[] = raw ? JSON.parse(raw) : [];
  items.unshift({ at: new Date().toISOString(), ...entry });
  await AsyncStorage.setItem(KEY_LOG, JSON.stringify(items.slice(0, 200)));
}
export async function loadLog(): Promise<LogEntry[]> {
  const raw = await AsyncStorage.getItem(KEY_LOG);
  return raw ? JSON.parse(raw) : [];
}
