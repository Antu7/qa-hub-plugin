#!/usr/bin/env node
// The QA Hub MCP server inside the Claude Code plugin: newline-delimited JSON-RPC (MCP) on stdin/stdout.
// No dependencies. Every tool checks the API key first (see qahub.mjs) — a revoked key or an ended plan
// stops it within a minute, whatever the session already had.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { client, gitBranch, isMain, QaHubError, VERSION } from "./qahub.mjs";

const LINK_FILE = "qahub.json"; // in the app's repository: { "project": "<slug>" }
const MAX_FILE = 512 * 1024;
const MAX_UPLOAD = 10 * 1024 * 1024; // a file a test uploads (a picture, a PDF)
const CODE = /\.(ts|js|mjs|cjs|json)$/i;
/** Text, or bytes (a picture, a PDF, a spreadsheet)? Read as UTF-8 strictly: anything that isn't is bytes. */
const asText = (buf) => { if (buf.includes(0)) return null; try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return null; } };
const SLUG = /^[a-z0-9-]{1,60}$/;
const MAX_PUSH = 29 * 1024 * 1024; // QA Hub takes a push body up to 30 MB
const SLOW = 120_000; // a push or a pull carries whole files

/**
 * Where a test file may live — QA Hub's own rule (lib/paths.ts), applied here too, both ways: before a file is
 * read to send it, and before a file QA Hub sends is written. Nothing hidden (.git, .claude, .github, .env…),
 * nothing in node_modules, only code and files a test uploads. Returns why not, or null.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ALLOWED = /\.(ts|js|mjs|cjs|json|csv|txt|xml|png|jpe?g|gif|webp|svg|bmp|pdf|xlsx?|docx?|pptx|zip|mp4|mov|mp3|wav)$/i;
// Kept equal to QA Hub's apps/web/src/lib/paths.ts RESERVED (test/plugin.test.mjs pins the list).
const RESERVED = new Set(["playwright.config.ts", "playwright.config.js", "package.json", "package-lock.json", ".env", ".env.local"]);
export function pathProblem(rel) {
  if (typeof rel !== "string" || !rel || rel.length > 300) return "not a usable path";
  if (rel.includes("\\")) return "use forward slashes";
  if (RESERVED.has(rel)) return "QA Hub makes this file itself";
  const segs = rel.split("/");
  if (segs.some((x) => !SEGMENT.test(x))) return "hidden or unusual folder or file name";
  if (segs.some((x) => x.toLowerCase() === "node_modules")) return "inside node_modules";
  if (!ALLOWED.test(rel)) return "only code and files a test uploads";
  return null;
}
const inside = (root, p) => { const r = path.relative(root, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };

/**
 * The folder this app lives in: the nearest one up with qahub.json, else a git root, else the cwd.
 * Never the home folder because it is a git repo (dotfiles): that would make all of home "the app".
 */
export function appRoot(start = process.cwd(), home = os.homedir()) {
  const from = path.resolve(start);
  for (let d = from; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, LINK_FILE))) return d;
    if (d !== home && fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return from;
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
  const why = pathProblem(rel2);
  if (why) throw new QaHubError(`${rel}: can't be sent to QA Hub (${why})`);
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

export const TOOLS = [
  {
    name: "qahub_status",
    description: "Check the QA Hub connection: whose API key this is, whether the company's plan is active, the company's projects, and which project this app folder is linked to. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "qahub_project",
    description: "The project's structure in QA Hub — read it before writing tests: the module tree (each module's address and how many tests it has), the hand-picked sets, every test on one line (ref, title, module, tags, file, what it protects), the tags in use, the spec folders and the shared helper files. With module: that module's tests in full — steps, test data, whether each counts yet. Put each new test in the module for the part of the app it covers; reuse the helpers; don't write a test that already exists.",
    inputSchema: { type: "object", properties: { module: { type: "string", description: "A module's name or address: its tests with their steps and test data" }, project: { type: "string", description: "Leave out to use the linked project" } }, additionalProperties: false },
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
    name: "qahub_helpers",
    description: "Before writing ANY helper (a function or value in a non-spec file): the project's helpers — every teammate's — best matches first: name(params) — what it does · its file · which modules' tests use it, and where one is written twice. Import an existing one; never write a second helper that does the same. One a second module needs moves to qahub/shared/ (update its importers in the same push). Without query: the module's own helpers, the ones it uses and the shared ones.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      query: { type: "string", description: "What the helper does, in a few words or its name, e.g. \"refused save message\"" },
      module: { type: "string", description: "The module you work on" },
      project: { type: "string", description: "Leave out to use the linked project" },
    } },
  },
  {
    name: "qahub_knowledge",
    description: "What QA Hub knows about this app, kept for the whole team and filed like an index: under each module (its own topic — journey, fields and rules, test data that works, bugs — and its pages' topics), then overall (the code map, \"app\", pages in no module). Read it BEFORE the code: faster, and it saves your usage. Without arguments: the index, with whether each topic is up to date (changed: files the code changed since). module: everything filed under that module, in full — read only the module you work on. topic: one topic in full.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      module: { type: "string", description: "A module's name (or address): its topics in full" },
      topic: { type: "string", description: "One topic in full: a module's name, \"page /address\", \"app\"" },
      project: { type: "string", description: "Leave out to use the linked project" },
    } },
  },
  {
    name: "qahub_code",
    description: "The app's code from the project's GitHub repo, read-only — for when this folder doesn't have the app's code (a QA without a checkout). One of: path (a file's text), search (files whose code mentions some words, e.g. a button's label or an error message), under (the files in a folder; \"\" for the whole repo). Read qahub_knowledge first; after reading, qahub_learn what you found so nobody reads it again.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      path: { type: "string" }, search: { type: "string" }, under: { type: "string" },
      project: { type: "string", description: "Leave out to use the linked project" },
    } },
  },
  {
    name: "qahub_learn",
    description: "Save what you learned about this app's code so the next Claude (any teammate's) needn't read it again: one topic — \"app\" for the whole, or a module — in plain words a tester can use (routes and their source files; each form's fields, required ones, formats and limits; success and error messages; who may do what; the main flows and their edge cases). Facts, not code. Give the files you read and the commit (git rev-parse HEAD). Saving a topic again replaces it.",
    inputSchema: { type: "object", additionalProperties: false, required: ["topic", "body", "files"], properties: {
      topic: { type: "string" },
      body: { type: "string", description: "Plain-words facts, up to ~20,000 characters" },
      files: { type: "array", items: { type: "string" }, description: "Source files it came from, paths from the repo root" },
      sha: { type: "string", description: "The commit it reflects (git rev-parse HEAD), if this folder is a git checkout" },
      project: { type: "string", description: "Leave out to use the linked project" },
    } },
  },
  {
    name: "qahub_wait_review",
    description: "After qahub_plan says test cases wait for a person: wait here until each is decided in QA Hub — approved (write its code now), sent back with changes (plan it again with the change), or rejected (drop it) — then carry on by yourself. Tell the user first that you're waiting for their decision in QA Hub. Checks every few seconds, up to `minutes` (default 10).",
    inputSchema: { type: "object", additionalProperties: false, required: ["tests"], properties: {
      tests: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" }, description: "The refs waiting for review (TEST-00012)" },
      minutes: { type: "integer", minimum: 1, maximum: 15 },
      project: { type: "string", description: "Leave out to use the linked project" },
    } },
  },
  {
    name: "qahub_map",
    description: "Map the app: send the WHOLE list of its modules (the feature areas a tester would name), so QA Hub knows every part of the app and shows what has no tests. Only organises — never tests or changes the app. Do it yourself, without asking, when qahub_gaps says the app isn't mapped: build the list from qahub_knowledge's page topics (\"page /address\") or the app's routes — one module per feature area (path = its page address), sub-pages with parent = the parent's path. Names stay plain (\"Customers\", \"Customer list\"). A first map is open to anyone who writes tests; mapping again is for admins and project managers.",
    inputSchema: { type: "object", additionalProperties: false, required: ["modules"], properties: {
      modules: { type: "array", minItems: 1, maxItems: 300, items: { type: "object", additionalProperties: false, required: ["name", "path"], properties: {
        name: { type: "string" }, path: { type: "string", description: "The page's address, e.g. /admin/customers" }, parent: { type: "string", description: "The parent module's path, for a sub-page" },
      } } },
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
    inputSchema: { type: "object", properties: { project: { type: "string", description: "The project's short name (slug), e.g. freight-portal" },
      force: { type: "boolean", description: "Link even though this folder's GitHub repo isn't one of the project's — only once the user confirms it's the right project" } }, required: ["project"], additionalProperties: false },
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
              steps: { type: "array", items: { anyOf: [{ type: "string" }, { type: "object", required: ["title", "expect"], properties: { title: { type: "string" }, expect: { type: "string" } } }] }, description: "Its test.step names in order, each with what should happen (for a test QA Hub already has, plain strings keep the stored expected results)" },
              type: { type: "string", enum: ["functional", "negative", "boundary", "validation", "permission", "workflow", "smoke"], description: "Required for a new test" }, priority: { type: "string", enum: ["high", "medium", "low"] },
              preconditions: { type: "string" }, covers: { type: "array", items: { type: "string" }, description: "Behaviour names of its module it verifies (required for a new test unless smoke)" },
              waiver: { type: "string", description: "Only with a true reason (20+ characters) why the code can't prove what QA Hub's depth check asks — shown in QA Hub; the behaviour then never reads proven" },
              description: { type: "string", maxLength: 600, description: "1-3 plain sentences: what the test checks, which user or situation it stands for, and what would count as broken. Always fill it — you and others read it when coming back to this test." },
              replaces: { type: "string", description: "The test's ref (e.g. TEST-00012) when this push renames it or moves it to another file — it keeps its number and history" },
              applied: { type: "boolean", description: "true when this push applies the change request qahub_gaps listed for this test" },
              sets: { type: "array", items: { type: "string" }, description: "Hand-picked sets (by name, from qahub_project) this test should join — only when the person asked, or it clearly belongs (e.g. a release check)" },
              distinctFrom: { type: "array", items: { type: "string" }, description: "Refs QA Hub flagged as possible duplicates that you read and that test something else" },
              knownBug: { type: "string", maxLength: 300, description: "Only in the recorder chat, only for a test that checks the RIGHT behaviour and fails because the APP is wrong: what is wrong, in plain words. Such a test is saved tagged known-bug (the person sees it) — every other test must have passed twice in try_tests first. Tell the person too (\"Needs you: …\")." },
              data: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,39}$" }, value: { type: "string", maxLength: 500 }, variable: { type: "string", pattern: "^[a-z][a-z0-9_]{0,39}$", description: "A project variable (qahub_project → Variables, or one you send in variables) that gives this value a NEW value every run; value stays the fallback" } } }, description: "The values the test types: name (lower_snake_case), default, and — for anything whose exact value doesn't decide what the test proves (names, titles, emails, amounts, dates, notes) — variable, so every run tries different data. The code reads them: const data = JSON.parse(process.env.QAHUB_DATA ?? \"{}\"); data.course_title ?? \"Fire safety basics\" — and checks the app shows data.course_title, never a hard-coded copy. A person's own choice (a value made fixed or linked elsewhere) survives your push. Leave out = unchanged" },
              runAs: { type: "string", description: "The test account this test starts signed in as — a name from qahub_project's Test accounts, chosen by ROLE for what the test proves (a permission test runs as the role that should, or shouldn't, be allowed). Leave out for the default account. Switching mid-test: await qahub.signInAs(page, \"<name>\"); a second person at the same time: const other = await qahub.as(\"<name>\") — a second signed-in page (take qahub from the test's fixtures), name written out" },
              needs: { type: "array", maxItems: 10, items: { type: "string" }, description: "ONLY when this test uses what another test makes (\"Delete the order\" needs \"Create an order\"): that test's ref or exact title (one in this push counts). It then runs first, and if it fails this test is skipped — every other test still runs. Leave out for an independent test (the normal case); [] removes a link" },
            },
          },
        },
        behaviours: { type: "array", items: { type: "object", required: ["module", "name", "kind"], properties: { module: { type: "string" }, name: { type: "string" }, kind: { type: "string", enum: ["create", "view", "edit", "delete", "search", "validation", "workflow", "permission", "calculation", "navigation", "other"] }, priority: { type: "string", enum: ["high", "medium", "low"] }, description: { type: "string" } } }, description: "Behaviours the app has that QA Hub doesn't list yet (a test in this push may cover one)" },
        variables: {
          type: "array", maxItems: 30, description: "Project variables a test's data links to that qahub_project doesn't list yet — created (one that exists is the person's and is left as it is). Reuse an existing one when it fits. Rules must be what the app ACCEPTS (a title field taking 3–80 characters: minLength 3, maxLength 80), so every drawn value is valid input",
          items: { type: "object", additionalProperties: false, required: ["name", "kind"], properties: {
            name: { type: "string", pattern: "^[a-z][a-z0-9_]{0,39}$" },
            kind: { type: "string", enum: ["text", "number", "date", "email", "list"] },
            rules: { type: "object", additionalProperties: false, description: "text: minLength, maxLength, letters, digits, spaces, symbols; number: min, max, decimals; date: fromDays, toDays (from today), format; email: domain", properties: {
              minLength: { type: "integer", minimum: 1, maximum: 500 }, maxLength: { type: "integer", minimum: 1, maximum: 500 }, letters: { type: "boolean" }, digits: { type: "boolean" }, spaces: { type: "boolean" }, symbols: { type: "boolean" },
              min: { type: "number" }, max: { type: "number" }, decimals: { type: "integer", minimum: 0, maximum: 6 },
              fromDays: { type: "integer" }, toDays: { type: "integer" }, format: { type: "string", enum: ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD.MM.YYYY"] }, domain: { type: "string" } } },
            values: { type: "array", maxItems: 200, items: { type: "string", maxLength: 500 }, description: "list: the values to pick from (real-looking options the app accepts)" },
            pick: { type: "string", enum: ["random", "round"], description: "list: random each time, or one by one" },
            tricky: { type: "string", enum: ["no", "sometimes"], description: "sometimes = about one run in five uses an edge value inside the rules (the longest/shortest allowed, accents, quotes and <, other scripts, min/max/0) — use it for fields where that finds bugs" },
          } },
        },
        remove: { type: "array", items: { type: "string" }, description: "Refs of tests to take out on purpose (they go to QA Hub's recycle bin) — e.g. a test deleted from its file. Never to get past a refusal." },
        labels: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["name", "description"], properties: { name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,29}$" }, description: { type: "string", maxLength: 200, description: "What the label means, in plain words a non-tester understands" } } }, description: "New labels a test of this push uses that qahub_project's Labels doesn't have — only when no existing label fits. An existing label is never changed here." },
        fewerChecks: { type: "string", minLength: 20, maxLength: 300, description: "ONLY when a check (expect) truly has to go because the app changed on purpose — the real reason. While a person has asked you to fix a test, a push that removes checks is refused without it; never use it to make a failing test pass" },
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
        environment: { type: "string", description: "Which environment (qahub_status lists them); leave out for the project's default place" },
        allowProduction: { type: "boolean", description: "Only when the person said yes in so many words: run on a PRODUCTION place tests that aren't tagged read-only — they may create or delete real data there. QA Hub refuses it otherwise." },
        browser: { type: "string", enum: ["chrome", "firefox", "webkit", "edge"] },
        show: { type: "boolean", description: "true opens a visible browser window on the person's computer (default: runs in the background)" },
        repeat: { type: "integer", minimum: 1, maximum: 10, description: "Run each test this many times in a row. A test with dynamic data (data linked to variables) gets NEW values on every try — repeat 5 tries 5 different inputs, and a failure shows the values that broke it (a bug that depends on the data, not a flaky test). Without dynamic data, 5 checks whether a test is flaky (\"Failed 2 of 5 times\")" },
        parallel: { type: "integer", minimum: 1, maximum: 8, description: "How many tests run at once, each in its own tab (default 4). A test with needs still waits for that test; tests on a one-at-a-time account take turns. 1 only for tests that change the same data and can't run side by side" },
        where: { type: "string", enum: ["computer", "server"], description: "\"server\" runs it on QA Hub's own test computers (no computer of the person's needed; always headless; only for apps reachable from the internet). Default: the person's computer" },
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
  {
    name: "qahub_fixes",
    description: "Failing tests a person asked you to fix (\"Ask Claude to fix it\" in QA Hub): each with the step it failed at, the error in plain words and exactly as Playwright said it, what the test is for, and the screenshot of the moment it failed. Read them, find the cause, fix it, then qahub_fix_note and re-run the test.",
    inputSchema: { type: "object", additionalProperties: false, properties: { project: { type: "string", description: "Leave out to use the linked project" } } },
  },
  {
    name: "qahub_fix_note",
    description: "Answer a fix request in plain words a non-programmer understands — shown on the run page in QA Hub. kind: \"app\" (the app had a bug and you fixed the app), \"test\" (the app changed on purpose and you updated the test), or \"neither\" (you couldn't fix it — say what a person should look at). Then re-run the test with qahub_run; a pass marks it fixed.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["test", "kind", "note"],
      properties: {
        project: { type: "string", description: "Leave out to use the linked project" },
        test: { type: "string", description: "The test's ref, e.g. TEST-00005" },
        kind: { type: "string", enum: ["app", "test", "neither"] },
        note: { type: "string", minLength: 10, maxLength: 500, description: "One or two plain sentences: what was wrong and what you changed (e.g. \"The Create training dialog kept the last title when reopened. It now starts empty.\")" },
      },
    },
  },
  {
    name: "qahub_look",
    description: "Before writing a test for a page: open it in the app — on the person's computer, signed in, at the project's address — and read what is really there: every control with its role and name (exactly what getByRole/getByLabel need), where it landed (a sign-in page means the session didn't hold), the app's own errors, and a picture. Opened and read, never clicked. Use it for every page a test touches, with or without the app's code.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["path"],
      properties: {
        path: { type: "string", description: "The page's path in the app, e.g. /quotes or /quotes/new?tab=items" },
        environment: { type: "string", description: "An environment's name; leave out for the project's first one" },
        project: { type: "string", description: "Leave out to use the linked project" },
      },
    },
  },
];

const KIND = { bug: "the app broke", missing: "something on the page changed — check whether the app or the test is right", blocked: "a captcha or bot wall stopped it (not a bug)",
  setup: "a step couldn't be done (covered, hidden, disabled, a page that didn't open), so the test never reached its checks — find what got in the way before calling it a bug" };
/** A run, in words Claude acts on: what failed, where, why, and the page with the video and trace. */
/** Where a failure happened: the page (address, title, what it showed), the failing code lines, the values typed. */
export function whereItFailed(ctx, values) {
  const out = [];
  if (ctx?.url) out.push(`It ended on: ${ctx.url}${ctx.title ? ` (“${ctx.title}”)` : ""}`);
  if (ctx?.page) out.push(`The page showed (its main part, or the open dialog):\n${ctx.page.split("\n").slice(0, 60).map((l) => `    ${l}`).join("\n")}`);
  if (ctx?.code) out.push(`${ctx.at ? `${ctx.at.file}:${ctx.at.line}` : "The code"}:\n${ctx.code.split("\n").slice(0, 12).map((l) => `    ${l}`).join("\n")}`);
  const v = values && Object.entries(values);
  if (v?.length) out.push(`Values it used: ${v.slice(0, 8).map(([k, x]) => `${k} = “${x}”`).join(", ")}`);
  return out.length ? `\n  ${out.join("\n  ")}` : "";
}

export function describeRun(run, origin) {
  const url = `${origin}${run.url}`;
  if (run.status === "running") return `Run #${run.number} is still running (${run.tests} test${run.tests === 1 ? "" : "s"}) — ${url}\nAsk again with qahub_results { run: ${run.number}, wait: true }.`;
  const lines = [`Run #${run.number} finished: ${run.passed} passed, ${run.failed} failed${run.skipped ? `, ${run.skipped} skipped` : ""}${run.browser ? ` (${run.browser}${run.durationSec ? `, ${run.durationSec} s` : ""})` : ""}${run.failed || run.verdict !== "pass" ? "" : " — all passed"} — ${url}`];
  if (run.trial) lines.push("This was a try of a test that hasn't passed yet: it stays out of Results, and nobody is told. The first passing try goes into Results.");
  if (run.verdict === "stopped") lines.push(`It stopped before the end${run.stopReason ? `: ${run.stopReason}` : ""}.`);
  for (const f of run.failures ?? []) {
    lines.push(`- ${f.ref ?? "(deleted test)"} “${f.title}”${f.file ? ` (${f.file})` : ""} failed${f.failedStep ? ` at “${f.failedStep}”` : ""}${f.kind && KIND[f.kind] ? ` — ${KIND[f.kind]}` : ""}${f.since ? `; ${f.since}` : ""}.\n  ${f.error ?? "No error text."}${f.evidence?.length ? `\n  The app said: ${f.evidence.slice(0, 2).join(" | ")}` : ""}${whereItFailed(f.context, f.values)}`);
  }
  if (run.notRun?.length) lines.push(`Didn't run: ${run.notRun.slice(0, 20).map((x) => `${x.ref ?? "(deleted test)"} “${x.title}”${x.reason ? ` (${x.reason})` : ""}`).join("; ")}${run.notRun.length > 20 ? "; …" : ""}.`);
  if (run.flaky?.length) lines.push(`Flaky: ${run.flaky.map((x) => `${x.ref} “${x.title}”`).join(", ")} — passed only on the second try; find what makes it unreliable (a wait for the wrong thing, data left by an earlier test).`);
  if (run.failed) lines.push("Next: for each failure decide whether the app is wrong (fix the app) or the test no longer matches the app (fix the test). Never make it pass by checking less or waiting longer. A step that waited for something that never came: look where it ended and what the page showed, then read the app's code for the step before it (what that click or save really does — a redirect, a dialog, a different page) — find out, don't guess a new locator. If the test created something before it failed, check it was cleaned up (finally) and say if anything was left behind. Then push and run again. The video and trace are on the run page.");
  else if (run.skipped) lines.push("Skipped tests didn't run — usually because a test before them failed, or they have no recorded steps or stored file.");
  return lines.join("\n");
}

/**
 * The project's structure, as Claude reads it: modules as a tree, sets, tags, files, tests by module — each test on
 * one line, so it stays cheap to read on every task. With `module`: only that module's tests, in full.
 */
export function describeProject(s, module) {
  const want = module ? s.modules.find((m) => m.name.toLowerCase() === String(module).trim().toLowerCase() || m.path === String(module).trim()) : null;
  if (module && !want) throw new QaHubError(`No module “${module}” in this project. Modules: ${s.modules.map((m) => m.name).join(", ") || "none yet"}.`);
  const kids = (parent) => s.modules.filter((m) => (m.parent ?? null) === parent);
  const tree = [];
  const walk = (parent, depth) => { for (const m of kids(parent)) { tree.push(`${"  ".repeat(depth)}- ${m.name} (${m.path}) — ${m.tests ? `${m.tests} test${m.tests === 1 ? "" : "s"}` : "no tests yet"}${m.locked ? " — LOCKED by a person: never add, change or remove its tests" : ""}`); if (depth < 6) walk(m.path, depth + 1); } };
  walk(null, 0);
  // A module whose parent isn't in the list still shows (at the top).
  for (const m of s.modules) if (m.parent && !s.modules.some((x) => x.path === m.parent)) tree.push(`- ${m.name} (${m.path}) — ${m.tests} test(s)`);
  const byModule = new Map();
  for (const t of s.tests) if (!want || t.module === want.name) byModule.set(t.module, [...(byModule.get(t.module) ?? []), t]);
  const MAX = 300;
  const list = [];
  let shown = 0;
  for (const [mod, ts] of byModule) {
    list.push(`${mod}:`);
    for (const t of ts) {
      if (shown++ >= MAX) break;
      list.push(`  ${t.ref} “${t.title}” (${t.file ?? (t.stage === "planned" ? "planned, waiting for review" : "planned, approved — no code yet")})${t.type ? ` [${t.type}${t.priority === "high" ? ", high" : ""}${t.depth ? `, ${t.depth}` : ""}]` : ""}${t.tags?.length ? ` ${t.tags.map((x) => `@${x}`).join(" ")}` : ""}${t.needs?.length ? ` — needs ${t.needs.join(", ")}` : ""}${t.runAs ? ` — as ${t.runAs}` : ""}${t.signsInAs?.length ? ` (switches to ${t.signsInAs.join(", ")})` : ""}${t.description ? ` — ${t.description}` : ""}${t.by ? ` — ${t.by}` : ""}`);
      if (!want) continue; // steps and data: one module at a time
      if (t.steps?.length) list.push(`    ${t.steps.slice(0, 12).join(" → ")}`);
      // Its test data (QAHUB_DATA) as QA Hub holds it: a person may have changed a value, or made it vary each run.
      if (t.verified === false) list.push(`    not counted yet: passed ${t.passes ?? 0} of 2 times since its code changed — run it (repeat: 2)`);
      if (t.data?.length) list.push(`    data: ${t.data.map((d) => (d.varies ? `${d.name} (different every run${d.variable ? `: ${d.variable}` : ""})` : `${d.name} = “${d.value}”${d.fixedByPerson ? " (fixed by a person — leave it)" : ""}`)).join(", ")}`);
    }
  }
  const total = [...byModule.values()].reduce((n, x) => n + x.length, 0);
  if (total > MAX) list.push(`…and ${total - MAX} more (${total} tests in all).`);
  if (!want) list.push("Each test's steps and test data, one module at a time: qahub_project { module }.");
  return [
    `Project ${s.slug}${s.name ? ` (${s.name})` : ""}.`,
    `Modules (the app's areas, in its menu order — a test belongs to the one for the page it covers):\n${tree.join("\n") || "none yet"}`,
    ...(s.modules.some((m) => m.behaviours?.length) ? [`Behaviours (what each module should be tested for — qahub_design shows one module with its guide):\n${s.modules.filter((m) => m.behaviours?.length)
      .map((m) => `${m.name}: ${m.behaviours.map((b) => `${b.name} [${b.state}${b.priority === "high" ? ", high" : ""}]`).join("; ")}`).join("\n")}`]
      : ["Behaviours: none designed yet — qahub_design a module, then propose its behaviours with qahub_plan."]),
    `Sets (hand-picked, run in this order): ${s.sets?.length ? `\n${s.sets.map((x) => `- ${x.name}${x.description ? ` — ${x.description}` : ""}: ${x.tests.join(", ") || "empty"}`).join("\n")}` : "none"}. Every module and every tag is also a set of its own, automatically.`,
    describeLabels(s),
    `Spec folders: ${s.folders?.join(", ") || "none yet"}. Shared helpers: ${s.helpers?.join(", ") || "none yet"}.`,
    ...(s.helperIndex ? [describeHelperIndex(s.helperIndex)] : []),
    `Environments: ${s.environments.map((e) => `${e.name} (${e.url})`).join(", ") || "none"}.`,
    describeAccounts(s),
    describeVariables(s),
    `Tests (${s.tests.length}):\n${list.join("\n") || "none yet"}`,
  ].join("\n\n");
}

/** The helpers catalog, compact: how many, where, and what's written twice — qahub_helpers searches it. */
export function describeHelperIndex(h) {
  if (!h.total) return "Helpers: none yet. Before writing one, qahub_helpers; one two modules need goes in qahub/shared/.";
  return [`Helpers: ${h.total} in ${h.files.length} file${h.files.length === 1 ? "" : "s"} — ${h.files.map((f) => `${f.file} ${f.count}${f.module ? ` (${f.module})` : ""}`).join(", ")}. Before writing a helper, qahub_helpers { query } — import one that exists, never write a second.`,
    ...(h.duplicates.length ? [`Written twice (import one, drop the other): ${h.duplicates.slice(0, 10).map((d) => `${d.name} (${d.files.join(", ")})`).join("; ")}.`] : [])].join("\n");
}

/** One helper on one line: name(params) — what it does · file · used by: … (and where it's written twice). */
export const helperLine = (x) => `${x.name}${x.params === null ? "" : `(${x.params})`} — ${x.description || "no description"} · ${x.file}${x.usedBy.length ? ` · used by: ${x.usedBy.join(", ")}` : " · used by no test yet"}${x.duplicates.length ? ` · ⚠ also in ${x.duplicates.map((d) => (d.name === x.name ? d.file : `${d.file} as ${d.name}`)).join(", ")}` : ""}`;

/** The project's labels (one shared list, like GitHub labels): what each means, so tests are tagged by meaning. */
export function describeLabels(s) {
  const labels = s.labels ?? (s.tags ?? []).map((name) => ({ name, description: "" }));
  const head = "Labels — the project's one shared list of tags; tag every test with the ones whose meaning fits (pushed tests' tags). Use these names exactly; a new one only when none fits, sent in qahub_push labels with what it means in plain words";
  if (!labels.length) return `${head}: none yet.`;
  return [`${head}:`, ...labels.map((l) => `- ${l.name}${l.description ? ` — ${l.description}` : ""}${l.tests ? ` (${l.tests} test${l.tests === 1 ? "" : "s"})` : ""}`)].join("\n");
}

/** Who a test can sign in as: account names (what the code uses), their role and places. Never a username or password. */
export function describeAccounts(s) {
  const accounts = s.accounts ?? [];
  if (!accounts.length) return "Test accounts: none — tests run signed out. A test that must sign in can't be written yet: ask the person to add an account in QA Hub → Settings → Test accounts.";
  const roles = (s.roles ?? []).filter((r) => r.about);
  return [
    `Test accounts (each test starts signed in as one — runAs in qahub_push, default when left out; switch mid-test with qahub.signInAs(page, "<name>"); two at once with const other = await qahub.as("<name>")):`,
    ...accounts.map((a) => `- ${a.name}${a.role ? ` [${a.role}]` : ""} — on ${a.places.join(", ")}${a.default ? " — default" : ""}${a.oneAtATime ? " — one run at a time (a second run that needs it is refused while one uses it: keep it to the tests that truly need it)" : ""}`),
    ...(roles.length ? [`Roles: ${roles.map((r) => `${r.name} — ${r.about}`).join("; ")}.`] : []),
  ].join("\n");
}

/** The project's variables: what a test's data can link to so every run tries new values. */
export function describeVariables(s) {
  const vars = s.variables ?? [];
  const head = "Variables (link a test's data to one — data: [{ name, value, variable }] — and every run, and every try of a repeat, draws a new value; send new ones in qahub_push variables)";
  if (!vars.length) return `${head}: none yet.`;
  const rule = (v) => Object.entries(v.rules ?? {}).map(([k, x]) => `${k} ${x}`).join(", ");
  return [`${head}:`, ...vars.map((v) => `- ${v.name} — ${v.kind}${v.kind === "list" ? ` of ${v.values} (${v.pick}${v.sample?.length ? `, e.g. ${v.sample.map((x) => `“${x}”`).join(", ")}` : ""})` : rule(v) ? ` (${rule(v)})` : ""}${v.tricky ? " — sometimes an edge value" : ""}`)].join("\n");
}

const STATE = { proven: "proven", failing: "failing", weak: "weak", "not-run": "not run yet", planned: "planned", untested: "untested" };
// Each topic's version as this session last read it in full (project + topic → updatedAt).
const readAt = new Map();
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
  // A blip (QA Hub slow or briefly down) is asked again, a few times; a run that was started is never lost track of.
  const follow = async (p, number, wait) => {
    const end = Date.now() + waitMs;
    for (let misses = 0; ;) {
      let run;
      try { ({ run } = await qa.call("GET", `/api/v1/projects/${p}/runs/${number}?shots=1`)); misses = 0; } catch (e) {
        if (number === "latest" || !["unreachable", "timeout", "server", "not_qahub"].includes(e.code)) throw e;
        if (++misses > 3) throw new QaHubError(`${e.message} Run #${number} was started and may still be going — read it later with qahub_results { run: ${number}, wait: true }. Don't start it again.`, e.code);
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      if (run.status !== "running" || !wait || Date.now() > end) {
        const text = describeRun(run, qa.origin());
        // Each failure's screenshot as an image Claude sees — what the person would see on the run page.
        const shots = (run.failures ?? []).filter((f) => f.screenshot);
        if (!shots.length) return text;
        return { content: [{ type: "text", text }, ...shots.flatMap((f) => [
          { type: "text", text: `${f.ref ?? f.title} — the screen when it failed:` },
          { type: "image", data: f.screenshot.base64, mimeType: f.screenshot.type },
        ])] };
      }
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
    async qahub_project({ project, module } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      return describeProject(await qa.call("GET", `/api/v1/projects/${p}`), module);
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
      // Each test case's stage says whether it waits for a person (high-priority and risky ones, by default).
      building(root, [...res.planned, ...(res.updated ?? [])].map((x) => x.ref));
      const waiting = res.planned.filter((x) => x.stage === "planned").length;
      const ready = res.planned.length - waiting;
      const lines = [];
      if (waiting) lines.push(`${waiting} test case${waiting === 1 ? "" : "s"} waiting for a person to approve in QA Hub: ${qa.origin()}/p/${p}/tests — they decide what “correct” is. Write the code for any approved ones first, then tell the user they're waiting in QA Hub and call qahub_wait_review { tests: [${res.planned.filter((x) => x.stage === "planned").map((x) => `"${x.ref}"`).join(", ")}] } — you carry on by yourself the moment they decide. Code for an unapproved plan is refused.`);
      if (ready) lines.push(`${ready} test case${ready === 1 ? "" : "s"} approved — write ${ready === 1 ? "its" : "their"} code now: each test("…") named exactly as planned, its test.step names equal to the planned steps.`);
      for (const x of res.planned) lines.push(`- ${x.ref} “${x.title}” in ${x.module} (${x.stage})`);
      // Already a test (it has code): its design was updated, not a new test — change ITS code and push it.
      if (res.updated?.length) lines.push(`Already tests — their test cases were updated, no new ones made. Change their code to match and qahub_push it (same file, same title):`);
      for (const x of res.updated ?? []) lines.push(`- ${x.ref} “${x.title}” in ${x.module}`);
      if (res.behaviours?.added?.length) lines.push(`Behaviours added${res.review ? " (proposed until approved)" : ""}: ${res.behaviours.added.join(", ")}.`);
      for (const d of res.behaviours?.dropped ?? []) lines.push(`“${d}” was dropped by a person — don't propose it again or test it.`);
      return lines.join("\n") || "Nothing planned.";
    },
    async qahub_knowledge({ topic, module, project } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      const t = String(topic ?? "").trim(), m = String(module ?? "").trim();
      const { entries, index, where } = await qa.call("GET", `/api/v1/projects/${p}/knowledge${t ? `?topic=${encodeURIComponent(t)}` : m ? `?module=${encodeURIComponent(m)}` : ""}`);
      // Where this QA is testing and on which branch of the code (QA Hub 2026-10-20+): said first, with what's new there.
      const place = !where ? "" : `Testing ${where.place ?? "the app"} — code branch ${where.branch ?? "the default"}${where.production ? ` (production: ${where.production})` : ""}.${where.newOnBranch ? `\nNot in production yet:\n${where.newOnBranch}` : ""}${where.note ? `\n${where.note}` : ""}\n\n`;
      // The version of each topic read in full: a save of it carries this, so it never lands over a newer one.
      if (t || m) for (const e of entries) if (e.body !== undefined) readAt.set(`${p}\n${e.topic.toLowerCase()}`, e.updatedAt); // only what was really read
      // "observed: <module>": what QA Hub's explorer saw in the real app (QA Hub 2026-10-21+) — dated per part, no code to compare.
      const seen = (e) => /^observed: /i.test(e.topic);
      const state = (e) => (seen(e) ? "OBSERVED in the real app (each part says where, as whom and when) — trust it over the code-made page topics when they differ" : e.upToDate ? "up to date" : e.changed ? `OUT OF DATE — changed since: ${e.changed.join(", ")}` : `can't tell if current (${e.unknown})`);
      const full = (e) => `## ${e.topic} — by ${e.by || "someone"}, ${e.updatedAt.slice(0, 10)}, ${state(e)}\nFiles: ${e.files.join(", ") || "none listed"}\n\n${e.body}`;
      if (t) return full(entries[0]);
      if (m) {
        if (!entries.length) return `${place}Nothing filed under “${m}” yet. Read the code for it, then save the module's topic (topic = its name) with qahub_learn.`;
        const later = entries.filter((e) => e.more);
        return place + [...entries.filter((e) => !e.more).map(full), ...(later.length ? [`More filed under ${m}, not shown to keep this short — read one when you need it with qahub_knowledge { topic }: ${later.map((e) => `“${e.topic}”${e.summary ? ` (${e.summary})` : ""}`).join(", ")}`] : [])].join("\n\n");
      }
      if (!entries.length) return `${place}Nothing learned about this app yet. Read the code for what you need, then save it with qahub_learn into the module's topic (topic = its name; "page /…" topics are QA Hub's, made from the code — it refuses saves to them) so the next Claude doesn't have to.`;
      const by = new Map(entries.map((e) => [e.topic, e]));
      const mark = (name) => { const e = by.get(name); return !e ? name : seen(e) ? `${name} (observed in the real app${e.summary ? `: ${e.summary.replace(/^what .+? looks like in the real app — /, "")}` : ""})` : `${name.startsWith("page ") ? name.slice(5) : `${name} (module topic${e.summary ? `: ${e.summary}` : ""})`}${e.changed ? " ⚠ out of date" : ""}`; };
      const lines = ["The index — read only the module you work on (qahub_knowledge { module }), or one topic (qahub_knowledge { topic }):"];
      const walk = (ns, depth) => { for (const n of ns) { lines.push(`${"  ".repeat(depth)}- ${n.module} (${n.path}): ${n.topics.length ? n.topics.map(mark).join(" · ") : "nothing yet"}`); if (depth < 6) walk(n.modules, depth + 1); } };
      walk(index?.modules ?? [], 0);
      const overall = index?.overall ?? entries.map((e) => e.topic);
      const pages = overall.filter((x) => x.startsWith("page "));
      const rest = overall.filter((x) => !x.startsWith("page "));
      lines.push(`Overall: ${rest.map((x) => `${x}${by.get(x)?.summary ? ` (${by.get(x).summary})` : ""}${by.get(x)?.changed ? " ⚠ out of date" : ""}`).join(" · ") || "nothing"}`);
      if (pages.length) lines.push(`Pages in no module yet: ${pages.map((x) => x.slice(5)).join(", ")}`);
      lines.push("A module's topic says its journey, fields and rules, where it shows, test data that works, values refused, bugs; “observed: <module>” (QA Hub's explorer) is what each test account really saw there — fields and their limits, columns, what buttons open — trust it over the code when they differ; a page's (QA Hub's, made from the code) says what a user sees there and its validation. A module topic out of date: re-read just those files, then save it again — what you saw on a page goes into its module's topic, never a “page /…” one.");
      return place + lines.join("\n");
    },

    async qahub_code({ path, search, under, project } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      const q = path ? `path=${encodeURIComponent(path)}` : search ? `search=${encodeURIComponent(search)}` : `under=${encodeURIComponent(under ?? "")}`;
      const r = await qa.call("GET", `/api/v1/projects/${p}/code?${q}`);
      if ("text" in r) return r.text === null ? `${r.path}: ${r.note}` : `${r.path}${r.note ? ` (${r.note})` : ""}\n\n${r.text}`;
      if ("search" in r) return r.files.length ? `Files mentioning “${r.search}”:\n${r.files.join("\n")}` : `No file mentions “${r.search}”.`;
      return `${r.files.length} files${r.under ? ` in ${r.under}` : ""}${r.note ? ` — ${r.note}` : ""}:\n${r.files.join("\n")}`;
    },

    async qahub_wait_review({ tests: refs = [], minutes = 10, project } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      const end = Date.now() + Math.min(15, Math.max(1, minutes)) * 60_000;
      for (;;) {
        const st = await reviewState(qa, p);
        const decided = refs.map((ref) => ({ ref, ...decision(st, ref) }));
        const open = decided.filter((d) => d.state === "waiting");
        if (!open.length || Date.now() > end) return reviewWords(decided, open.length > 0);
        await new Promise((ok) => setTimeout(ok, 8_000));
      }
    },

    async qahub_map({ modules, project } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      const r = await qa.call("POST", `/api/v1/projects/${p}/map`, { modules });
      return `Mapped: ${r.modules} modules (${r.added} new${r.renamed ? `, ${r.renamed} renamed` : ""}${r.removed ? `, ${r.removed} removed` : ""}${r.kept ? `, ${r.kept} kept because tests still use them` : ""}). QA Hub now shows what has no tests — qahub_gaps.`;
    },

    async qahub_learn({ topic, body, files, sha, project } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      // basedOn: the version this session read ("new" if it never read it — then it must not exist yet). Recorded on
      // reads only, so after any save — another helper's, or this one's — the topic is read again before the next save.
      const branch = gitBranch(root); // a feature branch's knowledge waits for the feature, like its tests
      await qa.call("PUT", `/api/v1/projects/${p}/knowledge`, { topic, body, files: files ?? [], ...(sha ? { sha } : {}), ...(branch ? { branch } : {}), basedOn: readAt.get(`${p}\n${String(topic).toLowerCase()}`) ?? "new" });
      return `Saved “${topic}” — every teammate's Claude reads it now instead of the code.`;
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
    async qahub_helpers({ query, module, project } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      const q = String(query ?? "").trim(), m = String(module ?? "").trim();
      const r = await qa.call("GET", `/api/v1/projects/${p}/helpers?q=${encodeURIComponent(q)}${m ? `&module=${encodeURIComponent(m)}` : ""}`);
      const reuse = "Import the one that does what you need — never write a second helper that does the same. One a second module needs moves to qahub/shared/ (qahub_pull it first; update its importers in the same push).";
      if (!r.total) return "No helpers in this project yet — write yours in the module's helpers file; one two modules need goes in qahub/shared/.";
      if (!r.matched) return `Nothing matched “${q}” — no helper does that yet, so writing one is fine. The closest are:\n${r.closest.map(helperLine).join("\n")}`;
      if (!r.helpers.length) return `No helpers for ${m} yet, and none shared (${r.total} in the project: qahub_helpers { query } searches them all).`;
      return [q ? `Helpers for “${q}”, best first (${r.helpers.length} of ${r.total}):` : `${m ? `${m}'s helpers, the ones it uses, and the shared ones` : "Every helper"} (${r.helpers.length} of ${r.total}):`, ...r.helpers.map(helperLine), reuse].join("\n");
    },
    async qahub_pull({ overwrite = [], project } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      // From a feature branch: that branch's own versions, as its push is checked against them (base for the rest).
      const branch = gitBranch(root);
      const { files } = await qa.call("GET", `/api/v1/projects/${p}/files?content=1${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`, undefined, { timeout: SLOW });
      const realRoot = fs.realpathSync(root);
      const titles = (src) => [...String(src).matchAll(/\btest(?:\.(?:only|skip|fixme))?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
      const eol = (x) => x.replace(/\r\n/g, "\n"); // a Windows checkout's line endings aren't a difference
      const added = [], replaced = [], same = [], differs = [], refused = [];
      const got = {}; // QA Hub's sha of each file this folder now has exactly as QA Hub has it: the base of an edit here
      for (const f of Array.isArray(files) ? files : []) {
        const rel = String(f?.path ?? "");
        // QA Hub's own path rule, on the way OUT too: a bad row or a compromised server can't drop
        // .git hooks, .claude settings, CI workflows or anything outside this folder.
        const why = pathProblem(rel);
        if (why) { refused.push(`${rel || "(no path)"} (${why})`); continue; }
        const dest = path.join(root, ...rel.split("/"));
        try {
          let d = path.dirname(dest);
          while (!fs.existsSync(d)) d = path.dirname(d);
          if (!inside(realRoot, fs.realpathSync(d))) { refused.push(`${rel} (its folder points outside this app)`); continue; } // checked before any folder is made
          if (fs.lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) { refused.push(`${rel} (a link is there)`); continue; }
          let want;
          if (f.binary) {
            if (typeof f.base64 !== "string" || !f.base64) { refused.push(`${rel} (QA Hub no longer has its bytes)`); continue; }
            want = Buffer.from(f.base64, "base64");
          } else {
            if (typeof f.content !== "string") { refused.push(`${rel} (QA Hub sent no text for it)`); continue; }
            want = f.content;
          }
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const sha = SHA256.test(f.sha ?? "") ? f.sha : sha256(want); // QA Hub's own, else the same hash of what it sent
          if (!fs.existsSync(dest)) { fs.writeFileSync(dest, want); added.push(rel); got[rel] = sha; continue; }
          const local = fs.readFileSync(dest);
          if (f.binary ? Buffer.compare(local, want) === 0 : eol(local.toString("utf8")) === eol(want)) { same.push(rel); got[rel] = sha; continue; }
          if (overwrite.includes(rel)) { fs.writeFileSync(dest, want); replaced.push(rel); got[rel] = sha; continue; }
          if (f.binary) { differs.push(`${rel} — QA Hub has a different file`); continue; }
          const mine = titles(local.toString("utf8"));
          const theirs = titles(want).filter((x) => !mine.includes(x));
          differs.push(`${rel}${theirs.length ? ` — QA Hub's copy also has ${theirs.map((x) => `“${x}”`).join(", ")}` : ""}`);
        } catch (e) { refused.push(`${rel} (couldn't write it: ${e.code ?? e.message})`); }
      }
      bases(root, got);
      return [
        `QA Hub's test files for ${p}: ${files.length}.`,
        ...(added.length ? [`Added: ${added.join(", ")}.`] : []),
        ...(replaced.length ? [`Replaced with QA Hub's copy: ${replaced.join(", ")}.`] : []),
        ...(differs.length ? [`Different here: ${differs.join("; ")}. Keep both sides: add the teammates' tests to your copy (or take QA Hub's with overwrite and re-add yours), then push.`] : []),
        ...(refused.length ? [`Not written: ${refused.join("; ")}.`] : []),
        ...(!added.length && !replaced.length && !differs.length ? ["This folder already has QA Hub's latest."] : []),
      ].join("\n");
    },
    async qahub_link({ project, force = false }) {
      await qa.whoami();
      const p = projectOf(String(project ?? "").trim().toLowerCase());
      const { projects } = await qa.call("GET", "/api/v1/projects");
      if (!projects.some((x) => x.slug === p)) throw new QaHubError(`No project “${p}” in your company's QA Hub. Projects: ${projects.map((x) => x.slug).join(", ") || "none"}.`);
      // A checkout of another app linked here would read and teach the wrong project: its GitHub repo must be one of the
      // project's. Not a git checkout, or a project with no repo linked: nothing to compare.
      const mine = gitRepos(root);
      if (mine.length && !force) {
        const theirs = ((await qa.call("GET", `/api/v1/projects/${p}`)).repos ?? []).map((r) => repoName(typeof r === "string" ? r : r?.repo)).filter(Boolean);
        if (theirs.length && !theirs.some((r) => mine.includes(r))) throw new QaHubError(`This folder is ${mine.join(", ")} on GitHub, but the QA Hub project “${p}” is linked to ${theirs.join(", ")} — so it's probably not this app's project. Ask the user which project it is; only if they say “${p}” is right, call qahub_link again with force: true.`);
      }
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
      const hit = g.affectedByChanges;
      if (hit?.tests?.length) lines.push(`Update before running — the app's code changed since the last run (${hit.since} → ${hit.now}) and these tests use what it took out: ${hit.tests.slice(0, 10).map((t) => `${t.ref} “${t.title}” (uses ${t.words.map((w) => `“${w}”`).join(", ")}; changed in ${t.files.join(", ")})`).join("; ")}. Read each change: renamed or removed on purpose → update the test (qahub_pull, change, qahub_push); not on purpose → it's an app bug, say so.`);
      if (b.untested.length) lines.push(`Test next: ${b.untested.slice(0, 10).map((x) => `${x.name} (${x.module}, ${x.kind}, ${x.priority})`).join("; ")}.`);
      if (b.failing.length || b.weak.length) lines.push(`Not proven: ${[...b.failing, ...b.weak].slice(0, 10).map((x) => `${x.name} (${x.module}, ${b.failing.includes(x) ? "failing" : "weak"})`).join("; ")}.`);
      if (b.notDesigned.length) lines.push(`Not designed yet: ${b.notDesigned.join(", ")} — qahub_design them and propose their behaviours.`);
      return [...lines, capped(g)].join("\n");
    },
    async qahub_run({ project, tests, tag, module, set, environment, browser, show = false, wait = true, repeat, parallel, where, allowProduction } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      // An empty list is a mistake, never "everything": that would run the whole project on their computer.
      if (Array.isArray(tests) && !tests.length) throw new QaHubError("No tests named (tests is empty), so nothing was run. Name the refs (qahub_push returns them), or pick a tag, module or set.");
      if ([tests?.length ? tests : null, tag, module, set].filter(Boolean).length > 1) throw new QaHubError("Pick tests by one of: tests, tag, module or set.");
      const body = { ...(allowProduction === true ? { allowProduction: true } : {}), ...(tests?.length ? { tests } : {}), ...(tag ? { tag } : {}), ...(module ? { module } : {}), ...(set ? { set } : {}), ...(environment ? { environment } : {}), ...(browser ? { browser } : {}), headless: where === "server" || !show, ...(repeat > 1 ? { repeat } : {}), ...(parallel ? { parallel } : {}), ...(where === "server" ? { where } : {}) };
      const { run } = await qa.call("POST", `/api/v1/projects/${p}/runs/start`, body).catch((e) => {
        // Not connected (or an old qahub): what the person does about it, in one line Claude can relay.
        if (/Connect your computer/i.test(e.message)) throw new QaHubError(`${e.message} Tell the person once: in QA Hub → Computers, run the connect command it shows in a terminal on the computer where the app runs, and leave it open. Until then the tests are sent but not run.`);
        throw e;
      });
      // QA Hub found the same run already going (this call is a retry): it's that run, not a second one.
      const said0 = run.alreadyStarted ? `Run #${run.number} was already started a moment ago (the same tests) — following it instead of starting another`
        : `Run #${run.number} started: ${run.tests} test${run.tests === 1 ? "" : "s"} on ${run.environment}`;
      const said = run.trial ? `${said0} (a try — these tests haven't passed yet, so it stays out of Results until it passes)` : said0;
      if (!wait) return `${said} — ${qa.origin()}${run.url}\nRead it with qahub_results { run: ${run.number}, wait: true }.`;
      return follow(p, run.number, true);
    },
    async qahub_results({ project, run, wait = false } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      if (run !== undefined && !(Number.isInteger(run) && run > 0)) throw new QaHubError("run is a run number, like 12");
      return follow(p, run ?? "latest", wait);
    },
    async qahub_fixes({ project } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      const { fixes } = await qa.call("GET", `/api/v1/projects/${p}/fixes`, undefined, { timeout: SLOW });
      if (!fixes?.length) return "No fix requests waiting in QA Hub.";
      // Text Claude reads, and each failure's screenshot as an image it can see.
      const content = [{ type: "text", text: `${fixes.length} failing test${fixes.length === 1 ? "" : "s"} a person asked you to fix. For each: find the cause — the app (a bug: fix the app) or the test (the app changed on purpose: update the test). Never make it pass by checking less or waiting longer. Then qahub_fix_note in plain words, push the test if you changed it, and qahub_run { tests: [its ref] }.` }];
      for (const f of fixes) {
        content.push({ type: "text", text: [
          `${f.ref} “${f.title}” (${f.file ?? "recorded test"}) — failed in run #${f.run}${f.stepTitle ? ` at step ${f.step + 1}, “${f.stepTitle}”` : ""}; asked by ${f.askedBy}; try ${f.attempt} of 3.`,
          f.description ? `What it's for: ${f.description}` : "",
          `Steps: ${f.steps.join(" → ")}`,
          `What went wrong: ${f.plain ?? "?"}`,
          f.technical && f.technical !== f.plain ? `Playwright said: ${f.technical}` : "",
          f.failKind ? `QA Hub's read: ${KIND[f.failKind] ?? f.failKind}.` : "",
          `Run page (video and trace): ${qa.origin()}${f.url}`,
          whereItFailed(f.context, f.values).trim(),
          f.screenshot ? "The screenshot of the moment it failed:" : "No screenshot for this one.",
        ].filter(Boolean).join("\n") });
        if (f.screenshot) content.push({ type: "image", data: f.screenshot.base64, mimeType: f.screenshot.type });
      }
      return { content };
    },
    async qahub_look({ project, path, environment } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      const r = await qa.call("POST", `/api/v1/projects/${p}/look`, { path, ...(environment ? { environment } : {}) }, { timeout: SLOW });
      if (r.status === "failed") throw new QaHubError(r.error ?? "Couldn't open the page");
      if (r.status !== "done") return `${path} is still opening on the person's computer — call qahub_look again in a moment.`;
      const l = r.look;
      const content = [{ type: "text", text: [
        `${l.url}${l.title ? ` — “${l.title}”` : ""}`,
        "What's on the page (role and name of each control — find elements by these):",
        l.snapshot,
        l.errors?.length ? `The app's own errors on this page: ${l.errors.join(" | ")}` : "",
      ].filter(Boolean).join("\n") }];
      if (l.shot) content.push({ type: "image", data: l.shot, mimeType: "image/jpeg" });
      return { content };
    },
    async qahub_fix_note({ project, test, kind, note } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      if (!/^TEST-\d{1,9}$/.test(String(test ?? ""))) throw new QaHubError("test is the test's ref, like TEST-00005");
      await qa.call("POST", `/api/v1/projects/${p}/fixes/${test}`, { kind, note });
      return `Noted on ${test} in QA Hub. Now run it again: qahub_run { tests: ["${test}"] } — a pass marks it fixed.`;
    },
    async qahub_push({ project, files = [], tests: given = [], modules = [], remove = [], behaviours = [], variables = [], labels = [], fewerChecks } = {}) {
      await qa.whoami();
      const p = projectOf(project);
      const tests = given.map((t) => (typeof t?.file === "string" ? { ...t, file: t.file.replaceAll("\\", "/") } : t)); // a Windows path
      // Every new test lands in a real module: refused here, before anything is sent, with what to do.
      if (tests.length) {
        const s = await qa.call("GET", `/api/v1/projects/${p}`);
        const lost = [...new Set(tests.filter((t) => !moduleFor(s, modules, t)).map((t) => t.module))];
        if (lost.length) {
          throw new QaHubError(`${lost.map((m) => `Module “${m}”`).join(", ")} isn't in QA Hub, so ${lost.length === 1 ? "its tests" : "those tests"} would land in Inbox. QA Hub's modules: ${s.modules.map((m) => m.name).join(", ") || "none yet"}. Use one of those (the one for the page the test covers), or — if it's a part of the app QA Hub doesn't have yet — add it in the same push: modules: [{ name: "${lost[0]}", path: "/…", parent: "/…" }] (its URL path; parent only for a sub-page). Nothing was sent.`);
        }
      }
      // Passed twice on this computer with this exact code (try_tests): QA Hub counts them verified — no run of its own.
      const proven = provenTests(root, tests);
      // The recorder chat saves only what was proven: each test passed twice in try_tests with its code exactly as
      // sent — or is marked a known app bug (tagged, so the person sees it). Refused here, before anything is sent.
      if (process.env.QAHUB_CHAT && tests.length) {
        const unproven = unprovenTests(root, tests);
        if (unproven.length) throw new QaHubError(`Not proven yet: ${unproven.map((t) => `“${t.title}” (${t.why})`).join("; ")}. Try ${unproven.length === 1 ? "it" : "them"} with try_tests (repeat: 2) until ${unproven.length === 1 ? "it passes" : "they pass"} twice with this exact code — or, if one fails only because the APP is wrong, keep the right check and push it with knownBug: "<what's wrong>" and tell the person ("Needs you: …"). Nothing was sent.`);
        for (const t of tests) if (t.knownBug) {
          t.tags = [...new Set([...(t.tags ?? []), "known-bug"])];
          t.description = `Known bug: ${String(t.knownBug).trim()}${t.description ? ` — ${t.description}` : ""}`.slice(0, 600);
          delete t.knownBug;
        }
      }
      const branch = gitBranch(root); // on a feature branch QA Hub keeps this push waiting until the feature reaches each place
      // Each file's base: QA Hub's sha of the copy the edit here started from — a shared helper a teammate changed since is refused.
      const base = bases(root);
      const body = { files: files.map((f) => readAppFile(root, f)).map((x) => (SHA256.test(base[x.path] ?? "") ? { ...x, base: base[x.path] } : x)), tests, modules, ...(proven.length ? { proven } : {}), ...(remove.length ? { remove } : {}), ...(behaviours.length ? { behaviours } : {}), ...(variables.length ? { variables } : {}), ...(labels.length ? { labels } : {}), ...(fewerChecks ? { fewerChecks } : {}), ...(process.env.QAHUB_CHAT ? { chat: true } : {}), ...(branch ? { branch } : {}) };
      const size = Buffer.byteLength(JSON.stringify(body));
      if (size > MAX_PUSH) throw new QaHubError(`This push is ${Math.round(size / 1048576)} MB; QA Hub takes up to 30 MB at once. Send the files a test uploads in smaller pushes (a few at a time). Nothing was sent.`);
      const res = await qa.call("POST", `/api/v1/projects/${p}/tests`, body, { timeout: SLOW }).catch((e) => {
        if (e.code === "timeout") throw new QaHubError(`${e.message} The push may still have landed — check with qahub_project before sending it again.`, "timeout");
        throw e;
      });
      const refs = res?.refs ?? [];
      building(root, refs.map((r) => r.ref));
      bases(root, Object.fromEntries(body.files.map((x) => [x.path, sha256(x.base64 !== undefined ? Buffer.from(x.base64, "base64") : x.content)]))); // QA Hub has these now
      const credited = Array.isArray(res?.credited) ? refs.filter((r) => res.credited.includes(r.ref)) : [];
      const toRun = refs.filter((r) => !credited.includes(r));
      const w = res?.waiting;
      const count = (x) => (Array.isArray(x) ? x.length : x ?? 0); // QA Hub sends the refs
      return [
        `Sent to QA Hub (${p}): ${files.length} file(s), ${tests.length} test(s).`,
        ...(w ? [`Waiting for ${w.branch ?? branch}: ${count(w.newTests)} new tests, ${count(w.updated)} updated — QA Hub switches each place to them when that place's run shows the feature has arrived.${w.note ? ` ${w.note}` : ""}`] : []),
        ...(res?.variables?.created?.length ? [`Variables created: ${res.variables.created.join(", ")} — each run now draws new values for the data linked to them.`] : []),
        ...(res?.variables?.alreadyThere?.length ? [`Already in QA Hub (kept as the person set them): ${res.variables.alreadyThere.join(", ")}.`] : []),
        ...(res?.modules?.added?.length ? [`Modules added: ${res.modules.added.map((m) => `${m.name} (${m.path})`).join(", ")}.`] : []),
        ...(res?.modules?.named ?? []).map((m) => `QA Hub calls ${m.path} “${m.qahub}” (you said “${m.yours}”) — use “${m.qahub}” from now on.`),
        ...(refs.length ? [`Tests: ${refs.map((r) => `${r.ref} “${r.title}”${r.module ? ` in ${r.module}` : ""}`).join(", ")}.`] : []),
        ...(credited.length ? [`Proven on this computer — passed twice with this exact code — so QA Hub counts ${credited.length === 1 ? "it" : "them"} as verified, no QA Hub run needed: ${credited.map((r) => r.ref).join(", ")}.`] : []),
        // Waiting: no place runs them yet (a run would try the live versions, or skip them) — proven here is what counts.
        ...(toRun.length && !w ? [`Run ${credited.length ? "the rest" : "them"} now, twice — a new or changed test only counts once it has passed twice: qahub_run { tests: ${JSON.stringify(toRun.map((r) => r.ref))}, repeat: 2 }`] : []),
        ...refs.filter((r) => r.note).map((r) => `${r.ref}: ${r.note}.`),
        ...(res?.inbox?.length ? [`In Inbox (no module): ${res.inbox.join("; ")}.`] : []),
        ...(res?.removed?.length ? [`Moved to QA Hub's recycle bin: ${res.removed.join(", ")}.`] : []),
        capped(res),
      ].join("\n");
    },
  };
}

/**
 * The tests in a push that haven't passed twice in try_tests with their file exactly as it is now (connector's
 * try.mjs writes the proof beside the kept records: ~/qa_hub/<project>/.qahub/proof.json). Exported for its test.
 */
/**
 * What a test's proof covers: its file with every OTHER test cut out — its own code and the file's shared code
 * (imports, beforeEach, helpers at the top), not its neighbours'. Fixing one test no longer un-proves the rest of the
 * file; changing shared code still does — and so does a local file it imports (`./helpers`), given its `file` and
 * `read(path)` (a file's text, or null). The connector records proof the same way (qahub packages/cli/bin/try.mjs) — keep the two identical.
 */
export function proofText(src, title, file, read) {
  const s = String(src);
  // Where a test(...) call ends: its brackets matched, text in quotes skipped.
  const endOf = (from) => {
    for (let i = s.indexOf("(", from), depth = 0; i >= 0 && i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' || ch === "'" || ch === "`") { for (i++; i < s.length && s[i] !== ch; i++) if (s[i] === "\\") i++; continue; }
      if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) return s[i + 1] === ";" ? i + 2 : i + 1;
    }
    return s.length;
  };
  const heads = [...s.matchAll(/\btest(?:\.only)?\(\s*(["'`])((?:\\.|(?!\1).)+)\1/g)];
  let out = s;
  for (let i = heads.length - 1; i >= 0; i--) if (heads[i][2] !== title) out = out.slice(0, heads[i].index) + out.slice(endOf(heads[i].index));
  return read ? out + helpersOf(s, file, read) : out;
}

/**
 * The text of the local files a spec imports (./x, ../x — never a package), followed import by import: what a try
 * runs of them, so only files under qahub/. At most 5 imports deep, 50 files, 1 MB. Kept identical in the connector.
 */
function helpersOf(src, file, read) {
  const seen = new Set([path.posix.normalize(file)]);
  let out = "";
  const walk = (from, text, depth) => {
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])(\.{1,2}\/[^"'\n]*)\1/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), m[2]));
      const hit = [base, ...["ts", "js", "mjs", "cjs", "json"].map((x) => `${base}.${x}`), base.replace(/\.js$/, ".ts"), ...["ts", "js", "mjs"].map((x) => `${base}/index.${x}`)]
        .find((p) => p.startsWith("qahub/") && /\.(m?[jt]s|cjs|json)$/.test(p) && !p.split("/").some((x) => ["node_modules", ".git", ".results", ".auth"].includes(x)) && read(p) != null);
      if (!hit || seen.has(hit) || seen.size >= 50 || out.length > 1_000_000) continue;
      seen.add(hit);
      const got = String(read(hit));
      out += `\n// ${hit}\n${got}`;
      if (depth < 5) walk(hit, got, depth + 1);
    }
  };
  walk(file, src, 1);
  return out;
}

export function unprovenTests(root, tests) {
  const proof = proofOf(root);
  return tests.filter((t) => !t.knownBug).map((t) => ({ title: t.title, why: notProven(root, proof, t) })).filter((x) => x.why);
}

/** "file#title" of each test in a push that passed twice on this computer with its code as sent: QA Hub credits them. */
export function provenTests(root, tests) {
  const proof = proofOf(root);
  return tests.filter((t) => !t.knownBug && !notProven(root, proof, t)).map((t) => `${t.file}#${t.title}`);
}

// In the project's own folder: ~/qa_hub/<project>/.qahub/proof.json.
const proofOf = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, ".qahub", "proof.json"), "utf8")); } catch { return {}; } };
/** Why a test isn't proven twice with its file as it is now, or null when it is. */
function notProven(root, proof, t) {
  let content = null;
  try { content = fs.readFileSync(path.join(root, t.file), "utf8"); } catch { /* not on disk */ }
  const p = proof[`${t.file}#${t.title}`];
  const read = (p) => { try { return fs.readFileSync(path.join(root, p), "utf8"); } catch { return null; } };
  const sha1 = (x) => createHash("sha1").update(x).digest("hex");
  // A connector from 0.10.21 also proves the helpers a test imports (sha2) — checked when there; an older one's proof (sha
  // only) is checked the way it was made, so a plugin and connector updated at different times never block a push.
  const same = !p || content === null ? false : p.sha2 !== undefined ? p.sha2 === sha1(proofText(content, t.title, t.file, read)) : p.sha === sha1(proofText(content, t.title));
  return !p ? "never tried" : !same ? "its code, or a helper it imports, changed since it last passed" : p.streak < 2 ? (p.streak === 1 ? "passed once, not twice" : "its last try failed") : null;
}

/** A repo's address (https://github.com/o/n.git, git@github.com:o/n, ssh://…) or "o/n" as "o/n", lower-case; a folder on disk: null. */
const repoName = (url) => { const u = String(url ?? "").trim(); return /^(file:|[/.~\\])/.test(u) ? null : /([^/:\s]+)\/([^/:\s]+?)(?:\.git)?\/?$/.exec(u)?.slice(1).join("/").toLowerCase() ?? null; };
/** The repos this folder's git checkout points at (its remotes), as "owner/name"; none when it isn't a checkout. */
function gitRepos(root) {
  try {
    const out = execFileSync("git", ["-C", root, "config", "--local", "--get-regexp", "^remote\\..*\\.url$"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    return [...new Set(out.split("\n").map((l) => repoName(l.split(/\s+/)[1])).filter(Boolean))];
  } catch { return []; } // not a checkout, no remotes, no git
}

/**
 * QA Hub's sha of each file as this folder last got it (pulled, or pushed from here) — <root>/.qahub/pulled.json; the
 * connector's sync writes the same file (packages/cli/bin/tests-home.mjs). `got` adds to it. Never throws.
 */
export function bases(root, got) {
  const f = path.join(root, ".qahub", "pulled.json");
  let have = {};
  try { have = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* nothing pulled here yet */ }
  if (got && Object.keys(got).length) try {
    Object.assign(have, got);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try { fs.writeFileSync(path.join(path.dirname(f), ".gitignore"), "*\n", { flag: "wx" }); } catch { /* there already */ } // never in the app's commits
    fs.writeFileSync(f, JSON.stringify(have));
  } catch { /* best effort */ }
  return have;
}
const sha256 = (x) => createHash("sha256").update(x).digest("hex");
const SHA256 = /^[0-9a-f]{64}$/;

/** QA Hub's full answer for Claude to read — capped, so a big project can't flood the conversation. */
function capped(x, max = 6_000) {
  const s = JSON.stringify(x, null, 2);
  return s.length > max ? `${s.slice(0, max)}\n… (cut — ${s.length - max} more characters)` : s;
}

// ---- MCP over stdio ------------------------------------------------------------------------------
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]; // what this server can speak; newest first
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
        return send({ jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: "qahub", version: VERSION } } });
      }
      if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
      if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      if (method === "tools/call") {
        const fn = Object.hasOwn(impl, String(params?.name)) ? impl[params.name] : null; // never an inherited "constructor"
        if (!fn) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
        try {
          const out = await fn(params.arguments ?? {});
          // A tool answers in text, or with its own content blocks (text and images).
          return send({ jsonrpc: "2.0", id, result: Array.isArray(out?.content) ? { content: out.content } : { content: [{ type: "text", text: out }] } });
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

if (isMain(import.meta.url)) {
  // Older Node has no fetch: every tool then says what to install, instead of the server dying unseen.
  const old = Number(process.versions.node.split(".")[0]) < 18;
  const refuse = async () => { throw new QaHubError(`QA Hub needs Node.js 18 or newer — this computer has ${process.version}. Install the current Node.js from nodejs.org, then restart Claude Code.`); };
  serve(process.stdin, process.stdout, old ? Object.fromEntries(TOOLS.map((t) => [t.name, refuse])) : tools());
}

// ---- plan review: what a person decided in QA Hub ---------------------------------------------------
/** Each test's stage, and the changes a person asked for, as QA Hub has them now. */
/**
 * The tests Claude is building in this folder (planned or pushed here, last 2 days): the Stop hook keeps it at work
 * until each is approved, written and has passed twice. Called with no refs, it only reads. Never throws.
 */
export function building(root, refs = []) {
  const f = path.join(os.tmpdir(), `qahub-building-${Buffer.from(root).toString("base64url").slice(-60)}.json`);
  let have = {};
  try { have = JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* none yet */ }
  const now = Date.now();
  for (const [r, at] of Object.entries(have)) if (now - at > 2 * 86_400_000) delete have[r];
  for (const r of refs) if (/^TEST-\d+$/.test(r)) have[r] = now;
  if (refs.length) try { fs.writeFileSync(f, JSON.stringify(have)); } catch { /* best effort */ }
  return Object.keys(have);
}

export async function reviewState(qa, p) {
  const [proj, gaps] = await Promise.all([qa.call("GET", `/api/v1/projects/${p}`), qa.call("GET", `/api/v1/projects/${p}/gaps`).catch(() => ({}))]);
  return { tests: new Map((proj.tests ?? []).map((t) => [t.ref, t])), changes: new Map((gaps.changeRequests ?? []).map((c) => [c.ref, c])) };
}
/** waiting | approved | changes | rejected (gone from the project) for one planned test. */
export function decision(st, ref) {
  const t = st.tests.get(ref);
  if (!t) return { state: "rejected" };
  const ch = st.changes.get(ref);
  if (ch && t.stage === "planned") return { state: "changes", title: t.title, note: ch.request?.note ?? "" };
  return t.stage === "planned" ? { state: "waiting", title: t.title } : { state: "approved", title: t.title };
}
export function reviewWords(decided, timedOut) {
  const of = (s) => decided.filter((d) => d.state === s);
  const lines = [];
  if (of("approved").length) lines.push(`Approved — write their code now, push and run them: ${of("approved").map((d) => `${d.ref} “${d.title}”`).join(", ")}.`);
  for (const d of of("changes")) lines.push(`${d.ref} “${d.title}”: changes asked — ${d.note || "see qahub_gaps"}. Plan it again with the change (qahub_plan), then wait again.`);
  if (of("rejected").length) lines.push(`Rejected (removed): ${of("rejected").map((d) => d.ref).join(", ")} — don't write them.`);
  if (timedOut) lines.push(`Still waiting for: ${of("waiting").map((d) => d.ref).join(", ")}. Tell the user; when they decide, you'll hear about it with their next message (or call qahub_wait_review again).`);
  return lines.join("\n");
}
