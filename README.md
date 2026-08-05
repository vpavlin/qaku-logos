# qaku-logos

A **Q&A board** rebuilt as a **local-first, peer-to-peer, end-to-end-encrypted Logos app** — a Basecamp module (desktop) + React Native mobile app that sync directly between a session's devices/participants over **SDS Reliable Channels**, no server.

Built by applying the [`logos-skills`](https://github.com/vpavlin/logos-skills) playbook to qaku's domain (sessions, questions, upvotes, answers, polls). See [`DESIGN.md`](DESIGN.md) for the event model and [`REPORT.md`](REPORT.md) for build status.

## Layout
- **`packages/`** — the portable spine (TS): `contract` (events + HLC), `engine` (fold/merge/invariant), `sync` (crypto + wire + RBSR). **Convergence property test passes 7/7** (`npm test`).
- **`qaku_core/`** — the universal C++ core module (engine mirror, crypto, delivery wiring).
- **`module/`** — the desktop `ui_qml` view (pure QML).
- **`mobile/`** — the React Native / Expo app.

## Status
The sync spine is **proven** (tests pass). The desktop `.lgx`, C++↔JS parity, and the on-device mobile build are the remaining toolchain/hardware steps — see `REPORT.md`.

## License
Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
