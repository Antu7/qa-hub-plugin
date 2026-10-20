#!/usr/bin/env node
// "Claude writes tests while it builds": when Claude is about to stop after changing the app's code in a folder
// linked to QA Hub, and no tests were pushed since, it is sent back ONCE in the session — to write tests for what
// it built, or to say in one line why the change needs none. Never loops (stop_hook_active), never blocks on errors.
import fs from "node:fs";
import path from "node:path";
import { appRoot } from "../server/index.mjs";
import { isTestFile } from "./test-checklist.mjs";

// App code a user can see the effect of. Not tests, docs, config, lock files, styles alone or generated output.
const CODE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|html?|php|py|rb|go|java|kt|cs|erb|twig|blade\.php)$/i;
const NOT_APP = /(^|\/)(tests?|e2e|__tests__|__mocks__|spec|specs|cypress|playwright|docs?|scripts|migrations|node_modules|dist|build|\.next|coverage)\//i;
const CONFIG = /(^|\/)[^/]*\.config\.[cm]?[jt]s$|(^|\/)\.[^/]+$/i;

/** App files Claude changed since its last qahub_push, from the session's transcript (JSONL). */
export function changedSincePush(transcript, root) {
  let changed = new Set();
  for (const line of transcript.split("\n")) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    for (const c of e?.message?.content ?? []) {
      if (c?.type !== "tool_use") continue;
      if (/qahub_push$/.test(c.name ?? "")) { changed = new Set(); continue; }
      if (!["Write", "Edit", "MultiEdit"].includes(c.name)) continue;
      const file = c.input?.file_path;
      if (typeof file !== "string") continue;
      const rel = path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
      if (rel.startsWith("..") || !CODE.test(rel) || isTestFile(rel) || NOT_APP.test(rel) || CONFIG.test(rel)) continue;
      changed.add(rel);
    }
  }
  return [...changed];
}

/** The Stop hook's answer, or null. `seen` is the once-per-session marker file. */
export function buildCheck(input, transcript, seen) {
  if (input?.stop_hook_active) return null;
  const root = appRoot(input?.cwd || process.cwd());
  if (!fs.existsSync(path.join(root, "qahub.json"))) return null;
  const files = changedSincePush(transcript, root);
  if (!files.length) return null;
  try { fs.writeFileSync(seen, "", { flag: "wx" }); } catch { return null; } // already asked this session
  const list = files.slice(0, 6).join(", ") + (files.length > 6 ? `, and ${files.length - 6} more` : "");
  return { decision: "block", reason: `You changed the app (${list}) and no tests went to QA Hub. If a user can see this change, write tests for it now with the qahub:write-tests skill — look, plan, push, run. If they can't (a refactor, config, styling only), say so in one line and stop.` };
}
