#!/usr/bin/env bun
/**
 * Molecule AI channel for Claude Code.
 *
 * MCP server that bridges Molecule A2A traffic into the active Claude Code
 * session and routes Claude's replies back through Molecule's A2A endpoints.
 *
 * Inbound (A2A → Claude turn): polls each watched workspace's
 *   GET /workspaces/:id/activity?since_secs=N&type=a2a_receive
 * and emits an MCP `notifications/claude/channel` for each new event.
 * Polling (vs push) is the default because it works through every NAT/firewall
 * with zero infra — no tunnel required. For production setups with a public
 * inbound URL, see #2 in the README ("push mode", future).
 *
 * Outbound (Claude reply → A2A): exposes the `reply_to_workspace` and
 * `start_workspace_chat` MCP tools that POST to /workspaces/:id/a2a.
 *
 * State lives in ~/.claude/channels/molecule/:
 *   - access.json         workspace allowlist + per-workspace auth
 *   - .env                MOLECULE_PLATFORM_URL + tokens (chmod 600)
 *   - bot.pid             singleton lock
 *   - inbox/              file attachments downloaded from peers
 *
 * Multi-workspace: declare MOLECULE_WORKSPACE_IDS as a comma-separated list;
 * each id polls independently. Auth is per-workspace via
 * MOLECULE_WORKSPACE_TOKENS (same order, comma-separated).
 *
 * Cancellation: SIGTERM/SIGINT cleanly drains in-flight pollers + posts a
 * single "channel disconnecting" line back to each watched workspace so
 * peers see a deliberate close, not a silent timeout.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, renameSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { extractText, type ActivityEntry } from './extract-text.ts'
import { sendHeartbeat } from './heartbeat.ts'

// ─── Config ─────────────────────────────────────────────────────────────

const STATE_DIR = process.env.MOLECULE_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'molecule')
const ENV_FILE = join(STATE_DIR, '.env')
const PID_FILE = join(STATE_DIR, 'bot.pid')
const CURSOR_FILE = join(STATE_DIR, 'cursor.json')

// Load ~/.claude/channels/molecule/.env into process.env. Real env wins.
// Plugin-spawned servers don't get an env block — this is where tokens live.
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
try {
  // Token is a credential — lock to owner. No-op on Windows (would need ACLs).
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {
  // Missing .env on first run is fine; we'll fail loudly below if required vars are absent.
}

const PLATFORM_URL = process.env.MOLECULE_PLATFORM_URL?.replace(/\/$/, '')
const WORKSPACE_IDS = (process.env.MOLECULE_WORKSPACE_IDS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)
const WORKSPACE_TOKENS = (process.env.MOLECULE_WORKSPACE_TOKENS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)
const POLL_INTERVAL_MS = parseInt(process.env.MOLECULE_POLL_INTERVAL_MS ?? '5000', 10)
// POLL_WINDOW_SECS is only used for the initial "watch from now" cursor seed
// — after that, the cursor (since_id) drives every subsequent poll. Older
// versions of the plugin used since_secs as the primary filter; v0.2 keeps
// the env var for compat but its meaning is narrower.
const POLL_WINDOW_SECS = parseInt(process.env.MOLECULE_POLL_WINDOW_SECS ?? '30', 10)
// MOLECULE_AGENT_NAME / MOLECULE_AGENT_DESC populate the agent_card the plugin
// posts to /registry/register on startup. Both have sane defaults — set them
// only when you want the canvas tab to show something specific.
const AGENT_NAME = process.env.MOLECULE_AGENT_NAME ?? 'Claude Code (channel)'
const AGENT_DESC = process.env.MOLECULE_AGENT_DESC ??
  'Local Claude Code session bridged via molecule-mcp-claude-channel'
// MOLECULE_AUTO_REGISTER_POLL controls the startup auto-register behavior.
// Default is "yes" — the plugin's whole point is to make a poll-mode
// workspace work without manual canvas configuration. Set to "0" / "false"
// if you've already configured the workspace another way and don't want
// the plugin overwriting agent_card on every restart.
const AUTO_REGISTER_POLL = !['0', 'false', 'no'].includes(
  (process.env.MOLECULE_AUTO_REGISTER_POLL ?? 'true').toLowerCase()
)
// MOLECULE_HEARTBEAT_INTERVAL_MS — cadence for the per-workspace
// /registry/heartbeat ping that keeps the canvas presence badge on
// "online" (closes #6 / molecule-core#24).
//
// Default 30_000ms (30s) matches the Python runtime's HEARTBEAT_INTERVAL
// in workspace/heartbeat.py and is well under the platform's 90s
// `REMOTE_LIVENESS_STALE_AFTER` window — three heartbeat ticks fit
// inside the staleness budget so a single dropped POST doesn't flap
// the workspace to `awaiting_agent`.
//
// Set to 0 to disable the heartbeat loop entirely (useful for tests
// or for operators who run a separate heartbeat daemon). Negative
// values are clamped to 0.
const HEARTBEAT_INTERVAL_MS = Math.max(
  0,
  parseInt(process.env.MOLECULE_HEARTBEAT_INTERVAL_MS ?? '30000', 10) || 0,
)

if (!PLATFORM_URL || WORKSPACE_IDS.length === 0 || WORKSPACE_TOKENS.length === 0) {
  process.stderr.write(
    `molecule channel: required config missing\n` +
    `  set in ${ENV_FILE}\n` +
    `  format:\n` +
    `    MOLECULE_PLATFORM_URL=https://your-tenant.staging.moleculesai.app\n` +
    `    MOLECULE_WORKSPACE_IDS=ws-uuid-1,ws-uuid-2\n` +
    `    MOLECULE_WORKSPACE_TOKENS=tok-1,tok-2\n` +
    `  optional:\n` +
    `    MOLECULE_POLL_INTERVAL_MS=5000\n` +
    `    MOLECULE_POLL_WINDOW_SECS=30\n`
  )
  process.exit(1)
}
if (WORKSPACE_IDS.length !== WORKSPACE_TOKENS.length) {
  process.stderr.write(
    `molecule channel: MOLECULE_WORKSPACE_IDS and MOLECULE_WORKSPACE_TOKENS must have ` +
    `the same number of entries (got ${WORKSPACE_IDS.length} ids vs ${WORKSPACE_TOKENS.length} tokens)\n`
  )
  process.exit(1)
}

const TOKEN_BY_WORKSPACE = new Map<string, string>(
  WORKSPACE_IDS.map((id, i) => [id, WORKSPACE_TOKENS[i]])
)

// ─── Singleton lock ─────────────────────────────────────────────────────
//
// One channel server per host — multiple Claude sessions polling the same
// workspaces would race the dedup state and double-deliver. If a previous
// session crashed (SIGKILL, terminal closed) its server can survive as an
// orphan; kill it before we start.

try {
  const stale = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
  if (stale > 1 && stale !== process.pid) {
    process.kill(stale, 0)  // throws if dead
    process.stderr.write(`molecule channel: replacing stale poller pid=${stale}\n`)
    process.kill(stale, 'SIGTERM')
  }
} catch {}
writeFileSync(PID_FILE, String(process.pid))

// Unlink the PID file on every exit path — including process.exit(N)
// from the cursor-support probe (v0.2.1) which doesn't go through the
// SIGINT/SIGTERM handlers. Without this, a non-clean exit leaves a
// stale pid in PID_FILE pointing at a dead pid; the next launch's
// `process.kill(stale, 'SIGTERM')` (above) would deliver the signal to
// whatever unrelated process now owns that PID — exactly the cross-
// process-kill hazard the singleton lock exists to prevent. exit
// listeners only run synchronous code; unlinkSync is the right tool.
process.on('exit', () => {
  try {
    const owned = parseInt(readFileSync(PID_FILE, 'utf8'), 10)
    if (owned === process.pid) unlinkSync(PID_FILE)
  } catch {
    // Already gone, or another process took ownership — leave it alone.
  }
})

// Last-resort safety net — without these the process dies silently on any
// unhandled promise rejection. With them it logs and keeps serving tools.
process.on('unhandledRejection', err => {
  process.stderr.write(`molecule channel: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`molecule channel: uncaught exception: ${err}\n`)
})

// ─── Activity polling (inbound) ─────────────────────────────────────────
//
// One independent poll loop per watched workspace. Each loop tracks the
// max activity_id it has seen so far; on each tick it queries
//   GET /workspaces/:id/activity?since_secs=POLL_WINDOW_SECS&type=a2a_receive
// and emits an MCP notification for any activity whose id is new.
//
// `since_secs` is wider than the poll interval (30s vs 5s by default) so a
// single missed tick (transient network blip) doesn't lose messages — the
// next tick re-fetches the overlap window and the seen-id dedup filters it.
//
// activity_logs is paged out at 30 days, so an honest seen-id set never
// grows unbounded; new sessions start fresh.

// ActivityEntry lives in extract-text.ts (imported above) so unit
// tests can import the type + helper without triggering server.ts's
// boot-time side-effects (cursor load, MCP transport connect).

// ─── Cursor persistence ────────────────────────────────────────────────
//
// v0.2 switches from the v0.1 since_secs+seenIds scheme to a Telegram-style
// since_id cursor. The cursor is the activity_logs.id of the last event
// this plugin successfully delivered to Claude. Server returns events
// strictly after that id in ASC order, so we never miss or replay.
//
// Persisted to ${CURSOR_FILE} as a JSON object keyed by workspace_id.
// Atomic write via temp + rename so a crash mid-write can't corrupt the
// file (the previous cursor stays valid; worst case is a few replays
// after the crash, which still beats the v0.1 30-second time-window).
//
// Schema:  { "ws-uuid-1": "act-uuid-X", "ws-uuid-2": "act-uuid-Y", ... }
// Missing key = "first run" → seeds from most-recent without processing.
// 410 from server = cursor stale → drop key, re-seed on next tick.

const cursors = new Map<string, string>()

function loadCursors(): void {
  if (!existsSync(CURSOR_FILE)) return
  try {
    const raw = readFileSync(CURSOR_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.length > 0) cursors.set(k, v)
    }
  } catch (err) {
    // Corrupt cursor file = treat as no cursors. Worst case: each watched
    // workspace re-seeds from now on the next tick (no replay, no message
    // loss for events arriving AFTER the seed). Don't fail-fast here —
    // a poller that refuses to start because of one bad file is more
    // annoying than the recovery cost.
    process.stderr.write(`molecule channel: cursor file unreadable (${err}); starting fresh\n`)
  }
}

function saveCursors(): void {
  const obj: Record<string, string> = {}
  for (const [k, v] of cursors) obj[k] = v
  const tmp = `${CURSOR_FILE}.tmp.${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
    renameSync(tmp, CURSOR_FILE)
  } catch (err) {
    // Cursor write failure is recoverable (next successful poll re-saves);
    // log on stderr so the user sees disk-full / readonly-fs early.
    process.stderr.write(`molecule channel: cursor save failed: ${err}\n`)
  }
}

// Per-row inbound filter for the activity feed. The `?type=a2a_receive`
// query already restricts the kind, but the platform STILL returns the
// agent's own outbound /notify rows in that view — they're recorded as
// a2a_receive on the SAME workspace_id with method='notify' and a null
// source_id. emitNotification would then classify them as `canvas_user`
// inbound (because peer_id is empty), and every reply this plugin sent
// would echo back as a fake user turn one poll later — the model would
// see its own answer as a new user prompt and try to "respond" to it,
// burning tokens and confusing the conversation.
//
// Filter on the row level so the cursor still advances past these rows
// (the caller already advances cursor to activities[last].id regardless
// of skip/emit, so a long run of notify-only rows can't stall the cursor).
//
// Reno-Stars caught this as the v0.4.0-gitea.2 → .3 P1 fix. Exported so
// a regression test can pin the contract without standing up a fake
// activity-feed HTTP fixture just to assert one boolean.
export function shouldEmitActivity(act: Pick<ActivityEntry, 'method'>): boolean {
  // Outbound /notify calls (this agent's own replies) — silently drop.
  if (act.method === 'notify') return false
  return true
}

async function pollWorkspace(workspaceId: string, mcp: Server): Promise<void> {
  const token = TOKEN_BY_WORKSPACE.get(workspaceId)!
  const url = new URL(`${PLATFORM_URL}/workspaces/${workspaceId}/activity`)
  url.searchParams.set('type', 'a2a_receive')
  url.searchParams.set('limit', '100')

  const cursor = cursors.get(workspaceId)
  if (cursor) {
    // Steady-state: server returns rows strictly after cursor in ASC order.
    url.searchParams.set('since_id', cursor)
  } else {
    // First run for this workspace — deliver every event in the POLL_WINDOW_SECS
    // backfill window, then advance the cursor past the newest. The previous
    // policy was seed-then-skip on the assumption that pre-session events
    // were "out of context", but operators routinely restart Claude Code
    // mid-conversation and EXPECT the queued message to be delivered (otherwise
    // the user typed something, restarted to enable replies, and got silence
    // — exactly the friction this channel is supposed to remove).
    //
    // Backfill is bounded by POLL_WINDOW_SECS so a long-idle restart doesn't
    // replay weeks of conversation. Set POLL_WINDOW_SECS=0 to opt out and
    // restore the old skip-on-cold-start behavior.
    url.searchParams.set('since_secs', String(POLL_WINDOW_SECS))
  }

  let resp: Response
  try {
    resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        // Same-origin header — required by the tenant's edge WAF on hosted
        // SaaS deployments. Without it the WAF rewrites the request and
        // /workspaces/* returns an empty 404 (it's silently routed to the
        // canvas Next.js, which has no /workspaces page). Node/Bun fetch
        // doesn't auto-set Origin (that's a browser-only concern), so we
        // set it explicitly to PLATFORM_URL — the only origin the bearer
        // is valid against anyway, so no risk of leaking it elsewhere.
        Origin: PLATFORM_URL,
      },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    process.stderr.write(`molecule channel: poll ${workspaceId} fetch failed: ${err}\n`)
    return
  }

  if (resp.status === 410) {
    // Cursor row is gone (pruned, or never existed if the env var was
    // hand-edited). Drop the cursor; next tick re-seeds from most-recent.
    process.stderr.write(`molecule channel: poll ${workspaceId} cursor stale (410) — re-seeding\n`)
    cursors.delete(workspaceId)
    saveCursors()
    return
  }
  if (!resp.ok) {
    // 401/403 = bad token; 404 = workspace doesn't exist; 5xx = transient.
    // Surface 4xx on stderr so the user sees auth/config issues immediately.
    if (resp.status >= 400 && resp.status < 500) {
      process.stderr.write(
        `molecule channel: poll ${workspaceId} returned ${resp.status} — ` +
        `check MOLECULE_WORKSPACE_TOKENS / MOLECULE_WORKSPACE_IDS in ${ENV_FILE}\n`
      )
    }
    return
  }
  let activities: ActivityEntry[]
  try {
    activities = (await resp.json()) as ActivityEntry[]
  } catch (err) {
    process.stderr.write(`molecule channel: poll ${workspaceId} parse failed: ${err}\n`)
    return
  }

  // Cold-start AND steady-state share the same delivery shape: walk
  // ASC-ordered events, emit each, advance cursor past the newest. The
  // only difference is whether we got rows by since_id (steady-state) or
  // since_secs (cold start backfill); the platform returns the same
  // column shape and ordering either way.
  //
  // Advance cursor even on emit failure — the alternative (block on
  // notification failure) would stall the channel entirely, and
  // notification delivery is best-effort anyway.
  if (activities.length === 0) return
  for (const act of activities) {
    if (!shouldEmitActivity(act)) continue
    emitNotification(mcp, workspaceId, act)
  }
  const newest = activities[activities.length - 1].id
  if (newest !== cursor) {
    cursors.set(workspaceId, newest)
    saveCursors()
  }
}

// ─── Cursor-support probe (startup compat check) ──────────────────────
//
// v0.2 relies on the since_id cursor on /activity (Molecule-AI/molecule-core
// PR #2354). Older platforms silently ignore the query param and return
// whatever the default time window covers, which would make us re-deliver
// the same activities on every tick — a worse silent-duplicate bug than
// any failure mode v0.1 had.
//
// Detect at startup with a known-invalid UUID. PR-#2354+ answers 410 Gone
// for any cursor that doesn't resolve to an activity_logs row. Pre-#2354
// servers ignore the param and answer 200 OK. We use the all-zero UUID
// because gen_random_uuid() will never produce it (per RFC 4122 §4.4 the
// version + variant bits are non-zero), so a 410 is unambiguous.
//
// Probe failure is fatal — the user MUST upgrade. Falling back to v0.1
// behavior would re-introduce the message-loss-on-restart bug v0.2 was
// written to fix; failing loudly is the better default.
const PROBE_CURSOR = '00000000-0000-0000-0000-000000000000'

async function probeCursorSupport(workspaceId: string): Promise<'ok' | 'too_old' | 'inconclusive'> {
  const token = TOKEN_BY_WORKSPACE.get(workspaceId)!
  const url = new URL(`${PLATFORM_URL}/workspaces/${workspaceId}/activity`)
  url.searchParams.set('type', 'a2a_receive')
  url.searchParams.set('since_id', PROBE_CURSOR)
  url.searchParams.set('limit', '1')

  let resp: Response
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Origin: PLATFORM_URL },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    process.stderr.write(`molecule channel: probe ${workspaceId} fetch failed: ${err}\n`)
    return 'inconclusive'
  }

  if (resp.status === 410) return 'ok'
  if (resp.status === 200) return 'too_old'

  // 401/403/404/5xx — orthogonal to cursor support. Probe is inconclusive;
  // let the normal poll loop surface the real failure.
  process.stderr.write(
    `molecule channel: probe ${workspaceId} returned HTTP ${resp.status} (expected 410); ` +
    `cursor support unverifiable, continuing\n`
  )
  return 'inconclusive'
}

// ─── Register-as-poll (startup self-register) ──────────────────────────
//
// On startup, register each watched workspace with delivery_mode=poll so
// the platform's a2a_proxy short-circuits to activity_logs (PR 2 / #2353)
// instead of trying to dispatch HTTP to a URL the operator's laptop
// doesn't have. Idempotent — the upsert in /registry/register's handler
// preserves existing values; we just declare delivery_mode and the
// agent_card.
//
// Failure here is non-fatal — the polling loop still works against a
// pre-poll-configured workspace, and a transient platform 5xx shouldn't
// block channel startup. Log loudly so misconfiguration is visible.
async function registerAsPoll(workspaceId: string): Promise<void> {
  const token = TOKEN_BY_WORKSPACE.get(workspaceId)!
  const body = {
    id: workspaceId,
    delivery_mode: 'poll',
    agent_card: {
      name: AGENT_NAME,
      description: AGENT_DESC,
    },
  }
  let resp: Response
  try {
    resp = await fetch(`${PLATFORM_URL}/registry/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Origin: PLATFORM_URL,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    process.stderr.write(`molecule channel: register-as-poll ${workspaceId} fetch failed: ${err}\n`)
    return
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    process.stderr.write(
      `molecule channel: register-as-poll ${workspaceId} HTTP ${resp.status} — ${errText.slice(0, 200)}\n`
    )
    return
  }
  // Sanity-check: the platform should echo back delivery_mode=poll.
  // A push reply means an older controlplane that doesn't know about
  // delivery_mode yet — log so the user can identify the mismatch.
  try {
    const j = (await resp.json()) as { delivery_mode?: string }
    if (j.delivery_mode && j.delivery_mode !== 'poll') {
      process.stderr.write(
        `molecule channel: register-as-poll ${workspaceId} returned delivery_mode=${j.delivery_mode} ` +
        `(expected poll). Platform may predate #2339.\n`
      )
    }
  } catch {
    // Non-JSON response. Don't fail; the 2xx already tells us the upsert
    // landed, and the polling loop is the source of truth for steady-state.
  }
}

// ─── Notification emission ─────────────────────────────────────────────

function emitNotification(mcp: Server, workspaceId: string, act: ActivityEntry): void {
  const text = extractText(act)
  // Discriminate canvas-user messages (typed in the canvas chat panel) from
  // peer-agent A2A traffic. The canvas wraps user chat as JSON-RPC
  // message/send with source_id=null; real peers carry their workspace_id
  // in source_id. The reply tool routes differently on this — canvas_user
  // → /notify (lands in the user's chat), peer_agent → /a2a (proper JSON-RPC
  // response to the calling peer).
  const peerId = act.source_id ?? ''
  const kind: 'canvas_user' | 'peer_agent' = peerId ? 'peer_agent' : 'canvas_user'

  // Per the telegram channel reference: notifications/claude/channel is the
  // host's hook. content becomes the conversation turn; meta is structured
  // metadata Claude can reason about (workspace_id, peer_id, ts, etc.).
  // image_path / attachment_* mirror telegram's shape so the host's
  // attachment handling works without a custom path.
  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        source: 'molecule',
        kind,
        workspace_id: act.workspace_id,
        watching_as: workspaceId,
        peer_id: peerId,
        method: act.method ?? '',
        activity_id: act.id,
        ts: act.created_at,
      },
    },
  }).catch(err => {
    process.stderr.write(`molecule channel: failed to deliver notification for ${act.id}: ${err}\n`)
  })
}

// ─── MCP server ─────────────────────────────────────────────────────────

// Capabilities: declaring `experimental['claude/channel']` is what makes the
// Claude Code MCP host actually deliver our `notifications/claude/channel`
// events into the conversation. Without it the host treats this server as
// tool-only and silently drops every channel notification — the poll
// advances, the cursor moves, stderr says "delivered", and yet no message
// reaches the user. The companion `claude/channel/permission` flag opts the
// server into the permission-prompt path the host gates channel writes on.
//
// Reno-Stars caught this as the v0.4.0-gitea.2 → .3 P0 fix; mirrors the
// shape used by the official telegram channel plugin's MCP server.
//
// Exported so a regression test can pin the shape without spinning up a
// real Server / stdio transport.
export const SERVER_CAPABILITIES = {
  tools: {},
  experimental: {
    'claude/channel': {},
    'claude/channel/permission': {},
  },
} as const

const mcp = new Server(
  { name: 'molecule', version: '0.4.0-gitea.3' },
  { capabilities: SERVER_CAPABILITIES },
)

// Tool: reply_to_workspace ----------------------------------------------
//
// Sends a reply from one of our watched workspaces. The destination is
// picked from `peer_id`:
//
//   - peer_id absent / empty  → canvas-user reply via POST /workspaces/:our/notify
//                               (lands in the My Chat panel — what users see when
//                               they type in the canvas)
//   - peer_id present         → peer-agent A2A reply via POST /workspaces/:peer/a2a
//                               with a proper JSON-RPC message/send envelope
//
// The notification meta.kind tells Claude which to use; this tool just
// honors whichever peer_id the caller passes.

const ReplyArgsSchema = z.object({
  workspace_id: z.string().describe(
    "Watched workspace_id to reply AS (must be in MOLECULE_WORKSPACE_IDS). " +
    "Defaults to the workspace whose message Claude is responding to — " +
    "if there's only one watched workspace, omit this."
  ).optional(),
  peer_id: z.string().describe(
    "Workspace_id of the peer to send TO (for peer_agent inbound — " +
    "use notification meta.peer_id). Omit or pass empty string to reply " +
    "to the canvas user via /notify (for canvas_user inbound)."
  ).optional(),
  text: z.string().describe('Reply text. Plain text or markdown.'),
})

async function replyToWorkspace(args: z.infer<typeof ReplyArgsSchema>): Promise<string> {
  let { workspace_id } = args
  if (!workspace_id) {
    if (WORKSPACE_IDS.length === 1) workspace_id = WORKSPACE_IDS[0]
    else throw new Error(
      `workspace_id required when watching multiple workspaces. ` +
      `Watching: ${WORKSPACE_IDS.join(', ')}`
    )
  }
  const token = TOKEN_BY_WORKSPACE.get(workspace_id)
  if (!token) {
    throw new Error(
      `workspace_id ${workspace_id} is not in MOLECULE_WORKSPACE_IDS. ` +
      `Configured: ${WORKSPACE_IDS.join(', ')}`
    )
  }

  const peerId = args.peer_id?.trim() ?? ''
  if (!peerId) {
    // Canvas-user reply — POST /workspaces/:our/notify with {message: text}.
    // The platform appends to the user-facing chat panel; no JSON-RPC envelope
    // because there's no peer URL on the other side, just the canvas UI.
    const resp = await fetch(`${PLATFORM_URL}/workspaces/${workspace_id}/notify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Origin: PLATFORM_URL,
      },
      body: JSON.stringify({ message: args.text }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`notify failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
    }
    return `Replied to canvas user as ${workspace_id} via /notify.`
  }

  // Peer-agent A2A reply — proper JSON-RPC 2.0 envelope as the platform's
  // a2a_proxy expects. Empirically (verified 2026-04-29 against workspace-
  // server's ProxyA2A handler), shorthand `{parts:[...]}` gets accepted but
  // the platform strips params before forwarding to the peer's URL — the
  // peer then sees an envelope with `params: null` and no message text.
  // Wrapping in proper JSON-RPC preserves the message all the way through.
  //
  // `messageId` is generated client-side; the platform doesn't require it
  // but peers may use it for idempotency / dedup.
  const body = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'message/send',
    params: {
      message: {
        messageId: crypto.randomUUID(),
        parts: [{ type: 'text', text: args.text }],
      },
    },
  }
  const resp = await fetch(`${PLATFORM_URL}/workspaces/${peerId}/a2a`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Source-Workspace-Id': workspace_id,
      // Same-origin header for SaaS edge WAF — see pollWorkspace fetch
      // for the full explanation. /workspaces/* requires it on hosted
      // tenants; localhost ignores it.
      Origin: PLATFORM_URL,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`reply failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return `Reply sent from ${workspace_id} to ${peerId}.`
}

// ─── Universal-tool helpers ────────────────────────────────────────────
//
// Resolves "act AS which watched workspace" for tools that take an
// optional workspace_id distinguishing the channel-side caller from the
// target. When watching exactly one workspace it's an obvious default;
// for multi-watch, the caller must specify.

function resolveWatching(asWorkspaceId?: string): { workspaceId: string; token: string } {
  let workspaceId = asWorkspaceId
  if (!workspaceId) {
    if (WORKSPACE_IDS.length === 1) workspaceId = WORKSPACE_IDS[0]
    else throw new Error(
      `_as_workspace required when watching multiple workspaces. ` +
      `Watching: ${WORKSPACE_IDS.join(', ')}`
    )
  }
  const token = TOKEN_BY_WORKSPACE.get(workspaceId)
  if (!token) {
    throw new Error(
      `${workspaceId} is not in MOLECULE_WORKSPACE_IDS. ` +
      `Configured: ${WORKSPACE_IDS.join(', ')}`
    )
  }
  return { workspaceId, token }
}

// Standard auth headers shared by every platform call. Origin is required
// by the SaaS edge WAF — see pollWorkspace's fetch for the full story.
function platformHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Origin: PLATFORM_URL!,
    ...extra,
  }
}

// Tool: list_peers ------------------------------------------------------
//
// Returns the watched workspace's view of the team — siblings, children,
// parent — so Claude can answer "who are my peers?" without a separate
// HTTP detour. Mirrors the registry endpoint backed by GET /registry/:id/peers
// (workspace-server/internal/handlers/discovery.go:Peers).

const ListPeersArgsSchema = z.object({
  workspace_id: z.string().describe(
    "Watched workspace_id to query peers FOR. Omit if only one watched."
  ).optional(),
  q: z.string().describe(
    "Optional case-insensitive substring filter on peer name or role."
  ).optional(),
})

interface Peer {
  id: string
  name: string
  role: string | null
  tier: number | null
  status: string
  url: string
  parent_id: string | null
  active_tasks: number
  agent_card?: unknown
}

async function listPeers(args: z.infer<typeof ListPeersArgsSchema>): Promise<Peer[]> {
  let { workspace_id } = args
  if (!workspace_id) {
    if (WORKSPACE_IDS.length === 1) workspace_id = WORKSPACE_IDS[0]
    else throw new Error(
      `workspace_id required when watching multiple workspaces. ` +
      `Watching: ${WORKSPACE_IDS.join(', ')}`
    )
  }
  const token = TOKEN_BY_WORKSPACE.get(workspace_id)
  if (!token) {
    throw new Error(
      `workspace_id ${workspace_id} is not in MOLECULE_WORKSPACE_IDS. ` +
      `Configured: ${WORKSPACE_IDS.join(', ')}`
    )
  }
  const url = new URL(`${PLATFORM_URL}/registry/${workspace_id}/peers`)
  if (args.q) url.searchParams.set('q', args.q)
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: PLATFORM_URL,
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`list_peers failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return (await resp.json()) as Peer[]
}

// Tool: get_workspace_info ---------------------------------------------
//
// Mirrors the universal `get_workspace_info` tool — returns the watched
// workspace's own identity (id, name, role, tier, parent, status, agent_card).
// Backed by GET /workspaces/:id (workspace-server's WorkspaceHandler.Get).

const GetWorkspaceInfoArgsSchema = z.object({
  _as_workspace: z.string().describe(
    "Watched workspace_id to introspect (omit if only one watched)."
  ).optional(),
})

// Pure formatter — kept exportable so server.test.ts can pin the
// message shape without mocking fetch + resolveWatching just to read
// one string. molecule-core#2429.
export function formatRemovedWorkspaceError(
  workspaceId: string,
  body: { id?: string; removed_at?: string; hint?: string } | null | undefined,
): string {
  const safeBody = body ?? {}
  const id = safeBody.id ?? workspaceId
  const hint = safeBody.hint ?? 'Regenerate workspace + token from the canvas → Tokens tab.'
  const removed = safeBody.removed_at ? ` at ${safeBody.removed_at}` : ''
  return `Workspace ${id} was deleted on the platform${removed}. ${hint}`
}

async function getWorkspaceInfo(args: z.infer<typeof GetWorkspaceInfoArgsSchema>): Promise<unknown> {
  const { workspaceId, token } = resolveWatching(args._as_workspace)
  const resp = await fetch(`${PLATFORM_URL}/workspaces/${workspaceId}`, {
    headers: platformHeaders(token),
    signal: AbortSignal.timeout(15_000),
  })
  if (resp.status === 410) {
    // molecule-core#2429: platform returns 410 Gone when status='removed'.
    // Surface a clear "your workspace was deleted, re-onboard" error
    // instead of a generic HTTP error — without this branch the operator
    // sees `get_workspace_info failed: HTTP 410` and has to guess why.
    let body: { id?: string; removed_at?: string; hint?: string } = {}
    try {
      body = await resp.json() as typeof body
    } catch {
      // best-effort body parse; the error message stands alone
    }
    throw new Error(formatRemovedWorkspaceError(workspaceId, body))
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`get_workspace_info failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return resp.json()
}

// Tool: send_message_to_user -------------------------------------------
//
// Mirrors the universal `send_message_to_user` tool — POST /workspaces/:id/notify.
// Lands as a chat bubble in the canvas My Chat panel. The universal tool
// also supports `attachments` (file paths inside the workspace container)
// uploaded via /chat/uploads; this channel runs on the user's local FS and
// uploads from there. Same contract — paths are absolute on whichever side
// the tool runs from.

const SendMessageToUserArgsSchema = z.object({
  _as_workspace: z.string().describe(
    "Watched workspace_id to send AS (omit if only one watched)."
  ).optional(),
  message: z.string().describe(
    "Caption text for the chat bubble. Required even with attachments — " +
    "set to a short label like 'Here's the build:' or 'Done — see attached.'\n\n" +
    "DO NOT paste file URLs in this string. Files MUST go through `attachments` " +
    "so they render as a clickable download chip."
  ),
  attachments: z.array(z.string()).describe(
    "Absolute file paths on the user's local machine (e.g. ['/tmp/build.zip']). " +
    "Each gets uploaded via /chat/uploads and surfaces as a download chip in " +
    "the canvas. 25 MB per file cap."
  ).optional(),
})

async function sendMessageToUser(args: z.infer<typeof SendMessageToUserArgsSchema>): Promise<string> {
  const { workspaceId, token } = resolveWatching(args._as_workspace)
  let attachmentRefs: unknown[] = []
  if (args.attachments && args.attachments.length > 0) {
    // Multipart upload — same shape as workspace/a2a_tools.py:_upload_chat_files.
    // The platform stages files under /workspace/.molecule/chat-uploads (a
    // canvas "allowed root") and returns metadata the notify body references.
    const form = new FormData()
    for (const path of args.attachments) {
      const file = Bun.file(path)
      if (!(await file.exists())) {
        throw new Error(`attachment not found: ${path}`)
      }
      // Bun.file is a Blob; FormData accepts Blob with filename.
      form.append('files', file, path.split('/').pop() ?? 'attachment')
    }
    const upResp = await fetch(`${PLATFORM_URL}/workspaces/${workspaceId}/chat/uploads`, {
      method: 'POST',
      headers: platformHeaders(token),
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    if (!upResp.ok) {
      const errText = await upResp.text().catch(() => '')
      throw new Error(`chat/uploads failed: HTTP ${upResp.status} — ${errText.slice(0, 200)}`)
    }
    const upJson = (await upResp.json()) as { files?: unknown[] }
    attachmentRefs = upJson.files ?? []
  }
  const body: Record<string, unknown> = { message: args.message }
  if (attachmentRefs.length > 0) body.attachments = attachmentRefs
  const resp = await fetch(`${PLATFORM_URL}/workspaces/${workspaceId}/notify`, {
    method: 'POST',
    headers: platformHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`notify failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return `Sent to canvas user as ${workspaceId}${attachmentRefs.length > 0 ? ` with ${attachmentRefs.length} attachment(s)` : ''}.`
}

// Tool: delegate_task (sync) -------------------------------------------
//
// Mirrors the universal `delegate_task` tool — sends an A2A message to a
// peer and waits inline for the response. POSTs to /workspaces/:peer/a2a;
// the platform's a2a_proxy forwards to the peer's URL and returns the
// peer's reply body. Use for QUICK questions; for long-running work use
// delegate_task_async + check_task_status.

const DelegateTaskArgsSchema = z.object({
  _as_workspace: z.string().describe(
    "Watched workspace_id to send AS (omit if only one watched)."
  ).optional(),
  workspace_id: z.string().describe("Target peer workspace ID (from list_peers)."),
  task: z.string().describe("Task description to send to the peer."),
})

async function delegateTask(args: z.infer<typeof DelegateTaskArgsSchema>): Promise<unknown> {
  const { workspaceId, token } = resolveWatching(args._as_workspace)
  if (!args.workspace_id) throw new Error('workspace_id (target peer) is required')
  if (!args.task) throw new Error('task is required')
  const body = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'message/send',
    params: {
      message: {
        messageId: crypto.randomUUID(),
        parts: [{ type: 'text', text: args.task }],
      },
    },
  }
  // 60s timeout because sync delegation waits for the peer to actually
  // produce a response. Long-running peer work should use the async path.
  const resp = await fetch(`${PLATFORM_URL}/workspaces/${args.workspace_id}/a2a`, {
    method: 'POST',
    headers: platformHeaders(token, {
      'Content-Type': 'application/json',
      'X-Source-Workspace-Id': workspaceId,
    }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`delegate_task failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return resp.json()
}

// Tool: delegate_task_async --------------------------------------------
//
// Mirrors the universal `delegate_task_async` tool — POST /workspaces/:self/delegate
// with target_id + task + idempotency_key. Returns 202 with delegation_id;
// the platform runs the A2A round-trip in the background and stores the
// result in the delegations table. Poll via check_task_status.

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

const DelegateTaskAsyncArgsSchema = DelegateTaskArgsSchema

async function delegateTaskAsync(args: z.infer<typeof DelegateTaskAsyncArgsSchema>): Promise<unknown> {
  const { workspaceId, token } = resolveWatching(args._as_workspace)
  if (!args.workspace_id) throw new Error('workspace_id (target peer) is required')
  if (!args.task) throw new Error('task is required')
  // Idempotency key: SHA-256 of (target, task) so a restart firing the same
  // delegation gets the existing delegation_id back instead of creating a
  // duplicate (mirrors workspace/a2a_tools.py — fixes #1456 there).
  const idem = (await sha256Hex(`${args.workspace_id}:${args.task}`)).slice(0, 32)
  const resp = await fetch(`${PLATFORM_URL}/workspaces/${workspaceId}/delegate`, {
    method: 'POST',
    headers: platformHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      target_id: args.workspace_id,
      task: args.task,
      idempotency_key: idem,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (resp.status !== 202 && !resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`delegate_task_async failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return resp.json()
}

// Tool: check_task_status ----------------------------------------------
//
// Mirrors the universal `check_task_status` tool — GET /workspaces/:self/delegations,
// optionally filtered by delegation_id. Returns peer-reply summary + status
// (pending / in_progress / queued / completed / failed).

const CheckTaskStatusArgsSchema = z.object({
  _as_workspace: z.string().describe(
    "Watched workspace_id whose delegations to inspect (omit if only one watched)."
  ).optional(),
  task_id: z.string().describe(
    "delegation_id returned by delegate_task_async. Omit to list recent delegations."
  ).optional(),
})

async function checkTaskStatus(args: z.infer<typeof CheckTaskStatusArgsSchema>): Promise<unknown> {
  const { workspaceId, token } = resolveWatching(args._as_workspace)
  const resp = await fetch(`${PLATFORM_URL}/workspaces/${workspaceId}/delegations`, {
    headers: platformHeaders(token),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`check_task_status failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  const all = (await resp.json()) as Array<{ delegation_id?: string }>
  if (args.task_id) {
    const match = all.find(d => d.delegation_id === args.task_id)
    return match ?? { status: 'not_found', delegation_id: args.task_id }
  }
  return { delegations: all.slice(0, 10), count: all.length }
}

// Tool: commit_memory --------------------------------------------------
//
// Mirrors the universal `commit_memory` tool — POST /workspaces/:self/memories.
// Persists across sessions. RBAC + scope (LOCAL/TEAM/GLOBAL) enforcement
// is platform-side; this tool just plumbs the call.

const CommitMemoryArgsSchema = z.object({
  _as_workspace: z.string().describe(
    "Watched workspace_id to commit AS (omit if only one watched)."
  ).optional(),
  content: z.string().describe("What to remember — be specific."),
  scope: z.enum(['LOCAL', 'TEAM', 'GLOBAL']).describe(
    "Memory scope (default LOCAL)."
  ).optional(),
})

async function commitMemory(args: z.infer<typeof CommitMemoryArgsSchema>): Promise<unknown> {
  const { workspaceId, token } = resolveWatching(args._as_workspace)
  if (!args.content) throw new Error('content is required')
  const resp = await fetch(`${PLATFORM_URL}/workspaces/${workspaceId}/memories`, {
    method: 'POST',
    headers: platformHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      content: args.content,
      scope: (args.scope ?? 'LOCAL').toUpperCase(),
      // Platform cross-validates this against the bearer for namespace
      // isolation (workspace-server fix for GH#1610).
      workspace_id: workspaceId,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`commit_memory failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return resp.json()
}

// Tool: recall_memory --------------------------------------------------
//
// Mirrors the universal `recall_memory` tool — GET /workspaces/:self/memories.
// Returns rows accessible by scope; empty query returns all accessible.

const RecallMemoryArgsSchema = z.object({
  _as_workspace: z.string().describe(
    "Watched workspace_id to recall FROM (omit if only one watched)."
  ).optional(),
  query: z.string().describe("Search query (empty returns all).").optional(),
  scope: z.enum(['LOCAL', 'TEAM', 'GLOBAL', '']).describe(
    "Filter by scope (empty = all accessible)."
  ).optional(),
})

async function recallMemory(args: z.infer<typeof RecallMemoryArgsSchema>): Promise<unknown> {
  const { workspaceId, token } = resolveWatching(args._as_workspace)
  const url = new URL(`${PLATFORM_URL}/workspaces/${workspaceId}/memories`)
  url.searchParams.set('workspace_id', workspaceId)
  if (args.query) url.searchParams.set('q', args.query)
  if (args.scope) url.searchParams.set('scope', args.scope.toUpperCase())
  const resp = await fetch(url, {
    headers: platformHeaders(token),
    signal: AbortSignal.timeout(15_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`recall_memory failed: HTTP ${resp.status} — ${errText.slice(0, 200)}`)
  }
  return resp.json()
}

// The tool surface mirrors workspace/platform_tools/registry.py — same
// names, same input shapes, same semantics — so an external agent driven
// through this channel has parity with an in-container agent driven by the
// universal MCP. The one channel-specific addition is `_as_workspace`,
// which disambiguates which watched workspace the tool acts AS when this
// MCP is configured to watch more than one. Underscore-prefixed so it
// can't collide with the universal contract.

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply_to_workspace',
      description:
        'Reply to whoever sent the most recent inbound message. Pass peer_id ' +
        'from notification meta.peer_id for peer_agent inbound (routes via /a2a); ' +
        'omit peer_id (or pass empty string) for canvas_user inbound (routes via ' +
        '/notify into the My Chat panel). Check meta.kind on the notification to ' +
        'pick the right form.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'Watched workspace_id to reply as (omit if only one watched).' },
          peer_id: {
            type: 'string',
            description:
              'Workspace_id of the peer to A2A-reply to (from notification meta.peer_id). ' +
              'Omit or pass empty string to /notify the canvas user instead.',
          },
          text: { type: 'string', description: 'Reply text (plain text or markdown).' },
        },
        required: ['text'],
      },
    },
    {
      name: 'delegate_task',
      description:
        'Delegate a task to a peer workspace via A2A and WAIT for the response (synchronous). ' +
        'Use for QUICK questions and small sub-tasks; for long-running work use ' +
        'delegate_task_async + check_task_status so this session does not block.',
      inputSchema: {
        type: 'object',
        properties: {
          _as_workspace: { type: 'string', description: 'Watched workspace_id to send AS (omit if only one watched).' },
          workspace_id: { type: 'string', description: 'Target peer workspace ID (from list_peers).' },
          task: { type: 'string', description: 'Task description to send to the peer.' },
        },
        required: ['workspace_id', 'task'],
      },
    },
    {
      name: 'delegate_task_async',
      description:
        'Send a task to a peer and return immediately with a task_id (non-blocking). ' +
        'Poll with check_task_status. The platform A2A queue handles delivery + retries.',
      inputSchema: {
        type: 'object',
        properties: {
          _as_workspace: { type: 'string', description: 'Watched workspace_id to send AS (omit if only one watched).' },
          workspace_id: { type: 'string', description: 'Target peer workspace ID (from list_peers).' },
          task: { type: 'string', description: 'Task description to send to the peer.' },
        },
        required: ['workspace_id', 'task'],
      },
    },
    {
      name: 'check_task_status',
      description:
        'Poll the status of a task started with delegate_task_async; returns the result when done. ' +
        'Statuses: pending/in_progress (peer working — wait), queued (peer busy with prior task — ' +
        'do NOT retry), completed (result available), failed (real error).',
      inputSchema: {
        type: 'object',
        properties: {
          _as_workspace: { type: 'string', description: 'Watched workspace_id whose delegations to inspect (omit if only one watched).' },
          task_id: { type: 'string', description: 'task_id (delegation_id) returned by delegate_task_async. Omit to list recent.' },
        },
      },
    },
    {
      name: 'list_peers',
      description:
        'List the watched workspace\'s peer agents (siblings, children, parent) as registered ' +
        'in the canvas. Use first when you need to delegate but don\'t know the target\'s ID. ' +
        'Access control is enforced — you only see peers your workspace can reach.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'Watched workspace_id to query peers for (omit if only one watched).' },
          q: { type: 'string', description: 'Optional case-insensitive substring filter on peer name or role.' },
        },
      },
    },
    {
      name: 'get_workspace_info',
      description:
        'Get the watched workspace\'s own info — id, name, role, tier, parent, status, agent_card. ' +
        'Use to introspect identity (e.g. before reporting back to the user, or to determine if ' +
        'this is a tier-0 root that can write GLOBAL memory).',
      inputSchema: {
        type: 'object',
        properties: {
          _as_workspace: { type: 'string', description: 'Watched workspace_id to introspect (omit if only one watched).' },
        },
      },
    },
    {
      name: 'send_message_to_user',
      description:
        'Send a message to the user\'s canvas chat — pushed instantly via WebSocket. Use to ' +
        '(1) acknowledge a task immediately, (2) post mid-flight progress updates, (3) deliver ' +
        'follow-up results, (4) attach files via the `attachments` field. NEVER paste file URLs ' +
        'in `message`; always pass absolute paths in `attachments` so the platform serves them ' +
        'as download chips (works on SaaS where external file hosts are unreachable).',
      inputSchema: {
        type: 'object',
        properties: {
          _as_workspace: { type: 'string', description: 'Watched workspace_id to send AS (omit if only one watched).' },
          message: { type: 'string', description: 'Caption text for the chat bubble. Required even with attachments.' },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute file paths on the user\'s local machine. Each is uploaded via /chat/uploads and surfaces as a download chip. 25 MB cap per file.',
          },
        },
        required: ['message'],
      },
    },
    {
      name: 'commit_memory',
      description:
        'Save a fact to persistent memory; survives across sessions and restarts. ' +
        'Scopes: LOCAL (private to this workspace), TEAM (shared with parent + siblings), ' +
        'GLOBAL (entire org — only tier-0 roots can write).',
      inputSchema: {
        type: 'object',
        properties: {
          _as_workspace: { type: 'string', description: 'Watched workspace_id to commit AS (omit if only one watched).' },
          content: { type: 'string', description: 'What to remember — be specific.' },
          scope: { type: 'string', enum: ['LOCAL', 'TEAM', 'GLOBAL'], description: 'Memory scope (default LOCAL).' },
        },
        required: ['content'],
      },
    },
    {
      name: 'recall_memory',
      description:
        'Search persistent memory; returns matching LOCAL + TEAM + GLOBAL rows. ' +
        'Empty query returns ALL accessible memories — cheap and avoids missing rows that ' +
        'don\'t match a narrow keyword.',
      inputSchema: {
        type: 'object',
        properties: {
          _as_workspace: { type: 'string', description: 'Watched workspace_id to recall FROM (omit if only one watched).' },
          query: { type: 'string', description: 'Search query (empty returns all).' },
          scope: { type: 'string', enum: ['LOCAL', 'TEAM', 'GLOBAL', ''], description: 'Filter by scope (empty = all accessible).' },
        },
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = req.params.arguments ?? {}
  switch (req.params.name) {
    case 'reply_to_workspace': {
      const result = await replyToWorkspace(ReplyArgsSchema.parse(args))
      return { content: [{ type: 'text', text: result }] }
    }
    case 'delegate_task': {
      const result = await delegateTask(DelegateTaskArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
    case 'delegate_task_async': {
      const result = await delegateTaskAsync(DelegateTaskAsyncArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
    case 'check_task_status': {
      const result = await checkTaskStatus(CheckTaskStatusArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
    case 'list_peers': {
      const peers = await listPeers(ListPeersArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(peers, null, 2) }] }
    }
    case 'get_workspace_info': {
      const info = await getWorkspaceInfo(GetWorkspaceInfoArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] }
    }
    case 'send_message_to_user': {
      const result = await sendMessageToUser(SendMessageToUserArgsSchema.parse(args))
      return { content: [{ type: 'text', text: result }] }
    }
    case 'commit_memory': {
      const result = await commitMemory(CommitMemoryArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
    case 'recall_memory': {
      const result = await recallMemory(RecallMemoryArgsSchema.parse(args))
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`)
  }
})

// ─── Boot ───────────────────────────────────────────────────────────────

loadCursors()

// Compat probe FIRST — before we open the MCP transport or self-register
// any workspaces. v0.2.1 had this probe AFTER mcp.connect+registerAsPoll,
// which had two bugs:
//   1. mcp.connect already finished the initialize handshake, so a
//      probe-failure exit looked like "MCP server crashed mid-session"
//      to Claude Code (which swallows the stderr explanation) instead of
//      the cleaner "server failed to start" with the upgrade message.
//   2. registerAsPoll() may have already mutated the platform's
//      delivery_mode for a workspace whose workspace-server can't honor
//      poll, leaving the workspace in a broken state if we then exit.
// Probing first is purely a startup-ordering fix; the probe semantics
// (410 → ok, 200 → too_old, anything else → inconclusive) are unchanged.
//
// Probes run in parallel (allSettled) — sequentially they were N × 15s
// at worst, which adds up for multi-workspace channels. Order doesn't
// matter for the verdict; we only care if any one came back too_old.
{
  const results = await Promise.allSettled(
    WORKSPACE_IDS.map(id => probeCursorSupport(id).then(r => ({ id, r }))),
  )
  let anyTooOld = false
  for (const settled of results) {
    if (settled.status !== 'fulfilled') continue
    const { id, r } = settled.value
    if (r === 'too_old') {
      anyTooOld = true
      process.stderr.write(
        `molecule channel: workspace ${id} on a platform that predates ` +
        `since_id cursor support (Molecule-AI/molecule-core PR #2354).\n` +
        `  Symptom would be: every poll re-delivers all recent activity as if it were new.\n` +
        `  Fix: upgrade workspace-server to a build with /activity ?since_id=… support.\n`
      )
    }
  }
  if (anyTooOld) {
    process.stderr.write(
      `molecule channel: refusing to start in poll mode against an older platform. ` +
      `Pin MOLECULE_PLATFORM_URL to an upgraded tenant or downgrade to plugin v0.1.\n`
    )
    // exit triggers the 'exit' listener, which unlinks the PID file.
    process.exit(2)
  }
}

const transport = new StdioServerTransport()
await mcp.connect(transport)

// Self-register each workspace as poll-mode BEFORE the first poll fires.
// Sequenced (not Promise.all) so failures are surfaced one at a time and
// the operator can spot which workspace's token is bad.
if (AUTO_REGISTER_POLL) {
  for (const id of WORKSPACE_IDS) {
    await registerAsPoll(id)
  }
}

process.stderr.write(
  `molecule channel: connected — watching ${WORKSPACE_IDS.length} workspace(s) at ${PLATFORM_URL}\n` +
  `  workspaces: ${WORKSPACE_IDS.join(', ')}\n` +
  `  delivery_mode=poll  cursor=${CURSOR_FILE}  auto_register=${AUTO_REGISTER_POLL}\n` +
  `  poll: every ${POLL_INTERVAL_MS}ms (cursor-based; ${POLL_WINDOW_SECS}s window only used for first-run seed)\n` +
  `  heartbeat: ` +
    (HEARTBEAT_INTERVAL_MS > 0
      ? `every ${HEARTBEAT_INTERVAL_MS}ms (POST /registry/heartbeat — keeps canvas presence on 'online')\n`
      : `disabled (MOLECULE_HEARTBEAT_INTERVAL_MS=0; canvas will flip to 'awaiting_agent' after 90s)\n`)
)

// Stagger initial polls slightly so N-workspace watchers don't all hit the
// platform at the same instant on every tick.
WORKSPACE_IDS.forEach((id, i) => {
  setTimeout(() => {
    void pollWorkspace(id, mcp)
    setInterval(() => void pollWorkspace(id, mcp), POLL_INTERVAL_MS).unref()
  }, i * 500)
})

// Per-workspace heartbeat ticker — closes #6 / molecule-core#24.
//
// The startup `registerAsPoll` upsert already bumped `last_heartbeat_at`
// on each row, so the workspace is "online" from boot. The first heartbeat
// fires after one full HEARTBEAT_INTERVAL_MS so we don't double-pump on
// startup; subsequent ticks keep the row fresh inside the 90s stale
// window enforced by workspace-server's healthsweep.
//
// Stagger by i * 500ms so N-workspace plugins don't fan-spike the
// platform — same shape as the poll-loop staggering above.
//
// Conditional on HEARTBEAT_INTERVAL_MS > 0 so tests / unusual deploys
// can disable the loop without hacking around the ticker. .unref() so
// the heartbeat doesn't keep the event loop alive at shutdown.
//
// `sendHeartbeat` is imported from ./heartbeat.ts — see that file for
// the full presence-bug rationale + wire-shape contract.
if (HEARTBEAT_INTERVAL_MS > 0) {
  WORKSPACE_IDS.forEach((id, i) => {
    setTimeout(() => {
      setInterval(
        () => void sendHeartbeat({
          platformUrl: PLATFORM_URL,
          workspaceId: id,
          token: TOKEN_BY_WORKSPACE.get(id)!,
        }),
        HEARTBEAT_INTERVAL_MS,
      ).unref()
    }, i * 500)
  })
}

// Clean shutdown — fire-and-forget a "disconnected" notice on each watched
// workspace's A2A so peers don't sit waiting on a silent channel.
const shutdown = (sig: string) => {
  process.stderr.write(`molecule channel: ${sig} — shutting down\n`)
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
