// logos-transport — SHARED, crypto-agnostic transport over liblogosdelivery + SDS
// Reliable Channels. Extracted VERBATIM from KYM's proven mobile transport so that
// KYM, qaku, and any future Logos app run the SAME wire code and cannot drift.
//
// It moves OPAQUE sealed bytes on content topics. It knows nothing about crypto or the
// app's envelope: the app supplies the TOPIC (its namespace) and does seal()/open()
// itself. On receive, this module hands the app the candidate sealed-byte arrays and
// the app returns whether it opened one. Copy this file (+ utf8.ts) into any Logos
// app; do NOT fork or paraphrase it — that is exactly the drift this file prevents.
//
// The load-bearing wire conventions that broke repeatedly, now in ONE place:
//  1. subscribe THEN channelCreate (channelCreate does not subscribe the content
//     topic; the recv service only emits for subscribed topics).
//  2. DOUBLE-base64 channelSend + payloadCandidates double-peel across the JNI boundary.
//  3. relay (not light-client) node config, entryNodes pinned, settle for the mesh.
//  4. Hermes-safe utf8 (utf8.ts) — never TextEncoder/TextDecoder.
//  5. native receive event is { wakuPtr, event } with `event` a JSON STRING and the
//     WakuMessage payload a BYTE ARRAY.
import { NativeModules, NativeEventEmitter } from "react-native";
import { fromByteArray, toByteArray } from "base64-js";
import { sha256 as sha256hash } from "@noble/hashes/sha256";
import { utf8Bytes as utf8, utf8Decode as fromUtf8 } from "./utf8";

const { LogosMessaging } = NativeModules as any;
const emitter = new NativeEventEmitter(LogosMessaging);

// Per-stage diagnostic counters (surface in a Sync card). rxRaw = every native event;
// rxSeen = a message with a payload we handed to the app; rxOpened/rxOpenFail = the
// app's open() outcome (reported back from onReceive); tx = channelSend calls.
export const counters = {
  rxRaw: 0, rxNoPayload: 0, rxSelfEcho: 0, rxSeen: 0,
  rxOpened: 0, rxOpenFail: 0, rxNew: 0, rxDup: 0, txTotal: 0, peers: -1, mesh: -1,
};
export const diag = { chan: 0, msg: 0, err: 0, sample: "" };
export function getRxSample(): string {
  return `chan:${diag.chan} msg:${diag.msg} err:${diag.err}${diag.sample ? " | " + diag.sample : ""}`;
}

// Autoshard (RFC 51 gen-0) for a content topic — must match the C++ core's shardFor.
export function shardFor(contentTopic: string, count = 8): number {
  const parts = contentTopic.split("/"); // ["", app, version, name, enc]
  if (parts.length < 3) return -1;
  const app = parts[1], ver = parts[2];
  const h = sha256hash(utf8(app + ver));
  let val = 0n;
  for (let i = 24; i < 32; i++) val = (val << 8n) | BigInt(h[i]);
  return Number(val % BigInt(count));
}

// logos.dev fleet bootstrap multiaddrs — pinned so the node actually meshes.
export const ENTRY_NODES: string[] = [
  "/dns4/delivery-01.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmTUbnxLGT9JvV6mu9oPyDjqHK4Phs1VDJNUgESgNSkuby",
  "/dns4/delivery-02.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmMK7PYygBtKUQ8EHp7EfaD3bCEsJrkFooK8RQ2PVpJprH",
  "/dns4/delivery-01.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm4S1JYkuzDKLKQvwgAhZKs9otxXqt8SCGtB4hoJP1S397",
  "/dns4/delivery-02.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8Y9kgBNtjxvCnf1X6gnZJW5EGE4UwwCL3CCm55TwqBiH",
  "/dns4/delivery-01.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8YokiNun9BkeA1ZRmhLbtNUvcwRr64F69tYj9fkGyuEP",
  "/dns4/delivery-02.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAkvwhGHKNry6LACrB8TmEFoCJKEX29XR5dDUzk3UT3UNSE",
];
const FLEET_PRESET = "logos.dev";

let didSetup = false;   // setup() is process-wide — once
let ctx = "";           // node handle from new()/start(); threaded into every call
let started = false;
let deviceId = "";
let renewTimer: ReturnType<typeof setInterval> | null = null;
const joinedTopics = new Set<string>();
let storeReqSeq = 0;

// The app's receive handler: given the content topic + candidate sealed-byte arrays,
// try to open one with the session key and fold it. Return true iff one opened.
export type OnReceive = (topic: string, candidates: Uint8Array[]) => boolean;
export type OnStatus = (s: string) => void;

export function getCtx(): string { return ctx; }

// A WakuMessage payload arrives as a base64 string OR a raw BYTE ARRAY (number[]);
// a byte array may be the base64-text bytes or the decoded sealed bytes. Produce every
// plausible sealed-bytes candidate — open() is authenticated, so only the right one wins.
export function payloadCandidates(payload: any): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (Array.isArray(payload)) {
    let s = "";
    for (let i = 0; i < payload.length; i++) s += String.fromCharCode(payload[i] & 0xff);
    let once: Uint8Array | null = null;
    try { once = toByteArray(s); out.push(once); } catch { /* not base64 text */ }        // 1 peel
    if (once) { try { out.push(toByteArray(fromUtf8(once))); } catch { /* not double */ } } // 2 peels
    out.push(Uint8Array.from(payload.map((b: number) => b & 0xff)));                         // raw bytes
  } else if (typeof payload === "string") {
    try {
      const once = toByteArray(payload);
      out.push(once);                                     // single-encoded
      try { out.push(toByteArray(fromUtf8(once))); } catch { /* not double */ }
    } catch { /* not base64 */ }
  }
  return out;
}

// Bring the node up ONCE and register the single receive listener. Idempotent.
export async function startNode(opts: { deviceId: string; onReceive: OnReceive; onStatus?: OnStatus }): Promise<void> {
  deviceId = opts.deviceId;
  const step = (s: string) => { try { opts.onStatus && opts.onStatus(s); } catch { /* */ } };
  if (started) return;
  step("1/6 loading native libs…");
  if (!didSetup) { await LogosMessaging.setup(); didSetup = true; }
  step("2/6 creating node…");
  // KYM's exact config: RELAY node, no light-client fields (adding filter/lightpush/
  // store made waku_new reject the config → offline).
  ctx = await LogosMessaging.new({ mode: "Core", preset: FLEET_PRESET, relay: true, entryNodes: ENTRY_NODES });
  step("3/6 starting node…");
  await LogosMessaging.start(ctx);
  emitter.addListener("logosMessage", (evt: { wakuPtr?: string; event?: string }) => {
    counters.rxRaw++;
    try {
      const s0 = String((evt && evt.event) || "");
      if (s0.indexOf("channel_message_received") >= 0) diag.chan++;
      else if (s0.indexOf("message_received") >= 0) diag.msg++;
      else if (s0.indexOf("error") >= 0) diag.err++;
    } catch { /* */ }
    try {
      const raw = evt && evt.event;
      if (!raw) { counters.rxNoPayload++; return; }
      const m: any = JSON.parse(raw);
      const wm = m.wakuMessage || m.message || m;
      const payload = wm && wm.payload != null ? wm.payload : m.payload;
      if (payload == null) { counters.rxNoPayload++; return; }
      counters.rxSeen++;
      const topic = m.contentTopic || m.channelId || (wm && wm.contentTopic) || "";
      const cands = payloadCandidates(payload);
      const opened = opts.onReceive(topic, cands); // app opens with its key + folds
      if (opened) { counters.rxOpened++; return; }
      counters.rxOpenFail++;
      if (!diag.sample) {
        const kind = Array.isArray(payload) ? "arr" + payload.length
          : typeof payload === "string" ? "b64:" + payload.length : typeof payload;
        const isChan = m && m.eventType === "channel_message_received";
        diag.sample = `${isChan ? "chan" : "msg"} pl=${kind} cand=${cands.length}`;
      }
    } catch { /* foreign traffic / bad shape — never throw in the listener */ }
  });
  started = true;
  step("4/6 forming mesh (10s)…");
  await new Promise((r) => setTimeout(r, 10000)); // let the mesh form before first publish
}

// Join a content topic: subscribe THEN channelCreate (order matters), and keep the
// leased content-topic subscription alive with a 60s renew for ALL joined topics.
export async function join(topic: string, onStatus?: OnStatus): Promise<void> {
  const step = (s: string) => { try { onStatus && onStatus(s); } catch { /* */ } };
  step("5/6 subscribing to topic…");
  await LogosMessaging.subscribeContentTopic(ctx, topic);
  step("6/6 opening channel…");
  await LogosMessaging.channelCreate(ctx, topic, topic, deviceId);
  joinedTopics.add(topic);
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = setInterval(() => {
    for (const t of joinedTopics) LogosMessaging.subscribeContentTopic(ctx, t).catch(() => { /* next tick retries */ });
  }, 60000);
  step("ready");
}

// Publish opaque sealed bytes on a topic — KYM's DOUBLE-base64 SDS channel send. The
// FFI base64-decodes `payload` once, so base64(utf8Bytes(sealedB64)) puts the base64
// text bytes on the SDS wire; the receive side double-decodes to reach the sealed bytes.
export async function publishSealed(topic: string, sealed: Uint8Array): Promise<void> {
  const sealedB64 = fromByteArray(sealed);
  const doubled = fromByteArray(utf8(sealedB64));
  await LogosMessaging.channelSend(ctx, topic, JSON.stringify({ payload: doubled, ephemeral: false }));
  counters.txTotal++;
}

// Store (history) pull for cold-start catch-up. Pages one query per bootstrap peer;
// hands each stored message's candidates to the app (which opens + folds), returns count.
export async function storeSync(topic: string, onCandidates: (topic: string, candidates: Uint8Array[]) => boolean): Promise<number> {
  if (!ctx || typeof LogosMessaging.storeQuery !== "function") return 0;
  let msgs = 0;
  for (const peer of ENTRY_NODES) {
    try {
      // requestId is MANDATORY — omitting it faults the store-query FFI natively.
      const query = {
        requestId: `lt-${storeReqSeq++}`,
        contentTopics: [topic], includeData: true,
        paginationForward: true, paginationLimit: 100,
      };
      const respStr: string = await LogosMessaging.storeQuery(ctx, JSON.stringify(query), peer, 8000);
      if (!respStr || respStr.indexOf("{") !== 0) continue; // non-JSON sentinel = empty
      const res = JSON.parse(respStr);
      const list: any[] = res.messages || res.Messages || res.messageData || [];
      for (const mm of list) {
        const wm = mm.message || mm.wakuMessage || mm;
        if (onCandidates(topic, payloadCandidates(wm.payload))) msgs++;
      }
      if (msgs > 0) break;
    } catch { /* try next peer */ }
  }
  return msgs;
}

// Refresh connected-peer and gossip-MESH peer counts. mesh==0 means a publish over
// gossip has nowhere to go (the node is connected but not in the mesh).
export async function refreshPeerInfo(): Promise<void> {
  if (!ctx) return;
  try {
    const metrics = await LogosMessaging.getNodeInfo(ctx, "Metrics");
    const p = /libp2p_peers\s+(\d+)/.exec(metrics);
    counters.peers = p ? parseInt(p[1], 10) : counters.peers;
    const mm = /libp2p_gossipsub_peers_per_topic_mesh\{[^}]*\}\s+([\d.]+)/.exec(metrics);
    counters.mesh = mm ? Math.round(parseFloat(mm[1])) : counters.mesh;
  } catch { /* */ }
}
