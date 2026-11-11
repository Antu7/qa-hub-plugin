#!/usr/bin/env node
// Before a QA Hub tool: the tools started where Claude Code started, but Claude may now work somewhere else in this app's
// repository — a git worktree on another branch (2026-11-11: PH-2575's tests would have gone up from the main checkout's
// feat/ph-1089 branch and been switched on with the wrong feature). A call that doesn't say `folder` from there is turned
// back, naming the folder to pass. Never a permission bypass: the hook only refuses, and only for this app's own folders.
import fs from "node:fs";
import path from "node:path";
import { appRoot, gitCommon } from "../server/index.mjs";
import { hookMain, isMain } from "../server/qahub.mjs";

const real = (d) => { try { return fs.realpathSync.native(d); } catch { return path.resolve(d); } };

export function folderCheck(input, env = process.env) {
  const cwd = input?.cwd, started = env.CLAUDE_PROJECT_DIR;
  if (!cwd || !started || input?.tool_input?.folder) return null;
  const here = real(appRoot(cwd)), home = real(appRoot(started));
  if (here === home) return null;
  // Only this app's own repository: anywhere else, the tools keep the folder they started in, as before.
  if (!gitCommon(here) || gitCommon(here) !== gitCommon(home)) return null;
  const tool = String(input?.tool_name ?? "").replace(/^mcp__.*?__(qahub_)/, "$1");
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: `You're working in ${cwd}, but QA Hub's tools started in ${started} — another checkout of this repository. Call ${tool || "it"} again with folder: ${JSON.stringify(cwd)}, so QA Hub reads this folder's files and its branch.` } };
}

if (isMain(import.meta.url)) hookMain((input) => folderCheck(input));
