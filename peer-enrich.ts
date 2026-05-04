// peer-enrich — registry-backed name/role lookup for inbound A2A peers.
//
// Mirrors workspace/a2a_client.py:enrich_peer_metadata in molecule-core: a
// 5-minute TTL cache wrapping GET /registry/discover/<peer_id>, with
// negative caching so a flaky/missing peer doesn't re-fire the bounded GET
// on every push. The README has documented these envelope fields since the
// 2026-05-02 PR (Molecule-AI/molecule-mcp-claude-channel#23) but the code
// has never actually populated them — this module closes that gap so the
// channel plugin's meta block matches what Claude Code is told to expect.
//
// Trust boundary: peer_id is sourced from the inbox row, which the
// platform sends but doesn't guarantee. UUID validation lives here so a
// malformed id (path-traversal chars, control bytes, embedded JSON-RPC
// quotes) can't be reflected into either the registry URL or the
// meta envelope. Same guard the Python side uses (a2a_client._validate_peer_id).

const PEER_METADATA_TTL_MS = 5 * 60 * 1000

// UUID v1-v5 / nil — same shape Python's _validate_peer_id accepts. The
// platform's discover route only resolves canonical UUIDs, so anything
// off-shape is automatically a registry miss; rejecting at the helper
// boundary skips the round-trip + protects against header injection.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface PeerRecord {
  id?: string
  name?: string
  role?: string
  status?: string
  url?: string
  // Platform may add fields without a code change here — surface whatever
  // /registry/discover returns. Callers narrow on the named fields they care about.
  [k: string]: unknown
}

interface CacheEntry {
  fetchedAt: number
  // null is the negative-cache sentinel: registry failure is cached for one
  // TTL window so a missing peer doesn't burn a GET per push.
  record: PeerRecord | null
}

const cache = new Map<string, CacheEntry>()

// Test seam — unit tests reset state between cases without exporting the
// Map itself (keeps the cache's mutation surface narrow).
export function _resetPeerCache(): void {
  cache.clear()
}

export function validatePeerId(peerId: string): string | null {
  if (!peerId) return null
  return UUID_RE.test(peerId) ? peerId.toLowerCase() : null
}

export function agentCardUrlFor(peerId: string, platformUrl: string): string {
  // Construct the platform-side discover URL. Returns empty string for
  // non-UUID input — never interpolate path-traversal chars into a URL.
  // Platform URL is operator-supplied via MOLECULE_PLATFORM_URL so it's
  // already trusted; peer_id is the boundary.
  const canon = validatePeerId(peerId)
  if (canon === null) return ''
  return `${platformUrl.replace(/\/$/, '')}/registry/discover/${canon}`
}

export interface EnrichDeps {
  // Injected fetch + clock so tests don't touch real network or wall time.
  // server.ts always passes the platform fetch and Date.now.
  fetch?: typeof fetch
  now?: () => number
  // Per-request timeout. The Python helper uses 2s; keep the same here so
  // a stalled registry never blocks the inbox emit path. Bun's native
  // AbortSignal.timeout is used by default.
  timeoutMs?: number
}

export async function enrichPeerMetadata(
  peerId: string,
  platformUrl: string,
  token: string,
  deps: EnrichDeps = {},
): Promise<PeerRecord | null> {
  const canon = validatePeerId(peerId)
  if (canon === null) return null

  const now = (deps.now ?? Date.now)()
  const cached = cache.get(canon)
  if (cached && now - cached.fetchedAt < PEER_METADATA_TTL_MS) {
    // Fresh — return whatever's there. null is the negative-cache sentinel
    // (caller treats absence the same as a registry miss).
    return cached.record
  }

  const f = deps.fetch ?? fetch
  const url = `${platformUrl.replace(/\/$/, '')}/registry/discover/${canon}`
  const timeoutMs = deps.timeoutMs ?? 2000

  let resp: Response
  try {
    resp = await f(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        // Origin is required by the SaaS edge WAF on /registry/* routes
        // (memory: reference_saas_waf_origin_header). Without it the edge
        // rewrites to Next.js and returns an empty 404 — same misdiagnosis
        // path that bit the workspace runtime before PR #2413.
        Origin: platformUrl,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    // Network failure / timeout — negative-cache and degrade. The push
    // path must never block on a registry stall.
    cache.set(canon, { fetchedAt: now, record: null })
    return null
  }

  if (resp.status !== 200) {
    cache.set(canon, { fetchedAt: now, record: null })
    return null
  }

  let data: unknown
  try {
    data = await resp.json()
  } catch {
    cache.set(canon, { fetchedAt: now, record: null })
    return null
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    cache.set(canon, { fetchedAt: now, record: null })
    return null
  }

  const record = data as PeerRecord
  cache.set(canon, { fetchedAt: now, record })
  return record
}
