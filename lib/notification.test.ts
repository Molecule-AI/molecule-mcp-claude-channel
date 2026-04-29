import { describe, it, expect } from 'bun:test'
import { extractText, buildReplyBody, type ActivityEntry } from './notification.ts'

const baseActivity: ActivityEntry = {
  id: 'act-1',
  workspace_id: 'ws-A',
  activity_type: 'a2a_receive',
  source_id: 'ws-B',
  target_id: 'ws-A',
  method: 'message/send',
  summary: 'message/send → A',
  status: 'ok',
  error_detail: null,
  created_at: '2026-04-29T12:00:00Z',
}

describe('extractText', () => {
  it('extracts from JSON-RPC envelope with message wrapper (shape 1)', () => {
    const act: ActivityEntry = {
      ...baseActivity,
      request_body: {
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'message/send',
        params: {
          message: {
            messageId: 'm1',
            parts: [{ type: 'text', text: 'Hello peer!' }],
          },
        },
      },
    }
    expect(extractText(act)).toEqual({ text: 'Hello peer!', nonTextSkipped: 0 })
  })

  it('extracts from JSON-RPC envelope with params.parts (shape 2)', () => {
    const act: ActivityEntry = {
      ...baseActivity,
      request_body: {
        jsonrpc: '2.0',
        id: 'req-2',
        method: 'message/send',
        params: {
          parts: [{ type: 'text', text: 'Legacy shape' }],
        },
      },
    }
    expect(extractText(act)).toEqual({ text: 'Legacy shape', nonTextSkipped: 0 })
  })

  it('extracts from shorthand body (shape 3)', () => {
    const act: ActivityEntry = {
      ...baseActivity,
      request_body: {
        parts: [{ type: 'text', text: 'Canvas direct send' }],
      },
    }
    expect(extractText(act)).toEqual({ text: 'Canvas direct send', nonTextSkipped: 0 })
  })

  it('joins multi-part text concatenation in shape 1', () => {
    const act: ActivityEntry = {
      ...baseActivity,
      request_body: {
        params: {
          message: {
            parts: [
              { type: 'text', text: 'First. ' },
              { type: 'text', text: 'Second.' },
            ],
          },
        },
      },
    }
    expect(extractText(act).text).toBe('First. Second.')
  })

  it('counts non-text parts as nonTextSkipped (image-only message)', () => {
    const act: ActivityEntry = {
      ...baseActivity,
      summary: 'message/send → A',
      request_body: {
        params: {
          message: {
            parts: [
              { type: 'image' as 'text', text: 'data:image/png;base64,...' as string },
              { type: 'file' as 'text', text: 'attachment' as string },
            ],
          },
        },
      },
    }
    const out = extractText(act)
    expect(out.nonTextSkipped).toBe(2)
    // No text in the parts → falls back to summary, which is still better
    // than silent-drop. The nonTextSkipped count tells the caller to log.
    expect(out.text).toBe('message/send → A')
  })

  it('mixed text + non-text returns text + skipped count', () => {
    const act: ActivityEntry = {
      ...baseActivity,
      request_body: {
        params: {
          message: {
            parts: [
              { type: 'text', text: 'see attachment' },
              { type: 'image' as 'text', text: 'binary' },
            ],
          },
        },
      },
    }
    const out = extractText(act)
    expect(out.text).toBe('see attachment')
    expect(out.nonTextSkipped).toBe(1)
  })

  it('falls back to summary when request_body has no recognised shape', () => {
    const act: ActivityEntry = {
      ...baseActivity,
      summary: 'fallback summary',
      request_body: { unrelated: 'data' },
    }
    expect(extractText(act)).toEqual({ text: 'fallback summary', nonTextSkipped: 0 })
  })

  it('falls back to summary when request_body is missing entirely', () => {
    const act: ActivityEntry = { ...baseActivity, summary: 'just a summary', request_body: undefined }
    expect(extractText(act)).toEqual({ text: 'just a summary', nonTextSkipped: 0 })
  })

  it('emits placeholder when both request_body AND summary are missing', () => {
    const act: ActivityEntry = { ...baseActivity, summary: null, request_body: undefined }
    expect(extractText(act).text).toBe('(empty A2A message)')
  })

  it('regression: shape 1 (JSON-RPC envelope) is the most common; verify exact match', () => {
    // This is the shape that the v0.1 bug caused to fall through to summary.
    // Lock the contract — if anyone ever changes the candidate-walk order,
    // this test should fail loudly so they remember why.
    const act: ActivityEntry = {
      ...baseActivity,
      summary: 'message/send → ws-A',
      request_body: {
        jsonrpc: '2.0',
        id: 'req-real',
        method: 'message/send',
        params: {
          message: {
            messageId: 'msg-xyz',
            parts: [{ type: 'text', text: 'Real peer message — not summary' }],
          },
        },
      },
    }
    expect(extractText(act).text).toBe('Real peer message — not summary')
  })
})

describe('buildReplyBody', () => {
  // Deterministic id generator so we can assert the exact JSON shape.
  // Returns "id-1", "id-2", etc. on successive calls — buildReplyBody
  // calls idGen twice (once for envelope id, once for messageId).
  function* idCounter() {
    let i = 0
    while (true) yield `id-${++i}`
  }

  it('produces a JSON-RPC 2.0 envelope with method=message/send', () => {
    const gen = idCounter()
    const body = buildReplyBody('hello peer', () => gen.next().value as string)
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 'id-1',
      method: 'message/send',
      params: {
        message: {
          messageId: 'id-2',
          parts: [{ type: 'text', text: 'hello peer' }],
        },
      },
    })
  })

  it('regression: NEVER ships shorthand {parts:[...]} (the v0.1 outbound bug)', () => {
    // The original v0.1 sent {parts:[...]} directly. The platform's
    // a2a_proxy accepted it but stripped params before forwarding to
    // the peer, so the peer received params:null. This test pins the
    // proper-JSON-RPC contract so a future "let's simplify" doesn't
    // re-introduce the bug.
    const body = buildReplyBody('reply text')
    expect(body).toHaveProperty('jsonrpc', '2.0')
    expect(body).toHaveProperty('method', 'message/send')
    expect(body).toHaveProperty('params.message.parts')
    expect(body.params.message.parts).toEqual([{ type: 'text', text: 'reply text' }])
    // Crucial: parts must be NESTED under params.message, NOT at top level
    expect(body).not.toHaveProperty('parts')
  })

  it('preserves text exactly — no encoding, escaping, or truncation', () => {
    const tricky = "Hello 'world'\nLine 2\tTab \"quote\" 中文 💬"
    const body = buildReplyBody(tricky)
    expect(body.params.message.parts[0].text).toBe(tricky)
  })

  it('id and messageId are generated independently', () => {
    const seen: string[] = []
    const gen = () => {
      const id = `id-${seen.length + 1}`
      seen.push(id)
      return id
    }
    const body = buildReplyBody('text', gen)
    // Two distinct generated ids — envelope id and messageId
    expect(body.id).toBe('id-1')
    expect(body.params.message.messageId).toBe('id-2')
    expect(body.id).not.toBe(body.params.message.messageId)
  })

  it('default id generator produces UUIDs (not predictable)', () => {
    const a = buildReplyBody('test')
    const b = buildReplyBody('test')
    // Two calls produce different ids
    expect(a.id).not.toBe(b.id)
    // UUID v4 shape: 8-4-4-4-12 hex with version 4
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})
