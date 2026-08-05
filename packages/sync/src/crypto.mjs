// QAKU session crypto — the reference implementation. One 32-byte pre-shared
// secret S is the whole session key; every device/participant with the secret
// can read+write. Sharing = handing over the secret (pairing link/QR/code).
//
//   K            = HKDF-SHA256(ikm=S, salt="qaku-pair-v1", info="", 32)
//   topic(e)     = HMAC-SHA256(K, "qaku/topic/v1|"+e)[0..15]              (16 bytes)
//   contentTopic = "/qaku/1/" + hex(topic(e)) + "/proto"
//   Ke           = HKDF-SHA256(ikm=K, salt="", info="qaku/payload/v1", 32)
//   fingerprint  = hex(SHA-256(K)[0..2])            (a short session id/fp)
//   wire payload = nonce(12) ‖ ChaCha20-Poly1305(Ke, nonce, plaintext, aad=topic)
//
// Zero-dependency: uses node:crypto so it runs without an npm install. The
// mobile (JS) and C++ ports must reproduce these exact bytes.
import { createHmac, createHash, hkdfSync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const enc = (s) => new TextEncoder().encode(s);
const HEXC = "0123456789abcdef";
const hex = (b) => { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; };

/** A fresh 32-byte session secret. */
export function newSecret() {
  return new Uint8Array(randomBytes(32));
}

/** Derive the full identity from a 32-byte secret. Pure. */
export function deriveIdentity(secret) {
  if (secret.length !== 32) throw new Error("qaku session secret must be 32 bytes");
  const K = new Uint8Array(hkdfSync("sha256", secret, enc("qaku-pair-v1"), new Uint8Array(0), 32));
  const Ke = new Uint8Array(hkdfSync("sha256", K, new Uint8Array(0), enc("qaku/payload/v1"), 32));
  const fp = new Uint8Array(createHash("sha256").update(K).digest()).slice(0, 3);
  return { secret, K, Ke, fpBytes: fp, fingerprint: hex(fp) };
}

/** The session content topic for a rotation epoch (0 = static, phase 1). */
export function topicFor(id, epoch = 0) {
  const t = new Uint8Array(createHmac("sha256", Buffer.from(id.K)).update(`qaku/topic/v1|${epoch}`).digest()).slice(0, 16);
  return `/qaku/1/${hex(t)}/proto`;
}

/** Encrypt: nonce(12) ‖ ChaCha20-Poly1305 ciphertext‖tag, AAD-bound to the topic. */
export function seal(id, plaintext, topic, nonce = randomBytes(12)) {
  const n = Buffer.from(nonce);
  const c = createCipheriv("chacha20-poly1305", Buffer.from(id.Ke), n, { authTagLength: 16 });
  c.setAAD(Buffer.from(enc(topic)));
  const ct = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
  const tag = c.getAuthTag();
  const out = new Uint8Array(12 + ct.length + tag.length);
  out.set(n, 0); out.set(ct, 12); out.set(tag, 12 + ct.length);
  return out; // nonce ‖ ciphertext ‖ tag  (tag last, matching AEAD convention)
}

/** Inverse of seal(). Throws if the tag doesn't verify (wrong key / tampered). */
export function open(id, sealed, topic) {
  const n = Buffer.from(sealed.subarray(0, 12));
  const tag = Buffer.from(sealed.subarray(sealed.length - 16));
  const ct = Buffer.from(sealed.subarray(12, sealed.length - 16));
  const d = createDecipheriv("chacha20-poly1305", Buffer.from(id.Ke), n, { authTagLength: 16 });
  d.setAAD(Buffer.from(enc(topic)));
  d.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([d.update(ct), d.final()]));
}
