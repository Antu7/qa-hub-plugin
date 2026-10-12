// The plugin against a pretend QA Hub: only a valid key with an active plan gets anything done.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { newer, serverUrl, updateNote } from "../server/qahub.mjs";
import { readAppFile, tools } from "../server/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYS = { "qh_good": true, "qh_expired": false }; // key → plan active; anything else is revoked
const pushed = [];
const planned = [];
let planReview = false;
const started = [];
let polls = 0;
let latest = { run: { number: 7, status: "finished", verdict: "pass", passed: 3, failed: 0, failures: [], flaky: [], url: "/p/freight/runs/7" } };
const failedRun = { run: { number: 8, status: "finished", verdict: "fail", passed: 1, failed: 1, skipped: 0, durationSec: 34, browser: "chrome", url: "/p/freight/runs/8",
  failures: [{ ref: "TEST-00004", title: "Save a quote", file: "tests/quotes.spec.ts", failedStep: "Save it", error: "expect(locator).toHaveText() failed · Expected: Quote saved", kind: "bug", since: "new — passed last time" }],
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
        { ref: "TEST-00002", title: "Sign in", module: "Log in", tags: [], file: "tests/login.spec.ts", steps: ["Sign in"], by: "recorded by Rima" }] });
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
  assert.match(sent, /TEST-00004 “Save a quote”[\s\S]*qahub_run \{ tests: \["TEST-00004"\] \}/);
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
  assert.deepEqual((await answer(2)).result.tools.map((t) => t.name), ["qahub_status", "qahub_project", "qahub_design", "qahub_plan", "qahub_find", "qahub_pull", "qahub_link", "qahub_gaps", "qahub_push", "qahub_run", "qahub_results"]);
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
  assert.match(bad.out, /NOT connected — Your QA Hub API key is not valid/);
  assert.doesNotMatch(bad.out, /qh_revoked_secret_value/);
});

test("the Playwright checklist is handed over once per session, only for test files", async () => {
  const { checklistFor } = await import("../hooks/test-checklist.mjs");
  const seen = path.join(os.tmpdir(), `qahub-checklist-test-${process.pid}-${Date.now()}`);
  assert.equal(checklistFor({ tool_input: { file_path: "src/app.ts" } }, seen), null);
  const first = checklistFor({ tool_input: { file_path: "tests/quotes.spec.ts" } }, seen);
  assert.equal(first.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(first.hookSpecificOutput.additionalContext, /never first\(\)\/nth\(\)/);
  assert.ok(first.hookSpecificOutput.additionalContext.length < 2500);
  assert.equal(checklistFor({ tool_input: { file_path: "tests/other.spec.ts" } }, seen), null); // once
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
  assert.match(await t.qahub_project({}), /TEST-00002 “Sign in” \(tests\/login\.spec\.ts\) — recorded by Rima\n    Sign in/);
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
  assert.match(said, /1 test case planned and approved[\s\S]*write its code/);
  assert.match(said, /“Archive a quote” was dropped by a person/);
  planReview = true;
  said = await t.qahub_plan(plan);
  assert.match(said, /waiting for review in QA Hub[\s\S]*\/p\/freight\/tests/);
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
  assert.match(updateNote("0.7.3", "0.7.2"), /0\.7\.2 → 0\.7\.3[\s\S]*claude plugin marketplace update qahub[\s\S]*Enable auto-update/);
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
