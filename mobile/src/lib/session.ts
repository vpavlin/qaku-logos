// QAKU mobile session store: the SyncNode boundary on the phone. It reuses the
// SAME engine + contract as the desktop core and the TS reference (imported via
// relative path; metro.config.js adds the repo root to watchFolders) - so the
// phone folds identically and cannot diverge from the hub/desktop. The transport
// (delivery.ts) just moves sealed bytes; all safety lives here + in the engine.
//
// NOTE: the .mjs reference modules are ESM and run under metro as-is. If your
// bundler dislikes the .mjs extension, copy engine.mjs/events.mjs/hlc.mjs into
// mobile/src/lib and drop the extension - the code is identical.
// @ts-ignore - shared reference implementation
import { mergeEvents, computeState } from "../../../packages/engine/src/engine.mjs";
// @ts-ignore
import { Clock, ev } from "../../../packages/contract/src/index.mjs";
import { encodeEvent } from "./wire";
import { startNode, publishSealed, sealEvent, storeSync, sendSyncReq, counters } from "./delivery";
import { getDeviceId } from "./device";

export class Session {
  log: any[] = [];
  ids = new Set<string>();
  clock: any;
  device = "phone";
  listeners = new Set<() => void>();
  // Posts authored here that haven't been confirmed on the fleet yet. A NAT'd phone's
  // gossip mesh forms only in brief windows, so we re-publish these whenever the mesh
  // has peers (driven by the 3s poll → flushPending) and drop one once it echoes back
  // to us (= it reached the fleet). Bounded by a 5-min TTL.
  private pending: { id: string; sealed: Uint8Array; ts: number }[] = [];

  async start(secret: Uint8Array, onStatus?: (s: string) => void) {
    this.device = await getDeviceId();
    this.clock = new Clock(this.device);
    // The delivery layer now decodes + dispatches: onEvent gets a decoded event's
    // payload, onSyncReq asks us to re-serve our whole log to a joining peer.
    await startNode(secret, (event) => this.ingestEvent(event), onStatus, (from) => this.serveLog(from));
    this.emit(); // node is up + subscribed — surface the UI immediately
    // PULL half: ask peers to re-serve everything (beats sparse mesh + fills history),
    // then a store cold-start pull. Both in the background so "joined" isn't blocked.
    onStatus?.("syncing history…");
    sendSyncReq().catch(() => {});
    storeSync((event) => this.ingestEvent(event)).then(() => this.emit()).catch(() => {});
  }

  state() { return computeState(this.log); }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const fn of this.listeners) fn(); }

  private merge(event: any): boolean {
    if (this.ids.has(event.id)) return false;
    this.log = mergeEvents([...this.log, event]);
    this.ids.add(event.id);
    this.clock.receive(event.hlc);
    return true;
  }

  // Fold a decoded event (from live receive or store pull). Dedup by id. If it's one
  // of OUR pending posts echoing back off the fleet, stop re-publishing it — delivered.
  ingestEvent(event: any) {
    try {
      if (event && event.id) {
        const before = this.pending.length;
        this.pending = this.pending.filter((p) => p.id !== event.id);
        if (this.pending.length !== before) { /* our post reached the fleet */ }
      }
      if (event && this.merge(event)) { counters.rxNew++; this.emit(); }
      else counters.rxDup++;
    } catch { /* malformed event */ }
  }

  // A peer asked us to re-serve (SYNC_REQ). Re-publish our whole log so they catch
  // up; ignore our own request. Cheap + idempotent (they dedup by id).
  private serveLog(from: string) {
    if (from && from === this.device) return;
    for (const e of this.log) {
      publishSealed(sealEvent(encodeEvent(e))).catch(() => {});
    }
  }

  // Author a local event: stamp HLC, merge, seal, publish, and QUEUE it so it keeps
  // getting re-published whenever the gossip mesh opens (flushPending) until it echoes
  // back (confirmed on the fleet). This is what makes a NAT'd phone's posts actually
  // leave — a single publish almost always falls into a mesh-pruned gap.
  async append(type: keyof typeof ev, payload: any) {
    const event = (ev as any)[type](this.clock.send(), payload);
    this.merge(event);
    this.emit();
    const sealed = sealEvent(encodeEvent(event));
    this.pending.push({ id: event.id, sealed, ts: Date.now() });
    await publishSealed(sealed);
  }

  // Re-publish every un-confirmed post. Called from the UI poll ONLY when the mesh has
  // peers (counters.mesh > 0), so this fires within ~3s of a mesh window opening.
  // Drops posts older than 5 min (give up). Receivers dedup by id, so repeats are safe.
  flushPending() {
    const now = Date.now();
    this.pending = this.pending.filter((p) => now - p.ts < 300000);
    for (const p of this.pending) publishSealed(p.sealed).catch(() => {});
  }

  // Convenience domain actions (mirror the desktop core surface).
  ask(content: string) { return this.append("questionAdd", { questionId: rid(), content }); }
  upvote(targetId: string, up = true) { return this.append("upvote", { targetId, up }); }
  answer(questionId: string, content: string) { return this.append("answerPost", { answerId: rid(), questionId, content }); }
  moderate(questionId: string, hidden: boolean) { return this.append("moderate", { questionId, hidden }); }
  votePoll(pollId: string, optionId: string) { return this.append("pollVote", { pollId, optionId }); }
}

function rid() { return Math.random().toString(16).slice(2, 14); }
