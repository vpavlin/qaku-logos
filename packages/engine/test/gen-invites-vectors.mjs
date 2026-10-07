// Regenerate vectors/invites.json from invites-cases.mjs + the JS engine's fold (qaku ADR 0001).
// Signatures are deterministic (RFC6979), so an unchanged scenario regenerates byte-identically.
// Re-run the C++ harness afterwards (qaku_core/test/engine_harness.cpp) - it must agree.
//   node packages/engine/test/gen-invites-vectors.mjs
import { writeFileSync } from "node:fs";
import { computeState } from "../src/engine.mjs";
import { project } from "./rules-cases.mjs";
import { inviteEvents, ROOM, addr } from "./invites-cases.mjs";

const events = inviteEvents();
const out = [{ name: "invite tickets (qaku ADR 0001)", roomId: ROOM, addr, events, expect: project(computeState(events, { roomId: ROOM })) }];
writeFileSync(new URL("./vectors/invites.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${out.length} case(s), ${events.length} events`);
