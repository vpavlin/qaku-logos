// Regenerate vectors/rules.json from rules-cases.mjs + the JS engine's fold. Run after a
// deliberate rule change, review the diff, then re-run the C++ harness
// (qaku_core/test/engine_harness.cpp) - it must agree with the new file byte-for-byte.
//   node packages/engine/test/gen-rules-vectors.mjs
import { writeFileSync } from "node:fs";
import { computeState } from "../src/engine.mjs";
import { cases, project } from "./rules-cases.mjs";

const out = cases.map((c) => ({ name: c.name, ...(c.me ? { me: c.me } : {}), events: c.events, expect: project(computeState(c.events, { me: c.me })) }));
writeFileSync(new URL("./vectors/rules.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${out.length} cases`);
