#!/usr/bin/env node
// The QA Hub MCP server inside the Claude Code plugin: newline-delimited JSON-RPC (MCP) on stdin/stdout.
// No dependencies. Every tool checks the API key first (see qahub.mjs) — a revoked key or an ended plan
// stops it within a minute, whatever the session already had.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { client, QaHubError, VERSION } from "./qahub.mjs";

const LINK_FILE = "qahub.json"; // in the app's repository: { "project": "<slug>" }
const MAX_FILE = 512 * 1024;
const MAX_UPLOAD = 10 * 1024 * 1024; // a file a test uploads (a picture, a PDF)
const CODE = /\.(ts|js|mjs|cjs|json)$/i;
/** Text, or bytes (a picture, a PDF, a spreadsheet)? Read as UTF-8 strictly: anything that isn't is bytes. */
const asText = (buf) => { if (buf.includes(0)) return null; try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return null; } };
const SLUG = /^[a-z0-9-]{1,60}$/;

/** The folder this app lives in: the nearest one up with qahub.json, else a git root, else the cwd. */
export function appRoot(start = process.cwd()) {
  for (let d = path.resolve(start); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, LINK_FILE)) || fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return path.resolve(start);
  }
}
function linkedProject(root) {
  try { const p = JSON.parse(fs.readFileSync(path.join(root, LINK_FILE), "utf8")).project; return SLUG.test(p) ? p : null; } catch { return null; }
}

/**
 * A file to send, read safely: inside the app's folder (symlinks resolved), never secrets, size-capped.
 * Returns { path (relative, forward slashes), content }.
 */
export function readAppFile(root, rel) {
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(root, String(rel));
  let real;
  try { real = fs.realpathSync(abs); } catch { throw new QaHubError(`${rel}: no such file`); }
  const inside = path.relative(realRoot, real);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new QaHubError(`${rel}: only files inside this app's folder can be sent`);
  const base = path.basename(real).toLowerCase();
  if (base.startsWith(".env") || /\.(pem|key|p12|pfx)$/.test(base) || /(^|\/)(\.git|node_modules)\//.test(inside.split(path.sep).join("/") + "/")) {
    throw new QaHubError(`${rel}: this file is never sent to QA Hub`);
  }
  const st = fs.statSync(real);
  if (!st.isFile()) throw new QaHubError(`${rel}: not a file`);
  const rel2 = inside.split(path.sep).join("/");
  // Code is text, up to 512 KB. A file a test uploads goes as its bytes (base64), up to 10 MB — never
  // read as text, which would quietly corrupt a picture or a PDF.
  if (CODE.test(base)) {
    if (st.size > MAX_FILE) throw new QaHubError(`${rel}: over 512 KB`);
    return { path: rel2, content: fs.readFileSync(real, "utf8") };
  }
  if (st.size > MAX_UPLOAD) throw new QaHubError(`${rel}: over 10 MB — tests can upload files up to 10 MB`);
  const buf = fs.readFileSync(real);
  const text = st.size <= MAX_FILE ? asText(buf) : null;
  return text !== null ? { path: rel2, content: text } : { path: rel2, base64: buf.toString("base64") };
}

const TOOLS = [
  {
    name: "qahub_status",
    description: "Check the QA Hub connection: whose API key this is, whether the company's plan is active, the company's projects, and which project this app folder is linked to. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "qahub_project",
    description: "The project's structure in QA Hub — read it before writing tests: the module tree (each module's address and how many tests it has), the hand-picked sets, every test (ref, title, module, tags, file, what it protects), the tags in use, the spec folders and the shared helper files. Put each new test in the module for the part of the app it covers; reuse the helpers; don't write a test that already exists.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "Leave out to use the linked project" } }, additionalProperties: false },
  },
  {
    name: "qahub_design",
    description: "Before planning tests for a part of the app: that module's behaviours (what a user can do there) with how far each is proven — proven, failing, weak, not run, planned, untested — and QA Hub's guide for testing each kind of behaviour (what a professional checks, and what QA Hub requires the code to prove). An undesigned module says so: propose its behaviours with qahub_plan.",
    inputSchema: { type: "object", additionalProperties: false, required: ["module"], properties: {
      module: { type: "string", description: "The module's name or address, as qahub_project shows it" },
      project: { type: "string", description: "Leave out to use the linked project" },
    } },
  },
  {
    name: "qahub_plan",
    description: "Required before writing code for new tests: send the test cases in plain words — title, module, type, priority, preconditions, every step with its expected result, and the behaviours each covers (add missing behaviours in `behaviours`). QA Hub refuses duplicates here. When the project reviews plans, a person approves them first and code for an unapproved plan is refused; otherwise they're approved at once.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["tests"],
      properties: {
        project: { type: "string", description: "Leave out to use the linked project" },
        behaviours: { type: "array", maxItems: 100, description: "Behaviours the module has that QA Hub doesn't list yet", items: { type: "object", additionalProperties: false, required: ["module", "name", "kind"], properties: {
          module: { type: "string" }, name: { type: "string", description: "What a user can do, e.g. “Delete a quote”" },
          kind: { type: "string", enum: ["create", "view", "edit", "delete", "search", "validation", "workflow", "permission", "calculation", "navigation", "other"] }, priority: { type: "string", enum: ["high", "medium", "low"] }, description: { type: "string" },
        } } },
        tests: { type: "array", maxItems: 200, items: { type: "object", additionalProperties: false, required: ["title", "module", "type", "steps"], properties: {
          title: { type: "string", description: "Exactly the name its test(\"…\") will have" }, module: { type: "string" },
          type: { type: "string", enum: ["functional", "negative", "boundary", "validation", "permission", "workflow", "smoke"] }, priority: { type: "string", enum: ["high", "medium", "low"] },
          preconditions: { type: "string", description: "What must be true before it starts" },
          covers: { type: "array", items: { type: "string" }, description: "Behaviour names of its module it verifies (required unless type is smoke)" },
          steps: { type: "array", items: { type: "object", required: ["title", "expect"], properties: { title: { type: "string" }, expect: { type: "string", description: "What should happen after this step" } } } },
          description: { type: "string" }, tags: { type: "array", items: { type: "string" } },
          distinctFrom: { type: "array", items: { type: "string" }, description: "Refs QA Hub flagged as similar that you read and that test something else" },
        } } },
      },
    },
  },
  {
    name: "qahub_find",
    description: "Before writing a test: what in QA Hub already tests this behaviour — anyone's tests (teammates' Claudes, people's recordings), with their steps and who made them. SAME means QA Hub would refuse a new test for it as a duplicate: improve that test instead of writing a second one.",
    inputSchema: { type: "object", additionalProperties: false, required: ["about"], properties: {
      about: { type: "string", description: "The behaviour in a few words, e.g. \"save a quote\"" },
      module: { type: "string", description: "The module it belongs to, if you know" },
      project: { type: "string", description: "Leave out to use the linked project" },
    } },
  },
  {
    name: "qahub_pull",
    description: "Bring QA Hub's latest test files into this folder — teammates push tests too, so do this before changing a shared spec file or helper. Files you don't have are added; a file that differs here is only replaced when you list it in overwrite (after looking at what's different), so nothing local is lost.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      overwrite: { type: "array", items: { type: "string" }, description: "Paths to replace with QA Hub's copy" },
      project: { type: "string", description: "Leave out to use the linked project" },
    } },
  },
  {
    name: "qahub_link",
    description: "Link this app's folder to a QA Hub project (writes qahub.json with the project's name in the app's root). Use the project name shown in QA Hub.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "The project's short name (slug), e.g. freight-portal" } }, required: ["project"], additionalProperties: false },
  },
  {
    name: "qahub_gaps",
    description: "What to work on next in this project: parts of the app with no tests, failing tests (with each test's description — what it protects), tests not sorted into a module, and changeRequests: edits people made in QA Hub to tests you wrote (apply each in the code, then push the test with applied: true).",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "Leave out to use the linked project" } }, additionalProperties: false },
  },
  {
    name: "qahub_push",
    description: "Send Playwright test files and the tests in them to QA Hub, all or nothing. Files are read from disk by path (inside this app's folder only) — test code and helpers, and any file a test uploads (a picture, a PDF, a spreadsheet, a CSV, up to 10 MB), which QA Hub stores and puts next to the test on every run. Each test names its file, a plain-language title, a description of what it protects and why, the app module it covers, tags, and the steps a person would read.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        project: { type: "string", description: "Leave out to use the linked project" },
        files: { type: "array", maxItems: 200, items: { type: "string" }, description: "Paths of the test files (and helpers they import), relative to the app's root" },
        tests: {
          type: "array", maxItems: 500,
          items: {
            type: "object", additionalProperties: false, required: ["file", "title", "module", "steps"],
            properties: {
              file: { type: "string" }, title: { type: "string" }, module: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              steps: { type: "array", items: { type: "object", required: ["title", "expect"], properties: { title: { type: "string" }, expect: { type: "string" } } }, description: "Its test.step names in order, each with what should happen (for a test QA Hub already has, plain strings keep the stored expected results)" },
              type: { type: "string", enum: ["functional", "negative", "boundary", "validation", "permission", "workflow", "smoke"], description: "Required for a new test" }, priority: { type: "string", enum: ["high", "medium", "low"] },
              preconditions: { type: "string" }, covers: { type: "array", items: { type: "string" }, description: "Behaviour names of its module it verifies (required for a new test unless smoke)" },
              waiver: { type: "string", description: "Only with a true reason (20+ characters) why the code can't prove what QA Hub's depth check asks — shown in QA Hub; the behaviour then never reads proven" },
              description: { type: "string", maxLength: 600, description: "1-3 plain sentences: what the test checks, which user or situation it stands for, and what would count as broken. Always fill it — you and others read it when coming back to this test." },
              replaces: { type: "string", description: "The test's ref (e.g. TEST-00012) when this push renames it or moves it to another file — it keeps its number and history" },
              applied: { type: "boolean", description: "true when this push applies the change request qahub_gaps listed for this test" },
              sets: { type: "array", items: { type: "string" }, description: "Hand-picked sets (by name, from qahub_project) this test should join — only when the person asked, or it clearly belongs (e.g. a release check)" },
              distinctFrom: { type: "array", items: { type: "string" }, description: "Refs QA Hub flagged as possible duplicates that you read and that test something else" },
            },
          },
        },
        behaviours: { type: "array", items: { type: "object", required: ["module", "name", "kind"], properties: { module: { type: "string" }, name: { type: "string" }, kind: { type: "string", enum: ["create", "view", "edit", "delete", "search", "validation", "workflow", "permission", "calculation", "navigation", "other"] }, priority: { type: "string", enum: ["high", "medium", "low"] }, description: { type: "string" } } }, description: "Behaviours the app has that QA Hub doesn't list yet (a test in this push may cover one)" },
        remove: { type: "array", items: { type: "string" }, description: "Refs of tests to take out on purpose (they go to QA Hub's recycle bin) — e.g. a test deleted from its file. Never to get past a refusal." },
        modules: { type: "array", items: { type: "object", properties: { name: { type: "string" }, path: { type: "string" }, parent: { type: "string", description: "The parent module's path, for a sub-page (e.g. /quotes for /quotes/print)" } }, required: ["name", "path"] }, description: "Modules the app has that QA Hub doesn't yet (qahub_project lists what exists): each with its URL path and, for a sub-page, its parent's path. QA Hub adds them; it never renames an existing module." },
      },
    },
  },
  {
    name: "qahub_run",
    description: "Run tests in QA Hub — on the person's own connected computer, signed in to the app, in a real browser — and wait for the result: which tests failed, at which step, the error, and whether the app broke or the test no longer matches. Push first; a run uses what QA Hub has. Pick tests by refs, a tag, a module or a set (one of them), or leave all out for every test.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        project: { type: "string", description: "Leave out to use the linked project" },
        tests: { type: "array", items: { type: "string" }, maxItems: 500, description: "Test refs, e.g. [\"TEST-00012\"] (qahub_push and qahub_status show them)" },
        tag: { type: "string", description: "Every test with this tag, e.g. smoke" },
        module: { type: "string", description: "Every test in this module" },
        set: { type: "string", description: "A saved set, by its name" },
        environment: { type: "string", description: "Which environment (qahub_status lists them); leave out for the first" },
        browser: { type: "string", enum: ["chrome", "firefox", "webkit", "edge"] },
        show: { type: "boolean", description: "true opens a visible browser window on the person's computer (default: runs in the background)" },
        wait: { type: "boolean", description: "Wait for the result (default true, up to about 5 minutes); false returns the run number at once" },
      },
    },
  },
  {
    name: "qahub_results",
    description: "The result of a run: still running, or finished with every failure (test, step, error, bug or change) and flaky tests. Leave run out for the latest run.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        project: { type: "string", description: "Leave out to use the linked project" },
        run: { type: "integer", minimum: 1, description: "The run number; leave out for the latest" },
        wait: { type: "boolean", description: "If it is still running, wait for it (up to about 5 minutes). Default false." },
      },
    },
  },
];

const KIND = { bug: "the app broke", missing: "something on the page changed — check whether the app or the test is right", blocked: "a captcha or bot wall stopped it (not a bug)" };
/** A run, in words Claude acts on: what failed, where, why, and the page with the video and trace. */
export function describeRun(run, origin) {
  const url = `${origin}${run.url}`;
  if (run.status === "running") return `Run #${run.number} is still running (${run.tests} test${run.tests === 1 ? "" : "s"}) — ${url}\nAsk again with qahub_results { run: ${run.number}, wait: true }.`;
  const lines = [`Run #${run.number} finished: ${run.passed} passed, ${run.failed} failed${run.skipped ? `, ${run.skipped} skipped` : ""}${run.browser ? ` (${run.browser}${run.durationSec ? `, ${run.durationSec} s` : ""})` : ""}${run.failed || run.verdict !== "pass" ? "" : " — all passed"} — ${url}`];
  if (run.verdict === "stopped") lines.push(`It stopped before the end${run.stopReason ? `: ${run.stopReason}` : ""}.`);
  for (const f of run.failures ?? []) {
    lines.push(`- ${f.ref ?? "(deleted test)"} “${f.title}”${f.file ? ` (${f.file})` : ""} failed${f.failedStep ? ` at “${f.failedStep}”` : ""}${f.kind && KIND[f.kind] ? ` — ${KIND[f.kind]}` : ""}${f.since ? `; ${f.since}` : ""}.\n  ${f.error ?? "No error text."}${f.evidence?.length ? `\n  The app said: ${f.evidence.slice(0, 2).join(" | ")}` : ""}`);
  }
  if (run.flaky?.length) lines.push(`Flaky: ${run.flaky.map((x) => `${x.ref} “${x.title}”`).join(", ")} — passed only on the second try; find what makes it unreliable (a wait for the wrong thing, data left by an earlier test).`);
  if (run.failed) lines.push("Next: for each failure decide whether the app is wrong (fix the app) or the test no longer matches the app (fix the test). Never make it pass by checking less or waiting longer. Then push and run again. The screenshot, video and trace are on the run page.");
  else if (run.skipped) lines.push("Skipped tests didn't run — usually because a test before them failed, or they have no recorded steps or stored file.");
  return lines.join("\n");
}

/** The project's structure, as Claude reads it: modules as a tree, sets, tags, files, tests by module. */
export function describeProject(s) {
  const kids = (parent) => s.modules.filter((m) => (m.parent ?? null) === parent);
  const tree = [];
  const walk = (parent, depth) => { for (const m of kids(parent)) { tree.push(`${"  ".repeat(depth)}- ${m.name} (${m.path}) — ${m.tests ? `${m.tests} test${m.tests === 1 ? "" : "s"}` : "no tests yet"}`); if (depth < 6) walk(m.path, depth + 1); } };
  walk(null, 0);
  // A module whose parent isn't in the list still shows (at the top).
  for (const m of s.modules) if (m.parent && !s.modules.some((x) => x.path === m.parent)) tree.push(`- ${m.name} (${m.path}) — ${m.tests} test(s)`);
  const byModule = new Map();
  for (const t of s.tests) byModule.set(t.module, [...(byModule.get(t.module) ?? []), t]);
  const MAX = 300;
  const list = [];
  let shown = 0;
  for (const [mod, ts] of byModule) {
    list.push(`${mod}:`);
    for (const t of ts) {
      if (shown++ >= MAX) break;
      list.push(`  ${t.ref} “${t.title}” (${t.file ?? (t.stage === "planned" ? "planned, waiting for review" : "planned, approved — no code yet")})${t.type ? ` [${t.type}${t.priority === "high" ? ", high" : ""}${t.depth ? `, ${t.depth}` : ""}]` : ""}${t.tags?.length ? ` ${t.tags.map((x) => `@${x}`).join(" ")}` : ""}${t.description ? ` — ${t.description}` : ""}${t.by ? ` — ${t.by}` : ""}`);
      if (t.steps?.length) list.push(`    ${t.steps.slice(0, 12).join(" → ")}`);
    }
  }
  if (s.tests.length > MAX) list.push(`…and ${s.tests.length - MAX} more (${s.tests.length} tests in all).`);
  return [
    `Project ${s.slug}${s.name ? ` (${s.name})` : ""}.`,
    `Modules (the app's areas, in its menu order — a test belongs to the one for the page it covers):\n${tree.join("\n") || "none yet"}`,
    ...(s.modules.some((m) => m.behaviours?.length) ? [`Behaviours (what each module should be tested for — qahub_design shows one module with its guide):\n${s.modules.filter((m) => m.behaviours?.length)
      .map((m) => `${m.name}: ${m.behaviours.map((b) => `${b.name} [${b.state}${b.priority === "high" ? ", high" : ""}]`).join("; ")}`).join("\n")}`]
      : ["Behaviours: none designed yet — qahub_design a module, then propose its behaviours with qahub_plan."]),
    `Sets (hand-picked, run in this order): ${s.sets?.length ? `\n${s.sets.map((x) => `- ${x.name}${x.description ? ` — ${x.description}` : ""}: ${x.tests.join(", ") || "empty"}`).join("\n")}` : "none"}. Every module and every tag is also a set of its own, automatically.`,
    `Tags in use: ${s.tags?.join(", ") || "none"}.`,
    `Spec folders: ${s.folders?.join(", ") || "none yet"}. Shared helpers: ${s.helpers?.join(", ") || "none yet"}.`,
    `Environments: ${s.environments.map((e) => `${e.name} (${e.url})`).join(", ") || "none"}.`,
    `Tests (${s.tests.length}):\n${list.join("\n") || "none yet"}`,
  ].join("\n\n");
}

const STATE = { proven: "proven", failing: "failing", weak: "weak", "not-run": "not run yet", planned: "planned", untested: "untested" };
const RANK = { high: 0, medium: 1, low: 2 };
/** A module's design, as Claude plans from it: behaviours by priority with their state, then the guide for its kinds. */
export function describeDesign(d) {
  const list = [...d.behaviours].sort((a, b) => RANK[a.priority] - RANK[b.priority]);
  const proven = d.behaviours.filter((b) => b.state === "proven").length;
  const lines = [d.designed ? `${d.module.name} (${d.module.path}): ${proven} of ${d.behaviours.length} behaviours proven.` : `${d.module.name} (${d.module.path}): ${d.note ?? "isn't designed yet."}`];
  for (const b of list) lines.push(`- ${b.name} (${b.kind}, ${b.priority}) — ${STATE[b.state] ?? b.state}${b.tests.length ? ` (${b.tests.map((t) => t.ref).join(", ")})` : ""}${b.status === "proposed" ? " — proposed, not confirmed yet" : ""}`);
  if (d.behaviours.length) lines.push("Untested and weak ones come first; a weak one needs its test to prove it (or a better test), not another test.");
  for (const [kind, g] of Object.entries(d.guide ?? {})) lines.push(`\nHow to test ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}:\n${g.consider.map((c) => `  • ${c}`).join("\n")}\n  QA Hub requires: ${g.gate}.`);
  return lines.join("\n");
}

/** Which QA Hub module a pushed test lands in — the server's own rules, checked before sending. */
function moduleFor(s, modules, t) {
  const exact = s.modules.find((m) => m.name === t.module) ?? s.modules.find((m) => m.name.toLowerCase() === t.module.toLowerCase()) ?? s.modules.find((m) => m.path === t.module);
  if (exact) return exact.name;
  if (modules.some((m) => m.name.toLowerCase() === t.module.toLowerCase())) return t.module;
  if (s.tests.some((x) => x.file === t.file && x.title === t.title) || t.replaces) return "(kept)";
  if (s.tests.some((x) => !x.file && x.module === t.module && x.title.toLowerCase() === t.title.toLowerCase())) return t.module; // its plan's module
  return null;
}

export function tools(env = process.env, cwd = process.cwd(), fetchImpl = fetch, { pollMs = 3_000, waitMs = 5 * 60_000 } = {}) {
  const qa = client({ key: env.QAHUB_KEY, server: env.QAHUB_SERVER, fetchImpl });
  const root = appRoot(cwd);
  const projectOf = (arg) => {
    const p = arg ?? linkedProject(root);
    if (!p) throw new QaHubError("This app folder isn't linked to a QA Hub project yet. Ask which project it is (qahub_status lists them), then call qahub_link.");
    if (!SLUG.test(p)) throw new QaHubError(`“${p}” isn't a QA Hub project name (lowercase letters, digits and dashes).`);
    return p;
  };
  // Wait for a run to finish, asking every few seconds; past the limit, say how to ask again.
  const follow = async (p, number, wait) => {
    const end = Date.now() + waitMs;
    for (;;) {
      const { run } = await qa.call("GET", `/api/v1/projects/${p}/runs/${number}`);
      if (run.status !== "running" || !wait || Date.now() > end) return describeRun(run, qa.origin());
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  return {
    async qahub_status() {
      const me = await qa.whoami({ fresh: true });
      const { projects } = await qa.call("GET", "/api/v1/projects");
      const linked = linkedProject(root);
      const summary = linked && projects.some((x) => x.slug === linked) ? await qa.call("GET", `/api/v1/projects/${linked}`).catch(() => null) : null;
      return [
        `Connected to QA Hub (${qa.origin()}) as ${me.user?.name ?? "?"} <${me.user?.email ?? "?"}> — ${me.company?.name ?? "your company"}, role ${me.role}.`,
        `Plan active until ${me.company?.expiresAt?.slice(0, 10) ?? "?"}.`,
        me.computer ? `Your computer: ${me.computer.name} (qahub ${me.computer.version}) — connected, so qahub_run can run tests.`
          : `Your computer isn't connected, so tests can't run yet: in QA Hub open Computers and run the connect command it shows (in a terminal on the computer where the app runs).`,
        `Projects: ${projects.map((p) => `${p.slug} (${p.name})`).join(", ") || "none yet — create one in QA Hub"}.`,
        linked ? `This folder is linked to: ${linked}.` : "This folder isn't linked to a project yet (qahub_link).",
        ...(summary ? [`Environments: ${summary.environments.map((e) => `${e.name} (${e.url})`).join(", ") || "none"}. Tests in QA Hub: ${summary.tests.length}.`] : []),
      ].join("\n");
    },
    async qahub_project({ project } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      return describeProject(await qa.call("GET", `/api/v1/projects/${p}`));
    },
    async qahub_design({ module, project } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      if (!String(module ?? "").trim()) throw new QaHubError("Say which module, e.g. module: \"Quotes\" (qahub_project lists them).");
      return describeDesign(await qa.call("GET", `/api/v1/projects/${p}/design?module=${encodeURIComponent(String(module).trim())}`));
    },
    async qahub_plan({ project, behaviours = [], tests = [] } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      const res = await qa.call("POST", `/api/v1/projects/${p}/plan`, { ...(behaviours.length ? { behaviours } : {}), tests });
      const n = res.planned.length;
      const lines = [];
      if (res.review && n) lines.push(`${n} test case${n === 1 ? "" : "s"} planned — waiting for review in QA Hub: ${qa.origin()}/p/${p}/tests. A person approves, asks for changes or rejects each one. Tell the user, and stop here for these tests: code for an unapproved plan is refused. Their answers show in qahub_gaps (changeRequests).`);
      else if (n) lines.push(`${n} test case${n === 1 ? "" : "s"} planned and approved — write ${n === 1 ? "its" : "their"} code now: each test("…") named exactly as planned, its test.step names equal to the planned steps.`);
      for (const x of res.planned) lines.push(`- ${x.ref} “${x.title}” in ${x.module} (${x.stage})`);
      // Already a test (it has code): its design was updated, not a new test — change ITS code and push it.
      if (res.updated?.length) lines.push(`Already tests — their test cases were updated, no new ones made. Change their code to match and qahub_push it (same file, same title):`);
      for (const x of res.updated ?? []) lines.push(`- ${x.ref} “${x.title}” in ${x.module}`);
      if (res.behaviours?.added?.length) lines.push(`Behaviours added${res.review ? " (proposed until approved)" : ""}: ${res.behaviours.added.join(", ")}.`);
      for (const d of res.behaviours?.dropped ?? []) lines.push(`“${d}” was dropped by a person — don't propose it again or test it.`);
      return lines.join("\n") || "Nothing planned.";
    },
    async qahub_find({ about, module, project } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      const q = String(about ?? "").trim();
      if (!q) throw new QaHubError("Say what behaviour to look for, e.g. about: \"save a quote\"");
      const { tests: found } = await qa.call("GET", `/api/v1/projects/${p}/tests?q=${encodeURIComponent(q)}${module ? `&module=${encodeURIComponent(module)}` : ""}`);
      if (!found.length) return `Nothing in QA Hub covers this yet (“${q}”) — a new test is welcome.`;
      const line = (t) => `${t.same ? "SAME: " : "related: "}${t.ref} “${t.title}” (${t.module}, ${t.by}; ${t.file})${t.description ? ` — ${t.description}` : ""}\n    ${t.steps.slice(0, 12).join(" → ") || "no steps"}`;
      const same = found.filter((t) => t.same);
      return [
        ...found.map(line),
        same.length ? `${same.map((t) => t.ref).join(", ")} already ${same.length === 1 ? "tests" : "test"} this — don't write a second test. Improve ${same.length === 1 ? "it" : "one of them"} if it's missing a check (a test Claude wrote: push its file with the same title; a recorded one: tell the person what to add). QA Hub refuses a duplicate.`
          : "None of these is the same test; if yours checks something they don't, write it.",
      ].join("\n");
    },
    async qahub_pull({ overwrite = [], project } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      const { files } = await qa.call("GET", `/api/v1/projects/${p}/files?content=1`);
      const realRoot = fs.realpathSync(root);
      const titles = (src) => [...String(src).matchAll(/\btest(?:\.(?:only|skip|fixme))?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
      const added = [], replaced = [], same = [], differs = [], refused = [];
      for (const f of files) {
        const rel = String(f.path);
        const dest = path.resolve(root, rel);
        const inside = path.relative(root, dest);
        if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || /(^|\/)(\.git|node_modules)(\/|$)/.test(rel) || /^\.env/i.test(path.basename(rel))) { refused.push(rel); continue; }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (path.relative(realRoot, fs.realpathSync(path.dirname(dest))).startsWith("..")) { refused.push(rel); continue; } // a symlinked folder pointing out
        // A file a test uploads: its bytes, compared byte for byte.
        if (f.binary) {
          if (!f.base64) { refused.push(`${rel} (QA Hub no longer has its bytes)`); continue; }
          const bytes = Buffer.from(f.base64, "base64");
          if (!fs.existsSync(dest)) { fs.writeFileSync(dest, bytes); added.push(rel); continue; }
          if (Buffer.compare(fs.readFileSync(dest), bytes) === 0) { same.push(rel); continue; }
          if (overwrite.includes(rel)) { fs.writeFileSync(dest, bytes); replaced.push(rel); continue; }
          differs.push(`${rel} — QA Hub has a different file`);
          continue;
        }
        if (!fs.existsSync(dest)) { fs.writeFileSync(dest, f.content); added.push(rel); continue; }
        const local = fs.readFileSync(dest, "utf8");
        if (local === f.content) { same.push(rel); continue; }
        if (overwrite.includes(rel)) { fs.writeFileSync(dest, f.content); replaced.push(rel); continue; }
        const theirs = titles(f.content).filter((x) => !titles(local).includes(x));
        differs.push(`${rel}${theirs.length ? ` — QA Hub's copy also has ${theirs.map((x) => `“${x}”`).join(", ")}` : ""}`);
      }
      return [
        `QA Hub's test files for ${p}: ${files.length}.`,
        ...(added.length ? [`Added: ${added.join(", ")}.`] : []),
        ...(replaced.length ? [`Replaced with QA Hub's copy: ${replaced.join(", ")}.`] : []),
        ...(differs.length ? [`Different here: ${differs.join("; ")}. Keep both sides: add the teammates' tests to your copy (or take QA Hub's with overwrite and re-add yours), then push.`] : []),
        ...(refused.length ? [`Not written (path not allowed here): ${refused.join(", ")}.`] : []),
        ...(!added.length && !replaced.length && !differs.length ? ["This folder already has QA Hub's latest."] : []),
      ].join("\n");
    },
    async qahub_link({ project }) {
      await qa.whoami();
      const p = projectOf(String(project ?? "").trim().toLowerCase());
      const { projects } = await qa.call("GET", "/api/v1/projects");
      if (!projects.some((x) => x.slug === p)) throw new QaHubError(`No project “${p}” in your company's QA Hub. Projects: ${projects.map((x) => x.slug).join(", ") || "none"}.`);
      fs.writeFileSync(path.join(root, LINK_FILE), JSON.stringify({ project: p }, null, 2) + "\n");
      return `Linked ${root} to the QA Hub project “${p}” (${LINK_FILE} — commit it so teammates share the link; it holds no secret).`;
    },
    async qahub_gaps({ project } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      const g = await qa.call("GET", `/api/v1/projects/${p}/gaps`);
      // Behaviours first: what should be tested and isn't, highest priority first (QA Hub sorts them).
      const b = g.behaviours ?? { untested: [], failing: [], weak: [], notDesigned: [] };
      const lines = [];
      if (b.untested.length) lines.push(`Test next: ${b.untested.slice(0, 10).map((x) => `${x.name} (${x.module}, ${x.kind}, ${x.priority})`).join("; ")}.`);
      if (b.failing.length || b.weak.length) lines.push(`Not proven: ${[...b.failing, ...b.weak].slice(0, 10).map((x) => `${x.name} (${x.module}, ${b.failing.includes(x) ? "failing" : "weak"})`).join("; ")}.`);
      if (b.notDesigned.length) lines.push(`Not designed yet: ${b.notDesigned.join(", ")} — qahub_design them and propose their behaviours.`);
      return [...lines, JSON.stringify(g, null, 2)].join("\n");
    },
    async qahub_run({ project, tests, tag, module, set, environment, browser, show = false, wait = true } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      if ([tests?.length ? tests : null, tag, module, set].filter(Boolean).length > 1) throw new QaHubError("Pick tests by one of: tests, tag, module or set.");
      const body = { ...(tests?.length ? { tests } : {}), ...(tag ? { tag } : {}), ...(module ? { module } : {}), ...(set ? { set } : {}), ...(environment ? { environment } : {}), ...(browser ? { browser } : {}), headless: !show };
      const { run } = await qa.call("POST", `/api/v1/projects/${p}/runs/start`, body).catch((e) => {
        // Not connected (or an old qahub): what the person does about it, in one line Claude can relay.
        if (/Connect your computer/i.test(e.message)) throw new QaHubError(`${e.message} Tell the person once: in QA Hub → Computers, run the connect command it shows in a terminal on the computer where the app runs, and leave it open. Until then the tests are sent but not run.`);
        throw e;
      });
      if (!wait) return `Run #${run.number} started: ${run.tests} test${run.tests === 1 ? "" : "s"} on ${run.environment} — ${qa.origin()}${run.url}\nRead it with qahub_results { run: ${run.number}, wait: true }.`;
      return follow(p, run.number, true);
    },
    async qahub_results({ project, run, wait = false } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      if (run !== undefined && !(Number.isInteger(run) && run > 0)) throw new QaHubError("run is a run number, like 12");
      return follow(p, run ?? "latest", wait);
    },
    async qahub_push({ project, files = [], tests = [], modules = [], remove = [], behaviours = [] } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      // Every new test lands in a real module: refused here, before anything is sent, with what to do.
      if (tests.length) {
        const s = await qa.call("GET", `/api/v1/projects/${p}`);
        const lost = [...new Set(tests.filter((t) => !moduleFor(s, modules, t)).map((t) => t.module))];
        if (lost.length) {
          throw new QaHubError(`${lost.map((m) => `Module “${m}”`).join(", ")} isn't in QA Hub, so ${lost.length === 1 ? "its tests" : "those tests"} would land in Inbox. QA Hub's modules: ${s.modules.map((m) => m.name).join(", ") || "none yet"}. Use one of those (the one for the page the test covers), or — if it's a part of the app QA Hub doesn't have yet — add it in the same push: modules: [{ name: "${lost[0]}", path: "/…", parent: "/…" }] (its URL path; parent only for a sub-page). Nothing was sent.`);
        }
      }
      const body = { files: files.map((f) => readAppFile(root, f)), tests, modules, ...(remove.length ? { remove } : {}), ...(behaviours.length ? { behaviours } : {}) };
      const res = await qa.call("POST", `/api/v1/projects/${p}/tests`, body);
      const refs = res?.refs ?? [];
      return [
        `Sent to QA Hub (${p}): ${files.length} file(s), ${tests.length} test(s).`,
        ...(res?.modules?.added?.length ? [`Modules added: ${res.modules.added.map((m) => `${m.name} (${m.path})`).join(", ")}.`] : []),
        ...(res?.modules?.named ?? []).map((m) => `QA Hub calls ${m.path} “${m.qahub}” (you said “${m.yours}”) — use “${m.qahub}” from now on.`),
        ...(refs.length ? [`Tests: ${refs.map((r) => `${r.ref} “${r.title}”${r.module ? ` in ${r.module}` : ""}`).join(", ")}.`, `Run them now: qahub_run { tests: ${JSON.stringify(refs.map((r) => r.ref))} }`] : []),
        ...refs.filter((r) => r.note).map((r) => `${r.ref}: ${r.note}.`),
        ...(res?.inbox?.length ? [`In Inbox (no module): ${res.inbox.join("; ")}.`] : []),
        ...(res?.removed?.length ? [`Moved to QA Hub's recycle bin: ${res.removed.join(", ")}.`] : []),
        JSON.stringify(res, null, 2),
      ].join("\n");
    },
  };
}

// ---- MCP over stdio ------------------------------------------------------------------------------
export function serve(input = process.stdin, output = process.stdout, impl = tools()) {
  const send = (msg) => output.write(JSON.stringify(msg) + "\n");
  const rl = readline.createInterface({ input });
  rl.on("line", async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    const { id, method, params } = msg;
    if (id === undefined) return; // a notification (initialized, cancelled…)
    try {
      if (method === "initialize") {
        return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "qahub", version: VERSION } } });
      }
      if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
      if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      if (method === "tools/call") {
        const fn = impl[params?.name];
        if (!fn) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
        try {
          const text = await fn(params.arguments ?? {});
          return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
        } catch (e) {
          // A refusal is an answer Claude should read and relay, not a crash.
          const text = e instanceof QaHubError ? e.message : `QA Hub plugin error: ${String(e?.message ?? e).slice(0, 300)}`;
          return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });
        }
      }
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message ?? e).slice(0, 300) } });
    }
  });
  return rl;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server/index.mjs")) serve();
