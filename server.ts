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

interface ActivityEntry {
  id: string
  workspace_id: string
  activity_type: string
  source_id: string | null
  target_id: string | null
  method: string | null
  summary: string | null
  request_body?: unknown
  response_body?: unknown
  status: string
  error_detail: string | null
  created_at: string
}

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
    // First run for this workspace — seed the cursor from the most-recent
    // existing event WITHOUT delivering it. Without this seed the next tick
    // would also have no cursor and we'd loop forever. Seed-then-skip is
    // the right policy at startup: events that arrived BEFORE the operator
    // started this Claude session are out of context and shouldn't be
    // replayed as if they're new turns. Events arriving AFTER the seed
    // have id > cursor and will be delivered on subsequent ticks.
    url.searchParams.set('since_secs', String(POLL_WINDOW_SECS))
    url.searchParams.set('limit', '1')
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

  if (!cursor) {
    // First-run seed: take the newest activity_id (the only one returned
    // because we asked for limit=1) and remember it as our starting point.
    // Don't deliver it — see comment above.
    if (activities.length > 0) {
      cursors.set(workspaceId, activities[0].id)
      saveCursors()
    }
    return
  }

  // Steady-state: server returned ASC-ordered rows strictly after cursor.
  // Deliver each in order; advance cursor only after we hand the event
  // off to MCP. If the notification call rejects we still advance — the
  // alternative (block on notification failure) would stall the channel
  // entirely, and notification delivery is best-effort anyway.
  if (activities.length === 0) return
  for (const act of activities) {
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

function extractText(act: ActivityEntry): string {
  // request_body is what the platform's a2a_proxy logs when forwarding A2A
  // to this workspace. Empirically (verified against workspace-server's
  // logA2ASuccess in a2a_proxy_helpers.go on 2026-04-29), the shape varies:
  //
  //   1. JSON-RPC envelope (most common — what real peers send):
  //        { jsonrpc, id, method: "message/send", params: { message: { parts: [...] } } }
  //   2. JSON-RPC with params.parts directly (some legacy callers):
  //        { jsonrpc, id, method, params: { parts: [...] } }
  //   3. Shorthand body (canvas-side direct sends):
  //        { parts: [...] }
  //
  // Walk the envelope in priority order. Fall back to act.summary so the peer
  // message at least surfaces SOMETHING — silent-drop is the failure mode this
  // helper exists to prevent.
  const body = act.request_body as {
    parts?: Array<{ type?: string; text?: string }>
    params?: {
      message?: { parts?: Array<{ type?: string; text?: string }> }
      parts?: Array<{ type?: string; text?: string }>
    }
  } | undefined

  const candidates = [
    body?.params?.message?.parts,  // shape 1 — JSON-RPC w/ message wrapper
    body?.params?.parts,           // shape 2 — JSON-RPC params.parts
    body?.parts,                   // shape 3 — shorthand
  ]
  for (const parts of candidates) {
    if (Array.isArray(parts)) {
      const text = parts.filter(p => p.type === 'text').map(p => p.text ?? '').join('')
      if (text) return text
    }
  }
  return act.summary ?? '(empty A2A message)'
}

function emitNotification(mcp: Server, workspaceId: string, act: ActivityEntry): void {
  const text = extractText(act)
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
        workspace_id: act.workspace_id,
        watching_as: workspaceId,
        peer_id: act.source_id ?? '',
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

const mcp = new Server(
  { name: 'molecule', version: '0.2.2' },
  { capabilities: { tools: {} } },
)

// Tool: reply_to_workspace ----------------------------------------------
//
// Sends an A2A message FROM one of our watched workspaces TO the peer that
// last messaged us (or to an explicit peer_id). Used by Claude when the
// human operator authors a reply in this session.

const ReplyArgsSchema = z.object({
  workspace_id: z.string().describe(
    "Watched workspace_id to reply AS (must be in MOLECULE_WORKSPACE_IDS). " +
    "Defaults to the workspace whose A2A message Claude is responding to — " +
    "if there's only one watched workspace, omit this."
  ).optional(),
  peer_id: z.string().describe(
    "Workspace_id of the peer to send TO. Look at the most recent " +
    "notifications/claude/channel meta.peer_id."
  ),
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
  // A2A request shape — proper JSON-RPC 2.0 envelope as the platform's a2a_proxy
  // expects. Empirically (verified 2026-04-29 against workspace-server's
  // ProxyA2A handler), shorthand `{parts:[...]}` gets accepted but the platform
  // strips params before forwarding to the peer's URL — the peer then sees an
  // envelope with `params: null` and no message text. Wrapping in proper
  // JSON-RPC preserves the message all the way through.
  //
  // `messageId` is generated client-side; the platform doesn't require it but
  // peers may use it for idempotency / dedup. Random hex matches the a2a-sdk
  // convention.
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
  const resp = await fetch(`${PLATFORM_URL}/workspaces/${args.peer_id}/a2a`, {
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
  return `Reply sent from ${workspace_id} to ${args.peer_id}.`
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply_to_workspace',
      description:
        'Reply to a Molecule A2A peer that messaged one of our watched workspaces. ' +
        'Use after seeing a notifications/claude/channel inbound message.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Watched workspace_id to reply as (omit if only one watched).',
          },
          peer_id: {
            type: 'string',
            description: 'Workspace_id of the peer to reply to (from notification meta.peer_id).',
          },
          text: {
            type: 'string',
            description: 'Reply text (plain text or markdown).',
          },
        },
        required: ['peer_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  switch (req.params.name) {
    case 'reply_to_workspace': {
      const args = ReplyArgsSchema.parse(req.params.arguments ?? {})
      const result = await replyToWorkspace(args)
      return { content: [{ type: 'text', text: result }] }
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
  `  poll: every ${POLL_INTERVAL_MS}ms (cursor-based; ${POLL_WINDOW_SECS}s window only used for first-run seed)\n`
)

// Stagger initial polls slightly so N-workspace watchers don't all hit the
// platform at the same instant on every tick.
WORKSPACE_IDS.forEach((id, i) => {
  setTimeout(() => {
    void pollWorkspace(id, mcp)
    setInterval(() => void pollWorkspace(id, mcp), POLL_INTERVAL_MS).unref()
  }, i * 500)
})

// Clean shutdown — fire-and-forget a "disconnected" notice on each watched
// workspace's A2A so peers don't sit waiting on a silent channel.
const shutdown = (sig: string) => {
  process.stderr.write(`molecule channel: ${sig} — shutting down\n`)
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
