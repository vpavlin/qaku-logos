# Changelog

## v0.1.7 — on-disk persistence (sessions + messages survive restart)

qaku_core was fully in-memory: every Q&A session and message was lost on a module
or host restart. This release ports KYM's proven per-tenant persistence so state
is durable. Transparent to the view and mobile - no API change, no UI change.

### qaku_core 0.1.4 (engine + sync core)
- New `qaku_persist_std.hpp`: std-only, no-Qt/no-delivery persistence primitives
  (pair.key / log.json / sessions.json / device.txt read+write). Robust by design -
  a missing or corrupt file is skipped, never fatal.
- Writable data dir `QAKU_CORE_DATA` (hub/tests) else `$HOME/.qaku-core`, resolved
  in `onContextReady()`. Each session persists under `<root>/<id>/`: `pair.key`
  (raw 32-byte secret) + `log.json` (event log as a JSON array). A `<root>/sessions.json`
  registry holds display order + titles + the current selection; `<root>/device.txt`
  keeps the device id stable across restarts.
- Loads on start (`loadSessions()`): reads the registry, re-derives each session's
  identity/topic from its `pair.key`, folds its `log.json`, restores order + current;
  first run creates + persists the default session (in-place migration).
- Persists on change: `pushEvent` rewrites the session log (and merges any concurrent
  on-disk writes first, so two Basecamp instances sharing the dir can't clobber each
  other); `createSession`/`joinSession`/`switchSession`/`deleteSession`/`setConfig`
  update the registry; `deleteSession` removes the session dir; `setDeviceId` writes
  `device.txt`. All writes guard on a non-empty data dir.
- Verified with a compiled restart-survival harness (`test/persist_harness.cpp`):
  create a session + append a question, tear down, reconstruct from the same
  `QAKU_CORE_DATA` dir, assert the session title + message + fingerprint come back.

### qaku view 0.1.7 (Basecamp ui_qml)
- No view code change; rebuilt to bundle qaku_core 0.1.4 (persistence).

### qaku mobile
- Unchanged this release (persistence is a qaku_core-only, desktop/hub concern).

## v0.1.5 — QR sharing + secret-in-URL sharing model

Sharing a Q&A is now a scannable artifact. The shareable secret is formalized as
a URI, `qaku://join?s=<64-hex secret>`, that carries everything a peer needs: the
32-byte secret derives BOTH the Waku topic AND the AEAD payload key (HKDF/HMAC),
so every message is end-to-end encrypted and the secret IS the password - the
same secret-in-URL model as the original qaku's password-in-URL, minus a server.

### qaku_core 0.1.3 (engine + sync core)
- Vendored Nayuki's MIT `qrcodegen.{hpp,cpp}` into the core (the host `qr` module
  is unreachable from a pure-QML view - see basecamp-qr-core-unreachable).
- New actions: `shareUri()` returns `qaku://join?s=<secret>` for the current
  session; `shareQr()` encodes that URI as a QR matrix `{ok,n,cells,text}` (MEDIUM
  ECC) for the view's Canvas to paint.
- `joinSession(code)` now accepts EITHER a raw 64-hex secret OR a `qaku://join?s=`
  URI (prefix stripped), so a scanned QR and a pasted secret share one join path.
- `snapshot()` adds a `shareUri` field.

### qaku view 0.1.5 (Basecamp ui_qml)
- The "Share this Q&A" card now renders the QR on a plain QtQuick `Canvas`
  (host-safe on every Basecamp version) beside a copyable share link and secret.
- Host-safe controls only (`LogosText` + `LogosButton` + themed `AppField` +
  `Canvas`) - no `LogosTextField`/`LogosCopyableText`/`variant`.
- The sidebar Join field accepts a `qaku://join` link as well as a 64-hex secret.

### qaku mobile 0.1.5 (vc5)
- Added `expo-camera`, `react-native-qrcode-svg`, `react-native-svg`.
- "Scan QR" button opens the camera and joins from a scanned `qaku://join?s=<hex>`
  (or raw secret) via the existing `session.start`; camera permission declared via
  the `expo-camera` config plugin (survives `expo prebuild`).
- After joining, the current session's `qaku://join` URI is shown as a QR so
  another phone can scan it. Paste-secret / paste-link Join is kept too.

## v0.1.3 — multi-session + sidebar

QAKU becomes a proper multi-session app, matching the original qaku's UX: a
device now holds SEVERAL Q&As at once, each with its own secret -> identity ->
topic -> log -> role, all syncing peer-to-peer in the background; you view/edit
the CURRENT one. The core is modeled on KYM's multi-budget engine (a
`std::map<id, Session>` + display order + current + `cur()`).

### qaku_core 0.1.2 (engine + sync core)
- New session registry: `struct Session` in `m_sessions`, `m_order`, `m_current`,
  `cur()`, `sessionForTopic()`. The old single session migrates into the map on
  load.
- New actions: `createSession(title, description)` (fresh random secret, reuses an
  empty current slot), `joinSession(secretHex)` (adds a NEW session from a pasted
  64-hex secret, or switches if already held), `switchSession(id)`,
  `deleteSession(id)`, `listSessions()`. Every existing action
  (addQuestion/upvote/postAnswer/moderate/createPoll/votePoll/...) now targets
  `cur()`.
- `snapshot()` returns BOTH a `sessions` array (id, title, fingerprint, role,
  questions, open, current) AND the current session's full detail
  (questions/answers/polls) + its shareable `secret` hex + `fingerprint` + `role`.
- Transport is per session: incoming channel/relay messages route by content topic
  to the owning session (`ingestPayload` -> `sessionForTopic`), and delivery joins
  + seeds EVERY session on node-ready (background sync for all).

### qaku view 0.1.3 (Basecamp ui_qml)
- Rebuilt as a sidebar app on the Logos design system (Logos.Theme +
  Logos.Controls): a LEFT SIDEBAR (QAKU header, a primary "+ New Q&A" with an
  inline title/description form, a "Join a Q&A" secret-paste affordance, a
  scrollable session list showing title + role + question count + short
  fingerprint with the current one highlighted, a Settings device-name field, and
  a live status line) + a MAIN PANE for the current session (header with
  Open/Closed, the Share-this-Q&A `LogosCopyableText` secret card, the Ask box,
  the upvote/answer/moderation question list, and polls).

### mobile 0.1.3 / versionCode 4
- Version bump; the phone folds via the shared JS engine directly (independent of
  the core's snapshot shape), so join/sync is unchanged and still builds arm64.

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
