# qaku-logos

A **Q&A board** rebuilt as a **local-first, peer-to-peer, end-to-end-encrypted Logos app** — a Basecamp module (desktop) + React Native mobile app that sync directly between a session's devices/participants over **Logos Delivery**, no server.

Built by applying the [`logos-skills`](https://github.com/vpavlin/logos-skills) playbook to qaku's domain (sessions, questions, upvotes, answers, polls). See [`DESIGN.md`](DESIGN.md) for the event model and [`CHANGELOG.md`](CHANGELOG.md) for release history.

## Layout
- **`packages/`** — the portable spine (TS): `contract` (events + HLC), `engine` (fold/merge/invariant), `sync` (crypto + wire + RBSR). **Convergence property test passes 7/7** (`npm test`).
- **`qaku_core/`** — the universal C++ core module (engine mirror, crypto, delivery wiring).
- **`module/`** — the desktop `ui_qml` view (pure QML).
- **`mobile/`** — the React Native / Expo app.

## Install
Both are published at [apps.vpavlin.xyz](https://apps.vpavlin.xyz/). Website: <https://vpavlin.github.io/qaku-logos/>.
- **Android (arm64 only):** in F-Droid add the repository
  `https://apps.vpavlin.xyz/fdroid/repo?fingerprint=2373710A76ACB09F287F053E99E533F9D3685529C44E9027CDBC79B1DC0C9105`,
  then install **QAKU**. [Loam](https://vpavlin.github.io/loam/) (same repository) is recommended: all
  Logos apps on the phone then share one node. Without Loam, QAKU runs its own node.
- **Desktop (Basecamp 0.2.x):** in Basecamp → Settings → Package Repositories add
  `https://apps.vpavlin.xyz/logos-repo.json`, then install **qaku**. It pulls in
  **qaku_core** (engine + sync), which pulls in **loam_core** and its dependencies.
  Basecamp 0.3 support is in progress (`port/0.3` branch).

## Status
Questions, upvotes, answers, moderation and polls sync between the Android app and
Basecamp over Logos Delivery (via loam_core), with catch-up backfilling missed events.
The sync spine has a convergence property test + golden vectors (`npm test`).
See [`CHANGELOG.md`](CHANGELOG.md) for release history.

## License
Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
