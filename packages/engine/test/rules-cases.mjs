// Shared JS<->C++ rule vectors (review 2026-09-30). Each case is a raw event log (the
// same bytes a peer could put on the wire) plus the projection both engines must fold
// it to. gen-rules-vectors.mjs writes these + the JS projection to vectors/rules.json;
// rules.test.mjs checks the JS engine against it, qaku_core/test/engine_harness.cpp
// checks the C++ engine against the SAME file (the parity guard).

// Raw event (no signature: participant events are always admitted, gated ones are
// legacy-admitted in the default permissive mode, and the C++ fold has no sig gate).
export function E(id, type, wall, dev, payload) {
  return { v: 1, id, type, hlc: { wall, ctr: 0, dev }, dev, payload };
}

// The part of the fold both engines emit identically (JS adds `verified`, C++ doesn't).
export function project(st) {
  const s = st.session;
  return {
    session: s ? { id: s.id, title: s.title, description: s.description, enabled: s.enabled, moderationEnabled: s.moderationEnabled } : null,
    owner: st.owner || "",
    admins: [...st.admins].sort(),
    names: st.names,
    questions: st.questions.map((q) => ({
      id: q.id, content: q.content, author: q.author, moderated: q.moderated,
      acceptedAnswerId: q.acceptedAnswerId, upvotes: q.upvotes, upvoters: q.upvoters,
      answers: q.answers.map((a) => ({ id: a.id, content: a.content, author: a.author, accepted: a.accepted, upvoters: a.upvoters })),
    })),
    polls: st.polls.map((p) => ({ id: p.id, title: p.title, question: p.question, options: p.options, active: p.active, tally: p.tally, votes: p.votes })),
    eventCount: st.eventCount,
  };
}

const create = (wall = 1) => E("e-create", "session.create", wall, "S", { sessionId: "sess", title: "Town Hall", description: "" });

export const cases = [
  {
    name: "upvote/poll voter is the author, payload.voter ignored",
    events: [
      create(),
      E("e-q1", "question.add", 10, "A", { questionId: "q1", content: "hello" }),
      E("e-u1", "upvote", 20, "B", { targetType: "question", targetId: "q1", up: true, voter: "X1" }),
      E("e-u2", "upvote", 21, "B", { targetType: "question", targetId: "q1", up: true, voter: "X2" }),
      E("e-u3", "upvote", 22, "B", { targetType: "question", targetId: "q1", up: true, voter: "X3" }),
      E("e-u4", "upvote", 23, "C", { targetType: "question", targetId: "q1", up: true, voter: "B" }),
      E("e-u5", "upvote", 24, "C", { targetType: "question", targetId: "q1", up: false }),   // C retracts its OWN vote only
      E("e-p1", "poll.create", 30, "S", { pollId: "p1", question: "Pick", options: [{ id: "o1", title: "A" }, { id: "o2", title: "B" }], active: true }),
      E("e-v1", "poll.vote", 40, "C", { pollId: "p1", optionId: "o1", voter: "Y1" }),
      E("e-v2", "poll.vote", 41, "C", { pollId: "p1", optionId: "o2", voter: "Y2" }),
      E("e-v3", "poll.vote", 42, "D", { pollId: "p1", optionId: "o1", voter: "C" }),
    ],
  },
  {
    name: "first question.add wins; creatorOf is the first writer",
    events: [
      create(),
      E("e-qa", "question.add", 10, "A", { questionId: "q1", content: "original" }),
      E("e-qm", "question.add", 20, "M", { questionId: "q1", content: "hijacked", author: "A" }),
      E("e-em", "question.edit", 30, "M", { questionId: "q1", content: "edited by M" }),   // rejected: M is not the creator
      E("e-dm", "question.delete", 31, "M", { questionId: "q1" }),                          // rejected too
      E("e-ea", "question.edit", 40, "A", { questionId: "q1", content: "edited by A" }),   // accepted: A created q1
      E("e-an1", "answer.post", 50, "S", { answerId: "a1", questionId: "q1", content: "first answer" }),
      E("e-an2", "answer.post", 51, "S", { answerId: "a1", questionId: "q1", content: "dup answer" }),
    ],
  },
  {
    name: "malformed payloads never throw and fold identically",
    events: [
      create(),
      E("e-cfg", "session.config", 5, "S", { title: 42, description: null, enabled: "no", moderationEnabled: true }),
      E("e-p1", "poll.create", 10, "S", { pollId: "p1", question: "bad options", options: "not-an-array", active: "yes" }),
      E("e-p2", "poll.create", 11, "S", { pollId: "p2", question: 7, options: [null, 5, "x", [1], { id: "o1", title: "ok" }, { title: "no id" }] }),
      E("e-v1", "poll.vote", 12, "C", { pollId: "p2", optionId: "o1" }),
      E("e-v2", "poll.vote", 13, "D", { pollId: "p2", optionId: 99 }),
      E("e-v3", "poll.vote", 14, "F", { pollId: "p2", optionId: "constructor" }),
      E("e-q1", "question.add", 20, "A", { questionId: "q1", content: 42 }),
      E("e-q2", "question.add", 21, "B", { questionId: "q2", content: { x: 1 }, author: 7 }),
      E("e-q3", "question.add", 22, "C", "a string payload"),
      E("e-q4", "question.add", 23, "D", { questionId: "q4", content: "fine" }),
      E("e-ed", "question.edit", 24, "D", { questionId: "q4", content: ["not", "a", "string"] }),
      E("e-u1", "upvote", 25, "B", { targetId: "q4", up: "yes" }),
      E("e-u2", "upvote", 26, "C", { targetId: 5, up: true }),
      E("e-mod", "moderate", 27, "S", { questionId: "q1", hidden: 1 }),
      E("e-acc", "answer.accept", 28, "S", { questionId: "q4", answerId: 3, accepted: "true" }),
      E("e-n1", "profile.set", 30, "A", { name: 12345 }),
      E("e-n2", "profile.set", 31, "B", { name: null }),
      E("e-adm", "admin.add", 32, "S", { memberId: { evil: true } }),
    ],
  },
  {
    name: "display names are clipped to 40 code points, never mid-character",
    events: [
      create(),
      // 45 x U+00E9 (2 bytes each): a 40-BYTE cut split the 20th char's sequence.
      E("e-n1", "profile.set", 10, "A", { name: "é".repeat(45) }),
      // 41 emoji (4 bytes / a UTF-16 surrogate pair each): a UTF-16 slice split a pair.
      E("e-n2", "profile.set", 11, "B", { name: "\u{1F600}".repeat(41) }),
      E("e-n3", "profile.set", 12, "C", { name: "x".repeat(39) + "\u{1F600}\u{1F600}" }),
    ],
  },
];
