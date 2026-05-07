// heartbeat.ts — POST /registry/heartbeat keepalive that flips the
// canvas presence badge from `awaiting_agent` to `online`. Closes #6
// and molecule-core#24.
//
// Why this file exists:
//
//   The platform's healthsweep (workspace-server's
//   internal/registry/healthsweep.go) flips any `runtime='external'`
//   workspace whose `last_heartbeat_at` is older than 90s back to
//   `status='awaiting_agent'`. The v0.4.0-gitea.1 channel plugin only
//   POSTed /registry/register at startup (which DOES bump
//   last_heartbeat_at via registry.go:369) but never heartbeated again.
//   Within 90s of plugin start the row goes stale, the canvas badge
//   flips to `awaiting_agent`, and the workspace looks offline even
//   though A2A traffic flows fine over the long-poll loop.
//
//   /workspaces/:id/activity GET (the poll loop) is read-only on the
//   platform side — it does NOT touch presence. /registry/heartbeat is
//   the only endpoint the platform's healthsweep actually watches.
//
// Why a separate module:
//
//   server.ts has top-level side effects (PID-file lock, MCP connect,
//   compat probe, register-as-poll, ticker start). Importing it from a
//   test triggers all of them. Pure helpers — formatRemovedWorkspaceError,
//   computeJitteredInterval, resolvePlatformUrls — already live in
//   their own modules so tests can pin contracts without booting the
//   server. This file follows the same pattern: heartbeat is a
//   fetch-and-log function with a single dependency (workspace_id +
//   token + base URL), trivially testable against a Bun.serve fixture.

/**
 * Send one POST /registry/heartbeat to the platform.
 *
 * On success: 2xx, body drained.
 * On platform 4xx/5xx: logged to stderr with status + truncated body,
 *   resolves cleanly so the next caller's setInterval tick retries.
 * On network error: logged to stderr, resolves cleanly.
 *
 * The function NEVER throws — the typical caller is a setInterval
 * tick, and an unhandled rejection there would kill the heartbeat
 * loop for the rest of the plugin's lifetime, leaving the canvas
 * badge stuck on awaiting_agent with no log to point at.
 *
 * Wire shape (pinned by heartbeat.test.ts):
 *   POST {platformUrl}/registry/heartbeat
 *   Authorization: Bearer {token}
 *   Content-Type: application/json
 *   Origin: {platformUrl}                  -- SaaS edge WAF requires this
 *   {"workspace_id": "<id>"}               -- minimal HeartbeatPayload
 *
 * The body is the smallest valid HeartbeatPayload — workspace_id is the
 * only required field, everything else (error_rate, sample_error,
 * active_tasks, uptime_seconds, current_task) is `omitempty`-friendly
 * on the platform side. The Python runtime in workspace/heartbeat.py
 * sends the same shape when it has no per-tick metrics to attach.
 */
export interface HeartbeatOptions {
  /** Platform base URL, no trailing slash. e.g. https://tenant.staging.moleculesai.app */
  platformUrl: string
  /** Workspace UUID being heartbeated. */
  workspaceId: string
  /** Bearer token issued for this workspace by /registry/register. */
  token: string
  /** Optional fetch override for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** Optional stderr override for tests. Defaults to writing to process.stderr. */
  log?: (line: string) => void
  /** Optional request timeout in ms. Defaults to 10s — heartbeat is a thin
   *  DB UPDATE; if it can't land in 10s the network is wedged enough that
   *  the next tick fires sooner than waiting longer would help. */
  timeoutMs?: number
}

export async function sendHeartbeat(opts: HeartbeatOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const log = opts.log ?? ((line: string) => { process.stderr.write(line) })
  const timeoutMs = opts.timeoutMs ?? 10_000

  let resp: Response
  try {
    resp = await fetchImpl(`${opts.platformUrl}/registry/heartbeat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        Origin: opts.platformUrl,
      },
      body: JSON.stringify({ workspace_id: opts.workspaceId }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    log(`molecule channel: heartbeat ${opts.workspaceId} fetch failed: ${err}\n`)
    return
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    log(
      `molecule channel: heartbeat ${opts.workspaceId} HTTP ${resp.status} — ${errText.slice(0, 200)}\n`,
    )
    return
  }

  // 2xx — drain body so the connection can be reused. We don't consume
  // any field from the heartbeat response; /registry/register is where
  // platform_inbound_secret + auth_token are surfaced.
  await resp.text().catch(() => '')
}
