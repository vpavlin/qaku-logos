// Restart-survival harness for qaku_core persistence (v0.1.7). It drives the SAME
// free functions the module runs (qaku_persist_std.hpp) plus the shared engine, in
// two phases against one QAKU_CORE_DATA dir:
//   Phase A ("first launch"): derive a session identity from a fresh secret, write
//     pair.key, append a session.create + a question.add event to log.json, and
//     register the session in sessions.json. Then everything goes out of scope
//     (the in-memory core is torn down).
//   Phase B ("restart"): a brand-new set of in-memory structures reads ONLY the
//     data dir back - registry, pair.key, log.json - re-derives the identity, folds
//     the log, and asserts the session title + the question survived.
// Exit 0 + "PASS" only if the session and its message come back byte-identical.
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include <cassert>
#include <openssl/rand.h>
#include "qaku_engine.hpp"
#include "qaku_crypto.hpp"
#include "qaku_wire_std.hpp"
#include "qaku_persist_std.hpp"

using namespace qaku;
namespace P = qaku::persist;

static std::string uuid() {
    Bytes r(16); RAND_bytes(r.data(), 16);
    r[6] = (r[6] & 0x0f) | 0x40; r[8] = (r[8] & 0x3f) | 0x80;
    std::string h = toHex(r.data(), 16);
    return h.substr(0,8)+"-"+h.substr(8,4)+"-"+h.substr(12,4)+"-"+h.substr(16,4)+"-"+h.substr(20);
}
static Event mk(const char* type, HLC hlc, json payload) {
    Event e; e.v = 1; e.type = type; e.hlc = hlc; e.dev = hlc.dev; e.payload = std::move(payload); e.id = uuid();
    return e;
}

int main() {
    const char* root = std::getenv("QAKU_CORE_DATA");
    if (!root) { fprintf(stderr, "set QAKU_CORE_DATA\n"); return 2; }
    const std::string dataDir = root;
    P::ensureDir(dataDir);

    const std::string dev = "harness-device";
    const std::string sid = "s_persist_test";
    const std::string sessDir = dataDir + "/" + sid;
    const std::string wantTitle = "Restart Survival Q&A";
    const std::string wantQ = "Does the log survive a restart?";
    std::string savedFingerprint, savedTopic, savedQid;

    // ---- Phase A: create a session + append events, then persist + drop ----
    {
        Bytes secret(32); RAND_bytes(secret.data(), 32);
        Identity id = deriveIdentity(secret);
        savedFingerprint = id.fingerprint;
        savedTopic = topicFor(id);

        // pair.key (raw secret)
        P::writePairKey(sessDir, secret);

        // build the log: session.create (owner=dev) + one question.add
        std::vector<Event> log;
        HLC h1{ 1000, 0, dev };
        log.push_back(mk(T::SESSION_CREATE, h1, {{"sessionId", id.fingerprint}, {"title", wantTitle}, {"description", "from harness"}}));
        HLC h2{ 1001, 0, dev };
        savedQid = "q" + toHex(secret.data(), 4);
        log.push_back(mk(T::QUESTION_ADD, h2, {{"questionId", savedQid}, {"content", wantQ}}));
        log = mergeEvents(log);

        P::writeLog(sessDir, log);

        P::Registry reg;
        reg.sessions.push_back({ sid, wantTitle });
        reg.current = sid;
        P::writeRegistry(dataDir, reg);

        printf("[A] wrote session '%s' (%zu events) key+log+registry -> %s\n", sid.c_str(), log.size(), sessDir.c_str());
    }

    // ---- Phase B: fresh structures read ONLY the data dir back ----
    {
        P::Registry reg = P::readRegistry(dataDir);
        assert(reg.current == sid && "registry current lost");
        assert(reg.sessions.size() == 1 && "registry session count lost");
        assert(reg.sessions[0].id == sid && "registry session id lost");
        assert(reg.sessions[0].title == wantTitle && "registry title lost");

        Bytes secret = P::readPairKey(sessDir);
        assert(secret.size() == 32 && "pair.key lost");
        Identity id = deriveIdentity(secret);
        assert(id.fingerprint == savedFingerprint && "identity did not re-derive from persisted key");
        assert(topicFor(id) == savedTopic && "topic did not re-derive");

        std::vector<Event> log = P::readLog(sessDir);
        assert(log.size() == 2 && "log event count lost");

        json st = computeState(log);
        assert(st["isSession"].get<bool>() && "session not reconstructed");
        assert(st["session"].is_object() && "session object missing");
        assert(st["session"].value("title", std::string()) == wantTitle && "session title lost");
        assert(st["owner"].get<std::string>() == dev && "owner lost");
        assert(st.value("questionCount", (json::number_integer_t)0) == 1 && "question count lost");
        assert(st["questions"].is_array() && st["questions"].size() == 1 && "question missing");
        assert(st["questions"][0].value("content", std::string()) == wantQ && "question content lost");

        printf("[B] reload OK: fingerprint=%s title='%s' owner=%s questions=%d q0='%s'\n",
               id.fingerprint.c_str(), st["session"].value("title", std::string()).c_str(),
               st["owner"].get<std::string>().c_str(),
               (int)st.value("questionCount", (json::number_integer_t)0),
               st["questions"][0].value("content", std::string()).c_str());
    }

    printf("PASS: session + message survived restart\n");
    return 0;
}
