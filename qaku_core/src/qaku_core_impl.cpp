// QakuCoreImpl implementation. The engine/crypto/wire are the std-only headers
// (qaku_engine.hpp etc., byte-parity with the JS reference). This file wires the
// multi-session mutation API + the delivery_module transport (SDS Reliable
// Channels), routing incoming messages to the session that owns the topic.
//
// Every delivery call is async / fire-and-forget (a synchronous send on the
// event-loop thread freezes the module on the IPC timeout).
#include "qaku_core_impl.h"
#include "logos_sdk.h"   // umbrella: LogosModules + LogosMap(nlohmann::json) + StdLogosResult
#include "qrcodegen.hpp"  // vendored Nayuki QR encoder (the host qr core is unreachable from a pure-QML view)
#include <QTimer>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cctype>
#include <algorithm>

using qaku::json;
using qaku::Event;

static long long nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}
static std::string hex(const qaku::Bytes& b){ return qaku::toHex(b.data(), b.size()); }
static qaku::Bytes fromHex(const std::string& s){ qaku::Bytes b; for (size_t i=0;i+1<s.size();i+=2) b.push_back((uint8_t)std::stoi(s.substr(i,2), nullptr, 16)); return b; }
// Minimal base64 (the FFI wants base64 at the channelSend boundary).
static const char* kB64T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static std::string b64(const qaku::Bytes& in){ std::string o; int val=0,bits=-6; for(uint8_t c:in){val=(val<<8)+c;bits+=8;while(bits>=0){o+=kB64T[(val>>bits)&0x3F];bits-=6;}} if(bits>-6)o+=kB64T[((val<<8)>>(bits+8))&0x3F]; while(o.size()%4)o+='='; return o; }
static std::string b64s(const std::string& in){ return b64(qaku::Bytes(in.begin(), in.end())); }
static std::string b64decode(const std::string& in){ std::vector<int> T(256,-1); for(int i=0;i<64;i++) T[(unsigned char)kB64T[i]]=i; std::string o; int val=0,bits=-8; for(unsigned char c:in){ if(T[c]==-1) break; val=(val<<6)+T[c]; bits+=6; if(bits>=0){ o.push_back(char((val>>bits)&0xFF)); bits-=8; } } return o; }
// The delivery send() payload must be a JSON byte ARRAY under the current cpp-sdk
// (a JSON string throws "type must be array, but is string" in the marshaling);
// this produces the same wire bytes. deliverySend probes array vs string.
static LogosMap bytesPayload(const std::string& s){ LogosMap a = LogosMap::array(); for (unsigned char c : s) a.push_back((unsigned)c); return a; }

// A 64-hex string is a valid session secret (32 bytes).
static bool isHex64(const std::string& s){ if (s.size()!=64) return false; for (char c : s) { if (!((c>='0'&&c<='9')||(c>='a'&&c<='f')||(c>='A'&&c<='F'))) return false; } return true; }
// The shareable pairing artifact: qaku://join?s=<64-hex secret> - the secret IS
// the password (it derives BOTH the Waku topic AND the AEAD payload key), so the
// URI carries everything a phone/peer needs to join and decrypt, exactly like the
// original qaku's password-in-URL. Accept a raw 64-hex secret OR this URI.
static const char* kShareScheme = "qaku://join?s=";
static std::string stripShareUri(const std::string& in){
    std::string s = in;
    if (s.rfind("qaku://", 0) == 0) { auto p = s.find("s="); if (p != std::string::npos) s = s.substr(p + 2); }
    return s;
}
static std::string trim(const std::string& s){ size_t a=s.find_first_not_of(" \t\r\n"); if (a==std::string::npos) return ""; size_t b=s.find_last_not_of(" \t\r\n"); return s.substr(a, b-a+1); }
static std::string lower(std::string s){ for (auto& c : s) c = (char)tolower((unsigned char)c); return s; }

// role of this device in a session's fold: "owner" | "admin" | "guest" | "new".
static std::string roleFor(const std::vector<qaku::Event>& log, const std::string& dev) {
    auto adm = qaku::admitEvents(log);
    if (!adm.isSession) return "new";
    if (adm.owner == dev) return "owner";
    for (auto& a : adm.admins) if (a == dev) return "admin";
    return "guest";
}

QakuCoreImpl::~QakuCoreImpl() { if (m_hubTimer) { m_hubTimer->stop(); m_hubTimer->deleteLater(); m_hubTimer = nullptr; } }

// ---- session registry ------------------------------------------------------
QakuCoreImpl::Session& QakuCoreImpl::cur() { return m_sessions[m_current]; }
const QakuCoreImpl::Session& QakuCoreImpl::cur() const {
    auto it = m_sessions.find(m_current);
    static const Session kEmpty{};
    return it == m_sessions.end() ? kEmpty : it->second;
}
QakuCoreImpl::Session* QakuCoreImpl::sessionForTopic(const std::string& t) {
    for (auto& kv : m_sessions) if (kv.second.haveKey && kv.second.topic == t) return &kv.second;
    return nullptr;
}
std::string QakuCoreImpl::newSessionId() {
    qaku::Bytes r(6); RAND_bytes(r.data(), 6); return "s" + qaku::toHex(r.data(), 6);
}
// Create an entry with a fresh random secret and make it the current session.
QakuCoreImpl::Session& QakuCoreImpl::newSessionEntry() {
    std::string id = newSessionId();
    Session& s = m_sessions[id];
    s.id = id;
    s.dir = m_dataDir.empty() ? std::string() : (m_dataDir + "/" + id);
    m_order.push_back(id);
    qaku::Bytes secret(32); RAND_bytes(secret.data(), 32);
    applySecret(s, secret, true);   // writes pair.key
    m_current = id;
    saveSessions();
    return s;
}
// On load: seed a single default session (env QAKU_SECRET or a fresh key). This
// is the in-place migration of the old single-session core into the map, and (with
// persistence) the first-run path that puts the default session on disk.
void QakuCoreImpl::loadOrCreateSecret() {
    Session& s = newSessionEntry();
    if (const char* e = std::getenv("QAKU_SECRET")) {
        try { applySecret(s, fromHex(e), true); } catch (...) {}
    }
}

// Load (or first-run generate + persist) this device's secp256k1 signing key. m_myAddress
// becomes the author identity on every event we write. Env QAKU_SIGN_KEY (64-hex) pins it
// for tests/hub. Key stored raw (32B) at <dataDir>/sign.key.
void QakuCoreImpl::loadOrCreateSignKey() {
    qaku::Bytes priv;
    if (const char* e = std::getenv("QAKU_SIGN_KEY")) { qaku::Bytes b = qaku::fromHex(e); if (b.size() == 32) priv = b; }
    if (priv.empty() && !m_dataDir.empty()) {
        std::ifstream f(m_dataDir + "/sign.key", std::ios::binary);
        if (f) { std::string s((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>()); if (s.size() == 32) priv.assign(s.begin(), s.end()); }
    }
    if (priv.size() == 32) m_signId = qaku::identityFromPriv(priv);
    if (!m_signId.valid) {
        m_signId = qaku::generateIdentity();
        if (!m_dataDir.empty() && m_signId.valid) {
            std::ofstream f(m_dataDir + "/sign.key", std::ios::binary | std::ios::trunc);
            if (f) f.write((const char*)m_signId.priv.data(), 32);
        }
    }
    m_myAddress = m_signId.valid ? m_signId.address : m_deviceId;
}

// --- on-disk persistence (mirrors KYM's per-budget layout) ------------------
// Writable data dir: env QAKU_CORE_DATA (hub/tests) else $HOME/.qaku-core. Each
// session lives in <root>/<id> (pair.key + log.json); the registry is
// <root>/sessions.json. Empty m_dataDir = no persistence (all writers guard on it).
void QakuCoreImpl::setupDataDir() {
    std::string dir;
    if (const char* d = std::getenv("QAKU_CORE_DATA")) dir = d;
    else if (const char* h = std::getenv("HOME")) dir = std::string(h) + "/.qaku-core";
    if (dir.empty()) return;
    m_dataDir = qaku::persist::ensureDir(dir) ? dir : std::string();
}

void QakuCoreImpl::savePersistedLog(Session& s) { qaku::persist::writeLog(s.dir, s.log); }

// Merge the on-disk log into s.log. Multi-instance safety: Basecamp can run more
// than one qaku_core instance behind a ui plugin (distinct instance ids) sharing
// the same data dir; merging disk in BEFORE we append means a stale in-memory
// instance can't clobber another instance's events. Dedup by id + HLC sort make
// the merge order-independent. No-op when not persisting.
void QakuCoreImpl::loadPersistedLog(Session& s) {
    if (s.dir.empty()) return;
    std::vector<Event> disk = qaku::persist::readLog(s.dir);
    if (disk.empty()) return;
    s.log = qaku::mergeEvents(s.log, disk);
    s.ids.clear();
    for (auto& e : s.log) {
        s.ids.insert(e.id);
        if (e.hlc.wall > s.wall) { s.wall = e.hlc.wall; s.ctr = e.hlc.ctr; }
    }
}

// Persist the registry: ids in display order + each session's current title
// (re-derived from its fold so it's always accurate) + the current selection.
void QakuCoreImpl::saveSessions() {
    if (m_dataDir.empty()) return;
    qaku::persist::Registry r;
    for (const auto& id : m_order) {
        auto it = m_sessions.find(id); if (it == m_sessions.end()) continue;
        const Session& s = it->second;
        std::string title;
        json cs = qaku::computeState(s.log);
        if (cs["session"].is_object()) title = cs["session"].value("title", "");
        r.sessions.push_back({ s.id, title });
    }
    r.current = m_current;
    qaku::persist::writeRegistry(m_dataDir, r);
}

// Load persisted sessions on start. For each registered id: read its pair.key
// (-> applySecret derives identity/topic/fingerprint) + its log.json. A session
// with a missing/corrupt key is skipped (can't derive a topic) - never fatal.
// Restores m_order + m_current. First run (no registry) -> create the default.
void QakuCoreImpl::loadSessions() {
    if (!m_dataDir.empty()) {
        qaku::persist::Registry r = qaku::persist::readRegistry(m_dataDir);
        for (const auto& e : r.sessions) {
            if (e.id.empty() || m_sessions.count(e.id)) continue;
            std::string dir = m_dataDir + "/" + e.id;
            qaku::Bytes secret = qaku::persist::readPairKey(dir);
            if (secret.size() != 32) continue;   // no usable key: skip this session
            Session& s = m_sessions[e.id];
            s.id = e.id;
            s.dir = dir;
            m_order.push_back(e.id);
            applySecret(s, secret, false);        // derive identity/topic (key already on disk)
            loadPersistedLog(s);
        }
        if (!r.current.empty() && m_sessions.count(r.current)) m_current = r.current;
    }
    if (m_current.empty() || !m_sessions.count(m_current)) m_current = m_order.empty() ? "" : m_order.front();
    // First run (or everything skipped): create + persist a fresh default session.
    if (m_sessions.empty()) loadOrCreateSecret();
    saveSessions();
}

void QakuCoreImpl::applySecret(Session& s, const qaku::Bytes& secret, bool persist) {
    s.identity = qaku::deriveIdentity(secret);   // .secret keeps the raw code so snapshot() can share it
    s.topic = qaku::topicFor(s.identity);
    s.fingerprint = s.identity.fingerprint;
    s.haveKey = true;
    s.subscribed = false;
    if (persist) qaku::persist::writePairKey(s.dir, secret);   // <dir>/pair.key (no-op if dir empty)
    // If delivery is already up, join this session's topic + seed its log. Else
    // the first snapshot()/hub tick bootstraps delivery and subscribes them all.
    if (m_nodeReady) { joinTransport(s); for (auto& e : s.log) sealAndSend(s, e); }
}

qaku::HLC QakuCoreImpl::nextHlc(Session& s) {
    long long t = nowMs();
    if (t > s.wall) { s.wall = t; s.ctr = 0; } else { s.ctr += 1; }
    return qaku::HLC{ s.wall, s.ctr, m_myAddress };   // author = our address (signEvent re-stamps it too)
}

void QakuCoreImpl::onContextReady() {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    setupDataDir();
    // Device id: env QAKU_DEVICE_ID (hub/tests) > persisted device.txt > the
    // default. Persisted so a setDeviceId rename survives restart. Env wins on
    // every launch when set.
    if (const char* d = std::getenv("QAKU_DEVICE_ID")) m_deviceId = d;
    else if (!m_dataDir.empty()) { std::string p = qaku::persist::readDeviceId(m_dataDir); if (!p.empty()) m_deviceId = p; }
    loadOrCreateSignKey();   // our secp256k1 author identity (m_myAddress) — before any fold/authoring
    if (!m_dataDir.empty()) { std::ifstream nf(m_dataDir + "/myname.txt"); if (nf) { std::getline(nf, m_myName); } }
    // Load persisted sessions (registry + each pair.key + log.json), or create a
    // fresh default session on first run. Replaces the old in-memory-only seed.
    loadSessions();
    loadUnpublished();   // restore the "queued" set so a not-yet-published question survives restart
    setStatus("Ready");
    bootstrapDelivery();
    // Headless hub self-drive: a QTimer on the event-loop thread (NEVER a
    // std::thread - the delivery async callbacks only dispatch on this thread, so
    // a worker-thread driver leaves createNode hanging). Armed by QAKU_HUB.
    if (std::getenv("QAKU_HUB")) {
        m_hubTimer = new QTimer();
        QObject::connect(m_hubTimer, &QTimer::timeout, [this]{ std::lock_guard<std::recursive_mutex> lk(m_mtx); if (!m_nodeReady) bootstrapDelivery(); else resync(); });
        m_hubTimer->start(15000);
    }
    publishState();
}

std::string QakuCoreImpl::setSecret(std::string secretHex) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (m_sessions.empty()) newSessionEntry();
    try { applySecret(cur(), fromHex(secretHex), true); } catch (const std::exception& e) { return std::string("{\"error\":\"") + e.what() + "\"}"; }
    publishState(); return snapshot();
}
std::string QakuCoreImpl::setDeviceId(std::string deviceId) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (!deviceId.empty()) { m_deviceId = deviceId; qaku::persist::writeDeviceId(m_dataDir, deviceId); }
    return snapshot();
}
std::string QakuCoreImpl::fingerprint() { std::lock_guard<std::recursive_mutex> lk(m_mtx); return cur().haveKey ? cur().fingerprint : ""; }
std::string QakuCoreImpl::status() { std::lock_guard<std::recursive_mutex> lk(m_mtx); return m_status; }

// The plain shareable URI for the current session (carries the secret).
std::string QakuCoreImpl::shareUri() {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (!cur().haveKey) return "";
    return std::string(kShareScheme) + hex(cur().identity.secret);
}
// Encode that URI as a QR matrix for the view's Canvas. MEDIUM ECC survives a
// phone camera at a screen angle. Returns {ok,n,cells,text}; the view paints
// black/white modules from cells[y*n+x] (the host qr core is unreachable, so the
// encoder is vendored into this core - see basecamp-qr-core-unreachable).
std::string QakuCoreImpl::shareQr() {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    json out;
    if (!cur().haveKey) { out["ok"] = false; out["error"] = "no session key yet"; return out.dump(); }
    const std::string uri = std::string(kShareScheme) + hex(cur().identity.secret);
    try {
        const qrcodegen::QrCode qr =
            qrcodegen::QrCode::encodeText(uri.c_str(), qrcodegen::QrCode::Ecc::MEDIUM);
        const int n = qr.getSize();
        json cells = json::array();
        for (int y = 0; y < n; ++y)
            for (int x = 0; x < n; ++x) cells.push_back(qr.getModule(x, y));
        out["ok"] = true;
        out["n"] = n;
        out["cells"] = std::move(cells);
        out["text"] = uri;
    } catch (const std::exception& e) {
        out["ok"] = false;
        out["error"] = std::string("qr encode failed: ") + e.what();
    }
    return out.dump();
}

void QakuCoreImpl::setStatus(const std::string& s) { m_status = s; emit statusChanged(s); }

void QakuCoreImpl::pushEvent(Session& s, Event e, bool broadcast) {
    // Sign our OWN events (broadcast) so they carry a verifiable secp256k1 author address
    // (parity with mobile). Received events (broadcast=false) keep their original signature.
    if (broadcast && m_signId.valid) qaku::signEvent(m_signId, e);
    // Merge any on-disk events written by a concurrent instance BEFORE appending
    // (see loadPersistedLog) so this write can't clobber theirs. No-op if not
    // persisting or nothing new on disk.
    loadPersistedLog(s);
    if (s.ids.count(e.id)) return;
    s.ids.insert(e.id);
    s.log = qaku::mergeEvents(s.log, { e });
    if (e.hlc.wall > s.wall) { s.wall = e.hlc.wall; s.ctr = e.hlc.ctr; }
    savePersistedLog(s);   // rewrite <dir>/log.json (small; off any IPC hot path)
    if (broadcast) {
        // Our own new event: mark "queued" (durable) BEFORE sending; sealAndSend clears it
        // once dispatched to the channel. If not connected yet it stays queued and the
        // node-up reseed / periodic resync re-sends (and clears) it.
        m_unpublished.insert(e.id); saveUnpublished();
        sealAndSend(s, e);
    }
    publishState();
}

void QakuCoreImpl::publishState() {
    // Current session detail (the main pane renders these top-level fields).
    json s = qaku::computeState(cur().log);
    // Tag each question with its local send state so the view can show a "queued" badge on
    // our own not-yet-published questions (evId = the source event id; see qaku_engine).
    if (s.contains("questions") && s["questions"].is_array())
        for (auto& q : s["questions"]) q["queued"] = m_unpublished.count(q.value("evId", "")) > 0;
    s["status"] = m_status;
    s["fingerprint"] = cur().haveKey ? cur().fingerprint : "";
    // The raw session secret as hex: THIS is the pairing code, meant to be shared
    // so a phone/peer can join the same derived topic (joinSession / session.start).
    s["secret"] = cur().haveKey ? hex(cur().identity.secret) : "";
    // The full shareable URI (secret-in-URL, like the original qaku's password-in-URL).
    s["shareUri"] = cur().haveKey ? (std::string(kShareScheme) + hex(cur().identity.secret)) : "";
    s["deviceId"] = m_myAddress;   // the copyable IDENTITY is now our signing address (for admin lists)
    s["address"] = m_myAddress;
    s["myName"] = m_myName;
    s["currentId"] = m_current;
    s["role"] = roleFor(cur().log, m_myAddress);
    // Transport diagnostics: the content topic we publish/subscribe on, and the
    // autoshard the fleet routes it to. Mobile shows the SAME two for its session;
    // if the shard differs the two nodes are on different pubsub topics and can
    // never meet even though both say "Connected".
    s["contentTopic"] = cur().haveKey ? cur().topic : "";
    s["shard"] = cur().haveKey ? qaku::shardFor(cur().topic) : -1;
    // The session LIST (the sidebar renders this). Skip an unused default slot
    // (a keyed session with no session.create yet).
    json sessions = json::array();
    for (const auto& id : m_order) {
        auto it = m_sessions.find(id); if (it == m_sessions.end()) continue;
        const Session& e = it->second;
        if (e.log.empty()) continue;
        json cs = qaku::computeState(e.log);
        std::string title;
        bool open = true;
        if (cs["session"].is_object()) { title = cs["session"].value("title", ""); open = cs["session"].value("enabled", true); }
        sessions.push_back({
            {"id", e.id},
            {"title", title.empty() ? std::string("Untitled Q&A") : title},
            {"fingerprint", e.fingerprint},
            {"role", roleFor(e.log, m_myAddress)},
            {"questions", cs.value("questionCount", (json::number_integer_t)0)},
            {"open", open},
            {"unread", 0},
            {"current", e.id == m_current}
        });
    }
    s["sessions"] = sessions;
    s["sync"] = { {"rxRaw", m_rxRaw}, {"rxSeen", m_rxSeen}, {"rxOpened", m_rxOpened},
                  {"rxOpenFail", m_rxOpenFail}, {"rxNew", m_rxNew}, {"rxDup", m_rxDup}, {"txTotal", m_txTotal} };
    m_snapshot = s.dump();
    emit stateChanged(m_snapshot);
}

std::string QakuCoreImpl::snapshot() {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    // Lazily start delivery on the first read after the view attaches.
    bool anyKey = false; for (auto& kv : m_sessions) if (kv.second.haveKey) { anyKey = true; break; }
    if (anyKey && !m_nodeReady) bootstrapDelivery();
    publishState();
    return m_snapshot;
}
std::string QakuCoreImpl::resync() {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    // PERIODIC re-broadcast (hub tick): rate-limited to once per 60s. Re-broadcasting
    // the whole log every 15s from every peer amplified into a shard flood. SYNC_REQ
    // (on-demand, below) covers a joining peer's catch-up; this is just a slow safety
    // net for peers that missed live traffic.
    if (m_nodeReady && nowMs() - m_lastPeriodicReserveMs >= 60000) {
        m_lastPeriodicReserveMs = nowMs();
        for (auto& kv : m_sessions) if (kv.second.haveKey) for (auto& e : kv.second.log) sealAndSend(kv.second, e);
    }
    publishState(); return m_snapshot;
}

// --- admission helper: is this device owner/admin in the CURRENT session? ---
std::string QakuCoreImpl::adminGuard() {
    json s = qaku::computeState(cur().log);
    if (!s.value("isSession", false)) return "";
    for (auto& a : s["admins"]) if (a == m_myAddress) return "";
    return "{\"error\":\"not an owner/admin\"}";
}

static Event mkEvent(const char* type, const qaku::HLC& hlc, json payload) {
    Event e; e.v = 1; e.type = type; e.hlc = hlc; e.dev = hlc.dev; e.payload = std::move(payload);
    qaku::Bytes r(16); RAND_bytes(r.data(), 16);
    r[6] = (r[6] & 0x0f) | 0x40; r[8] = (r[8] & 0x3f) | 0x80;
    std::string h = qaku::toHex(r.data(), 16);
    e.id = h.substr(0,8)+"-"+h.substr(8,4)+"-"+h.substr(12,4)+"-"+h.substr(16,4)+"-"+h.substr(20);
    return e;
}

// --- multi-session lifecycle ---
std::string QakuCoreImpl::createSession(std::string title, std::string description) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    // Reuse an empty current slot (the migrated default, or a freshly created one);
    // otherwise mint a NEW session with a fresh secret and switch to it.
    if (m_sessions.empty() || !cur().haveKey || !cur().log.empty()) newSessionEntry();
    if (title.empty()) title = "Untitled Q&A";
    Event e = mkEvent(qaku::T::SESSION_CREATE, nextHlc(cur()), {{"sessionId", cur().fingerprint}, {"title", title}, {"description", description}});
    pushEvent(cur(), e, true);
    emitProfileSet(cur());   // announce our display name on this session's topic
    saveSessions();   // capture the session title in the registry
    return snapshot();
}
// Author our display name (if set) into a keyed session, so peers render a pseudonym
// instead of the raw address. Self-scoped (names our OWN address) → safe for anyone.
void QakuCoreImpl::emitProfileSet(Session& s) {
    if (m_myName.empty() || !s.haveKey) return;
    pushEvent(s, mkEvent(qaku::T::PROFILE_SET, nextHlc(s), {{"name", m_myName}}), true);
}
std::string QakuCoreImpl::setName(std::string name) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (name.size() > 40) name = name.substr(0, 40);
    m_myName = name;
    if (!m_dataDir.empty()) { std::ofstream f(m_dataDir + "/myname.txt", std::ios::trunc); if (f) f << m_myName; }
    for (auto& kv : m_sessions) emitProfileSet(kv.second);   // re-announce on every joined Q&A
    return snapshot();
}
std::string QakuCoreImpl::joinSession(std::string secretHex) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    // Accept a raw 64-hex secret OR a qaku://join?s=<hex> URI (from a scanned QR).
    std::string code = lower(trim(stripShareUri(trim(secretHex))));
    if (!isHex64(code)) return "{\"error\":\"secret must be 64 hex characters\"}";
    qaku::Bytes s = fromHex(code);
    std::string topic;
    try { topic = qaku::topicFor(qaku::deriveIdentity(s)); } catch (...) { return "{\"error\":\"invalid secret\"}"; }
    // Already hold this session? Switch instead of duplicating.
    for (auto& kv : m_sessions) if (kv.second.haveKey && kv.second.topic == topic) { m_current = kv.first; saveSessions(); return snapshot(); }
    // Reuse an empty current slot, else a fresh entry, keyed to the shared secret.
    Session* target = (!m_sessions.empty() && cur().haveKey && cur().log.empty()) ? &cur() : &newSessionEntry();
    applySecret(*target, s, true);   // writes the joined session's pair.key
    m_current = target->id;
    emitProfileSet(*target);   // announce our display name on the joined topic
    saveSessions();
    return snapshot();
}
std::string QakuCoreImpl::switchSession(std::string id) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (!m_sessions.count(id)) return "{\"error\":\"no such session\"}";
    m_current = id; saveSessions(); return snapshot();
}
std::string QakuCoreImpl::deleteSession(std::string id) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    auto it = m_sessions.find(id);
    if (it == m_sessions.end()) return "{\"error\":\"no such session\"}";
    std::string dir = it->second.dir;
    m_sessions.erase(it);
    m_order.erase(std::remove(m_order.begin(), m_order.end(), id), m_order.end());
    if (m_order.empty()) { newSessionEntry(); }   // keep at least one slot
    else if (m_current == id) m_current = m_order.front();
    qaku::persist::removeSessionDir(dir);          // wipe its on-disk log + key
    saveSessions();
    return snapshot();
}
std::string QakuCoreImpl::listSessions() { std::lock_guard<std::recursive_mutex> lk(m_mtx); publishState(); return m_snapshot; }

// --- session config ---
std::string QakuCoreImpl::setConfig(std::string patchJson) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    std::string g = adminGuard(); if (!g.empty()) return g;
    json p; try { p = json::parse(patchJson); } catch (...) { return "{\"error\":\"bad patch json\"}"; }
    pushEvent(cur(), mkEvent(qaku::T::SESSION_CONFIG, nextHlc(cur()), p), true);
    saveSessions();   // a config patch may rename the session; refresh the registry title
    return snapshot();
}
std::string QakuCoreImpl::addAdmin(std::string memberId, std::string name) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    pushEvent(cur(), mkEvent(qaku::T::ADMIN_ADD, nextHlc(cur()), {{"memberId", memberId}, {"name", name}}), true); return snapshot();
}
std::string QakuCoreImpl::removeAdmin(std::string memberId) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    pushEvent(cur(), mkEvent(qaku::T::ADMIN_REMOVE, nextHlc(cur()), {{"memberId", memberId}}), true); return snapshot();
}

// --- questions ---
std::string QakuCoreImpl::addQuestion(std::string content) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    qaku::Bytes r(6); RAND_bytes(r.data(), 6);
    pushEvent(cur(), mkEvent(qaku::T::QUESTION_ADD, nextHlc(cur()), {{"questionId", qaku::toHex(r.data(),6)}, {"content", content}}), true); return snapshot();
}
std::string QakuCoreImpl::editQuestion(std::string questionId, std::string content) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    pushEvent(cur(), mkEvent(qaku::T::QUESTION_EDIT, nextHlc(cur()), {{"questionId", questionId}, {"content", content}}), true); return snapshot();
}
std::string QakuCoreImpl::deleteQuestion(std::string questionId) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    pushEvent(cur(), mkEvent(qaku::T::QUESTION_DELETE, nextHlc(cur()), {{"questionId", questionId}}), true); return snapshot();
}
std::string QakuCoreImpl::upvoteQuestion(std::string questionId, std::string up) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    pushEvent(cur(), mkEvent(qaku::T::UPVOTE, nextHlc(cur()), {{"targetType","question"},{"targetId", questionId},{"up", up!="false"},{"voter", m_myAddress}}), true); return snapshot();
}
std::string QakuCoreImpl::upvoteAnswer(std::string answerId, std::string up) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    pushEvent(cur(), mkEvent(qaku::T::UPVOTE, nextHlc(cur()), {{"targetType","answer"},{"targetId", answerId},{"up", up!="false"},{"voter", m_myAddress}}), true); return snapshot();
}

// --- answers + moderation ---
std::string QakuCoreImpl::postAnswer(std::string questionId, std::string content) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    qaku::Bytes r(6); RAND_bytes(r.data(), 6);
    pushEvent(cur(), mkEvent(qaku::T::ANSWER_POST, nextHlc(cur()), {{"answerId", qaku::toHex(r.data(),6)}, {"questionId", questionId}, {"content", content}}), true); return snapshot();
}
std::string QakuCoreImpl::acceptAnswer(std::string questionId, std::string answerId, std::string accepted) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    pushEvent(cur(), mkEvent(qaku::T::ANSWER_ACCEPT, nextHlc(cur()), {{"questionId", questionId}, {"answerId", answerId}, {"accepted", accepted!="false"}}), true); return snapshot();
}
std::string QakuCoreImpl::moderate(std::string questionId, std::string hidden) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    pushEvent(cur(), mkEvent(qaku::T::MODERATE, nextHlc(cur()), {{"questionId", questionId}, {"hidden", hidden!="false"}}), true); return snapshot();
}

// --- polls ---
std::string QakuCoreImpl::createPoll(std::string question, std::string optionsJson, std::string active) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    json opts; try { opts = json::parse(optionsJson); } catch (...) { return "{\"error\":\"bad options json\"}"; }
    qaku::Bytes r(6); RAND_bytes(r.data(), 6);
    pushEvent(cur(), mkEvent(qaku::T::POLL_CREATE, nextHlc(cur()), {{"pollId", qaku::toHex(r.data(),6)}, {"question", question}, {"options", opts}, {"active", active!="false"}}), true); return snapshot();
}
std::string QakuCoreImpl::setPollActive(std::string pollId, std::string active) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    pushEvent(cur(), mkEvent(qaku::T::POLL_SET_ACTIVE, nextHlc(cur()), {{"pollId", pollId}, {"active", active!="false"}}), true); return snapshot();
}
std::string QakuCoreImpl::votePoll(std::string pollId, std::string optionId) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    pushEvent(cur(), mkEvent(qaku::T::POLL_VOTE, nextHlc(cur()), {{"pollId", pollId}, {"optionId", optionId}, {"voter", m_myAddress}}), true); return snapshot();
}

// --- sync / transport ---
std::string QakuCoreImpl::ingestSealed(std::string sealedHex) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (!cur().haveKey) return "{\"error\":\"no session key\"}";
    try { qaku::Bytes s = fromHex(sealedHex); openAndPush(cur(), std::string(s.begin(), s.end())); }
    catch (const std::exception& e) { return std::string("{\"error\":\"") + e.what() + "\"}"; }
    return snapshot();
}

void QakuCoreImpl::bootstrapDelivery() {
    bool anyKey = false; for (auto& kv : m_sessions) if (kv.second.haveKey) { anyKey = true; break; }
    if (!anyKey || m_nodeReady || m_deliveryStarting) return;
    m_deliveryStarting = true;
    // Register the receive handlers BEFORE createNode. BOTH the raw relay path and
    // the SDS reliable-channel path are registered; only the transport we actually
    // joined delivers. Each extracts the base64 payload, routes by content topic.
    auto toWire = [](const LogosMap& v) -> std::string {
        if (v.is_string()) return v.get<std::string>();
        if (v.is_array()) { std::string s; s.reserve(v.size()); for (const auto& c : v) if (c.is_number_integer()) s.push_back((char)c.get<int>()); return s; }
        if (v.is_object() && v.contains("_bytes") && v["_bytes"].is_string()) return v["_bytes"].get<std::string>();
        return std::string();
    };
    // The SDS reliable-channel path (onChannelMessageReceived) is AUTHORITATIVE:
    // it hands us the UNWRAPPED payload. The raw relay path (onMessageReceived)
    // fires too, but for a channel message its payload is the SDS wire FRAME (~19KB
    // of causal history/bloom), which never AEAD-opens. Ingesting it only inflated
    // rxOpenFail with benign noise. So relay ingestion is best-effort + SILENT on
    // failure (channelActive=false); the channel path counts a real rxOpenFail.
    modules().delivery_module.onMessageReceived(
        [this, toWire](const std::string&, const std::string& contentTopic, const LogosMap& payload, int64_t) {
            std::string p = toWire(payload);
            if (p.empty() && payload.is_object() && payload.contains("payload")) p = toWire(payload["payload"]);
            if (!p.empty()) ingestPayload(contentTopic, p, /*channelPath=*/false);
        });
    modules().delivery_module.onChannelMessageReceived(
        [this, toWire](const std::string& channelId, const std::string&, const LogosMap& payload, int64_t) {
            std::string p = toWire(payload);
            if (p.empty() && payload.is_object() && payload.contains("payload")) p = toWire(payload["payload"]);
            if (!p.empty()) ingestPayload(channelId, p, /*channelPath=*/true);
        });
    setStatus("Connecting...");
    // RELAY node with the logos.test fleet entry nodes PINNED. Bare
    // {mode:Core,preset:...} gives ZERO bootstrap nodes ("seed node, no bootstrap") —
    // the node drifts off the fleet, joins no shard mesh, and logs "No peers for topic"/
    // "NoPeersToPublish": it prints "Connected" (start() ok) but publishes/receives
    // NOTHING. The phone pins these same 6 nodes and meshes; the desktop must too or the
    // two never meet.
    //
    // FLEET = logos.test (cluster 2). We were on logos.dev, but logos.dev migrated to
    // CLUSTER 3 while liblogosdelivery's baked preset still maps logos.dev→cluster 2 — so
    // a fresh node dialed the now-cluster-3 boxes with cluster-2 config and never meshed.
    // logos.test stays cluster 2, keeping qaku's shard (sha256("qaku"+"1") % 8 = 0) valid.
    // Keep preset + entryNodes in lockstep with mobile (loam-transport.ts ENTRY_NODES).
    LogosMap cfg = {
        {"logLevel", "INFO"}, {"mode", "Core"}, {"preset", "logos.test"}, {"relay", true},
        {"entryNodes", LogosMap::array({
            "/dns4/node-01.do-ams3.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmQ9X2xDfPG3uL77V9piYDhjq14JhKCtcmNYsTMKNqrKCj",
            "/dns4/node-02.do-ams3.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmB8NYprrfQrgWVzsJtYWkfjsXbmJEGNMG6othXsQ53BwG",
            "/dns4/node-01.gc-us-central1-a.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmF8WtwGPmeGHgYAX2277jHgy5cW9F7zsB8EqUjBZQAZQ3",
            "/dns4/node-02.gc-us-central1-a.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmUuXhUW9bdJpzN1kfDziFiUZo4bszTk66cvr7uuyCHXR7",
            "/dns4/node-01.ac-cn-hongkong-c.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmL3oU95jh1BZHozn3uNhx8HEneirgr8M1jEAapzXGDqRF",
            "/dns4/node-02.ac-cn-hongkong-c.logos.test.status.im/tcp/30303/p2p/16Uiu2HAm28CoBZjpyxsanC8tQpbvZ7bZJnVYuB1EgFzb571qpWsV",
        })},
    };
    if (const char* ov = std::getenv("QAKU_DELIVERY_CFG")) {
        auto j = json::parse(ov, nullptr, false);
        if (j.is_object()) for (auto it = j.begin(); it != j.end(); ++it) cfg[it.key()] = it.value();
    }
    std::string cfgStr = cfg.dump();
    fprintf(stderr, "QAKU bootstrapDelivery cfg=%s\n", cfgStr.c_str());
    auto startNode = [this, cfgStr]() {
        modules().delivery_module.createNodeAsync(cfgStr, [this](StdLogosResult r) {
            if (!r.success) { m_deliveryStarting = false; setStatus("Delivery error (createNode): " + r.error); return; }
            modules().delivery_module.startAsync([this](StdLogosResult r2) {
                if (!r2.success) { m_deliveryStarting = false; setStatus("Delivery error (start): " + r2.error); return; }
                std::lock_guard<std::recursive_mutex> lk(m_mtx);
                m_nodeReady = true;
                joinAllTransports();
                setStatus("Connected - " + std::to_string(m_order.size()) + " session(s)");
                // Seed every session's log for peers already listening. The logos.dev
                // relay mesh on our shard is sparse and one-shot publishes get dropped,
                // so re-broadcast the whole log a FEW times over the first ~12s (KYM's
                // seed-burst fix). Idempotent — peers dedup by id. Timers fire on the Qt
                // thread; joinTransport must have run first (subscribe+channelCreate).
                // Seed the log ONCE on node-up (was a 3x burst — an amplifier). A
                // joining peer pulls reliably via SYNC_REQ, so a single seed is enough;
                // the periodic resync (rate-limited to 60s) is the slow safety net.
                for (auto& kv : m_sessions) if (kv.second.haveKey) for (auto& e : kv.second.log) sealAndSend(kv.second, e);
                publishState();
            });
        });
    };
    if (std::getenv("QAKU_HUB")) QTimer::singleShot(1500, startNode);
    else startNode();
}

void QakuCoreImpl::joinAllTransports() {
    for (auto& kv : m_sessions) if (kv.second.haveKey) joinTransport(kv.second);
}
void QakuCoreImpl::joinTransport(Session& s) {
    if (!s.haveKey || !m_nodeReady || s.subscribed) return;
    // SDS Reliable Channels: subscribe THEN channelCreate (channelCreate does not
    // itself subscribe the content topic; the recv service only emits for
    // subscribed topics). channelId == contentTopic == the session's derived topic.
    modules().delivery_module.subscribeAsync(s.topic, [](StdLogosResult){});
    modules().delivery_module.channelCreateAsync(s.topic, s.topic, m_deviceId, [](StdLogosResult){});
    s.subscribed = true;
}

void QakuCoreImpl::sealAndSend(Session& s, const Event& e) {
    if (!s.haveKey || !m_nodeReady) return;   // not connected → our own event stays "queued"
    std::string plain = qaku::encodeEvent(e);
    qaku::Bytes sealed = qaku::seal(s.identity, qaku::Bytes(plain.begin(), plain.end()), s.topic);
    bool dispatched = deliverySend(s.topic, b64(sealed));
    // Handed to the reliable channel while connected → clear "queued" (only affects our own
    // authored events; received/reseeded ids aren't in the set). All synchronous on the Qt
    // thread — no cross-thread callback needed.
    if (dispatched && m_unpublished.erase(e.id)) saveUnpublished();
    m_txTotal++;
}

bool QakuCoreImpl::deliverySend(const std::string& topic, const std::string& sealedB64) {
    if (!m_nodeReady) return false;
    // SINGLE-base64, matching KYM's proven kym_core exactly. We hand the transport
    // the base64 TEXT as bytes (bytesPayload); delivery_module base64-encodes that
    // once more on the wire, so a peer decodes ONCE to reach our base64 text and a
    // SECOND time to reach the sealed bytes — the phone's payloadCandidates does
    // exactly those 1–2 peels. The OLD code added an extra b64s() layer here, so a
    // desktop/hub message needed THREE peels and the phone could NEVER decode it
    // (desktop->mobile was dead; desktop<->desktop only worked because both sides
    // shared the extra layer). Robust to either IPC shape: JSON byte ARRAY (repr 1)
    // or string (repr 2); probe once, cache m_sendRepr.
    auto attempt = [&](int repr) -> bool {
        try {
            LogosMap p = (repr == 1) ? bytesPayload(sealedB64) : LogosMap(sealedB64);
            modules().delivery_module.channelSendAsync(topic, p, [](StdLogosResult){});
            return true;
        } catch (...) { return false; }
    };
    if (m_sendRepr == 1 || m_sendRepr == 2) { if (attempt(m_sendRepr)) return true; m_sendRepr = 0; }
    if (attempt(1)) { m_sendRepr = 1; return true; }
    if (attempt(2)) { m_sendRepr = 2; return true; }
    fprintf(stderr, "QAKUTX deliverySend: no working payload representation\n");
    return false;
}

// Persist / restore the "queued" (unpublished) id set. Global (event ids are UUIDs, unique
// across sessions). Best-effort: a missing/corrupt file yields an empty set.
void QakuCoreImpl::saveUnpublished() {
    if (m_dataDir.empty()) return;
    json a = json::array(); for (const auto& id : m_unpublished) a.push_back(id);
    std::ofstream f(m_dataDir + "/unpublished.json", std::ios::trunc); if (f) f << a.dump();
}
void QakuCoreImpl::loadUnpublished() {
    if (m_dataDir.empty()) return;
    std::ifstream f(m_dataDir + "/unpublished.json"); if (!f) return;
    try { json a = json::parse(std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>()));
          if (a.is_array()) { m_unpublished.clear(); for (auto& x : a) if (x.is_string()) m_unpublished.insert(x.get<std::string>()); }
    } catch (...) { /* ignore */ }
}

// AEAD-open one sealed byte-string with a session's key, then dispatch on the
// envelope type: an EVENT folds into the log; a SYNC_REQ (a peer that just joined
// asking for state) makes us re-serve our whole log so they catch up. Returns true
// iff the bytes decrypted with this session's key (so ingestPayload stops probing).
bool QakuCoreImpl::openAndPush(Session& s, const std::string& sealed) {
    std::string plain;
    try {
        qaku::Bytes bs(sealed.begin(), sealed.end());
        qaku::Bytes pt = qaku::open(s.identity, bs, s.topic);
        plain = std::string(pt.begin(), pt.end());
    } catch (const std::exception&) { return false; }
    m_rxOpened++;
    try {
        json o = json::parse(plain);
        const std::string type = o.value("type", "");
        if (type == "SYNC_REQ") {
            // Re-serve the whole log (idempotent — peers dedup by id). Ignore our own
            // request echoed back. Debounced to 3s so a reconnecting peer spamming
            // SYNC_REQ can't restack full re-serves into a flood, while still being
            // responsive for a genuine join.
            if (o.value("from", "") != m_deviceId && nowMs() - m_lastSyncReserveMs >= 3000) {
                m_lastSyncReserveMs = nowMs();
                for (auto& e : s.log) sealAndSend(s, e);
            }
            return true;
        }
        if (type == "EVENT" && o.contains("event")) {
            Event e = qaku::eventFromJson(o["event"]);
            if (s.ids.count(e.id)) { m_rxDup++; return true; }
            m_rxNew++;
            pushEvent(s, e, false);
        }
    } catch (const std::exception&) { /* opened but not a valid envelope — still ours */ }
    return true;
}

void QakuCoreImpl::ingestPayload(const std::string& contentTopic, const std::string& payloadB64, bool channelPath) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    m_rxRaw++;
    // Route by content topic to the session that owns it (each Q&A = one topic).
    Session* sp = sessionForTopic(contentTopic);
    if (!sp) return;   // a message on a topic we don't hold (stray shard traffic)
    // Only the channel path counts toward rxSeen/rxOpenFail — the raw relay path
    // carries SDS-framed duplicates that never open (benign, not a real failure).
    if (channelPath) m_rxSeen++;
    // The wire payload is base64 text; a peer may single- OR double-encode. Try
    // the double-peel first (our + the phone's convention), then a single peel.
    std::string once = b64decode(payloadB64);
    if (openAndPush(*sp, b64decode(once))) { if (channelPath) fprintf(stderr, "QAKURX ingest OK double topic=%s\n", contentTopic.c_str()); return; }
    if (openAndPush(*sp, once))            { if (channelPath) fprintf(stderr, "QAKURX ingest OK single topic=%s\n", contentTopic.c_str()); return; }
    if (channelPath) {   // silent on the relay path (SDS-frame noise)
        fprintf(stderr, "QAKURX ingest OPENFAIL topic=%s plen=%zu (double+single both failed)\n", contentTopic.c_str(), payloadB64.size());
        m_rxOpenFail++;
    }
}
