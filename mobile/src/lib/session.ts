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
import { encodeEvent, decodeEvent } from "./wire";
import { startNode, publishSealed, sealEvent, openSealed, storeSync, counters } from "./delivery";
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
    await startNode(secret, (sealed) => this.ingest(sealed), onStatus);
    this.emit(); // node is up + subscribed — surface the UI immediately
    // cold-start catch-up in the BACKGROUND: don't block "joined" on the store
    // query's per-peer 8s timeouts (up to ~48s of dead "Joining…").
    storeSync((sealed) => this.ingest(sealed)).then(() => this.emit()).catch(() => {});
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

  ingest(sealed: Uint8Array) {
    try {
      const event = decodeEvent(openSealed(sealed));
      if (this.merge(event)) { counters.rxNew++; this.emit(); }
      else counters.rxDup++;
    } catch { /* not for us / bad tag */ }
  }

  // Author a local event: stamp HLC, merge, seal + publish.
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
