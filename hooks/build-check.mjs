#!/usr/bin/env node
// "Claude writes tests while it builds": when Claude is about to stop after changing the app's code in a folder
// linked to QA Hub, and no tests were pushed since, it is sent back — to write tests for what it built, or to say in
// one line why the change needs none. Once per push: asked again only for app files it wasn't asked about since the
// last qahub_push (feature B after feature A's push is asked; a "needs no tests" isn't nagged for the same files).
// Never loops (stop_hook_active), never blocks on errors.
import fs from "node:fs";
import path from "node:path";
import { appRoot, projectAt } from "../server/index.mjs";
import { gitBranch } from "../server/qahub.mjs";
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

/** The Stop hook's answer, or null. `seen` keeps what it last asked about: { pushes, files }. */
export function buildCheck(input, transcript, seen) {
  if (input?.stop_hook_active) return null;
  const root = appRoot(input?.cwd || process.cwd());
  if (!projectAt(root)) return null;
  const files = changedSincePush(transcript, root);
  if (!files.length) return null;
  const pushes = (transcript.match(/"name":"[^"]*qahub_push"/g) ?? []).length; // a push starts a new set of changes
  let asked = {};
  try { asked = JSON.parse(fs.readFileSync(seen, "utf8")); } catch { /* not asked yet */ }
  if (asked.pushes === pushes && files.every((f) => asked.files?.includes(f))) return null; // already asked about these
  try { fs.writeFileSync(seen, JSON.stringify({ pushes, files })); } catch { return null; }
  const list = files.slice(0, 6).join(", ") + (files.length > 6 ? `, and ${files.length - 6} more` : "");
  const branch = gitBranch(root);
  // main/master: usually what places run, so live. A feature branch's tests can't run before the push (try_tests is the
  // recorder chat's only): proven after it, and only on a place that runs this branch.
  const onBranch = branch ? ` You are on branch ${branch}: also run qahub_find for the tests this change affects and update the affected tests in place, keeping their titles; qahub_learn what you learned; then send one qahub_push${/^(main|master)$/.test(branch)
    ? " and prove every new and updated test twice (qahub_run, repeat: 2)"
    : " — QA Hub keeps it waiting until the feature reaches each place; prove the new and updated tests twice (qahub_run, repeat: 2) only on a place that runs this branch (Settings → Code branches)"}.` : "";
  return { decision: "block", reason: `You changed the app (${list}) and no tests went to QA Hub. If a user can see this change, write tests for it now with the qahub:write-tests skill — look, plan, push, run.${onBranch} If they can't (a refactor, config, styling only), say so in one line and stop.` };
}
