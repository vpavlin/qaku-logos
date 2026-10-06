// Moderator invite tickets (ADR 0013): outcome checks + convergence. vectors/invites.json is
// folded by the C++ harness too (qaku_core/test/engine_harness.cpp) - passing both = parity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeState, mergeEvents } from "../src/engine.mjs";
import { project } from "./rules-cases.mjs";
import { inviteEvents, ROOM, addr, tickets } from "./invites-cases.mjs";
import { signInviteClaim, verifyInviteClaim, inviteClaimMessage } from "../../contract/src/identity.mjs";

const [vec] = JSON.parse(readFileSync(new URL("./vectors/invites.json", import.meta.url), "utf8"));
const st = computeState(vec.events, { roomId: vec.roomId });
const a = vec.addr;

test("vectors/invites.json is current with invites-cases.mjs (regenerate with gen-invites-vectors.mjs)", () => {
  assert.equal(vec.roomId, ROOM);
  assert.deepEqual(vec.addr, addr);
  assert.deepEqual(vec.events, JSON.parse(JSON.stringify(inviteEvents())));
  assert.deepEqual(project(st), vec.expect);
});

test("outcomes", () => {
  const admins = new Set(st.admins);
  const inv = st.invites;
  const ok = (c, m) => assert.ok(c, m);
  ok(admins.has(a.A) && admins.has(a.B), "owner A + plain admin.add B are admins");
  ok(admins.has(a.F), "F redeemed T1 -> admin (valid claim)");
  ok(!admins.has(a.G), "G: double claim of T1, high-S and other-room claims of T5 all rejected");
  ok(admins.has(a.E), "E redeemed T2 (after a wrong-key attempt was rejected); B (plain admin) could invite");
  ok(!admins.has(a.C), "C: claim of revoked T4 and claim-for-someone-else of T5 rejected");
  ok(!admins.has(a.D), "D: outsider invite T3 never pending; claim before invite T6 didn't count");
  assert.equal(admins.size, 4, "exactly A, B, E, F");
  ok(!(a.T1 in inv) && !(a.T2 in inv), "redeemed tickets are no longer pending (T1 revoke had no effect)");
  ok(!(a.T3 in inv), "outsider D could not offer T3");
  ok(!(a.T4 in inv), "revoked T4 is gone");
  ok(!(a.T8 in inv), "an unsigned invite is ignored");
  assert.deepEqual(Object.keys(inv).sort(), [a.T5, a.T6, a.T7, a.T9].sort(), "exactly T5, T6, T7, T9 pending");
  for (const t of [a.T5, a.T6, a.T7, a.T9]) assert.equal(inv[t], "admin");
  const q = st.questions[0];
  assert.deepEqual(q.answers.map((x) => x.id), ["aE"], "E (admin via ticket) can answer; C can't");
});

test("the claim message, and verifyInviteClaim's rejections", () => {
  assert.equal(inviteClaimMessage("r", "0xt", "0xm"), "qaku-invite-claim-v1|r|0xt|0xm");
  const priv = new Uint8Array(32); priv[31] = 0x21;
  const c = signInviteClaim(priv, ROOM, a.F);
  assert.equal(c.ticket, tickets.T1.address);
  assert.ok(verifyInviteClaim(ROOM, c.ticket, c.ticketPub, a.F, c.ticketSig));
  assert.ok(!verifyInviteClaim(ROOM, c.ticket, c.ticketPub, a.G, c.ticketSig), "another member");
  assert.ok(!verifyInviteClaim("other", c.ticket, c.ticketPub, a.F, c.ticketSig), "another room");
  assert.ok(!verifyInviteClaim("", c.ticket, c.ticketPub, a.F, c.ticketSig), "no room id");
  assert.ok(!verifyInviteClaim(ROOM, tickets.T2.address, c.ticketPub, a.F, c.ticketSig), "pub doesn't match the ticket");
  assert.ok(!verifyInviteClaim(ROOM, c.ticket, c.ticketPub, a.F, c.ticketSig.toUpperCase()), "non-canonical hex");
});

test("without the room id no claim verifies (only plain admin.add counts)", () => {
  const s = computeState(vec.events);
  assert.deepEqual([...s.admins].sort(), [a.A, a.B].sort());
});

test("convergence: 300 shuffled + duplicated arrival orders fold identically", () => {
  const gold = JSON.stringify(project(st));
  let s = 7 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let t = 0; t < 300; t++) {
    const sh = [...vec.events];
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    const withDups = [...sh, sh[t % sh.length], sh[(t * 3) % sh.length]];
    assert.equal(JSON.stringify(project(computeState(mergeEvents(withDups), { roomId: ROOM }))), gold, `order ${t}`);
  }
});
