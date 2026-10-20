// Keep going: Claude is about to stop while tests it is building in this folder aren't done — waiting for review,
// approved with no code, or not passed twice yet. It goes back to work with what's left, round after round, until
// each is done. It stops when it needs the person ("Needs you:"), after MAX rounds, or when waiting alone has
// taken an hour (the person may be away). Never in the recorder chat (stop.mjs): it has its own loop and caps.
export const MAX = 15, MAX_WAIT = 4;

/** What is left of the tests being built: { waiting, write, fix }, from the project's tests by ref. */
export function leftOf(tests, refs) {
  const out = { waiting: [], write: [], fix: [] };
  for (const ref of refs) {
    const t = tests.get(ref);
    if (!t) continue; // rejected or deleted: nothing to do
    if (t.stage === "planned") out.waiting.push(t);
    else if (t.stage === "approved") out.write.push(t);
    else if (t.verified === false) out.fix.push(t);
  }
  return out;
}

/**
 * The Stop answer, or null. `rounds`: { n, waits } this session so far. `active` (stop_hook_active): Claude is already
 * carrying on because a Stop hook sent it back — it goes on only in rounds this hook counted, so it ends by MAX; another
 * hook's send-back is never extended. ponytail: counted per session, not per chain.
 */
export function keepGoing(left, rounds, lastText = "", active = false) {
  if (active && !(rounds.n > 0)) return null;
  if (/(^|\n)\s*\**needs you:/i.test(lastText)) return null;
  const working = left.write.length + left.fix.length;
  if (!working && !left.waiting.length) return null;
  if (rounds.n >= MAX) return null;
  if (!working && rounds.waits >= MAX_WAIT) return null;
  const name = (t) => `${t.ref} “${t.title}”`;
  const lines = [`Not finished — tests you're building in QA Hub aren't done yet (round ${rounds.n + 1} of ${MAX}). Keep going:`];
  if (left.write.length) lines.push(`- Approved, no code yet — write, push and run them: ${left.write.map(name).join(", ")}.`);
  if (left.fix.length) lines.push(`- Not passed twice yet — run them (qahub_run { tests: [...], repeat: 2 }), read each failure (where it ended, the page, the screenshot), find the cause in the app's code, fix, push and run again: ${left.fix.map((t) => `${name(t)} (${t.passes ?? 0} of 2 passes)`).join(", ")}.`);
  if (left.waiting.length) lines.push(`- Waiting for a person to approve: ${left.waiting.map(name).join(", ")} — ${working ? "after the rest, " : ""}call qahub_wait_review { tests: ${JSON.stringify(left.waiting.map((t) => t.ref))} }.`);
  lines.push("Never make a test pass by checking less or waiting longer. Stop only when you truly need the person (a missing test account, a real bug in the app, a decision only they can make): start your message with “Needs you:” and say what.");
  return { decision: "block", reason: lines.join("\n") };
}
