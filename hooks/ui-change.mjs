#!/usr/bin/env node
// "You changed what a test uses" (QA Hub plan auto-heal, Phase 1). Claude builds the app AND writes its tests, so
// the cheapest heal is Claude updating the tests in the same change:
//   - after an Edit of the app (a component, a translation file): the words it took out — a button's text, a label,
//     a test id — are looked for in the app's test files; any hit is named, file:line, at once;
//   - when Claude is about to stop (argv "stop"): a test that still looks for such a word sends it back, once.
// Plain text matching, no network. Never blocks on its own errors.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appRoot } from "../server/index.mjs";
import { isMain } from "../server/qahub.mjs";
import { isTestFile } from "./test-checklist.mjs";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "out", ".turbo", ".cache"]);
const TEST_DIR = /(^|\/)(tests?|e2e|playwright|__tests__|specs?)\//i;
const CODE = /\.[cm]?[jt]sx?$/i;

/** Text a person reads: has a letter, isn't a path, a URL or code. */
const wordy = (s) => s.length >= 2 && s.length <= 60 && /\p{L}/u.test(s) && !/^(\/|https?:|\.|#)/.test(s) && !/[{}$<>\\]/.test(s);
function wordsIn(code) {
  const out = new Set();
  for (const m of code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) if (wordy(m[2].trim())) out.add(m[2].trim());
  for (const m of code.matchAll(/>([^<>{}]+)</g)) if (wordy(m[1].trim())) out.add(m[1].trim());
  return out;
}
/** Words the edit took out: in the old text, not in the new one. */
export function removedWords(before, after) {
  const now = wordsIn(String(after ?? ""));
  return [...wordsIn(String(before ?? ""))].filter((w) => !now.has(w));
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isTestish = (rel) => isTestFile(rel) || (TEST_DIR.test(rel) && CODE.test(rel));

/** Where the app's tests look for these words, as a quoted string: [{ word, at: "tests/x.ts:3" }]. */
export function usesIn(root, words) {
  if (!words.length) return [];
  const res = words.map((w) => ({ w, re: new RegExp(`(["'\`])${esc(w)}\\1`) }));
  const hits = [];
  let seen = 0;
  const walk = (dir) => {
    let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (seen > 5000 || hits.length >= 40) return; // ponytail: a huge repo is checked in part, never slowly
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (!e.isFile() || !isTestish(rel)) continue;
      seen++;
      let text; try { if (fs.statSync(full).size > 512_000) continue; text = fs.readFileSync(full, "utf8"); } catch { continue; }
      text.split("\n").forEach((line, i) => { for (const { w, re } of res) if (re.test(line)) hits.push({ word: w, at: `${rel}:${i + 1}` }); });
    }
  };
  walk(root);
  return hits;
}

const listOf = (hits) => [...new Set(hits.map((h) => h.word))].map((w) => `- “${w}”: ${hits.filter((h) => h.word === w).map((h) => h.at).slice(0, 5).join(", ")}`).join("\n");
const readState = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };

/** PostToolUse on an Edit of the app: what to tell Claude, or null. `state` remembers the words for the Stop check. */
export function uiChange(input, state) {
  const ti = input?.tool_input ?? {};
  const pairs = input?.tool_name === "MultiEdit" ? (ti.edits ?? []) : input?.tool_name === "Edit" || ti.old_string !== undefined ? [ti] : [];
  if (!pairs.length || typeof ti.file_path !== "string") return null;
  const file = path.resolve(input?.cwd || process.cwd(), ti.file_path);
  const root = appRoot(path.dirname(file));
  if (!fs.existsSync(path.join(root, "qahub.json"))) return null;
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (rel.startsWith("..") || isTestish(rel) || rel.split("/").some((p) => SKIP_DIRS.has(p))) return null;
  let current = ""; try { current = fs.readFileSync(file, "utf8"); } catch { /* deleted */ }
  // Still in the file somewhere else: moved, not removed.
  const words = [...new Set(pairs.flatMap((p) => removedWords(p.old_string, p.new_string)))]
    .filter((w) => !new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(w)}($|[^\\p{L}\\p{N}_])`, "u").test(current));
  const hits = usesIn(root, words);
  if (!hits.length) return null;
  const s = readState(state);
  s[root] = [...new Set([...(s[root] ?? []), ...hits.map((h) => h.word)])];
  try { fs.writeFileSync(state, JSON.stringify(s)); } catch { /* the Stop check just won't know */ }
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext:
    `You took these words out of ${rel}, and the app's tests still look for them:\n${listOf(hits)}\nIf the app now says something else, update those lines to what it says now and run the tests (qahub_run) before you finish. If the old words are still right somewhere else in the app, leave them.` } };
}

/** Stop: a test still looks for words Claude took out of the app → back once (never loops). */
export function staleCheck(input, state) {
  if (input?.stop_hook_active) return null;
  const root = appRoot(input?.cwd || process.cwd());
  const s = readState(state);
  const words = s[root] ?? [];
  if (!words.length) return null;
  const hits = usesIn(root, words);
  if (!hits.length) { delete s[root]; try { fs.writeFileSync(state, JSON.stringify(s)); } catch { /* fine */ } return null; }
  return { decision: "block", reason: `Tests still look for words you took out of the app:\n${listOf(hits)}\nUpdate them to what the app says now and run them with qahub_run — or, if they're still right (the words are still in the app elsewhere), say so in one line and stop.` };
}

if (isMain(import.meta.url)) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(raw || "{}");
      const id = String(input.session_id ?? "nosession").replace(/[^\w-]/g, "").slice(0, 80);
      const state = path.join(os.tmpdir(), `qahub-ui-${id}.json`);
      const out = process.argv[2] === "stop" ? staleCheck(input, state) : uiChange(input, state);
      if (out) process.stdout.write(JSON.stringify(out));
    } catch { /* never block */ }
  });
}
