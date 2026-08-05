// QAKU event log. Every change is an immutable, append-only event; current
// state is a pure deterministic fold over the merged log. Edits are superseding
// events; deletes are tombstones; upvotes/votes are per-voter LWW registers
// (commutative across distinct voters). Merge = union by `id`. See DESIGN.md.
import { randomUUID } from "node:crypto";

/** @typedef {import('./hlc.mjs').HLC} HLC */

export const EventType = {
  // --- session lifecycle (owner/admin gated after create) ---
  SESSION_CREATE: "session.create",   // author (hlc.dev) = founding owner
  SESSION_CONFIG: "session.config",   // LWW-by-HLC per field (title/desc/enabled/moderation)
  ADMIN_ADD: "admin.add",             // owner/admin grants admin
  ADMIN_REMOVE: "admin.remove",       // owner/admin revokes admin (soft; owner is permanent)

  // --- questions (any participant may add; edit/delete = author or admin) ---
  QUESTION_ADD: "question.add",
  QUESTION_EDIT: "question.edit",     // superseding, field-scoped LWW-by-HLC
  QUESTION_DELETE: "question.delete", // sticky tombstone

  // --- upvotes: per-(target,voter) LWW boolean; count = #distinct true voters ---
  // Commutative across distinct voters (union), idempotent per voter, toggle-safe.
  UPVOTE: "upvote",                   // { targetType:'question'|'answer', targetId, up:bool, voter }

  // --- answers (owner/admin gated in qaku) ---
  ANSWER_POST: "answer.post",
  ANSWER_EDIT: "answer.edit",
  ANSWER_DELETE: "answer.delete",
  ANSWER_ACCEPT: "answer.accept",     // { questionId, answerId, accepted:bool } LWW-by-HLC

  // --- moderation (owner/admin gated) ---
  MODERATE: "moderate",               // { questionId, hidden:bool } LWW-by-HLC flag

  // --- polls ---
  POLL_CREATE: "poll.create",         // owner/admin
  POLL_SET_ACTIVE: "poll.setActive",  // owner/admin, LWW-by-HLC
  POLL_DELETE: "poll.delete",         // owner/admin, tombstone
  POLL_VOTE: "poll.vote",             // { pollId, optionId, voter } per-voter LWW register
};

/** admin/owner may moderate + answer + configure; participants may ask + upvote + vote. */
export const Role = { OWNER: "owner", ADMIN: "admin", PARTICIPANT: "participant" };
export const UpvoteTarget = { QUESTION: "question", ANSWER: "answer" };

/**
 * Build an event. `hlc` and `dev` come from the authoring device's Clock.
 * `id` is auto-generated (UUIDv4) unless supplied (tests pass stable ids).
 * `id` is the idempotency key: redelivery dedups on it, merge is union-by-id.
 * @param {string} type @param {HLC} hlc @param {object} payload
 */
export function makeEvent(type, hlc, payload, id = randomUUID()) {
  if (!hlc || typeof hlc.dev !== "string") throw new Error("event requires an HLC with a dev");
  return { v: 1, id, type, hlc, dev: hlc.dev, payload };
}

// Typed constructors — thin sugar over makeEvent, documenting each payload shape.
export const ev = {
  sessionCreate: (hlc, { sessionId, title, description = "" }, id) =>
    makeEvent(EventType.SESSION_CREATE, hlc, { sessionId, title, description }, id),

  // Any subset of fields; only provided keys apply (field-scoped LWW-by-HLC).
  sessionConfig: (hlc, { title, description, enabled, moderationEnabled }, id) =>
    makeEvent(EventType.SESSION_CONFIG, hlc, { title, description, enabled, moderationEnabled }, id),

  adminAdd: (hlc, { memberId, name }, id) =>
    makeEvent(EventType.ADMIN_ADD, hlc, { memberId, name }, id),
  adminRemove: (hlc, { memberId }, id) =>
    makeEvent(EventType.ADMIN_REMOVE, hlc, { memberId }, id),

  questionAdd: (hlc, { questionId, content, author }, id) =>
    makeEvent(EventType.QUESTION_ADD, hlc, { questionId, content, author }, id),
  questionEdit: (hlc, { questionId, content }, id) =>
    makeEvent(EventType.QUESTION_EDIT, hlc, { questionId, content }, id),
  questionDelete: (hlc, { questionId }, id) =>
    makeEvent(EventType.QUESTION_DELETE, hlc, { questionId }, id),

  // up=true is an upvote, up=false retracts it (toggle). voter is the identity
  // whose vote this is (defaults to hlc.dev). Concurrent upvotes by DIFFERENT
  // voters all survive (set union); the same voter toggling resolves LWW-by-HLC.
  upvote: (hlc, { targetType = UpvoteTarget.QUESTION, targetId, up = true, voter }, id) =>
    makeEvent(EventType.UPVOTE, hlc, { targetType, targetId, up, voter: voter || hlc.dev }, id),

  answerPost: (hlc, { answerId, questionId, content, author }, id) =>
    makeEvent(EventType.ANSWER_POST, hlc, { answerId, questionId, content, author }, id),
  answerEdit: (hlc, { answerId, content }, id) =>
    makeEvent(EventType.ANSWER_EDIT, hlc, { answerId, content }, id),
  answerDelete: (hlc, { answerId }, id) =>
    makeEvent(EventType.ANSWER_DELETE, hlc, { answerId }, id),
  answerAccept: (hlc, { questionId, answerId, accepted = true }, id) =>
    makeEvent(EventType.ANSWER_ACCEPT, hlc, { questionId, answerId, accepted }, id),

  moderate: (hlc, { questionId, hidden = true }, id) =>
    makeEvent(EventType.MODERATE, hlc, { questionId, hidden }, id),

  pollCreate: (hlc, { pollId, title = "", question, options, active = false }, id) =>
    makeEvent(EventType.POLL_CREATE, hlc, { pollId, title, question, options, active }, id),
  pollSetActive: (hlc, { pollId, active }, id) =>
    makeEvent(EventType.POLL_SET_ACTIVE, hlc, { pollId, active }, id),
  pollDelete: (hlc, { pollId }, id) =>
    makeEvent(EventType.POLL_DELETE, hlc, { pollId }, id),
  pollVote: (hlc, { pollId, optionId, voter }, id) =>
    makeEvent(EventType.POLL_VOTE, hlc, { pollId, optionId, voter: voter || hlc.dev }, id),
};
