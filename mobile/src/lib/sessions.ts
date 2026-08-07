// QAKU multi-session manager: ONE embedded node, N Q&As. Each joined Q&A ("room") has
// its own shared secret → seal/open key + derived content topic + event log; they all
// ride the shared logos-transport (multi-topic). This is qaku's analogue of KYM's
// multi-budget: a registry of joined rooms, per-room fold, and authoring that SIGNS with
// this device's key (verifiable author) and SEALS with the room's household key.
import * as transport from "./logos-transport";
import { deriveIdentity, topicFor, seal, open, newSecret, Identity as SealId } from "./crypto";
import { encodeEvent } from "./wire";
import { utf8Bytes, utf8Decode } from "./utf8";
import { getDeviceId } from "./device";
import { getIdentity, Identity, shortAddr } from "./identity";
// @ts-ignore - shared reference implementation (metro resolves the relative .mjs)
import { computeState } from "../../../packages/engine/src/engine.mjs";
// @ts-ignore
import { Clock, ev } from "../../../packages/contract/src/index.mjs";
// @ts-ignore
import { signEvent } from "../../../packages/contract/src/identity.mjs";
import * as SecureStore from "expo-secure-store";
import * as FileSystem from "expo-file-system";

// Durable local log store (the fix for "reload → empty Q&A": content must survive locally,
// not depend on re-pulling from a peer that may not exist). One JSON file per room.
const logPath = (h: string) => (FileSystem.documentDirectory || "") + "qaku-log-" + h + ".json";
async function loadLogFile(h: string): Promise<any[]> {
  try { const p = logPath(h); const info = await FileSystem.getInfoAsync(p); if (!info.exists) return []; const s = await FileSystem.readAsStringAsync(p); const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; }
}
async function saveLogFile(h: string, log: any[]) {
  try { await FileSystem.writeAsStringAsync(logPath(h), JSON.stringify(log)); } catch { /* best-effort */ }
}

const HEXC = "0123456789abcdef";
const hex = (b: Uint8Array) => { let s = ""; for (const x of b) s += HEXC[x >> 4] + HEXC[x & 15]; return s; };
const fromHex = (s: string) => { const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; };
const rid = () => Math.random().toString(16).slice(2, 14);
const REG_KEY = "qaku-rooms-v1";

export type RoomMeta = { topicHash: string; secretHex: string; title: string };
type Room = { meta: RoomMeta; sealId: SealId; topic: string; log: any[]; ids: Set<string>; clock: any };

// The shareable pairing artifact — same secret-in-URL model as OG qaku.
export const shareUriFor = (secretHex: string) => "qaku://join?s=" + secretHex;
export function extractSecret(input: string): string {
  const s = (input || "").trim();
  const i = s.indexOf("s=");
  return s.startsWith("qaku://") && i >= 0 ? s.slice(i + 2).trim() : s;
}

export class Sessions {
  private rooms = new Map<string, Room>();   // topic -> Room
  private byHash = new Map<string, Room>();   // topicHash -> Room
  private identity: Identity | null = null;
  private deviceId = "";
  private saveTimers = new Map<string, any>();
  private lastSeed = new Map<string, number>();
  private seedTimer: any = null;
  loaded = false;   // local state (registry + logs) is in memory — UI can render now
  started = false;  // the node is up — safe to join/publish/sync
  syncing = false;  // a catch-up round is active / events still flowing — show a spinner
  private syncSettle: any = null;
  private seenTs = new Map<string, number>();   // topicHash -> latest question ts the user has seen
  private starred = new Set<string>();          // Q&As kept alive by the foreground service
  private startTime = 0;
  private connectedAt = 0;
  onNewQuestion: ((topicHash: string, content: string, title: string) => void) | null = null;
  notifyAttempts = 0;   // diagnostic: how many times we've asked to fire a question notification
  myAddress = "";
  myName = "";
  listeners = new Set<() => void>();

  // Flag "syncing" for a few seconds; extended while events keep arriving, so the UI can
  // show "Syncing…" and clear it once a channel goes quiet.
  private markSyncing(ms = 3500) {
    if (!this.syncing) { this.syncing = true; this.emit(); }
    clearTimeout(this.syncSettle);
    this.syncSettle = setTimeout(() => { this.syncing = false; this.emit(); }, ms);
  }

  // Persist a room's log a short moment after it changes (batch bursts of ingests).
  private scheduleSave(room: Room) {
    const h = room.meta.topicHash;
    clearTimeout(this.saveTimers.get(h));
    this.saveTimers.set(h, setTimeout(() => saveLogFile(h, room.log), 400));
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const fn of this.listeners) fn(); }

  // --- registry persistence (secrets live here; the secret IS the access) ---
  private async loadRegistry(): Promise<RoomMeta[]> {
    try { const raw = await SecureStore.getItemAsync(REG_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
  }
  private async saveRegistry() {
    const metas = [...this.byHash.values()].map((r) => r.meta);
    try { await SecureStore.setItemAsync(REG_KEY, JSON.stringify(metas)); } catch { /* */ }
  }

  private makeRoom(meta: RoomMeta): Room {
    const sealId = deriveIdentity(fromHex(meta.secretHex));
    const topic = topicFor(sealId);
    return { meta: { ...meta, topicHash: topic.split("/")[3] || meta.topicHash }, sealId, topic, log: [], ids: new Set(), clock: new Clock(this.myAddress) };
  }

  // Bring the node up on every joined room's topic; then pull history + ask peers.
  async start(onStatus?: (s: string) => void) {
    // 1) LOCAL FIRST — identity + every persisted Q&A + its log, from disk. No network
    // wait, so the UI can render the list immediately.
    this.identity = await getIdentity();
    this.myAddress = this.identity.address;
    this.deviceId = await getDeviceId();
    try { this.myName = (await SecureStore.getItemAsync("qaku-myname")) || ""; } catch { /* */ }
    try { const raw = await SecureStore.getItemAsync("qaku-seen"); if (raw) for (const [k, v] of Object.entries(JSON.parse(raw))) this.seenTs.set(k, Number(v)); } catch { /* */ }
    try { const raw = await SecureStore.getItemAsync("qaku-starred"); if (raw) this.starred = new Set(JSON.parse(raw)); } catch { /* */ }
    this.startTime = Date.now();
    for (const meta of await this.loadRegistry()) {
      const room = this.makeRoom(meta);
      await this.hydrate(room);   // restore the persisted log
      this.rooms.set(room.topic, room); this.byHash.set(room.meta.topicHash, room);
    }
    this.loaded = true;
    this.emit();                  // UI shows the Q&As from disk NOW
    // 2) CONNECT in the background; content is already on screen while the node comes up.
    this.connect(onStatus);
  }

  private async connect(onStatus?: (s: string) => void) {
    try {
      await transport.start({ deviceId: this.deviceId, topics: [...this.rooms.keys()], onStatus, onReceive: (t, c) => this.onCandidates(t, c) });
      this.started = true;
      this.connectedAt = Date.now();
      this.emit();
      this.markSyncing(8000);   // initial catch-up window
      await transport.join([...this.rooms.keys()]).catch(() => {}); // catch rooms added during bring-up
      // Catch-up rounds — retried to beat a still-forming mesh (a dropped first SYNC_REQ
      // is how offline-posted questions got missed).
      this.resync();
      setTimeout(() => { this.lastResync = 0; this.resync(); }, 9000);
      setTimeout(() => { this.lastResync = 0; this.resync(); }, 24000);
      // Periodically push our logs so a peer that subscribes LATER (e.g. Basecamp joining
      // by secret) catches up even though it never sends a SYNC_REQ. Rate-limited inside.
      if (this.seedTimer) clearInterval(this.seedTimer);
      this.seedTimer = setInterval(() => this.seedAll(), 60000);
      setTimeout(() => this.seedAll(), 4000);
    } catch (e: any) {
      onStatus?.("offline — reopen to retry");
    }
  }

  private syncRoom(room: Room) {
    this.sendSyncReq(room).catch(() => {});                 // pull: ask peers to re-serve
    setTimeout(() => this.seedRoom(room), 1500);            // push: re-broadcast ours (for already-subscribed peers)
    transport.storeSync((t, cands) => this.onCandidates(t, cands)).then(() => this.emit()).catch(() => {});
  }

  // Full catch-up round across every room: ask peers to re-serve (SYNC_REQ), push ours,
  // and pull the fleet store once. Rate-limited. Retried a few times after connect and on
  // app foreground — a single SYNC_REQ can race a still-forming mesh, which is how a
  // question posted from Basecamp while the phone was offline got missed on reconnect.
  private lastResync = 0;
  async resync(force = false) {
    if (!this.started) return;
    const now = Date.now();
    if (!force && now - this.lastResync < 4000) return;     // coalesce rapid triggers (force = pull-to-refresh)
    this.lastResync = now;
    this.markSyncing();
    for (const room of this.rooms.values()) { this.sendSyncReq(room).catch(() => {}); this.seedRoom(room); }
    try { await transport.storeSync((t, cands) => this.onCandidates(t, cands)); this.emit(); } catch { /* */ }
  }

  // Route an inbound payload to the room owning that topic; open with the room key; fold.
  private onCandidates(topic: string, candidates: Uint8Array[]): boolean {
    const room = this.rooms.get(topic);
    if (!room) return false;
    for (const cand of candidates) {
      let plain: Uint8Array;
      try { plain = open(room.sealId, cand, room.topic); } catch { continue; }
      try {
        const envlp = JSON.parse(utf8Decode(plain));
        if (envlp && envlp.type === "EVENT" && envlp.event) this.ingest(room, envlp.event);
        else if (envlp && envlp.type === "SYNC_REQ") this.serveLog(room, typeof envlp.from === "string" ? envlp.from : "");
      } catch { /* opened but not an envelope */ }
      return true;
    }
    return false;
  }

  // Restore a room's persisted log and advance its clock past every loaded event.
  private async hydrate(room: Room) {
    const log = await loadLogFile(room.meta.topicHash);
    for (const e of log) { if (e && e.id) { room.ids.add(e.id); try { room.clock.receive(e.hlc); } catch { /* */ } } }
    room.log = log;
  }

  private ingest(room: Room, event: any) {
    if (!event || room.ids.has(event.id)) return;
    room.log = [...room.log, event];
    room.ids.add(event.id);
    try { room.clock.receive(event.hlc); } catch { /* */ }
    this.scheduleSave(room);   // durable — survives reload without needing a peer
    if (this.syncing) this.markSyncing(2500);   // events flowing — keep "syncing" until quiet
    // Notify for a question in a starred Q&A that arrives AFTER the initial catch-up flood
    // (past ~12s from connect) — skew-proof: uses wall time since connect, not the event's
    // ts (which comes from another device's clock). Suppresses the reconnect backlog.
    if (event.type === "question.add" && event.dev !== this.myAddress && this.starred.has(room.meta.topicHash)
        && this.connectedAt > 0 && Date.now() - this.connectedAt > 12000) {
      this.notifyAttempts++;
      this.onNewQuestion?.(room.meta.topicHash, (event.payload && event.payload.content) || "New question", this.metaTitle(room.meta.topicHash));
    }
    this.emit();
  }

  // --- starred Q&As (kept alive by the foreground service) ---
  isStarred(topicHash: string): boolean { return this.starred.has(topicHash); }
  starredCount(): number { return this.starred.size; }
  starredHashes(): string[] { return [...this.starred]; }
  async toggleStar(topicHash: string) {
    if (this.starred.has(topicHash)) this.starred.delete(topicHash); else this.starred.add(topicHash);
    try { await SecureStore.setItemAsync("qaku-starred", JSON.stringify([...this.starred])); } catch { /* */ }
    this.emit();
  }

  private async publish(room: Room, envObj: any) {
    const sealed = seal(room.sealId, utf8Bytes(JSON.stringify(envObj)), room.topic);
    await transport.publishSealed(room.topic, sealed);
  }
  private async sendSyncReq(room: Room) {
    await this.publish(room, { v: 1, type: "SYNC_REQ", from: this.deviceId }).catch(() => {});
  }
  private serveLog(room: Room, from: string) {
    if (from && from === this.deviceId) return;
    this.seedRoom(room);
  }

  // Push (re-broadcast) a room's whole log so any SUBSCRIBED peer — e.g. a Basecamp that
  // just joined by secret — catches up WITHOUT having to send a SYNC_REQ (qaku_core never
  // does). Rate-limited per room; skips oversized logs to avoid a re-broadcast storm.
  private seedRoom(room: Room) {
    if (room.log.length === 0 || room.log.length > 500) return;
    const now = Date.now();
    if (now - (this.lastSeed.get(room.meta.topicHash) || 0) < 20000) return;
    this.lastSeed.set(room.meta.topicHash, now);
    for (const e of room.log) this.publish(room, { v: 1, type: "EVENT", event: e }).catch(() => {});
  }
  private seedAll() { for (const room of this.rooms.values()) this.seedRoom(room); }

  // Author a signed event into a room: stamp HLC → sign (author=our address) → fold →
  // seal + publish. Returns immediately after local fold; publish is best-effort async.
  private async append(room: Room, type: string, payload: any) {
    if (!this.identity) return;
    const event = (ev as any)[type](room.clock.send(), payload);
    signEvent(this.identity, event);
    this.ingest(room, event);
    await this.publish(room, { v: 1, type: "EVENT", event }).catch(() => {});
  }

  // --- public API ---------------------------------------------------------
  async createRoom(title: string): Promise<string> {
    const secret = newSecret();
    const room = this.makeRoom({ topicHash: "", secretHex: hex(secret), title: title || "New Q&A" });
    this.rooms.set(room.topic, room); this.byHash.set(room.meta.topicHash, room);
    await this.saveRegistry();
    if (this.started) await transport.join([room.topic]);
    // Author the session.create (owner = us) + our current name, then sync.
    await this.append(room, "sessionCreate", { sessionId: room.meta.topicHash, title: room.meta.title, description: "" });
    if (this.myName) await this.append(room, "profileSet", { name: this.myName });
    this.emit();
    if (this.started) this.syncRoom(room);
    return room.meta.topicHash;
  }

  async joinRoom(secretInput: string): Promise<string> {
    const sh = extractSecret(secretInput).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sh)) throw new Error("Secret must be 64 hex chars or a qaku://join link.");
    const room = this.makeRoom({ topicHash: "", secretHex: sh, title: "Q&A" });
    if (this.byHash.has(room.meta.topicHash)) return room.meta.topicHash; // already joined
    await this.hydrate(room);   // restore any prior local log for this room
    this.rooms.set(room.topic, room); this.byHash.set(room.meta.topicHash, room);
    await this.saveRegistry();
    if (this.started) { await transport.join([room.topic]); this.syncRoom(room); }
    if (this.myName) await this.append(room, "profileSet", { name: this.myName });
    this.emit();
    return room.meta.topicHash;
  }

  async leaveRoom(topicHash: string) {
    const room = this.byHash.get(topicHash); if (!room) return;
    this.rooms.delete(room.topic); this.byHash.delete(topicHash);
    await this.saveRegistry(); this.emit();
  }

  // Set our display name: persist locally (so it shows on the home screen + survives
  // reload independent of any room), then publish a signed profile.set to EVERY room.
  async setName(name: string) {
    this.myName = name;
    try { await SecureStore.setItemAsync("qaku-myname", name); } catch { /* */ }
    for (const room of this.rooms.values()) await this.append(room, "profileSet", { name });
    this.emit();
  }
  async currentName(topicHash: string): Promise<string> {
    const st = this.state(topicHash); return (st.names && st.names[this.myAddress]) || "";
  }

  ask(h: string, content: string) { const r = this.byHash.get(h); return r ? this.append(r, "questionAdd", { questionId: rid(), content }) : Promise.resolve(); }
  upvote(h: string, targetId: string, up = true) { const r = this.byHash.get(h); return r ? this.append(r, "upvote", { targetId, up }) : Promise.resolve(); }
  postAnswer(h: string, questionId: string, content: string) { const r = this.byHash.get(h); return r ? this.append(r, "answerPost", { answerId: rid(), questionId, content }) : Promise.resolve(); }
  moderate(h: string, questionId: string, hidden: boolean) { const r = this.byHash.get(h); return r ? this.append(r, "moderate", { questionId, hidden }) : Promise.resolve(); }

  state(topicHash: string): any {
    const r = this.byHash.get(topicHash); if (!r) return { questions: [], polls: [], names: {} };
    return computeState(r.log);
  }
  secretHex(topicHash: string): string { return this.byHash.get(topicHash)?.meta.secretHex || ""; }
  isAdmin(topicHash: string): boolean { const st = this.state(topicHash); return !!(st.admins && st.admins.indexOf(this.myAddress) >= 0); }
  displayName(topicHash: string, addr: string): string { const st = this.state(topicHash); return (st.names && st.names[addr]) || shortAddr(addr); }
  // Cheap title (no fold) for the room header fallback — avoids computeState in render.
  metaTitle(topicHash: string): string { return this.byHash.get(topicHash)?.meta.title || ""; }

  // Mark every current question in a room as seen (clears its unread badge). Persisted.
  async markSeen(topicHash: string) {
    const r = this.byHash.get(topicHash); if (!r) return;
    const st = computeState(r.log);
    let maxTs = this.seenTs.get(topicHash) || 0;
    for (const q of (st.questions || [])) if (q.ts > maxTs) maxTs = q.ts;
    this.seenTs.set(topicHash, maxTs);
    try { await SecureStore.setItemAsync("qaku-seen", JSON.stringify(Object.fromEntries(this.seenTs))); } catch { /* */ }
    this.emit();
  }

  // Room list for the home screen: title + question count + open/closed.
  list(): { topicHash: string; title: string; questions: number; owned: boolean; unread: number }[] {
    return [...this.byHash.values()].map((r) => {
      const st = computeState(r.log);
      const qs = st.questions || [];
      const seen = this.seenTs.get(r.meta.topicHash) || 0;
      return { topicHash: r.meta.topicHash, title: (st.session && st.session.title) || r.meta.title, questions: qs.length, owned: st.owner === this.myAddress, unread: qs.filter((q: any) => q.ts > seen).length };
    });
  }
}

// Process-wide singleton — shared by the React tree AND the background-actions task, so
// the node + logs persist across foreground/background as one instance.
export const sessions = new Sessions();
