// Pure functions extracted from server.ts so they're unit-testable in
// isolation from the MCP server lifecycle. server.ts re-exports these
// (well, imports + uses them); tests import directly.
//
// Keep this file dependency-free (no MCP SDK, no fs, no fetch) — that's
// what makes it testable. Anything that talks to a real platform or
// stdin/stdout belongs in server.ts.

export interface ActivityEntry {
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

export interface ExtractTextResult {
  text: string
  /** Number of non-text parts that were dropped — used by callers to
   *  surface a stderr warning. Telegram-style image_path delivery is
   *  v0.2 work; for now we want loud-when-something-was-skipped behavior
   *  rather than silent fall-through to summary. */
  nonTextSkipped: number
}

/**
 * Extract the user-visible text from an a2a_receive activity row.
 *
 * Walks request_body in three known shapes (verified empirically against
 * workspace-server's a2a_proxy on 2026-04-29):
 *   1. JSON-RPC envelope w/ message wrapper:  body.params.message.parts[]
 *   2. JSON-RPC envelope w/ params.parts:     body.params.parts[]
 *   3. Shorthand body:                        body.parts[]
 *
 * Falls back to act.summary when no recognised shape contains text — peer
 * messages should NEVER silently disappear; if all else fails, surface
 * the auto-generated summary so Claude at least sees that *something*
 * arrived.
 *
 * Returns both the extracted text AND a count of skipped non-text parts.
 * The caller (notification emit path) logs nonTextSkipped to stderr so
 * image-only messages don't fall silently into the summary fallback.
 */
export function extractText(act: ActivityEntry): ExtractTextResult {
  const body = act.request_body as {
    parts?: Array<{ type?: string; text?: string }>
    params?: {
      message?: { parts?: Array<{ type?: string; text?: string }> }
      parts?: Array<{ type?: string; text?: string }>
    }
  } | undefined

  const candidates = [
    body?.params?.message?.parts,  // shape 1
    body?.params?.parts,           // shape 2
    body?.parts,                   // shape 3
  ]

  let nonTextSkipped = 0
  for (const parts of candidates) {
    if (!Array.isArray(parts)) continue
    nonTextSkipped += parts.filter(p => p.type && p.type !== 'text').length
    const text = parts
      .filter(p => p.type === 'text')
      .map(p => p.text ?? '')
      .join('')
    if (text) return { text, nonTextSkipped }
  }
  return { text: act.summary ?? '(empty A2A message)', nonTextSkipped }
}

/**
 * Build the JSON-RPC 2.0 envelope sent to /workspaces/:peer_id/a2a.
 *
 * The platform's a2a_proxy expects proper JSON-RPC; shorthand bodies get
 * accepted by the proxy but stripped before forwarding to the peer's URL,
 * so the peer receives `params: null` and no message text. This was the
 * outbound-half of the bug fixed in PR #1.
 *
 * `messageId` is generated client-side; the platform doesn't require it
 * but peers may use it for idempotency / dedup. Random hex matches the
 * a2a-sdk convention.
 */
export interface ReplyBody {
  jsonrpc: '2.0'
  id: string
  method: 'message/send'
  params: {
    message: {
      messageId: string
      parts: Array<{ type: 'text'; text: string }>
    }
  }
}

export function buildReplyBody(text: string, idGen: () => string = randomId): ReplyBody {
  return {
    jsonrpc: '2.0',
    id: idGen(),
    method: 'message/send',
    params: {
      message: {
        messageId: idGen(),
        parts: [{ type: 'text', text }],
      },
    },
  }
}

function randomId(): string {
  // crypto.randomUUID is available on the bun runtime via globalThis.crypto
  // (Web Crypto API). Tests inject a deterministic generator so the body
  // shape is comparable against fixtures.
  return crypto.randomUUID()
}
