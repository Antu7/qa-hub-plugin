// Talking to QA Hub with the person's API key. Shared by the MCP server and the session-start check.
// The key only ever travels in the Authorization header, only to the configured QA Hub, never through
// a redirect, and never over plain http except to this computer or the local network.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const VERSION = "0.7.12";
/** Where QA Hub lives unless the plugin settings name another address. One place, used by the server and the hooks. */
export const DEFAULT_SERVER = "https://app.qahub.dev";

/**
 * Is this file the script Node was started with? Compared as real paths: a plain string compare of
 * import.meta.url with argv[1] fails on Windows (C:\…), for a path with a space (%20) and through a symlink —
 * and then the MCP server or a hook silently never runs.
 */
export function isMain(url, argv1 = process.argv[1]) {
  try { return !!argv1 && fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(url)); } catch { return false; }
}

export class QaHubError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/** The QA Hub address, or an error saying why it can't be used. */
export function serverUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw new QaHubError("The QA Hub address in the plugin settings isn't a web address.", "bad_server"); }
  const h = u.hostname;
  // This computer, or the office network (a QA Hub on a teammate's machine): a private address or a .local name.
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(h) || h.endsWith(".local") || h.endsWith(".localhost")
    || /^(10\.\d+|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+$/.test(h);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new QaHubError("The QA Hub address must start with https:// (plain http is only allowed on this computer or the office network).", "bad_server");
  return u.origin;
}

/** Plain-language reasons the server gave, by status. The key is never part of a message. */
function explain(status, body, server) {
  const said = body?.error?.message;
  if (status === 401) return new QaHubError(`Your QA Hub API key is not valid (wrong, revoked, or your access was removed). Make a new one at ${server}/account, then run /plugin, open qahub and update the key.`, "unauthorized");
  if (status === 402) return new QaHubError(`Your company's QA Hub plan has ended, so Claude can't send tests. Renew it at ${server}/account.`, "plan_expired");
  if (status === 403) return new QaHubError(said || "Your role in QA Hub can't do this. Ask an owner of your company's QA Hub.", "forbidden");
  if (status === 404) return new QaHubError(said || "Not found in your company's QA Hub.", "not_found");
  if (status === 429) return new QaHubError("Too many requests to QA Hub — wait a minute and try again.", "rate_limited");
  return new QaHubError(said || `QA Hub answered ${status}.`, "server");
}

export function client({ key = process.env.QAHUB_KEY, server = process.env.QAHUB_SERVER, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  key = String(key ?? "").trim();
  let base;
  const ready = () => {
    // A placeholder that was never filled in counts as no key.
    if (!key || key.startsWith("${")) throw new QaHubError("No QA Hub API key yet. Run /plugin, open qahub and add your key (QA Hub → Plan & API keys).", "no_key");
    if (/\s/.test(key) || key.length > 200) throw new QaHubError("The QA Hub API key in the plugin settings has spaces or line breaks in it — paste it again.", "no_key");
    return (base ??= serverUrl(String(server ?? "").trim() || DEFAULT_SERVER));
  };
  /** One request. `timeout` (ms) is longer for a push or a pull, which carry whole files. */
  async function call(method, path, body, { timeout = timeoutMs } = {}) {
    const origin = ready();
    const slow = () => new QaHubError(`QA Hub at ${origin} didn't answer within ${Math.round(timeout / 1000)} s.`, "timeout");
    let res, text;
    try {
      res = await fetchImpl(origin + path, {
        method,
        headers: { Authorization: `Bearer ${key}`, "User-Agent": `qahub-claude-plugin/${VERSION}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
      text = await res.text();
    } catch (e) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw slow();
      throw new QaHubError(`Couldn't reach QA Hub at ${origin}. Check the address in the plugin settings and your connection.`, "unreachable");
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not QA Hub's JSON */ }
    if (!res.ok) throw explain(res.status, json, origin);
    // A page that answers but isn't QA Hub (a website, a login portal, a typo'd address) — never read as "no data".
    if (!json || typeof json !== "object") throw new QaHubError(`${origin} answered, but not like QA Hub does. Check the QA Hub address in the plugin settings (/plugin → qahub).`, "not_qahub");
    return json;
  }

  let checked = null; // { at, me } — the key is re-checked at most once a minute
  /**
   * Who this key belongs to — and refuses when the key or the company's plan is no longer good.
   * Called before every tool, so a revoked key or an ended plan stops work within a minute.
   */
  async function whoami({ fresh = false } = {}) {
    if (!fresh && checked && Date.now() - checked.at < 60_000) return checked.me;
    checked = null;
    const me = await call("GET", "/api/v1/me");
    if (!me?.company?.active) throw new QaHubError(`Your company's QA Hub plan has ended, so Claude can't send tests. Renew it at ${ready()}/account.`, "plan_expired");
    checked = { at: Date.now(), me };
    return me;
  }
  return { call, whoami, origin: () => ready() };
}

// ---- updates ------------------------------------------------------------------------------------
// Claude Code can't be told by a plugin to update itself (third-party marketplaces don't auto-update unless
// the person turns it on), so the session start compares this copy with the published one and says so.
const PUBLISHED = "https://raw.githubusercontent.com/Antu7/qa-hub-plugin/main/.claude-plugin/plugin.json";

/** Is version a newer than b? ("0.7.10" > "0.7.9"); anything unreadable is never newer. */
export function newer(a, b) {
  const p = (v) => (/^\d+(\.\d+){2}$/.test(String(v ?? "")) ? String(v).split(".").map(Number) : null);
  const x = p(a), y = p(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The published version, or null (offline, slow, moved): never more than 2 s, never an error. */
export async function publishedVersion() {
  try {
    const r = await fetch(PUBLISHED, { signal: AbortSignal.timeout(2_000), redirect: "error" });
    return r.ok ? (await r.json()).version ?? null : null;
  } catch { return null; }
}

/** What Claude tells the person once, when this copy is older than the published one. */
export function updateNote(latest, current = VERSION) {
  if (!newer(latest, current)) return "";
  return ` A newer QA Hub plugin is out (${current} → ${latest}). Tell the user once, before other work: in a terminal run \`claude plugin marketplace update qahub\` and then \`claude plugin update qahub@qahub\` (the first only refreshes the list; the second installs it), then restart Claude Code. To never do this by hand again: /plugin → Marketplaces → qahub → Enable auto-update.`;
}
