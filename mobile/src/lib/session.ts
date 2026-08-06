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

  // Fold a decoded event (from live receive or store pull). Dedup by id.
  ingestEvent(event: any) {
    try {
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

  // Author a local event: stamp HLC, merge, seal + publish. EXACTLY like KYM.
  async append(type: keyof typeof ev, payload: any) {
    const event = (ev as any)[type](this.clock.send(), payload);
    this.merge(event);
    this.emit();
    await publishSealed(sealEvent(encodeEvent(event)));
  }

  // Convenience domain actions (mirror the desktop core surface).
  ask(content: string) { return this.append("questionAdd", { questionId: rid(), content }); }
  upvote(targetId: string, up = true) { return this.append("upvote", { targetId, up }); }
  answer(questionId: string, content: string) { return this.append("answerPost", { answerId: rid(), questionId, content }); }
  moderate(questionId: string, hidden: boolean) { return this.append("moderate", { questionId, hidden }); }
  votePoll(pollId: string, optionId: string) { return this.append("pollVote", { pollId, optionId }); }
}

function rid() { return Math.random().toString(16).slice(2, 14); }
