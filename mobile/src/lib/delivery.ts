// QAKU mobile transport over liblogosdelivery + SDS Reliable Channels. This is
// the load-bearing wiring the mobile-app + reliable-channels skills warn about;
// the channel MECHANICS themselves are documented in logos-reliable-channels.
//
// The vendored native bridge (from KYM) is CTX-BASED: setup() loads the libs,
// new(config) creates a node and returns a ctx string, start(ctx) starts it, and
// EVERY subsequent call takes that ctx as its first arg. Passing the topic where
// ctx belongs makes the Kotlin side do BigInteger(topic) -> NumberFormatException
// -> a native crash on join. So: new()+start() once, thread `ctx` everywhere.
//
// The four gates that each silently produce "syncs nothing":
//  1. subscribe THEN channelCreate (channelCreate does not subscribe the content
//     topic; the recv service only emits for subscribed topics -> ours:0).
//  2. double-base64 payload convention across the JNI boundary (send double-
//     encodes; receive tries the double-decoded candidate) so the hub can read us.
//  3. relay (not light-client) node config, entryNodes present, wait for mesh.
//  4. content-topic subscribe (auto-shards) - never a raw pubsub subscribe.
// Plus per-stage counters (rxRaw/rxSeen/rxOpened) so a silent drop is visible.
import { NativeModules, NativeEventEmitter } from "react-native";
import { fromByteArray, toByteArray } from "base64-js";
import { deriveIdentity, topicFor, seal, open, Identity } from "./crypto";
import { getDeviceId } from "./device";

const { LogosMessaging } = NativeModules as any;
const emitter = new NativeEventEmitter(LogosMessaging);

// Hermes-safe utf8 (KYM_TRANSPORT_SPEC L4) — NOT TextEncoder/TextDecoder, which may
// throw on Hermes and silently break the payload double-peel → "invalid tag".
import { utf8Bytes as utf8, utf8Decode as fromUtf8 } from "./utf8";

// Per-stage diagnostic counters (surface these in the UI Sync card). rxRaw splits
// into rxNoPayload (event had no payload field) + rxSelfEcho (our own senderId) +
// rxSeen (a foreign message we actually try to open). rxRaw>0 but rxSeen==0 means
// we ARE meshed and receiving, but every message is our echo or payload-less.
export const counters = {
  rxRaw: 0, rxNoPayload: 0, rxSelfEcho: 0, rxSeen: 0,
  rxOpened: 0, rxOpenFail: 0, rxNew: 0, rxDup: 0, txTotal: 0, peers: -1, mesh: -1,
};
// Receive diagnostics: native event-type tally + the first unopenable message's shape.
export const diag = { chan: 0, msg: 0, err: 0, sample: "" };
export function getRxSample(): string {
  return `chan:${diag.chan} msg:${diag.msg} err:${diag.err}${diag.sample ? " | " + diag.sample : ""}`;
}

// Autoshard (RFC 51 gen-0) for a content topic — MUST match qaku_crypto.hpp's
// shardFor so the phone and desktop show the same shard for a session.
import { sha256 as sha256hash } from "@noble/hashes/sha256";
export function shardFor(contentTopic: string, count = 8): number {
  const parts = contentTopic.split("/"); // ["", app, version, name, enc]
  if (parts.length < 3) return -1;
  const app = parts[1], ver = parts[2];
  const h = sha256hash(utf8(app + ver));
  let val = 0n;
  for (let i = 24; i < 32; i++) val = (val << 8n) | BigInt(h[i]);
  return Number(val % BigInt(count));
}
export function getTopic(): string { return topic; }
export function getShard(): number { return topic ? shardFor(topic) : -1; }

const FLEET_PRESET = "logos.dev";
// logos.dev fleet bootstrap multiaddrs — the same set the desktop/hub dial. An
// empty list leaves the node with no peers ("hub silently isolated") even though
// the preset is set; pin them explicitly.
const ENTRY_NODES: string[] = [
  "/dns4/delivery-01.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmTUbnxLGT9JvV6mu9oPyDjqHK4Phs1VDJNUgESgNSkuby",
  "/dns4/delivery-02.do-ams3.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAmMK7PYygBtKUQ8EHp7EfaD3bCEsJrkFooK8RQ2PVpJprH",
  "/dns4/delivery-01.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm4S1JYkuzDKLKQvwgAhZKs9otxXqt8SCGtB4hoJP1S397",
  "/dns4/delivery-02.gc-us-central1-a.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8Y9kgBNtjxvCnf1X6gnZJW5EGE4UwwCL3CCm55TwqBiH",
  "/dns4/delivery-01.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAm8YokiNun9BkeA1ZRmhLbtNUvcwRr64F69tYj9fkGyuEP",
  "/dns4/delivery-02.ac-cn-hongkong-c.logos.dev.status.im/tcp/30303/p2p/16Uiu2HAkvwhGHKNry6LACrB8TmEFoCJKEX29XR5dDUzk3UT3UNSE",
];

let didSetup = false;   // setup() is process-wide — once
let ctx = "";           // the node handle from new()/start() — thread it into every call
let started = false;
let renewTimer: ReturnType<typeof setInterval> | null = null; // periodic filter re-subscribe
let identity: Identity | null = null;
let topic = "";
let deviceId = "";

type OnEvent = (event: any) => void;          // a decoded EVENT envelope's `event`
type OnSyncReq = (from: string) => void;      // a peer asking us to re-serve our log
type OnStatus = (s: string) => void;

export async function startNode(secret: Uint8Array, onEvent: OnEvent, onStatus?: OnStatus, onSyncReq?: OnSyncReq): Promise<void> {
  const step = (s: string) => { try { onStatus && onStatus(s); } catch { /* */ } };
  identity = deriveIdentity(secret);
  topic = topicFor(identity);
  deviceId = await getDeviceId();

  if (!started) {
    // 1. load the native libs (no config, once). 2. create the node -> ctx.
    // 3. start it. RELAY config (NO light-client fields — filter/lightpush/store
    // make waku_new reject the config -> node offline); auto-shard handles the shard.
    // Each step reports status BEFORE the native call so a native crash's last-seen
    // status names the crashing call (localize without a device logcat).
    step("1/6 loading native libs…");
    if (!didSetup) { await LogosMessaging.setup(); didSetup = true; }
    step("2/6 creating node…");
    ctx = await LogosMessaging.new({ mode: "Core", preset: FLEET_PRESET, relay: true, entryNodes: ENTRY_NODES });
    step("3/6 starting node…");
    await LogosMessaging.start(ctx);
    // All receives (live relay + SDS channel) arrive on this one JS event. The
    // native emits { wakuPtr, event } where `event` is the FFI event as a JSON
    // STRING — the WakuMessage sits under wakuMessage/message/root and its payload
    // is a BYTE ARRAY (or base64 string). Parse it, decrypt, then dispatch on the
    // envelope type (EVENT vs SYNC_REQ). Ported from KYM's startReceiving — the old
    // qaku handler read a non-existent top-level `m.payload` and dropped everything.
    // NO self-echo filter: KYM keeps self-echoes and dedups by event id (an echoed
    // event is already in our log, so merge is a harmless no-op).
    emitter.addListener("logosMessage", (evt: { wakuPtr?: string; event?: string }) => {
      counters.rxRaw++;
      // Diagnostic tally (surfaced in the Sync card): which native event fired, and —
      // for the first message we CAN'T open — its payload shape + last open error.
      // This is how we localize a receive failure without a device logcat (KYM).
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
        let lastErr = "";
        const cands = payloadCandidates(payload);
        for (const cand of cands) {
          let plaintext: Uint8Array;
          try { plaintext = open(identity!, cand, topic); } // authenticated — only the right candidate wins
          catch (e) { lastErr = String((e && (e as any).message) || e).slice(0, 24); continue; }
          counters.rxOpened++;
          try {
            const env = JSON.parse(fromUtf8(plaintext));
            if (env && env.type === "EVENT" && env.event) onEvent(env.event);
            else if (env && env.type === "SYNC_REQ" && onSyncReq) onSyncReq(typeof env.from === "string" ? env.from : "");
          } catch { /* opened but not a valid envelope */ }
          return;
        }
        counters.rxOpenFail++;
        // Capture the FIRST unopenable message's shape so we can see why (arr len /
        // b64 len, candidates tried, last open throw, channel vs relay event).
        if (!diag.sample) {
          const kind = Array.isArray(payload) ? "arr" + payload.length
            : typeof payload === "string" ? "b64:" + payload.length : typeof payload;
          const isChan = m && m.eventType === "channel_message_received";
          diag.sample = `${isChan ? "chan" : "msg"} pl=${kind} cand=${cands.length} err[${lastErr || "none"}]`;
        }
      } catch { /* foreign traffic / bad shape — never throw in the listener */ }
    });
    started = true;
    step("4/6 forming mesh (10s)…");
    await new Promise((r) => setTimeout(r, 10000)); // let the mesh form before first publish
  }

  // BOTH, in order: subscribe the content topic, THEN create the channel.
  step("5/6 subscribing to topic…");
  await LogosMessaging.subscribeContentTopic(ctx, topic);
  step("6/6 opening channel…");
  await LogosMessaging.channelCreate(ctx, topic, topic, deviceId);
  // Content-topic (filter) subscriptions are LEASED by the fleet service node and
  // expire — on a light/mobile node they're the receive path, so without renewal the
  // phone silently stops receiving after the lease lapses. Re-subscribe periodically
  // (idempotent; refreshes the lease). Never re-channelCreate (that resets SDS state).
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = setInterval(() => {
    LogosMessaging.subscribeContentTopic(ctx, topic).catch(() => { /* transient — next tick retries */ });
  }, 60000);
  step("ready");
}

// A WakuMessage payload arrives EITHER as a base64 string OR (the common case on
// this native bridge) a raw BYTE ARRAY (number[]) — and when a byte array it may be
// the base64 *text* bytes or the decoded sealed bytes. Produce every plausible
// sealed-bytes candidate; open() is authenticated so only the right one decrypts.
// Ported verbatim from KYM (mobile/src/lib/delivery.ts) — the OLD qaku version only
// accepted a base64 string and dropped every received (byte-array) message.
function payloadCandidates(payload: any): Uint8Array[] {
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

// Publish one sealed event via BOTH paths (receivers dedup by event id):
//  1. channelSend — SDS reliable channel, DOUBLE-base64 (relay-gossip; only reaches
//     the fleet when this node holds a relay mesh — the desktop/hub case).
//  2. send — the high-level logosdelivery_send, SINGLE-base64. This LIGHTPUSHES when
//     the node has no relay mesh, which is the MOBILE case: a phone behind NAT can't
//     hold a gossip mesh (its relay streams get pruned — "yamux Stream Closed"), so
//     channelSend goes nowhere. Lightpush hands the message to a fleet service node
//     that relays it on the shard, where desktop peers receive it via onMessageReceived.
// Sending both is belt-and-suspenders: whichever transport this node actually has,
// the event gets out. Each is isolated so one failing path can't block the other.
export async function publishSealed(sealed: Uint8Array): Promise<void> {
  const sealedB64 = fromByteArray(sealed);
  const doubled = fromByteArray(utf8(sealedB64));
  try { await LogosMessaging.channelSend(ctx, topic, JSON.stringify({ payload: doubled, ephemeral: false })); }
  catch (e) { /* no relay mesh — lightpush below carries it */ }
  try { await LogosMessaging.send(ctx, JSON.stringify({ contentTopic: topic, payload: sealedB64, ephemeral: false })); }
  catch (e) { /* lightpush unavailable — channel above may have carried it */ }
  counters.txTotal++;
}

// Ask peers to re-serve everything (the "pull" half of sync). liblogosdelivery has
// no reliable history for a NAT'd phone beyond store, so on join we publish a
// SYNC_REQ; every peer that holds the session re-sends its whole log. Idempotent —
// receivers dedup by event id, so asking repeatedly is harmless. Mirrors KYM.
export async function sendSyncReq(): Promise<void> {
  if (!ctx || !identity) return;
  const env = { v: 1, type: "SYNC_REQ", from: deviceId };
  try { await publishSealed(sealEvent(utf8(JSON.stringify(env)))); } catch { /* offline — next join retries */ }
}

// Seal an event's wire bytes for publishing.
export function sealEvent(plaintext: Uint8Array): Uint8Array {
  return seal(identity!, plaintext, topic);
}
export function openSealed(sealed: Uint8Array): Uint8Array {
  return open(identity!, sealed, topic);
}

// Store (history) pull for cold-start catch-up. liblogosdelivery exposes
// waku_store_query on the phone (the desktop delivery_module does not) - the
// phone only needs to READ. Page through the cursor, try each bootstrap peer,
// decrypt each returned payload exactly like a live receive (idempotent).
export async function storeSync(onEvent: OnEvent): Promise<number> {
  // Guard the bridge method's presence (an older APK without it must not throw).
  if (!ctx || typeof LogosMessaging.storeQuery !== "function") return 0;
  let msgs = 0;
  for (const peer of ENTRY_NODES) {
    try {
      // requestId is MANDATORY: the store-query FFI builds a StoreQueryRequest and
      // dereferences requestId; omitting it faults natively (hard crash, uncatchable
      // by this try/catch). KYM's proven query carries one — mirror it exactly.
      const query = {
        requestId: `qaku-${storeReqSeq++}`,
        contentTopics: [topic], includeData: true,
        paginationForward: true, paginationLimit: 100,
      };
      const respStr: string = await LogosMessaging.storeQuery(ctx, JSON.stringify(query), peer, 8000);
      // The JNI returns a non-JSON sentinel (e.g. "on_response-ok") for an empty
      // body — treat anything not starting with "{" as "peer answered, nothing new".
      if (!respStr || respStr.indexOf("{") !== 0) continue;
      const res = JSON.parse(respStr);
      const list: any[] = res.messages || res.Messages || res.messageData || [];
      for (const m of list) {
        const wm = m.message || m.wakuMessage || m;
        for (const cand of payloadCandidates(wm.payload)) {
          try {
            const env = JSON.parse(fromUtf8(open(identity!, cand, topic)));
            if (env && env.type === "EVENT" && env.event) { onEvent(env.event); msgs++; }
            break; // opened — done with this message
          } catch { /* try next candidate */ }
        }
      }
      if (msgs > 0) break;
    } catch { /* try next peer */ }
  }
  return msgs;
}
// Monotonic store-query id (no Date.now needed; unique per process is enough).
let storeReqSeq = 0;

export async function refreshPeerCount(): Promise<number> {
  if (!ctx) return counters.peers;
  try {
    const metrics = await LogosMessaging.getNodeInfo(ctx, "Metrics");
    // libp2p_peers UNDER-reports (reads 0 while sync flows) - treat non-zero as a
    // positive signal only; never conclude "offline" from 0. Trust a received msg.
    const m = /libp2p_peers\s+(\d+)/.exec(metrics);
    counters.peers = m ? parseInt(m[1], 10) : counters.peers;
    // GOSSIP MESH peers — this is what a publish needs. A relay node behind NAT can
    // have connected peers (peers>0) but 0 in the gossip mesh, so channelSend/gossip
    // has nowhere to go. mesh==0 = can't publish; the send diagnostic we were missing.
    const mm = /libp2p_gossipsub_peers_per_topic_mesh\{[^}]*\}\s+([\d.]+)/.exec(metrics);
    counters.mesh = mm ? Math.round(parseFloat(mm[1])) : counters.mesh;
  } catch { /* */ }
  return counters.peers;
}
