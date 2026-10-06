// Moderator invite tickets (ADR 0013) — a shared JS<->C++ scenario. Every event is REALLY
// signed (deterministic keys, RFC6979 → byte-identical on every run), because the fold only
// counts ticket events signed by their author. gen-invites-vectors.mjs writes the log + the JS
// projection to vectors/invites.json; invites.test.mjs and qaku_core/test/engine_harness.cpp
// both fold that SAME file (the parity guard).
//
// Authors A..G and tickets T1..T9 are symbolic; `addr` maps them to real addresses.
//   A = owner, B = admin via plain admin.add, C/D/G = participants, E/F = admins via tickets.
import { secp256k1 } from "@noble/curves/secp256k1";
import { identityFromPriv, signEvent, signInviteClaim, _internal } from "../../contract/src/identity.mjs";

const { fromHex } = _internal;
export const ROOM = "9f1c0a5e7b3d4c2a8e6f1d0b3a5c7e9f";     // a topic hash (32 hex) — the room id claims bind to
const key = (n) => fromHex("00".repeat(31) + n);
const AUTH = { A: "01", B: "02", C: "03", D: "04", E: "05", F: "06", G: "07" };
const TICK = { T1: "21", T2: "22", T3: "23", T4: "24", T5: "25", T6: "26", T7: "27", T8: "28", T9: "29" };
export const ids = Object.fromEntries(Object.entries(AUTH).map(([n, k]) => [n, identityFromPriv(key(k))]));
export const tickets = Object.fromEntries(Object.entries(TICK).map(([n, k]) => [n, identityFromPriv(key(k))]));
export const addr = {
  ...Object.fromEntries(Object.entries(ids).map(([n, v]) => [n, v.address])),
  ...Object.fromEntries(Object.entries(tickets).map(([n, v]) => [n, v.address])),
};
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// A signed event by `who` at HLC wall `wall`.
function S(id, type, wall, who, payload, { unsigned = false } = {}) {
  const e = { v: 1, id, type, hlc: { wall, ctr: 0, dev: ids[who].address }, dev: ids[who].address, payload };
  return unsigned ? e : signEvent(ids[who], e);
}
const invite = (id, wall, who, t, role = "admin", o) => S(id, "member.invite", wall, who, { ticket: tickets[t].address, role }, o);
// A claim of ticket `t` authored by `who` for `member` (default: themselves). `signWith` signs the
// ticket proof with ANOTHER ticket's key; `room` binds it to another room; `highS` swaps in the
// high-S twin of the ticket signature (valid for OpenSSL, rejected by noble — both folds reject it).
function claim(id, wall, who, t, { member = who, signWith = t, room = ROOM, highS = false } = {}) {
  const c = signInviteClaim(key(TICK[signWith]), room, ids[member].address);
  let ticketSig = c.ticketSig;
  if (highS) {
    const s = BigInt("0x" + ticketSig.slice(64));
    ticketSig = ticketSig.slice(0, 64) + (N - s).toString(16).padStart(64, "0");
  }
  return S(id, "member.claim", wall, who, { ticket: tickets[t].address, ticketPub: tickets[t].pubHex, member: ids[member].address, ticketSig });
}

export function inviteEvents() {
  return [
    S("e-create", "session.create", 1, "A", { sessionId: ROOM, title: "Invites", description: "" }),
    S("e-addB", "admin.add", 2, "A", { memberId: ids.B.address, name: "B" }),
    S("e-q1", "question.add", 3, "C", { questionId: "q1", content: "who answers?" }),
    invite("i-T1", 4, "A", "T1"),
    claim("c-T1-F", 5, "F", "T1"),                        // valid → F admin
    claim("c-T1-G", 6, "G", "T1"),                        // double claim → ignored
    invite("i-T1-revoke", 7, "A", "T1", "revoke"),        // revoke after redemption → no effect
    invite("i-T2", 8, "B", "T2"),                         // B (plain admin) may invite too
    claim("c-T2-E-wrongkey", 9, "E", "T2", { signWith: "T3" }),   // wrong ticket key → rejected
    claim("c-T2-E", 10, "E", "T2"),                       // valid → E admin
    invite("i-T3-outsider", 11, "D", "T3"),               // D is not an admin → ignored
    claim("c-T3-D", 12, "D", "T3"),                       // ...so this claim has nothing to redeem
    invite("i-T4", 13, "A", "T4"),
    invite("i-T4-revoke", 14, "A", "T4", "revoke"),
    claim("c-T4-C", 15, "C", "T4"),                       // revoked → rejected
    invite("i-T5", 16, "A", "T5"),
    claim("c-T5-C-for-D", 17, "C", "T5", { member: "D" }),        // claim for someone else → rejected
    claim("c-T5-G-highS", 18, "G", "T5", { highS: true }),        // high-S ticket sig → rejected
    claim("c-T5-G-otherroom", 19, "G", "T5", { room: "00112233445566778899aabbccddeeff" }),   // bound to another room → rejected
    claim("c-T6-D-early", 20, "D", "T6"),                 // claim BEFORE the invite → does not count
    invite("i-T6", 21, "A", "T6"),
    invite("i-T7", 22, "F", "T7"),                        // F (admin via ticket) can invite
    invite("i-T8-unsigned", 23, "A", "T8", "admin", { unsigned: true }),   // unsigned invite → ignored
    invite("i-T9", 24, "A", "T9"),
    claim("c-T9-A", 25, "A", "T9"),                       // the owner can't claim → T9 stays pending
    S("e-a-E", "answer.post", 30, "E", { answerId: "aE", questionId: "q1", content: "E answers (admin via ticket)" }),
    S("e-a-C", "answer.post", 31, "C", { answerId: "aC", questionId: "q1", content: "C is no admin" }),
    S("e-mod-F", "moderate", 32, "F", { questionId: "q1", hidden: false }),
  ];
}
