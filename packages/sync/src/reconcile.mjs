// Range-Based Set Reconciliation for the QAKU event log — the bandwidth-efficient
// replacement for "resend the whole log" cold-start backfill. Two peers exchange
// small fingerprints over sorted ranges of their event-id set, recursively
// splitting only where the fingerprints disagree, until each side learns the
// EXACT set of event-ids it's missing. Only those events are then transferred.
//
// Pure functions of two event sets — testable without any transport. Order events
// by (hlc.wall, id); fingerprint = XOR of per-id SHA-256 folded with the count,
// first 16 bytes. Algorithm-aligned with Negentropy/RBSR (Waku's choice).
// Zero-dependency: node:crypto sha256.
import { createHash } from "node:crypto";

const enc = (s) => Buffer.from(s, "utf8");
const sha256 = (b) => new Uint8Array(createHash("sha256").update(Buffer.from(b)).digest());

function keyCmp(a, b) {
  if (a.wall !== b.wall) return a.wall - b.wall;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Sort events into the canonical reconciliation order. */
export function toItems(events) {
  return events.map((e) => ({ wall: e.hlc.wall, id: e.id })).sort(keyCmp);
}

function fingerprint(items) {
  const acc = new Uint8Array(32);
  for (const it of items) {
    const h = sha256(enc(it.id));
    for (let i = 0; i < 32; i++) acc[i] ^= h[i];
  }
  const countBuf = new Uint8Array(4);
  new DataView(countBuf.buffer).setUint32(0, items.length);
  const fp = sha256(new Uint8Array([...acc, ...countBuf])).slice(0, 16);
  return Buffer.from(fp).toString("hex");
}

function inRange(items, lo, hi) {
  return items.filter((it) => {
    if (lo && keyCmp(it, lo) < 0) return false;
    if (hi && keyCmp(it, hi) >= 0) return false;
    return true;
  });
}

/**
 * Reconcile two event sets → the exact symmetric difference plus control cost:
 *   { aNeeds:[id], bNeeds:[id], rounds, comparisons, controlBytes }
 * aNeeds = ids A lacks (B has); bNeeds = ids B lacks (A has). No payloads move.
 */
export function reconcile(eventsA, eventsB, { threshold = 8, buckets = 16 } = {}) {
  const A = toItems(eventsA), B = toItems(eventsB);
  const aNeeds = new Set(), bNeeds = new Set();
  let rounds = 0, comparisons = 0, controlBytes = 0;
  let frontier = [{ lo: null, hi: null }];
  while (frontier.length) {
    rounds++;
    const next = [];
    for (const { lo, hi } of frontier) {
      const ia = inRange(A, lo, hi), ib = inRange(B, lo, hi);
      comparisons++;
      controlBytes += 16 * 2;
      if (fingerprint(ia) === fingerprint(ib)) continue;
      const larger = ia.length >= ib.length ? ia : ib;
      if (larger.length <= threshold) {
        const aSet = new Set(ia.map((x) => x.id));
        const bSet = new Set(ib.map((x) => x.id));
        for (const x of ib) if (!aSet.has(x.id)) aNeeds.add(x.id);
        for (const x of ia) if (!bSet.has(x.id)) bNeeds.add(x.id);
        controlBytes += (ia.length + ib.length) * 36;
        continue;
      }
      const step = Math.ceil(larger.length / buckets);
      let subLo = lo;
      for (let i = 0; i < larger.length; i += step) {
        const nextItem = larger[i + step];
        const subHi = nextItem ? { wall: nextItem.wall, id: nextItem.id } : hi;
        next.push({ lo: subLo, hi: subHi });
        subLo = subHi;
      }
    }
    frontier = next;
  }
  return { aNeeds: [...aNeeds], bNeeds: [...bNeeds], rounds, comparisons, controlBytes };
}

/** The events A must receive from B so both converge. */
export function eventsToSend(fromEvents, needIds) {
  const need = new Set(needIds);
  return fromEvents.filter((e) => need.has(e.id));
}
