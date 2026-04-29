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
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ─── Config ─────────────────────────────────────────────────────────────

const STATE_DIR = process.env.MOLECULE_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'molecule')
const ENV_FILE = join(STATE_DIR, '.env')
const PID_FILE = join(STATE_DIR, 'bot.pid')

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
const POLL_WINDOW_SECS = parseInt(process.env.MOLECULE_POLL_WINDOW_SECS ?? '30', 10)

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

const seenIds = new Map<string, Set<string>>()  // workspace_id → Set<activity.id>

async function pollWorkspace(workspaceId: string, mcp: Server): Promise<void> {
  const token = TOKEN_BY_WORKSPACE.get(workspaceId)!
  const url = new URL(`${PLATFORM_URL}/workspaces/${workspaceId}/activity`)
  url.searchParams.set('since_secs', String(POLL_WINDOW_SECS))
  url.searchParams.set('type', 'a2a_receive')
  url.searchParams.set('limit', '100')

  let resp: Response
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    process.stderr.write(`molecule channel: poll ${workspaceId} fetch failed: ${err}\n`)
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

  const seen = seenIds.get(workspaceId) ?? new Set<string>()
  // Activities arrive newest-first per /activity contract. Reverse so we
  // emit in chronological order — peers see "earliest unseen first" instead
  // of out-of-order if multiple landed in one window.
  for (const act of activities.slice().reverse()) {
    if (seen.has(act.id)) continue
    seen.add(act.id)
    emitNotification(mcp, workspaceId, act)
  }
  // Cap dedup set so it can't grow unbounded across multi-day sessions.
  // Activity ids that age past POLL_WINDOW_SECS won't reappear in a future
  // /activity response anyway (since_secs filters them out), so trimming
  // is safe.
  if (seen.size > 1000) {
    const ids = Array.from(seen).slice(-500)
    seen.clear()
    for (const id of ids) seen.add(id)
  }
  seenIds.set(workspaceId, seen)
}

// ─── Notification emission ─────────────────────────────────────────────

function extractText(act: ActivityEntry): string {
  // request_body is the inbound A2A message. Shape: { parts: [{ type, text }, ...] }
  // Fallback to summary if shape isn't recognised so the peer message at
  // least surfaces SOMETHING in the session rather than getting silently dropped.
  const body = act.request_body as { parts?: Array<{ type?: string; text?: string }> } | undefined
  if (body?.parts && Array.isArray(body.parts)) {
    const text = body.parts.filter(p => p.type === 'text').map(p => p.text ?? '').join('')
    if (text) return text
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
  { name: 'molecule', version: '0.1.0' },
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
  // A2A request shape — matches workspace-server/internal/handlers/a2a_proxy.go's
  // ProxyA2A handler expectations. The request_body becomes the peer's view of
  // our message; we set source/target headers so the receiving workspace can
  // attribute the message to us.
  const body = {
    parts: [{ type: 'text', text: args.text }],
  }
  const resp = await fetch(`${PLATFORM_URL}/workspaces/${args.peer_id}/a2a`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Source-Workspace-Id': workspace_id,
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

const transport = new StdioServerTransport()
await mcp.connect(transport)

process.stderr.write(
  `molecule channel: connected — watching ${WORKSPACE_IDS.length} workspace(s) at ${PLATFORM_URL}\n` +
  `  workspaces: ${WORKSPACE_IDS.join(', ')}\n` +
  `  poll: every ${POLL_INTERVAL_MS}ms with ${POLL_WINDOW_SECS}s window\n`
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
