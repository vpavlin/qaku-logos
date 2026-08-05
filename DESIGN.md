# QAKU on Logos — DESIGN

Rebuild of the original React/Vite + Waku Q&A app (`/home/vpavlin/qaku`) as a
**multi-writer, offline-convergent Logos app**: a Basecamp core+view module, an
RN mobile app, and an optional headless hub, all folding the same event log and
syncing over SDS Reliable Channels. This document is the decision log required by
the blueprint (§1 "Decisions up front"). Each choice is justified against the
`logos-multiwriter-sync` skill.

## 0. The domain, extracted from the original

Reading `/home/vpavlin/qaku/src` (it drives everything through the `qakulib`
library): a **session** ("QA", `ControlMessage`) is owner-created and has
`owner`, `admins[]`, `title`, `enabled` (open/closed), and a `moderation` flag. A
session contains **questions** (`EnhancedQuestionMessage`: `hash` id, `content`,
`author`, `upvotes`, `upvotedByMe`, `answers[]`, `moderated`), **answers**
(owner/admin-posted, likeable), **upvotes** (`upvote(id, hash, type)`,
deduplicated per user via `upvotedByMe`), owner **moderation** (`moderate(id,
hash, hidden)`), and **polls** (`newPoll` with options; per-user votes; an
`active` toggle). This is a genuine multi-writer problem: concurrent upvotes
(counters), concurrent questions (appends), owner moderation (author-gated), and
a shared session key (cross-user sharing).

## 1. Event schema (`{v,id,type,hlc,dev,payload}`)

Every change is an immutable, append-only event; current state is a pure
deterministic fold over the **merged** log; merge is **union by `id`**. Nothing
is ever mutated or overwritten, so no concurrent write is lost.[sync §1]

```
Event = { v:1, id:UUIDv4, type, hlc:{wall,ctr,dev}, dev, payload }
```
`id` is the idempotency key (redelivery dedups on it). `v` is present from event
one. `hlc.dev` is the author + HLC tiebreak. Constructors live in
`packages/contract/src/events.mjs` (`ev.*` over `makeEvent`) — call sites never
hand-build events.

### Event types & payloads

| type | payload | class |
|---|---|---|
| `session.create` | `{sessionId,title,description}` | create; author = **owner** |
| `session.config` | `{title?,description?,enabled?,moderationEnabled?}` | **LWW-by-HLC per field**; owner/admin |
| `admin.add` / `admin.remove` | `{memberId,name?}` | membership; owner/admin-gated |
| `question.add` | `{questionId,content,author?}` | append; **any participant** |
| `question.edit` | `{questionId,content}` | **superseding** (field LWW-by-HLC); author or admin |
| `question.delete` | `{questionId}` | **sticky tombstone**; author or admin |
| `upvote` | `{targetType,targetId,up:bool,voter}` | **per-(target,voter) LWW register** (commutative across voters) |
| `answer.post` | `{answerId,questionId,content,author?}` | append; **owner/admin** |
| `answer.edit` / `answer.delete` | `{answerId,content?}` | supersede / tombstone; owner/admin |
| `answer.accept` | `{questionId,answerId,accepted:bool}` | **LWW-by-HLC**; owner/admin |
| `moderate` | `{questionId,hidden:bool}` | **LWW-by-HLC flag**; owner/admin |
| `poll.create` | `{pollId,title,question,options[],active}` | create; owner/admin |
| `poll.setActive` | `{pollId,active:bool}` | **LWW-by-HLC**; owner/admin |
| `poll.delete` | `{pollId}` | tombstone; owner/admin |
| `poll.vote` | `{pollId,optionId,voter}` | **per-voter LWW register**; any participant |

## 2. Commutative deltas vs LWW — the classification (sync §2)

The critical modeling decision. The original `qaku` counts upvotes; a **naive
increment counter is wrong under an append-only log** because redelivery (Waku
Store, RBSR backfill, rebroadcast) would double-count and concurrent increments
race.

- **Upvotes = a per-`(target,voter)` LWW boolean register.** The upvote event
  carries the `voter` identity (defaults to `hlc.dev`). The fold keeps, per
  target, a map `voter → up`, resolved by HLC order; the **count = number of
  voters whose latest state is `up=true`**. This makes upvotes:
  - **commutative across distinct voters** — two people upvoting the same
    question offline both stick (set union), neither lost;
  - **idempotent per voter** — the same voter's event redelivered changes
    nothing (no inflation — the counter bug the skill warns about);
  - **toggle-safe** — a later `up=false` from the same voter retracts, resolved
    LWW-by-HLC, so re-upvoting works.
  This is strictly better than a raw commutative +1 delta here, because a Q&A
  upvote is a *set membership* ("who upvoted"), not a fungible quantity — modeling
  it as a set gives idempotency the +1 delta lacks. Poll votes are the same
  pattern with a value (`optionId`) instead of a boolean: **one live vote per
  voter**, LWW-by-HLC; tally = count of distinct voters per option.
- **LWW-by-HLC** for single-valued attributes where "latest edit wins" is
  correct: `moderate.hidden`, `answer.accept`, `session.config.*`,
  `poll.setActive`, and each field of `question.edit`/`answer.edit`. Resolved by
  `compareHlc` (wall → ctr → dev), never wall-clock alone.[sync §3]
- **Edits are superseding events, deletes are sticky tombstones** — never an
  overwrite (sync §1). Concurrent edits to different fields both survive
  (field-scoped supersede); same-field conflict is LWW-by-HLC. A delete is
  terminal — a late edit cannot resurrect a tombstoned question. The fold is
  **lenient** about ordering: an edit that folds before its create is ignored as
  an orphan rather than gated, and the create landing later still projects
  correctly.

There is **no numeric conservation law** (a Q&A board isn't a ledger), so instead
of a zero-sum invariant we assert **count-integrity** oracles (§4).

## 3. HLC ordering (sync §3)

`HLC = {wall, ctr, dev}`, total order `wall → ctr → dev`, identical on every
replica. `Clock.send()` stamps a local event; `Clock.receive(remoteHlc)` advances
the clock past an ingested cause; the node **primes its clock from the whole log
on load**. Wall time orders only — no domain value is derived from it. Projection
sorts (questions by upvotes, answers, polls) all carry a final **`id` tiebreak**
so the rendered order is total and identical across arrival orders (a `ts`-only
sort would be unstable under reshuffling — found and fixed while making the
convergence test deterministic).

## 4. Invariant oracle — surfaced, never enforced (sync §4)

`checkInvariant(state)` asserts counting laws a naive counter would break:
1. each target's `upvotes === upvoters.length` (no double-count, no dupes);
2. each poll's option tallies **sum to** its distinct-voter count (one live vote
   per voter);
3. every live answer references a known question id.
These are asserted across the 200-trial shuffled-order convergence test and can
be surfaced in the UI, but are **never** used to block, clamp, or drop an event
at merge — a violating state would be a displayed condition, not a merge error.

## 5. Roles / admission model (sync §7)

A session is single-owner: the **owner is the author (`hlc.dev`) of the earliest
`session.create`**. Admins are folded from `admin.add`/`admin.remove` in HLC
order, each membership change **gated by the current admin set** (owner is a
permanent admin). Admission then filters every event:
- owner/admin-only: `session.config`, `admin.*`, `answer.*`, `moderate`,
  `poll.create/setActive/delete`;
- author-or-admin: `question.edit` / `question.delete`;
- any participant (anyone with the session secret): `question.add`, `upvote`,
  `poll.vote`.
Admission is a **deterministic filter folded from the same event set** — it runs
over the merged set and computes owner + final admin set + creator map before
admitting, so it is **order-independent** and convergence still holds. This is
**enforcement-on-merge = attribution, not cryptographic authorization**: anyone
with the session secret can physically write; admission decides what the fold
*honors*. Per-participant signatures / MLS re-key are a later layer.

## 6. Tenant / sharing model (sync §1.4, crypto §1.6)

**One session = one 32-byte secret = one derived content topic = one reliable
channel.** Everything derives from the secret `S`
(`packages/sync/src/crypto.mjs`):
```
K            = HKDF-SHA256(S, salt="qaku-pair-v1")
contentTopic = "/qaku/1/" + hex(HMAC-SHA256(K,"qaku/topic/v1|"+epoch)[0..15]) + "/proto"
Ke           = HKDF-SHA256(K, info="qaku/payload/v1")
fingerprint  = hex(SHA-256(K)[0..2])          // short public session id
wire payload = nonce(12) ‖ ChaCha20-Poly1305(Ke, nonce, plaintext, aad=contentTopic)
```
The topic is HMAC-derived (unlinkable without `K`); the payload is AEAD-sealed
with the topic as AAD so a wrong key/topic fails the tag. **Sharing a session =
handing over the secret** (a pairing link/QR — the original app's session id +
optional password maps onto this). A session whose secret you never share stays
private but still syncs across your own devices + the hub. The channel gives
transport reliability only — it does **not** encrypt; we seal before `channelSend`
and open after receive.

## 7. Transport, cold-start, identity

- **Transport:** SDS Reliable Channels (`logos-reliable-channels`), not raw relay
  or libchat — ordering, gap-fill, retransmit, segmentation inside delivery.
  `channelId == contentTopic == derived topic`; `senderId == deviceId`. The
  sealed `{v:1,type:"EVENT",event}` envelope is what rides inside.
- **Cold-start history:** the channel is live-only. Chosen mechanism: **RBSR set
  reconciliation** (`packages/sync/src/reconcile.mjs`) — peers exchange 16-byte
  range fingerprints ordered by `(hlc.wall,id)` and transfer only the symmetric
  difference — backed by a **hub** that stays online, with a bounded
  rebroadcast-on-join burst as a safety net until store-pull is proven.
- **Identity / senderId:** a stable per-device id, persisted, distinct from the
  session secret. It is the HLC `dev` tiebreak and the channel `senderId`; the
  hub and each client get distinct ids so wire traffic is attributable.

## 8. Layout (mirrors the blueprint / KYM)

```
packages/contract   event schema, HLC, typed constructors   (pure, runnable TS)
packages/engine     mergeEvents + admitEvents + computeState + checkInvariant
packages/sync       crypto (HKDF/HMAC/ChaCha20-Poly1305), wire, SyncNode, reconcile
qaku_core/          universal C++ core: fold+crypto+delivery; snapshot()+actions+stateChanged
module/             pure-QML ui_qml view polling snapshot()
mobile/             RN/Expo app: JNI bridge, config plugin, channel wiring, counters
```
The TS packages are the **reference implementation**; the C++ core must reproduce
the fold byte-for-byte (guard with golden vectors + a parity test, as KYM does).
