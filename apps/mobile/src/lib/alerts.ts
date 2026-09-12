/**
 * Very loud alerts on the phone: alarm sound through expo-av (plays even in silent mode on iOS) plus a long vibration
 * pattern. Used for push notifications received in the foreground and for new loud notifications found while polling.
 */
import { Vibration, Platform } from 'react-native';
import { Audio } from 'expo-av';

export const VIBRATION_PATTERN = [0, 600, 150, 600, 150, 900, 300, 600, 150, 600];
let sound: Audio.Sound | null = null;
let enabled = true;

export function setLoudEnabled(on: boolean) {
  enabled = on;
}

async function load() {
  if (sound) return sound;
  await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: false, shouldDuckAndroid: false });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sound: s } = await Audio.Sound.createAsync(require('../../assets/sounds/loud_alert.wav'), { volume: 1.0 });
  sound = s;
  return s;
}

/** Ring the alarm and vibrate. Safe to call repeatedly; failures are swallowed (no audio hardware, permissions). */
export async function ringLoud() {
  if (!enabled) return;
  try {
    Vibration.vibrate(VIBRATION_PATTERN, false);
  } catch {
    /* no vibration */
  }
  try {
    const s = await load();
    await s.setPositionAsync(0);
    await s.playAsync();
  } catch {
    /* no audio */
  }
}

const seen = new Set<string>();
let primed = false;
/** Ring once for every new, unread, loud notification found by the poll; the first poll only primes the set. */
export function ringForNew(items: { id: string; read: boolean; data?: Record<string, unknown> }[]) {
  if (!primed) {
    items.forEach((n) => seen.add(n.id));
    primed = true;
    return;
  }
  let ring = false;
  for (const n of items) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (!n.read && n.data?.loud) ring = true;
  }
  if (ring) void ringLoud();
}

export const isAndroid = Platform.OS === 'android';
