// channel-capabilities-and-filter.test.ts — pins the two regressions Reno-Stars
// caught in their local-patched verify of v0.4.0-gitea.2:
//
//   P0. Server constructor must declare `experimental.claude/channel` and
//       `experimental.claude/channel/permission` capabilities. Without
//       these, the Claude Code MCP host treats the server as tool-only and
//       silently drops every `notifications/claude/channel` event we emit
//       — poll advances, cursor moves, stderr says "delivered", message
//       never reaches the user.
//
//   P1. pollWorkspace must skip outbound `method=notify` rows. The
//       activity feed returns the agent's own /notify calls alongside
//       inbound A2A; emitNotification classifies them as canvas_user
//       (source_id=null) and the reply echoes back as a fake user turn
//       one poll later.
//
// Both regressions are silent — green tests + green CI today, broken
// behavior in production. Pin the shape so a future refactor that drops
// either fix surfaces here.
//
// Imports from ./server.ts are safe because tests/setup.ts (preloaded
// via bunfig.toml) sets the three required env vars before any test
// file is imported.

import { describe, expect, test } from 'bun:test'
import {
  SERVER_CAPABILITIES,
  shouldEmitActivity,
} from './server.ts'
import type { ActivityEntry } from './extract-text.ts'

describe('SERVER_CAPABILITIES — P0 channel-capability declaration', () => {
  test('declares experimental.claude/channel', () => {
    expect(SERVER_CAPABILITIES).toBeDefined()
    expect(SERVER_CAPABILITIES.experimental).toBeDefined()
    // The presence of the key is what the host checks. Empty object is
    // intentional — the channel capability has no negotiable sub-fields
    // today; it's a marker for "this server emits notifications/claude/channel".
    expect(SERVER_CAPABILITIES.experimental['claude/channel']).toBeDefined()
    expect(typeof SERVER_CAPABILITIES.experimental['claude/channel']).toBe('object')
  })

  test('declares experimental.claude/channel/permission', () => {
    // Companion flag the host gates channel-write permission prompts on.
    // Required pair — telegram-channel reference declares both.
    expect(SERVER_CAPABILITIES.experimental['claude/channel/permission']).toBeDefined()
    expect(typeof SERVER_CAPABILITIES.experimental['claude/channel/permission']).toBe('object')
  })

  test('still declares tools (regression: don\'t lose the tools surface)', () => {
    // The pre-fix capability object was `{ tools: {} }`; this test pins
    // that adding the experimental block didn't accidentally drop tools,
    // which would break reply_to_workspace / list_peers / delegate_task.
    expect(SERVER_CAPABILITIES.tools).toBeDefined()
  })
})

describe('shouldEmitActivity — P1 outbound /notify echo filter', () => {
  // Construct just enough of an ActivityEntry to satisfy the helper's
  // Pick<ActivityEntry, 'method'>. The helper is intentionally narrow —
  // it only reads .method — so the test doesn't need to mock the rest.
  const make = (method: string | null): Pick<ActivityEntry, 'method'> => ({ method })

  test('skips method="notify" rows (the agent\'s own outbound echoes)', () => {
    expect(shouldEmitActivity(make('notify'))).toBe(false)
  })

  test('emits method="message/send" rows (inbound peer A2A)', () => {
    // The dominant inbound shape: peers POST /workspaces/:id/a2a with
    // a JSON-RPC message/send envelope; the platform records that as
    // method="message/send" on the destination workspace.
    expect(shouldEmitActivity(make('message/send'))).toBe(true)
  })

  test('emits method="user_message" rows (canvas-user inbound)', () => {
    // Canvas chat panel sends method="user_message" — these surface
    // as canvas_user kind to Claude.
    expect(shouldEmitActivity(make('user_message'))).toBe(true)
  })

  test('emits null-method rows (inbound, method missing on platform side)', () => {
    // Defensive: platform older than #2354 may have null method on some
    // rows; deliver them rather than silently dropping. canvas_user
    // classification will fall back to "no peer_id" → treat as canvas-user.
    expect(shouldEmitActivity(make(null))).toBe(true)
  })

  test('emits any non-"notify" method even unrecognised ones', () => {
    // Forward-compat: a future platform version could add a new method
    // string. Default-allow + explicit-deny on "notify" is the safer
    // policy than default-deny + explicit-allow on a known list.
    expect(shouldEmitActivity(make('something/new'))).toBe(true)
  })

  test('integration: emitting twice in a batch where one is notify yields one emission', () => {
    // Models the real pollWorkspace loop shape: filter pass count must
    // equal "non-notify rows", regardless of order.
    const batch: Array<Pick<ActivityEntry, 'method'>> = [
      make('notify'),       // own echo — drop
      make('message/send'), // peer A2A — emit
      make('notify'),       // another own echo — drop
      make('user_message'), // canvas user — emit
    ]
    const emitted = batch.filter(shouldEmitActivity)
    expect(emitted).toHaveLength(2)
    expect(emitted.map(a => a.method)).toEqual(['message/send', 'user_message'])
  })
})
