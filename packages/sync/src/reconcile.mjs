// RBSR reconciliation — now SOURCED FROM loam-sync (single source), not a qaku copy.
// loam-sync's reconcile/toItems/fingerprintIds are byte-identical to qaku's originals
// (same (wall,id) ordering + XOR-of-SHA256 fingerprint layout, the cross-language parity
// contract). Imported from the in-tree loam-sync submodule's dist by RELATIVE path (qaku's
// packages are bare .mjs, no npm workspace / no "loam-sync" specifier). Only the app-only
// eventsToSend helper stays here.
export { reconcile, toItems, fingerprintIds } from "../../loam-sync/dist/reconcile.js";

/** The events A must receive from B so both converge (app helper). */
export function eventsToSend(fromEvents, needIds) {
  const need = new Set(needIds);
  return fromEvents.filter((e) => need.has(e.id));
}
