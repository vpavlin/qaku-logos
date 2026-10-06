# ADR 0001: A Loam identity per room, and moderator invite tickets

Status: **Accepted** (2026-10-06). Builds on loam-keycard ADR 0001 (one root, unlinkable identities) and follows the ticket scheme of Scala ADR 0022.

## Context

- QAKU is anonymous Q&A. Until now every device signed with **one key for all rooms** (`qaku-identity-key` on the phone, `sign.key` in `qaku_core`). Anyone in two rooms with you could tell both authors are the same person.
- Loam now holds one root per person and derives an unlinkable identity per (app, context):
  - phone: `loamIdentityStatus()`, `loamIdentity(contextId)`, `loamSign(contextId, digestHex)` (loam-transport `b64e648`; the app namespace is the approved app, `qaku`);
  - desktop: `loam_core` 0.6.0 `hdStatus()`, `hdIdentity("qaku", contextId)`, `hdSign("qaku", contextId, digestHex)`.
- Rooms **have roles**: the `session.create` author is the owner; owners/admins add admins (`admin.add {memberId}`), answer, moderate (hide), configure and run polls. Granting admin needs the other person's address, and with a fresh identity per room nobody knows it in advance.

## Decision

### 1. One identity per room, always

- **Context id = the room's topic hash**: the 32 hex characters in `/qaku/1/<hash>/proto`, derived from the room secret. Every device of every member computes the same value, before any event has synced.
- When you create or join a room and Loam has a root, the room is **bound to the Loam identity** for (`qaku`, topic hash). There is no "use my main identity" option (loam-keycard ADR 0001: QAKU rooms are per-context, always).
- Events are signed in two halves: the app stamps the author (`hlc.dev` / `dev` = the room address) and computes `sha256(canonicalMessage)`; Loam signs the digest (low-S); the app attaches `{pub, sig}` and checks the signature before using it. The wire format is unchanged, so old clients verify these events.
- **The binding is stable.** Once a room is bound it keeps that identity, and the binding is stored with the room (phone: the room registry; desktop: `<session>/identity.json`). Switching would lose your owner/admin role and split your authorship.
- **Fallback, Loam without a root (or no Loam):** the room is bound to today's device key. "No Loam" includes a Loam too old for identities (phone: `update Loam` / own node; desktop: `hdStatus` failing three times in a row). That key is shared by all such rooms, so they stay linkable; this is the known cost of running without Loam.
- **Existing rooms keep the device key** (they were bound to it before this ADR; your role there depends on it).
- **Root exists but is locked, Loam doesn't answer, or Loam refuses:** the room stays bound to Loam. We never fall back to the device key for a Loam-bound room, which would link it. On the phone the action fails with a clear message; on the desktop the event waits in a per-room outbox (persisted) and is signed once Loam answers, with the reason shown as the room's identity status.
- Every Loam call is asynchronous with an explicit timeout (phone: 20 s inside `hdCall`; desktop: 15 s per `*AsyncResult` call). Nothing blocks the UI or the module's event loop.

### 2. Moderator invite tickets

An invite link is the normal join link plus `&inv=<ticket private key, 64 hex>`: `qaku://join?s=<secret>&inv=<ticket>`. The ticket is a one-time secp256k1 key made for this invite.

| Event | Payload | Counts when |
|---|---|---|
| `member.invite` | `{ticket, role}`; `ticket` = address of the ticket key; `role` = `admin` \| `revoke` | **Signed** by its author, the author is the owner or an admin at that point in HLC order, and the ticket is not yet redeemed. |
| `member.claim` | `{ticket, ticketPub, member, ticketSig}` | **Signed** by its author; `member` == the author; `member` ≠ owner; the ticket is pending; `address(ticketPub)` == `ticket`; `ticketSig` is a **low-S** signature by `ticketPub` over `sha256("qaku-invite-claim-v1|" + roomId + "|" + ticket + "|" + member)`, where `roomId` = the topic hash. |

Rules:

- **The first valid claim in HLC order wins.** The member becomes an admin and the ticket is redeemed; later claims are ignored. Revoking a redeemed ticket does nothing (use `admin.remove`).
- Folded state gains `invites: {ticket → role}` (pending tickets), so admins can see and revoke them.
- **Why low-S:** the phone's verifier (noble) rejects the high-S twin of a signature and OpenSSL accepts it, so `qaku_core` checks low-S explicitly, for ticket signatures and for event signatures in `verifyEvent`.
- **Why the topic hash:** the joiner claims right after joining, before `session.create` has synced, so the claim can't be bound to anything from the log. The topic hash is known from the secret alone.
- Adding an admin by pasting their address (`admin.add`) still works; the address to paste is the person's address **in this room**.

## Consequences

- Both folds (`packages/engine/src/engine.mjs`, `qaku_core/src/qaku_engine.hpp`) implement the invite rules identically. `computeState` / `admitEvents` take the room id (JS `opts.roomId`, C++ third argument); without it no claim verifies.
- Tests:
  - `packages/engine/test/invites.test.mjs` + `vectors/invites.json` (also folded by `qaku_core/test/engine_harness.cpp`): valid claim, double claim, wrong ticket key, claim for someone else, revoked ticket, outsider invite, high-S, claim bound to another room, claim before the invite, unsigned invite, owner claim, and 300 shuffled + duplicated arrival orders;
  - `packages/contract/test/hd-identities.test.mjs`: the loam-keycard derivation vectors, two rooms → two addresses from one root, same room → same address, Loam-signed events verify and fold.
- **Older clients** skip the two new event types: someone who joined by ticket shows up there without the admin role until the client is updated, and an old client can't open an invite link (it rejects the `&inv=` suffix).
- **An invite link is a bearer secret:** whoever opens it first becomes an admin. Revoke tickets that went unused.
- Identities can still be linked by timing, writing style or a display name you reuse across rooms; this removes only the cryptographic link. The display name is still one setting for all rooms.
- The phone's home screen and the desktop's settings still show the device address; it identifies only the fallback key.
