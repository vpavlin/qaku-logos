#pragma once
// QAKU engine - the pure, deterministic fold from a merged event log to session
// state, mirrored from the JS reference (packages/engine/src/engine.mjs). std +
// nlohmann::json only, no Qt, no I/O. This MUST stay byte-parity with the JS
// fold; guard it with golden vectors + a parity test (see REPORT.md, "what
// remains"). Keep this header ASCII-only (a non-ASCII char stops the interface
// generator; see the basecamp skill).
#include <string>
#include <vector>
#include <map>
#include <set>
#include <algorithm>
#include <nlohmann/json.hpp>

// The event envelope, HLC and CRDT merge now come from the shared logos-sync
// library (vendored under logos_sync/) — they were already byte-identical to
// QAKU's hand-written copies (opaque json payload, wall/ctr/dev HLC, union-by-id
// + HLC-sort merge), so this is a pure de-duplication. What stays QAKU's: the
// event-type constants, Admission, and the whole Q&A fold below (ADR 0007/0010).
#include "logos_sync/event.hpp"
#include "logos_sync/merge.hpp"
// verifyEvent / verifyInviteClaim: invite tickets are folded in admitEvents (qaku ADR 0001).
#include "qaku_identity.hpp"

namespace qaku {
using json = nlohmann::json;

// Adopt the shared spine into the qaku:: namespace so the rest of the module keeps
// compiling unchanged against qaku::Event / qaku::HLC etc. eventToJson/eventFromJson
// (the on-wire event serialization) now come from logos-sync too — QAKU's envelope
// wrapper ({v,type:"EVENT",event}) stays in qaku_wire_std.hpp.
using logos_sync::HLC;
using logos_sync::compareHlc;
using logos_sync::Event;
using logos_sync::eventToJson;
using logos_sync::eventFromJson;
using logos_sync::mergeEvents;

// Event type constants - keep in lockstep with contract/src/events.mjs.
namespace T {
    constexpr const char* SESSION_CREATE = "session.create";
    constexpr const char* SESSION_CONFIG = "session.config";
    constexpr const char* ADMIN_ADD      = "admin.add";
    constexpr const char* ADMIN_REMOVE   = "admin.remove";
    constexpr const char* QUESTION_ADD   = "question.add";
    constexpr const char* QUESTION_EDIT  = "question.edit";
    constexpr const char* QUESTION_DELETE= "question.delete";
    constexpr const char* UPVOTE         = "upvote";
    constexpr const char* ANSWER_POST    = "answer.post";
    constexpr const char* ANSWER_EDIT    = "answer.edit";
    constexpr const char* ANSWER_DELETE  = "answer.delete";
    constexpr const char* ANSWER_ACCEPT  = "answer.accept";
    constexpr const char* MODERATE       = "moderate";
    constexpr const char* POLL_CREATE    = "poll.create";
    constexpr const char* POLL_SET_ACTIVE= "poll.setActive";
    constexpr const char* POLL_DELETE    = "poll.delete";
    constexpr const char* POLL_VOTE      = "poll.vote";
    constexpr const char* PROFILE_SET    = "profile.set";   // self-scoped display name (participant)
    constexpr const char* MEMBER_INVITE  = "member.invite"; // {ticket,role} invite ticket (qaku ADR 0001), owner/admin
    constexpr const char* MEMBER_CLAIM   = "member.claim";  // {ticket,ticketPub,member,ticketSig} redeem it, first valid wins
}

// ---- tolerant payload reads ------------------------------------------------
// A payload is whatever a peer put on the wire (old client, bug, or hostile writer).
// nlohmann's value(k, def) only falls back when the key is MISSING: a present-but-null
// or wrong-typed field throws type_error, and one such event threw out of the fold on
// every publishState -> the session (and the module) was dead. jget returns `def` when
// the payload is not an object or the field is missing / null / the wrong type. Same
// typing as str()/bool() in engine.mjs (a string field only accepts a JSON string, a
// bool field only a JSON bool), so both engines read the same value from the same bytes.
template <class T>
inline T jget(const json& j, const char* k, T def) {
    if (!j.is_object()) return def;
    auto it = j.find(k);
    if (it == j.end() || it->is_null()) return def;
    try { return it->template get<T>(); } catch (const json::exception&) { return def; }
}
inline std::string jstr(const json& j, const char* k, const std::string& def = std::string()) {
    if (!j.is_object()) return def;
    auto it = j.find(k);
    return (it != j.end() && it->is_string()) ? it->get<std::string>() : def;
}
inline bool jbool(const json& j, const char* k, bool def) {
    if (!j.is_object()) return def;
    auto it = j.find(k);
    return (it != j.end() && it->is_boolean()) ? it->get<bool>() : def;
}

// Cut a UTF-8 string to at most maxCp code points, never mid-sequence. Invalid bytes
// (e.g. a name an older build already cut at 40 BYTES, leaving half an emoji in
// myname.txt) are dropped, so the result is always valid UTF-8 and json::dump can't
// throw "incomplete UTF-8". For valid input this equals the JS [...s].slice(0, n).
inline std::string utf8Clip(const std::string& in, size_t maxCp) {
    std::string out; size_t cps = 0, i = 0, n = in.size();
    while (i < n && cps < maxCp) {
        unsigned char c = (unsigned char)in[i];
        size_t len = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 0;
        bool ok = len > 0 && i + len <= n;
        for (size_t k = 1; ok && k < len; k++) ok = ((unsigned char)in[i + k] & 0xC0) == 0x80;
        if (ok && len == 2) ok = c >= 0xC2;                                    // no overlong 2-byte
        if (ok && len == 3) { unsigned char c1 = (unsigned char)in[i + 1];
            ok = !(c == 0xE0 && c1 < 0xA0) && !(c == 0xED && c1 >= 0xA0); }    // no overlong, no surrogates
        if (ok && len == 4) { unsigned char c1 = (unsigned char)in[i + 1];
            ok = c <= 0xF4 && !(c == 0xF0 && c1 < 0x90) && !(c == 0xF4 && c1 >= 0x90); }
        if (!ok) { i += 1; continue; }                                         // drop a stray byte
        out.append(in, i, len); i += len; cps++;
    }
    return out;
}
constexpr size_t NAME_MAX_CP = 40;   // display-name cap, in code points (engine.mjs NAME_MAX)

// Poll options: an array of objects with a non-empty string id; anything else is dropped
// (engine.mjs optionsOf).
inline json pollOptions(const json& p) {
    json out = json::array();
    if (!p.is_object()) return out;
    auto it = p.find("options");
    if (it == p.end() || !it->is_array()) return out;
    for (const auto& o : *it) if (o.is_object() && !jstr(o, "id").empty()) out.push_back(o);
    return out;
}

// Poll results visibility: "always" (default, also any unknown value / old polls) or
// "afterVote". Display-only; the tally is always folded (engine.mjs resultsOf).
inline std::string pollResults(const json& p) {
    return jstr(p, "results") == "afterVote" ? "afterVote" : "always";
}

// mergeEvents / compareHlc are now logos_sync::mergeEvents / compareHlc (aliased
// above) — union-by-id + HLC sort, idempotent, byte-identical to QAKU's original.

struct Admission { std::vector<Event> admitted; std::string owner; std::vector<std::string> admins; std::map<std::string, std::string> invites; bool isSession = false; };

// Role admission (mirror of admitEvents). Owner = author of earliest
// session.create; admins folded in HLC order gated by the current set; content
// events owner/admin-gated; question edit/delete author-or-admin; participant
// events open. Order-independent (folds the full set first).
// Invite tickets (qaku ADR 0001, mirror of engine.mjs): member.invite must be SIGNED by a current
// owner/admin (role "admin" offers, "revoke" withdraws a pending ticket); member.claim must be
// SIGNED by `member`, member != owner, the ticket pending, and ticketSig a low-S signature by
// ticketPub over "qaku-invite-claim-v1|roomId|ticket|member". First valid claim in HLC order
// wins; a redeemed ticket is final. roomId = the room's topic hash ("" = no claim verifies).
inline Admission admitEvents(const std::vector<Event>& evs, const std::string& roomId = std::string()) {
    auto ordered = mergeEvents(evs);
    Admission A;
    for (const auto& e : ordered) if (e.type == T::SESSION_CREATE) { A.owner = e.hlc.dev; break; }
    A.isSession = !A.owner.empty();
    std::set<std::string> admins;
    if (!A.owner.empty()) admins.insert(A.owner);
    std::map<std::string, std::string> invites;   // pending ticket -> offered role
    std::set<std::string> claimed;                // redeemed tickets (one-time)
    std::set<std::string> ticketEvents;           // invite/claim event ids that took effect
    for (const auto& e : ordered) {
        if (e.type == T::MEMBER_INVITE || e.type == T::MEMBER_CLAIM) {
            if (A.owner.empty() || e.sig.empty() || !verifyEvent(e)) continue;   // must be signed by its author
            std::string t = jstr(e.payload, "ticket");
            if (t.empty() || claimed.count(t)) continue;                        // a redeemed ticket is final
            if (e.type == T::MEMBER_INVITE) {
                if (!admins.count(e.hlc.dev)) continue;                         // only a current owner/admin
                std::string r = jstr(e.payload, "role");
                if (r == "revoke") { invites.erase(t); ticketEvents.insert(e.id); }
                else if (r == "admin") { invites[t] = r; ticketEvents.insert(e.id); }
            } else {
                std::string m = jstr(e.payload, "member");
                if (m.empty() || m != e.hlc.dev || m == A.owner || !invites.count(t)) continue;
                if (!verifyInviteClaim(roomId, t, jstr(e.payload, "ticketPub"), m, jstr(e.payload, "ticketSig"))) continue;
                admins.insert(m);
                invites.erase(t);
                claimed.insert(t);
                ticketEvents.insert(e.id);
            }
            continue;
        }
        if (e.type != T::ADMIN_ADD && e.type != T::ADMIN_REMOVE) continue;
        if (!admins.count(e.hlc.dev)) continue;
        std::string m = jstr(e.payload, "memberId");
        if (e.type == T::ADMIN_ADD) { if (!m.empty()) admins.insert(m); }
        else if (m != A.owner) admins.erase(m);
    }
    // Creator = FIRST writer of the id (earliest in HLC order; emplace keeps the first),
    // so a later question.add reusing someone's questionId can't claim edit/delete on it.
    std::map<std::string, std::string> creatorOf;
    for (const auto& e : ordered) {
        std::string id = e.type == T::QUESTION_ADD ? jstr(e.payload, "questionId")
                       : e.type == T::ANSWER_POST ? jstr(e.payload, "answerId") : std::string();
        if (!id.empty()) creatorOf.emplace(id, e.hlc.dev);
    }
    auto isMod = [](const std::string& t){
        return t==T::SESSION_CONFIG||t==T::ANSWER_POST||t==T::ANSWER_EDIT||t==T::ANSWER_DELETE||
               t==T::ANSWER_ACCEPT||t==T::MODERATE||t==T::POLL_CREATE||t==T::POLL_SET_ACTIVE||t==T::POLL_DELETE;
    };
    for (const auto& e : ordered) {
        const std::string& author = e.hlc.dev;
        if (!A.isSession) { A.admitted.push_back(e); continue; }
        if (e.type == T::SESSION_CREATE) { A.admitted.push_back(e); continue; }
        if (e.type == T::ADMIN_ADD || e.type == T::ADMIN_REMOVE) { if (admins.count(author)) A.admitted.push_back(e); continue; }
        if (e.type == T::MEMBER_INVITE || e.type == T::MEMBER_CLAIM) { if (ticketEvents.count(e.id)) A.admitted.push_back(e); continue; }
        if (isMod(e.type)) { if (admins.count(author)) A.admitted.push_back(e); continue; }
        if (e.type == T::QUESTION_EDIT || e.type == T::QUESTION_DELETE) {
            auto it = creatorOf.find(jstr(e.payload, "questionId"));
            if (admins.count(author) || (it != creatorOf.end() && it->second == author)) A.admitted.push_back(e);
            continue;
        }
        if (e.type == T::QUESTION_ADD || e.type == T::UPVOTE || e.type == T::POLL_VOTE || e.type == T::PROFILE_SET) { A.admitted.push_back(e); continue; }
    }
    for (auto& a : admins) A.admins.push_back(a);
    A.invites = invites;
    return A;
}

// Fold the admitted log into a snapshot JSON: {session, owner, admins,
// questions:[{id,content,author,ts,moderated,acceptedAnswerId,upvotes,upvoters,
// answers:[...]}], polls:[{...,results,tally,votes,myVote}], counts}. Mirror of
// computeState. `me` = the viewer's author address; only used for each poll's myVote
// (that voter's live optionId, or null). Empty = no viewer (myVote always null).
// roomId = the room's topic hash; invite claims are bound to it (qaku ADR 0001).
inline json computeState(const std::vector<Event>& evs, const std::string& me = std::string(), const std::string& roomId = std::string()) {
    auto adm = admitEvents(evs, roomId);
    const auto& ordered = adm.admitted;

    struct QV { std::string id, evId, content, author; long long ts=0; bool moderated=false; std::string accepted; bool deleted=false; };
    struct AV { std::string id, evId, questionId, content, author; long long ts=0; bool accepted=false; bool deleted=false; };
    struct PV { std::string id, title, question, results; json options; bool active=false; long long ts=0; bool deleted=false; std::map<std::string,std::string> votes; };

    bool haveSession=false; json session=nullptr;
    std::map<std::string,QV> questions; std::vector<std::string> qOrder;
    std::map<std::string,AV> answers;   std::vector<std::string> aOrder;
    std::map<std::string,PV> polls;     std::vector<std::string> pOrder;
    std::map<std::string,std::string> names;   // author address -> display name (LWW by HLC order)
    // upvote register: targetId -> (voter -> up)
    std::map<std::string, std::map<std::string,bool>> up;

    for (const auto& e : ordered) {
        const json& p = e.payload;   // may be any JSON type: every read below is jstr/jbool/typed
        const std::string& t = e.type;
        if (t == T::SESSION_CREATE) {
            if (!haveSession) { haveSession=true; session = {
                {"id", jstr(p,"sessionId")}, {"title", jstr(p,"title")},
                {"description", jstr(p,"description")}, {"owner", e.hlc.dev},
                {"enabled", true}, {"moderationEnabled", false}, {"createdAt", e.hlc.wall} }; }
        } else if (t == T::SESSION_CONFIG) {
            if (haveSession && p.is_object()) {   // typed fields only; a wrong-typed field is ignored
                if (p.contains("title") && p["title"].is_string()) session["title"]=p["title"];
                if (p.contains("description") && p["description"].is_string()) session["description"]=p["description"];
                if (p.contains("enabled") && p["enabled"].is_boolean()) session["enabled"]=p["enabled"];
                if (p.contains("moderationEnabled") && p["moderationEnabled"].is_boolean()) session["moderationEnabled"]=p["moderationEnabled"];
            }
        } else if (t == T::QUESTION_ADD) {
            // FIRST question.add for an id wins; a later duplicate is ignored.
            std::string id = jstr(p,"questionId");
            std::string author = jstr(p,"author"); if (author.empty()) author = e.hlc.dev;
            if (!id.empty() && !questions.count(id)) { questions[id] = QV{id, e.id, jstr(p,"content"), author, e.hlc.wall, false, "", false}; qOrder.push_back(id); }
        } else if (t == T::QUESTION_EDIT) {
            auto it = questions.find(jstr(p,"questionId")); if (it!=questions.end() && p.is_object() && p.contains("content") && p["content"].is_string()) it->second.content = p["content"].get<std::string>();
        } else if (t == T::QUESTION_DELETE) {
            auto it = questions.find(jstr(p,"questionId")); if (it!=questions.end()) it->second.deleted = true;
        } else if (t == T::MODERATE) {
            auto it = questions.find(jstr(p,"questionId")); if (it!=questions.end()) it->second.moderated = jbool(p,"hidden", true);
        } else if (t == T::UPVOTE) {
            // The voter IS the author (hlc.dev); payload.voter is ignored (it let one writer
            // vote as any number of made-up voters).
            up[jstr(p,"targetId")][e.hlc.dev] = jbool(p,"up", true);
        } else if (t == T::ANSWER_POST) {
            std::string id = jstr(p,"answerId");
            std::string author = jstr(p,"author"); if (author.empty()) author = e.hlc.dev;
            if (!id.empty() && !answers.count(id)) { answers[id] = AV{id, e.id, jstr(p,"questionId"), jstr(p,"content"), author, e.hlc.wall, false, false}; aOrder.push_back(id); }
        } else if (t == T::ANSWER_EDIT) {
            auto it = answers.find(jstr(p,"answerId")); if (it!=answers.end() && p.is_object() && p.contains("content") && p["content"].is_string()) it->second.content = p["content"].get<std::string>();
        } else if (t == T::ANSWER_DELETE) {
            auto it = answers.find(jstr(p,"answerId")); if (it!=answers.end()) it->second.deleted = true;
        } else if (t == T::ANSWER_ACCEPT) {
            std::string aid = jstr(p,"answerId"); bool acc = jbool(p,"accepted", true);
            if (aid.empty()) continue;   // no answer id: nothing to accept
            auto it = answers.find(aid); if (it!=answers.end()) it->second.accepted = acc;
            auto q = questions.find(jstr(p,"questionId")); if (q!=questions.end()) q->second.accepted = acc ? aid : (q->second.accepted==aid?"":q->second.accepted);
        } else if (t == T::POLL_CREATE) {
            std::string id = jstr(p,"pollId");
            if (!id.empty() && !polls.count(id)) { PV pv; pv.id=id; pv.title=jstr(p,"title"); pv.question=jstr(p,"question"); pv.options=pollOptions(p); pv.active=jbool(p,"active",false); pv.results=pollResults(p); pv.ts=e.hlc.wall; polls[id]=pv; pOrder.push_back(id); }
        } else if (t == T::POLL_SET_ACTIVE) {
            auto it = polls.find(jstr(p,"pollId")); if (it!=polls.end()) it->second.active = jbool(p,"active", false);
        } else if (t == T::POLL_DELETE) {
            auto it = polls.find(jstr(p,"pollId")); if (it!=polls.end()) it->second.deleted = true;
        } else if (t == T::PROFILE_SET) {
            // self-scoped: names the author's OWN address, LWW by fold order. Only a string
            // name counts; capped at NAME_MAX_CP code points (never a byte cut mid-character).
            if (p.is_object() && p.contains("name") && p["name"].is_string())
                names[e.hlc.dev] = utf8Clip(p["name"].get<std::string>(), NAME_MAX_CP);
        } else if (t == T::POLL_VOTE) {
            // voter = the author (hlc.dev), never payload.voter. Counts only while the poll is
            // ACTIVE at this point of the ordered log (a vote on a closed poll is ignored).
            auto it = polls.find(jstr(p,"pollId")); if (it!=polls.end() && it->second.active) it->second.votes[e.hlc.dev] = jstr(p,"optionId");
        }
    }

    auto upvotersOf = [&](const std::string& id){
        std::vector<std::string> v; auto it = up.find(id);
        if (it != up.end()) for (auto& kv : it->second) if (kv.second) v.push_back(kv.first);
        std::sort(v.begin(), v.end()); return v;
    };

    // answers by question (live only)
    std::map<std::string, std::vector<json>> ansByQ;
    for (auto& id : aOrder) { auto& a = answers[id]; if (a.deleted) continue;
        auto voters = upvotersOf(a.id);
        json aj = {{"id",a.id},{"evId",a.evId},{"questionId",a.questionId},{"content",a.content},{"author",a.author},{"ts",a.ts},{"accepted",a.accepted},{"upvotes",(long long)voters.size()},{"upvoters",voters}};
        ansByQ[a.questionId].push_back(aj);
    }
    for (auto& kv : ansByQ) std::sort(kv.second.begin(), kv.second.end(), [](const json& x, const json& y){
        long long xu=x["upvotes"], yu=y["upvotes"]; if (xu!=yu) return xu>yu; long long xt=x["ts"],yt=y["ts"]; if (xt!=yt) return xt<yt; return x["id"]<y["id"]; });

    json qs = json::array();
    for (auto& id : qOrder) { auto& q = questions[id]; if (q.deleted) continue;
        auto voters = upvotersOf(q.id);
        json qj = {{"id",q.id},{"evId",q.evId},{"content",q.content},{"author",q.author},{"ts",q.ts},{"moderated",q.moderated},
                   {"acceptedAnswerId", q.accepted.empty()? json(nullptr): json(q.accepted)},
                   {"upvotes",(long long)voters.size()},{"upvoters",voters},
                   {"answers", ansByQ.count(q.id)? json(ansByQ[q.id]) : json::array()}};
        qs.push_back(qj);
    }
    std::sort(qs.begin(), qs.end(), [](const json& x, const json& y){
        long long xu=x["upvotes"], yu=y["upvotes"]; if (xu!=yu) return xu>yu; long long xt=x["ts"],yt=y["ts"]; if (xt!=yt) return xt<yt; return x["id"]<y["id"]; });

    json ps = json::array();
    for (auto& id : pOrder) { auto& pl = polls[id]; if (pl.deleted) continue;
        json tally = json::object(); for (auto& o : pl.options) tally[jstr(o,"id")] = 0;
        long long voters=0; for (auto& kv : pl.votes) { if (tally.contains(kv.second)) { tally[kv.second] = (long long)tally[kv.second] + 1; voters++; } }
        json myVote = nullptr;
        if (!me.empty()) { auto mv = pl.votes.find(me); if (mv != pl.votes.end() && tally.contains(mv->second)) myVote = mv->second; }
        ps.push_back({{"id",pl.id},{"title",pl.title},{"question",pl.question},{"options",pl.options},{"active",pl.active},{"results",pl.results},{"ts",pl.ts},{"tally",tally},{"votes",voters},{"myVote",myVote}});
    }
    std::sort(ps.begin(), ps.end(), [](const json& x, const json& y){ long long xt=x["ts"],yt=y["ts"]; if (xt!=yt) return xt<yt; return x["id"]<y["id"]; });

    json invites = json::object();
    for (auto& kv : adm.invites) invites[kv.first] = kv.second;

    return json{
        {"session", session}, {"owner", adm.owner}, {"admins", adm.admins}, {"invites", invites}, {"isSession", adm.isSession},
        {"questions", qs}, {"polls", ps}, {"names", names},
        {"questionCount", qs.size()}, {"eventCount", (long long)ordered.size()},
    };
}

} // namespace qaku
