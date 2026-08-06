// QAKU mobile - minimal scaffold UI. Joins a session from a pasted secret (hex),
// a scanned QR, or a qaku://join?s=<hex> link; folds via the shared engine, and
// renders questions/upvotes + a Sync card with the per-stage counters (the
// make-or-break diagnostic).
import React, { useEffect, useMemo, useState } from "react";
import { SafeAreaView, ScrollView, View, Text, TextInput, TouchableOpacity, StyleSheet, Modal } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import QRCode from "react-native-qrcode-svg";
import { Session } from "./src/lib/session";
import { newSecret } from "./src/lib/crypto";
import { counters, getTopic, getShard, refreshPeerCount, getRxSample } from "./src/lib/delivery";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) => new Uint8Array((s.match(/.{1,2}/g) || []).map((h) => parseInt(h, 16)));

// The shareable pairing artifact: qaku://join?s=<64-hex secret>. The secret IS
// the password (it derives the topic AND the AEAD key), so the URI carries
// everything a peer needs to join and decrypt - the same secret-in-URL model as
// the original qaku. Strip the prefix down to the raw hex; accept a raw secret too.
const shareUriFor = (secret: Uint8Array) => "qaku://join?s=" + hex(secret);
function extractSecret(input: string): string {
  const s = input.trim();
  const i = s.indexOf("s=");
  return s.startsWith("qaku://") && i >= 0 ? s.slice(i + 2).trim() : s;
}

// --- crash surfacing: release builds hide JS errors (silent close). Capture them
// and show on screen so a crash is READABLE without a device logcat. If the app
// STILL hard-closes past this, the fault is native, not JS. ---
let __lastError = "";
try {
  const EU = (global as any).ErrorUtils;
  if (EU && EU.setGlobalHandler) {
    EU.setGlobalHandler((e: any, isFatal?: boolean) => {
      __lastError = (isFatal ? "[FATAL] " : "") + (e && e.message ? e.message : String(e)) + "\n" +
        String((e && e.stack) || "").split("\n").slice(0, 8).join("\n");
      // deliberately do NOT rethrow — keep the app alive so the UI can display it
    });
  }
} catch { /* */ }

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: string }> {
  state = { err: "" };
  static getDerivedStateFromError(e: any) {
    return { err: (e && e.message ? e.message : String(e)) + "\n" + String((e && e.stack) || "").split("\n").slice(0, 10).join("\n") };
  }
  render() {
    if (this.state.err) return (
      <SafeAreaView style={{ flex: 1, backgroundColor: "#1a0000", padding: 20 }}>
        <Text style={{ color: "#ff8a8a", fontSize: 13, fontWeight: "bold", marginBottom: 8 }}>QAKU render crash</Text>
        <ScrollView><Text selectable style={{ color: "#ffbcbc", fontSize: 12 }}>{this.state.err}</Text></ScrollView>
      </SafeAreaView>
    );
    return this.props.children as any;
  }
}

export default function App() {
  const [gerr, setGerr] = useState("");
  useEffect(() => {
    const t = setInterval(() => { if (__lastError && __lastError !== gerr) setGerr(__lastError); }, 400);
    return () => clearInterval(t);
  }, [gerr]);
  if (gerr) return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#1a0000", padding: 20 }}>
      <Text style={{ color: "#ff8a8a", fontSize: 13, fontWeight: "bold", marginBottom: 8 }}>QAKU JS error</Text>
      <ScrollView><Text selectable style={{ color: "#ffbcbc", fontSize: 12 }}>{gerr}</Text></ScrollView>
    </SafeAreaView>
  );
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}

function AppInner() {
  const session = useMemo(() => new Session(), []);
  const [state, setState] = useState<any>({ questions: [] });
  const [secretHex, setSecretHex] = useState("");
  const [q, setQ] = useState("");
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinStatus, setJoinStatus] = useState("");
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  useEffect(() => session.subscribe(() => setState(session.state())), [session]);

  // Keep the Sync card live: poll the node's peer count and force a re-render every
  // 3s while joined. Without this, counters.peers stays at its initial -1 forever
  // (refreshPeerCount was never called) and rxRaw/tx only moved on receive/send —
  // so "peers -1" was a stale display, NOT a real "no peers".
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!joined) return;
    const t = setInterval(() => {
      refreshPeerCount()
        .then(() => { if (counters.mesh > 0) session.flushPending(); }) // publish pending the instant the mesh opens
        .catch(() => {});
      forceTick((n) => n + 1);
    }, 3000);
    return () => clearInterval(t);
  }, [joined]);

  // Joining boots a Waku node (10-30s) and does a store catch-up, so the button
  // MUST show progress and MUST surface failures - in release, a swallowed throw
  // just looks like a dead button. A pasted 64-hex secret (or scanned qaku://join
  // link) drives start() onto the SAME derived topic as the desktop; blank
  // generates a fresh session secret. Takes an optional raw value so the scanner
  // and the paste field share ONE join path (no second code branch to drift).
  const join = async (raw?: string) => {
    if (joining) return;
    const trimmed = extractSecret(raw !== undefined ? raw : secretHex).toLowerCase();
    if (trimmed.length > 0 && !/^[0-9a-f]{64}$/.test(trimmed)) {
      setError("Secret must be 64 hex characters or a qaku://join link (or leave blank to create a new session).");
      return;
    }
    setError("");
    setJoining(true);
    try {
      const secret = trimmed.length === 64 ? fromHex(trimmed) : newSecret();
      setSecretHex(hex(secret));
      await session.start(secret, setJoinStatus);
      setJoined(true);
    } catch (e: any) {
      setError("Join failed: " + (e && e.message ? e.message : String(e)));
    } finally {
      setJoining(false);
    }
  };

  // Open the scanner, asking for the camera permission on first use.
  const openScanner = async () => {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        setError("Camera access is needed to scan a QR - allow it, or paste the secret/link instead.");
        return;
      }
    }
    setError("");
    setScanning(true);
  };

  // A scanned QR carries the same qaku://join?s=<hex> the typed field accepts, so
  // it goes through exactly one join path.
  const onScanned = (data: string) => {
    if (!scanning) return; // ignore the burst of frames after the first hit
    setScanning(false);
    join(data);
  };

  const shareUri = secretHex.length === 64 ? shareUriFor(fromHex(secretHex)) : "";

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.h1}>QAKU</Text>
      {!joined ? (
        <>
          <View style={s.row}>
            <TextInput style={s.input} editable={!joining} placeholder="secret (hex) / qaku://join link, or blank to create" placeholderTextColor="#667" value={secretHex} onChangeText={setSecretHex} autoCapitalize="none" autoCorrect={false} />
            <TouchableOpacity style={[s.btn, joining && s.btnDisabled]} disabled={joining} onPress={() => join()}>
              <Text style={s.btnT}>{joining ? "Joining…" : "Join"}</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={[s.scanBtn, joining && s.btnDisabled]} disabled={joining} onPress={openScanner}>
            <Text style={s.scanBtnT}>Scan QR</Text>
          </TouchableOpacity>
          {joining ? <Text selectable style={s.hint}>{joinStatus || "starting…"}  (10-30s)</Text> : null}
          {error ? <Text style={s.error}>{error}</Text> : null}
        </>
      ) : (
        <>
          {shareUri ? (
            <View style={s.shareCard}>
              <Text style={s.shareTitle}>Share this Q&A</Text>
              <View style={s.qrBox}>
                <QRCode value={shareUri} size={200} backgroundColor="#ffffff" color="#000000" />
              </View>
              <Text style={s.shareHint}>Scan on another phone, or share the secret, to join and sync. The secret is the password - it encrypts every message end-to-end. Keep it private.</Text>
              <Text style={s.shareSecret} selectable>{secretHex}</Text>
            </View>
          ) : null}
          <View style={s.row}>
            <TextInput style={s.input} placeholder="Ask a question..." placeholderTextColor="#667" value={q} onChangeText={setQ} />
            <TouchableOpacity style={s.btn} onPress={() => { session.ask(q); setQ(""); }}><Text style={s.btnT}>Ask</Text></TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1 }}>
            {(state.questions || []).map((qq: any) => (
              <View key={qq.id} style={s.card}>
                <TouchableOpacity style={s.up} onPress={() => session.upvote(qq.id)}><Text style={s.upT}>^ {qq.upvotes}</Text></TouchableOpacity>
                <Text style={s.qText}>{qq.moderated ? "[hidden] " : ""}{qq.content}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={s.sync}>
            <Text selectable style={s.syncT}>topic {getTopic() || "-"}</Text>
            <Text style={s.syncT}>shard {getShard()}   peers {counters.peers}   mesh {counters.mesh}{counters.mesh === 0 ? " (can't publish!)" : ""}</Text>
            <Text style={s.syncT}>rxRaw {counters.rxRaw} - noPayload {counters.rxNoPayload} - selfEcho {counters.rxSelfEcho} - seen {counters.rxSeen}</Text>
            <Text style={s.syncT}>rxOpened {counters.rxOpened} - rxFail {counters.rxOpenFail} - rxNew {counters.rxNew} - tx {counters.txTotal}</Text>
            <Text selectable style={s.syncT}>{getRxSample()}</Text>
          </View>
        </>
      )}

      {/* QR scanner overlay */}
      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={s.scannerRoot}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(e) => onScanned(e.data)}
          />
          <View style={s.scanHint} pointerEvents="none">
            <Text style={s.scanHintT}>Point at the QAKU QR shown on the other device</Text>
          </View>
          <TouchableOpacity style={s.scanCancel} onPress={() => setScanning(false)}>
            <Text style={s.btnT}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0f1115", padding: 16 },
  h1: { color: "#f5f7fa", fontSize: 26, fontWeight: "700", marginBottom: 12 },
  row: { flexDirection: "row", gap: 8, marginBottom: 12 },
  input: { flex: 1, backgroundColor: "#1a1e27", color: "#f5f7fa", borderRadius: 8, paddingHorizontal: 12 },
  btn: { backgroundColor: "#2a7d5f", borderRadius: 8, paddingHorizontal: 16, justifyContent: "center" },
  btnDisabled: { backgroundColor: "#24402f" },
  btnT: { color: "white", fontWeight: "600" },
  scanBtn: { backgroundColor: "#232838", borderRadius: 8, paddingVertical: 12, alignItems: "center", marginBottom: 8 },
  scanBtnT: { color: "#8fd6b4", fontWeight: "600" },
  hint: { color: "#8b93a7", fontSize: 12, marginBottom: 8 },
  error: { color: "#fb3748", fontSize: 13, marginBottom: 8 },
  shareCard: { backgroundColor: "#161a22", borderRadius: 12, padding: 16, marginBottom: 12, alignItems: "center" },
  shareTitle: { color: "#f5f7fa", fontSize: 16, fontWeight: "700", marginBottom: 10, alignSelf: "flex-start" },
  qrBox: { backgroundColor: "#ffffff", padding: 12, borderRadius: 8 },
  shareHint: { color: "#8b93a7", fontSize: 12, marginTop: 10, textAlign: "center" },
  shareSecret: { color: "#8fd6b4", fontSize: 11, fontFamily: "monospace", marginTop: 8, textAlign: "center" },
  card: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#161a22", borderRadius: 10, padding: 12, marginBottom: 8 },
  up: { backgroundColor: "#232838", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  upT: { color: "#8fd6b4", fontWeight: "700" },
  qText: { color: "#e7ebf3", flex: 1 },
  sync: { paddingTop: 8, borderTopWidth: 1, borderTopColor: "#232838" },
  syncT: { color: "#8b93a7", fontSize: 11 },
  scannerRoot: { flex: 1, backgroundColor: "#000" },
  scanHint: { position: "absolute", top: 80, left: 0, right: 0, alignItems: "center" },
  scanHintT: { color: "#fff", backgroundColor: "rgba(0,0,0,0.5)", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, fontSize: 13 },
  scanCancel: { position: "absolute", bottom: 40, alignSelf: "center", backgroundColor: "#2a7d5f", borderRadius: 8, paddingHorizontal: 28, paddingVertical: 12 },
});
