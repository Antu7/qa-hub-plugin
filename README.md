# QA Hub for Claude Code

Claude writes Playwright tests while it builds your app and sends them to your company's QA Hub,
where anyone can run them, see results and get reports. **It needs a QA Hub API key** — without
a valid key and an active plan, the plugin does nothing.

## Install

Needs **Node.js 18 or newer** on the computer (`node --version`). Inside Claude Code:

```
/plugin marketplace add Antu7/qa-hub-plugin
/plugin install qahub@qahub
```

**Turn on automatic updates** (once): `/plugin` → **Marketplaces** → **qahub** → **Enable auto-update**. New versions then install by themselves and load the next time Claude Code starts. Claude Code leaves this off for every marketplace except Anthropic's own, and a plugin can't switch it on for you. Without it, Claude tells you at the start of a session when a newer version is out; update with `claude plugin marketplace update qahub` and then `claude plugin update qahub@qahub` (the first only refreshes the list; the second installs the new version), then restart Claude Code. A company admin can enforce it for everyone with managed settings: `"extraKnownMarketplaces": { "qahub": { "source": { "source": "github", "repo": "Antu7/qa-hub-plugin" }, "autoUpdate": true } }`.

Developing the plugin itself: `claude plugin marketplace add /path/to/this/folder` instead (the folder is its own marketplace).

Claude Code asks for:

- **QA Hub API key** — from QA Hub → *Plan & API keys*. Claude Code keeps it as a secret setting (the system keychain on macOS), never in your project's files.
- **QA Hub address** — the address you open QA Hub at (QA Hub's *Claude setup* card shows it). Leave the default for `https://app.qahub.dev`.

Then, in your app's folder:

```
/qahub:connect <your-project>
```

This writes `qahub.json` (`{ "project": "<your-project>" }`) — commit it; it holds no secret.

Changing the key later: `/plugin` → **qahub** → configure.

## How the key is checked

| When | What happens |
|---|---|
| Every session start | The key is checked with QA Hub (`GET /api/v1/me`). Claude is told *connected as …, plan active until …* — or exactly what's wrong. A session is never blocked when QA Hub is down. |
| Every tool call | Checked again (at most once a minute, `qahub_status` always). A revoked key or an ended plan stops work within a minute. |
| Every request on the server | QA Hub itself refuses a missing, wrong or revoked key (401), an ended plan (402) and a role that may not push (403). **This is the real gate** — the plugin's checks are there to say it clearly. |

The key travels only in the `Authorization` header, only to the configured QA Hub, never through a
redirect, and never over plain `http` except to this computer or the office network (`localhost`, `*.local`, `10.*`, `172.16–31.*`, `192.168.*`).

## What it can do

- `qahub_status` — who you are, your plan, your company's projects, which project this folder sends to
- `qahub_link` — link this folder to a project
- `qahub_gaps` — what to test next: untested areas, failing tests
- `qahub_design` — one module's behaviours (what a user can do there) with how far each is proven, and QA Hub's guide for testing each kind
- `qahub_plan` — test cases in plain words (steps with expected results, type, priority, preconditions, what they cover) before any code; reviewed by a person when the project asks for it
- `qahub_project` — the project's structure: the module tree (with addresses), hand-picked sets, every test with its steps and who made it, spec folders and shared helpers
- `qahub_find` — what already tests a behaviour (anyone's tests); SAME = QA Hub would refuse a new one as a duplicate
- `qahub_pull` — QA Hub's latest test files into this folder (adds what's missing; replaces a differing file only when asked)
- `qahub_push` — send test files and the tests in them (only files inside this app's folder; `.env`, keys and anything under `.git` / `node_modules` are never sent). The reply lists each test's ref.
- `qahub_run` — run tests on the person's own connected computer (signed in, real browser) and wait for the result: each failure's test, step, error, and whether the app broke or the page changed. By refs, a tag, a module, a set, or all.
- `qahub_results` — a run's result (the latest, or by number)

**Professional tests, enforced:** every module has behaviours, and each should be **proven** by a test whose code really checks it. QA Hub reads a pushed test's code: a create or edit test must read its typed values back after reopening, a delete test must check the item is gone, a validation test must check the message and that nothing was saved, and a page-opens-only test must be type smoke — otherwise the push is refused, saying what's missing. The Coverage page shows every behaviour as proven, failing, weak, not run, planned or untested.

**Working as a team:** QA Hub keeps one test per behaviour. A push is refused when a new test repeats an existing one (anyone's — a teammate's Claude or a person's recording), unless Claude declares it different (`distinctFrom`); when it would drop a teammate's test from a shared file (pull first, or `remove` it on purpose — recycle bin); and a new test's module must exist or be added in the same push (modules are never renamed by a push). Pushes to one project take turns, so two at the same moment can't both add the same test.

Before `git push`, if the app's latest QA Hub run has failing tests, Claude Code asks you first. Quiet when everything passed, and when QA Hub can't be reached.

**How QA Hub runs Claude's tests:** the person's computer (`qahub connect`, 0.9.21+) runs the stored Playwright files with Playwright's own test runner — signed in once with the project's test account, the environment's address as `baseURL`, each `test.step` shown live, a failed test's screenshot, video and trace kept. So a test uses `page.goto("/path")`, imports only `@playwright/test` and its own pushed files, and is pushed with its exact `test("…")` title.

Skills: `/qahub:write-tests`, `/qahub:connect`.

## Develop

```
node --test test/plugin.test.mjs
claude plugin validate .
claude --plugin-dir .     # try it locally without publishing
```
