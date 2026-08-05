// QAKU mobile transport over liblogosdelivery + SDS Reliable Channels. This is
// the load-bearing wiring the mobile-app + reliable-channels skills warn about;
// the channel MECHANICS themselves are documented in logos-reliable-channels.
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
const ENTRY_NODES: string[] = [ /* fleet bootstrap multiaddrs - pin the same set the desktop/hub dial */ ];

let started = false;
let identity: Identity | null = null;
let topic = "";
let deviceId = "";

type OnEvent = (sealed: Uint8Array) => void;

export async function startNode(secret: Uint8Array, onEvent: OnEvent): Promise<void> {
  identity = deriveIdentity(secret);
  topic = topicFor(identity);
  deviceId = await getDeviceId();

  if (!started) {
    // Minimal RELAY config - NO light-client fields (filter/lightpush/store make
    // waku_new reject the config -> node offline). Auto-shard handles the shard.
    await LogosMessaging.setup(JSON.stringify({ mode: "Core", preset: FLEET_PRESET, relay: true, entryNodes: ENTRY_NODES }));
    // All receives (live relay + SDS channel) arrive on this one JS event.
    emitter.addListener("logosMessage", (m: { channelId?: string; senderId?: string; payload?: string }) => {
      counters.rxRaw++;
      if (!m || !m.payload) return;
      if (m.senderId && m.senderId === deviceId) return; // ignore our own echo
      counters.rxSeen++;
      const bytes = payloadCandidates(m.payload).find((c) => c);
      for (const cand of payloadCandidates(m.payload)) {
        try {
          const sealed = cand;
          const pt = open(identity!, sealed, topic); // verify AEAD before handing up
          void pt; counters.rxOpened++;
          onEvent(sealed);
          return;
        } catch { /* try next candidate */ }
      }
      counters.rxOpenFail++;
      void bytes;
    });
    started = true;
    await new Promise((r) => setTimeout(r, 10000)); // let the mesh form before first publish
  }

  // BOTH, in order: subscribe the content topic, THEN create the channel.
  await LogosMessaging.subscribeContentTopic(topic);
  await LogosMessaging.channelCreate(topic, topic, deviceId);
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
  await LogosMessaging.channelSend(topic, JSON.stringify({ payload: doubled, ephemeral: false }));
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
  let msgs = 0;
  for (const peer of ENTRY_NODES) {
    try {
      const res = JSON.parse(await LogosMessaging.storeQuery(JSON.stringify({
        contentTopics: [topic], includeData: true, paginationForward: true, paginationLimit: 100,
      }), peer, 8000));
      for (const m of res.messages || []) {
        for (const cand of payloadCandidates(m.payload)) {
          try { open(identity!, cand, topic); onEvent(cand); msgs++; break; } catch { /* */ }
        }
      }
      if (msgs > 0) break;
    } catch { /* try next peer */ }
  }
  return msgs;
}

export async function refreshPeerCount(): Promise<number> {
  try {
    const metrics = await LogosMessaging.getNodeInfo("Metrics");
    // libp2p_peers UNDER-reports (reads 0 while sync flows) - treat non-zero as a
    // positive signal only; never conclude "offline" from 0. Trust a received msg.
    const m = /libp2p_peers\s+(\d+)/.exec(metrics);
    counters.peers = m ? parseInt(m[1], 10) : counters.peers;
  } catch { /* */ }
  return counters.peers;
}
