---
name: write-tests
description: Design and write professional end-to-end tests for what you just built or changed — aligned with the project's QA Hub (its modules, behaviours, sets and the tests teammates and people already have) — plan them, push them, run them on the person's computer and fix what fails. Use after building or changing a user-facing feature, when the user asks for tests or what to test next, or QA Hub has change or fix requests.
---

# Test like a QA engineer — designed, proven, never twice

Several people build this app with their own Claude, and others record tests in QA Hub. QA Hub is the one shared place: each module has **behaviours** (what a user can do there), each behaviour should be **proven** by a test whose code really checks it, and there is **one test per behaviour**. The person may not be technical: they read your tests as plain steps with expected results.

The person may only say "automate this", "test the training page" or "I want negative tests for the forms". Take it from there: you design, write, push, run and fix — they read plain steps and results. When they ask for a kind of testing, map it onto QA Hub's types (functional, negative, boundary, validation, permission, workflow, smoke). QA Hub runs end-to-end browser tests only: for load, security scanning, API-only or unit tests, say so plainly and offer the browser tests that come closest — never pretend.

1. **Connect.** `qahub_status` (key, plan, whether their computer is connected, environments). Not linked: ask which project, `qahub_link`.
2. **Know the project.** `qahub_project`: modules, their behaviours and state, sets, every test (steps, author, type, whether it's proven), spec folders, helpers. `qahub_gaps` first if there are change or fix requests — they come first (step 9).
3. **Design the module you're working on.** `qahub_design { module }`:
   - its behaviours: **untested** and **weak** first, high priority first;
   - the guide for each kind (create, edit, delete, search, validation, workflow, permission, calculation…) — what a professional checks, and what QA Hub requires the code to prove.
   - **A part of the app QA Hub doesn't have yet** (a page you just built): design and plan answer "no module". Add it first — `qahub_push { modules: [{ name, path: "/its-url", parent }] }` (parent only for a sub-page), nothing else in that push — then design it.
   - Not designed yet, or the feature adds something new → propose behaviours: one per thing a user can do ("Create a quote", "Delete a quote", "Only managers approve"), with kind and priority (money, data loss, access → high).
4. **Plan test cases, the way a QA engineer would — not only the happy path.** For each behaviour, using the guide:
   - **positive**: the main path, with every value read back after reopening;
   - **negative / validation**: required fields empty, wrong formats, duplicates → the message, and nothing saved;
   - **boundaries**: 0, the maximum, one more than the maximum;
   - **edit**: changed fields show the new values and unchanged ones keep theirs;
   - **delete**: gone from the list, from search and its page;
   - **workflow / permission**: every allowed move or role, and every forbidden one blocked.
   Each test case: a title, its type, priority, what must be true before it starts, and **every step with its expected result**. Check `qahub_find` for each — a **SAME** test already exists: improve it, never write a second one.
5. **`qahub_plan`** the behaviours and test cases. A test case whose title is already a test in that module updates that test (the reply lists it under "already tests") — change its code, never write a second one; `distinctFrom` never applies to the same title. If the project reviews plans, the reply says they're waiting: tell the user (with the link) and **stop** for those tests. Otherwise write the code.
6. **Write the code** (`@playwright/test`, in the project's spec folders, reusing its helpers; `qahub_pull` first if you change a shared file). QA Hub runs the file itself:
   - tests start signed in — no log-in steps, never a password, key or token;
   - `page.goto("/path")` — QA Hub sets the address;
   - imports: `@playwright/test` and your own pushed files only;
   - `test("…")` named **exactly** as planned; its `test.step` names **equal** to the planned steps;
   - **prove it**: create/edit → reload or reopen the record, then expect the typed values; delete → expect it gone; validation → expect the message and that nothing was saved. QA Hub reads the code and refuses a test that doesn't.
   - **one control, one meaning**: when the page has two of a kind (the app's global search and the page's own search, a header button and an empty-state button), scope to the page's own region (`page.getByRole("main")`, the dialog, the card) — never `.first()`, never the one that merely matches first;
   - **a file to upload** (a photo, a PDF, a spreadsheet, a CSV): put it in the spec folder (e.g. `tests/fixtures/robot.png`), attach it with `setInputFiles(path.join(__dirname, "fixtures/robot.png"))`, and push it with the test. QA Hub stores it (up to 10 MB) and puts it next to the test on every run. A small made-up file, never a real person's document;
   - **its own data, then tidy up**: give what a test creates a unique name starting with `QA ` (so people can spot it), and delete it at the end when the app allows it (a `finally`, or a cleanup step) — every run must leave the app as it found it.
7. **`qahub_push`** the files with each test's `type`, `priority`, `preconditions`, `covers` and steps `{ title, expect }`. **List the tests in the order a person would do them** (create → open → edit → delete) — that's the order they get their numbers and join a set (`sets`). A test is independent by default and every test runs even when another fails; only when a test truly uses what another one makes, give it `needs: ["<that test's title or ref>"]` — QA Hub then runs it after that test (in every run and every set) and skips it only if that test fails. Read the reply:
   - **a depth refusal** ("the edited value is never checked after reopening") → fix the test so it proves it. `waiver` only with a true reason the code can't prove it (shown in QA Hub; the behaviour then never reads proven) — never to get past a refusal you could fix;
   - **looks like TEST-…** → a duplicate: improve that one, or `distinctFrom` if it truly tests something else;
   - **would remove TEST-…** → `qahub_pull`, keep the teammate's test, push again;
   - **module isn't in QA Hub / covers something that isn't a behaviour** → use QA Hub's names, or add them (`modules`, `behaviours`);
   - **waiting for review** → stop; a person approves the plan first.
8. **`qahub_run { tests: [refs] }`** on their computer. Failures name the test, step and error and whether the app broke or the page changed: fix the app if it's wrong, the test if it no longer matches — never check less or wait longer. Push, run again; stop after 3 rounds on one failure and say what you found. Not connected: tell them once how (QA Hub → Computers) and say the tests are sent, not run.
9. **Change and fix requests** (`qahub_gaps`): a change request on a **planned** test case is a person's note on your plan — `qahub_plan` it again with the change; on a test with code, change the code and push with `applied: true` (`replaces` when its title or file changed). A fix request: find the cause as in step 8.
10. **Tell the user** in two lines: what is now proven (behaviours), what's still untested, the run result and its link.
11. **Suggest what's next — unasked.** From the untested and weak behaviours (`qahub_gaps`), recommend the 2–3 tests worth most, each with one plain reason — money, deleting data and who-may-do-what first ("Delete a course: nothing proves a deleted course is really gone"). Also suggest kinds they haven't asked for when the feature calls for them (a form with no negative tests, an approval with no permission test). Offer to do them; don't start without a yes.
