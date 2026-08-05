# qaku-logos

A **Q&A board** rebuilt as a **local-first, peer-to-peer, end-to-end-encrypted Logos app** — a Basecamp module (desktop) + React Native mobile app that sync directly between a session's devices/participants over **SDS Reliable Channels**, no server.

Built by applying the [`logos-skills`](https://github.com/vpavlin/logos-skills) playbook to qaku's domain (sessions, questions, upvotes, answers, polls). See [`DESIGN.md`](DESIGN.md) for the event model and [`CHANGELOG.md`](CHANGELOG.md) for release history.

## Layout
- **`packages/`** — the portable spine (TS): `contract` (events + HLC), `engine` (fold/merge/invariant), `sync` (crypto + wire + RBSR). **Convergence property test passes 7/7** (`npm test`).
- **`qaku_core/`** — the universal C++ core module (engine mirror, crypto, delivery wiring).
- **`module/`** — the desktop `ui_qml` view (pure QML).
- **`mobile/`** — the React Native / Expo app.

## Install (v0.1.0)
Artifacts are attached to the [GitHub release](https://github.com/vpavlin/qaku-logos/releases).
- **Desktop (Basecamp):** in Basecamp → Settings → Package Repositories add
  `https://github.com/vpavlin/qaku-logos/releases/download/v0.1.0/logos-repo.json`,
  then install **qaku_core** (the engine/sync core) and **qaku** (the view).
- **Android:** install `qaku-0.1.0-arm64.apk` on a real arm64 phone (no x86_64
  build; an emulator will not load the embedded Waku node).

## Status
The sync spine is **proven** (`npm test` 7/7 — convergence property test + golden
vectors). The two desktop `.lgx`s and the arm64 APK build and package; see
[`CHANGELOG.md`](CHANGELOG.md) for what is wired vs. still scaffolded (the desktop
core's delivery_module transport calls are the next increment).

## License
Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
