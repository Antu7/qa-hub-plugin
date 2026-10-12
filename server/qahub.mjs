// Talking to QA Hub with the person's API key. Shared by the MCP server and the session-start check.
// The key only ever travels in the Authorization header, only to the configured QA Hub, never through
// a redirect, and never over plain http except to this computer or the local network.

export const VERSION = "0.7.1";

export class QaHubError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/** The QA Hub address, or an error saying why it can't be used. */
export function serverUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw new QaHubError("The QA Hub address in the plugin settings isn't a web address.", "bad_server"); }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname) || u.hostname.endsWith(".local") || u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new QaHubError("The QA Hub address must start with https:// (plain http is only allowed on this computer).", "bad_server");
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

export function client({ key = process.env.QAHUB_KEY, server = process.env.QAHUB_SERVER, fetchImpl = fetch } = {}) {
  key = String(key ?? "").trim();
  let base;
  const ready = () => {
    // A placeholder that was never filled in counts as no key.
    if (!key || key.startsWith("${")) throw new QaHubError("No QA Hub API key yet. Run /plugin, open qahub and add your key (QA Hub → Plan & API keys).", "no_key");
    if (/\s/.test(key) || key.length > 200) throw new QaHubError("The QA Hub API key in the plugin settings has spaces or line breaks in it — paste it again.", "no_key");
    return (base ??= serverUrl(server));
  };
  async function call(method, path, body) {
    const origin = ready();
    let res;
    try {
      res = await fetchImpl(origin + path, {
        method,
        headers: { Authorization: `Bearer ${key}`, "User-Agent": `qahub-claude-plugin/${VERSION}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new QaHubError(`Couldn't reach QA Hub at ${origin}. Check the address in the plugin settings and your connection.`, "unreachable");
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw explain(res.status, json, origin);
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
