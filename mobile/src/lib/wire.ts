// Wire envelope (parity with packages/sync/src/wire.mjs).
export function encodeEvent(event: any): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, type: "EVENT", event }));
}
export function decodeEvent(bytes: Uint8Array): any {
  const o = JSON.parse(new TextDecoder().decode(bytes));
  if (o.type !== "EVENT" || !o.event) throw new Error(`unexpected envelope: ${o.type}`);
  return o.event;
}
