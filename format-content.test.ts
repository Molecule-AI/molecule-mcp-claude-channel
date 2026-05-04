// Regression tests for format-content.ts — pin the exact strings Claude
// sees as the conversation turn. Per memory `feedback_assert_exact_not_substring`,
// substring assertions pass for both correct formatting AND for "extractor
// returned raw input" failure modes; only exact equality discriminates.

import { describe, expect, it } from 'bun:test'
import {
  formatChannelContent,
  formatHeader,
  formatReplyHint,
} from './format-content.ts'

const PEER = 'a1b2c3d4-e5f6-4789-9abc-def012345678'
const WATCHING = 'd0e1f2a3-b4c5-4678-89ab-cdef01234567'

describe('formatHeader — canvas_user', () => {
  it('shows the watching workspace, no peer_id', () => {
    expect(
      formatHeader({
        text: 'irrelevant',
        kind: 'canvas_user',
        watchingAs: WATCHING,
        peerId: '',
      }),
    ).toBe(`[from canvas user · workspace=${WATCHING}]`)
  })
})

describe('formatHeader — peer_agent', () => {
  it('uses name+role when both registry-resolved', () => {
    expect(
      formatHeader({
        text: 'irrelevant',
        kind: 'peer_agent',
        watchingAs: WATCHING,
        peerId: PEER,
        peerName: 'ops-agent',
        peerRole: 'sre',
      }),
    ).toBe(`[from ops-agent (sre) · peer_id=${PEER} · watching=${WATCHING}]`)
  })

  it('uses name alone when role missing', () => {
    expect(
      formatHeader({
        text: 'irrelevant',
        kind: 'peer_agent',
        watchingAs: WATCHING,
        peerId: PEER,
        peerName: 'ops-agent',
      }),
    ).toBe(`[from ops-agent · peer_id=${PEER} · watching=${WATCHING}]`)
  })

  it('falls back to "peer-agent" when registry lookup failed entirely', () => {
    expect(
      formatHeader({
        text: 'irrelevant',
        kind: 'peer_agent',
        watchingAs: WATCHING,
        peerId: PEER,
      }),
    ).toBe(`[from peer-agent · peer_id=${PEER} · watching=${WATCHING}]`)
  })
})

describe('formatReplyHint', () => {
  it('canvas_user reply omits peer_id (routes to /notify)', () => {
    expect(
      formatReplyHint({
        text: 'irrelevant',
        kind: 'canvas_user',
        watchingAs: WATCHING,
        peerId: '',
      }),
    ).toBe(`↩ Reply: reply_to_workspace({workspace_id: "${WATCHING}", text: "..."})`)
  })

  it('peer_agent reply includes peer_id (routes to /a2a)', () => {
    expect(
      formatReplyHint({
        text: 'irrelevant',
        kind: 'peer_agent',
        watchingAs: WATCHING,
        peerId: PEER,
      }),
    ).toBe(
      `↩ Reply: reply_to_workspace({workspace_id: "${WATCHING}", peer_id: "${PEER}", text: "..."})`,
    )
  })
})

describe('formatChannelContent — full envelope', () => {
  it('composes header + text + hint with newline separators', () => {
    const body = formatChannelContent({
      text: 'did you got any request from hermes agent?',
      kind: 'peer_agent',
      watchingAs: WATCHING,
      peerId: PEER,
      peerName: 'hermes-agent',
      peerRole: 'runtime',
    })
    expect(body).toBe(
      `[from hermes-agent (runtime) · peer_id=${PEER} · watching=${WATCHING}]\n` +
        `did you got any request from hermes agent?\n` +
        `↩ Reply: reply_to_workspace({workspace_id: "${WATCHING}", peer_id: "${PEER}", text: "..."})`,
    )
  })

  it('preserves multi-line peer text without truncation', () => {
    const text = 'line one\nline two\n\nline four'
    const body = formatChannelContent({
      text,
      kind: 'canvas_user',
      watchingAs: WATCHING,
      peerId: '',
    })
    // Header + multi-line body + hint, all separated by single newlines.
    expect(body).toBe(
      `[from canvas user · workspace=${WATCHING}]\n` +
        text +
        `\n↩ Reply: reply_to_workspace({workspace_id: "${WATCHING}", text: "..."})`,
    )
  })
})
