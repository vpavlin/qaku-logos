// React Native has no Node `crypto`. The shared contract's events.mjs only needs
// `randomUUID`, so this shim provides exactly that, backed by Expo's CSPRNG
// (Android SecureRandom). Metro rewrites `node:crypto` / `crypto` here — see
// metro.config.js. Keep the surface minimal: add exports only as the shared
// packages start importing them.
import * as Crypto from "expo-crypto";

export function randomUUID() {
  return Crypto.randomUUID();
}

export default { randomUUID };
