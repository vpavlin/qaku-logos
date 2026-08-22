import { test } from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../../contract/src/hlc.mjs";
import { ev } from "../../contract/src/events.mjs";
import { newSecret, deriveIdentity, topicFor, seal, open } from "../src/crypto.mjs";
import { SyncNode } from "../src/node.mjs";
import { reconcile, eventsToSend } from "../src/reconcile.mjs";

test("seal/open round-trips with the right key; a wrong key throws", () => {
  const id = deriveIdentity(newSecret());
  const topic = topicFor(id);
  const pt = new TextEncoder().encode("hello qaku");
  const sealed = seal(id, "test-seal", pt, topic);
  assert.deepEqual(open(id, sealed, topic), pt);

  const other = deriveIdentity(newSecret());
  assert.throws(() => open(other, sealed, topic), "wrong session key must fail the AEAD tag");
  // Tamper a byte → tag fails.
  const bad = sealed.slice(); bad[20] ^= 1;
  assert.throws(() => open(id, bad, topic));
});

test("the same secret derives the same topic + fingerprint on every device", () => {
  const s = newSecret();
  const a = deriveIdentity(s), b = deriveIdentity(Uint8Array.from(s));
  assert.equal(topicFor(a), topicFor(b));
  assert.equal(a.fingerprint, b.fingerprint);
});

test("two SyncNodes on one secret converge over the sealed wire", () => {
  const secret = newSecret();
  const A = new SyncNode(secret, { device: "A" });
  const B = new SyncNode(secret, { device: "B" });
  assert.equal(A.topic, B.topic, "same secret ⇒ same content topic (same channel)");

  // A creates the session; B upvotes offline; they exchange sealed bytes.
  const wire = [];
  wire.push(A.append(ev.sessionCreate(A.now(), { sessionId: "s", title: "Q&A" })));
  wire.push(A.append(ev.questionAdd(A.now(), { questionId: "q0", content: "first?" })));
  for (const w of wire) B.ingest(w);                       // B catches up

  const bUp = B.append(ev.upvote(B.now(), { targetId: "q0", up: true }));
  const aQ = A.append(ev.questionAdd(A.now(), { questionId: "q1", content: "second?" }));
  // cross-deliver, including a duplicate (idempotent)
  assert.equal(A.ingest(bUp), true);
  assert.equal(A.ingest(bUp), false, "redelivery is a no-op");
  B.ingest(aQ);

  assert.deepEqual(A.state().questions, B.state().questions, "nodes converge");
  const q0 = A.state().questions.find((q) => q.id === "q0");
  assert.equal(q0.upvotes, 1);
});

test("RBSR finds the exact symmetric difference", () => {
  const c = new Clock("A", (() => { let t = 1000; return () => t++; })());
  const shared = [
    ev.sessionCreate(c.send(), { sessionId: "s", title: "T" }),
    ev.questionAdd(c.send(), { questionId: "q0", content: "a" }),
    ev.questionAdd(c.send(), { questionId: "q1", content: "b" }),
  ];
  const onlyA = [ev.upvote(c.send(), { targetId: "q0", up: true })];
  const onlyB = [ev.questionAdd(c.send(), { questionId: "q2", content: "c" })];
  const A = [...shared, ...onlyA];
  const B = [...shared, ...onlyB];
  const r = reconcile(A, B);
  assert.deepEqual(r.aNeeds.sort(), onlyB.map((e) => e.id).sort(), "A needs B's extra event");
  assert.deepEqual(r.bNeeds.sort(), onlyA.map((e) => e.id).sort(), "B needs A's extra event");
  // Apply the diff → both hold the union.
  const A2 = [...A, ...eventsToSend(B, r.aNeeds)];
  assert.equal(A2.length, 5);
});
