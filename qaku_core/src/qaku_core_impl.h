#pragma once
// QakuCoreImpl - the QAKU engine + sync as a Logos CORE module (universal
// authoring). It owns the append-only event log, folds it through the shared
// std-only engine (qaku_engine.hpp), drives all Q&A mutations, and syncs over
// delivery_module using SDS Reliable Channels. It runs BOTH standalone under
// logoscore (the always-on hub) AND behind the desktop `qaku` ui_qml view, which
// calls these methods and renders snapshot() - ONE implementation of the
// engine/sync, no ui/hub drift.
//
// Rules honored (see the basecamp + multiwriter-sync skills):
//  - public methods return std::string (never int/bool - the dispatcher .dump()s);
//  - read state is delivered as a dispatchable snapshot() ACTION (getters are
//    dropped from the generated dep-caller) PLUS a stateChanged event;
//  - <=4 args per method; structured payloads pass as ONE JSON string;
//  - NO trailing // comments on a declaration line (the glue drops such methods);
//  - ASCII-only (a non-ASCII char stops the interface generator).
#include <string>
#include <vector>
#include <set>
#include <map>
#include <mutex>

class QTimer;
#include "logos_module_context.h"
#include "qaku_engine.hpp"
#include "qaku_crypto.hpp"
#include "qaku_wire_std.hpp"

class QakuCoreImpl : public LogosModuleContext {
public:
    ~QakuCoreImpl() override;

    // --- read surface (dispatchable actions; the UI polls snapshot on a Timer) ---
    std::string snapshot();
    std::string status();
    std::string fingerprint();

    // --- session lifecycle ---
    std::string createSession(std::string title, std::string description);
    std::string setConfig(std::string patchJson);
    std::string addAdmin(std::string memberId, std::string name);
    std::string removeAdmin(std::string memberId);

    // --- questions ---
    std::string addQuestion(std::string content);
    std::string editQuestion(std::string questionId, std::string content);
    std::string deleteQuestion(std::string questionId);
    std::string upvoteQuestion(std::string questionId, std::string up);
    std::string upvoteAnswer(std::string answerId, std::string up);

    // --- answers + moderation (owner/admin) ---
    std::string postAnswer(std::string questionId, std::string content);
    std::string acceptAnswer(std::string questionId, std::string answerId, std::string accepted);
    std::string moderate(std::string questionId, std::string hidden);

    // --- polls ---
    std::string createPoll(std::string question, std::string optionsJson, std::string active);
    std::string setPollActive(std::string pollId, std::string active);
    std::string votePoll(std::string pollId, std::string optionId);

    // --- sync / pairing ---
    std::string setSecret(std::string secretHex);
    std::string setDeviceId(std::string deviceId);
    std::string ingestSealed(std::string sealedHex);
    std::string resync();

protected:
    void onContextReady() override;

logos_events:
    void stateChanged(const std::string& snapshotJson);
    void statusChanged(const std::string& status);

private:
    qaku::HLC nextHlc();
    void pushEvent(const qaku::Event& e, bool broadcast);
    std::string adminGuard();
    void publishState();
    void setStatus(const std::string& s);

    // delivery (all calls async / fire-and-forget - a synchronous send on the
    // event-loop thread freezes the module on the IPC timeout).
    void bootstrapDelivery();
    void joinTransport();
    void ingestRaw(const std::string& contentTopic, const std::string& sealed);
    // Network receive path: the wire payload is base64 (the peer may single- OR
    // double-encode); try both candidates and ingest whichever AEAD-opens.
    void ingestPayload(const std::string& contentTopic, const std::string& payloadB64);
    bool openAndPush(const std::string& sealed);
    void sealAndSend(const qaku::Event& e);
    void deliverySend(const std::string& topic, const std::string& sealedB64);
    void applySecret(const qaku::Bytes& secret, bool persist);
    void loadOrCreateSecret();

    // --- state ---
    std::vector<qaku::Event> m_log;
    std::set<std::string> m_ids;
    qaku::Identity m_id;
    qaku::Bytes m_secret;          // the raw 32-byte session secret (the pairing code)
    std::string m_topic;
    bool m_haveKey = false;
    bool m_subscribed = false;
    bool m_deliveryStarting = false;

    long long m_wall = 0, m_ctr = 0;
    std::string m_deviceId = "qaku-core";
    std::string m_snapshot = "{}";
    std::string m_status = "Starting...";
    bool m_nodeReady = false;
    int m_sendRepr = 0;

    // diagnostic counters (surfaced in snapshot, per logos-distributed-debugging)
    long m_rxRaw = 0, m_rxSeen = 0, m_rxOpened = 0, m_rxOpenFail = 0, m_rxNew = 0, m_rxDup = 0, m_txTotal = 0;

    std::recursive_mutex m_mtx;
    QTimer* m_hubTimer = nullptr;
};
