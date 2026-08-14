// QAKU mobile — multi-session Q&A. A home list of joined Q&As (join by secret/QR or
// create), each opening a signed, live-synced session. Authors are verifiable addresses
// with optional display names; a small collapsible sync line keeps the diagnostics out
// of the way. Palette = the original qaku (dark + gold primary + teal accent).
import React, { useEffect, useMemo, useState } from "react";
import { SafeAreaView, ScrollView, View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, BackHandler, AppState, RefreshControl, Image, StatusBar } from "react-native";
import * as Clipboard from "expo-clipboard";
import { CameraView, useCameraPermissions } from "expo-camera";
import QRCode from "react-native-qrcode-svg";
import { sessions, shareUriFor, extractSecret } from "./src/lib/sessions";
import { shortAddr } from "./src/lib/identity";
import { counters, getRxSample, refreshPeerInfo, shardFor, usingServiceBackend, serviceNodeDown, serviceAwaitingApproval, launchSharedService } from "./src/lib/loam-transport";
import { initNotifications, notifyQuestion } from "./src/lib/notify";
import { updateKeepAlive } from "./src/lib/keepalive";

// OG qaku palette (src/index.css → hex).
const C = {
  bg: "#141415", surface: "#1a1a1d", surface2: "#26262b",
  primary: "#ffc533", primaryFg: "#141415", accent: "#50b986",
  text: "#ffffff", muted: "#9f9fab", border: "#303035", input: "#39393f", danger: "#e6194b",
};

let __lastError = "";
try {
  const EU = (global as any).ErrorUtils;
  if (EU && EU.setGlobalHandler) EU.setGlobalHandler((e: any, isFatal?: boolean) => {
    __lastError = (isFatal ? "[FATAL] " : "") + (e?.message || String(e)) + "\n" + String(e?.stack || "").split("\n").slice(0, 8).join("\n");
  });
} catch { /* */ }

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: string }> {
  state = { err: "" };
  static getDerivedStateFromError(e: any) { return { err: (e?.message || String(e)) + "\n" + String(e?.stack || "").split("\n").slice(0, 10).join("\n") }; }
  render() {
    if (this.state.err) return <SafeAreaView style={{ flex: 1, backgroundColor: "#1a0000", padding: 20 }}><Text style={{ color: "#ff8a8a", fontWeight: "bold" }}>QAKU crash</Text><ScrollView><Text selectable style={{ color: "#ffbcbc", fontSize: 12 }}>{this.state.err}</Text></ScrollView></SafeAreaView>;
    return this.props.children as any;
  }
}

export default function App() {
  const [gerr, setGerr] = useState("");
  useEffect(() => { const t = setInterval(() => { if (__lastError && __lastError !== gerr) setGerr(__lastError); }, 400); return () => clearInterval(t); }, [gerr]);
  if (gerr) return <SafeAreaView style={{ flex: 1, backgroundColor: "#1a0000", padding: 20 }}><Text style={{ color: "#ff8a8a", fontWeight: "bold" }}>QAKU error</Text><ScrollView><Text selectable style={{ color: "#ffbcbc", fontSize: 12 }}>{gerr}</Text></ScrollView></SafeAreaView>;
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}

// Relative time ("just now" / "5m" / "3h" / "2d") falling back to an absolute date.
function timeAgo(ts: number): string {
  if (!ts) return "";
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  const d = Math.floor(h / 24);
  if (d < 7) return d + "d";
  return new Date(ts).toLocaleDateString();
}
function fullTime(ts: number): string { return ts ? new Date(ts).toLocaleString() : ""; }

function Avatar({ addr, name, size = 28 }: { addr: string; name?: string; size?: number }) {
  // deterministic hue from the address; initial = first letter of name or "0x".
  let h = 0; for (let i = 2; i < Math.min(addr.length, 10); i++) h = (h * 31 + addr.charCodeAt(i)) % 360;
  const initial = (name && name.trim()[0]) || (addr[2] || "?");
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: `hsl(${h},45%,32%)`, alignItems: "center", justifyContent: "center" }}><Text style={{ color: C.text, fontWeight: "700", fontSize: size * 0.45 }}>{initial.toUpperCase()}</Text></View>;
}

function AppInner() {
  const [, tick] = useState(0);
  const force = () => tick((n) => n + 1);
  // Coalesce bursts of sync events into at most one re-render per 150ms (a store pull or
  // seed can fire emit() dozens of times in a moment).
  const forceScheduled = React.useRef(false);
  const scheduleForce = () => {
    if (forceScheduled.current) return;
    forceScheduled.current = true;
    setTimeout(() => { forceScheduled.current = false; force(); }, 150);
  };
  const [status, setStatus] = useState("starting…");
  const [openHash, setOpenHash] = useState<string | null>(null);
  const [error, setError] = useState("");

  // home inputs
  const [secretIn, setSecretIn] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);
  // room inputs
  const [q, setQ] = useState("");
  const [answering, setAnswering] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState("");
  const [sortBy, setSortBy] = useState<"top" | "new" | "old" | "answered">("top");
  const [filterBy, setFilterBy] = useState<"all" | "unanswered" | "answered">("all");
  const [hiddenOpen, setHiddenOpen] = useState(false);
  // modals
  const [scanning, setScanning] = useState(false);
  const [shareHash, setShareHash] = useState<string | null>(null);
  const [nameModal, setNameModal] = useState(false);
  const [nameText, setNameText] = useState("");
  const [showDiag, setShowDiag] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState("");
  const [adminModal, setAdminModal] = useState(false);
  const [adminInput, setAdminInput] = useState("");
  const [permission, requestPermission] = useCameraPermissions();

  const copy = async (text: string, label = "Copied") => {
    try { await Clipboard.setStringAsync(text); setCopied(label); setTimeout(() => setCopied(""), 1500); } catch { /* */ }
  };

  // Pull-to-refresh → force a full catch-up round (past the rate-limit).
  const onRefresh = async () => {
    setRefreshing(true);
    try { await sessions.resync(true); } catch { /* */ }
    setTimeout(() => setRefreshing(false), 900);
  };
  const openRoom = (h: string) => { sessions.markSeen(h); setOpenHash(h); };
  const leaveRoom = () => { if (openHash) sessions.markSeen(openHash); setOpenHash(null); };
  // Star → keep this Q&A synced in the background (foreground service + notifications).
  const toggleStar = async (h: string) => { await sessions.toggleStar(h); await updateKeepAlive(sessions.starredCount()); };

  const openHashRef = React.useRef<string | null>(null);
  useEffect(() => { openHashRef.current = openHash; }, [openHash]);

  useEffect(() => {
    const un = sessions.subscribe(scheduleForce);
    sessions.start(setStatus)
      .then(() => updateKeepAlive(sessions.starredCount()))   // resume the FG service if any Q&A was starred
      .catch((e) => setError("Start failed: " + (e?.message || e)));
    const t = setInterval(() => { refreshPeerInfo().catch(() => {}); force(); }, 3000);
    // Notifications: open the tapped Q&A; alert on new questions in starred Q&As unless we're
    // already looking at that one in the foreground.
    initNotifications((h) => { sessions.markSeen(h); setOpenHash(h); });
    sessions.onNewQuestion = (h, content, title) => {
      if (openHashRef.current === h && AppState.currentState === "active") return;
      notifyQuestion(h, title, content);
    };
    return () => { un(); clearInterval(t); sessions.onNewQuestion = null; };
  }, []);

  // Android hardware back: close any open modal → leave the open Q&A back to the list →
  // only then let the OS handle it (exit). Without this, back killed the app from anywhere.
  useEffect(() => {
    const onBack = () => {
      if (scanning) { setScanning(false); return true; }
      if (nameModal) { setNameModal(false); return true; }
      if (shareHash) { setShareHash(null); return true; }
      if (openHash) { leaveRoom(); return true; }
      return false;
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => sub.remove();
  }, [scanning, nameModal, shareHash, openHash]);

  // Re-sync whenever the app returns to the foreground — catches anything peers posted
  // while we were backgrounded/offline (a single reconnect SYNC_REQ can miss it).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => { if (st === "active") sessions.resync().catch(() => {}); });
    return () => sub.remove();
  }, [sessions]);

  // Only fold ALL rooms on the home screen; inside a room we fold that one room once (below).
  // Gated on `loaded` (local state ready) — NOT `started` (connected) — so the list shows
  // instantly from disk while the node connects in the background.
  const rooms = (!openHash && sessions.loaded) ? sessions.list() : [];

  const doJoin = async (raw?: string) => {
    setBusy(true); setError("");
    try { const h = await sessions.joinRoom(raw !== undefined ? raw : secretIn); setSecretIn(""); setOpenHash(h); }
    catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  };
  const doCreate = async () => {
    setBusy(true); setError("");
    try { const h = await sessions.createRoom(newTitle); setNewTitle(""); setOpenHash(h); }
    catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  };
  const openScanner = async () => {
    if (!permission?.granted) { const r = await requestPermission(); if (!r.granted) { setError("Camera access needed to scan."); return; } }
    setError(""); setScanning(true);
  };
  const saveName = async () => { setNameModal(false); await sessions.setName(nameText.trim()); };

  // ---------- HOME ----------
  if (!openHash) {
    return (
      <SafeAreaView style={s.root}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        {copied ? <View style={s.copiedToast}><Text style={s.copiedToastT}>{copied}</Text></View> : null}
        <View style={s.topRow}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
            <Image source={require("./assets/icon.png")} style={s.logo} />
            <Text style={s.brand}>QA<Text style={{ color: C.primary }}>KU</Text></Text>
          </View>
          <TouchableOpacity style={s.namePill} onPress={() => { setNameText(sessions.myName); setNameModal(true); }}>
            <Avatar addr={sessions.myAddress || "0x0"} name={sessions.myName} size={22} />
            <Text style={s.namePillT} numberOfLines={1}>{sessions.myName || shortAddr(sessions.myAddress)}</Text>
          </TouchableOpacity>
        </View>
        <View style={s.sectionRow}>
          <Text style={s.section}>Your Q&As</Text>
          {sessions.syncing ? <Text style={s.syncingSmall}>⟳ syncing…</Text> : null}
        </View>
        <ScrollView style={{ flex: 1 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.primary} colors={[C.primary]} progressBackgroundColor={C.surface} />}>
          {rooms.length === 0 ? <Text style={s.empty}>No Q&As yet. Create one, or join with a secret / QR.</Text> : null}
          {rooms.map((r) => (
            <TouchableOpacity key={r.topicHash} style={[s.roomCard, r.unread > 0 && s.roomCardUnread]} onPress={() => openRoom(r.topicHash)}>
              <View style={{ flex: 1 }}>
                <Text style={[s.roomTitle, r.unread > 0 && { color: C.text }]} numberOfLines={1}>{r.title}</Text>
                <Text style={s.roomSub}>{r.questions} question{r.questions === 1 ? "" : "s"}{r.owned ? "  ·  you host" : ""}</Text>
              </View>
              {sessions.isStarred(r.topicHash) ? <Text style={s.starMini}>★</Text> : null}
              {r.owned ? <View style={s.hostBadge}><Text style={s.hostBadgeT}>HOST</Text></View> : null}
              {r.unread > 0 ? <View style={s.unreadBadge}><Text style={s.unreadBadgeT}>{r.unread > 99 ? "99+" : r.unread}</Text></View> : null}
              <Text style={s.chev}>›</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <View style={s.createRow}>
          <TextInput style={s.input} placeholder="New Q&A title…" placeholderTextColor={C.muted} value={newTitle} onChangeText={setNewTitle} />
          <TouchableOpacity style={[s.btnPrimary, busy && s.dim]} disabled={busy} onPress={doCreate}><Text style={s.btnPrimaryT}>Create</Text></TouchableOpacity>
        </View>
        <View style={s.joinRow}>
          <TextInput style={s.input} placeholder="Join: secret / qaku://join link" placeholderTextColor={C.muted} value={secretIn} onChangeText={setSecretIn} autoCapitalize="none" autoCorrect={false} />
          <TouchableOpacity style={[s.btnGhost, busy && s.dim]} disabled={busy} onPress={() => doJoin()}><Text style={s.btnGhostT}>Join</Text></TouchableOpacity>
          <TouchableOpacity style={[s.btnGhost, busy && s.dim]} disabled={busy} onPress={openScanner}><Text style={s.btnGhostT}>Scan</Text></TouchableOpacity>
        </View>
        {error ? <Text style={s.error}>{error}</Text> : null}
        {ldBanner()}
        <SyncLine status={status} show={showDiag} onToggle={() => setShowDiag((v) => !v)} topic="" />
        {renderScanner(scanning, setScanning, (d) => { setScanning(false); doJoin(d); })}
        {renderNameModal(nameModal, setNameModal, nameText, setNameText, saveName, sessions.myAddress, copy)}
      </SafeAreaView>
    );
  }

  // ---------- ROOM ----------
  const st = sessions.state(openHash);                 // fold ONCE per render; derive the rest
  const allQ = st.questions || [];
  const names = st.names || {};
  const nameOf = (a: string) => names[a] || shortAddr(a);
  const admin = (st.admins || []).indexOf(sessions.myAddress) >= 0;
  const answeredOf = (x: any) => (x.answers && x.answers.length > 0) || !!x.acceptedAnswerId;
  const visibleQ = allQ.filter((x: any) => !x.moderated);
  const filteredQ = filterBy === "unanswered" ? visibleQ.filter((x: any) => !answeredOf(x))
    : filterBy === "answered" ? visibleQ.filter(answeredOf) : visibleQ;
  const sortFns: any = {
    top: (a: any, b: any) => (b.upvotes || 0) - (a.upvotes || 0) || a.ts - b.ts,
    new: (a: any, b: any) => b.ts - a.ts,
    old: (a: any, b: any) => a.ts - b.ts,
    answered: (a: any, b: any) => (answeredOf(b) ? 1 : 0) - (answeredOf(a) ? 1 : 0) || (b.upvotes || 0) - (a.upvotes || 0),
  };
  const shownQ = [...filteredQ].sort(sortFns[sortBy]);
  const hiddenQ = allQ.filter((x: any) => x.moderated);
  const title = (st.session && st.session.title) || sessions.metaTitle(openHash) || "Q&A";
  const renderQ = (qq: any) => (
    <View key={qq.id} style={[s.qCard, qq.acceptedAnswerId && { borderColor: C.accent }, qq.moderated && { opacity: 0.55 }]}>
      <TouchableOpacity style={s.upvote} onPress={() => sessions.upvote(openHash!, qq.id).catch(() => {})}>
        <Text style={s.upvoteArrow}>▲</Text><Text style={s.upvoteN}>{qq.upvotes || 0}</Text>
      </TouchableOpacity>
      <View style={{ flex: 1 }}>
        <Text style={s.qText}>{qq.content}</Text>
        <View style={s.byline}>
          <Avatar addr={qq.author} name={nameOf(qq.author)} size={18} />
          <Text style={s.bylineName} numberOfLines={1}>{nameOf(qq.author)}</Text>
          {qq.verified ? <Text style={s.verified}>✓</Text> : null}
          <Text style={s.time} numberOfLines={1}>· {timeAgo(qq.ts)}</Text>
          {qq.author === sessions.myAddress ? (
            sessions.isPublished(qq.evId)
              ? <Text style={s.pubOk} numberOfLines={1}>· ✓ published</Text>
              : <Text style={s.pubPending} numberOfLines={1}>· ⏳ queued</Text>
          ) : null}
        </View>
        {(qq.answers || []).map((a: any) => {
          const acc = qq.acceptedAnswerId === a.id;   // single source of truth (one accepted answer)
          return (
          <View key={a.id} style={s.answer}>
            <TouchableOpacity style={s.ansUpvote} onPress={() => sessions.upvote(openHash!, a.id).catch(() => {})}>
              <Text style={s.ansUpvoteArrow}>▲</Text><Text style={s.ansUpvoteN}>{a.upvotes || 0}</Text>
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={[s.answerText, acc && { color: C.accent, fontWeight: "600" }]}>{acc ? "✓ " : ""}{a.content}</Text>
              <View style={s.byline}>
                <Avatar addr={a.author} name={nameOf(a.author)} size={16} />
                <Text style={s.bylineName} numberOfLines={1}>{nameOf(a.author)}</Text>
                {a.verified ? <Text style={s.verified}>✓</Text> : null}
                {acc ? <Text style={s.acceptedTag}>· accepted</Text> : null}
                <Text style={s.time} numberOfLines={1}>· {timeAgo(a.ts)}</Text>
                {admin ? (
                  <TouchableOpacity onPress={() => sessions.acceptAnswer(openHash!, qq.id, a.id, !acc).catch(() => {})}>
                    <Text style={s.acceptBtn}>· {acc ? "unaccept" : "accept ✓"}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          </View>
          );
        })}
        {admin && (answering === qq.id ? (
          <View style={s.answerRow}>
            <TextInput style={s.inputSm} placeholder="Answer…" placeholderTextColor={C.muted} value={answerText} onChangeText={setAnswerText} autoFocus />
            <TouchableOpacity style={s.btnPrimarySm} onPress={() => { const v = answerText.trim(); if (v) sessions.postAnswer(openHash!, qq.id, v).catch(() => {}); setAnswerText(""); setAnswering(null); }}><Text style={s.btnPrimaryT}>Send</Text></TouchableOpacity>
          </View>
        ) : (
          <View style={s.adminRow}>
            <TouchableOpacity onPress={() => { setAnswering(qq.id); setAnswerText(""); }}><Text style={s.adminAction}>Answer</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => sessions.moderate(openHash!, qq.id, !qq.moderated).catch(() => {})}><Text style={s.adminAction}>{qq.moderated ? "Unhide" : "Hide"}</Text></TouchableOpacity>
          </View>
        ))}
      </View>
    </View>
  );
  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      {copied ? <View style={s.copiedToast}><Text style={s.copiedToastT}>{copied}</Text></View> : null}
      <View style={s.roomHead}>
        <TouchableOpacity onPress={leaveRoom}><Text style={s.back}>‹ Q&As</Text></TouchableOpacity>
        <Text style={s.roomHeadTitle} numberOfLines={1}>{title}</Text>
        <TouchableOpacity onPress={() => toggleStar(openHash)} hitSlop={10}><Text style={[s.starBtn, sessions.isStarred(openHash) && s.starOn]}>{sessions.isStarred(openHash) ? "★" : "☆"}</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => setShareHash(openHash)}><Text style={s.share}>Share</Text></TouchableOpacity>
      </View>
      {sessions.isStarred(openHash) ? <TouchableOpacity onPress={() => notifyQuestion(openHash!, "Test notification", "If you can see this, notifications work ✓")}><Text style={s.starHint}>★ Kept live in the background · tap to send a test notification</Text></TouchableOpacity> : null}
      {sessions.syncing ? <Text style={s.syncingHint}>⟳  Syncing this Q&A… questions may still be arriving</Text> : null}
      {sessions.unpublishedIn(openHash) > 0 ? <Text style={s.queuedHint}>⏳ {sessions.unpublishedIn(openHash)} not yet published — retrying until they reach the network</Text> : null}
      {(sessions.myName || names[sessions.myAddress]) ? null : <TouchableOpacity onPress={() => { setNameText(sessions.myName); setNameModal(true); }}><Text style={s.setNameHint}>Set a display name so people know who you are →</Text></TouchableOpacity>}
      {admin ? (
        <View style={s.adminBar}>
          <TouchableOpacity style={[s.adminChip, !sessions.sessionOpen(openHash) && s.adminChipClosed]} onPress={() => sessions.setOpen(openHash!, !sessions.sessionOpen(openHash!)).catch(() => {})}>
            <Text style={[s.adminChipT, !sessions.sessionOpen(openHash) && { color: C.danger }]}>{sessions.sessionOpen(openHash) ? "● Open — tap to close" : "○ Closed — tap to open"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.adminChip} onPress={() => { setAdminInput(""); setAdminModal(true); }}><Text style={s.adminChipT}>Admins ({sessions.adminsOf(openHash).length})</Text></TouchableOpacity>
        </View>
      ) : (!sessions.sessionOpen(openHash) ? <Text style={s.closedHint}>🔒 This Q&A is closed — new questions are disabled</Text> : null)}
      {sessions.sessionOpen(openHash) ? (
        <View style={s.askRow}>
          <TextInput style={s.input} placeholder="Ask a question…" placeholderTextColor={C.muted} value={q} onChangeText={setQ} />
          <TouchableOpacity style={s.btnPrimary} onPress={() => { const v = q.trim(); if (v) sessions.ask(openHash, v).catch(() => {}); setQ(""); }}><Text style={s.btnPrimaryT}>Ask</Text></TouchableOpacity>
        </View>
      ) : null}
      <View style={s.controls}>
        <View style={s.chipRow}>
          <Text style={s.chipLabel}>Sort</Text>
          {(["top", "new", "old"] as const).map((k) => (
            <TouchableOpacity key={k} style={[s.chip, sortBy === k && s.chipOn]} onPress={() => setSortBy(k)}><Text style={[s.chipT, sortBy === k && s.chipTOn]}>{k === "top" ? "Top" : k === "new" ? "New" : "Old"}</Text></TouchableOpacity>
          ))}
        </View>
        <View style={s.chipRow}>
          <Text style={s.chipLabel}>Show</Text>
          {(["all", "unanswered", "answered"] as const).map((k) => (
            <TouchableOpacity key={k} style={[s.chip, filterBy === k && s.chipOn]} onPress={() => setFilterBy(k)}><Text style={[s.chipT, filterBy === k && s.chipTOn]}>{k === "all" ? "All" : k === "unanswered" ? "Unanswered" : "Answered"}</Text></TouchableOpacity>
          ))}
        </View>
      </View>
      <ScrollView style={{ flex: 1 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.primary} colors={[C.primary]} progressBackgroundColor={C.surface} />}>
        {shownQ.length === 0 ? <Text style={s.empty}>{allQ.length === 0 ? "No questions yet — be the first to ask." : "Nothing matches this filter."}</Text> : null}
        {shownQ.map(renderQ)}
        {hiddenQ.length > 0 ? (
          <View style={s.hiddenSection}>
            <TouchableOpacity style={s.hiddenHead} onPress={() => setHiddenOpen((v) => !v)}>
              <Text style={s.hiddenHeadT}>{hiddenOpen ? "▾" : "▸"}  Hidden ({hiddenQ.length})</Text>
            </TouchableOpacity>
            {hiddenOpen ? hiddenQ.map(renderQ) : null}
          </View>
        ) : null}
      </ScrollView>
      {ldBanner()}
      <SyncLine status={status} show={showDiag} onToggle={() => setShowDiag((v) => !v)} topic={openHash} />
      {renderShare(shareHash, setShareHash)}
      {renderScanner(scanning, setScanning, (d) => { setScanning(false); doJoin(d); })}
      {renderNameModal(nameModal, setNameModal, nameText, setNameText, saveName, sessions.myAddress, copy)}
      {renderAdminModal(adminModal, setAdminModal, openHash, adminInput, setAdminInput, copy)}
    </SafeAreaView>
  );
}

function ldBanner() {
  if (!usingServiceBackend()) return null;
  const down = serviceNodeDown();
  const waiting = serviceAwaitingApproval();
  if (!down && !waiting) return null;
  return (
    <TouchableOpacity style={s.ldBanner} activeOpacity={0.85} onPress={() => launchSharedService()}>
      <Text style={s.ldBannerIcon}>{down ? "⚠️" : "🔒"}</Text>
      <View style={{ flex: 1 }}>
        <Text style={s.ldBannerT}>{down ? "Logos Delivery isn't running" : "QAKU isn't approved yet"}</Text>
        <Text style={s.ldBannerSub}>{down ? "Tap to open it — QAKU can't sync until it's running." : "Tap to open Logos Delivery and approve QAKU."}</Text>
      </View>
      <Text style={s.ldBannerCta}>OPEN ›</Text>
    </TouchableOpacity>
  );
}

function SyncLine({ status, show, onToggle, topic }: { status: string; show: boolean; onToggle: () => void; topic: string }) {
  const meshBad = counters.mesh === 0;
  return (
    <TouchableOpacity activeOpacity={0.7} onPress={onToggle} style={s.syncLine}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View style={[s.dot, { backgroundColor: counters.peers > 0 && !meshBad ? C.accent : counters.peers > 0 ? C.primary : C.muted }]} />
        <Text style={s.syncTxt}>{counters.peers > 0 ? `${counters.peers} peers` : status}{meshBad ? " · forming…" : ""}</Text>
        <Text style={s.syncMore}>{show ? "▾" : "▸"}</Text>
      </View>
      {show ? <Text selectable style={s.diag}>shard {topic ? shardFor("/qaku/1/" + topic + "/proto") : "-"} · mesh {counters.mesh} · rx {counters.rxNew}/{counters.rxOpened} · tx {counters.txTotal}/{counters.txAttempt} fail {counters.txFail} · notif {sessions.notifyAttempts}{"\n"}{getRxSample()}</Text> : null}
    </TouchableOpacity>
  );
}

function renderNameModal(open: boolean, setOpen: (v: boolean) => void, text: string, setText: (v: string) => void, save: () => void, address: string, copy: (t: string, l?: string) => void) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={s.modalWrap}><View style={s.modalCard}>
        <Text style={s.modalTitle}>Your display name</Text>
        <Text style={s.modalHint}>Shown next to your questions & answers, signed by your key. Others can verify it's really you.</Text>
        <TextInput style={s.modalInput} placeholder="e.g. satoshi" placeholderTextColor={C.muted} value={text} onChangeText={setText} autoFocus autoCapitalize="none" returnKeyType="done" onSubmitEditing={save} />
        <Text style={[s.addrLabel, { marginTop: 14 }]}>Your identity address (share this to be made an admin)</Text>
        <TouchableOpacity onPress={() => copy(address, "Address copied")}><Text style={s.addrVal} selectable>{address}  ⧉</Text></TouchableOpacity>
        <Text style={[s.addrLabel, { marginTop: 14 }]}>Network mode (experimental)</Text>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
          {(["Core", "Edge"] as const).map((m) => {
            const active = sessions.nodeMode === m;
            return (
              <TouchableOpacity key={m} style={[s.modeChip, active && s.modeChipOn]} onPress={() => sessions.setNodeMode(m)}>
                <Text style={[s.modeChipT, active && s.modeChipTOn]}>{m}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={s.modeHint}>{sessions.nodeMode === "Edge"
          ? "Edge: lighter on battery/data — no relay, publishes via lightpush. Experimental. Relaunch the app to apply."
          : "Core: full node, relays traffic for the network. The reliable default. Relaunch the app to apply a change."}</Text>
        <Text style={[s.addrLabel, { marginTop: 14 }]}>Shared node (experimental)</Text>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
          {([["Own node", false], ["Shared", true]] as const).map(([lbl, v]) => {
            const active = sessions.useSharedNode === v;
            return (
              <TouchableOpacity key={lbl} style={[s.modeChip, active && s.modeChipOn]} onPress={() => sessions.setUseSharedNode(v)}>
                <Text style={[s.modeChipT, active && s.modeChipTOn]}>{lbl}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={s.modeHint}>{sessions.useSharedNode
          ? "Shared: route through the Logos Delivery app's one device-wide node (you approve QAKU there once). Falls back to its own node if not installed. Relaunch to apply."
          : "Own node: QAKU runs its own embedded node (default). Relaunch to apply a change."}</Text>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
          <TouchableOpacity style={[s.btnGhost, { flex: 1 }]} onPress={() => setOpen(false)}><Text style={s.btnGhostT}>Cancel</Text></TouchableOpacity>
          <TouchableOpacity style={[s.btnPrimary, { flex: 1 }]} onPress={save}><Text style={s.btnPrimaryT}>Save</Text></TouchableOpacity>
        </View>
      </View></View>
    </Modal>
  );
}

function renderShare(hash: string | null, setHash: (v: string | null) => void) {
  if (!hash) return null;
  const uri = shareUriFor(sessions.secretHex(hash));
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => setHash(null)}>
      <View style={s.modalWrap}><View style={s.modalCard}>
        <Text style={s.modalTitle}>Share this Q&A</Text>
        <View style={s.qrBox}><QRCode value={uri} size={210} backgroundColor="#ffffff" color="#000000" /></View>
        <Text style={s.modalHint}>Scan to join & sync. The secret is the password — it encrypts every message. Keep it private.</Text>
        <Text selectable style={s.secretTxt}>{sessions.secretHex(hash)}</Text>
        <TouchableOpacity style={[s.btnPrimary, { marginTop: 12 }]} onPress={() => setHash(null)}><Text style={s.btnPrimaryT}>Done</Text></TouchableOpacity>
      </View></View>
    </Modal>
  );
}

function renderAdminModal(open: boolean, setOpen: (v: boolean) => void, hash: string | null, input: string, setInput: (v: string) => void, copy: (t: string, l?: string) => void) {
  if (!hash) return null;
  const owner = sessions.ownerOf(hash);
  const isOwner = sessions.isOwner(hash);
  const admins = sessions.adminsOf(hash).filter((a) => a !== owner);
  const add = () => { const v = input.trim(); if (v) { sessions.addAdmin(hash, v).catch(() => {}); setInput(""); } };
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={s.modalWrap}><View style={s.modalCard}>
        <Text style={s.modalTitle}>Admins</Text>
        <Text style={s.modalHint}>Admins can answer, moderate, open/close, and run polls. Add someone by their identity address (from their name screen), or a Basecamp's device id.</Text>
        <Text style={s.addrLabel}>Your address{isOwner ? "  (owner)" : ""}</Text>
        <TouchableOpacity onPress={() => copy(sessions.myAddress, "Address copied")}><Text style={s.addrVal} selectable>{sessions.myAddress}  ⧉</Text></TouchableOpacity>
        <View style={s.divider} />
        <Text style={s.addrLabel}>Owner</Text>
        <Text style={s.addrVal} numberOfLines={1}>{shortAddr(owner)}</Text>
        {admins.length ? <Text style={[s.addrLabel, { marginTop: 10 }]}>Admins</Text> : null}
        {admins.map((a) => (
          <View key={a} style={s.adminRowM}>
            <Text style={[s.addrVal, { flex: 1 }]} numberOfLines={1}>{shortAddr(a)}</Text>
            {isOwner ? <TouchableOpacity onPress={() => sessions.removeAdmin(hash, a).catch(() => {})}><Text style={s.removeT}>Remove</Text></TouchableOpacity> : null}
          </View>
        ))}
        <View style={s.divider} />
        <Text style={s.addrLabel}>Add admin</Text>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
          <TextInput style={[s.modalInput, { flex: 1 }]} placeholder="0x… address or device id" placeholderTextColor={C.muted} value={input} onChangeText={setInput} autoCapitalize="none" autoCorrect={false} />
          <TouchableOpacity style={s.btnPrimary} onPress={add}><Text style={s.btnPrimaryT}>Add</Text></TouchableOpacity>
        </View>
        <TouchableOpacity style={[s.btnGhost, { marginTop: 14 }]} onPress={() => setOpen(false)}><Text style={s.btnGhostT}>Done</Text></TouchableOpacity>
      </View></View>
    </Modal>
  );
}

function renderScanner(scanning: boolean, setScanning: (v: boolean) => void, onScanned: (d: string) => void) {
  return (
    <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={(e) => scanning && onScanned(e.data)} />
        <View style={s.scanHint} pointerEvents="none"><Text style={s.scanHintT}>Point at a QAKU QR</Text></View>
        <TouchableOpacity style={s.scanCancel} onPress={() => setScanning(false)}><Text style={s.btnPrimaryT}>Cancel</Text></TouchableOpacity>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, padding: 16 },
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  brand: { color: C.text, fontSize: 28, fontWeight: "800", letterSpacing: 1 },
  logo: { width: 32, height: 32, borderRadius: 7 },
  namePill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: C.surface, borderRadius: 20, paddingVertical: 4, paddingHorizontal: 8, maxWidth: 160 },
  namePillT: { color: C.muted, fontSize: 12 },
  section: { color: C.muted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 },
  empty: { color: C.muted, fontSize: 14, textAlign: "center", marginTop: 30, paddingHorizontal: 20, lineHeight: 20 },
  roomCard: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.surface, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  roomCardUnread: { borderColor: C.primary },
  unreadBadge: { backgroundColor: C.primary, borderRadius: 11, minWidth: 22, height: 22, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  unreadBadgeT: { color: C.primaryFg, fontSize: 12, fontWeight: "800" },
  syncingHint: { color: C.primary, fontSize: 12, marginBottom: 8 },
  queuedHint: { color: C.primary, fontSize: 12, marginBottom: 8, fontWeight: "700" },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  syncingSmall: { color: C.primary, fontSize: 11 },
  roomTitle: { color: C.text, fontSize: 16, fontWeight: "700" },
  roomSub: { color: C.muted, fontSize: 12, marginTop: 2 },
  hostBadge: { backgroundColor: C.primary, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  hostBadgeT: { color: C.primaryFg, fontSize: 10, fontWeight: "800" },
  chev: { color: C.muted, fontSize: 22 },
  createRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  joinRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  input: { flex: 1, backgroundColor: C.input, color: C.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, minHeight: 44 },
  // Modal inputs live in a COLUMN card — no flex:1 (which would collapse their height);
  // full width via alignSelf stretch + an explicit height so they're tappable.
  modalInput: { alignSelf: "stretch", backgroundColor: C.input, color: C.text, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, minHeight: 48 },
  inputSm: { flex: 1, backgroundColor: C.input, color: C.text, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 },
  btnPrimary: { backgroundColor: C.primary, borderRadius: 10, paddingHorizontal: 16, justifyContent: "center", alignItems: "center" },
  btnPrimaryT: { color: C.primaryFg, fontWeight: "800" },
  btnPrimarySm: { backgroundColor: C.primary, borderRadius: 8, paddingHorizontal: 12, justifyContent: "center" },
  btnGhost: { backgroundColor: C.surface2, borderRadius: 10, paddingHorizontal: 14, justifyContent: "center", alignItems: "center" },
  btnGhostT: { color: C.primary, fontWeight: "700" },
  dim: { opacity: 0.5 },
  error: { color: C.danger, fontSize: 13, marginTop: 8 },
  // room
  roomHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  back: { color: C.primary, fontSize: 15, fontWeight: "700" },
  roomHeadTitle: { color: C.text, fontSize: 17, fontWeight: "800", flex: 1, textAlign: "center", marginHorizontal: 8 },
  share: { color: C.accent, fontSize: 14, fontWeight: "700" },
  starBtn: { color: C.muted, fontSize: 20, marginHorizontal: 10 },
  starOn: { color: C.primary },
  starMini: { color: C.primary, fontSize: 13 },
  starHint: { color: C.primary, fontSize: 12, marginBottom: 8, opacity: 0.9 },
  setNameHint: { color: C.primary, fontSize: 12, marginBottom: 8 },
  ldBanner: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: "#c2410c", borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, marginBottom: 10 },
  ldBannerIcon: { fontSize: 24 },
  ldBannerT: { color: "#ffffff", fontSize: 15, fontWeight: "800" },
  ldBannerSub: { color: "#ffe3cf", fontSize: 12, marginTop: 2, lineHeight: 16 },
  ldBannerCta: { color: "#ffffff", fontSize: 14, fontWeight: "800" },
  modeChip: { flex: 1, borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingVertical: 8, alignItems: "center" },
  modeChipOn: { backgroundColor: C.primary, borderColor: C.primary },
  modeChipT: { color: C.muted, fontSize: 13, fontWeight: "700" },
  modeChipTOn: { color: "#ffffff" },
  modeHint: { color: C.muted, fontSize: 11, marginTop: 6, lineHeight: 15 },
  askRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  qCard: { flexDirection: "row", gap: 10, backgroundColor: C.surface, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  upvote: { alignItems: "center", backgroundColor: C.surface2, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: 42 },
  upvoteArrow: { color: C.primary, fontSize: 12 },
  upvoteN: { color: C.text, fontWeight: "800", fontSize: 15 },
  qText: { color: C.text, fontSize: 15, lineHeight: 20 },
  byline: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  bylineName: { color: C.muted, fontSize: 12, maxWidth: 140 },
  verified: { color: C.accent, fontSize: 12, fontWeight: "800" },
  pubOk: { color: C.accent, fontSize: 11, fontWeight: "700" },
  pubPending: { color: C.primary, fontSize: 11, fontWeight: "800" },
  time: { color: C.muted, fontSize: 11, opacity: 0.8 },
  answer: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: C.border },
  answerText: { color: "#d8d8e0", fontSize: 14, lineHeight: 19 },
  ansUpvote: { alignItems: "center", backgroundColor: C.surface2, borderRadius: 7, paddingHorizontal: 7, paddingVertical: 3, minWidth: 34 },
  ansUpvoteArrow: { color: C.primary, fontSize: 10 },
  ansUpvoteN: { color: C.text, fontWeight: "800", fontSize: 12 },
  acceptedTag: { color: C.accent, fontSize: 11, fontWeight: "700" },
  acceptBtn: { color: C.primary, fontSize: 11, fontWeight: "800" },
  answerRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  adminRow: { flexDirection: "row", gap: 16, marginTop: 8 },
  adminAction: { color: C.accent, fontSize: 13, fontWeight: "700" },
  // admin bar (open/close + admins), closed hint, copy toast, address rows
  adminBar: { flexDirection: "row", gap: 8, marginBottom: 10 },
  adminChip: { backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 },
  adminChipClosed: { borderColor: C.danger },
  adminChipT: { color: C.accent, fontSize: 12, fontWeight: "700" },
  closedHint: { color: C.danger, fontSize: 12, marginBottom: 10 },
  copiedToast: { position: "absolute", top: 8, alignSelf: "center", backgroundColor: C.accent, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 6, zIndex: 100 },
  copiedToastT: { color: C.primaryFg, fontWeight: "800", fontSize: 12 },
  addrLabel: { color: C.muted, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  addrVal: { color: C.accent, fontSize: 13, fontFamily: "monospace", marginTop: 3 },
  divider: { height: 1, backgroundColor: C.border, marginVertical: 12 },
  adminRowM: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 },
  removeT: { color: C.danger, fontSize: 12, fontWeight: "700" },
  // sort/filter controls
  controls: { gap: 6, marginBottom: 10 },
  chipRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  chipLabel: { color: C.muted, fontSize: 11, width: 34 },
  chip: { backgroundColor: C.surface, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: C.border },
  chipOn: { backgroundColor: C.primary, borderColor: C.primary },
  chipT: { color: C.muted, fontSize: 12, fontWeight: "600" },
  chipTOn: { color: C.primaryFg, fontWeight: "800" },
  // hidden section
  hiddenSection: { marginTop: 8, borderTopWidth: 1, borderTopColor: C.border, paddingTop: 8 },
  hiddenHead: { paddingVertical: 8 },
  hiddenHeadT: { color: C.muted, fontSize: 13, fontWeight: "700" },
  // sync line
  syncLine: { borderTopWidth: 1, borderTopColor: C.border, paddingTop: 8, marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  syncTxt: { color: C.muted, fontSize: 12, flex: 1 },
  syncMore: { color: C.muted, fontSize: 12 },
  diag: { color: C.muted, fontSize: 10, marginTop: 6, fontFamily: "monospace" },
  // modals
  modalWrap: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: C.surface, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: C.border },
  modalTitle: { color: C.text, fontSize: 18, fontWeight: "800", marginBottom: 6 },
  modalHint: { color: C.muted, fontSize: 12, lineHeight: 17, marginBottom: 12 },
  qrBox: { backgroundColor: "#fff", padding: 14, borderRadius: 10, alignSelf: "center", marginBottom: 12 },
  secretTxt: { color: C.accent, fontSize: 11, fontFamily: "monospace", textAlign: "center" },
  scanHint: { position: "absolute", top: 80, left: 0, right: 0, alignItems: "center" },
  scanHintT: { color: "#fff", backgroundColor: "rgba(0,0,0,0.5)", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  scanCancel: { position: "absolute", bottom: 40, alignSelf: "center", backgroundColor: C.primary, borderRadius: 10, paddingHorizontal: 28, paddingVertical: 12 },
});
