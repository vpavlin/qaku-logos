// QAKU session crypto for React Native — now SOURCED FROM loam-sync (single source),
// not a vendored copy. The household AEAD derivation (K/Ke/topic/nonce/seal/open) is
// loam-sync's crypto with domain="qaku", imported from the in-tree loam-sync submodule
// (metro aliases "loam-sync/crypto" → packages/loam-sync/dist/crypto.js). It reproduces
// qaku's exact legacy key schedule BYTE-FOR-BYTE (verified identical to the old @noble
// mobile impl, the node:crypto packages/sync reference, and qaku_core C++):
//   K            = HKDF-SHA256(S, salt="qaku-pair-v1")
//   contentTopic = "/qaku/1/" + hex(HMAC-SHA256(K,"qaku/topic/v1|"+epoch)[0..15]) + "/proto"
//   Ke           = HKDF-SHA256(K, info="qaku/payload/v1")
//   nonce        = HMAC-SHA256(Ke,"qaku/nonce/v1|"+sealId)[0..11]   (DETERMINISTIC, ADR 0011)
//   wire payload = nonce(12) || ChaCha20-Poly1305(Ke, nonce, plaintext, aad=topic)
// loam-sync/crypto.js uses @noble, which resolves against mobile's existing @noble/hashes
// + @noble/ciphers (they already ship the sha2.js/hkdf.js/hmac.js/chacha.js subpaths).
import * as Crypto from "expo-crypto";
import {
  deriveIdentity as LDerive,
  topicFor as LTopic,
  nonceFor as LNonce,
  seal as LSeal,
  open as LOpen,
  type Identity as LIdentity,
} from "loam-sync/crypto";

const DOMAIN = "qaku"; // session crypto domain — reproduces the legacy qaku key schedule

// Hermes-safe RNG. expo-crypto's getRandomBytes is synchronous and needs no polyfill
// (@noble randomBytes needs crypto.getRandomValues, which Hermes lacks — the old publish trap).
const randomBytes = (n: number): Uint8Array => Crypto.getRandomBytes(n);
const HEXC = "0123456789abcdef";
const hex = (b: Uint8Array) => { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; };

// The household crypto is now loam-sync's Identity plus qaku's short hex session fingerprint.
export type Identity = LIdentity & { fingerprint: string };

export function newSecret(): Uint8Array { return randomBytes(32); }

export function deriveIdentity(secret: Uint8Array): Identity {
  const id = LDerive(secret, DOMAIN);
  return { ...id, fingerprint: hex(id.fpBytes) };
}

export const topicFor = (id: Identity, epoch = 0): string => LTopic(id, DOMAIN, epoch);

/**
 * Deterministic 12-byte nonce from the seal id (loam-sync, domain "qaku"). Same id →
 * same nonce → same ciphertext, so re-sealing an immutable event is byte-identical and
 * the fleet store dedups it. Pass a fresh token for an ephemeral control frame.
 */
export const nonceFor = (id: Identity, sealId: string): Uint8Array => LNonce(id, DOMAIN, sealId);

/** A short random hex token — seeds the deterministic nonce for ephemeral control frames. */
export function randToken(): string { return hex(randomBytes(8)); }

/**
 * Encrypt: nonce(12) || ChaCha20-Poly1305 ciphertext||tag, AAD-bound to the topic. The
 * nonce is DERIVED from `sealId` (deterministic): pass the event id for an immutable event
 * so a re-seal is byte-identical (store dedups); a fresh token for a control frame.
 */
export const seal = (id: Identity, sealId: string, plaintext: Uint8Array, topic: string): Uint8Array =>
  LSeal(id, DOMAIN, sealId, plaintext, topic);

/** Inverse of seal(). Throws if the tag doesn't verify (wrong key / tampered). */
export const open = (id: Identity, sealed: Uint8Array, topic: string): Uint8Array =>
  LOpen(id, sealed, topic);
