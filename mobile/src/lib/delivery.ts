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

const utf8 = (s: string) => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

// Per-stage diagnostic counters (surface these in the UI Sync card).
export const counters = { rxRaw: 0, rxSeen: 0, rxOpened: 0, rxOpenFail: 0, rxNew: 0, rxDup: 0, txTotal: 0, peers: -1 };

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
let identity: Identity | null = null;
let topic = "";
let deviceId = "";

type OnEvent = (sealed: Uint8Array) => void;
type OnStatus = (s: string) => void;

export async function startNode(secret: Uint8Array, onEvent: OnEvent, onStatus?: OnStatus): Promise<void> {
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
    // All receives (live relay + SDS channel) arrive on this one JS event.
    emitter.addListener("logosMessage", (m: { channelId?: string; senderId?: string; payload?: string }) => {
      counters.rxRaw++;
      if (!m || !m.payload) return;
      if (m.senderId && m.senderId === deviceId) return; // ignore our own echo
      counters.rxSeen++;
      for (const cand of payloadCandidates(m.payload)) {
        try {
          open(identity!, cand, topic); // verify AEAD before handing up
          counters.rxOpened++;
          onEvent(cand);
          return;
        } catch { /* try next candidate */ }
      }
      counters.rxOpenFail++;
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
  step("ready");
}

// Try both single- and double-decoded candidates (the FFI base64-encodes once on
// the event; a peer that double-encodes on send needs a second peel).
function payloadCandidates(payloadB64: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  try { out.push(toByteArray(payloadB64)); } catch { /* */ }
  try { out.push(toByteArray(fromUtf8(toByteArray(payloadB64)))); } catch { /* */ }
  return out;
}

// Publish one sealed event. Double-encode to match the fleet's convention:
// the sealed bytes -> base64 text -> that text's utf8 bytes -> base64 again, so
// the FFI's single decode leaves base64 text the receiver peels a second time.
export async function publishSealed(sealed: Uint8Array): Promise<void> {
  const sealedB64 = fromByteArray(sealed);
  const doubled = fromByteArray(utf8(sealedB64));
  await LogosMessaging.channelSend(ctx, topic, JSON.stringify({ payload: doubled, ephemeral: false }));
  counters.txTotal++;
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
          try { open(identity!, cand, topic); onEvent(cand); msgs++; break; } catch { /* */ }
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
  } catch { /* */ }
  return counters.peers;
}
