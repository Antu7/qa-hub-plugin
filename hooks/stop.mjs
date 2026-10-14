#!/usr/bin/env node
// The one Stop hook. Two checks can each send Claude back when it is about to stop — app code changed and no tests
// pushed (build-check.mjs), and tests still looking for words taken out of the app (ui-change.mjs staleCheck). As
// two separate hooks they could both block the same stop, so Claude got sent back twice with two messages; here
// they run together and answer once, with both reasons. Each keeps its own guards (stop_hook_active, once per
// session); errors never block.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMain } from "../server/qahub.mjs";
import { buildCheck } from "./build-check.mjs";
import { staleCheck } from "./ui-change.mjs";

/** Both checks' answers as one Stop answer, or null. */
export function stopCheck(input, transcript, { seen, state }) {
  const reasons = [];
  for (const check of [() => buildCheck(input, transcript, seen), () => staleCheck(input, state)]) {
    try { const out = check(); if (out?.decision === "block") reasons.push(out.reason); } catch { /* never block on an error */ }
  }
  return reasons.length ? { decision: "block", reason: reasons.join("\n\n") } : null;
}

if (isMain(import.meta.url)) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(raw || "{}");
      const transcript = input.transcript_path ? fs.readFileSync(input.transcript_path, "utf8") : "";
      const id = String(input.session_id ?? "nosession").replace(/[^\w-]/g, "").slice(0, 80);
      const out = stopCheck(input, transcript, {
        seen: path.join(os.tmpdir(), `qahub-build-${id}`),
        state: path.join(os.tmpdir(), `qahub-ui-${id}.json`),
      });
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* never block */ }
  });
}
