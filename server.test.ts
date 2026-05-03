// Regression tests for getWorkspaceInfo's 410-handling — pinned via
// the formatRemovedWorkspaceError pure helper so the test doesn't
// need to mock fetch + resolveWatching just to read one string.
//
// molecule-core#2429 — without these tests, the "your workspace was
// deleted, re-onboard" message is a 4-line code path that an
// inattentive refactor could collapse back into the generic
// "HTTP 410" error we used to surface.

import { describe, expect, it } from 'bun:test'
// Imports from ./error-format.ts (not ./server.ts) so the test doesn't
// trigger server.ts's boot-time env validation, PID-file lock, MCP
// transport connect, or top-level await on missing MOLECULE_* env. The
// import-time process.exit(1) made this test file uncatchable in CI
// (where MOLECULE_PLATFORM_URL et al. are unset).
import { formatRemovedWorkspaceError } from './error-format.ts'

describe('formatRemovedWorkspaceError — 410 Gone handling (#2429)', () => {
  it('prefers the platform-supplied id, removed_at, and hint when present', () => {
    const msg = formatRemovedWorkspaceError('local-fallback-id', {
      id: 'real-uuid',
      removed_at: '2026-04-30T12:00:00Z',
      hint: 'Custom hint from the platform.',
    })
    expect(msg).toBe(
      'Workspace real-uuid was deleted on the platform at 2026-04-30T12:00:00Z. Custom hint from the platform.',
    )
  })

  it('falls back to the local workspaceId + default hint when body is empty', () => {
    const msg = formatRemovedWorkspaceError('fallback-uuid', {})
    expect(msg).toBe(
      'Workspace fallback-uuid was deleted on the platform. Regenerate workspace + token from the canvas → Tokens tab.',
    )
  })

  it('tolerates a null/undefined body (unparseable response)', () => {
    expect(formatRemovedWorkspaceError('uuid', null)).toContain(
      'Workspace uuid was deleted',
    )
    expect(formatRemovedWorkspaceError('uuid', undefined)).toContain(
      'Regenerate workspace + token',
    )
  })

  it('omits the timestamp clause when removed_at is missing', () => {
    const msg = formatRemovedWorkspaceError('uuid', {
      id: 'uuid',
      hint: 'h',
    })
    expect(msg).not.toContain(' at ')
    expect(msg).toBe('Workspace uuid was deleted on the platform. h')
  })
})
