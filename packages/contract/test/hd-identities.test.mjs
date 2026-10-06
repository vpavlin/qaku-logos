// Per-room Loam identities (ADR 0013, loam-keycard ADR 0001). A tiny reference of loam-keycard's
// hd.ts (BIP39 seed + hardened BIP32 at m/43'/60'/1581'/A'/C0'..C3') built on @noble only, checked
// against loam-keycard's shared vectors (vectors/loam-hd.json, copied verbatim), then used to show:
//   - two QAKU rooms give the SAME root two different, unrelated author addresses;
//   - the same room always gives the same address (authorship is stable within a room);
//   - an event signed by Loam through the external-signer path (stampAuthor + eventDigestHex +
//     attachSignature — what sessions.ts / qaku_core do with loamSign / hdSign) verifies and folds
//     with that per-room author.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import { hmac } from "@noble/hashes/hmac";
import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { addressFor, stampAuthor, eventDigestHex, attachSignature, verifyEvent, _internal } from "../src/identity.mjs";
import { Clock, ev } from "../src/index.mjs";
import { computeState } from "../../engine/src/engine.mjs";

const { hex, fromHex } = _internal;
const enc = (s) => new TextEncoder().encode(s);
const N = secp256k1.CURVE.n;
const big = (b) => BigInt("0x" + (hex(b) || "0"));
const be32 = (v) => { const b = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

function idx31(seed) {
  const h = sha256(enc(seed));
  const at = (o) => (((h[o] << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) & 0x7fffffff) >>> 0;
  return [at(0), at(4), at(8), at(12)];
}
function subPath(appId, contextId) {
  if (!contextId) return [0, 0];                       // main identity
  return [idx31("loam-app:" + appId)[0], ...idx31("loam-ctx:" + appId + ":" + contextId)];
}
function derive(seed, appId, contextId) {
  let I = hmac(sha512, enc("Bitcoin seed"), seed);
  let k = I.slice(0, 32), c = I.slice(32);
  const path = [43, 60, 1581, ...subPath(appId, contextId)];
  for (const i of path) {                              // hardened only: data = 0x00 || k || ser32(i + 2^31)
    const data = new Uint8Array(37);
    data.set(k, 1);
    const idx = (i + 0x80000000) >>> 0;
    data[33] = idx >>> 24; data[34] = (idx >>> 16) & 0xff; data[35] = (idx >>> 8) & 0xff; data[36] = idx & 0xff;
    I = hmac(sha512, c, data);
    k = be32((big(I.slice(0, 32)) + big(k)) % N);
    c = I.slice(32);
  }
  const pub = secp256k1.getPublicKey(k, true);
  return { path: "m/" + path.map((i) => i + "'").join("/"), priv: k, pubHex: hex(pub), address: addressFor(pub) };
}

const V = JSON.parse(readFileSync(new URL("./vectors/loam-hd.json", import.meta.url), "utf8"));
const seed = pbkdf2(sha512, enc(V.mnemonic.normalize("NFKD")), enc(("mnemonic" + V.passphrase).normalize("NFKD")), { c: 2048, dkLen: 64 });

// A stand-in for Loam: holds the root, answers identity(contextId) and sign(contextId, digest) for app "qaku".
const loam = {
  identity: (ctx) => { const d = derive(seed, "qaku", ctx); return { address: d.address, pubHex: d.pubHex, path: d.path }; },
  sign: (ctx, digestHex) => { const d = derive(seed, "qaku", ctx); return { sig: secp256k1.sign(fromHex(digestHex), d.priv).toCompactHex(), pub: d.pubHex, address: d.address }; },
};

test("the reference derivation reproduces loam-keycard's shared vectors", () => {
  for (const v of V.identities) {
    const d = v.ref.kind === "main" ? derive(seed, "", "") : derive(seed, v.ref.appId, v.ref.contextId);
    assert.equal(d.path, v.path, v.name);
    assert.equal(hex(d.priv), v.privHex, v.name);
    assert.equal(d.pubHex, v.pubHex, v.name);
    assert.equal(d.address, v.address, v.name);
  }
});

// Two room ids = two topic hashes (what both platforms pass as the Loam context).
const ROOM1 = "9f1c0a5e7b3d4c2a8e6f1d0b3a5c7e9f", ROOM2 = "0d2e4f6a8c1b3d5f7e9a0c2e4b6d8f1a";

test("two rooms -> two unrelated addresses from one root; the same room is stable", () => {
  const a1 = loam.identity(ROOM1).address, a2 = loam.identity(ROOM2).address;
  assert.notEqual(a1, a2);
  assert.equal(loam.identity(ROOM1).address, a1, "same room, same identity");
  assert.notEqual(a1, derive(seed, "", "").address, "not the main identity");
  assert.notEqual(a1, derive(seed, "scala", ROOM1).address, "another app with the same context id is another identity");
});

test("Loam-signed events verify, and each room folds its own author", () => {
  const author = (room, title) => {
    const id = loam.identity(room);
    const clock = new Clock(id.address);
    const e = ev.sessionCreate(clock.send(), { sessionId: room, title });
    stampAuthor(e, id.address);
    const r = loam.sign(room, eventDigestHex(e));
    assert.equal(r.address, id.address);
    attachSignature(e, r.pub, r.sig);
    assert.ok(verifyEvent(e), "verifies like a locally signed event");
    const q = ev.questionAdd(clock.send(), { questionId: "q", content: "hi" });
    stampAuthor(q, id.address);
    const rq = loam.sign(room, eventDigestHex(q));
    attachSignature(q, rq.pub, rq.sig);
    return computeState([e, q], { me: id.address, roomId: room });
  };
  const s1 = author(ROOM1, "one"), s2 = author(ROOM2, "two");
  assert.equal(s1.owner, loam.identity(ROOM1).address);
  assert.equal(s2.owner, loam.identity(ROOM2).address);
  assert.notEqual(s1.owner, s2.owner, "nothing in the two logs links the rooms");
  assert.equal(s1.questions[0].author, s1.owner);
  assert.ok(s1.questions[0].verified && s2.questions[0].verified);
});
