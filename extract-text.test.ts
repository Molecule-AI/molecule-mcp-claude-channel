// Regression tests for extractText. The 2026-04-30 incident — every
// canvas peer message arriving but extractText returning act.summary
// because parts had `kind` instead of `type` — is the failure mode
// these tests pin against. Add new shape coverage here when the
// platform's a2a_proxy logging changes.

import { describe, expect, it } from 'bun:test'
import { extractText, type ActivityEntry } from './extract-text.ts'

function act(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'a-1',
    workspace_id: 'w-1',
    activity_type: 'a2a_receive',
    source_id: 'peer-1',
    target_id: 'w-1',
    method: 'message/send',
    summary: 'fallback summary',
    request_body: undefined,
    response_body: undefined,
    status: 'ok',
    error_detail: null,
    created_at: '2026-04-30T00:00:00Z',
    ...overrides,
  }
}

describe('extractText — part discriminator', () => {
  it('accepts a2a-sdk v1 parts (kind: text) — the production shape', () => {
    const text = extractText(
      act({
        request_body: {
          jsonrpc: '2.0',
          method: 'message/send',
          params: { message: { parts: [{ kind: 'text', text: 'hello v1' }] } },
        },
      }),
    )
    expect(text).toBe('hello v1')
  })

  it('accepts legacy v0 parts (type: text) — back-compat', () => {
    const text = extractText(
      act({
        request_body: {
          jsonrpc: '2.0',
          method: 'message/send',
          params: { message: { parts: [{ type: 'text', text: 'hello v0' }] } },
        },
      }),
    )
    expect(text).toBe('hello v0')
  })

  it('joins multiple text parts in order, ignoring non-text parts', () => {
    const text = extractText(
      act({
        request_body: {
          params: {
            message: {
              parts: [
                { kind: 'text', text: 'one ' },
                { kind: 'data', text: 'should-skip' },
                { kind: 'text', text: 'two' },
              ],
            },
          },
        },
      }),
    )
    expect(text).toBe('one two')
  })
})

describe('extractText — body shape priority', () => {
  it('prefers params.message.parts (canonical JSON-RPC envelope)', () => {
    const text = extractText(
      act({
        request_body: {
          params: {
            message: { parts: [{ kind: 'text', text: 'shape-1' }] },
            parts: [{ kind: 'text', text: 'shape-2' }],
          },
          parts: [{ kind: 'text', text: 'shape-3' }],
        },
      }),
    )
    expect(text).toBe('shape-1')
  })

  it('falls back to params.parts when message wrapper is absent', () => {
    const text = extractText(
      act({
        request_body: {
          params: { parts: [{ kind: 'text', text: 'shape-2' }] },
        },
      }),
    )
    expect(text).toBe('shape-2')
  })

  it('falls back to body.parts (canvas-side direct sends)', () => {
    const text = extractText(
      act({ request_body: { parts: [{ kind: 'text', text: 'shape-3' }] } }),
    )
    expect(text).toBe('shape-3')
  })
})

describe('extractText — fallbacks', () => {
  it('returns act.summary when no shape matches', () => {
    const text = extractText(
      act({ request_body: { unrelated: 'envelope' }, summary: 'audit summary' }),
    )
    expect(text).toBe('audit summary')
  })

  it('returns the empty-marker when summary is null and body has no parts', () => {
    const text = extractText(act({ request_body: undefined, summary: null }))
    expect(text).toBe('(empty A2A message)')
  })

  it('skips empty-text parts and tries the next candidate before falling back', () => {
    const text = extractText(
      act({
        request_body: {
          params: { message: { parts: [{ kind: 'text', text: '' }] } },
          parts: [{ kind: 'text', text: 'recovered' }],
        },
      }),
    )
    expect(text).toBe('recovered')
  })
})
