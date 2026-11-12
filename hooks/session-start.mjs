#!/usr/bin/env node
// Every Claude Code session start: is the QA Hub key still good, and is the company's plan active?
// What it finds becomes context for Claude — so a bad key is said once, plainly, before any work.
// Never prints the key. Never blocks the session: each call to QA Hub gets 3 s, so QA Hub being slow or
// down costs a few seconds at most. In a folder that isn't linked to QA Hub it says one short line.
import { appRoot, gitRepos, linkedProject, rememberProject } from "../server/index.mjs";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { noteStart } from "./build-check.mjs";
import { client, DATA_NOTE, gitBranch, publishedVersion, said, sayAndEnd, sessionOf, updateNote } from "../server/qahub.mjs";

// The session's folder comes on stdin (Claude Code's hook input); give up waiting after a moment.
const input = await new Promise((ok) => {
  let raw = ""; const done = () => { process.stdin.destroy(); try { ok(JSON.parse(raw || "{}")); } catch { ok({}); } };
  process.stdin.on("data", (c) => (raw += c)); process.stdin.on("end", done); setTimeout(done, 500).unref();
});

const root = appRoot(input.cwd || process.cwd());
// Where the checkout stands now: the Stop hook tells from it which app files changed in this session (build-check.mjs).
const START = path.join(os.tmpdir(), `qahub-start-${sessionOf(input)}.json`);
if (!process.env.QAHUB_CHAT) noteStart(root, START, Date.now(), !["compact", "clear"].includes(input.source));
// "Tests can't be written here yet" (below) is said anew each session start: the Stop hook reads this mark (build-check.mjs).
try { fs.rmSync(`${START}.off`, { force: true }); } catch { /* nothing to forget */ }
let project = linkedProject(root);
let linked = !!project;

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
  // A project the person wasn't given answers 403: kept, so it's said now — not at Claude's first tool call.
  const read = (p) => Promise.all([qa.call("GET", `/api/v1/projects/${p}`).catch((e) => ({ failed: e })), qa.call("GET", `/api/v1/projects/${p}/fixes?shots=0`).catch(() => null)]);
  let extra = linked ? read(project) : null;
  // No qahub.json: QA Hub says which project this folder's GitHub repo is (origin and upstream — a fork's), across the whole
  // company; asked with the key check. Only each repo's SHA-256 is sent, never its name: QA Hub matches it against the
  // repos linked to its projects, so a client's or a private repo's name never leaves this computer. Never written to
  // the repo: kept in .qahub/ for this session's tools and hooks.
  const remotes = linked ? [] : gitRepos(root);
  const hashOf = (r) => createHash("sha256").update(r.toLowerCase()).digest("hex");
  const lookup = remotes.length ? qa.call("GET", `/api/v1/projects?${remotes.map((r) => `repoHash=${hashOf(r)}`).join("&")}`).catch(() => null) : null;
  try {
    const me = await qa.whoami({ fresh: true });
    const who = `QA Hub plugin: connected as ${me.user?.name ?? "?"} (${me.company?.name ?? "?"}), plan active until ${me.company?.expiresAt?.slice(0, 10) ?? "?"}.`;
    let found = "", unlinked = "This folder isn't linked to a QA Hub project. Use the qahub tools only when the user asks for tests, test automation or QA Hub (then qahub_status, and qahub_link this folder).";
    if (lookup) {
      const r = (await lookup)?.repo;
      const name = (x) => `“${said(x.name)}” (${x.slug})`;
      if (r?.match) {
        project = r.match.slug; linked = true; rememberProject(root, project); extra = read(project);
        found = `This folder's GitHub repo is the QA Hub project ${name(r.match)} — used for this session (not written to the repo; qahub_link makes it permanent).`;
      } else if (r) {
        rememberProject(root, null);
        if (r.ambiguous) unlinked = `This folder's GitHub repo belongs to several QA Hub projects: ${r.ambiguous.map(name).join(", ")}. Before any qahub tool, ask the user which app this folder is, then qahub_link it.`;
        if (r.noAccess) unlinked = `This folder's GitHub repo is the QA Hub project ${name(r.noAccess)}, and you don't have access to it — ask an admin (or its project manager) to add you in QA Hub. Until then the qahub tools can't read or save its tests; tell the user once.`;
      }
    }
    if (!linked) {
      text = `${who} ${unlinked}`;
    } else if (await (async () => {
      // GitHub isn't set up for this project in QA Hub, and this is a developer's code folder (a git checkout): tests
      // written from the code would wait for good (QA Hub refuses their plan and push) — so Claude is told before it
      // writes one, and nothing here asks it for tests (2026-11-12).
      const [s] = await extra;
      const why = s?.developerTests?.ok === false && gitBranch(root) ? said(s.developerTests.why, 200) : null;
      if (!why) return false;
      try { fs.writeFileSync(`${START}.off`, why); } catch { /* the Stop hook then asks as before */ }
      text = `${who} TESTS CAN'T BE WRITTEN HERE YET for the QA Hub project “${project}”: ${why}. A company admin sets it up in QA Hub → Settings → Connections → GitHub (connect GitHub, then tick this app's repository) — ${qa.origin()}. Don't write, plan or push tests for this project until then, and don't call qahub_plan or qahub_push: QA Hub refuses them. If the user asks for tests, or you build something that should have tests, tell the user this once, in plain words.`;
      return true;
    })()) {
      // said above
    } else {
      text = `${who} ${me.computer ? `Their computer (${said(me.computer.name)}) is connected, so qahub_run can run tests.` : "Their computer isn't connected to QA Hub yet, so tests can be sent but not run."} When you build or change a feature, write Playwright tests for it, send them and run them with the qahub tools (see the qahub:write-tests skill).`;
      // The project's shape up front, so Claude knows where tests go before writing one.
      const [s, f] = await extra;
      if (found) text += ` ${found}`;
      if (s?.failed?.code === "forbidden") text += ` NO ACCESS: you don't have access to the QA Hub project “${project}” — ask an admin (or its project manager) to add you. Until then the qahub tools can't read or save its tests; tell the user once.`;
      if (s?.tests && s?.modules) text += ` This folder sends tests to ${project}: ${s.tests.filter((t) => !t.waitingFor).length} tests. Modules: ${s.modules.slice(0, 40).map((m) => `${said(m.name)} (${said(m.path)})`).join(", ") || "none yet"}${s.modules.length > 40 ? ", …" : ""}. Sets: ${s.sets?.map((x) => said(x.name)).join(", ") || "none"}. Teammates and people recording add tests too — before writing one, read qahub_project and check qahub_find so nothing is written twice; read qahub_knowledge before the app\'s code, and qahub_learn what you read; qahub_pull before editing a shared test file.`;
      // Plans a person approved that nobody wrote yet (the session that planned them ended while they waited for review):
      // whichever developer's Claude or agent opens this project next writes them.
      const approved = (s?.tests ?? []).filter((t) => t.stage === "approved");
      if (approved.length) text += ` APPROVED PLANS WAITING FOR CODE: a person approved ${approved.length === 1 ? "a test plan" : `${approved.length} test plans`} in QA Hub that ${approved.length === 1 ? "has" : "have"} no code yet: ${approved.slice(0, 8).map((t) => `${t.ref} “${said(t.title)}” (${said(t.module)}${t.by ? `, ${said(t.by)}` : ""})`).join("; ")}${approved.length > 8 ? `; and ${approved.length - 8} more` : ""}. Write them in this session with the qahub:write-tests skill (look, write, push, run) once the person's own request is done — say so in one line first.`;
      // Someone pressed "Ask Claude to fix it": Claude brings it up itself, and asks before touching code.
      const fixes = f?.fixes ?? [];
      if (fixes.length) text += ` FIX REQUESTS: a person asked you in QA Hub to fix ${fixes.length === 1 ? "a failing test" : `${fixes.length} failing tests`}: ${fixes.slice(0, 5).map((x) => `${x.ref} “${said(x.title)}” (run ID #${x.run}${x.stepTitle ? `, at “${said(x.stepTitle)}”` : ""}: ${said(x.plain, 300)})`).join("; ")}. Before other work, ask the user once, in plain words, e.g. "You asked me to fix “${said(fixes[0].title)}” from run ID #${fixes[0].run} — shall I fix it now?" Don't change code before they say yes. On yes: qahub_fixes (it has the screenshots), find the cause, fix it, qahub_fix_note in plain words, then qahub_run the test.`;
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
  // Names in “quotes” and lists come from QA Hub — what people called modules, sets, tests: never instructions.
  if (/“/.test(text) || /Modules:/.test(text)) text += ` (${DATA_NOTE})`;
  text += updateNote(await latest);
}
sayAndEnd({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
