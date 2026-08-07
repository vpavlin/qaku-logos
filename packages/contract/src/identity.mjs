// QAKU per-user identity + event signing (secp256k1). ADDED to give verifiable
// authorship: each device holds a secp256k1 keypair; its ADDRESS = "0x" + last-20-bytes
// of sha256(compressedPubkey) (SHA-256, not keccak, so C++/OpenSSL and JS/@noble derive
// it byte-identically). Every authored event is signed; the engine verifies before
// admitting (see packages/engine + qaku_engine.hpp). The AEAD session-seal is unchanged
// and orthogonal (confidentiality); this is the authenticity layer.
//
// Byte-parity contract with the C++ port (qaku_identity.hpp):
//   address(pub)      = "0x" + hex(sha256(pub_compressed_33B))[24:64]        (last 20 bytes)
//   canonicalMessage  = "qaku-sig-v1|"+type+"|"+wall+"|"+ctr+"|"+dev+"|"+id+"|"+cjson(payload)
//   cjson             = compact JSON, OBJECT KEYS SORTED lexicographically, no spaces
//   digest            = sha256(utf8Bytes(canonicalMessage))
//   sig               = secp256k1 ECDSA over digest, compact r||s (64B) hex, low-S
//   event carries     = { ...event, dev:address, hlc.dev:address, pub:hex(33B), sig:hex(64B) }
//   verify            = address(pub)===dev AND secp256k1.verify(sig, digest, pub)
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

// --- Hermes-safe helpers (no TextEncoder; identical to mobile/src/lib/utf8.ts) ---
function utf8Bytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}
const HEXC = "0123456789abcdef";
function hex(b) { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; }
function fromHex(s) { const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; }

// address = "0x" + last 20 bytes of sha256(compressed pubkey), lowercase hex.
export function addressFor(pubCompressed) {
  return "0x" + hex(sha256(pubCompressed)).slice(24, 64);
}

// Build an identity from a 32-byte private scalar (mobile supplies expo-crypto bytes;
// Node/test uses generateIdentity). Throws if the scalar is invalid (retry — rare).
export function identityFromPriv(priv) {
  const pub = secp256k1.getPublicKey(priv, true); // compressed 33B
  return { priv, pub, address: addressFor(pub), pubHex: hex(pub) };
}
export function generateIdentity() {
  return identityFromPriv(secp256k1.utils.randomPrivateKey());
}

// Deterministic, cross-language canonical form of an event's SIGNED fields
// (everything except pub/sig). Object keys sorted so JS and C++ agree byte-for-byte.
function cjson(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(cjson).join(",") + "]";
  if (typeof v === "object") {
    const ks = Object.keys(v).sort();
    return "{" + ks.map((k) => JSON.stringify(k) + ":" + cjson(v[k])).join(",") + "}";
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return "null";
}
export function canonicalMessage(ev) {
  const dev = (ev.hlc && ev.hlc.dev) || ev.dev || "";
  const wall = ev.hlc ? ev.hlc.wall : 0, ctr = ev.hlc ? ev.hlc.ctr : 0;
  return "qaku-sig-v1|" + ev.type + "|" + wall + "|" + ctr + "|" + dev + "|" + ev.id + "|" + cjson(ev.payload || {});
}

// Stamp the event with our address as its author (hlc.dev + dev) and sign it. Mutates
// and returns ev. Call AFTER makeEvent, BEFORE merge/publish.
export function signEvent(identity, ev) {
  ev.dev = identity.address;
  if (ev.hlc) ev.hlc.dev = identity.address;
  const digest = sha256(utf8Bytes(canonicalMessage(ev)));
  const sig = secp256k1.sign(digest, identity.priv); // RFC6979 deterministic — no RNG
  ev.pub = identity.pubHex;
  ev.sig = sig.toCompactHex();
  return ev;
}

// True iff the event is well-signed by the key whose address it claims (dev). Returns
// false on any malformed/missing field — never throws. The engine drops unverified events.
export function verifyEvent(ev) {
  try {
    if (!ev || !ev.pub || !ev.sig || !ev.type || !ev.id) return false;
    const dev = (ev.hlc && ev.hlc.dev) || ev.dev;
    if (!dev) return false;
    const pub = fromHex(ev.pub);
    if (pub.length !== 33) return false;
    if (addressFor(pub) !== dev) return false;            // pub must match the claimed author
    const digest = sha256(utf8Bytes(canonicalMessage(ev)));
    return secp256k1.verify(fromHex(ev.sig), digest, pub); // sig must be over the exact fields
  } catch {
    return false;
  }
}

export const _internal = { cjson, hex, fromHex, utf8Bytes };
