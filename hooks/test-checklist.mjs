#!/usr/bin/env node
// The first time in a session that Claude writes a Playwright test file, hand it a short checklist —
// at the moment it matters. (A long skill file is easy to skip; ZeuZ found its agent never read its 38 KB one.)
// Once per session; never blocks: a hook that fails must not stop someone coding.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appRoot } from "../server/index.mjs";
import { isMain } from "../server/qahub.mjs";

export const CHECKLIST = `QA Hub checklist for Playwright tests (shown once per session):
1. Tests start signed in: QA Hub signs in once per run. No log-in steps; never a password, key or token in a file.
2. Find elements the way a person does: getByRole with its name, getByLabel, getByPlaceholder, getByTestId. No CSS chains or generated ids. For a repeated row or card, find the row by something only it has, then the control inside it — never first()/nth() to pick between look-alikes.
3. After a save, prove it with something only the saved result has (the new item in the list, its URL or id, the values typed) — "no error" is not proof.
4. End every test with an expect of what the user should see. Know what bug it would catch; "works correctly" is not a check. A negative test must reach its rule (valid login, the other fields valid).
5. Never weaken a test to get green: no try/catch around expect, no removed assertions, no force: true, no waitForTimeout or networkidle — wait for the thing you expect to appear.
6. Change the page only the way a user does (click, fill, press). No page.evaluate that edits the page.
7. Each test stands alone, in a fresh browser, in any order: create what it needs, with unique values (e.g. Date.now()) so reruns don't collide.
8. Wrap each step in test.step("Plain words") — those names are what people read in QA Hub.
9. QA Hub runs this file itself, on the person's computer: page.goto("/path") (QA Hub sets the app's address — never write localhost), import only @playwright/test and your own pushed files (no other packages, no .env), and push each test with title = its exact name in test("…") and steps = its test.step names, in order.
10. Prove it: a create or edit test reopens the record (reload, or open it by name) and expects the typed values; delete expects it gone; validation expects the message AND that nothing was saved. QA Hub reads the code and refuses a test that doesn't.
11. One test per behaviour across the whole team: qahub_find first; a SAME test is improved, never written twice. Use QA Hub's module names (qahub_project).
Then qahub_push the file (and helpers), qahub_run the refs it returns, and fix what fails.`;

export const isTestFile = (p) => typeof p === "string" && /\.(spec|test)\.[cm]?[jt]sx?$/.test(p);

/** What to tell Claude for this tool call, or null. `seen` is the once-per-session marker file. */
export function checklistFor(input, seen) {
  const file = input?.tool_input?.file_path ?? input?.tool_input?.path;
  if (!isTestFile(file)) return null;
  // Only in an app linked to QA Hub: a Jest or Vitest file in any other project is none of QA Hub's business.
  const cwd = input?.cwd || process.cwd();
  if (!fs.existsSync(path.join(appRoot(path.dirname(path.resolve(cwd, file))), "qahub.json"))) return null;
  try { fs.writeFileSync(seen, "", { flag: "wx" }); } catch { return null; } // already shown this session
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: CHECKLIST } };
}

if (isMain(import.meta.url)) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(raw || "{}");
      const id = String(input.session_id ?? "nosession").replace(/[^\w-]/g, "").slice(0, 80);
      const out = checklistFor(input, path.join(os.tmpdir(), `qahub-checklist-${id}`));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* never block */ }
  });
}
