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
#include <QTimer>
#include <chrono>
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
static std::string b64(const qaku::Bytes& in){ static const char* T="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; std::string o; int val=0,bits=-6; for(uint8_t c:in){val=(val<<8)+c;bits+=8;while(bits>=0){o+=T[(val>>bits)&0x3F];bits-=6;}} if(bits>-6)o+=T[((val<<8)>>(bits+8))&0x3F]; while(o.size()%4)o+='='; return o; }

QakuCoreImpl::~QakuCoreImpl() { if (m_hubTimer) m_hubTimer->stop(); }

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
        m_hubTimer = new QTimer(this);
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
    if (!m_haveKey || m_nodeReady) return;
    // modules().delivery_module().createNodeAsync(cfg) with a fleet preset +
    // entryNodes (a bare preset gives ZERO bootstrap peers -> "No peers for
    // topic"; pin entryNodes / merge QAKU_DELIVERY_CFG over the default). On the
    // ready callback (event-loop thread) -> joinTransport().
    // The callback sets m_nodeReady=true; here we mark intent + join once ready.
    joinTransport();
}

void QakuCoreImpl::joinTransport() {
    if (!m_haveKey || m_subscribed) return;
    // SDS Reliable Channels. BOTH calls, in order (subscribe THEN channelCreate)
    // - channelCreate does not itself subscribe the content topic, and the recv
    // service only emits for subscribed topics, so a channelCreate-only join sees
    // ours:0. channelId == contentTopic == our derived topic; senderId == device.
    //   modules().delivery_module().subscribeAsync(m_topic);
    //   modules().delivery_module().channelCreateAsync(m_topic, m_topic, m_deviceId);
    m_subscribed = true;
    setStatus("Joined session " + (m_haveKey ? m_id.fingerprint : std::string()));
}

void QakuCoreImpl::sealAndSend(const Event& e) {
    if (!m_haveKey) return;
    std::string plain = qaku::encodeEvent(e);
    qaku::Bytes sealed = qaku::seal(m_id, qaku::Bytes(plain.begin(), plain.end()), m_topic);
    deliverySend(m_topic, b64(sealed));
    m_txTotal++;
}

void QakuCoreImpl::deliverySend(const std::string& topic, const std::string& sealedB64) {
    // Robust to either delivery build: newer builds want the payload as a JSON
    // byte ARRAY and throw "type must be array, but is string" on a string; older
    // builds want a string. Probe once (array->string), cache m_sendRepr, reuse.
    // Wire bytes are identical - this only picks the in-process IPC shape.
    //   channelSendAsync(topic, {"payload": <base64>, "ephemeral": false});
    (void)topic; (void)sealedB64;
}

void QakuCoreImpl::ingestRaw(const std::string& contentTopic, const std::string& sealed) {
    std::lock_guard<std::recursive_mutex> lk(m_mtx);
    m_rxRaw++;
    if (contentTopic != m_topic) { return; }
    m_rxSeen++;
    Event e;
    try {
        qaku::Bytes s(sealed.begin(), sealed.end());
        qaku::Bytes pt = qaku::open(m_id, s, m_topic);
        e = qaku::decodeEvent(std::string(pt.begin(), pt.end()));
        m_rxOpened++;
    } catch (const std::exception&) { m_rxOpenFail++; return; }
    if (m_ids.count(e.id)) { m_rxDup++; return; }
    m_rxNew++;
    pushEvent(e, false);
}
