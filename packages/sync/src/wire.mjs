// The Delivery wire envelope. One event per EVENT message; the bytes here are
// what gets sealed (encrypted) and handed to the transport. Events are tiny
// (~200-400 B), far under Waku's ~150 KB cap, so JSON (not protobuf) is fine.
const E = new TextEncoder();
const D = new TextDecoder();

/** event object -> plaintext bytes (to be sealed, then published). */
export function encodeEvent(event) {
  return E.encode(JSON.stringify({ v: 1, type: "EVENT", event }));
}

/** plaintext bytes (after open) -> event object. Throws on a non-EVENT envelope. */
export function decodeEvent(bytes) {
  const o = JSON.parse(D.decode(bytes));
  if (o.type !== "EVENT" || !o.event) throw new Error(`unexpected envelope: ${o.type}`);
  return o.event;
}
