// logos-transport — SHARED, crypto-agnostic transport over liblogosdelivery + SDS
// Reliable Channels. This is a 1:1 MIRROR of KYM's proven mobile transport
// (kym/mobile/src/lib/delivery.ts) with EXACTLY ONE intended change: it is
// crypto-agnostic. It moves OPAQUE sealed bytes on content topics — on receive it
// hands the app the candidate sealed-byte arrays and the app opens one with its key
// (KYM opened inline against its budget keys; here the app does that via onReceive).
// Everything else — node config, the bring-up ORDER (join BEFORE settle), the
// double-base64 channelSend, payloadCandidates, the receive-event parse, the 60s
// content-topic renew, storeSync, getPeerInfo — matches KYM byte-for-byte so this
// file can eventually REPLACE KYM's transport. Do not reorder or paraphrase it.
import { NativeModules, NativeEventEmitter } from "react-native";
import { fromByteArray, toByteArray } from "base64-js";
import { sha256 as sha256hash } from "@noble/hashes/sha256";
import { utf8Bytes as utf8, utf8Decode as fromUtf8 } from "./utf8";

const { LogosMessaging } = NativeModules as any;
const emitter = LogosMessaging ? new NativeEventEmitter(LogosMessaging) : null;

// Per-stage diagnostic counters (surface in a Sync card). rxOpened/rxOpenFail are the
// app's open() outcome, reported back via onReceive's return value.
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
  const h = sha256hash(utf8(parts[1] + parts[2]));
  let val = 0n;
  for (let i = 24; i < 32; i++) val = (val << 8n) | BigInt(h[i]);
  return Number(val % BigInt(count));
}

// logos.dev fleet bootstrap multiaddrs — KYM's BOOTSTRAP, pinned so the node meshes.
export const ENTRY_NODES: string[] = [
  "/dns4/delivery-01.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmTUbnxLGT9JvV6mu9oPyDjqHK4Phs1VDJNUgESgNSkuby",
  "/dns4/delivery-02.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmMK7PYygBtKUQ8EHp7EfaD3bCEsJrkFooK8RQ2PVpJprH",
  "/dns4/delivery-01.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm4S1JYkuzDKLKQvwgAhZKs9otxXqt8SCGtB4hoJP1S397",
  "/dns4/delivery-02.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8Y9kgBNtjxvCnf1X6gnZJW5EGE4UwwCL3CCm55TwqBiH",
  "/dns4/delivery-01.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8YokiNun9BkeA1ZRmhLbtNUvcwRr64F69tYj9fkGyuEP",
  "/dns4/delivery-02.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAkvwhGHKNry6LACrB8TmEFoCJKEX29XR5dDUzk3UT3UNSE",
];
const FLEET_PRESET = "logos.dev";
const SETTLE_MS = 10000;       // KYM SETTLE_MS
const FILTER_RENEW_MS = 60000; // KYM FILTER_RENEW_MS

let didSetup = false;
let node: { ctx: string } | null = null;             // set AFTER settle, like KYM
let starting: Promise<{ ctx: string }> | null = null;
let listenerAttached = false;
let renewTimer: ReturnType<typeof setInterval> | null = null;
let deviceId = "";
let onReceiveCb: OnReceive | null = null;
const joinedTopics = new Set<string>();              // KYM `routes`
let storeReqSeq = 0;

export type OnReceive = (topic: string, candidates: Uint8Array[]) => boolean; // true iff app opened one
export type OnStatus = (s: string) => void;

export function getCtx(): string { return node ? node.ctx : ""; }

// KYM payloadCandidates — verbatim.
export function payloadCandidates(payload: any): Uint8Array[] {
  const out: Uint8Array[] = [];
  if (Array.isArray(payload)) {
    let s = "";
    for (let i = 0; i < payload.length; i++) s += String.fromCharCode(payload[i] & 0xff);
    let once: Uint8Array | null = null;
    try { once = toByteArray(s); out.push(once); } catch { /* not base64 text */ }
    if (once) { try { out.push(toByteArray(fromUtf8(once))); } catch { /* not double */ } }
    out.push(Uint8Array.from(payload.map((b: number) => b & 0xff)));
  } else if (typeof payload === "string") {
    try {
      const once = toByteArray(payload);
      out.push(once);
      try { out.push(toByteArray(fromUtf8(once))); } catch { /* not double */ }
    } catch { /* not base64 */ }
  }
  return out;
}

// KYM joinRoute — subscribe THEN channelCreate. Uses the local ctx during bring-up.
async function joinRoute(ctx: string, topic: string): Promise<void> {
  await LogosMessaging.subscribeContentTopic(ctx, topic);
  await LogosMessaging.channelCreate(ctx, topic, topic, deviceId);
  joinedTopics.add(topic);
}

// KYM startReceiving — register the ONE listener. Gated on `node` (set after settle),
// exactly like KYM, so messages during the settle window are dropped. Crypto-agnostic:
// hands candidates to the app instead of opening inline.
function attachListener(): void {
  if (listenerAttached || !emitter) return;
  listenerAttached = true;
  emitter.addListener("logosMessage", (evt: { wakuPtr?: string; event?: string }) => {
    counters.rxRaw++;
    try {
      const s0 = String((evt && evt.event) || "");
      if (s0.indexOf("channel_message_received") >= 0) diag.chan++;
      else if (s0.indexOf("message_received") >= 0) diag.msg++;
      else if (s0.indexOf("error") >= 0) diag.err++;
    } catch { /* */ }
    if (!node) return; // node not up yet — nothing to hand the app (KYM: `if (!node) return`)
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
      const opened = onReceiveCb ? onReceiveCb(topic, cands) : false;
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
}

// KYM ensureNode — EXACT order: setup → new → start → joinRoute(subscribe+channelCreate)
// for every topic → settle → renew. Idempotent; concurrent callers share the in-flight
// startup. Adding a topic once the node is up joins it immediately (KYM refreshRoutes).
export async function start(opts: { deviceId: string; topics: string[]; onReceive: OnReceive; onStatus?: OnStatus }): Promise<void> {
  if (!LogosMessaging) throw new Error("Logos Delivery native module not present in this build");
  onReceiveCb = opts.onReceive;
  deviceId = opts.deviceId;
  const step = (s: string) => { try { opts.onStatus && opts.onStatus(s); } catch { /* */ } };
  attachListener(); // like KYM's startReceiving — registered independently of node bring-up
  if (node) { for (const t of opts.topics) if (!joinedTopics.has(t)) await joinRoute(node.ctx, t); return; }
  if (starting) { await starting; for (const t of opts.topics) if (!joinedTopics.has(t)) await joinRoute(node!.ctx, t); return; }
  starting = (async () => {
    step("Starting node…");
    if (!didSetup) { await LogosMessaging.setup(); didSetup = true; }
    // KYM's RELAY config — no light-client fields (they make waku_new reject → offline).
    const config = { mode: "Core", preset: FLEET_PRESET, relay: true, entryNodes: ENTRY_NODES };
    const c: string = await LogosMessaging.new(config);
    step("Joining mesh…");
    await LogosMessaging.start(c);
    // Subscribe + channelCreate every topic BEFORE the settle, so the mesh forms with
    // the channel/subscription already wired in (KYM's order — the bit I'd gotten wrong).
    for (const t of opts.topics) await joinRoute(c, t);
    step("Forming mesh…");
    await new Promise((r) => setTimeout(r, SETTLE_MS)); // settle AFTER join
    const n = { ctx: c };
    node = n; // only now does the listener start processing (matches KYM)
    if (renewTimer) clearInterval(renewTimer);
    renewTimer = setInterval(() => {
      if (!node) return;
      for (const t of joinedTopics) LogosMessaging.subscribeContentTopic(node.ctx, t).catch(() => { /* next tick retries */ });
    }, FILTER_RENEW_MS);
    step("Connected");
    return n;
  })();
  try { await starting; } catch (e) { node = null; throw e; } finally { starting = null; }
}

// KYM publishSealed (channel branch) — DOUBLE-base64 over the SDS reliable channel.
export async function publishSealed(topic: string, sealed: Uint8Array): Promise<void> {
  if (!node) return;
  const sealedB64 = fromByteArray(sealed);
  const doubled = fromByteArray(utf8(sealedB64));
  await LogosMessaging.channelSend(node.ctx, topic, JSON.stringify({ payload: doubled, ephemeral: false }));
  counters.txTotal++;
}

// KYM storeSync — history pull; hands each stored message's candidates to the app.
export async function storeSync(topic: string, onCandidates: (topic: string, candidates: Uint8Array[]) => boolean): Promise<number> {
  if (!node || typeof LogosMessaging.storeQuery !== "function") return 0;
  let msgs = 0;
  for (const peer of ENTRY_NODES) {
    try {
      const query = { requestId: `lt-${storeReqSeq++}`, contentTopics: [topic], includeData: true, paginationForward: true, paginationLimit: 100 };
      const respStr: string = await LogosMessaging.storeQuery(node.ctx, JSON.stringify(query), peer, 8000);
      if (!respStr || respStr.indexOf("{") !== 0) continue;
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

// KYM getPeerCount — sum ALL gossipsub-mesh gauges, parse shard(s), report peers/mesh.
export async function refreshPeerInfo(): Promise<void> {
  if (!node || typeof LogosMessaging.getNodeInfo !== "function") return;
  try {
    const metrics: string = await LogosMessaging.getNodeInfo(node.ctx, "Metrics");
    if (typeof metrics !== "string" || !metrics) return;
    let peers = -1, mesh = 0;
    for (const raw of metrics.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const value = Number(line.slice(line.lastIndexOf(" ") + 1));
      if (!Number.isFinite(value)) continue;
      if (line.startsWith("libp2p_peers ")) peers = Math.trunc(value);
      else if (line.includes("gossipsub") && line.includes("mesh")) mesh += Math.trunc(value);
    }
    if (peers >= 0) counters.peers = peers;
    counters.mesh = mesh;
  } catch { /* node down / metrics unavailable */ }
}
