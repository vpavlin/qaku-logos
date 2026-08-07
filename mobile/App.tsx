// QAKU mobile — multi-session Q&A. A home list of joined Q&As (join by secret/QR or
// create), each opening a signed, live-synced session. Authors are verifiable addresses
// with optional display names; a small collapsible sync line keeps the diagnostics out
// of the way. Palette = the original qaku (dark + gold primary + teal accent).
import React, { useEffect, useMemo, useState } from "react";
import { SafeAreaView, ScrollView, View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, BackHandler } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import QRCode from "react-native-qrcode-svg";
import { Sessions, shareUriFor, extractSecret } from "./src/lib/sessions";
import { shortAddr } from "./src/lib/identity";
import { counters, getRxSample, refreshPeerInfo, shardFor } from "./src/lib/logos-transport";

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

function Avatar({ addr, name, size = 28 }: { addr: string; name?: string; size?: number }) {
  // deterministic hue from the address; initial = first letter of name or "0x".
  let h = 0; for (let i = 2; i < Math.min(addr.length, 10); i++) h = (h * 31 + addr.charCodeAt(i)) % 360;
  const initial = (name && name.trim()[0]) || (addr[2] || "?");
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: `hsl(${h},45%,32%)`, alignItems: "center", justifyContent: "center" }}><Text style={{ color: C.text, fontWeight: "700", fontSize: size * 0.45 }}>{initial.toUpperCase()}</Text></View>;
}

function AppInner() {
  const sessions = useMemo(() => new Sessions(), []);
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
  const [permission, requestPermission] = useCameraPermissions();

  useEffect(() => {
    const un = sessions.subscribe(scheduleForce);
    sessions.start(setStatus).catch((e) => setError("Start failed: " + (e?.message || e)));
    const t = setInterval(() => { refreshPeerInfo().catch(() => {}); force(); }, 3000);
    return () => { un(); clearInterval(t); };
  }, [sessions]);

  // Android hardware back: close any open modal → leave the open Q&A back to the list →
  // only then let the OS handle it (exit). Without this, back killed the app from anywhere.
  useEffect(() => {
    const onBack = () => {
      if (scanning) { setScanning(false); return true; }
      if (nameModal) { setNameModal(false); return true; }
      if (shareHash) { setShareHash(null); return true; }
      if (openHash) { setOpenHash(null); return true; }
      return false;
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => sub.remove();
  }, [scanning, nameModal, shareHash, openHash]);

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
        <View style={s.topRow}>
          <Text style={s.brand}>QA<Text style={{ color: C.primary }}>KU</Text></Text>
          <TouchableOpacity style={s.namePill} onPress={() => { setNameText(sessions.myName); setNameModal(true); }}>
            <Avatar addr={sessions.myAddress || "0x0"} name={sessions.myName} size={22} />
            <Text style={s.namePillT} numberOfLines={1}>{sessions.myName || shortAddr(sessions.myAddress)}</Text>
          </TouchableOpacity>
        </View>
        <Text style={s.section}>Your Q&As</Text>
        <ScrollView style={{ flex: 1 }}>
          {rooms.length === 0 ? <Text style={s.empty}>No Q&As yet. Create one, or join with a secret / QR.</Text> : null}
          {rooms.map((r) => (
            <TouchableOpacity key={r.topicHash} style={s.roomCard} onPress={() => setOpenHash(r.topicHash)}>
              <View style={{ flex: 1 }}>
                <Text style={s.roomTitle} numberOfLines={1}>{r.title}</Text>
                <Text style={s.roomSub}>{r.questions} question{r.questions === 1 ? "" : "s"}{r.owned ? "  ·  you host" : ""}</Text>
              </View>
              {r.owned ? <View style={s.hostBadge}><Text style={s.hostBadgeT}>HOST</Text></View> : null}
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
        <SyncLine status={status} show={showDiag} onToggle={() => setShowDiag((v) => !v)} topic="" />
        {renderScanner(scanning, setScanning, (d) => { setScanning(false); doJoin(d); })}
        {renderNameModal(nameModal, setNameModal, nameText, setNameText, saveName)}
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
        </View>
        {(qq.answers || []).map((a: any) => (
          <View key={a.id} style={s.answer}>
            <Text style={[s.answerText, a.accepted && { color: C.accent }]}>{a.accepted ? "✓ " : "↳ "}{a.content}</Text>
            <View style={s.byline}><Text style={s.bylineName}>{nameOf(a.author)}</Text>{a.verified ? <Text style={s.verified}>✓</Text> : null}</View>
          </View>
        ))}
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
      <View style={s.roomHead}>
        <TouchableOpacity onPress={() => setOpenHash(null)}><Text style={s.back}>‹ Q&As</Text></TouchableOpacity>
        <Text style={s.roomHeadTitle} numberOfLines={1}>{title}</Text>
        <TouchableOpacity onPress={() => setShareHash(openHash)}><Text style={s.share}>Share</Text></TouchableOpacity>
      </View>
      {(sessions.myName || names[sessions.myAddress]) ? null : <TouchableOpacity onPress={() => { setNameText(sessions.myName); setNameModal(true); }}><Text style={s.setNameHint}>Set a display name so people know who you are →</Text></TouchableOpacity>}
      <View style={s.askRow}>
        <TextInput style={s.input} placeholder="Ask a question…" placeholderTextColor={C.muted} value={q} onChangeText={setQ} />
        <TouchableOpacity style={s.btnPrimary} onPress={() => { const v = q.trim(); if (v) sessions.ask(openHash, v).catch(() => {}); setQ(""); }}><Text style={s.btnPrimaryT}>Ask</Text></TouchableOpacity>
      </View>
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
      <ScrollView style={{ flex: 1 }}>
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
      <SyncLine status={status} show={showDiag} onToggle={() => setShowDiag((v) => !v)} topic={openHash} />
      {renderShare(shareHash, sessions, setShareHash)}
      {renderScanner(scanning, setScanning, (d) => { setScanning(false); doJoin(d); })}
      {renderNameModal(nameModal, setNameModal, nameText, setNameText, saveName)}
    </SafeAreaView>
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
      {show ? <Text selectable style={s.diag}>shard {topic ? shardFor("/qaku/1/" + topic + "/proto") : "-"} · mesh {counters.mesh} · rx {counters.rxNew}/{counters.rxOpened} · tx {counters.txTotal}/{counters.txAttempt} fail {counters.txFail}{"\n"}{getRxSample()}</Text> : null}
    </TouchableOpacity>
  );
}

function renderNameModal(open: boolean, setOpen: (v: boolean) => void, text: string, setText: (v: string) => void, save: () => void) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={s.modalWrap}><View style={s.modalCard}>
        <Text style={s.modalTitle}>Your display name</Text>
        <Text style={s.modalHint}>Shown next to your questions & answers, signed by your key. Others can verify it's really you.</Text>
        <TextInput style={s.modalInput} placeholder="e.g. satoshi" placeholderTextColor={C.muted} value={text} onChangeText={setText} autoFocus autoCapitalize="none" returnKeyType="done" onSubmitEditing={save} />
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          <TouchableOpacity style={[s.btnGhost, { flex: 1 }]} onPress={() => setOpen(false)}><Text style={s.btnGhostT}>Cancel</Text></TouchableOpacity>
          <TouchableOpacity style={[s.btnPrimary, { flex: 1 }]} onPress={save}><Text style={s.btnPrimaryT}>Save</Text></TouchableOpacity>
        </View>
      </View></View>
    </Modal>
  );
}

function renderShare(hash: string | null, sessions: Sessions, setHash: (v: string | null) => void) {
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
  namePill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: C.surface, borderRadius: 20, paddingVertical: 4, paddingHorizontal: 8, maxWidth: 160 },
  namePillT: { color: C.muted, fontSize: 12 },
  section: { color: C.muted, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 },
  empty: { color: C.muted, fontSize: 14, textAlign: "center", marginTop: 30, paddingHorizontal: 20, lineHeight: 20 },
  roomCard: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.surface, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: C.border },
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
  setNameHint: { color: C.primary, fontSize: 12, marginBottom: 8 },
  askRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  qCard: { flexDirection: "row", gap: 10, backgroundColor: C.surface, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  upvote: { alignItems: "center", backgroundColor: C.surface2, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: 42 },
  upvoteArrow: { color: C.primary, fontSize: 12 },
  upvoteN: { color: C.text, fontWeight: "800", fontSize: 15 },
  qText: { color: C.text, fontSize: 15, lineHeight: 20 },
  byline: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  bylineName: { color: C.muted, fontSize: 12, maxWidth: 160 },
  verified: { color: C.accent, fontSize: 12, fontWeight: "800" },
  answer: { marginTop: 8, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: C.border },
  answerText: { color: "#d8d8e0", fontSize: 14, lineHeight: 19 },
  answerRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  adminRow: { flexDirection: "row", gap: 16, marginTop: 8 },
  adminAction: { color: C.accent, fontSize: 13, fontWeight: "700" },
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
