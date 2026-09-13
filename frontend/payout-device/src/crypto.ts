import * as Crypto from 'expo-crypto';
import { generateDeviceKeys, randomNonce, selfTest, type DeviceKeyPair } from './protocol';

/** Hardware-seeded randomness from expo-crypto; the Ed25519 private key never leaves the secure store. */
export const randomBytes = (n: number) => Crypto.getRandomBytes(n);

export function createKeys(): DeviceKeyPair {
  const keys = generateDeviceKeys(randomBytes);
  if (!selfTest(keys)) throw new Error('Key self-test failed – refusing to enrol');
  return keys;
}
export const nonce = () => randomNonce(randomBytes);
