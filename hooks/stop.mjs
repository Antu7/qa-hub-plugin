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
import { editingRef, keepGoing, leftOf } from "./keep-going.mjs";
import { appRoot, building, reviewState } from "../server/index.mjs";
import { client } from "../server/qahub.mjs";

/** Both checks' answers as one Stop answer, or null. */
export function stopCheck(input, transcript, { seen, state }) {
  const reasons = [];
  for (const check of [() => buildCheck(input, transcript, seen), () => staleCheck(input, state)]) {
    try { const out = check(); if (out?.decision === "block") reasons.push(out.reason); } catch { /* never block on an error */ }
  }
  return reasons.length ? { decision: "block", reason: reasons.join("\n\n") } : null;
}

/** The last thing Claude said, from the transcript (JSONL): "Needs you:" lets it stop. */
function lastText(transcript) {
  const lines = transcript.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.type !== "assistant") continue;
      const text = (e.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (text) return text;
    } catch { /* not JSON */ }
  }
  return "";
}

/** Tests Claude is building here that aren't done: back to work (keep-going.mjs). Counted per session. */
async function keepGoingCheck(input, transcript, roundsFile) {
  const root = appRoot(input.cwd || process.cwd());
  const focus = editingRef(transcript);
  const refs = building(root).filter((r) => !focus || r === focus);
  if (!refs.length) return null;
  const project = JSON.parse(fs.readFileSync(path.join(root, "qahub.json"), "utf8")).project;
  if (!/^[a-z0-9-]{1,60}$/.test(project ?? "")) return null;
  const qa = client({ key: process.env.CLAUDE_PLUGIN_OPTION_API_KEY, server: process.env.CLAUDE_PLUGIN_OPTION_SERVER, timeoutMs: 8_000 });
  const left = leftOf((await reviewState(qa, project)).tests, refs);
  let rounds = { n: 0, waits: 0 };
  try { rounds = JSON.parse(fs.readFileSync(roundsFile, "utf8")); } catch { /* first stop */ }
  const out = keepGoing(left, rounds, input.last_assistant_message ?? lastText(transcript));
  if (out) fs.writeFileSync(roundsFile, JSON.stringify({ n: rounds.n + 1, waits: rounds.waits + (left.write.length + left.fix.length ? 0 : 1) }));
  return out;
}

if (isMain(import.meta.url)) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", async () => {
    try {
      const input = JSON.parse(raw || "{}");
      const transcript = input.transcript_path ? fs.readFileSync(input.transcript_path, "utf8") : "";
      const id = String(input.session_id ?? "nosession").replace(/[^\w-]/g, "").slice(0, 80);
      const first = stopCheck(input, transcript, {
        seen: path.join(os.tmpdir(), `qahub-build-${id}`),
        state: path.join(os.tmpdir(), `qahub-ui-${id}.json`),
      });
      const more = await keepGoingCheck(input, transcript, path.join(os.tmpdir(), `qahub-keep-${id}.json`)).catch(() => null);
      const reasons = [first?.reason, more?.reason].filter(Boolean);
      if (reasons.length) process.stdout.write(JSON.stringify({ decision: "block", reason: reasons.join("\n\n") }));
    } catch { /* never block */ }
  });
}
