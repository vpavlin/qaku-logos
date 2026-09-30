// Fold rules from the 2026-09-30 review: voter = author, first question.add wins,
// creatorOf = first writer, and a malformed payload can never throw or leak a
// non-string into the view. vectors/rules.json is shared with the C++ harness
// (qaku_core/test/engine_harness.cpp), so passing both = JS<->C++ parity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeState, clipName } from "../src/engine.mjs";
import { cases, project, E } from "./rules-cases.mjs";

const vectors = JSON.parse(readFileSync(new URL("./vectors/rules.json", import.meta.url), "utf8"));

function shuffled(arr, seed) {
  let a = seed >>> 0; const rand = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

test("vectors/rules.json is current with rules-cases.mjs (regenerate with gen-rules-vectors.mjs)", () => {
  assert.equal(vectors.length, cases.length);
  for (let i = 0; i < cases.length; i++) assert.deepEqual(vectors[i].events, JSON.parse(JSON.stringify(cases[i].events)), cases[i].name);
});

for (const v of vectors) {
  test(`fold matches the shared vector in every arrival order: ${v.name}`, () => {
    assert.deepEqual(project(computeState(v.events)), v.expect);
    for (let k = 1; k <= 20; k++) {
      const withDupes = shuffled([...v.events, ...v.events.slice(0, 3)], k * 7919);
      assert.deepEqual(project(computeState(withDupes)), v.expect, `order ${k}`);
    }
  });
}

test("upvote + poll vote: one vote per AUTHOR, payload.voter can't mint voters", () => {
  const st = computeState(cases[0].events);
  assert.deepEqual(st.questions[0].upvoters, ["B"]);          // B's 3 spoofed voters = 1 vote; C's forged "B" vote then retract = only C's own
  assert.deepEqual(st.polls[0].tally, { o1: 1, o2: 1 });      // C (last: o2) + D (o1); spoofed Y1/Y2/"C" ignored
});

test("first question.add wins and only its author may edit/delete it", () => {
  const st = computeState(cases[1].events);
  assert.equal(st.questions.length, 1);
  assert.equal(st.questions[0].content, "edited by A");       // M's duplicate add, edit and delete all lost
  assert.equal(st.questions[0].evId, "e-qa");
  assert.equal(st.questions[0].answers[0].content, "first answer");
});

test("malformed payloads: no throw, strings stay strings", () => {
  const junk = [null, undefined, 5, "s", [], [1, 2], { options: 7 }, { questionId: 1, content: {} }];
  const evs = [E("c", "session.create", 1, "S", { sessionId: "x", title: "t" })];
  let n = 0;
  for (const t of ["question.add", "question.edit", "upvote", "poll.create", "poll.vote", "answer.post", "answer.accept", "moderate", "profile.set", "session.config", "admin.add"])
    for (const p of junk) evs.push(E(`j${n++}`, t, 10 + n, "Z", p));
  evs.push(E("p", "poll.create", 500, "S", { pollId: "p", question: "q", options: { not: "array" } }));
  const st = computeState(evs);
  for (const q of st.questions) { assert.equal(typeof q.content, "string"); assert.equal(typeof q.author, "string"); }
  assert.deepEqual(st.polls.find((p) => p.id === "p").options, []);
  assert.equal(typeof st.session.title, "string");
});

test("clipName never splits a character", () => {
  assert.equal([...clipName("\u{1F600}".repeat(50))].length, 40);
  assert.equal(clipName("\u{1F600}".repeat(50)).length, 80);   // 40 whole surrogate pairs
  assert.equal(clipName(5), "");
});
