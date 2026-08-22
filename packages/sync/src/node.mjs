// SyncNode — a session peer, independent of the physical transport. It owns the
// event log, seals locally-authored events for publishing, and ingests peers'
// sealed events (decrypt -> dedup -> merge -> clock.receive). A transport
// adapter (delivery_module in the desktop core, liblogosdelivery on mobile)
// just calls .append()/.ingest() and moves bytes; all safety lives here + in
// the engine. Every device/hub is a peer — there is no client/server.
import { mergeEvents, computeState, checkInvariant } from "../../engine/src/engine.mjs";
import { Clock } from "../../contract/src/hlc.mjs";
import { deriveIdentity, topicFor, seal, open } from "./crypto.mjs";
import { encodeEvent, decodeEvent } from "./wire.mjs";

export class SyncNode {
  constructor(secret, { device = "node", log = [] } = {}) {
    this.id = deriveIdentity(secret);
    this.topic = topicFor(this.id);          // the session content topic to sub/pub on
    this.log = mergeEvents(log);
    this.clock = new Clock(device);
    for (const e of this.log) this.clock.receive(e.hlc);   // prime past the whole log
    this._ids = new Set(this.log.map((e) => e.id));
  }

  state() { return computeState(this.log); }
  invariant() { return checkInvariant(this.state()); }

  /** Stamp a fresh HLC for a locally-authored event (call clock.send()). */
  now() { return this.clock.send(); }

  /** Add a locally-authored event and return its sealed wire message to publish. */
  append(event) {
    if (!this._ids.has(event.id)) {
      this.log = mergeEvents([...this.log, event]);
      this._ids.add(event.id);
    }
    return seal(this.id, event.id, encodeEvent(event), this.topic);
  }

  /** Ingest one sealed message from the transport. Returns true if it was new.
   *  Throws if the message can't be opened (wrong session key / tampered). */
  ingest(sealed) {
    const event = decodeEvent(open(this.id, sealed, this.topic));
    if (this._ids.has(event.id)) return false;   // idempotent — redelivery is a no-op
    this.log = mergeEvents([...this.log, event]);
    this._ids.add(event.id);
    this.clock.receive(event.hlc);
    return true;
  }

  /** Re-seal the whole log — cold-start backfill for a peer that just joined
   *  (liblogosdelivery exposes no desktop Store; the hub re-serves on demand). */
  backfill() {
    return this.log.map((e) => seal(this.id, e.id, encodeEvent(e), this.topic));
  }
}
