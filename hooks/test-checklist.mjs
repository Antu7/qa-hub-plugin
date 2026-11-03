#!/usr/bin/env node
// The first time in a session that Claude writes a Playwright test file, hand it a short checklist —
// at the moment it matters. (A long skill file is easy to skip; ZeuZ found its agent never read its 38 KB one.)
// Once per session; never blocks: a hook that fails must not stop someone coding.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appRoot, projectAt } from "../server/index.mjs";
import { hookMain, isMain, sessionOf } from "../server/qahub.mjs";

// The checklist lives once, at the end of the write-tests skill: this hands over that very section.
const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), "../skills/write-tests/SKILL.md");
export const CHECKLIST = `QA Hub checklist for Playwright tests (shown once per session):\n${fs.readFileSync(SKILL, "utf8").split("## Checklist for every test file\n")[1]?.trim() ?? ""}`;

export const isTestFile = (p) => typeof p === "string" && /\.(spec|test)\.[cm]?[jt]sx?$/.test(p);

/** What to tell Claude for this tool call, or null. `seen` is the once-per-session marker file. */
export function checklistFor(input, seen) {
  if (process.env.QAHUB_CHAT) return null; // the recorder chat: its own instructions say how (no cleanup, one try, no QA Hub runs)
  const file = input?.tool_input?.file_path ?? input?.tool_input?.path;
  if (!isTestFile(file)) return null;
  // Only in an app linked to QA Hub: a Jest or Vitest file in any other project is none of QA Hub's business.
  const cwd = input?.cwd || process.cwd();
  if (!projectAt(appRoot(path.dirname(path.resolve(cwd, file))))) return null;
  try { fs.writeFileSync(seen, "", { flag: "wx" }); } catch { return null; } // already shown this session
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: CHECKLIST } };
}

if (isMain(import.meta.url)) hookMain((input) => checklistFor(input, path.join(os.tmpdir(), `qahub-checklist-${sessionOf(input)}`)));
