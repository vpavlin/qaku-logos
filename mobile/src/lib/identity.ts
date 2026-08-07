// Per-user signing identity on the phone: a secp256k1 keypair persisted in SecureStore,
// separate from the session secret (which is shared/household) and from the device id
// (the SDS senderId). Its ADDRESS (0x…) is this user's verifiable authorship — every
// authored event is signed with this key (see session.ts + packages/contract/identity.mjs),
// and the engine verifies before admitting. The private key never leaves the device.
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
// @ts-ignore - shared reference implementation (metro resolves the relative .mjs)
import { identityFromPriv } from "../../../packages/contract/src/identity.mjs";

const HEXC = "0123456789abcdef";
const hex = (b: Uint8Array) => { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; };
const fromHex = (s: string) => { const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; };

export type Identity = { priv: Uint8Array; pub: Uint8Array; pubHex: string; address: string };

let cached: Identity | null = null;

// A valid secp256k1 private scalar from expo-crypto (Hermes-safe RNG — NOT @noble
// randomBytes, which needs crypto.getRandomValues and throws on Hermes; same trap that
// once killed publishing). Reject-and-retry the vanishingly rare out-of-range scalar.
function freshPriv(): Uint8Array {
  for (let i = 0; i < 8; i++) {
    const p = Crypto.getRandomBytes(32);
    try { secp256k1.getPublicKey(p, true); return p; } catch { /* invalid scalar — retry */ }
  }
  throw new Error("could not generate a valid signing key");
}

// Load (or first-run create+persist) this device's signing identity.
export async function getIdentity(): Promise<Identity> {
  if (cached) return cached;
  let hexPriv = await SecureStore.getItemAsync("qaku-identity-key");
  if (!hexPriv) {
    hexPriv = hex(freshPriv());
    await SecureStore.setItemAsync("qaku-identity-key", hexPriv);
  }
  cached = identityFromPriv(fromHex(hexPriv)) as Identity;
  return cached;
}

export async function getAddress(): Promise<string> { return (await getIdentity()).address; }

// Short display form of an address: 0x1234…cdef.
export function shortAddr(addr: string): string {
  return addr && addr.length > 12 ? addr.slice(0, 6) + "…" + addr.slice(-4) : addr || "";
}
