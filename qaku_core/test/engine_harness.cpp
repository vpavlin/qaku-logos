// Engine robustness + JS<->C++ parity harness (review 2026-09-30).
//
// 1. PARITY: folds every case in packages/engine/test/vectors/rules.json (written by the
//    JS engine, see gen-rules-vectors.mjs) and requires the SAME projection the JS fold
//    produced: voter = author, first question.add wins, creatorOf = first writer, and
//    malformed payloads fold identically, votes on a closed poll are ignored, and a case's
//    optional `me` yields the same per-poll myVote. Each case is also folded in reversed and
//    rotated arrival orders (the rules must be order-independent).
// 2. CRASH CASES: a name cut at 40 BYTES used to split UTF-8 so json::dump threw
//    "incomplete UTF-8"; null / wrong-typed / non-object payloads used to throw out of
//    value() in the fold. None of these may throw now.
// 3. The sessions.json `fresh` flag round-trips (createSession/joinSession slot reuse).
//
// Build + run (from the repo root):
//   g++ -std=c++17 -Iqaku_core/src -I<nlohmann>/include qaku_core/test/engine_harness.cpp
//       -o /tmp/engine_harness -lcrypto && /tmp/engine_harness packages/engine/test/vectors/rules.json \
//       packages/engine/test/vectors/invites.json
// Exit 0 + "PASS" only if everything holds.
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <algorithm>
#include "qaku_engine.hpp"
#include "qaku_persist_std.hpp"
#include "qaku_wire_std.hpp"
#include "logos_sync/catchup.hpp"

using namespace qaku;

static int g_fail = 0;
#define CHECK(cond, msg) do { if (!(cond)) { g_fail++; fprintf(stderr, "FAIL: %s  (%s:%d)\n", msg, __FILE__, __LINE__); } } while (0)

// Same projection as rules-cases.mjs project().
static json project(const json& st) {
    json out;
    const json& s = st["session"];
    out["session"] = s.is_object() ? json{{"id", s["id"]}, {"title", s["title"]}, {"description", s["description"]},
                                          {"enabled", s["enabled"]}, {"moderationEnabled", s["moderationEnabled"]}} : json(nullptr);
    out["owner"] = st["owner"];
    std::vector<std::string> admins = st["admins"].get<std::vector<std::string>>();
    std::sort(admins.begin(), admins.end());
    out["admins"] = admins;
    out["invites"] = st["invites"];
    out["names"] = st["names"].empty() ? json::object() : st["names"];
    json qs = json::array();
    for (const auto& q : st["questions"]) {
        json as = json::array();
        for (const auto& a : q["answers"])
            as.push_back({{"id", a["id"]}, {"content", a["content"]}, {"author", a["author"]}, {"accepted", a["accepted"]}, {"upvoters", a["upvoters"]}});
        qs.push_back({{"id", q["id"]}, {"content", q["content"]}, {"author", q["author"]}, {"moderated", q["moderated"]},
                      {"acceptedAnswerId", q["acceptedAnswerId"]}, {"upvotes", q["upvotes"]}, {"upvoters", q["upvoters"]}, {"answers", as}});
    }
    out["questions"] = qs;
    json ps = json::array();
    for (const auto& p : st["polls"])
        ps.push_back({{"id", p["id"]}, {"title", p["title"]}, {"question", p["question"]}, {"options", p["options"]},
                      {"active", p["active"]}, {"results", p["results"]}, {"tally", p["tally"]}, {"votes", p["votes"]}, {"myVote", p["myVote"]}});
    out["polls"] = ps;
    out["eventCount"] = st["eventCount"];
    return out;
}

static void parity(const char* path) {
    std::ifstream f(path);
    if (!f) { fprintf(stderr, "cannot open %s\n", path); g_fail++; return; }
    std::stringstream ss; ss << f.rdbuf();
    json vectors = json::parse(ss.str());
    for (const auto& c : vectors) {
        std::vector<Event> evs;
        for (const auto& j : c["events"]) evs.push_back(eventFromJson(j));
        std::vector<std::vector<Event>> orders{ evs };
        std::vector<Event> rev(evs.rbegin(), evs.rend()); orders.push_back(rev);
        for (size_t k = 1; k < evs.size(); k += 3) { std::vector<Event> r = evs; std::rotate(r.begin(), r.begin() + k, r.end()); orders.push_back(r); }
        for (size_t o = 0; o < orders.size(); o++) {
            json got;
            try { got = project(computeState(orders[o], c.value("me", std::string()), c.value("roomId", std::string()))); }
            catch (const std::exception& e) { fprintf(stderr, "FAIL [%s] order %zu threw: %s\n", c["name"].get<std::string>().c_str(), o, e.what()); g_fail++; continue; }
            if (got != c["expect"]) {
                g_fail++;
                fprintf(stderr, "FAIL [%s] order %zu\n  C++: %s\n  JS : %s\n", c["name"].get<std::string>().c_str(), o,
                        got.dump().c_str(), c["expect"].dump().c_str());
            }
        }
        printf("parity ok: %s (%zu orders)\n", c["name"].get<std::string>().c_str(), orders.size());
    }
}

static Event mk(const std::string& id, const char* type, long long wall, const std::string& dev, json payload) {
    Event e; e.v = 1; e.id = id; e.type = type; e.hlc = HLC{wall, 0, dev}; e.dev = dev; e.payload = std::move(payload); return e;
}

static void crashCases() {
    // (a) the old 40-BYTE cut of a 2-byte-char name leaves half a character...
    std::string e45; for (int i = 0; i < 45; i++) e45 += "\xc3\xa9";
    std::string byteCut = e45.substr(0, 39);   // 19.5 chars - the old setName / myname.txt shape
    bool oldThrew = false;
    try { json j = {{"name", byteCut}}; (void)j.dump(); } catch (const json::exception&) { oldThrew = true; }
    CHECK(oldThrew, "sanity: dumping a mid-sequence byte cut throws (the original crash)");
    // ...utf8Clip sanitizes it (drops the stray lead byte) and clips by code points.
    std::string clean = utf8Clip(byteCut, NAME_MAX_CP);
    CHECK(clean.size() == 38, "utf8Clip drops the dangling lead byte of an already-truncated name");
    try { json j = {{"name", clean}}; (void)j.dump(); } catch (...) { CHECK(false, "dump of a utf8Clip'd name must not throw"); }
    CHECK(utf8Clip(e45, 40).size() == 80, "45 x U+00E9 -> 40 code points (80 bytes)");
    std::string emoji; for (int i = 0; i < 41; i++) emoji += "\xf0\x9f\x98\x80";
    CHECK(utf8Clip(emoji, 40).size() == 160, "41 emoji -> 40 whole emoji");
    CHECK(utf8Clip(std::string("ab\xff\xfe" "c"), 40) == "abc", "invalid bytes are dropped");
    CHECK(utf8Clip(std::string("\xed\xa0\x80" "x"), 40) == "x", "a UTF-8-encoded surrogate is dropped");
    // A replace-mode dump never throws even on a raw invalid string.
    try { json j = {{"x", byteCut}}; (void)j.dump(-1, ' ', false, json::error_handler_t::replace); }
    catch (...) { CHECK(false, "replace-mode dump must not throw"); }

    // (b) every event type x every hostile payload shape: the fold must not throw, and
    // the projected strings must stay strings.
    const std::vector<json> junk = { json(nullptr), json(5), json("s"), json::array(), json::array({1, 2}),
        json{{"options", 7}}, json{{"questionId", 1}, {"content", json::object()}},
        json{{"questionId", "q"}, {"content", nullptr}, {"author", nullptr}, {"voter", nullptr}, {"up", nullptr}},
        json{{"pollId", "p"}, {"options", "x"}, {"active", "yes"}, {"optionId", nullptr}},
        json{{"name", nullptr}}, json{{"name", 7}}, json{{"memberId", json::array()}},
        json{{"answerId", 3}, {"accepted", "true"}, {"hidden", 1}, {"title", 42}, {"enabled", "no"}} };
    const char* types[] = { T::SESSION_CONFIG, T::ADMIN_ADD, T::ADMIN_REMOVE, T::QUESTION_ADD, T::QUESTION_EDIT, T::QUESTION_DELETE,
        T::UPVOTE, T::ANSWER_POST, T::ANSWER_EDIT, T::ANSWER_DELETE, T::ANSWER_ACCEPT, T::MODERATE,
        T::POLL_CREATE, T::POLL_SET_ACTIVE, T::POLL_DELETE, T::POLL_VOTE, T::PROFILE_SET, T::SESSION_CREATE };
    std::vector<Event> evs{ mk("c", T::SESSION_CREATE, 1, "S", {{"sessionId", "x"}, {"title", "t"}}) };
    int n = 0;
    for (const char* t : types) for (const auto& p : junk) { n++; evs.push_back(mk("j" + std::to_string(n), t, 10 + n, n % 2 ? "S" : "Z", p)); }
    // payload.voter / author must not be able to smuggle a non-string either
    evs.push_back(mk("ok-q", T::QUESTION_ADD, 1000, "Z", {{"questionId", "ok"}, {"content", "fine"}}));
    try {
        json st = computeState(evs);
        std::string dumped = st.dump(-1, ' ', false, json::error_handler_t::replace);
        (void)dumped;
        for (const auto& q : st["questions"]) { CHECK(q["content"].is_string(), "question content is a string"); CHECK(q["author"].is_string(), "author is a string"); }
        CHECK(st["session"]["title"].is_string(), "session title stays a string");
        bool haveOk = false; for (const auto& q : st["questions"]) if (q["id"] == "ok") haveOk = true;
        CHECK(haveOk, "a valid question after the junk still folds");
        printf("crash cases ok: %zu hostile events folded, %zu questions\n", evs.size(), st["questions"].size());
    } catch (const std::exception& e) {
        CHECK(false, (std::string("computeState threw on hostile payloads: ") + e.what()).c_str());
    }
    // admitEvents alone (roleFor / adminGuard path)
    try { (void)admitEvents(evs); } catch (...) { CHECK(false, "admitEvents threw"); }

    // jget: missing / null / wrong type -> default
    json p = {{"s", "x"}, {"n", nullptr}, {"i", 5}, {"b", true}};
    CHECK(jget<std::string>(p, "s", "d") == "x", "jget string");
    CHECK(jget<std::string>(p, "n", "d") == "d", "jget null -> default");
    CHECK(jget<std::string>(p, "i", "d") == "d", "jget wrong type -> default");
    CHECK(jget<std::string>(p, "missing", "d") == "d", "jget missing -> default");
    CHECK(jget<bool>(json("str"), "b", false) == false, "jget on a non-object -> default");
    CHECK(jget<bool>(p, "b", false) == true, "jget bool");
}

static void registryFresh() {
    char tmpl[] = "/tmp/qaku-engine-harness-XXXXXX";
    const char* dir = mkdtemp(tmpl);
    if (!dir) { CHECK(false, "mkdtemp"); return; }
    persist::Registry r;
    r.sessions.push_back({"s1", "Joined", false});
    r.sessions.push_back({"s2", "", true});
    r.current = "s2";
    persist::writeRegistry(dir, r);
    persist::Registry back = persist::readRegistry(dir);
    CHECK(back.sessions.size() == 2, "registry round-trip size");
    CHECK(back.sessions.size() == 2 && !back.sessions[0].fresh && back.sessions[1].fresh, "fresh flag round-trips");
    CHECK(back.current == "s2", "current round-trips");
    // a legacy registry (no fresh key) loads as NOT fresh - never reused for create/join
    { std::ofstream f(std::string(dir) + "/sessions.json"); f << R"({"sessions":[{"id":"old","title":7}],"current":null})"; }
    persist::Registry legacy = persist::readRegistry(dir);
    CHECK(legacy.sessions.size() == 1 && !legacy.sessions[0].fresh && legacy.sessions[0].title.empty() && legacy.current.empty(),
          "legacy / wrong-typed registry loads tolerant, not fresh");
    persist::removeSessionDir(dir);
    printf("registry fresh flag ok\n");
}

// Invite tickets (qaku ADR 0001): the C++ signer/verifier on their own (the fold itself is checked
// against the JS-signed vectors/invites.json by parity()).
static void inviteCrypto() {
    Bytes tpriv(32, 0); tpriv[31] = 0x21;
    Bytes mpriv(32, 0); mpriv[31] = 0x06;
    SignId member = identityFromPriv(mpriv);
    const std::string room = "9f1c0a5e7b3d4c2a8e6f1d0b3a5c7e9f";
    InviteClaim c = signInviteClaim(tpriv, room, member.address);
    CHECK(c.ok, "signInviteClaim");
    CHECK(verifyInviteClaim(room, c.ticket, c.ticketPub, member.address, c.ticketSig), "own claim verifies");
    CHECK(!verifyInviteClaim("other", c.ticket, c.ticketPub, member.address, c.ticketSig), "other room rejected");
    CHECK(!verifyInviteClaim("", c.ticket, c.ticketPub, member.address, c.ticketSig), "empty room rejected");
    CHECK(!verifyInviteClaim(room, c.ticket, c.ticketPub, "0x00", c.ticketSig), "other member rejected");
    // the high-S twin: OpenSSL alone would accept it - the low-S gate must reject it
    static const unsigned char kN[32] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFE,
                                         0xBA,0xAE,0xDC,0xE6,0xAF,0x48,0xA0,0x3B,0xBF,0xD2,0x5E,0x8C,0xD0,0x36,0x41,0x41};
    Bytes sig = fromHex(c.ticketSig);
    Bytes hi(sig.begin(), sig.begin() + 32);
    { int borrow = 0; Bytes sN(32); for (int i = 31; i >= 0; i--) { int d = (int)kN[i] - sig[32 + i] - borrow; borrow = d < 0; sN[i] = (uint8_t)(d + (borrow ? 256 : 0)); } hi.insert(hi.end(), sN.begin(), sN.end()); }
    CHECK(ecdsaVerify(fromHex(c.ticketPub), sha256(strBytes(inviteClaimMessage(room, c.ticket, member.address))), hi), "sanity: OpenSSL accepts the high-S twin");
    CHECK(!verifyInviteClaim(room, c.ticket, c.ticketPub, member.address, toHex(hi.data(), 64)), "high-S claim rejected");
    // an event signed via the external-signer path (stamp + digest + attach) == signEvent
    Event e = mk("x", T::MEMBER_CLAIM, 5, "", {{"ticket", c.ticket}});
    stampAuthor(e, member.address);
    Bytes d = fromHex(eventDigestHex(e));
    Bytes es = ecdsaSignLowS(member.priv, d);
    e.pub = member.pubHex; e.sig = toHex(es.data(), es.size());
    CHECK(verifyEvent(e), "externally signed event verifies");
    Event hiE = e; Bytes eh(es.begin(), es.begin() + 32);
    { int borrow = 0; Bytes sN(32); for (int i = 31; i >= 0; i--) { int dd = (int)kN[i] - es[32 + i] - borrow; borrow = dd < 0; sN[i] = (uint8_t)(dd + (borrow ? 256 : 0)); } eh.insert(eh.end(), sN.begin(), sN.end()); }
    hiE.sig = toHex(eh.data(), 64);
    CHECK(!verifyEvent(hiE), "high-S event signature rejected (as noble does)");
    printf("invite crypto ok\n");
}

// Regression (live e2e 2026-10-06): a joiner never received the room history because both
// desktops used the default transport id "qaku-core" - catch-up frames from a peer with OUR id are
// dropped as self-echo. Simulate the RBSR exchange the module runs (respond() per frame, served
// events merged) between an owner holding the log and an empty joiner.
static size_t catchupBetween(const std::string& ownerId, const std::string& joinerId) {
    std::vector<Event> owner = { mk("c", T::SESSION_CREATE, 1, "0xA", {{"sessionId", "r"}, {"title", "t"}}),
                                 mk("q", T::QUESTION_ADD, 2, "0xA", {{"questionId", "q1"}, {"content", "hi"}}) };
    std::vector<Event> joiner;
    // frames in flight: (to-joiner?, msg)
    std::vector<std::pair<bool, json>> wire = { {false, logos_sync::catchup::buildInitial(joiner, joinerId)},
                                               {true, logos_sync::catchup::buildInitial(owner, ownerId)} };
    for (int round = 0; round < 20 && !wire.empty(); round++) {
        std::vector<std::pair<bool, json>> next;
        for (auto& f : wire) {
            bool toJoiner = f.first;
            auto st = logos_sync::catchup::respond(toJoiner ? joiner : owner, f.second, toJoiner ? joinerId : ownerId);
            for (auto& r : st.replies) next.push_back({!toJoiner, r});
            for (auto& e : st.serve) {
                auto& dst = toJoiner ? owner : joiner;
                bool have = false; for (auto& x : dst) if (x.id == e.id) have = true;
                if (!have) dst.push_back(e);
            }
        }
        wire.swap(next);
    }
    return joiner.size();
}
static void deviceIds() {
    std::string a = persist::newDeviceId(), b = persist::newDeviceId();
    CHECK(a != b && a != "qaku-core" && a.rfind("qaku-core-", 0) == 0 && a.size() == 22, "newDeviceId is unique per install");
    CHECK(catchupBetween("qaku-core", "qaku-core") == 0, "sanity: with the SAME transport id the joiner gets nothing (the bug)");
    CHECK(catchupBetween(a, b) == 2, "with distinct ids the joiner catches up the whole log");
    printf("device ids + catch-up ok\n");
}

// 4. RBSR catch-up frames from a peer: only the shape the vendored respond() can read is
//    accepted (a missing "bounds" was an assertion abort, a numeric id a type_error), and every
//    frame our own buildFp/respond emit passes.
static void catchupShapes() {
    auto cu = [](const char* s) { return qaku::catchupWellFormed(json::parse(s)); };
    CHECK(cu(R"({"v":2,"t":"fp","from":"p","bounds":["b"],"fps":["x","y"]})"), "catchup fp ok");
    CHECK(cu(R"({"v":2,"t":"ids","from":"p","lo":"a","ids":["a","b"]})"), "catchup ids ok");
    CHECK(!cu(R"({"v":2,"t":"fp","from":"p","fps":["x","y"]})"), "catchup fp missing bounds rejected");
    CHECK(!cu(R"({"v":2,"t":"fp","from":"p","bounds":[],"fps":["x","y"]})"), "catchup fp short bounds rejected");
    CHECK(!cu(R"({"v":2,"t":"ids","from":"p","ids":[5]})"), "catchup numeric id rejected");
    CHECK(!cu(R"({"v":2,"t":"need","from":"p"})"), "catchup need without ids rejected");
    CHECK(!cu(R"({"v":2,"t":"fp","from":7,"bounds":[],"fps":["x"]})"), "catchup numeric from rejected");
    std::vector<Event> a, b;
    for (int i = 0; i < 40; i++) { Event e; e.id = "id" + std::to_string(i * 37 % 100); a.push_back(e); if (i % 3) b.push_back(e); }
    std::vector<json> q{logos_sync::catchup::buildInitial(a, "A")};
    int rounds = 0, rejected = 0;
    while (!q.empty() && rounds++ < 100) {
        json m = q.back(); q.pop_back();
        if (!qaku::catchupWellFormed(m)) rejected++;
        auto st = logos_sync::catchup::respond(rounds % 2 ? b : a, m, rounds % 2 ? "B" : "A");
        for (auto& r : st.replies) q.push_back(r);
    }
    CHECK(rejected == 0, "every real catch-up frame passes catchupWellFormed");
    printf("catchup frame shapes ok (%d real frames)\n", rounds);
}

int main(int argc, char** argv) {
    const char* vec = argc > 1 ? argv[1] : "packages/engine/test/vectors/rules.json";
    const char* inv = argc > 2 ? argv[2] : "packages/engine/test/vectors/invites.json";
    parity(vec);
    parity(inv);
    inviteCrypto();
    deviceIds();
    crashCases();
    registryFresh();
    catchupShapes();
    if (g_fail) { printf("FAIL (%d)\n", g_fail); return 1; }
    printf("PASS\n");
    return 0;
}
