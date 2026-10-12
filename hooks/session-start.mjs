#!/usr/bin/env node
// Every Claude Code session start: is the QA Hub key still good, and is the company's plan active?
// What it finds becomes context for Claude — so a bad key is said once, plainly, before any work.
// Never prints the key. Never blocks the session: QA Hub being down must not stop someone coding.
import fs from "node:fs";
import path from "node:path";
import { client } from "../server/qahub.mjs";
import { appRoot } from "../server/index.mjs";

// The session's folder comes on stdin (Claude Code's hook input); give up waiting after a moment.
const input = await new Promise((ok) => {
  let raw = ""; const done = () => { process.stdin.destroy(); try { ok(JSON.parse(raw || "{}")); } catch { ok({}); } };
  process.stdin.on("data", (c) => (raw += c)); process.stdin.on("end", done); setTimeout(done, 500).unref();
});

const qa = client({ key: process.env.CLAUDE_PLUGIN_OPTION_API_KEY, server: process.env.CLAUDE_PLUGIN_OPTION_SERVER || "http://localhost:3100" });
let text;
try {
  const me = await qa.whoami({ fresh: true });
  text = `QA Hub plugin: connected as ${me.user?.name ?? "?"} (${me.company?.name ?? "?"}), plan active until ${me.company?.expiresAt?.slice(0, 10) ?? "?"}. ${me.computer ? `Their computer (${me.computer.name}) is connected, so qahub_run can run tests.` : "Their computer isn't connected to QA Hub yet, so tests can be sent but not run."} When you build or change a feature, write Playwright tests for it, send them and run them with the qahub tools (see the qahub:write-tests skill).`;
  // In a linked folder: the project's shape up front, so Claude knows where tests go before writing one.
  let project = null;
  try { project = JSON.parse(fs.readFileSync(path.join(appRoot(input.cwd || process.cwd()), "qahub.json"), "utf8")).project; } catch { /* not linked */ }
  if (/^[a-z0-9-]{1,60}$/.test(project ?? "")) {
    const s = await qa.call("GET", `/api/v1/projects/${project}`).catch(() => null);
    if (s) text += ` This folder sends tests to ${project}: ${s.tests.length} tests. Modules: ${s.modules.slice(0, 40).map((m) => `${m.name} (${m.path})`).join(", ") || "none yet"}${s.modules.length > 40 ? ", …" : ""}. Sets: ${s.sets?.map((x) => x.name).join(", ") || "none"}. Teammates and people recording add tests too — before writing one, read qahub_project and check qahub_find so nothing is written twice; qahub_pull before editing a shared test file.`;
  }
} catch (e) {
  text = `QA Hub plugin: NOT connected — ${e.message} Until this is fixed, don't call the qahub tools; tell the user once what to do.`;
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
