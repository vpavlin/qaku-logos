#pragma once
// QakuCoreImpl - the QAKU engine + sync as a Logos CORE module (universal
// authoring). It owns one append-only event log PER SESSION, folds each through
// the shared std-only engine (qaku_engine.hpp), drives all Q&A mutations, and
// syncs every session over delivery_module using SDS Reliable Channels. It runs
// BOTH standalone under logoscore (the always-on hub) AND behind the desktop
// `qaku` ui_qml view, which calls these methods and renders snapshot() - ONE
// implementation of the engine/sync, no ui/hub drift.
//
// Multi-session model (mirrors KYM's multi-budget core): a "session" is a Q&A
// (its own secret -> identity -> topic -> log -> role). A device holds several at
// once (m_sessions); it renders/edits the CURRENT one (cur()); ALL of them sync
// in the background. snapshot() returns the session LIST plus the current
// session's full detail + its shareable secret. Privacy = who you share a
// session's secret with.
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

    // --- multi-session lifecycle ---
    std::string createSession(std::string title, std::string description);
    std::string joinSession(std::string secretHex);
    std::string switchSession(std::string id);
    std::string deleteSession(std::string id);
    std::string listSessions();

    // --- current-session config / admins ---
    std::string setConfig(std::string patchJson);
    std::string addAdmin(std::string memberId, std::string name);
    std::string removeAdmin(std::string memberId);

    // --- questions (operate on the current session) ---
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
    // Per-session state. Everything belonging to ONE Q&A lives here; qaku_core
    // holds several at once (m_sessions), renders/edits the "current" one (cur()),
    // and syncs ALL of them in the background.
    struct Session {
        std::string id;
        std::vector<qaku::Event> log;
        std::set<std::string> ids;
        qaku::Identity identity;       // .secret holds the raw 32-byte pairing code
        std::string topic;
        std::string fingerprint;
        bool haveKey = false;
        bool subscribed = false;
        long long wall = 0, ctr = 0;
    };

    // event builders + per-session helpers
    qaku::HLC nextHlc(Session& s);
    void pushEvent(Session& s, const qaku::Event& e, bool broadcast);
    std::string adminGuard();
    void publishState();
    void setStatus(const std::string& s);

    // session registry
    std::string newSessionId();
    Session& newSessionEntry();
    void loadOrCreateSecret();
    Session& cur();
    const Session& cur() const;
    Session* sessionForTopic(const std::string& t);

    // delivery (all calls async / fire-and-forget - a synchronous send on the
    // event-loop thread freezes the module on the IPC timeout).
    void bootstrapDelivery();
    void joinTransport(Session& s);
    void joinAllTransports();
    void ingestPayload(const std::string& contentTopic, const std::string& payloadB64);
    bool openAndPush(Session& s, const std::string& sealed);
    void sealAndSend(Session& s, const qaku::Event& e);
    void deliverySend(const std::string& topic, const std::string& sealedB64);
    void applySecret(Session& s, const qaku::Bytes& secret, bool persist);

    // --- state ---
    std::map<std::string, Session> m_sessions;   // id -> session
    std::vector<std::string> m_order;            // ids in display order
    std::string m_current;                       // the selected session's id
    bool m_deliveryStarting = false;

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
