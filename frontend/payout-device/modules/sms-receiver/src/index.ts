/**
 * JS side of the native SMS receiver. On platforms without the native module (iOS, web, Expo Go) every call
 * degrades gracefully so the app can still run in "manual" mode for development.
 */
import { PermissionsAndroid, Platform } from 'react-native';

export interface ReceivedSms {
  id: string;
  from: string;
  text: string;
  /** Epoch millis when the device received the message. */
  receivedAt: number;
  subscriptionId: number;
  simSlot: number;
  timestampMillis: number;
}

export interface SimInfo {
  subscriptionId: number;
  simSlot: number;
  carrier: string | null;
  displayName: string | null;
  iccid: string | null;
  msisdn: string | null;
  countryIso: string | null;
}

type Native = {
  hasPermissions(): boolean;
  drainPending(): ReceivedSms[];
  acknowledge(ids: string[]): void;
  getSimInfo(): SimInfo[];
  addListener?: (event: string, listener: (e: ReceivedSms) => void) => { remove(): void };
};

let native: Native | null = null;
if (Platform.OS === 'android') {
  try {
    const { requireNativeModule } = require('expo-modules-core');
    native = requireNativeModule('SmsReceiver');
  } catch {
    native = null;
  }
}

export const isNativeAvailable = () => native != null;
export const hasPermissions = () => (native ? native.hasPermissions() : false);
export const drainPending = (): ReceivedSms[] => (native ? native.drainPending() : []);
export const acknowledge = (ids: string[]) => native?.acknowledge(ids);
export const getSimInfo = (): SimInfo[] => (native ? native.getSimInfo() : []);

/** Subscribe to SMS as they arrive while the app is alive. Returns an unsubscribe function. */
export function onSms(listener: (sms: ReceivedSms) => void): () => void {
  if (!native?.addListener) return () => {};
  const sub = native.addListener('onSms', listener);
  return () => sub.remove();
}

/** Ask for the runtime permissions the receiver needs (Android 6+). Returns true when all were granted. */
export async function requestPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const wanted = [
    PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
    PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
    PermissionsAndroid.PERMISSIONS.READ_PHONE_NUMBERS,
    PermissionsAndroid.PERMISSIONS.CALL_PHONE,
  ].filter(Boolean);
  try {
    const res = await PermissionsAndroid.requestMultiple(wanted);
    return wanted.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
  } catch {
    return false;
  }
}
