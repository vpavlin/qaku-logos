// QAKU engine — the pure, deterministic fold from a merged event log to Q&A
// session state, plus role-based admission and a count-integrity invariant
// oracle. No I/O, no platform deps. This is the reference implementation; the
// C++ core (qaku_core) must reproduce it exactly. See DESIGN.md.

import { EventType, Role, UpvoteTarget } from "../../contract/src/events.mjs";
import { verifyEvent } from "../../contract/src/identity.mjs";
// The CRDT merge (union-by-id + HLC ordering) is now SOURCED FROM loam-sync (single
// source), imported from the in-tree submodule's dist by RELATIVE path — same union +
// compareHlc ordering qaku always used. qaku keeps its own fold + event types below.
import { mergeEvents as LMerge } from "../../loam-sync/dist/merge.js";

// Signature admission. Authored events carry a secp256k1 signature (identity.mjs); the
// author (hlc.dev) is the signer's address, so admin/creator gating becomes spoof-proof.
// TRANSITION: default is PERMISSIVE — a SIGNED event must verify (bad sig ⇒ dropped),
// but an UNSIGNED (legacy / not-yet-updated peer) event is still admitted, so mobile and
// desktop keep syncing while both sides roll out signing. Flip to STRICT (drop unsigned)
// via setSignatureMode({strict:true}) once every writer signs. Must match qaku_engine.hpp.
let STRICT_SIG = false;
export function setSignatureMode({ strict } = {}) { STRICT_SIG = !!strict; }
export function getSignatureMode() { return { strict: STRICT_SIG }; }
function sigVerified(e) { return !!(e && e.sig) && verifyEvent(e); }
function sigOk(e) {
  // PARTICIPANT events (question/upvote/profile) are open to anyone with the secret — a bad
  // or missing signature must NEVER drop them (that silently hid a re-received copy of your
  // own question; basecamp's C++ engine has no sig check, so it kept showing it → the mobile
  // side was stricter and lost it). They just render without a "verified ✓". GATED events
  // (answer/moderate/admin/config/session) still require a valid signature so forgery of
  // privileged actions stays blocked.
  if (e && PARTICIPANT_EVENTS.has(e.type)) return true;
  if (e && e.sig) return verifyEvent(e);   // gated + signed → must be cryptographically valid
  return !STRICT_SIG;                        // gated + unsigned → legacy-admit unless strict
}

/**
 * Merge any number of event logs into one deduped, HLC-ordered array.
 * Union by event id (idempotent — re-delivery is a no-op). Pure.
 * Folds through loam-sync's mergeEvents (single source); qaku's variadic API preserved.
 */
export function mergeEvents(...logs) {
  return LMerge(...logs);
}

// Tolerant payload reads. A peer can put anything in a payload (old client, bug, or
// hostile writer); a wrong-typed field must never throw in the fold or reach a <Text>
// as a non-string. Missing / null / wrong-typed => the default. Mirrors jget() in
// qaku_engine.hpp so both engines see the same value for the same bytes.
function str(v, def = "") { return typeof v === "string" ? v : def; }
function bool(v, def) { return typeof v === "boolean" ? v : def; }
// Poll options: an array of objects with a non-empty string id; anything else is dropped
// (a non-array crashed the fold; an id-less option would soak up malformed votes).
function optionsOf(v) { return Array.isArray(v) ? v.filter((o) => o !== null && typeof o === "object" && !Array.isArray(o) && typeof o.id === "string" && o.id !== "") : []; }
// Display names are capped at 40 Unicode CODE POINTS (never mid-character: a UTF-16
// .slice could split a surrogate pair, the C++ byte cut split UTF-8). Same rule as
// qaku::utf8Clip in qaku_engine.hpp.
export const NAME_MAX = 40;
export function clipName(s) { return [...str(s)].slice(0, NAME_MAX).join(""); }
function payloadOf(e) { return e.payload !== null && typeof e.payload === "object" && !Array.isArray(e.payload) ? e.payload : {}; }

const ADMIN_EVENTS = new Set([EventType.ADMIN_ADD, EventType.ADMIN_REMOVE]);
// Events only an owner/admin may author.
const MOD_EVENTS = new Set([
  EventType.SESSION_CONFIG, EventType.ANSWER_POST, EventType.ANSWER_EDIT,
  EventType.ANSWER_DELETE, EventType.ANSWER_ACCEPT, EventType.MODERATE,
  EventType.POLL_CREATE, EventType.POLL_SET_ACTIVE, EventType.POLL_DELETE,
]);
// Anyone with the session secret may author these (a participant). profile.set only
// names the author's OWN address, so it's self-scoped and safe for anyone to author.
const PARTICIPANT_EVENTS = new Set([
  EventType.QUESTION_ADD, EventType.UPVOTE, EventType.POLL_VOTE, EventType.PROFILE_SET,
]);

/**
 * Role admission. The session is single-owner (the `session.create` author).
 * Admins are folded from `admin.add`/`admin.remove` in HLC order, each gated by
 * the current admin set (owner is permanent admin). Content-moderation events
 * are admitted only from an owner/admin; question.edit/delete from the question's
 * author OR an admin; participant events from anyone with the key. Non-admitted
 * events are dropped deterministically (same input set ⇒ same result in any
 * arrival order), so convergence still holds. This is enforcement-on-merge:
 * attribution, not cryptographic authorization.
 * Returns { admitted (HLC-ordered), owner, admins:[], isSession }.
 */
export function admitEvents(events) {
  // Signature gate first: drop forged/invalid-signed events (and, in strict mode,
  // unsigned ones) before any role fold, so a bad signer can't influence admission.
  const ordered = mergeEvents(events.filter(sigOk));

  // Owner = author of the earliest session.create.
  let owner = null;
  for (const e of ordered) {
    if (e.type === EventType.SESSION_CREATE) { owner = e.hlc.dev; break; }
  }
  const isSession = owner !== null;

  // Fold the admin set in HLC order, each membership change gated by the set.
  const admins = new Set();
  if (owner) admins.add(owner);
  for (const e of ordered) {
    if (!ADMIN_EVENTS.has(e.type)) continue;
    if (!admins.has(e.hlc.dev)) continue;            // only an admin may change admins
    const m = str(payloadOf(e).memberId);
    if (e.type === EventType.ADMIN_ADD) { if (m) admins.add(m); }
    else if (e.type === EventType.ADMIN_REMOVE && m !== owner) admins.delete(m);
  }

  // Creator of each question/answer (for author-gated edit/delete). FIRST writer wins
  // (earliest in HLC order): a later question.add reusing someone else's questionId
  // must not hand the impostor edit/delete rights. Matches the fold, which also keeps
  // the first question.add, so both are arrival-order independent.
  const creatorOf = new Map();
  for (const e of ordered) {
    const p = payloadOf(e);
    const id = e.type === EventType.QUESTION_ADD ? str(p.questionId) : e.type === EventType.ANSWER_POST ? str(p.answerId) : null;
    if (id && !creatorOf.has(id)) creatorOf.set(id, e.hlc.dev);
  }

  const admitted = [];
  for (const e of ordered) {
    const author = e.hlc.dev;
    if (!isSession) { admitted.push(e); continue; } // no session.create yet: admit all (lenient)
    if (e.type === EventType.SESSION_CREATE) { admitted.push(e); continue; }
    if (ADMIN_EVENTS.has(e.type)) {
      if (admins.has(author)) admitted.push(e);      // (already folded above; keep for downstream)
      continue;
    }
    if (MOD_EVENTS.has(e.type)) {
      if (admins.has(author)) admitted.push(e);
      continue;
    }
    if (e.type === EventType.QUESTION_EDIT || e.type === EventType.QUESTION_DELETE) {
      if (admins.has(author) || creatorOf.get(str(payloadOf(e).questionId)) === author) admitted.push(e);
      continue;
    }
    if (PARTICIPANT_EVENTS.has(e.type)) { admitted.push(e); continue; }
    // unknown type — drop
  }
  return { admitted, owner, admins: [...admins], isSession };
}

/** Fold per-(target,voter) LWW upvote registers → Set<voter> of live upvoters per target. */
function foldUpvotes(ordered) {
  // reg: targetId -> Map(voter -> {up, hlc})  (HLC-ordered fold ⇒ last write wins)
  const reg = new Map();
  for (const e of ordered) {
    if (e.type !== EventType.UPVOTE) continue;
    const p = payloadOf(e);
    const targetId = str(p.targetId);
    // The voter IS the author (hlc.dev, the signer). payload.voter is ignored: honouring
    // it let one writer cast votes "as" any number of made-up voters.
    const voter = e.hlc.dev;
    let m = reg.get(targetId);
    if (!m) { m = new Map(); reg.set(targetId, m); }
    m.set(voter, bool(p.up, true)); // ordered ascending ⇒ later event overwrites; toggle-safe, idempotent
  }
  const out = new Map(); // targetId -> Set<voter up===true>
  for (const [tid, m] of reg) {
    const s = new Set();
    for (const [voter, up] of m) if (up) s.add(voter);
    out.set(tid, s);
  }
  return out;
}

/**
 * Fold an event log (possibly unordered / with duplicates) into session state.
 * @param {object[]} events
 */
export function computeState(events) {
  const admission = admitEvents(events);
  const ordered = admission.admitted;

  let session = null; // {id, title, description, enabled, moderationEnabled}
  const questions = new Map(); // qid -> {..., deleted}
  const answers = new Map();   // aid -> {..., deleted}
  const polls = new Map();     // pid -> {..., deleted, votes: Map<voter,optionId>}
  const names = new Map();     // address -> latest display name (LWW-by-HLC, ordered fold)

  for (const e of ordered) {
    const p = payloadOf(e);
    switch (e.type) {
      case EventType.SESSION_CREATE:
        if (!session) session = {
          id: str(p.sessionId), title: str(p.title), description: str(p.description),
          owner: e.hlc.dev, enabled: true, moderationEnabled: false, createdAt: e.hlc.wall,
        };
        break;
      case EventType.SESSION_CONFIG:
        if (session) {   // typed fields only: a wrong-typed patch field is ignored, never stored
          if (typeof p.title === "string") session.title = p.title;
          if (typeof p.description === "string") session.description = p.description;
          if (typeof p.enabled === "boolean") session.enabled = p.enabled;
          if (typeof p.moderationEnabled === "boolean") session.moderationEnabled = p.moderationEnabled;
        }
        break;
      case EventType.QUESTION_ADD: {
        // FIRST question.add for an id wins (HLC order); a later duplicate is ignored,
        // never merged over it (that let anyone rewrite someone else's question).
        const qid = str(p.questionId);
        if (qid && !questions.has(qid)) questions.set(qid, { view: { id: qid, evId: e.id, content: str(p.content), author: str(p.author) || e.hlc.dev, verified: sigVerified(e), ts: e.hlc.wall, moderated: false, acceptedAnswerId: null }, deleted: false });
        break;
      }
      case EventType.QUESTION_EDIT: {
        const cur = questions.get(str(p.questionId));
        if (!cur) break;                    // orphan edit — ignore (create may fold later; lenient)
        if (typeof p.content === "string") cur.view.content = p.content;   // field supersede, HLC order
        break;
      }
      case EventType.QUESTION_DELETE: {
        const cur = questions.get(str(p.questionId));
        if (cur) cur.deleted = true;        // sticky tombstone
        break;
      }
      case EventType.MODERATE: {
        const cur = questions.get(str(p.questionId));
        if (cur) cur.view.moderated = bool(p.hidden, true);   // LWW-by-HLC flag
        break;
      }
      case EventType.ANSWER_POST: {
        const aid = str(p.answerId);       // first post wins, like questions (and the C++ fold)
        if (aid && !answers.has(aid)) answers.set(aid, { view: { id: aid, evId: e.id, questionId: str(p.questionId), content: str(p.content), author: str(p.author) || e.hlc.dev, verified: sigVerified(e), ts: e.hlc.wall, accepted: false }, deleted: false });
        break;
      }
      case EventType.ANSWER_EDIT: {
        const cur = answers.get(str(p.answerId));
        if (cur && typeof p.content === "string") cur.view.content = p.content;
        break;
      }
      case EventType.ANSWER_DELETE: {
        const cur = answers.get(str(p.answerId));
        if (cur) cur.deleted = true;
        break;
      }
      case EventType.ANSWER_ACCEPT: {
        const aid = str(p.answerId), accepted = bool(p.accepted, true);
        if (!aid) break;                      // no answer id: nothing to accept
        const cur = answers.get(aid);
        if (cur) cur.view.accepted = accepted;   // LWW-by-HLC
        const q = questions.get(str(p.questionId));
        if (q) q.view.acceptedAnswerId = accepted ? aid : (q.view.acceptedAnswerId === aid ? null : q.view.acceptedAnswerId);
        break;
      }
      case EventType.POLL_CREATE: {
        const pid = str(p.pollId);         // first create wins (C++ parity)
        if (pid && !polls.has(pid)) polls.set(pid, { view: { id: pid, title: str(p.title), question: str(p.question), options: optionsOf(p.options), active: bool(p.active, false), ts: e.hlc.wall }, deleted: false, votes: new Map() });
        break;
      }
      case EventType.POLL_SET_ACTIVE: {
        const cur = polls.get(str(p.pollId));
        if (cur) cur.view.active = bool(p.active, false);        // LWW-by-HLC
        break;
      }
      case EventType.POLL_DELETE: {
        const cur = polls.get(str(p.pollId));
        if (cur) cur.deleted = true;
        break;
      }
      case EventType.POLL_VOTE: {
        const cur = polls.get(str(p.pollId));
        // per-voter LWW register (HLC order); the voter is the author, never payload.voter
        if (cur) cur.votes.set(e.hlc.dev, str(p.optionId));
        break;
      }
      case EventType.PROFILE_SET:
        if (typeof p.name === "string") names.set(e.hlc.dev, clipName(p.name)); // LWW per author
        break;
      default: break;
    }
  }

  const upvoters = foldUpvotes(ordered);

  // --- projection --------------------------------------------------------
  const liveAnswers = [...answers.values()].filter((a) => !a.deleted).map((a) => {
    const s = upvoters.get(a.view.id) || new Set();
    return { ...a.view, upvotes: s.size, upvoters: [...s].sort() };
  });
  const answersByQ = new Map();
  for (const a of liveAnswers) {
    if (!answersByQ.has(a.questionId)) answersByQ.set(a.questionId, []);
    answersByQ.get(a.questionId).push(a);
  }

  const liveQuestions = [...questions.values()].filter((q) => !q.deleted).map((q) => {
    const s = upvoters.get(q.view.id) || new Set();
    const qa = (answersByQ.get(q.view.id) || []).sort((x, y) => y.upvotes - x.upvotes || x.ts - y.ts || (x.id < y.id ? -1 : 1));
    return { ...q.view, upvotes: s.size, upvoters: [...s].sort(), answers: qa };
  }).sort((a, b) => b.upvotes - a.upvotes || a.ts - b.ts || (a.id < b.id ? -1 : 1));

  const livePolls = [...polls.values()].filter((pl) => !pl.deleted).map((pl) => {
    const tally = {}; for (const o of pl.view.options) tally[o.id] = 0;
    let voters = 0;
    for (const [, optionId] of pl.votes) { if (Object.prototype.hasOwnProperty.call(tally, optionId)) { tally[optionId] += 1; voters += 1; } }
    return { ...pl.view, tally, votes: voters };
  }).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

  return {
    session,
    owner: admission.owner,
    admins: admission.admins,
    isSession: admission.isSession,
    names: Object.fromEntries(names),
    questions: liveQuestions,
    polls: livePolls,
    questionCount: liveQuestions.length,
    answerCount: liveAnswers.length,
    eventCount: ordered.length,
  };
}

/**
 * Count-integrity invariant oracle. A Q&A board has no numeric conservation
 * law, but it DOES have counting laws that a naive increment counter would break
 * under redelivery/reorder — so we assert them across convergence runs:
 *   - each target's upvote count equals its distinct-voter set size (no double count);
 *   - each poll's option tallies sum to its distinct-voter count (one live vote per voter);
 *   - every live answer references a known question id.
 * Surfaced (never enforced at merge). Returns { ok, ... }.
 */
export function checkInvariant(state) {
  const problems = [];
  const qids = new Set(state.questions.map((q) => q.id));
  for (const q of state.questions) {
    if (q.upvotes !== q.upvoters.length) problems.push(`q${q.id} upvote count != voter set`);
    if (new Set(q.upvoters).size !== q.upvoters.length) problems.push(`q${q.id} duplicate upvoter`);
    for (const a of q.answers) {
      if (a.upvotes !== a.upvoters.length) problems.push(`a${a.id} upvote count != voter set`);
      if (!qids.has(a.questionId)) problems.push(`a${a.id} references missing question`);
    }
  }
  for (const pl of state.polls) {
    const sum = Object.values(pl.tally).reduce((s, v) => s + v, 0);
    if (sum !== pl.votes) problems.push(`poll ${pl.id} tally sum ${sum} != voters ${pl.votes}`);
  }
  return { ok: problems.length === 0, problems };
}
