#!/usr/bin/env node
// Every message the person sends: did someone decide on Claude's test plans in QA Hub since? Approved ones, changes
// asked and rejections become context for Claude — so "I approved them" never has to be typed. Each decision is said
// once per session. Never blocks: 3 s at most, and any problem (no link, QA Hub down) says nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appRoot, reviewState } from "../server/index.mjs";
import { client } from "../server/qahub.mjs";

const input = await new Promise((ok) => {
  let raw = ""; const done = () => { process.stdin.destroy(); try { ok(JSON.parse(raw || "{}")); } catch { ok({}); } };
  process.stdin.on("data", (c) => (raw += c)); process.stdin.on("end", done); setTimeout(done, 500).unref();
});

try {
  const project = JSON.parse(fs.readFileSync(path.join(appRoot(input.cwd || process.cwd()), "qahub.json"), "utf8")).project;
  if (!/^[a-z0-9-]{1,60}$/.test(project ?? "")) process.exit(0);
  const qa = client({ key: process.env.CLAUDE_PLUGIN_OPTION_API_KEY, server: process.env.CLAUDE_PLUGIN_OPTION_SERVER, timeoutMs: 3_000 });
  const st = await reviewState(qa, project);
  // Said already in this session: never twice.
  const seenFile = path.join(os.tmpdir(), `qahub-review-${String(input.session_id ?? "x").replace(/[^\w-]/g, "")}.json`);
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(seenFile, "utf8")); } catch { /* first time */ }
  const lines = [];
  const approved = [...st.tests.values()].filter((t) => t.stage === "approved" && !t.file && seen[t.ref] !== "approved");
  if (approved.length) lines.push(`Approved in QA Hub, no code yet — write, push and run them now: ${approved.map((t) => `${t.ref} “${t.title}”`).join(", ")}.`);
  const changes = [...st.changes.values()].filter((c) => c.stage === "planned" && seen[c.ref] !== `changes:${c.request?.at}`);
  for (const c of changes) lines.push(`${c.ref} “${c.title}”: a person asked for changes — ${c.request?.note ?? ""}. Plan it again with the change.`);
  if (!lines.length) process.exit(0);
  for (const t of approved) seen[t.ref] = "approved";
  for (const c of changes) seen[c.ref] = `changes:${c.request?.at}`;
  fs.writeFileSync(seenFile, JSON.stringify(seen));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `QA Hub, since the last message: ${lines.join(" ")}` } }));
} catch { /* not linked, or QA Hub can't be reached: nothing to say */ }
