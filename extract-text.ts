// extractText — pull human-readable text out of a platform activity row's
// request_body. Lives in its own module so the unit test can import it
// without triggering server.ts's top-level boot side-effects (cursor
// load, MCP transport connect, poll loop).
//
// Shape & semantics: see the call site in server.ts and the
// long-form comment there. This file just owns the function.

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

export function extractText(act: ActivityEntry): string {
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
  // Part discriminator: a2a-sdk v0 used `type`, v1 (current) uses
  // `kind`. Real platform peers send `kind === 'text'`, so dropping
  // v1-shaped parts silently masks every inbound message. Accept both
  // — see workspace/inbox.py:_extract_text for the same v0/v1 fix on
  // the universal-MCP path. Reproduced live on hongmingwang tenant
  // 2026-04-30: messages from canvas peers were arriving but extractText
  // returned only act.summary because every part had `kind` not `type`.
  const body = act.request_body as {
    parts?: Array<{ type?: string; kind?: string; text?: string }>
    params?: {
      message?: { parts?: Array<{ type?: string; kind?: string; text?: string }> }
      parts?: Array<{ type?: string; kind?: string; text?: string }>
    }
  } | undefined

  const candidates = [
    body?.params?.message?.parts,  // shape 1 — JSON-RPC w/ message wrapper
    body?.params?.parts,           // shape 2 — JSON-RPC params.parts
    body?.parts,                   // shape 3 — shorthand
  ]
  for (const parts of candidates) {
    if (Array.isArray(parts)) {
      const text = parts
        .filter(p => p.kind === 'text' || p.type === 'text')
        .map(p => p.text ?? '')
        .join('')
      if (text) return text
    }
  }
  return act.summary ?? '(empty A2A message)'
}
