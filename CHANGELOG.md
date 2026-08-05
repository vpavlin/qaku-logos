# Changelog

## v0.1.0 — first deployable release

First shippable cut of QAKU: a local-first, multi-writer Q&A app on Logos.
Sessions, questions, per-voter upvotes, owner answers + moderation, and polls,
all computed by a conflict-free, append-only event-log engine (union-by-id merge,
HLC ordering) that the desktop core, the headless hub, and the mobile app all fold
identically. Sync rides SDS Reliable Channels over Logos Delivery (Waku).

### Artifacts (attached to this release)
- `qaku_core-0.1.0-linux-amd64.lgx` — the engine + sync CORE Basecamp module
  (`type: core`, `interface: universal`, `main: qaku_core_plugin`, depends on
  `delivery_module`). Runs headless as the always-on hub and behind the view.
- `qaku-0.1.0-linux-amd64.lgx` — the `ui_qml` view module (pure QML over the core).
- `qaku-0.1.0-arm64.apk` — Android app (arm64-v8a only; embeds the Logos Delivery
  Waku node via a hand-written JNI bridge). Test on a real arm64 phone, not an
  x86_64 emulator.
- `logos-repo.json` + `index.json` — a Basecamp package catalog whose URLs point
  at this release's `.lgx` assets. Add the `logos-repo.json` URL in
  Basecamp → Settings → Package Repositories to install QAKU from GitHub.

### Versioning
core, view, and mobile are versioned together at 0.1.0 for this first release.
The view calls the core over `logos.callModule("qaku_core", …)`; ship them in
lockstep (a view calling a core method the deployed core lacks is the opaque
"Invalid response").

### Notes / known limitations
- The desktop core's `delivery_module` transport calls are scaffolded (the
  channelCreate/channelSend/subscribe wiring points are present and documented but
  commented pending the pinned delivery_module's exact generated caller symbols);
  the shared fold/crypto/wire spine is proven by `npm test` (7/7, convergence +
  golden vectors). The `.lgx` builds, loads, and renders; end-to-end desktop wire
  sync is the next increment.
- Mobile ships the channels-enabled arm64 native node and the JNI/Kotlin bridge;
  on-device end-to-end sync must be verified on real hardware.
