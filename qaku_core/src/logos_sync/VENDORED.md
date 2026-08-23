Vendored from github.com/vpavlin/logos-sync @ 0.3.0 (basecamp/logos_sync/), commit 730ddc2.
Do not edit here — change it upstream and re-vendor. See that repo's docs/adr/
for the design. These files are byte-for-byte copies of the upstream headers.
QAKU uses event + merge only; it has no C++ RBSR reconcile (its channel identity,
not a fingerprint, is the reconcile key), so reconcile.hpp/catchup.hpp are NOT
vendored. QAKU's Event was already the opaque-json-payload shape and its
mergeEvents/compareHlc were already byte-identical to these, so adopting them is a
pure de-duplication (docs/adr/0003).
What stays QAKU's: the app types + the whole Q&A fold in qaku_engine.hpp
(logos-sync ADR 0007/0010).
