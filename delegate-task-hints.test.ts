// delegate-task-hints.test.ts — pin the wording of the multi-tenant
// 404 hint added in v0.4.1. The exact text gets pasted into operator
// bug reports + community Q&A; if a future refactor changes it
// silently, those references go stale. The test pins each load-bearing
// substring rather than the whole string so wording polish doesn't
// require updating an opaque snapshot.

import { describe, expect, test } from 'bun:test'
import { delegateTaskMultiTenantHint } from './delegate-task-hints.ts'

describe('delegateTaskMultiTenantHint (#3013 parked item)', () => {
  test('starts with " — note:" so it appends cleanly to the upstream error message', () => {
    // The hint is concatenated onto `delegate_task failed: HTTP 404 — body...`
    // — the leading separator MUST start with a space + em-dash so the
    // full message reads as one sentence, not two squashed-together
    // logs.
    const hint = delegateTaskMultiTenantHint('ws-a', 'https://t.example/')
    expect(hint.startsWith(' — note:')).toBe(true)
  })

  test('names the env var that controls multi-tenant mode', () => {
    // Operators searching their .env for "what knob makes this happen"
    // need the literal env-var name. Without it they search docs and
    // bounce.
    const hint = delegateTaskMultiTenantHint('ws-a', 'https://t.example/')
    expect(hint).toContain('MOLECULE_PLATFORM_URLS')
  })

  test('explains the cross-tenant constraint by name (a2a_proxy)', () => {
    // Operators who already know our internals can pattern-match on
    // "a2a_proxy" and stop debugging. Operators who don't can grep
    // the codebase + find the constraint quickly.
    const hint = delegateTaskMultiTenantHint('ws-a', 'https://t.example/')
    expect(hint).toContain('a2a_proxy')
  })

  test('surfaces the watching tenant URL the request actually went to', () => {
    // The most common cause of a "wrong-tenant" 404 is a typo in
    // MOLECULE_PLATFORM_URLS — operator MEANT t-b but typed t-a. The
    // hint MUST name the URL the request actually hit so the typo is
    // visible without reading server logs.
    const hint = delegateTaskMultiTenantHint('ws-a', 'https://typo-tenant.example/')
    expect(hint).toContain('https://typo-tenant.example/')
  })

  test('shows the EXACT list_peers call (with the watching workspace_id) the operator should run next', () => {
    // The recovery action is unambiguous: enumerate peers on the
    // watching tenant. Hint must give the exact tool call, not a
    // vague "use list_peers" — operators tend to skip vague hints
    // and search the docs instead.
    const hint = delegateTaskMultiTenantHint('ws-watching-id', 'https://t.example/')
    expect(hint).toContain('list_peers({workspace_id: "ws-watching-id"})')
  })

  test('different watching workspace_id changes the list_peers argument (catches a hard-coded id)', () => {
    // Discriminating: if a future refactor accidentally hard-codes the
    // workspace_id in the hint, this test goes red.
    const a = delegateTaskMultiTenantHint('ws-aaa', 'https://t.example/')
    const b = delegateTaskMultiTenantHint('ws-bbb', 'https://t.example/')
    expect(a).toContain('"ws-aaa"')
    expect(b).toContain('"ws-bbb"')
    expect(a).not.toBe(b)
  })
})
