#pragma once
// On-disk persistence primitives for qaku_core - std + nlohmann::json only, no Qt,
// no delivery. Ported from KYM's per-budget persistence (kym_core_impl.cpp): each
// Q&A "session" is stored under its own directory holding a raw 32-byte pairing key
// (pair.key) and its append-only event log (log.json), plus a small session
// registry (sessions.json) at the data-dir root. QakuCoreImpl calls these from its
// mutating methods so sessions + messages survive a module/host restart; a tiny
// harness (test/persist_harness.cpp) exercises these same functions directly, so
// the round-trip is verified against the exact code the module runs.
//
// Robustness rule (mirrors KYM's loaders): a missing OR corrupt file must never
// throw out of these functions - readers no-op / skip and return what they could,
// so a bad file can never crash the module on start.
#include <string>
#include <vector>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <iterator>
#include <nlohmann/json.hpp>
#include "qaku_engine.hpp"
#include "qaku_wire_std.hpp"
#include "qaku_crypto.hpp"

namespace qaku { namespace persist {
using json = nlohmann::json;

// Create dir (recursively); returns true if it exists afterwards. Empty = skip.
inline bool ensureDir(const std::string& dir) {
    if (dir.empty()) return false;
    std::error_code ec; std::filesystem::create_directories(dir, ec);
    return std::filesystem::exists(dir, ec);
}

// --- pair.key : the raw 32-byte secret (binary), the session's pairing code -----
inline void writePairKey(const std::string& dir, const Bytes& secret) {
    if (dir.empty()) return;
    std::error_code ec; std::filesystem::create_directories(dir, ec);
    std::ofstream f(dir + "/pair.key", std::ios::binary);
    if (f) f.write(reinterpret_cast<const char*>(secret.data()), (std::streamsize)secret.size());
}
// Returns the 32-byte secret, or an empty vector if missing/short (skip the session).
inline Bytes readPairKey(const std::string& dir) {
    if (dir.empty()) return {};
    std::ifstream f(dir + "/pair.key", std::ios::binary);
    if (!f) return {};
    std::string raw((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    if (raw.size() < 32) return {};
    return Bytes(raw.begin(), raw.begin() + 32);
}

// --- log.json : the session's event log as a JSON array of event objects --------
inline void writeLog(const std::string& dir, const std::vector<Event>& log) {
    if (dir.empty()) return;
    std::error_code ec; std::filesystem::create_directories(dir, ec);
    json arr = json::array();
    for (const auto& e : log) arr.push_back(eventToJson(e));
    std::ofstream f(dir + "/log.json");
    if (f) f << arr.dump();
}
// Reads the log; a missing/corrupt file yields an empty vector (never throws).
inline std::vector<Event> readLog(const std::string& dir) {
    std::vector<Event> out;
    if (dir.empty()) return out;
    std::ifstream f(dir + "/log.json");
    if (!f) return out;
    std::stringstream ss; ss << f.rdbuf();
    json arr = json::parse(ss.str(), nullptr, false);   // no-throw parse
    if (!arr.is_array()) return out;
    for (auto& j : arr) {
        try { Event e = eventFromJson(j); if (!e.id.empty()) out.push_back(e); }
        catch (...) { /* skip a bad entry, keep the rest */ }
    }
    return out;
}

// --- sessions.json : the registry (display order + titles + current selection) --
struct RegEntry { std::string id, title; };
struct Registry  { std::vector<RegEntry> sessions; std::string current; };

inline void writeRegistry(const std::string& root, const Registry& r) {
    if (root.empty()) return;
    std::error_code ec; std::filesystem::create_directories(root, ec);
    json arr = json::array();
    for (const auto& e : r.sessions) arr.push_back({{"id", e.id}, {"title", e.title}});
    json reg = {{"sessions", arr}, {"current", r.current}};
    std::ofstream f(root + "/sessions.json");
    if (f) f << reg.dump(2);
}
inline Registry readRegistry(const std::string& root) {
    Registry r;
    if (root.empty()) return r;
    std::ifstream f(root + "/sessions.json");
    if (!f) return r;
    std::stringstream ss; ss << f.rdbuf();
    json j = json::parse(ss.str(), nullptr, false);
    if (!j.is_object() || !j.contains("sessions") || !j["sessions"].is_array()) return r;
    for (auto& e : j["sessions"]) {
        if (!e.is_object() || !e.contains("id")) continue;
        r.sessions.push_back({ e.value("id", std::string()), e.value("title", std::string()) });
    }
    r.current = j.value("current", std::string());
    return r;
}

// --- device.txt : this device's stable id (SDS sender + CRDT event author) -------
inline void writeDeviceId(const std::string& root, const std::string& id) {
    if (root.empty()) return;
    std::ofstream f(root + "/device.txt");
    if (f) f << id;
}
inline std::string readDeviceId(const std::string& root) {
    if (root.empty()) return "";
    std::ifstream f(root + "/device.txt");
    std::string id;
    if (f) std::getline(f, id);
    return id;
}

// Remove a session's on-disk directory (log + key). No-op on failure.
inline void removeSessionDir(const std::string& dir) {
    if (dir.empty()) return;
    std::error_code ec; std::filesystem::remove_all(dir, ec);
}

}} // namespace qaku::persist
