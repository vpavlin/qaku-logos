// QAKU mobile - minimal scaffold UI. Joins a session from a pasted secret (hex),
// folds via the shared engine, and renders questions/upvotes + a Sync card with
// the per-stage counters (the make-or-break diagnostic).
import React, { useEffect, useMemo, useState } from "react";
import { SafeAreaView, ScrollView, View, Text, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import { Session } from "./src/lib/session";
import { newSecret } from "./src/lib/crypto";
import { counters } from "./src/lib/delivery";

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) => new Uint8Array((s.match(/.{1,2}/g) || []).map((h) => parseInt(h, 16)));

export default function App() {
  const session = useMemo(() => new Session(), []);
  const [state, setState] = useState<any>({ questions: [] });
  const [secretHex, setSecretHex] = useState("");
  const [q, setQ] = useState("");
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => session.subscribe(() => setState(session.state())), [session]);

  // Joining boots a Waku node (10-30s) and does a store catch-up, so the button
  // MUST show progress and MUST surface failures - in release, a swallowed throw
  // just looks like a dead button. A pasted 64-hex secret drives start() onto the
  // SAME derived topic as the desktop; blank generates a fresh session secret.
  const join = async () => {
    if (joining) return;
    const trimmed = secretHex.trim().toLowerCase();
    if (trimmed.length > 0 && !/^[0-9a-f]{64}$/.test(trimmed)) {
      setError("Secret must be 64 hex characters (or leave blank to create a new session).");
      return;
    }
    setError("");
    setJoining(true);
    try {
      const secret = trimmed.length === 64 ? fromHex(trimmed) : newSecret();
      setSecretHex(hex(secret));
      await session.start(secret);
      setJoined(true);
    } catch (e: any) {
      setError("Join failed: " + (e && e.message ? e.message : String(e)));
    } finally {
      setJoining(false);
    }
  };

  return (
    <SafeAreaView style={s.root}>
      <Text style={s.h1}>QAKU</Text>
      {!joined ? (
        <>
          <View style={s.row}>
            <TextInput style={s.input} editable={!joining} placeholder="session secret (hex) or blank to create" placeholderTextColor="#667" value={secretHex} onChangeText={setSecretHex} autoCapitalize="none" autoCorrect={false} />
            <TouchableOpacity style={[s.btn, joining && s.btnDisabled]} disabled={joining} onPress={join}>
              <Text style={s.btnT}>{joining ? "Joining…" : "Join"}</Text>
            </TouchableOpacity>
          </View>
          {joining ? <Text style={s.hint}>Starting node and syncing… this can take 10-30s.</Text> : null}
          {error ? <Text style={s.error}>{error}</Text> : null}
        </>
      ) : (
        <>
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
            <Text style={s.syncT}>rxRaw {counters.rxRaw} - rxSeen {counters.rxSeen} - rxOpened {counters.rxOpened} - rxNew {counters.rxNew} - tx {counters.txTotal} - peers {counters.peers}</Text>
          </View>
        </>
      )}
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
  hint: { color: "#8b93a7", fontSize: 12, marginBottom: 8 },
  error: { color: "#fb3748", fontSize: 13, marginBottom: 8 },
  card: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "#161a22", borderRadius: 10, padding: 12, marginBottom: 8 },
  up: { backgroundColor: "#232838", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  upT: { color: "#8fd6b4", fontWeight: "700" },
  qText: { color: "#e7ebf3", flex: 1 },
  sync: { paddingTop: 8, borderTopWidth: 1, borderTopColor: "#232838" },
  syncT: { color: "#8b93a7", fontSize: 11 },
});
