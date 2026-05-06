// platform-urls.test.ts — branch-coverage for resolvePlatformUrls.
//
// The resolver decides which tenant a watched workspace's HTTP calls
// route to. A regression here means tokens leak across tenants
// (singular fan-out broken → wrong host) or workspaces silently
// route through the wrong tenant (length-mismatch unchecked → off-by-
// one). Each branch needs a discriminating test.
//
// Mutation-test mentally before adding a test: if I delete the
// branch this exercises, does this test go red? If not, the test is
// asserting something else.

import { describe, expect, test } from 'bun:test'
import { resolvePlatformUrls, hasMixedTenants } from './platform-urls.ts'

describe('resolvePlatformUrls — single-tenant fan-out', () => {
  test('singular MOLECULE_PLATFORM_URL broadcasts to every watched workspace (preserves pre-v0.4 behavior)', () => {
    // The load-bearing back-compat case. Pre-v0.4 every install set
    // MOLECULE_PLATFORM_URL only; v0.4 must keep that working
    // verbatim so existing users don't have to touch their .env.
    const r = resolvePlatformUrls({
      workspaceIds: ['ws-a', 'ws-b', 'ws-c'],
      platformUrls: [],
      platformUrl: 'https://tenant.moleculesai.app',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.urls).toEqual([
      'https://tenant.moleculesai.app',
      'https://tenant.moleculesai.app',
      'https://tenant.moleculesai.app',
    ])
    expect(r.multiTenant).toBe(false)
  })

  test('one workspace + singular URL works (degenerate single-watch case)', () => {
    const r = resolvePlatformUrls({
      workspaceIds: ['ws-a'],
      platformUrls: [],
      platformUrl: 'https://tenant.moleculesai.app',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.urls).toEqual(['https://tenant.moleculesai.app'])
  })
})

describe('resolvePlatformUrls — multi-tenant per-workspace', () => {
  test('plural MOLECULE_PLATFORM_URLS routes one URL per watched workspace, same order', () => {
    // Closes #3013 issue 4. A user watching one workspace on
    // tenant-a + another on tenant-b can now express that without
    // running two plugin installs.
    const r = resolvePlatformUrls({
      workspaceIds: ['ws-a', 'ws-b'],
      platformUrls: ['https://tenant-a.../', 'https://tenant-b.../'],
      platformUrl: undefined,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.urls).toEqual(['https://tenant-a.../', 'https://tenant-b.../'])
    expect(r.multiTenant).toBe(true)
  })

  test('plural with all-same-URL entries is NOT flagged as multi-tenant (banner stays single-line)', () => {
    // A user might explicitly set MOLECULE_PLATFORM_URLS=url,url,url
    // even when they could have used the singular. The startup banner
    // collapses to single-line in that case (cosmetic), so the
    // multiTenant flag is `hasMixedTenants(urls) > 1`, not just
    // `platformUrls.length > 0`.
    const r = resolvePlatformUrls({
      workspaceIds: ['ws-a', 'ws-b'],
      platformUrls: ['https://t.example/', 'https://t.example/'],
      platformUrl: undefined,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.multiTenant).toBe(false)
  })

  test('plural wins when both plural AND singular are set (singular silently ignored)', () => {
    // Mixed-source semantics are documented as "plural wins". If we
    // ever changed to "fall back per-entry to singular", the parity
    // check would lose its meaning (a missing entry would silently
    // route through the singular instead of erroring). Pin the
    // current behavior so a future refactor doesn't drift.
    const r = resolvePlatformUrls({
      workspaceIds: ['ws-a', 'ws-b'],
      platformUrls: ['https://from-plural-a/', 'https://from-plural-b/'],
      platformUrl: 'https://from-singular/',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.urls).toEqual(['https://from-plural-a/', 'https://from-plural-b/'])
    // Singular MUST NOT appear in the resolved URLs.
    expect(r.urls.every(u => !u.includes('from-singular'))).toBe(true)
  })
})

describe('resolvePlatformUrls — error paths', () => {
  test('plural with mismatched length errors with both counts named', () => {
    // The exact regression mode the parity check exists to prevent:
    // 2 ids + 1 URL would silently route both workspaces through the
    // single URL (off-by-one fan-out), masking the misconfiguration
    // until a 401 from the wrong tenant. Error message names both
    // counts so the operator can spot the typo immediately.
    const r = resolvePlatformUrls({
      workspaceIds: ['ws-a', 'ws-b'],
      platformUrls: ['https://only-one/'],
      platformUrl: undefined,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('1 urls')
    expect(r.message).toContain('2 ids')
    // The error message must reference BOTH env-var names so the
    // operator knows where to look.
    expect(r.message).toContain('MOLECULE_PLATFORM_URLS')
    expect(r.message).toContain('MOLECULE_PLATFORM_URL')
  })

  test('plural with too many entries also errors', () => {
    const r = resolvePlatformUrls({
      workspaceIds: ['ws-a'],
      platformUrls: ['https://a/', 'https://b/'],
      platformUrl: undefined,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('2 urls')
    expect(r.message).toContain('1 ids')
  })

  test('neither plural nor singular set errors', () => {
    const r = resolvePlatformUrls({
      workspaceIds: ['ws-a'],
      platformUrls: [],
      platformUrl: undefined,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('MOLECULE_PLATFORM_URL')
    expect(r.message).toContain('MOLECULE_PLATFORM_URLS')
  })

  test('empty workspaceIds errors before URL resolution', () => {
    // Belt-and-braces — server.ts checks WORKSPACE_IDS.length before
    // calling resolvePlatformUrls, but the resolver still defends
    // against a future caller that doesn't.
    const r = resolvePlatformUrls({
      workspaceIds: [],
      platformUrls: ['https://a/'],
      platformUrl: undefined,
    })
    expect(r.ok).toBe(false)
  })

  test('singular set to empty string is treated as unset', () => {
    // process.env vars come back as `string | undefined`, but a
    // user editing `.env` could leave `MOLECULE_PLATFORM_URL=` (empty
    // assignment). The current callsite hands us undefined for that
    // case (env loader filters), but defend in the resolver too.
    const r = resolvePlatformUrls({
      workspaceIds: ['ws-a'],
      platformUrls: [],
      platformUrl: '',
    })
    expect(r.ok).toBe(false)
  })
})

describe('hasMixedTenants', () => {
  test('one URL → not mixed', () => {
    expect(hasMixedTenants(['https://only/'])).toBe(false)
  })
  test('two same URLs → not mixed', () => {
    expect(hasMixedTenants(['https://t/', 'https://t/'])).toBe(false)
  })
  test('two different URLs → mixed', () => {
    expect(hasMixedTenants(['https://a/', 'https://b/'])).toBe(true)
  })
  test('empty → not mixed (degenerate)', () => {
    expect(hasMixedTenants([])).toBe(false)
  })
})

describe('resolvePlatformUrls — output isolation', () => {
  test('returned urls array is a NEW array, not a reference to platformUrls input', () => {
    // The resolver must defensively copy so a caller mutating the
    // input array post-resolve doesn't corrupt URL_BY_WORKSPACE.
    const input = ['https://a/', 'https://b/']
    const r = resolvePlatformUrls({
      workspaceIds: ['ws-1', 'ws-2'],
      platformUrls: input,
      platformUrl: undefined,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.urls).not.toBe(input)
    input[0] = 'https://mutated/'
    expect(r.urls[0]).toBe('https://a/')
  })
})
