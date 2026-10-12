#!/usr/bin/env node
// Before `git push`: if this app's latest QA Hub run has failing tests, Claude Code asks the person first
// (the plan's "a gate warns if tests are failing"). Quiet when everything passed, when nothing is linked,
// and when QA Hub can't be reached — a check that fails must never block someone's push. Never prints the key.
import fs from "node:fs";
import path from "node:path";
import { appRoot } from "../server/index.mjs";
import { client } from "../server/qahub.mjs";

export async function pushCheck(input, env = process.env) {
  const cmd = String(input?.tool_input?.command ?? "");
  if (!/(^|[\s;&|(])git\s+(-\S+\s+)*push\b/.test(cmd)) return null;
  let project;
  try { project = JSON.parse(fs.readFileSync(path.join(appRoot(input.cwd || process.cwd()), "qahub.json"), "utf8")).project; } catch { return null; }
  if (!/^[a-z0-9-]{1,60}$/.test(project ?? "")) return null;
  try {
    const qa = client({ key: env.CLAUDE_PLUGIN_OPTION_API_KEY, server: env.CLAUDE_PLUGIN_OPTION_SERVER || "http://localhost:3100" });
    const { run } = await qa.call("GET", `/api/v1/projects/${project}/runs/latest`);
    if (run?.status !== "finished" || !run.failed) return null;
    const names = run.failures.slice(0, 3).map((f) => `${f.ref} “${f.title}”`).join(", ");
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask",
      permissionDecisionReason: `QA Hub's latest run of ${project} (run #${run.number}: ${run.failed} test${run.failed === 1 ? "" : "s"} failing — ${names}${run.failed > 3 ? ", …" : ""}). Push anyway? ${qa.origin()}${run.url}` } };
  } catch { return null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", async () => {
    try { const out = await pushCheck(JSON.parse(raw || "{}")); if (out) process.stdout.write(JSON.stringify(out)); } catch { /* never block */ }
  });
}
