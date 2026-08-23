// QAKU session crypto — now SOURCED FROM loam-sync (single source), not a qaku copy.
// One 32-byte pre-shared secret S is the whole session key; every device/participant with
// the secret can read+write. Sharing = handing over the secret (pairing link/QR/code).
//
// The derivation (K/Ke/topic/nonce/seal/open) is loam-sync's crypto with domain="qaku",
// which reproduces qaku's exact legacy key schedule BYTE-FOR-BYTE (verified: identical to
// the old node:crypto packages/sync output AND the mobile @noble output AND qaku_core C++).
// Deterministic id-derived nonce (ADR 0011): re-sealing an immutable event is byte-identical
// so the fleet store dedups it. wire = nonce(12) ‖ ChaCha20-Poly1305(Ke, nonce, pt, aad=topic).
//
// Imported from the in-tree loam-sync submodule's dist by RELATIVE path (qaku's packages are
// bare .mjs, no npm workspace). newSecret stays here (uses node:crypto RNG; app-specific).
import {
  deriveIdentity as LDerive,
  topicFor as LTopic,
  nonceFor as LNonce,
  seal as LSeal,
  open as LOpen,
} from "../../loam-sync/dist/crypto.js";
import { randomBytes } from "node:crypto";

const DOMAIN = "qaku"; // session crypto domain — reproduces the legacy qaku key schedule
const HEXC = "0123456789abcdef";
const hex = (b) => { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; };

/** A fresh 32-byte session secret. */
export function newSecret() {
  return new Uint8Array(randomBytes(32));
}

/** Derive the full identity from a 32-byte secret (loam-sync, domain "qaku"), plus qaku's
 *  short hex session fingerprint. Pure. */
export function deriveIdentity(secret) {
  const id = LDerive(secret, DOMAIN);
  return { ...id, fingerprint: hex(id.fpBytes) };
}

/** The session content topic for a rotation epoch (0 = static, phase 1). */
export const topicFor = (id, epoch = 0) => LTopic(id, DOMAIN, epoch);

/** Deterministic 12-byte nonce from the seal id (loam-sync, domain "qaku"). */
export const nonceFor = (id, sealId) => LNonce(id, DOMAIN, sealId);

/** Encrypt → nonce(12) ‖ ciphertext‖tag, AAD-bound to the topic; deterministic nonce
 *  from `sealId` (loam-sync seal, domain "qaku"). */
export const seal = (id, sealId, plaintext, topic) => LSeal(id, DOMAIN, sealId, plaintext, topic);

/** Inverse of seal(); throws if the tag doesn't verify (loam-sync open). */
export const open = (id, sealed, topic) => LOpen(id, sealed, topic);
