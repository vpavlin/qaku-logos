// Wire envelope (parity with packages/sync/src/wire.mjs). Hermes-safe utf8
// (KYM_TRANSPORT_SPEC L4) — NOT TextEncoder/TextDecoder.
import { utf8Bytes, utf8Decode } from "./utf8";
export function encodeEvent(event: any): Uint8Array {
  return utf8Bytes(JSON.stringify({ v: 1, type: "EVENT", event }));
}
export function decodeEvent(bytes: Uint8Array): any {
  const o = JSON.parse(utf8Decode(bytes));
  if (o.type !== "EVENT" || !o.event) throw new Error(`unexpected envelope: ${o.type}`);
  return o.event;
}
