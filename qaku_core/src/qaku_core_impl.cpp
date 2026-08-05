// QakuCoreImpl implementation. The engine/crypto/wire are the std-only headers
// (qaku_engine.hpp etc., byte-parity with the JS reference). This file wires the
// mutation API + the delivery_module transport (SDS Reliable Channels).
//
// Delivery caller names below follow the documented std delivery API (createNode
// /subscribe/channelCreate/channelSend + onMessageReceived/onChannelMessage-
// Received). Re-point them at the exact generated dependency-caller symbols of
// the delivery_module rev you pin in flake.nix. Every delivery call is async /
// fire-and-forget (a synchronous send on the event-loop thread freezes the
// module on the IPC timeout).
#include "qaku_core_impl.h"
#include "logos_sdk.h"   // umbrella: LogosModules + LogosMap(nlohmann::json) + StdLogosResult
#include <QTimer>
#include <chrono>
#include <cstdio>
#include <cstdlib>

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

QakuCoreImpl::~QakuCoreImpl() { if (m_hubTimer) { m_hubTimer->stop(); m_hubTimer->deleteLater(); m_hubTimer = nullptr; } }

qaku::HLC QakuCoreImpl::nextHlc() {
    long long t = nowMs();
    if (t > m_wall) { m_wall = t; m_ctr = 0; } else { m_ctr += 1; }
    return qaku::HLC{ m_wall, m_ctr, m_deviceId };
}

void QakuCoreImpl::onContextReady() {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (const char* d = std::getenv("QAKU_DEVICE_ID")) m_deviceId = d;
    loadOrCreateSecret();
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

void QakuCoreImpl::loadOrCreateSecret() {
    // env QAKU_SECRET (64 hex) > generated. A real build also persists to
    // <root>/pair.key and reloads (see KYM loadOrCreateSecret).
    if (const char* s = std::getenv("QAKU_SECRET")) { applySecret(fromHex(s), false); return; }
    qaku::Bytes secret(32); RAND_bytes(secret.data(), 32); applySecret(secret, true);
}

void QakuCoreImpl::applySecret(const qaku::Bytes& secret, bool /*persist*/) {
    m_secret = secret;                       // keep the raw code so snapshot() can share it
    m_id = qaku::deriveIdentity(secret);
    m_topic = qaku::topicFor(m_id);
    m_haveKey = true;
    m_subscribed = false;
}

std::string QakuCoreImpl::setSecret(std::string secretHex) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    try { applySecret(fromHex(secretHex), true); } catch (const std::exception& e) { return std::string("{\"error\":\"") + e.what() + "\"}"; }
    joinTransport(); publishState(); return snapshot();
}
std::string QakuCoreImpl::setDeviceId(std::string deviceId) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); if (!deviceId.empty()) m_deviceId = deviceId; return snapshot();
}
std::string QakuCoreImpl::fingerprint() { std::lock_guard<std::recursive_mutex> lk(m_mtx); return m_haveKey ? m_id.fingerprint : ""; }
std::string QakuCoreImpl::status() { std::lock_guard<std::recursive_mutex> lk(m_mtx); return m_status; }

void QakuCoreImpl::setStatus(const std::string& s) { m_status = s; emit statusChanged(s); }

void QakuCoreImpl::pushEvent(const Event& e, bool broadcast) {
    if (m_ids.count(e.id)) return;
    m_ids.insert(e.id);
    m_log = qaku::mergeEvents(m_log, { e });
    if (e.hlc.wall > m_wall) { m_wall = e.hlc.wall; m_ctr = e.hlc.ctr; }
    if (broadcast) sealAndSend(e);
    publishState();
}

void QakuCoreImpl::publishState() {
    json s = qaku::computeState(m_log);
    s["status"] = m_status;
    s["fingerprint"] = m_haveKey ? m_id.fingerprint : "";
    // The raw session secret as hex: THIS is the pairing code, meant to be shared
    // so a phone/peer can join the same derived topic (session.start(fromHex)).
    s["secret"] = m_haveKey ? hex(m_secret) : "";
    s["deviceId"] = m_deviceId;
    s["sync"] = { {"rxRaw", m_rxRaw}, {"rxSeen", m_rxSeen}, {"rxOpened", m_rxOpened},
                  {"rxOpenFail", m_rxOpenFail}, {"rxNew", m_rxNew}, {"rxDup", m_rxDup}, {"txTotal", m_txTotal} };
    m_snapshot = s.dump();
    emit stateChanged(m_snapshot);
}

std::string QakuCoreImpl::snapshot() { std::lock_guard<std::recursive_mutex> lk(m_mtx); publishState(); return m_snapshot; }
std::string QakuCoreImpl::resync() { std::lock_guard<std::recursive_mutex> lk(m_mtx); if (m_nodeReady) { for (auto& e : m_log) sealAndSend(e); } publishState(); return m_snapshot; }

// --- admission helper: is this device owner/admin in the current fold? ---
std::string QakuCoreImpl::adminGuard() {
    json s = qaku::computeState(m_log);
    if (!s.value("isSession", false)) return "";
    for (auto& a : s["admins"]) if (a == m_deviceId) return "";
    return "{\"error\":\"not an owner/admin\"}";
}

static Event mkEvent(const char* type, const qaku::HLC& hlc, json payload) {
    Event e; e.v = 1; e.type = type; e.hlc = hlc; e.dev = hlc.dev; e.payload = std::move(payload);
    // id = a UUIDv4-ish; a real build uses a proper UUID source.
    qaku::Bytes r(16); RAND_bytes(r.data(), 16);
    r[6] = (r[6] & 0x0f) | 0x40; r[8] = (r[8] & 0x3f) | 0x80;
    std::string h = qaku::toHex(r.data(), 16);
    e.id = h.substr(0,8)+"-"+h.substr(8,4)+"-"+h.substr(12,4)+"-"+h.substr(16,4)+"-"+h.substr(20);
    return e;
}

// --- session ---
std::string QakuCoreImpl::createSession(std::string title, std::string description) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    if (!m_haveKey) loadOrCreateSecret();
    Event e = mkEvent(qaku::T::SESSION_CREATE, nextHlc(), {{"sessionId", m_id.fingerprint}, {"title", title}, {"description", description}});
    pushEvent(e, true); return snapshot();
}
std::string QakuCoreImpl::setConfig(std::string patchJson) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    std::string g = adminGuard(); if (!g.empty()) return g;
    json p; try { p = json::parse(patchJson); } catch (...) { return "{\"error\":\"bad patch json\"}"; }
    pushEvent(mkEvent(qaku::T::SESSION_CONFIG, nextHlc(), p), true); return snapshot();
}
std::string QakuCoreImpl::addAdmin(std::string memberId, std::string name) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    pushEvent(mkEvent(qaku::T::ADMIN_ADD, nextHlc(), {{"memberId", memberId}, {"name", name}}), true); return snapshot();
}
std::string QakuCoreImpl::removeAdmin(std::string memberId) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    pushEvent(mkEvent(qaku::T::ADMIN_REMOVE, nextHlc(), {{"memberId", memberId}}), true); return snapshot();
}

// --- questions ---
std::string QakuCoreImpl::addQuestion(std::string content) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    qaku::Bytes r(6); RAND_bytes(r.data(), 6);
    pushEvent(mkEvent(qaku::T::QUESTION_ADD, nextHlc(), {{"questionId", qaku::toHex(r.data(),6)}, {"content", content}}), true); return snapshot();
}
std::string QakuCoreImpl::editQuestion(std::string questionId, std::string content) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    pushEvent(mkEvent(qaku::T::QUESTION_EDIT, nextHlc(), {{"questionId", questionId}, {"content", content}}), true); return snapshot();
}
std::string QakuCoreImpl::deleteQuestion(std::string questionId) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    pushEvent(mkEvent(qaku::T::QUESTION_DELETE, nextHlc(), {{"questionId", questionId}}), true); return snapshot();
}
std::string QakuCoreImpl::upvoteQuestion(std::string questionId, std::string up) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    pushEvent(mkEvent(qaku::T::UPVOTE, nextHlc(), {{"targetType","question"},{"targetId", questionId},{"up", up!="false"},{"voter", m_deviceId}}), true); return snapshot();
}
std::string QakuCoreImpl::upvoteAnswer(std::string answerId, std::string up) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    pushEvent(mkEvent(qaku::T::UPVOTE, nextHlc(), {{"targetType","answer"},{"targetId", answerId},{"up", up!="false"},{"voter", m_deviceId}}), true); return snapshot();
}

// --- answers + moderation ---
std::string QakuCoreImpl::postAnswer(std::string questionId, std::string content) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    qaku::Bytes r(6); RAND_bytes(r.data(), 6);
    pushEvent(mkEvent(qaku::T::ANSWER_POST, nextHlc(), {{"answerId", qaku::toHex(r.data(),6)}, {"questionId", questionId}, {"content", content}}), true); return snapshot();
}
std::string QakuCoreImpl::acceptAnswer(std::string questionId, std::string answerId, std::string accepted) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    pushEvent(mkEvent(qaku::T::ANSWER_ACCEPT, nextHlc(), {{"questionId", questionId}, {"answerId", answerId}, {"accepted", accepted!="false"}}), true); return snapshot();
}
std::string QakuCoreImpl::moderate(std::string questionId, std::string hidden) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    pushEvent(mkEvent(qaku::T::MODERATE, nextHlc(), {{"questionId", questionId}, {"hidden", hidden!="false"}}), true); return snapshot();
}

// --- polls ---
std::string QakuCoreImpl::createPoll(std::string question, std::string optionsJson, std::string active) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    json opts; try { opts = json::parse(optionsJson); } catch (...) { return "{\"error\":\"bad options json\"}"; }
    qaku::Bytes r(6); RAND_bytes(r.data(), 6);
    pushEvent(mkEvent(qaku::T::POLL_CREATE, nextHlc(), {{"pollId", qaku::toHex(r.data(),6)}, {"question", question}, {"options", opts}, {"active", active!="false"}}), true); return snapshot();
}
std::string QakuCoreImpl::setPollActive(std::string pollId, std::string active) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx); std::string g = adminGuard(); if (!g.empty()) return g;
    pushEvent(mkEvent(qaku::T::POLL_SET_ACTIVE, nextHlc(), {{"pollId", pollId}, {"active", active!="false"}}), true); return snapshot();
}
std::string QakuCoreImpl::votePoll(std::string pollId, std::string optionId) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    pushEvent(mkEvent(qaku::T::POLL_VOTE, nextHlc(), {{"pollId", pollId}, {"optionId", optionId}, {"voter", m_deviceId}}), true); return snapshot();
}

// --- sync / transport ---
std::string QakuCoreImpl::ingestSealed(std::string sealedHex) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    try { ingestRaw(m_topic, std::string(reinterpret_cast<char*>(fromHex(sealedHex).data()), fromHex(sealedHex).size())); }
    catch (const std::exception& e) { return std::string("{\"error\":\"") + e.what() + "\"}"; }
    return snapshot();
}

void QakuCoreImpl::bootstrapDelivery() {
    if (!m_haveKey || m_nodeReady || m_deliveryStarting) return;
    m_deliveryStarting = true;
    // Register the receive handlers BEFORE createNode (the position the host wires
    // them with). BOTH the raw relay path and the SDS reliable-channel path are
    // registered; only the transport we actually joined delivers. Each extracts
    // the base64 payload text, then ingestPayload tries single- and double-decode.
    auto toWire = [](const LogosMap& v) -> std::string {
        if (v.is_string()) return v.get<std::string>();
        if (v.is_array()) { std::string s; s.reserve(v.size()); for (const auto& c : v) if (c.is_number_integer()) s.push_back((char)c.get<int>()); return s; }
        if (v.is_object() && v.contains("_bytes") && v["_bytes"].is_string()) return v["_bytes"].get<std::string>();
        return std::string();
    };
    modules().delivery_module.onMessageReceived(
        [this, toWire](const std::string&, const std::string& contentTopic, const LogosMap& payload, int64_t) {
            std::string p = toWire(payload);
            if (p.empty() && payload.is_object() && payload.contains("payload")) p = toWire(payload["payload"]);
            if (!p.empty()) ingestPayload(contentTopic, p);
        });
    modules().delivery_module.onChannelMessageReceived(
        [this, toWire](const std::string& channelId, const std::string&, const LogosMap& payload, int64_t) {
            std::string p = toWire(payload);
            if (p.empty() && payload.is_object() && payload.contains("payload")) p = toWire(payload["payload"]);
            if (!p.empty()) ingestPayload(channelId, p);
        });
    // Fleet preset + optional entryNodes. A bare preset can give ZERO bootstrap
    // peers ("No peers for topic"); QAKU_DELIVERY_CFG (a JSON object) is merged
    // over the default so the hub/desktop can pin entryNodes without a rebuild.
    setStatus("Connecting...");
    LogosMap cfg = {{"logLevel", "INFO"}, {"mode", "Core"}, {"preset", "logos.dev"}};
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
                joinTransport();
                setStatus("Connected - session " + (m_haveKey ? m_id.fingerprint : std::string()));
                for (auto& e : m_log) sealAndSend(e);   // seed our log for peers already listening
                publishState();
            });
        });
    };
    // Headless: delay createNode so the receive-handler subscription IPC lands
    // before the node is built (else nwaku comes up "No external callbacks" and
    // messages never reach us). The desktop host wires events synchronously.
    if (std::getenv("QAKU_HUB")) QTimer::singleShot(1500, startNode);
    else startNode();
}

void QakuCoreImpl::joinTransport() {
    if (!m_haveKey || !m_nodeReady || m_subscribed) return;
    // SDS Reliable Channels. BOTH calls, in order (subscribe THEN channelCreate)
    // - channelCreate does not itself subscribe the content topic, and the recv
    // service only emits for subscribed topics, so a channelCreate-only join sees
    // ours:0. channelId == contentTopic == our derived topic; senderId == device.
    modules().delivery_module.subscribeAsync(m_topic, [](StdLogosResult){});
    modules().delivery_module.channelCreateAsync(m_topic, m_topic, m_deviceId, [](StdLogosResult){});
    m_subscribed = true;
}

void QakuCoreImpl::sealAndSend(const Event& e) {
    if (!m_haveKey || !m_nodeReady) return;
    std::string plain = qaku::encodeEvent(e);
    qaku::Bytes sealed = qaku::seal(m_id, qaku::Bytes(plain.begin(), plain.end()), m_topic);
    deliverySend(m_topic, b64(sealed));
    m_txTotal++;
}

void QakuCoreImpl::deliverySend(const std::string& topic, const std::string& sealedB64) {
    if (!m_nodeReady) return;
    // Double-encode to match the fleet/phone convention: the receiver's delivery
    // FFI peels one base64 layer, leaving base64 text the app peels a second time
    // (ingestPayload tries both). Robust to either delivery IPC shape: newer
    // builds want a JSON byte ARRAY (a string throws "type must be array"), older
    // ones want a string. Probe once (array->string), cache m_sendRepr, reuse.
    std::string doubled = b64s(sealedB64);
    auto attempt = [&](int repr) -> bool {
        try {
            LogosMap p = (repr == 1) ? bytesPayload(doubled) : LogosMap(doubled);
            modules().delivery_module.channelSendAsync(topic, p, [](StdLogosResult){});
            return true;
        } catch (...) { return false; }
    };
    if (m_sendRepr == 1 || m_sendRepr == 2) { if (attempt(m_sendRepr)) return; m_sendRepr = 0; }
    if (attempt(1)) { m_sendRepr = 1; return; }
    if (attempt(2)) { m_sendRepr = 2; return; }
    fprintf(stderr, "QAKUTX deliverySend: no working payload representation\n");
}

// Try to AEAD-open one sealed byte-string and, on success, fold the event in.
// Returns true if it opened (whether new or a duplicate), false if it did not.
bool QakuCoreImpl::openAndPush(const std::string& sealed) {
    Event e;
    try {
        qaku::Bytes s(sealed.begin(), sealed.end());
        qaku::Bytes pt = qaku::open(m_id, s, m_topic);
        e = qaku::decodeEvent(std::string(pt.begin(), pt.end()));
    } catch (const std::exception&) { return false; }
    m_rxOpened++;
    if (m_ids.count(e.id)) { m_rxDup++; return true; }
    m_rxNew++;
    pushEvent(e, false);
    return true;
}

void QakuCoreImpl::ingestPayload(const std::string& contentTopic, const std::string& payloadB64) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    m_rxRaw++;
    if (contentTopic != m_topic) return;
    m_rxSeen++;
    // The wire payload is base64 text; a peer may single- OR double-encode. Try
    // the double-peel first (our + the phone's convention), then a single peel.
    std::string once = b64decode(payloadB64);
    if (openAndPush(b64decode(once))) return;   // double: b64decode(b64decode(payload))
    if (openAndPush(once)) return;              // single: b64decode(payload)
    m_rxOpenFail++;
}

void QakuCoreImpl::ingestRaw(const std::string& contentTopic, const std::string& sealed) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    m_rxRaw++;
    if (contentTopic != m_topic) return;
    m_rxSeen++;
    if (!openAndPush(sealed)) m_rxOpenFail++;   // manual path: raw sealed bytes
}
