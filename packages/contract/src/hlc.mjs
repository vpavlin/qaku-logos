// Hybrid Logical Clock — now SOURCED FROM loam-sync (single source of truth), not a
// qaku copy. loam-sync's Clock is a superset: an injectable time source (ctor, default
// Date.now) makes send() argless-capable, primeFrom(log) seeds from the persisted log on
// boot, and receive() is observe-only (send() owns the counter bump) — so qaku's existing
// call sites (new Clock(dev[, now]), c.send(), clock.receive(hlc)) work unchanged.
//
// Imported from the in-tree loam-sync submodule's built dist by RELATIVE path (qaku's
// packages are bare .mjs with no npm workspace, so there is no "loam-sync" specifier to
// resolve here). We import from the SPECIFIC dist file (event.js) rather than dist/index.js
// on purpose: index.js re-exports signing.js (the OPTIONAL @noble/curves-v2 auth layer),
// which qaku does NOT use — it keeps its own v1 secp256k1 signing in identity.mjs.
export { Clock, compareHlc } from "../../loam-sync/dist/event.js";

/** @typedef {{ wall:number, ctr:number, dev:string }} HLC */
