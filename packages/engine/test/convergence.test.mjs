import { test } from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../../contract/src/hlc.mjs";
import { ev, UpvoteTarget } from "../../contract/src/events.mjs";
import { computeState, checkInvariant, mergeEvents } from "../src/engine.mjs";

// Seeded PRNG (mulberry32) — deterministic, reproducible test runs.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const QIDS = ["q0", "q1", "q2", "q3"];
const OPTS = [{ id: "o1", title: "A" }, { id: "o2", title: "B" }, { id: "o3", title: "C" }];

// A shared, agreed base every device starts from: an owner "S" creates the
// session, promotes A and B to admins, seeds a fixed set of questions to
// upvote/answer, and opens one poll. (Deterministic single-writer setup.)
function baseEvents() {
  let t = 1_000_000;
  const c = new Clock("S", () => t++);
  const out = [
    ev.sessionCreate(c.send(), { sessionId: "sess1", title: "Town Hall", description: "AMA" }),
    ev.sessionConfig(c.send(), { moderationEnabled: true }),
    ev.adminAdd(c.send(), { memberId: "A", name: "Alice" }),
    ev.adminAdd(c.send(), { memberId: "B", name: "Bob" }),
  ];
  for (const q of QIDS) out.push(ev.questionAdd(c.send(), { questionId: q, content: `seed ${q}`, author: "seed" }));
  out.push(ev.pollCreate(c.send(), { pollId: "p0", question: "Favourite?", options: OPTS, active: true }));
  return out;
}

// One device authoring a random offline sequence of Q&A edits. Admin devices
// (A,B) also answer/moderate/accept; participants (C,D) only ask/upvote/vote.
function deviceStream(dev, seed, base, isAdmin) {
  const rand = rng(seed);
  let t = 2_000_000 + Math.floor(rand() * 1000); // independent drift while offline
  const clock = new Clock(dev, () => t++);
  for (const b of base) clock.receive(b.hlc);     // prime past the base
  const events = [];
  const n = 8 + Math.floor(rand() * 10);
  let qn = 0, an = 0;
  for (let i = 0; i < n; i++) {
    const r = rand();
    const target = QIDS[Math.floor(rand() * QIDS.length)];
    if (r < 0.30) {
      // upvote a seed question (toggle: mostly up, occasionally retract) — same
      // voter twice is idempotent; different voters union.
      events.push(ev.upvote(clock.send(), { targetType: UpvoteTarget.QUESTION, targetId: target, up: rand() < 0.85 }));
    } else if (r < 0.45) {
      events.push(ev.questionAdd(clock.send(), { questionId: `${dev}-q${qn++}`, content: `${dev} asks ${i}` }));
    } else if (r < 0.6) {
      events.push(ev.pollVote(clock.send(), { pollId: "p0", optionId: OPTS[Math.floor(rand() * OPTS.length)].id }));
    } else if (isAdmin && r < 0.75) {
      const aid = `${dev}-a${an++}`;
      events.push(ev.answerPost(clock.send(), { answerId: aid, questionId: target, content: `${dev} answers` }));
    } else if (isAdmin && r < 0.85) {
      events.push(ev.moderate(clock.send(), { questionId: target, hidden: rand() < 0.5 }));
    } else if (isAdmin) {
      // accept/unaccept: needs an existing answer id — reference one this device made
      if (an > 0) events.push(ev.answerAccept(clock.send(), { questionId: target, answerId: `${dev}-a${Math.floor(rand() * an)}`, accepted: rand() < 0.7 }));
      else events.push(ev.upvote(clock.send(), { targetId: target, up: true }));
    } else {
      // participant filler: upvote an answer id if any exist won't be known; just re-upvote
      events.push(ev.upvote(clock.send(), { targetId: target, up: true }));
    }
  }
  return events;
}

test("N devices' concurrent offline edits converge to identical state + hold the count invariant", () => {
  for (let trial = 0; trial < 200; trial++) {
    const base = baseEvents();
    const specs = [["A", true], ["B", true], ["C", false], ["D", false]];
    const devices = specs.map(([d, adm], i) => deviceStream(d, trial * 13 + i * 101 + 1, base, adm));
    const all = [base, ...devices].flat();

    // Reference fold.
    const ref = computeState(all);
    const refInv = checkInvariant(ref);
    assert.ok(refInv.ok, `trial ${trial}: invariant broke — ${JSON.stringify(refInv.problems)}`);

    // Fold several random arrival orders (+ redelivered duplicates) — all must
    // match the reference exactly.
    const rand = rng(trial * 7 + 3);
    for (let k = 0; k < 4; k++) {
      const withDupes = shuffle([...all, ...shuffle(all, rand).slice(0, 7)], rand); // reorder + redeliver 7
      const s = computeState(withDupes);
      assert.equal(s.eventCount, ref.eventCount, `trial ${trial}: dedup mismatch`);
      assert.deepEqual(s.questions, ref.questions, `trial ${trial}: questions diverged`);
      assert.deepEqual(s.polls, ref.polls, `trial ${trial}: polls diverged`);
      assert.deepEqual(s.admins.sort(), ref.admins.sort(), `trial ${trial}: admins diverged`);
      assert.equal(s.session.moderationEnabled, ref.session.moderationEnabled, `trial ${trial}: config diverged`);
      assert.ok(checkInvariant(s).ok, `trial ${trial}/${k}: invariant broke on reorder`);
    }
  }
});

test("merge is idempotent — redelivering the whole log changes nothing", () => {
  const base = baseEvents();
  const a = deviceStream("A", 42, base, true);
  const once = computeState([base, a].flat());
  const twice = computeState(mergeEvents([base, a].flat(), [base, a].flat(), a));
  assert.deepEqual(twice.questions, once.questions);
  assert.deepEqual(twice.polls, once.polls);
  assert.equal(twice.eventCount, once.eventCount);
});

test("concurrent upvotes from distinct voters all survive (no LWW loss); same voter is idempotent", () => {
  const base = baseEvents();
  // Three different devices upvote q0 offline; one device double-upvotes.
  const mk = (dev, seed) => { const c = new Clock(dev); for (const b of base) c.receive(b.hlc); return c; };
  const cA = mk("A"), cB = mk("B"), cC = mk("C");
  const up = [
    ev.upvote(cA.send(), { targetId: "q0", up: true }),
    ev.upvote(cB.send(), { targetId: "q0", up: true }),
    ev.upvote(cC.send(), { targetId: "q0", up: true }),
    ev.upvote(cC.send(), { targetId: "q0", up: true }), // same voter again — idempotent
  ];
  const s = computeState([base, up].flat());
  const q0 = s.questions.find((q) => q.id === "q0");
  assert.equal(q0.upvotes, 3, "three distinct voters ⇒ 3, not 4 and not 1");
});
