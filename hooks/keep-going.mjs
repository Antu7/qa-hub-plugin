// Keep going: Claude is about to stop while tests it is building in this folder have work left that is Claude's —
// approved with no code, or failed in a run this session. It goes back to work with what's left, round after round,
// until each is done. Waiting for a person never holds the session: plans in review, and pushed tests whose runs are
// in progress or not passed twice yet, let it stop (the skill has it say which plans wait for review). It stops when
// it needs the person ("Needs you:"), after MAX rounds, when no qahub tool was called since its last send-back (no
// progress: saying it again won't help — e.g. tests "sent, not run"), and when no computer is connected (nothing runs).
// Never in the recorder chat (stop.mjs): it has its own loop and caps.
export const MAX = 15;

/** What is left of the tests being built: { waiting, write, run, fix }, from the project's tests by ref; `failed`: failedIn, `ran`: ranIn. */
export function leftOf(tests, refs, failed = new Set(), ran = null) {
  const out = { waiting: [], write: [], run: [], fix: [] };
  for (const ref of refs) {
    const t = tests.get(ref);
    if (!t) continue; // rejected or deleted: nothing to do
    if (t.stage === "planned") out.waiting.push(t);
    else if (t.stage === "approved") out.write.push(t);
    else if (t.verified === false && failed.has(ref)) out.fix.push(t);
    else if (t.verified === false && ran && !ran.has(ref)) out.run.push(t); // pushed, never run: nobody else will
    // not failed and run: its runs just aren't done — never wait for them
  }
  return out;
}

/** How many qahub tools Claude called in this session, from the transcript (JSONL). */
export function qahubCalls(transcript) {
  let n = 0;
  for (const line of transcript.split("\n")) {
    if (!line.includes("qahub_")) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "assistant") n += (e.message?.content ?? []).filter((c) => c.type === "tool_use" && /__qahub_\w+$/.test(c.name ?? "")).length;
    } catch { /* not JSON */ }
  }
  return n;
}

/** Refs a qahub_run named in this session, from the transcript (JSONL). */
export function ranIn(transcript) {
  const ran = new Set();
  for (const line of transcript.split("\n")) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    for (const c of e?.message?.content ?? []) if (c?.type === "tool_use" && /qahub_run$/.test(c.name ?? "")) for (const r of c.input?.tests ?? []) ran.add(r);
  }
  return ran;
}

/** Refs whose last run in this session failed, from the transcript (JSONL): a run naming a test clears it, a result's
 * "- TEST-… “…” failed" line (describeRun) sets it. */
export function failedIn(transcript) {
  const failed = new Set();
  for (const line of transcript.split("\n")) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    for (const c of e?.message?.content ?? []) {
      if (c?.type === "tool_use" && /qahub_run$/.test(c.name ?? "")) for (const r of c.input?.tests ?? []) failed.delete(r);
      if (c?.type !== "tool_result") continue;
      const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x?.text ?? "").join("\n");
      for (const m of text.matchAll(/^- (TEST-\d+) “[^”]*”(?: \([^)]*\))? failed/gm)) failed.add(m[1]);
    }
  }
  return failed;
}

/**
 * The Stop answer, or null. `rounds`: { n } this session so far. `active` (stop_hook_active): Claude is already
 * carrying on because a Stop hook sent it back — it goes on only in rounds this hook counted, so it ends by MAX; another
 * hook's send-back is never extended. `calls`: qahub tools called so far (qahubCalls) — the same as at the last send-back
 * (rounds.calls) is no progress. `computer`: one is connected (whoami); without it nothing runs.
 * ponytail: counted per session, not per chain.
 */
export function keepGoing(left, rounds, lastText = "", active = false, { calls, computer = true } = {}) {
  if (active && !(rounds.n > 0)) return null;
  if (/(^|\n)\s*\**needs you:/i.test(lastText)) return null;
  if (rounds.n > 0 && calls !== undefined && rounds.calls !== undefined && calls <= rounds.calls) return null;
  if (!computer) return null;
  if (!left.write.length && !left.fix.length && !left.run?.length) return null; // only a person's review, or runs not done: never wait for them
  if (rounds.n >= MAX) return null;
  const name = (t) => `${t.ref} “${t.title}”`;
  const lines = [`Not finished — tests you're building in QA Hub aren't done yet (round ${rounds.n + 1} of ${MAX}). Keep going:`];
  if (left.write.length) lines.push(`- Approved, no code yet — write, push and run them: ${left.write.map(name).join(", ")}.`);
  if (left.run?.length) lines.push(`- Pushed, never run — run them twice: qahub_run { tests: ${JSON.stringify(left.run.map((t) => t.ref))}, repeat: 2 }: ${left.run.map(name).join(", ")}.`);
  if (left.fix.length) lines.push(`- Failed — read each failure (where it ended, the page, the screenshot), find the cause in the app's code, fix, push and run again (qahub_run { tests: [...], repeat: 2 }): ${left.fix.map((t) => `${name(t)} (${t.passes ?? 0} of 2 passes)`).join(", ")}.`);
  if (left.waiting.length) lines.push(`- Waiting for a person's review: ${left.waiting.map(name).join(", ")} — don't wait for them: finish the rest, then end saying which plans wait for review (once approved, the next session writes them).`);
  lines.push("Never make a test pass by checking less or waiting longer. Stop only when you truly need the person (a missing test account, a real bug in the app, a decision only they can make): start your message with “Needs you:” and say what.");
  return { decision: "block", reason: lines.join("\n") };
}
