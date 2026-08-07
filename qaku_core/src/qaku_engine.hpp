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

namespace qaku {
using json = nlohmann::json;

struct HLC { long long wall = 0; long long ctr = 0; std::string dev; };
inline int compareHlc(const HLC& a, const HLC& b) {
    if (a.wall != b.wall) return a.wall < b.wall ? -1 : 1;
    if (a.ctr  != b.ctr)  return a.ctr  < b.ctr  ? -1 : 1;
    if (a.dev  != b.dev)  return a.dev  < b.dev  ? -1 : 1;
    return 0;
}

struct Event { int v = 1; std::string id; std::string type; HLC hlc; std::string dev; json payload; std::string pub; std::string sig; };

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
}

// Union by id, sort by HLC. Idempotent - redelivery is a no-op. Pure.
inline std::vector<Event> mergeEvents(const std::vector<Event>& a, const std::vector<Event>& b = {}) {
    std::map<std::string, Event> byId;
    for (const auto& e : a) byId.emplace(e.id, e);
    for (const auto& e : b) byId.emplace(e.id, e);
    std::vector<Event> out;
    out.reserve(byId.size());
    for (auto& kv : byId) out.push_back(kv.second);
    std::sort(out.begin(), out.end(), [](const Event& x, const Event& y){ return compareHlc(x.hlc, y.hlc) < 0; });
    return out;
}

struct Admission { std::vector<Event> admitted; std::string owner; std::vector<std::string> admins; bool isSession = false; };

// Role admission (mirror of admitEvents). Owner = author of earliest
// session.create; admins folded in HLC order gated by the current set; content
// events owner/admin-gated; question edit/delete author-or-admin; participant
// events open. Order-independent (folds the full set first).
inline Admission admitEvents(const std::vector<Event>& evs) {
    auto ordered = mergeEvents(evs);
    Admission A;
    for (const auto& e : ordered) if (e.type == T::SESSION_CREATE) { A.owner = e.hlc.dev; break; }
    A.isSession = !A.owner.empty();
    std::set<std::string> admins;
    if (!A.owner.empty()) admins.insert(A.owner);
    for (const auto& e : ordered) {
        if (e.type != T::ADMIN_ADD && e.type != T::ADMIN_REMOVE) continue;
        if (!admins.count(e.hlc.dev)) continue;
        std::string m = e.payload.value("memberId", "");
        if (e.type == T::ADMIN_ADD) admins.insert(m);
        else if (m != A.owner) admins.erase(m);
    }
    std::map<std::string, std::string> creatorOf;
    for (const auto& e : ordered) {
        if (e.type == T::QUESTION_ADD) creatorOf[e.payload.value("questionId","")] = e.hlc.dev;
        else if (e.type == T::ANSWER_POST) creatorOf[e.payload.value("answerId","")] = e.hlc.dev;
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
        if (isMod(e.type)) { if (admins.count(author)) A.admitted.push_back(e); continue; }
        if (e.type == T::QUESTION_EDIT || e.type == T::QUESTION_DELETE) {
            auto it = creatorOf.find(e.payload.value("questionId",""));
            if (admins.count(author) || (it != creatorOf.end() && it->second == author)) A.admitted.push_back(e);
            continue;
        }
        if (e.type == T::QUESTION_ADD || e.type == T::UPVOTE || e.type == T::POLL_VOTE) { A.admitted.push_back(e); continue; }
    }
    for (auto& a : admins) A.admins.push_back(a);
    return A;
}

// Fold the admitted log into a snapshot JSON: {session, owner, admins,
// questions:[{id,content,author,ts,moderated,acceptedAnswerId,upvotes,upvoters,
// answers:[...]}], polls:[{...,tally,votes}], counts}. Mirror of computeState.
inline json computeState(const std::vector<Event>& evs) {
    auto adm = admitEvents(evs);
    const auto& ordered = adm.admitted;

    struct QV { std::string id, evId, content, author; long long ts=0; bool moderated=false; std::string accepted; bool deleted=false; };
    struct AV { std::string id, evId, questionId, content, author; long long ts=0; bool accepted=false; bool deleted=false; };
    struct PV { std::string id, title, question; json options; bool active=false; long long ts=0; bool deleted=false; std::map<std::string,std::string> votes; };

    bool haveSession=false; json session=nullptr;
    std::map<std::string,QV> questions; std::vector<std::string> qOrder;
    std::map<std::string,AV> answers;   std::vector<std::string> aOrder;
    std::map<std::string,PV> polls;     std::vector<std::string> pOrder;
    // upvote register: targetId -> (voter -> up)
    std::map<std::string, std::map<std::string,bool>> up;

    for (const auto& e : ordered) {
        const json& p = e.payload;
        const std::string& t = e.type;
        if (t == T::SESSION_CREATE) {
            if (!haveSession) { haveSession=true; session = {
                {"id", p.value("sessionId","")}, {"title", p.value("title","")},
                {"description", p.value("description","")}, {"owner", e.hlc.dev},
                {"enabled", true}, {"moderationEnabled", false}, {"createdAt", e.hlc.wall} }; }
        } else if (t == T::SESSION_CONFIG) {
            if (haveSession) {
                if (p.contains("title") && !p["title"].is_null()) session["title"]=p["title"];
                if (p.contains("description") && !p["description"].is_null()) session["description"]=p["description"];
                if (p.contains("enabled") && !p["enabled"].is_null()) session["enabled"]=p["enabled"];
                if (p.contains("moderationEnabled") && !p["moderationEnabled"].is_null()) session["moderationEnabled"]=p["moderationEnabled"];
            }
        } else if (t == T::QUESTION_ADD) {
            std::string id = p.value("questionId","");
            if (!questions.count(id)) { questions[id] = QV{id, e.id, p.value("content",""), p.value("author", e.hlc.dev), e.hlc.wall, false, "", false}; qOrder.push_back(id); }
        } else if (t == T::QUESTION_EDIT) {
            auto it = questions.find(p.value("questionId","")); if (it!=questions.end() && p.contains("content")) it->second.content = p["content"];
        } else if (t == T::QUESTION_DELETE) {
            auto it = questions.find(p.value("questionId","")); if (it!=questions.end()) it->second.deleted = true;
        } else if (t == T::MODERATE) {
            auto it = questions.find(p.value("questionId","")); if (it!=questions.end()) it->second.moderated = p.value("hidden", true);
        } else if (t == T::UPVOTE) {
            up[p.value("targetId","")][p.value("voter", e.hlc.dev)] = p.value("up", true);
        } else if (t == T::ANSWER_POST) {
            std::string id = p.value("answerId","");
            if (!answers.count(id)) { answers[id] = AV{id, e.id, p.value("questionId",""), p.value("content",""), p.value("author", e.hlc.dev), e.hlc.wall, false, false}; aOrder.push_back(id); }
        } else if (t == T::ANSWER_EDIT) {
            auto it = answers.find(p.value("answerId","")); if (it!=answers.end() && p.contains("content")) it->second.content = p["content"];
        } else if (t == T::ANSWER_DELETE) {
            auto it = answers.find(p.value("answerId","")); if (it!=answers.end()) it->second.deleted = true;
        } else if (t == T::ANSWER_ACCEPT) {
            auto it = answers.find(p.value("answerId","")); if (it!=answers.end()) it->second.accepted = p.value("accepted", true);
            auto q = questions.find(p.value("questionId","")); if (q!=questions.end()) q->second.accepted = p.value("accepted", true) ? p.value("answerId","") : (q->second.accepted==p.value("answerId","")?"":q->second.accepted);
        } else if (t == T::POLL_CREATE) {
            std::string id = p.value("pollId","");
            if (!polls.count(id)) { PV pv; pv.id=id; pv.title=p.value("title",""); pv.question=p.value("question",""); pv.options=p.value("options", json::array()); pv.active=p.value("active",false); pv.ts=e.hlc.wall; polls[id]=pv; pOrder.push_back(id); }
        } else if (t == T::POLL_SET_ACTIVE) {
            auto it = polls.find(p.value("pollId","")); if (it!=polls.end()) it->second.active = p.value("active", false);
        } else if (t == T::POLL_DELETE) {
            auto it = polls.find(p.value("pollId","")); if (it!=polls.end()) it->second.deleted = true;
        } else if (t == T::POLL_VOTE) {
            auto it = polls.find(p.value("pollId","")); if (it!=polls.end()) it->second.votes[p.value("voter", e.hlc.dev)] = p.value("optionId","");
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
        json tally = json::object(); for (auto& o : pl.options) tally[o.value("id","")] = 0;
        long long voters=0; for (auto& kv : pl.votes) { if (tally.contains(kv.second)) { tally[kv.second] = (long long)tally[kv.second] + 1; voters++; } }
        ps.push_back({{"id",pl.id},{"title",pl.title},{"question",pl.question},{"options",pl.options},{"active",pl.active},{"ts",pl.ts},{"tally",tally},{"votes",voters}});
    }
    std::sort(ps.begin(), ps.end(), [](const json& x, const json& y){ long long xt=x["ts"],yt=y["ts"]; if (xt!=yt) return xt<yt; return x["id"]<y["id"]; });

    return json{
        {"session", session}, {"owner", adm.owner}, {"admins", adm.admins}, {"isSession", adm.isSession},
        {"questions", qs}, {"polls", ps},
        {"questionCount", qs.size()}, {"eventCount", (long long)ordered.size()},
    };
}

} // namespace qaku
