// QAKU session crypto for React Native. Byte-parity with the reference
// (packages/sync/src/crypto.mjs) and the C++ core (qaku_crypto.hpp) - uses
// @noble (RN-safe, no node:crypto). Same derivation:
//   K            = HKDF-SHA256(S, salt="qaku-pair-v1")
//   contentTopic = "/qaku/1/" + hex(HMAC-SHA256(K,"qaku/topic/v1|"+epoch)[0..15]) + "/proto"
//   Ke           = HKDF-SHA256(K, info="qaku/payload/v1")
//   wire payload = nonce(12) || ChaCha20-Poly1305(Ke, nonce, plaintext, aad=topic)
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import * as Crypto from "expo-crypto";
// Hermes-safe RNG. @noble/hashes `randomBytes` needs `crypto.getRandomValues`, which
// Hermes does NOT provide unless polyfilled — so it threw inside seal()'s nonce on
// EVERY publish (open()/receive never calls it, which is why receive worked but tx
// stayed 0 with no visible error). expo-crypto's getRandomBytes is synchronous and
// needs no polyfill; KYM's identity.ts uses exactly this.
const randomBytes = (n: number): Uint8Array => Crypto.getRandomBytes(n);

import { utf8Bytes } from "./utf8"; // Hermes-safe (KYM_TRANSPORT_SPEC L4)
const enc = (s: string) => utf8Bytes(s);
const HEXC = "0123456789abcdef";
const hex = (b: Uint8Array) => { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; };

export type Identity = { secret: Uint8Array; K: Uint8Array; Ke: Uint8Array; fingerprint: string };

export function newSecret(): Uint8Array { return randomBytes(32); }

export function deriveIdentity(secret: Uint8Array): Identity {
  if (secret.length !== 32) throw new Error("qaku session secret must be 32 bytes");
  const K = hkdf(sha256, secret, enc("qaku-pair-v1"), new Uint8Array(0), 32);
  const Ke = hkdf(sha256, K, new Uint8Array(0), enc("qaku/payload/v1"), 32);
  return { secret, K, Ke, fingerprint: hex(sha256(K).slice(0, 3)) };
}

export function topicFor(id: Identity, epoch = 0): string {
  const t = hmac(sha256, id.K, enc(`qaku/topic/v1|${epoch}`)).slice(0, 16);
  return `/qaku/1/${hex(t)}/proto`;
}

/**
 * Deterministic 12-byte nonce from the seal id (ADR 0011, byte-identical to loam-sync
 * nonceFor + qaku_core C++ + packages/sync). Same id → same nonce → same ciphertext, so
 * re-sealing an immutable event is byte-identical and the fleet store dedups it (fixes
 * store bloat + cold-start truncation). Pass a fresh token for an ephemeral control frame.
 */
export function nonceFor(id: Identity, sealId: string): Uint8Array {
  return hmac(sha256, id.Ke, enc(`qaku/nonce/v1|${sealId}`)).slice(0, 12);
}

/** A short random hex token — seeds the deterministic nonce for ephemeral control frames. */
export function randToken(): string {
  return hex(randomBytes(8));
}

/**
 * Encrypt: nonce(12) || ChaCha20-Poly1305 ciphertext||tag, AAD-bound to the topic. The
 * nonce is DERIVED from `sealId` (deterministic): pass the event id for an immutable event
 * so a re-seal is byte-identical (store dedups); a fresh token for a control frame.
 */
export function seal(id: Identity, sealId: string, plaintext: Uint8Array, topic: string): Uint8Array {
  const nonce = nonceFor(id, sealId);
  const ct = chacha20poly1305(id.Ke, nonce, enc(topic)).encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0); out.set(ct, nonce.length);
  return out; // nonce(12) || ciphertext||tag (noble appends the tag to ciphertext)
}

export function open(id: Identity, sealed: Uint8Array, topic: string): Uint8Array {
  const nonce = sealed.subarray(0, 12);
  const ct = sealed.subarray(12);
  return chacha20poly1305(id.Ke, nonce, enc(topic)).decrypt(ct);
}
