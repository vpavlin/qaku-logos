// QAKU engine — the pure, deterministic fold from a merged event log to Q&A
// session state, plus role-based admission and a count-integrity invariant
// oracle. No I/O, no platform deps. This is the reference implementation; the
// C++ core (qaku_core) must reproduce it exactly. See DESIGN.md.

import { EventType, Role, UpvoteTarget } from "../../contract/src/events.mjs";
import { compareHlc } from "../../contract/src/hlc.mjs";

/**
 * Merge any number of event logs into one deduped, HLC-ordered array.
 * Union by event id (idempotent — re-delivery is a no-op). Pure.
 */
export function mergeEvents(...logs) {
  const byId = new Map();
  for (const log of logs) for (const e of log) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => compareHlc(a.hlc, b.hlc));
}

const ADMIN_EVENTS = new Set([EventType.ADMIN_ADD, EventType.ADMIN_REMOVE]);
// Events only an owner/admin may author.
const MOD_EVENTS = new Set([
  EventType.SESSION_CONFIG, EventType.ANSWER_POST, EventType.ANSWER_EDIT,
  EventType.ANSWER_DELETE, EventType.ANSWER_ACCEPT, EventType.MODERATE,
  EventType.POLL_CREATE, EventType.POLL_SET_ACTIVE, EventType.POLL_DELETE,
]);
// Anyone with the session secret may author these (a participant).
const PARTICIPANT_EVENTS = new Set([
  EventType.QUESTION_ADD, EventType.UPVOTE, EventType.POLL_VOTE,
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
  const ordered = mergeEvents(events);

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
    if (e.type === EventType.ADMIN_ADD) admins.add(e.payload.memberId);
    else if (e.type === EventType.ADMIN_REMOVE && e.payload.memberId !== owner) admins.delete(e.payload.memberId);
  }

  // Creator of each question/answer (for author-gated edit/delete).
  const creatorOf = new Map();
  for (const e of ordered) {
    if (e.type === EventType.QUESTION_ADD) creatorOf.set(e.payload.questionId, e.hlc.dev);
    else if (e.type === EventType.ANSWER_POST) creatorOf.set(e.payload.answerId, e.hlc.dev);
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
      if (admins.has(author) || creatorOf.get(e.payload.questionId) === author) admitted.push(e);
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
    const { targetId, voter, up } = e.payload;
    let m = reg.get(targetId);
    if (!m) { m = new Map(); reg.set(targetId, m); }
    m.set(voter, up); // ordered ascending ⇒ later event overwrites; toggle-safe, idempotent
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

  for (const e of ordered) {
    const p = e.payload;
    switch (e.type) {
      case EventType.SESSION_CREATE:
        if (!session) session = {
          id: p.sessionId, title: p.title, description: p.description || "",
          owner: e.hlc.dev, enabled: true, moderationEnabled: false, createdAt: e.hlc.wall,
        };
        break;
      case EventType.SESSION_CONFIG:
        if (session) {
          if (p.title != null) session.title = p.title;
          if (p.description != null) session.description = p.description;
          if (p.enabled != null) session.enabled = p.enabled;
          if (p.moderationEnabled != null) session.moderationEnabled = p.moderationEnabled;
        }
        break;
      case EventType.QUESTION_ADD: {
        const cur = questions.get(p.questionId);
        if (cur) cur.view = { ...cur.view, ...p };
        else questions.set(p.questionId, { view: { id: p.questionId, content: p.content, author: p.author || e.hlc.dev, ts: e.hlc.wall, moderated: false, acceptedAnswerId: null }, deleted: false });
        break;
      }
      case EventType.QUESTION_EDIT: {
        const cur = questions.get(p.questionId);
        if (!cur) break;                    // orphan edit — ignore (create may fold later; lenient)
        if (p.content != null) cur.view.content = p.content;   // field supersede, HLC order
        break;
      }
      case EventType.QUESTION_DELETE: {
        const cur = questions.get(p.questionId);
        if (cur) cur.deleted = true;        // sticky tombstone
        break;
      }
      case EventType.MODERATE: {
        const cur = questions.get(p.questionId);
        if (cur) cur.view.moderated = !!p.hidden;   // LWW-by-HLC flag
        break;
      }
      case EventType.ANSWER_POST: {
        const cur = answers.get(p.answerId);
        if (cur) cur.view = { ...cur.view, ...p };
        else answers.set(p.answerId, { view: { id: p.answerId, questionId: p.questionId, content: p.content, author: p.author || e.hlc.dev, ts: e.hlc.wall, accepted: false }, deleted: false });
        break;
      }
      case EventType.ANSWER_EDIT: {
        const cur = answers.get(p.answerId);
        if (cur && p.content != null) cur.view.content = p.content;
        break;
      }
      case EventType.ANSWER_DELETE: {
        const cur = answers.get(p.answerId);
        if (cur) cur.deleted = true;
        break;
      }
      case EventType.ANSWER_ACCEPT: {
        const cur = answers.get(p.answerId);
        if (cur) cur.view.accepted = !!p.accepted;   // LWW-by-HLC
        const q = questions.get(p.questionId);
        if (q) q.view.acceptedAnswerId = p.accepted ? p.answerId : (q.view.acceptedAnswerId === p.answerId ? null : q.view.acceptedAnswerId);
        break;
      }
      case EventType.POLL_CREATE: {
        const cur = polls.get(p.pollId);
        if (cur) cur.view = { ...cur.view, ...p };
        else polls.set(p.pollId, { view: { id: p.pollId, title: p.title || "", question: p.question, options: p.options, active: !!p.active, ts: e.hlc.wall }, deleted: false, votes: new Map() });
        break;
      }
      case EventType.POLL_SET_ACTIVE: {
        const cur = polls.get(p.pollId);
        if (cur) cur.view.active = !!p.active;        // LWW-by-HLC
        break;
      }
      case EventType.POLL_DELETE: {
        const cur = polls.get(p.pollId);
        if (cur) cur.deleted = true;
        break;
      }
      case EventType.POLL_VOTE: {
        const cur = polls.get(p.pollId);
        if (cur) cur.votes.set(p.voter, p.optionId);  // per-voter LWW register (HLC order)
        break;
      }
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
    for (const [, optionId] of pl.votes) { if (optionId in tally) { tally[optionId] += 1; voters += 1; } }
    return { ...pl.view, tally, votes: voters };
  }).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

  return {
    session,
    owner: admission.owner,
    admins: admission.admins,
    isSession: admission.isSession,
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
