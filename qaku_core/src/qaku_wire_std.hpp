#pragma once
// The Delivery wire envelope (parity with packages/sync/src/wire.mjs). One event
// per EVENT message: plaintext = {"v":1,"type":"EVENT","event":{...}} then sealed.
#include <string>
#include <nlohmann/json.hpp>
#include "qaku_engine.hpp"

namespace qaku {
using json = nlohmann::json;

// eventToJson / eventFromJson (the inner event serialization) now come from
// logos-sync via qaku_engine.hpp's using-declarations — they emit the SAME bytes
// QAKU emitted before ({v,id,type,hlc,dev,payload}(+pub/sig)). Only the envelope
// wrapper stays here.

inline std::string encodeEvent(const Event& e) {
    return json{{"v",1},{"type","EVENT"},{"event", eventToJson(e)}}.dump();
}
inline Event decodeEvent(const std::string& bytes) {
    json o = json::parse(bytes);
    if (o.value("type","") != "EVENT" || !o.contains("event")) throw std::runtime_error("unexpected envelope");
    return eventFromJson(o["event"]);
}

} // namespace qaku
