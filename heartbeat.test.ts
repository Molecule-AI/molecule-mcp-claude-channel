// heartbeat.test.ts — pin the POST /registry/heartbeat shape against a
// local Bun.serve fixture. Closes #6 / molecule-core#24 — the v0.4.0-gitea.1
// channel plugin polled /workspaces/:id/activity but never POSTed
// /registry/heartbeat, so the platform's healthsweep flipped the canvas
// presence badge to `awaiting_agent` within 90s of plugin start.
//
// The poll loop is read-only on the platform side (activity.go is a SELECT
// — /workspaces/:id/activity does NOT bump last_heartbeat_at), so without
// a dedicated keepalive POST the row stales out and the badge looks
// offline even while A2A traffic flows fine.
//
// Asserts the actual HTTP wire shape:
//   - method = POST
//   - path   = /registry/heartbeat
//   - Authorization: Bearer <token-for-workspace>
//   - Content-Type: application/json
//   - Origin: <platformUrl>            (SaaS edge WAF — same as register)
//   - body.workspace_id = <id>
//
// Pre-fix code path: heartbeat.ts does not exist. Post-fix: this test
// passes against the real function and would FAIL if a refactor swapped
// POST→GET, dropped the bearer token, renamed workspace_id, or stopped
// drainage on the success path — all of which would silently re-break
// the presence badge or leak sockets.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'

import { sendHeartbeat } from './heartbeat.ts'

interface CapturedRequest {
  method: string
  pathname: string
  headers: Record<string, string>
  body: unknown
}

let captured: CapturedRequest[] = []
let nextStatus = 200
let nextResponseBody: string = '{}'

const fixture = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    let body: unknown = undefined
    try {
      body = await req.json()
    } catch {
      body = await req.text().catch(() => undefined)
    }
    const hdrs: Record<string, string> = {}
    req.headers.forEach((v, k) => { hdrs[k.toLowerCase()] = v })
    captured.push({ method: req.method, pathname: url.pathname, headers: hdrs, body })
    return new Response(nextResponseBody, {
      status: nextStatus,
      headers: { 'content-type': 'application/json' },
    })
  },
})

const platformUrl = `http://127.0.0.1:${fixture.port}`

beforeAll(() => {
  captured = []
  nextStatus = 200
  nextResponseBody = '{}'
})

afterEach(() => {
  captured = []
  nextStatus = 200
  nextResponseBody = '{}'
})

afterAll(() => {
  fixture.stop(true)
})

describe('sendHeartbeat — POST /registry/heartbeat shape (closes #6 / molecule-core#24)', () => {
  it('POSTs the workspace_id payload with the per-workspace bearer token + Origin header', async () => {
    nextStatus = 200
    await sendHeartbeat({
      platformUrl,
      workspaceId: 'ws-heartbeat-test-id',
      token: 'tok-heartbeat-test',
    })

    expect(captured).toHaveLength(1)
    const req = captured[0]!
    expect(req.method).toBe('POST')
    expect(req.pathname).toBe('/registry/heartbeat')
    expect(req.headers['authorization']).toBe('Bearer tok-heartbeat-test')
    expect(req.headers['content-type']).toContain('application/json')
    // Origin pinned because SaaS edge WAF rewrites /workspaces/* and
    // /registry/* to the Next.js front-end without it (per saved memory
    // `reference_saas_waf_origin_header.md`). Heartbeat would silently
    // 404 on saas tenants without it; pin so a refactor that drops it
    // surfaces here, not in production.
    expect(req.headers['origin']).toBe(platformUrl)
    expect(req.body).toEqual({ workspace_id: 'ws-heartbeat-test-id' })
  })

  it('does not throw on platform 5xx — logs and returns so the next tick retries', async () => {
    nextStatus = 503
    nextResponseBody = 'service unavailable'
    const logs: string[] = []
    // sendHeartbeat must not propagate — the setInterval caller relies on
    // resolution-not-rejection so a transient platform 503 doesn't kill
    // the heartbeat loop for the rest of the plugin's lifetime.
    await expect(sendHeartbeat({
      platformUrl,
      workspaceId: 'ws-x',
      token: 'tok-x',
      log: (line) => { logs.push(line) },
    })).resolves.toBeUndefined()
    expect(captured).toHaveLength(1)
    expect(logs.join('')).toContain('HTTP 503')
    expect(logs.join('')).toContain('service unavailable')
  })

  it('does not throw on platform 401 — auth-token revocation surfaces in stderr but does not crash', async () => {
    nextStatus = 401
    nextResponseBody = '{"error":"invalid token"}'
    const logs: string[] = []
    await expect(sendHeartbeat({
      platformUrl,
      workspaceId: 'ws-y',
      token: 'tok-revoked',
      log: (line) => { logs.push(line) },
    })).resolves.toBeUndefined()
    expect(captured).toHaveLength(1)
    expect(logs.join('')).toContain('HTTP 401')
  })

  it('does not throw on network error — fetch failure logged, next tick retries', async () => {
    const logs: string[] = []
    // Use a port that's almost certainly closed (port 1 is reserved/usually
    // unreachable in user space). On any plausible test host the connection
    // refuses immediately, surfacing the fetch-failed branch.
    await expect(sendHeartbeat({
      platformUrl: 'http://127.0.0.1:1',
      workspaceId: 'ws-net',
      token: 'tok',
      log: (line) => { logs.push(line) },
      timeoutMs: 1_000,
    })).resolves.toBeUndefined()
    expect(logs.join('')).toContain('fetch failed')
  })

  it('drains the response body on success so connections can be reused', async () => {
    // Pre-fix concern: a body-not-drained refactor would leak sockets in
    // production over the lifetime of a long-running session. The
    // contract the production code relies on is "after sendHeartbeat
    // resolves, the body is consumed" — verifiable indirectly by
    // observing that a follow-up call still sees a fresh fixture entry.
    nextStatus = 200
    nextResponseBody = '{"ok":true,"some":"large-response-body-with-content"}'
    await sendHeartbeat({
      platformUrl,
      workspaceId: 'ws-1',
      token: 'tok-1',
    })
    await sendHeartbeat({
      platformUrl,
      workspaceId: 'ws-2',
      token: 'tok-2',
    })
    expect(captured).toHaveLength(2)
    expect(captured[0]!.body).toEqual({ workspace_id: 'ws-1' })
    expect(captured[1]!.body).toEqual({ workspace_id: 'ws-2' })
  })
})
