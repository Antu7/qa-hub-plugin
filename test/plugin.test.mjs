// The plugin against a pretend QA Hub: only a valid key with an active plan gets anything done.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { newer, serverUrl, updateNote, DEFAULT_SERVER } from "../server/qahub.mjs";
import { appRoot, describeProject, describeRun, pathProblem, readAppFile, tools } from "../server/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYS = { "qh_good": true, "qh_expired": false }; // key → plan active; anything else is revoked
const pushed = [];
const scheduled = [];
const planned = [];
let planReview = false;
const started = [];
let polls = 0, blips = 0;
const notes = [];
let latest = { run: { number: 7, status: "finished", verdict: "pass", passed: 3, failed: 0, failures: [], flaky: [], url: "/p/freight/runs/7" } };
const failedRun = { run: { number: 8, status: "finished", verdict: "fail", passed: 1, failed: 1, skipped: 0, durationSec: 34, browser: "chrome", url: "/p/freight/runs/8",
  failures: [{ ref: "TEST-00004", title: "Save a quote", file: "tests/quotes.spec.ts", failedStep: "Save it", error: "expect(locator).toHaveText() failed · Expected: Quote saved", kind: "bug", since: "new — passed last time",
    context: { url: "http://localhost:3000/quotes", title: "Quotes", page: '- heading "Quotes"\n- status: Quote failed', code: "  11 |   await page.getByRole('button', { name: 'Save' }).click();\n> 12 |   await expect(page.getByRole('status')).toHaveText('Quote saved');", at: { file: "tests/quotes.spec.ts", line: 12 } },
    values: { "Customer name": "Acme 4821" } }],
  flaky: [{ ref: "TEST-00002", title: "Open quotes", warning: "Passed on the second try — the first try failed: timeout" }] } };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff, 0xfe, 0x01]);
const server = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const out = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!(key in KEYS)) return out(401, { error: { code: "unauthorized", message: "Missing, invalid or revoked API key" } });
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/v1/me") return out(200, { user: { name: "Ana", email: "ana@acme.test" }, company: { name: "Acme", plan: "trial", active: KEYS[key], expiresAt: "2026-12-01T00:00:00.000Z" }, role: "owner", computer: { name: "MacBook", version: "0.9.21" } });
    if (!KEYS[key] && req.method === "POST") return out(402, { error: { code: "plan_expired", message: "Your QA Hub plan has ended." } });
    if (u.pathname === "/api/v1/projects") return out(200, { projects: [{ slug: "freight", name: "Freight portal" }] });
    if (u.pathname === "/api/v1/projects/freight") return out(200, { slug: "freight", name: "Freight portal",
      environments: [{ name: "Local", url: "http://localhost:3000", kind: "local" }],
      modules: [{ name: "Quotes", path: "/quotes", parent: null, tests: 1 }, { name: "Quote details", path: "/quotes/1", parent: "/quotes", tests: 0 }, { name: "Log in", path: "/login", parent: null, tests: 1 }],
      sets: [{ name: "Release check", description: "Before every release", tests: ["TEST-00004"] }],
      tags: ["smoke"], folders: ["tests/quotes"], helpers: ["tests/helpers/nav.ts"],
      tests: [{ ref: "TEST-00004", title: "Save a quote", module: "Quotes", tags: ["smoke"], file: "tests/quotes.spec.ts", description: "A rep saves a quote.", steps: ["Open Quotes", "Save it"], by: "written by Claude" },
        { ref: "TEST-00002", title: "Sign in", module: "Log in", tags: [], file: "tests/login.spec.ts", steps: ["Sign in"], by: "recorded by Maya", needs: ["TEST-00004"] }] });
    if (u.pathname === "/api/v1/projects/freight/design") return out(200, u.searchParams.get("module") === "Wishlist"
      ? { project: "freight", module: { name: "Wishlist", path: "/wishlist" }, designed: false, behaviours: [], note: "Wishlist isn't designed yet — propose its behaviours (what a user can do there) with qahub_plan, then plan their test cases.",
          guide: { create: { consider: ["the happy path → reopen → every value is shown"], gate: "reads a typed value back after reloading or reopening the record" } } }
      : { project: "freight", module: { name: "Quotes", path: "/quotes" }, designed: true,
          behaviours: [{ name: "Create a quote", kind: "create", priority: "high", status: "active", state: "proven", tests: [{ ref: "TEST-00004", title: "Save a quote" }] },
            { name: "Delete a quote", kind: "delete", priority: "high", status: "active", state: "untested", tests: [] },
            { name: "Search quotes", kind: "search", priority: "low", status: "proposed", state: "weak", tests: [{ ref: "TEST-00007", title: "Find a quote" }] }],
          guide: { create: { consider: ["the happy path → reopen → every value is shown"], gate: "reads a typed value back after reloading or reopening the record" },
            delete: { consider: ["confirm → gone from the list"], gate: "checks the deleted item is gone" }, search: { consider: ["a match shows"], gate: "checks that a match shows and that a non-match doesn't" } } });
    if (u.pathname === "/api/v1/projects/freight/plan" && req.method === "POST") { const body = JSON.parse(b); planned.push(body);
      return out(200, { planned: body.tests.map((t, i) => ({ ref: `TEST-0001${i}`, title: t.title, module: t.module, stage: planReview ? "planned" : "approved" })), behaviours: { added: (body.behaviours ?? []).map((x) => x.name), kept: [], dropped: ["Archive a quote"] }, review: planReview }); }
    if (u.pathname === "/api/v1/projects/freight/tests" && req.method === "GET") return out(200, { tests: u.searchParams.get("q") === "saving a quote"
      ? [{ ref: "TEST-00004", title: "Save a quote", module: "Quotes", file: "tests/quotes.spec.ts", steps: ["Open Quotes", "Save it"], by: "written by Claude", same: true }] : [] });
    if (u.pathname === "/api/v1/projects/freight/files") return out(200, { files: [
      { path: "tests/quotes.spec.ts", sha: "x", content: "import { test } from '@playwright/test';\ntest('Save a quote', async () => {});\ntest('Print a quote', async () => {});\n" },
      { path: "tests/helpers/nav.ts", sha: "y", content: "export const nav = 1;\n" },
      { path: "tests/fixtures/robot.png", sha: "z", binary: true, base64: PNG.toString("base64") }] });
    if (u.pathname === "/api/v1/projects/freight/runs/start" && req.method === "POST" && JSON.parse(b).tag === "offline") return out(400, { error: { code: "invalid_request", message: "Connect your computer first — tests run in a browser on it." } });
    if (u.pathname === "/api/v1/projects/freight/schedules" && req.method === "GET") return out(200, { schedules: [{ name: "Nightly", when: "Weekdays at 02:00 (Asia/Dhaka)", what: "Release check", where: "computer", enabled: true, nextAt: "2026-10-14T20:00:00.000Z", owner: "Ana", last: { status: "failed", detail: "Connect your computer first", run: null } }] });
    if (u.pathname === "/api/v1/projects/freight/schedules" && req.method === "POST") { const body = JSON.parse(b); scheduled.push(body);
      return body.action === "create" ? out(200, { name: body.name, when: "Every 4 hours from 08:00, weekdays (UTC)", what: "Tag smoke", nextAt: "2026-10-14T08:00:00.000Z" })
        : body.name === "Nope" ? out(404, { error: { code: "not_found", message: "No schedule called “Nope” in this project" } }) : out(200, { ok: true }); }
    if (u.pathname === "/api/v1/projects/freight/look" && req.method === "POST") { const body = JSON.parse(b); return body.path === "/broken"
      ? out(200, { status: "failed", error: "Couldn't open /broken. Is your app running?" })
      : out(200, { status: "done", look: { url: `http://localhost:5174${body.path}`, title: "Quotes", snapshot: '- heading "Quotes" [level=1]\n- button "New quote"', shot: PNG.toString("base64"), errors: ["TypeError: x is undefined"] } }); }
    if (u.pathname === "/api/v1/projects/freight/fixes") return out(200, { fixes: [{ ref: "TEST-00005", title: "Cancelling Create training saves nothing", file: "tests/training.spec.ts", steps: ["Open Create training, type a title and press Cancel", "Open Create training again"],
      run: 8, askedBy: "Alex", step: 1, stepTitle: "Open Create training again", attempt: 1, failKind: null, url: "/p/freight/runs/8",
      plain: "The “Title” box in the “Create training” dialog should have been empty, but it still said “QA Cancel 1”.", technical: "expect(locator).toHaveValue(expected) failed",
      ...(u.searchParams.get("shots") === "0" ? {} : { screenshot: { base64: PNG.toString("base64"), type: "image/png" } }) }] });
    if (u.pathname === "/api/v1/projects/freight/fixes/TEST-00005" && req.method === "POST") { notes.push(JSON.parse(b)); return out(200, { ok: true }); }
    if (u.pathname === "/api/v1/projects/freight/runs/start" && req.method === "POST" && JSON.parse(b).tag === "again") return out(200, { run: { number: 8, tests: 2, environment: "Local", url: "/p/freight/runs/8", alreadyStarted: true } });
    if (u.pathname === "/api/v1/projects/freight/runs/start" && req.method === "POST" && JSON.parse(b).tag === "blip") { blips = 0; return out(200, { run: { number: 9, tests: 1, environment: "Local", url: "/p/freight/runs/9" } }); }
    if (u.pathname === "/api/v1/projects/freight/runs/start" && req.method === "POST" && JSON.parse(b).tag === "down") return out(200, { run: { number: 10, tests: 1, environment: "Local", url: "/p/freight/runs/10" } });
    if (u.pathname === "/api/v1/projects/freight/runs/9") return ++blips === 1 ? out(503, { error: { message: "QA Hub is restarting" } }) : out(200, latest);
    if (u.pathname === "/api/v1/projects/freight/runs/10") return out(503, { error: { message: "QA Hub is restarting" } });
    if (u.pathname === "/api/v1/projects/hostile/files") return out(200, { files: [
      { path: ".GIT/hooks/post-checkout", content: "#!/bin/sh\nrm -rf ~\n" }, { path: ".claude/settings.json", content: "{}" }, { path: ".github/workflows/x.yml", content: "x" },
      { path: "NODE_MODULES/x.js", content: "x" }, { path: "package.json", content: "{}" }, { path: "CLAUDE.md", content: "x" }, { path: "../escape.ts", content: "x" },
      { path: "tests\\win.ts", content: "x" }, { path: "/etc/x.ts", content: "x" }, { path: "tests/nulled.spec.ts", content: null },
      { path: "tests/ok-after-bad.spec.ts", content: "ok\n" }] });
    if (u.pathname === "/api/v1/projects/freight/runs/start" && req.method === "POST") { started.push(JSON.parse(b)); polls = 0; return out(200, { run: { number: 8, tests: 2, environment: "Local", url: "/p/freight/runs/8" } }); }
    if (u.pathname === "/api/v1/projects/freight/runs/8") return out(200, ++polls < 2 ? { run: { number: 8, status: "running", tests: 2, url: "/p/freight/runs/8" } } : failedRun);
    if (u.pathname === "/api/v1/projects/freight/runs/latest") return out(200, latest);
    if (u.pathname === "/api/v1/projects/freight/gaps") return out(200, { behaviours: { untested: [{ module: "Quotes", name: "Delete a quote", kind: "delete", priority: "high" }], failing: [], weak: [{ module: "Quotes", name: "Search quotes", kind: "search", priority: "low", tests: ["TEST-00007"] }], notDesigned: ["Wishlist"] }, untested: [{ module: "Quotes", path: "/quotes" }] });
    if (u.pathname === "/api/v1/projects/freight/tests" && req.method === "POST") { pushed.push(JSON.parse(b)); return out(200, { files: 1, tests: 1, refs: [{ ref: "TEST-00004", title: "Save a quote", file: "tests/quotes.spec.ts", module: "Quotes" }], modules: { added: [], named: [] }, inbox: [] }); }
    return out(404, { error: { code: "not_found", message: "Project not found" } });
  });
});
let base, app;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  app = fs.mkdtempSync(path.join(os.tmpdir(), "qahub-app-"));
  fs.mkdirSync(path.join(app, ".git"));
  fs.mkdirSync(path.join(app, "tests"));
  fs.writeFileSync(path.join(app, "tests/quotes.spec.ts"), "import { test } from '@playwright/test';\n");
  fs.writeFileSync(path.join(app, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(os.tmpdir(), "outside.txt"), "nope");
});
after(() => { server.close(); fs.rmSync(app, { recursive: true, force: true }); });

const as = (key) => tools({ QAHUB_KEY: key, QAHUB_SERVER: base }, app, fetch, { pollMs: 10, waitMs: 3_000 });

test("the address: https, or plain http only on this computer / local network", () => {
  assert.equal(serverUrl("https://qahub.example.com/x"), "https://qahub.example.com");
  assert.equal(serverUrl("http://localhost:3100"), "http://localhost:3100");
  assert.equal(serverUrl("http://macbook-air-2.local:3100"), "http://macbook-air-2.local:3100");
  assert.throws(() => serverUrl("http://qahub.example.com"), /https/);
});

test("a valid key: status, link, gaps and push work — and the link file holds no secret", async () => {
  const t = as("qh_good");
  assert.match(await t.qahub_status(), /as Ana <ana@acme.test> — Acme[\s\S]*\nProjects: freight \(Freight portal\)/);
  await assert.rejects(t.qahub_gaps({}), /isn't linked/);
  await assert.rejects(t.qahub_link({ project: "other" }), /No project “other”/);
  assert.match(await t.qahub_link({ project: "freight" }), /Linked/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, "qahub.json"), "utf8")), { project: "freight" });
  assert.match(await t.qahub_gaps({}), /Quotes/);
  const sent = await t.qahub_push({ files: ["tests/quotes.spec.ts"], tests: [{ file: "tests/quotes.spec.ts", title: "Save a quote", module: "Quotes", steps: ["Open Quotes"] }] });
  assert.match(sent, /TEST-00004 “Save a quote”[\s\S]*qahub_run \{ tests: \["TEST-00004"\], repeat: 2 \}/);
  assert.equal(pushed.at(-1).files[0].path, "tests/quotes.spec.ts");
  assert.match(pushed.at(-1).files[0].content, /playwright/);
});

test("never sends secrets or anything outside the app's folder", () => {
  assert.throws(() => readAppFile(app, ".env"), /never sent/);
  assert.throws(() => readAppFile(app, "../outside.txt"), /inside this app's folder/);
  fs.symlinkSync(path.join(os.tmpdir(), "outside.txt"), path.join(app, "tests/link.txt"));
  assert.throws(() => readAppFile(app, "tests/link.txt"), /inside this app's folder/, "a symlink can't smuggle a file out");
});

test("no key, a revoked key, or an ended plan: every tool refuses, in words", async () => {
  await assert.rejects(as("")["qahub_status"](), /No QA Hub API key yet/);
  await assert.rejects(as("${user_config.api_key}")["qahub_status"](), /No QA Hub API key yet/, "an unfilled placeholder is no key");
  await assert.rejects(as("qh_revoked")["qahub_status"](), /not valid \(wrong, revoked/);
  for (const name of ["qahub_status", "qahub_project", "qahub_design", "qahub_plan", "qahub_find", "qahub_pull", "qahub_gaps", "qahub_push", "qahub_link", "qahub_run", "qahub_results"]) {
    await assert.rejects(as("qh_expired")[name]({ project: "freight" }), /plan has ended/, `${name} refuses on an ended plan`);
  }
});

test("a key revoked mid-session stops working within a minute (re-checked, not trusted forever)", async () => {
  const t = as("qh_good");
  await t.qahub_gaps({ project: "freight" });
  delete KEYS.qh_good;
  try {
    await assert.rejects(t.qahub_status(), /not valid/, "status always re-checks");
  } finally { KEYS.qh_good = true; }
});

test("speaks MCP over stdio: initialize, list the tools, call one", async () => {
  const child = spawn(process.execPath, [path.join(HERE, "../server/index.mjs")], { cwd: app, env: { ...process.env, QAHUB_KEY: "qh_good", QAHUB_SERVER: base } });
  const lines = [];
  child.stdout.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean)));
  const ask = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  const answer = async (id) => { for (let i = 0; i < 100; i++) { const l = lines.map((x) => JSON.parse(x)).find((x) => x.id === id); if (l) return l; await new Promise((r) => setTimeout(r, 50)); } throw new Error(`no answer ${id}`); };
  try {
  ask({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal((await answer(1)).result.serverInfo.name, "qahub");
  ask({ method: "notifications/initialized" });
  ask({ id: 2, method: "tools/list" });
  assert.deepEqual((await answer(2)).result.tools.map((t) => t.name), ["qahub_status", "qahub_project", "qahub_design", "qahub_plan", "qahub_find", "qahub_pull", "qahub_link", "qahub_gaps", "qahub_push", "qahub_run", "qahub_results", "qahub_fixes", "qahub_fix_note", "qahub_look", "qahub_schedule"]);
  ask({ id: 3, method: "tools/call", params: { name: "qahub_status", arguments: {} } });
  assert.match((await answer(3)).result.content[0].text, /Connected to QA Hub/);
  } finally { child.kill(); }
});

test("session start: says plainly when the key is bad, never prints it, never blocks", async () => {
  const run = (key) => new Promise((ok) => {
    const c = spawn(process.execPath, [path.join(HERE, "../hooks/session-start.mjs")], { env: { ...process.env, CLAUDE_PLUGIN_OPTION_API_KEY: key, CLAUDE_PLUGIN_OPTION_SERVER: base } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("close", (code) => ok({ code, out: JSON.parse(out).hookSpecificOutput.additionalContext }));
  });
  const good = await run("qh_good");
  assert.equal(good.code, 0);
  assert.match(good.out, /connected as Ana \(Acme\)/);
  const bad = await run("qh_revoked_secret_value");
  assert.equal(bad.code, 0);
  assert.match(bad.out, /not connected — Your QA Hub API key is not valid/);
  assert.doesNotMatch(bad.out, /qh_revoked_secret_value/);
});

test("the Playwright checklist is handed over once per session, only for test files", async () => {
  const { checklistFor } = await import("../hooks/test-checklist.mjs");
  const seen = path.join(os.tmpdir(), `qahub-checklist-test-${process.pid}-${Date.now()}`);
  fs.writeFileSync(path.join(app, "qahub.json"), JSON.stringify({ project: "freight" }));
  assert.equal(checklistFor({ cwd: app, tool_input: { file_path: "src/app.ts" } }, seen), null);
  const first = checklistFor({ cwd: app, tool_input: { file_path: "tests/quotes.spec.ts" } }, seen);
  assert.equal(first.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(first.hookSpecificOutput.additionalContext, /never first\(\)\/nth\(\)/);
  assert.ok(first.hookSpecificOutput.additionalContext.length < 2500);
  assert.equal(checklistFor({ cwd: app, tool_input: { file_path: "tests/other.spec.ts" } }, seen), null); // once
  fs.rmSync(seen);
});

test("status says whether tests can run now: the computer, the environments", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  const said = await t.qahub_status();
  assert.match(said, /Your computer: MacBook \(qahub 0\.9\.21\) — connected/);
  assert.match(said, /Environments: Local \(http:\/\/localhost:3000\)/);
});

test("qahub_run runs on the person's computer, waits, and says what failed, where, and what to do", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  const said = await t.qahub_run({ tests: ["TEST-00004", "TEST-00002"] });
  assert.deepEqual(started.at(-1), { tests: ["TEST-00004", "TEST-00002"], headless: true });
  assert.match(said, /Run #8 finished: 1 passed, 1 failed/);
  assert.match(said, /TEST-00004 “Save a quote” \(tests\/quotes\.spec\.ts\) failed at “Save it”/);
  assert.match(said, /the app broke/);
  assert.match(said, /Expected: Quote saved/);
  assert.match(said, /Flaky: TEST-00002/);
  assert.match(said, new RegExp(`${base}/p/freight/runs/8`));
  // Not waiting: it says the number to ask about.
  assert.match(await t.qahub_run({ tag: "smoke", wait: false, show: true }), /Run #8 started/);
  assert.deepEqual(started.at(-1), { tag: "smoke", headless: false });
  await assert.rejects(t.qahub_run({ tag: "smoke", module: "Quotes" }), /one of/);
  await assert.rejects(t.qahub_run({ tag: "offline" }), /Connect your computer first[\s\S]*QA Hub → Computers[\s\S]*sent but not run/);
});

test("qahub_results reads the latest run, or a run by number", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  assert.match(await t.qahub_results({}), /Run #7 finished: 3 passed, 0 failed — all passed/);
  polls = 5;
  assert.match(await t.qahub_results({ run: 8 }), /1 failed/);
});

test("before git push: asks the person when the latest run has failures; quiet otherwise; never blocks on errors", async () => {
  const gate = (command, key = "qh_good", server = base) => new Promise((ok) => {
    const c = spawn(process.execPath, [path.join(HERE, "../hooks/push-check.mjs")], { env: { ...process.env, CLAUDE_PLUGIN_OPTION_API_KEY: key, CLAUDE_PLUGIN_OPTION_SERVER: server } });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("close", (code) => ok({ code, out }));
    c.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: app, tool_input: { command } }));
  });
  fs.writeFileSync(path.join(app, "qahub.json"), JSON.stringify({ project: "freight" }));
  latest = failedRun;
  const ask = await gate("git push origin main");
  assert.equal(ask.code, 0);
  const o = JSON.parse(ask.out).hookSpecificOutput;
  assert.equal(o.permissionDecision, "ask");
  assert.match(o.permissionDecisionReason, /run #8: 1 test failing — TEST-00004 “Save a quote”/);
  assert.equal((await gate("npm test")).out, "", "only git push is checked");
  assert.equal((await gate("git push", "qh_good", "http://127.0.0.1:1")).out, "", "QA Hub down: the push goes ahead");
  latest = { run: { number: 9, status: "finished", verdict: "pass", passed: 2, failed: 0, failures: [], flaky: [], url: "/p/freight/runs/9" } };
  assert.equal((await gate("git push")).out, "", "all passing: nothing to ask");
});

test("qahub_project: the module tree, sets, tests, folders and helpers — what Claude reads before writing", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  const said = await t.qahub_project({});
  assert.match(said, /Modules[\s\S]*- Quotes \(\/quotes\) — 1 test\n  - Quote details \(\/quotes\/1\) — no tests yet\n- Log in \(\/login\) — 1 test/);
  assert.match(said, /Sets[\s\S]*Release check — Before every release: TEST-00004/);
  assert.match(said, /Tags in use: smoke/);
  assert.match(said, /Shared helpers: tests\/helpers\/nav\.ts/);
  assert.match(said, /Quotes:\n  TEST-00004 “Save a quote” \(tests\/quotes\.spec\.ts\) @smoke — A rep saves a quote\./);
});

test("push: a new test's module must exist or be declared — refused before sending, with what to do; a kept test is fine", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  const before = pushed.length;
  await assert.rejects(t.qahub_push({ files: ["tests/quotes.spec.ts"], tests: [{ file: "tests/quotes.spec.ts", title: "Print a quote", module: "Printing", steps: ["Print"] }] }),
    /Module “Printing” isn't in QA Hub[\s\S]*Quotes, Quote details, Log in[\s\S]*modules: \[\{ name: "Printing", path: "\/…", parent: "\/…" \}\]/);
  assert.equal(pushed.length, before, "nothing was sent");
  // Declared (with its parent), matched ignoring case, by address, or an existing test: all go through.
  await t.qahub_push({ files: ["tests/quotes.spec.ts"], modules: [{ name: "Printing", path: "/quotes/print", parent: "/quotes" }],
    tests: [{ file: "tests/quotes.spec.ts", title: "Print a quote", module: "Printing", steps: ["Print"], sets: ["Release check"] },
      { file: "tests/quotes.spec.ts", title: "Save it", module: "quotes", steps: ["Save"] }, { file: "tests/quotes.spec.ts", title: "Sign in again", module: "/login", steps: ["Go"] },
      { file: "tests/login.spec.ts", title: "Sign in", module: "Old name", steps: ["Go"] }] }).catch((e) => assert.fail(e.message));
  assert.deepEqual(pushed.at(-1).modules, [{ name: "Printing", path: "/quotes/print", parent: "/quotes" }]);
  assert.deepEqual(pushed.at(-1).tests[0].sets, ["Release check"]);
});

test("qahub_find: what already tests a behaviour, before writing a second one", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  const said = await t.qahub_find({ about: "saving a quote" });
  assert.match(said, /SAME: TEST-00004 “Save a quote” \(Quotes, written by Claude; tests\/quotes\.spec\.ts\)[\s\S]*Open Quotes → Save it/);
  assert.match(said, /don't write a second test/i);
  assert.match(await t.qahub_find({ about: "exporting invoices" }), /Nothing in QA Hub covers this yet/);
});

test("qahub_pull: brings the team's latest test files; never overwrites a local file unless asked, and says what's different", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  fs.writeFileSync(path.join(app, "tests/quotes.spec.ts"), "import { test } from '@playwright/test';\ntest('Save a quote', async () => {});\n");
  fs.rmSync(path.join(app, "tests/helpers"), { recursive: true, force: true });
  const said = await t.qahub_pull({});
  assert.match(said, /Added: tests\/helpers\/nav\.ts/);
  assert.match(said, /Different here: tests\/quotes\.spec\.ts — QA Hub's copy also has “Print a quote”/);
  assert.doesNotMatch(fs.readFileSync(path.join(app, "tests/quotes.spec.ts"), "utf8"), /Print a quote/, "not overwritten");
  assert.match(await t.qahub_pull({ overwrite: ["tests/quotes.spec.ts"] }), /Replaced with QA Hub's copy: tests\/quotes\.spec\.ts/);
  assert.match(fs.readFileSync(path.join(app, "tests/quotes.spec.ts"), "utf8"), /Print a quote/);
  fs.writeFileSync(path.join(app, "tests/quotes.spec.ts"), "import { test } from '@playwright/test';\n");
});

test("qahub_project shows each test's steps and who made it; push carries distinctFrom and remove", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  assert.match(await t.qahub_project({}), /TEST-00002 “Sign in” \(tests\/login\.spec\.ts\) — needs TEST-00004 — recorded by Maya/);
  assert.match(await t.qahub_project({ module: "Log in" }), /TEST-00002 “Sign in” \(tests\/login\.spec\.ts\) — needs TEST-00004 — recorded by Maya\n    Sign in/);
  await t.qahub_push({ files: ["tests/quotes.spec.ts"], remove: ["TEST-00009"], tests: [{ file: "tests/quotes.spec.ts", title: "Save a draft quote", module: "Quotes", steps: ["Save draft"], distinctFrom: ["TEST-00004"] }] });
  assert.deepEqual(pushed.at(-1).remove, ["TEST-00009"]);
  assert.deepEqual(pushed.at(-1).tests[0].distinctFrom, ["TEST-00004"]);
});

test("session start, in a linked folder: Claude starts out knowing the modules and sets", async () => {
  fs.writeFileSync(path.join(app, "qahub.json"), JSON.stringify({ project: "freight" }));
  const out = await new Promise((ok) => {
    const c = spawn(process.execPath, [path.join(HERE, "../hooks/session-start.mjs")], { env: { ...process.env, CLAUDE_PLUGIN_OPTION_API_KEY: "qh_good", CLAUDE_PLUGIN_OPTION_SERVER: base } });
    let o = ""; c.stdout.on("data", (d) => (o += d)); c.on("close", () => ok(JSON.parse(o).hookSpecificOutput.additionalContext));
    c.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", cwd: app }));
  });
  assert.match(out, /freight: 2 tests\. Modules: Quotes \(\/quotes\), Quote details \(\/quotes\/1\), Log in \(\/login\)\. Sets: Release check\./);
  assert.match(out, /qahub_project/);
});

test("qahub_design: a module's behaviours with their state, highest priority first, and the guide for its kinds", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  const said = await t.qahub_design({ module: "Quotes" });
  assert.match(said, /Quotes \(\/quotes\): 1 of 3 behaviours proven/);
  assert.match(said, /- Delete a quote \(delete, high\) — untested/);
  assert.match(said, /- Search quotes \(search, low\) — weak \(TEST-00007\) — proposed, not confirmed yet/);
  assert.match(said, /How to test a delete[\s\S]*confirm → gone from the list[\s\S]*QA Hub requires: checks the deleted item is gone/);
  const none = await t.qahub_design({ module: "Wishlist" });
  assert.match(none, /isn't designed yet/);
  assert.match(none, /How to test a create/);
});

test("qahub_plan: test cases before code; says whether a person reviews them; reports dropped behaviours", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  const plan = { behaviours: [{ module: "Quotes", name: "Delete a quote", kind: "delete", priority: "high" }],
    tests: [{ title: "Delete a quote and see it gone", module: "Quotes", type: "functional", priority: "high", preconditions: "A quote exists", covers: ["Delete a quote"],
      steps: [{ title: "Delete it", expect: "A confirmation shows" }, { title: "Search for it", expect: "It isn't found" }] }] };
  let said = await t.qahub_plan(plan);
  assert.deepEqual(planned.at(-1), plan);
  assert.match(said, /1 test case approved[\s\S]*write its code/);
  assert.match(said, /“Archive a quote” was dropped by a person/);
  planReview = true;
  said = await t.qahub_plan(plan);
  assert.match(said, /waiting for a person to approve in QA Hub[\s\S]*\/p\/freight\/tests/);
  assert.match(said, /stop here/i);
  planReview = false;
});

test("push forwards the design fields; gaps lead with behaviours", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  const test1 = { file: "tests/quotes.spec.ts", title: "Delete a quote and see it gone", module: "Quotes", type: "functional", priority: "high", preconditions: "A quote exists",
    covers: ["Delete a quote"], steps: [{ title: "Delete it", expect: "Gone" }], waiver: "the list refreshes from a nightly job, not on delete" };
  await t.qahub_push({ files: ["tests/quotes.spec.ts"], behaviours: [{ module: "Quotes", name: "Delete a quote", kind: "delete" }], tests: [test1] });
  assert.deepEqual(pushed.at(-1).tests[0], test1);
  assert.deepEqual(pushed.at(-1).behaviours, [{ module: "Quotes", name: "Delete a quote", kind: "delete" }]);
  const g = await t.qahub_gaps({});
  assert.match(g.split("\n")[0], /Test next: Delete a quote \(Quotes, delete, high\)/);
  assert.match(g, /Not proven: Search quotes \(Quotes, weak\)/);
  assert.match(g, /Not designed yet: Wishlist/);
});

test("an older install is told about the newer plugin, with what to run; the same or a newer one says nothing", () => {
  assert.equal(newer("0.7.10", "0.7.9"), true);
  assert.equal(newer("0.8.0", "0.7.12"), true);
  assert.equal(newer("0.7.2", "0.7.2"), false);
  assert.equal(newer("0.7.1", "0.7.2"), false);
  assert.equal(newer("garbage", "0.7.2"), false);
  assert.match(updateNote("0.7.3", "0.7.2"), /0\.7\.2 → 0\.7\.3[\s\S]*claude plugin marketplace update qahub[\s\S]*claude plugin update qahub@qahub[\s\S]*Enable auto-update/);
  assert.equal(updateNote("0.7.2", "0.7.2"), "");
  assert.equal(updateNote(null, "0.7.2"), "");
});

test("a file a test uploads: a picture goes as its bytes, a CSV as text; pulled back byte for byte", async () => {
  fs.mkdirSync(path.join(app, "tests/fixtures"), { recursive: true });
  fs.writeFileSync(path.join(app, "tests/fixtures/photo.png"), PNG);
  fs.writeFileSync(path.join(app, "tests/fixtures/people.csv"), "name,email\nAcme,ops@acme.test\n");
  assert.deepEqual(readAppFile(app, "tests/fixtures/photo.png"), { path: "tests/fixtures/photo.png", base64: PNG.toString("base64") });
  assert.deepEqual(readAppFile(app, "tests/fixtures/people.csv"), { path: "tests/fixtures/people.csv", content: "name,email\nAcme,ops@acme.test\n" });
  fs.writeFileSync(path.join(app, "tests/fixtures/big.zip"), Buffer.alloc(10 * 1024 * 1024 + 1));
  assert.throws(() => readAppFile(app, "tests/fixtures/big.zip"), /over 10 MB/);
  fs.rmSync(path.join(app, "tests/fixtures/big.zip"));
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  fs.rmSync(path.join(app, "tests/fixtures/robot.png"), { force: true });
  assert.match(await t.qahub_pull({}), /Added:[^\n]*tests\/fixtures\/robot\.png/);
  assert.deepEqual(fs.readFileSync(path.join(app, "tests/fixtures/robot.png")), PNG);
  assert.doesNotMatch(await t.qahub_pull({}), /robot\.png/, "the same bytes: nothing to say");
});

// ---- production hardening (0.7.5) -------------------------------------------------------------------

const hook = (file, stdin, env = {}, dir = path.join(HERE, "..")) => new Promise((ok) => {
  const c = spawn(process.execPath, [path.join(dir, file)], { env: { ...process.env, ...env } });
  let out = ""; c.stdout.on("data", (d) => (out += d)); c.on("close", (code) => ok({ code, out }));
  c.stdin.end(stdin === undefined ? "" : JSON.stringify(stdin));
});

test("the server and hooks start from a path with a space and through a symlink (as on Windows / dotfiles setups)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qahub-paths-"));
  const spaced = path.join(tmp, "QA Hub plugin");
  fs.cpSync(path.join(HERE, ".."), spaced, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(src) });
  const linked = path.join(tmp, "linked");
  fs.symlinkSync(spaced, linked);
  fs.writeFileSync(path.join(app, "qahub.json"), JSON.stringify({ project: "freight" }));
  try {
    for (const dir of [spaced, linked]) {
      const { out } = await hook("hooks/test-checklist.mjs", { session_id: `paths-${Date.now()}-${Math.random()}`.replace(".", ""), cwd: app, tool_input: { file_path: path.join(app, "tests/quotes.spec.ts") } }, {}, dir);
      assert.match(out, /QA Hub checklist/, `checklist runs from ${dir}`);
      const child = spawn(process.execPath, [path.join(dir, "server/index.mjs")], { cwd: app, env: { ...process.env, QAHUB_KEY: "qh_good", QAHUB_SERVER: base } });
      const said = await new Promise((ok) => { let o = ""; child.stdout.on("data", (d) => { o += d; if (o.includes("\n")) ok(o); }); setTimeout(() => ok(o), 3000); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n"); });
      child.kill();
      assert.match(said, /"serverInfo":\{"name":"qahub"/, `MCP server answers from ${dir}`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("the address: the default is QA Hub's own; office-network addresses work over http; a public one needs https", () => {
  assert.equal(DEFAULT_SERVER, "https://app.qahub.dev");
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, "../.claude-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.userConfig.server.default, DEFAULT_SERVER, "one default, everywhere");
  for (const ok of ["http://10.110.100.85:3100", "http://192.168.1.20:3100", "http://172.20.0.5"]) assert.equal(serverUrl(ok), ok);
  for (const bad of ["http://172.32.0.1", "http://8.8.8.8", "http://10.example.com"]) assert.throws(() => serverUrl(bad), /https/);
});

test("pull writes only QA Hub's kind of file: never .git, .claude, CI, node_modules or outside the folder; one bad entry doesn't lose the rest", async () => {
  const said = await as("qh_good").qahub_pull({ project: "hostile" });
  for (const bad of [".git/hooks/post-checkout", ".claude", ".github", "NODE_MODULES", "node_modules/x.js", "CLAUDE.md", "tests/win.ts"]) assert.equal(fs.existsSync(path.join(app, bad)), false, `${bad} not written`);
  assert.equal(fs.existsSync(path.join(path.dirname(app), "escape.ts")), false);
  assert.match(said, /Not written: \.GIT\/hooks\/post-checkout \(hidden/);
  assert.match(said, /tests\/nulled\.spec\.ts \(QA Hub sent no text for it\)/);
  assert.match(said, /Added: tests\/ok-after-bad\.spec\.ts/, "the good file after a bad one still lands, and is reported");
  fs.rmSync(path.join(app, "tests/ok-after-bad.spec.ts"));
});

test("pushing never reads hidden files, keys or anything that isn't test code or a file a test uploads", () => {
  fs.mkdirSync(path.join(app, ".GIT2"), { recursive: true });
  fs.writeFileSync(path.join(app, ".GIT2/config"), "url = https://token@github.com/x");
  fs.writeFileSync(path.join(app, ".npmrc"), "//registry/:_authToken=x");
  fs.writeFileSync(path.join(app, "id_rsa"), "PRIVATE");
  for (const f of [".GIT2/config", ".npmrc", "id_rsa"]) assert.throws(() => readAppFile(app, f), /can't be sent|never sent/, f);
});

test("an address that answers but isn't QA Hub is said plainly — never 'your plan has ended'", async () => {
  const html = http.createServer((_q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end("<html>Welcome</html>"); });
  await new Promise((r) => html.listen(0, "127.0.0.1", r));
  try {
    const t = tools({ QAHUB_KEY: "qh_good", QAHUB_SERVER: `http://127.0.0.1:${html.address().port}` }, app);
    await assert.rejects(t.qahub_status(), (e) => /answered, but not like QA Hub/.test(e.message) && !/plan has ended/.test(e.message));
  } finally { html.close(); }
});

test("following a run: a blip is asked again; if QA Hub stays down, the run number is never lost", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  assert.match(await t.qahub_run({ tag: "blip" }), /Run #9 finished/);
  await assert.rejects(t.qahub_run({ tag: "down" }), /Run #10 was started[\s\S]*qahub_results \{ run: 10, wait: true \}[\s\S]*Don't start it again/);
});

test("qahub_run with an empty test list runs nothing — never the whole project", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  const before = started.length;
  await assert.rejects(t.qahub_run({ tests: [] }), /nothing was run/);
  assert.equal(started.length, before);
});

test("in a folder not linked to QA Hub the hooks stay quiet: no checklist for a Jest file, one short line at start", async () => {
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "not-qahub-"));
  fs.mkdirSync(path.join(other, ".git"));
  try {
    const { checklistFor } = await import("../hooks/test-checklist.mjs");
    assert.equal(checklistFor({ cwd: other, tool_input: { file_path: path.join(other, "src/sum.test.ts") } }, path.join(other, "seen")), null);
    const { out } = await hook("hooks/session-start.mjs", { cwd: other }, { CLAUDE_PLUGIN_OPTION_API_KEY: "qh_good", CLAUDE_PLUGIN_OPTION_SERVER: base });
    const said = JSON.parse(out).hookSpecificOutput.additionalContext;
    assert.match(said, /isn't linked to a QA Hub project\. Use the qahub tools only when the user asks/);
    assert.doesNotMatch(said, /write Playwright tests for it/);
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});

test("session start against a QA Hub that never answers: done in seconds, says so", async () => {
  const hang = http.createServer(() => {});
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  try {
    const t0 = Date.now();
    const { out } = await hook("hooks/session-start.mjs", { cwd: app }, { CLAUDE_PLUGIN_OPTION_API_KEY: "qh_good", CLAUDE_PLUGIN_OPTION_SERVER: `http://127.0.0.1:${hang.address().port}` });
    assert.ok(Date.now() - t0 < 8_000, `took ${Date.now() - t0} ms`);
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /didn't answer within 3 s/);
  } finally { hang.closeAllConnections(); hang.close(); }
});

test("a push over QA Hub's 30 MB limit is refused before sending, with what to do", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  const big = ["a", "b", "c"].map((x) => `tests/fixtures/big-${x}.pdf`);
  for (const f of big) fs.writeFileSync(path.join(app, f), Buffer.alloc(8 * 1024 * 1024, 7));
  const before = pushed.length;
  try {
    await assert.rejects(t.qahub_push({ files: big }), /up to 30 MB at once[\s\S]*Nothing was sent/);
    assert.equal(pushed.length, before);
  } finally { for (const f of big) fs.rmSync(path.join(app, f)); }
});

test("MCP: an inherited name is not a tool; an unknown protocol version gets one this server speaks", async () => {
  const { serve } = await import("../server/index.mjs");
  const { PassThrough } = await import("node:stream");
  const inp = new PassThrough(), out = new PassThrough();
  const got = [];
  out.on("data", (d) => got.push(...String(d).split("\n").filter(Boolean).map((x) => JSON.parse(x))));
  serve(inp, out, as("qh_good"));
  inp.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } }) + "\n");
  inp.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "constructor", arguments: {} } }) + "\n");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(got.find((x) => x.id === 1).result.protocolVersion, "2025-11-25");
  assert.match(got.find((x) => x.id === 2).error.message, /Unknown tool constructor/);
});

test("the app folder is never the whole home folder, even when home is a git repo", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
  fs.mkdirSync(path.join(home, ".git"));
  fs.mkdirSync(path.join(home, "shop/src"), { recursive: true });
  try {
    assert.equal(appRoot(path.join(home, "shop/src"), home), path.join(home, "shop/src"));
    fs.writeFileSync(path.join(home, "shop/qahub.json"), "{}");
    assert.equal(appRoot(path.join(home, "shop/src"), home), path.join(home, "shop"));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("Windows: a file with CRLF line endings is the same file; a backslash path in a push is sent with slashes; git -C dir push is checked", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  fs.mkdirSync(path.join(app, "tests/helpers"), { recursive: true });
  fs.writeFileSync(path.join(app, "tests/helpers/nav.ts"), "export const nav = 1;\r\n");
  assert.doesNotMatch(await t.qahub_pull({}), /Different here:[^\n]*nav\.ts/);
  await t.qahub_push({ files: ["tests/quotes.spec.ts"], tests: [{ file: "tests\\quotes.spec.ts", title: "Save a quote", module: "Quotes", steps: ["Open Quotes"] }] });
  assert.equal(pushed.at(-1).tests[0].file, "tests/quotes.spec.ts");
  const { pushCheck } = await import("../hooks/push-check.mjs");
  latest = failedRun;
  try {
    const out = await pushCheck({ cwd: app, tool_input: { command: `git -C ${app} push origin main` } }, { CLAUDE_PLUGIN_OPTION_API_KEY: "qh_good", CLAUDE_PLUGIN_OPTION_SERVER: base });
    assert.equal(out?.hookSpecificOutput.permissionDecision, "ask");
  } finally { latest = { run: { number: 7, status: "finished", verdict: "pass", passed: 3, failed: 0, failures: [], flaky: [], url: "/p/freight/runs/7" } }; }
});

test("a test that uses what another makes says so (needs) — pushed, and shown in the project", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  assert.match(await t.qahub_project({}), /TEST-00002 “Sign in” \(tests\/login\.spec\.ts\) — needs TEST-00004/);
  await t.qahub_push({ files: ["tests/quotes.spec.ts"], tests: [{ file: "tests/quotes.spec.ts", title: "Delete a quote", module: "Quotes", steps: ["Delete it"], needs: ["Save a quote"] }] });
  assert.deepEqual(pushed.at(-1).tests[0].needs, ["Save a quote"]);
});

test("Ask Claude to fix it: Claude brings it up at session start, asks first, sees the screenshot, and answers in plain words", async () => {
  fs.writeFileSync(path.join(app, "qahub.json"), JSON.stringify({ project: "freight" }));
  const { out } = await hook("hooks/session-start.mjs", { cwd: app }, { CLAUDE_PLUGIN_OPTION_API_KEY: "qh_good", CLAUDE_PLUGIN_OPTION_SERVER: base });
  const said = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.match(said, /FIX REQUESTS: a person asked you in QA Hub to fix a failing test: TEST-00005 “Cancelling Create training saves nothing” \(run #8, at “Open Create training again”: The “Title” box/);
  assert.match(said, /shall I fix it now\?" Don't change code before they say yes/);

  const t = as("qh_good");
  const got = await t.qahub_fixes({});
  assert.ok(Array.isArray(got.content));
  assert.match(got.content.map((c) => c.text ?? "").join("\n"), /TEST-00005[\s\S]*What went wrong: The “Title” box[\s\S]*Playwright said: expect\(locator\)\.toHaveValue/);
  assert.deepEqual(got.content.find((c) => c.type === "image"), { type: "image", data: PNG.toString("base64"), mimeType: "image/png" });

  await assert.rejects(t.qahub_fix_note({ test: "five", kind: "app", note: "something long enough" }), /TEST-00005/);
  assert.match(await t.qahub_fix_note({ test: "TEST-00005", kind: "app", note: "The dialog kept the last title when reopened. It now starts empty." }), /qahub_run \{ tests: \["TEST-00005"\] \}/);
  assert.deepEqual(notes.at(-1), { kind: "app", note: "The dialog kept the last title when reopened. It now starts empty." });

  // Over MCP, the screenshot travels as an image block.
  const { serve } = await import("../server/index.mjs");
  const { PassThrough } = await import("node:stream");
  const inp = new PassThrough(), o = new PassThrough(), lines = [];
  o.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean).map((x) => JSON.parse(x))));
  serve(inp, o, as("qh_good"));
  inp.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "qahub_fixes", arguments: {} } }) + "\n");
  for (let i = 0; i < 50 && !lines.some((x) => x.id === 9); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(lines.find((x) => x.id === 9).result.content.some((c) => c.type === "image"));
});

test("a run QA Hub says was already started (Claude retrying after a timeout) is followed, not reported as new", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  polls = 0;
  assert.match(await t.qahub_run({ tag: "again", wait: false }), /Run #8 was already started a moment ago/);
});

test("a failure comes with where it happened: the page, the failing code lines, the values it typed", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  polls = 0;
  const said = await t.qahub_run({ tests: ["TEST-00004"] });
  assert.match(said, /On the page: http:\/\/localhost:3000\/quotes \(“Quotes”\)/);
  assert.match(said, /status: Quote failed/);
  assert.match(said, /tests\/quotes\.spec\.ts:12[\s\S]*> 12 \|/);
  assert.match(said, /Values it used: Customer name = “Acme 4821”/);
});

test("run each test 5× to check for flaky ones; a push that removes checks carries its reason", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  polls = 0;
  await t.qahub_run({ tests: ["TEST-00004"], repeat: 5, wait: false });
  assert.equal(started.at(-1).repeat, 5);
  // On QA Hub's own test computers: no computer of the person's needed, always headless.
  await t.qahub_run({ tests: ["TEST-00004"], where: "server", show: true, wait: false });
  assert.equal(started.at(-1).where, "server");
  assert.equal(started.at(-1).headless, true);
  await t.qahub_push({ files: ["tests/quotes.spec.ts"], fewerChecks: "The old price banner was removed from the app on purpose" });
  assert.equal(pushed.at(-1).fewerChecks, "The old price banner was removed from the app on purpose");
  // Test data: the values the code reads from QAHUB_DATA, declared with the test (a person can change them in QA Hub).
  const { TOOLS } = await import("../server/index.mjs");
  const push = TOOLS.find((x) => x.name === "qahub_push"); // Claude Code checks a call against this schema
  assert.ok(push.inputSchema.properties.tests.items.properties.data, "qahub_push takes test data");
  await t.qahub_push({ files: ["tests/quotes.spec.ts"], tests: [{ file: "tests/quotes.spec.ts", title: "Save a quote", module: "Quotes", steps: ["Open quotes"], data: [{ name: "customer_name", value: "Acme" }] }] });
  assert.deepEqual(pushed.at(-1).tests[0].data, [{ name: "customer_name", value: "Acme" }]);
});

test("qahub_push makes data dynamic: a value links to a variable, and new variables go along in the same push", async () => {
  const t = as("qh_good");
  const { TOOLS } = await import("../server/index.mjs");
  const push = TOOLS.find((x) => x.name === "qahub_push");
  assert.ok(push.inputSchema.properties.variables, "qahub_push takes variables");
  assert.ok(push.inputSchema.properties.tests.items.properties.data.items.properties.variable, "a data value can name its variable");
  const variables = [{ name: "customer_name", kind: "text", rules: { minLength: 2, maxLength: 40, letters: true, spaces: true }, tricky: "sometimes" }];
  await t.qahub_push({ files: ["tests/quotes.spec.ts"], tests: [{ file: "tests/quotes.spec.ts", title: "Save a quote", module: "Quotes", steps: ["Open quotes"], data: [{ name: "customer_name", value: "Acme", variable: "customer_name" }] }], variables });
  assert.deepEqual(pushed.at(-1).tests[0].data, [{ name: "customer_name", value: "Acme", variable: "customer_name" }]);
  assert.deepEqual(pushed.at(-1).variables, variables);
});

test("the project shows each test's data as QA Hub holds it now — and which values change every run", () => {
  const said = describeProject({ name: "EHS", slug: "ehs", environments: [], sets: [], tags: [], folders: [], helpers: [], modules: [{ name: "Training", path: "/training", tests: 1 }], tests: [{ ref: "TEST-00044", title: "Create a course", file: "e2e/course.spec.ts", module: "Training", steps: ["Open"],
    data: [{ name: "course_title", value: "Fire safety", varies: true }, { name: "seats", value: "30" }] }] }, "Training");
  assert.match(said, /data: course_title \(different every run\), seats = “30”/);
});

test("Claude sees the project's variables, which variable each value uses, a value a person fixed, and one-at-a-time accounts", () => {
  const said = describeProject({ name: "EHS", slug: "ehs", environments: [], sets: [], tags: [], folders: [], helpers: [], modules: [{ name: "Training", path: "/training", tests: 1 }],
    accounts: [{ name: "manager", role: null, places: ["Staging"], default: true, oneAtATime: true }],
    variables: [
      { name: "course_title", kind: "text", rules: { minLength: 3, maxLength: 60 }, tricky: true },
      { name: "city", kind: "list", rules: {}, values: 12, sample: ["Oslo", "Lima"], pick: "round", tricky: false },
    ],
    tests: [{ ref: "TEST-00044", title: "Create a course", file: "e2e/course.spec.ts", module: "Training", steps: ["Open"],
      data: [{ name: "title", value: "Fire safety", varies: true, variable: "course_title" }, { name: "seats", value: "30", fixedByPerson: true }] }] }, "Training");
  assert.match(said, /Variables \(link a test's data to one/);
  assert.match(said, /- course_title — text \(minLength 3, maxLength 60\) — sometimes an edge value/);
  assert.match(said, /- city — list of 12 \(round, e\.g\. “Oslo”, “Lima”\)/);
  assert.match(said, /data: title \(different every run: course_title\), seats = “30” \(fixed by a person — leave it\)/);
  assert.match(said, /- manager — on Staging — default — one run at a time/);
  assert.match(describeProject({ name: "E", slug: "e", environments: [], sets: [], tags: [], folders: [], helpers: [], modules: [], tests: [] }), /Variables \(.*\): none yet\./);
});


test("a run names the tests that didn't run and why — not just a count", () => {
  const text = describeRun({ number: 9, status: "finished", verdict: "fail", passed: 1, failed: 0, skipped: 2, url: "/p/x/runs/9", failures: [],
    notRun: [{ ref: "TEST-00004", title: "Delete the order", reason: "Skipped — TEST-00003 failed first" }, { ref: "TEST-00005", title: "Print the order", reason: null }] }, "https://qa.test");
  assert.match(text, /Didn't run: TEST-00004 “Delete the order” \(Skipped — TEST-00003 failed first\); TEST-00005 “Print the order”/);
});

test("qahub_look: Claude reads a page before writing a test for it — its controls by role and name, the app's errors, and a picture", async () => {
  fs.writeFileSync(path.join(app, "qahub.json"), JSON.stringify({ project: "freight" }));
  const t = as("qh_good");
  const got = await t.qahub_look({ path: "/quotes" });
  const text = got.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /\/quotes[\s\S]*button "New quote"/);
  assert.match(text, /The app's own errors on this page: TypeError: x is undefined/);
  assert.deepEqual(got.content.find((c) => c.type === "image"), { type: "image", data: PNG.toString("base64"), mimeType: "image/jpeg" });
  await assert.rejects(t.qahub_look({ path: "/broken" }), /Couldn't open \/broken/);
});

test("qahub_project is light by default — each test on one line; one module's steps and data on request", async () => {
  const t = as("qh_good");
  await t.qahub_link({ project: "freight" });
  const all = await t.qahub_project({});
  assert.match(all, /TEST-00004 “Save a quote”/);
  assert.doesNotMatch(all, /Open Quotes → Save it/);
  assert.match(all, /qahub_project \{ module \}/);
  const one = await t.qahub_project({ module: "quotes" });
  assert.match(one, /TEST-00004 “Save a quote”[\s\S]*Open Quotes → Save it/);
  assert.doesNotMatch(one, /TEST-00002 “Sign in”/);
  await assert.rejects(t.qahub_project({ module: "Nowhere" }), /No module “Nowhere”[\s\S]*Quotes/);
});

test("the checklist has one home: the write-tests skill — the hook hands over that very text", async () => {
  const { CHECKLIST } = await import("../hooks/test-checklist.mjs");
  const skill = fs.readFileSync(path.join(HERE, "../skills/write-tests/SKILL.md"), "utf8");
  assert.ok(CHECKLIST.length > 500 && CHECKLIST.length < 2500, String(CHECKLIST.length));
  assert.ok(skill.includes(CHECKLIST.split("\n").slice(1).join("\n")), "the hook's text is the skill's checklist section");
  assert.equal(skill.split("Tests start signed in").length - 1, 1, "and the rule is written once");
});

test("after building: app code changed and nothing pushed — Claude is sent back once to write tests (or say why not)", async () => {
  const { buildCheck } = await import("../hooks/build-check.mjs");
  fs.writeFileSync(path.join(app, "qahub.json"), JSON.stringify({ project: "freight" }));
  const line = (o) => JSON.stringify(o);
  const edit = (file) => line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: path.join(app, file) } }] } });
  const push = line({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__plugin_qahub_qahub__qahub_push", input: {} }] } });
  const seen = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qahub-seen-")), "s");
  const input = { cwd: app, session_id: "s1", stop_hook_active: false };

  const out = buildCheck(input, [edit("src/quotes/QuoteForm.tsx"), edit("README.md")].join("\n"), seen);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /src\/quotes\/QuoteForm\.tsx[\s\S]*qahub:write-tests[\s\S]*one line/);
  assert.doesNotMatch(out.reason, /README/);
  assert.equal(buildCheck(input, edit("src/a.ts"), seen), null, "once per session");

  const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qahub-seen-")), "s");
  assert.equal(buildCheck(input, [edit("src/a.ts"), push].join("\n"), fresh()), null, "tests were pushed after the change");
  assert.equal(buildCheck(input, [edit("tests/quotes.spec.ts"), edit("docs/plan.md"), edit("package-lock.json")].join("\n"), fresh()), null, "only tests, docs, lock files");
  assert.equal(buildCheck({ ...input, stop_hook_active: true }, edit("src/a.ts"), fresh()), null, "never loops");
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "qahub-unlinked-"));
  assert.equal(buildCheck({ ...input, cwd: other }, line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: path.join(other, "src/a.ts") } }] } }), fresh()), null, "only in a folder linked to QA Hub");
});

test("qahub_schedule: lists scheduled runs in words; creates one in the person's own time zone; on/off/delete by name", async () => {
  fs.writeFileSync(path.join(app, "qahub.json"), JSON.stringify({ project: "freight" }));
  const t = as("qh_good");
  assert.match(await t.qahub_schedule({ action: "list" }), /Nightly — Weekdays at 02:00 \(Asia\/Dhaka\) · Release check · on[\s\S]*last time it didn't start: Connect your computer first/);
  const made = await t.qahub_schedule({ action: "create", name: "Smoke every 4h", tag: "smoke", days: ["mon", "tue", "wed", "thu", "fri"], time: "08:00", everyHours: 4, where: "server" });
  assert.match(made, /Scheduled “Smoke every 4h”: Every 4 hours from 08:00, weekdays \(UTC\)/);
  assert.equal(scheduled.at(-1).timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(scheduled.at(-1).tag, "smoke");
  assert.match(await t.qahub_schedule({ action: "off", name: "Smoke every 4h" }), /off/);
  await assert.rejects(t.qahub_schedule({ action: "delete", name: "Nope" }), /No schedule called/);
  await assert.rejects(t.qahub_schedule({ action: "create", name: "x", tag: "smoke" }), /time/);
});

test("you changed what a test uses (plan auto-heal Phase 1): an edit that removes words tests still look for says which lines, and Claude can't finish while they still do", async () => {
  const { removedWords, uiChange, staleCheck } = await import("../hooks/ui-change.mjs");
  // The words an edit takes out of the app: text, labels, test ids — not ones it keeps or only moves.
  assert.deepEqual(removedWords(`<button aria-label="Save quote" data-testid="save">Save</button>`, `<button aria-label="Store quote" data-testid="save">Store</button>`).sort(), ["Save", "Save quote"]);
  assert.deepEqual(removedWords(`{ "save": "Save", "cancel": "Cancel" }`, `{ "save": "Store", "cancel": "Cancel" }`), ["Save"], "a translation file too");
  assert.deepEqual(removedWords(`const a = "Save";`, `const b = 1;\nconst a = "Save";`), [], "moved, not removed");
  assert.deepEqual(removedWords(`x("a", "/api/v1", 42)`, `x()`), [], "not words a person reads");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qahub-ui-"));
  fs.writeFileSync(path.join(root, "qahub.json"), JSON.stringify({ project: "freight" }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests/pages"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules/x"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/QuoteForm.tsx"), `export const F = () => <button aria-label="Store quote">Store</button>;\n`);
  fs.writeFileSync(path.join(root, "tests/pages/quote.ts"), `export class QuotePage {\n  constructor(page) { this.page = page; }\n  save = () => this.page.getByRole("button", { name: "Save quote" });\n}\n`);
  fs.writeFileSync(path.join(root, "tests/quotes.spec.ts"), `test("Save a quote", async ({ page }) => {\n  await page.getByText('Save').click();\n});\n`);
  fs.writeFileSync(path.join(root, "node_modules/x/a.spec.js"), `"Save quote"`);
  const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qahub-uist-")), "s.json");
  const edit = { cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, "src/QuoteForm.tsx"), old_string: `<button aria-label="Save quote">Save</button>`, new_string: `<button aria-label="Store quote">Store</button>` } };

  const out = uiChange(edit, state);
  const said = out.hookSpecificOutput.additionalContext;
  assert.match(said, /“Save quote”[\s\S]*tests\/pages\/quote\.ts:3/);
  assert.match(said, /“Save”[\s\S]*tests\/quotes\.spec\.ts:2/);
  assert.doesNotMatch(said, /node_modules/);
  assert.match(said, /qahub_run/);
  // A test file's own edit, or an app file outside a QA Hub folder, says nothing.
  assert.equal(uiChange({ ...edit, tool_input: { ...edit.tool_input, file_path: path.join(root, "tests/quotes.spec.ts") } }, state), null);
  assert.equal(uiChange({ ...edit, cwd: os.tmpdir(), tool_input: { ...edit.tool_input, file_path: path.join(os.tmpdir(), "src.tsx") } }, path.join(os.tmpdir(), "nope.json")), null);

  // About to stop while a test still says "Save": sent back once, naming the lines.
  const stop = staleCheck({ cwd: root, stop_hook_active: false }, state);
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /tests\/pages\/quote\.ts:3[\s\S]*one line/);
  assert.equal(staleCheck({ cwd: root, stop_hook_active: true }, state), null, "never loops");
  // Updated: nothing left to say.
  fs.writeFileSync(path.join(root, "tests/pages/quote.ts"), `save = () => this.page.getByRole("button", { name: "Store quote" });\n`);
  fs.writeFileSync(path.join(root, "tests/quotes.spec.ts"), `await page.getByText('Store').click();\n`);
  assert.equal(staleCheck({ cwd: root, stop_hook_active: false }, state), null);
});

test("Claude sees who a test can sign in as — names, roles, places — and what to do when there's no account", () => {
  const base = { slug: "shop", name: "Shop", modules: [], sets: [], tags: [], folders: [], helpers: [], environments: [{ name: "Staging", url: "https://s.example.com" }] };
  const out = describeProject({ ...base,
    roles: [{ name: "Manager", about: "Approves orders" }, { name: "Customer", about: "" }],
    accounts: [
      { name: "admin", role: null, places: ["Staging", "Production"], default: true },
      { name: "manager", role: "Manager", places: ["Staging"], default: false },
    ],
    tests: [{ ref: "TEST-00001", title: "Approve an order", module: "Orders", file: "tests/orders.spec.ts", runAs: "manager", signsInAs: ["admin"] }],
  });
  assert.match(out, /Test accounts \(each test starts signed in as one — runAs in qahub_push/);
  assert.match(out, /- admin — on Staging, Production — default/);
  assert.match(out, /- manager \[Manager\] — on Staging/);
  assert.match(out, /Roles: Manager — Approves orders\./);
  assert.match(out, /TEST-00001 “Approve an order”.* — as manager \(switches to admin\)/);
  const none = describeProject({ ...base, roles: [], accounts: [], tests: [] });
  assert.match(none, /Test accounts: none — tests run signed out.*Settings → Test accounts/);
});

test("the path rule matches QA Hub's (apps/web/src/lib/paths.ts): .env files and node_modules are refused both ways", () => {
  for (const p of [".env", ".env.local", "package.json", "package-lock.json", "playwright.config.ts", "playwright.config.js"]) {
    assert.ok(pathProblem(p), `${p} is QA Hub's own file`);
  }
  for (const p of ["node_modules/x/index.js", "e2e/Node_Modules/y.ts"]) assert.match(pathProblem(p) ?? "", /node_modules/, p);
  assert.equal(pathProblem("e2e/quotes.spec.ts"), null);
});

test("one Stop answer: changed app code AND stale test words come back as one block with both reasons", async () => {
  const { stopCheck } = await import("../hooks/stop.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qahub-stop-"));
  fs.writeFileSync(path.join(root, "qahub.json"), JSON.stringify({ project: "freight" }));
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests/quotes.spec.ts"), `await page.getByText('Save').click();\n`);
  const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qahub-stopst-")), "s.json");
  fs.writeFileSync(state, JSON.stringify({ [root]: ["Save"] }));
  const seen = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qahub-stopseen-")), "s");
  const edit = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: path.join(root, "src/QuoteForm.tsx") } }] } });

  const out = stopCheck({ cwd: root, stop_hook_active: false }, edit, { seen, state });
  assert.equal(out.decision, "block");
  assert.match(out.reason, /no tests went to QA Hub[\s\S]*Tests still look for words/, "both reasons, one message");
  assert.equal(stopCheck({ cwd: root, stop_hook_active: true }, edit, { seen, state }), null, "never loops");
  const hooks = JSON.parse(fs.readFileSync(path.join(HERE, "../hooks/hooks.json"), "utf8")).hooks.Stop;
  assert.equal(hooks.flatMap((h) => h.hooks).length, 1, "one Stop hook, not two");
});

