#!/usr/bin/env node
// Every Claude Code session start: is the QA Hub key still good, and is the company's plan active?
// What it finds becomes context for Claude — so a bad key is said once, plainly, before any work.
// Never prints the key. Never blocks the session: each call to QA Hub gets 3 s, so QA Hub being slow or
// down costs a few seconds at most. In a folder that isn't linked to QA Hub it says one short line.
import fs from "node:fs";
import path from "node:path";
import { appRoot } from "../server/index.mjs";
import { client, publishedVersion, updateNote } from "../server/qahub.mjs";

// The session's folder comes on stdin (Claude Code's hook input); give up waiting after a moment.
const input = await new Promise((ok) => {
  let raw = ""; const done = () => { process.stdin.destroy(); try { ok(JSON.parse(raw || "{}")); } catch { ok({}); } };
  process.stdin.on("data", (c) => (raw += c)); process.stdin.on("end", done); setTimeout(done, 500).unref();
});

let project = null;
try { project = JSON.parse(fs.readFileSync(path.join(appRoot(input.cwd || process.cwd()), "qahub.json"), "utf8")).project; } catch { /* not linked */ }
const linked = /^[a-z0-9-]{1,60}$/.test(project ?? "");

let text;
if (Number(process.versions.node.split(".")[0]) < 18) {
  text = `QA Hub plugin: needs Node.js 18 or newer (this computer has ${process.version}). If the user asks for tests or QA Hub, tell them to install the current Node.js from nodejs.org and restart Claude Code.`;
} else if (process.env.QAHUB_CHAT) {
  // QA Hub's recorder chat started this Claude with an address and key it just used: no check to wait on.
  text = `QA Hub plugin: running inside QA Hub's recorder chat for ${linked ? project : "this project"} — connected; use the qahub tools.`;
} else {
  const qa = client({ key: process.env.CLAUDE_PLUGIN_OPTION_API_KEY, server: process.env.CLAUDE_PLUGIN_OPTION_SERVER, timeoutMs: 3_000 });
  const latest = publishedVersion(); // in parallel with the key check; at most 2 s
  // The project and its fix requests are asked for at the same time as the key check, not after it: in a row they
  // could add two 3-second waits to every session start when QA Hub is slow. Ignored if the key check fails.
  const extra = linked ? Promise.all([qa.call("GET", `/api/v1/projects/${project}`).catch(() => null), qa.call("GET", `/api/v1/projects/${project}/fixes?shots=0`).catch(() => null)]) : null;
  try {
    const me = await qa.whoami({ fresh: true });
    const who = `QA Hub plugin: connected as ${me.user?.name ?? "?"} (${me.company?.name ?? "?"}), plan active until ${me.company?.expiresAt?.slice(0, 10) ?? "?"}.`;
    if (!linked) {
      text = `${who} This folder isn't linked to a QA Hub project. Use the qahub tools only when the user asks for tests, test automation or QA Hub (then qahub_status, and qahub_link this folder).`;
    } else {
      text = `${who} ${me.computer ? `Their computer (${me.computer.name}) is connected, so qahub_run can run tests.` : "Their computer isn't connected to QA Hub yet, so tests can be sent but not run."} When you build or change a feature, write Playwright tests for it, send them and run them with the qahub tools (see the qahub:write-tests skill).`;
      // The project's shape up front, so Claude knows where tests go before writing one.
      const [s, f] = await extra;
      if (s?.tests && s?.modules) text += ` This folder sends tests to ${project}: ${s.tests.filter((t) => !t.waitingFor).length} tests. Modules: ${s.modules.slice(0, 40).map((m) => `${m.name} (${m.path})`).join(", ") || "none yet"}${s.modules.length > 40 ? ", …" : ""}. Sets: ${s.sets?.map((x) => x.name).join(", ") || "none"}. Teammates and people recording add tests too — before writing one, read qahub_project and check qahub_find so nothing is written twice; read qahub_knowledge before the app\'s code, and qahub_learn what you read; qahub_pull before editing a shared test file.`;
      // Someone pressed "Ask Claude to fix it": Claude brings it up itself, and asks before touching code.
      const fixes = f?.fixes ?? [];
      if (fixes.length) text += ` FIX REQUESTS: a person asked you in QA Hub to fix ${fixes.length === 1 ? "a failing test" : `${fixes.length} failing tests`}: ${fixes.slice(0, 5).map((x) => `${x.ref} “${x.title}” (run #${x.run}${x.stepTitle ? `, at “${x.stepTitle}”` : ""}: ${x.plain})`).join("; ")}. Before other work, ask the user once, in plain words, e.g. "You asked me to fix “${fixes[0].title}” from run #${fixes[0].run} — shall I fix it now?" Don't change code before they say yes. On yes: qahub_fixes (it has the screenshots), find the cause, fix it, qahub_fix_note in plain words, then qahub_run the test.`;
    }
  } catch (e) {
    // An address on this computer that nothing answers: almost always a setting left from a local QA Hub (older
    // versions defaulted to http://localhost:3100). Say how to point it at the real one.
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(process.env.CLAUDE_PLUGIN_OPTION_SERVER ?? "");
    const hint = local ? ` The plugin's QA Hub address is set to ${process.env.CLAUDE_PLUGIN_OPTION_SERVER}, a QA Hub on this computer — start it, or set the address to the one shown on QA Hub's Claude setup page (/plugin → qahub → Configure).` : "";
    // Only slow (busy, or a slow network): the tools may well work — never tell Claude to stay away from them for that.
    const slow = e.code === "timeout" || e.code === "unreachable";
    text = slow
      ? `QA Hub plugin: QA Hub was slow to answer at session start (${e.message}). The qahub tools may still work — use them when needed, and only if they fail too tell the user.`
      : linked
      ? `QA Hub plugin: NOT connected — ${e.message}${hint} Until this is fixed, don't call the qahub tools; tell the user once what to do.`
      : `QA Hub plugin: not connected — ${e.message}${hint} Mention it only if the user asks for tests or QA Hub.`;
  }
  text += updateNote(await latest);
}
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
