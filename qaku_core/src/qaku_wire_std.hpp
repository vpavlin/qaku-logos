#pragma once
// The Delivery wire envelope (parity with packages/sync/src/wire.mjs). One event
// per EVENT message: plaintext = {"v":1,"type":"EVENT","event":{...}} then sealed.
#include <string>
#include <nlohmann/json.hpp>
#include "qaku_engine.hpp"

namespace qaku {
using json = nlohmann::json;

inline json eventToJson(const Event& e) {
    return json{{"v", e.v},{"id", e.id},{"type", e.type},
                {"hlc", {{"wall", e.hlc.wall},{"ctr", e.hlc.ctr},{"dev", e.hlc.dev}}},
                {"dev", e.dev},{"payload", e.payload}};
}
inline Event eventFromJson(const json& j) {
    Event e; e.v = j.value("v", 1); e.id = j.value("id",""); e.type = j.value("type","");
    const json& h = j.at("hlc"); e.hlc.wall = h.value("wall",0LL); e.hlc.ctr = h.value("ctr",0LL); e.hlc.dev = h.value("dev","");
    e.dev = j.value("dev", e.hlc.dev); e.payload = j.value("payload", json::object());
    return e;
}

inline std::string encodeEvent(const Event& e) {
    return json{{"v",1},{"type","EVENT"},{"event", eventToJson(e)}}.dump();
}
inline Event decodeEvent(const std::string& bytes) {
    json o = json::parse(bytes);
    if (o.value("type","") != "EVENT" || !o.contains("event")) throw std::runtime_error("unexpected envelope");
    return eventFromJson(o["event"]);
}

} // namespace qaku
