// Regression tests for peer-enrich.ts — covers the boundary cases that
// historically bit the Python equivalent (a2a_client.enrich_peer_metadata):
// negative caching on registry failure, TTL eviction, malformed peer_id
// rejection, and degraded-but-non-blocking behaviour on transport faults.
//
// All tests inject a fake fetch + clock so they run hermetically — never
// hitting real network and never depending on wall time. _resetPeerCache
// is called per-test so cache state from a sibling test can't leak.

import { describe, expect, it, beforeEach } from 'bun:test'
import {
  agentCardUrlFor,
  enrichPeerMetadata,
  validatePeerId,
  _resetPeerCache,
} from './peer-enrich.ts'

const VALID_PEER = 'a1b2c3d4-e5f6-4789-9abc-def012345678'
const PLATFORM = 'https://staging-api.moleculesai.app'
const TOKEN = 'tok-test'

beforeEach(() => {
  _resetPeerCache()
})

describe('validatePeerId', () => {
  it('accepts canonical UUID v1-v5', () => {
    expect(validatePeerId(VALID_PEER)).toBe(VALID_PEER)
  })
  it('lowercases the result so cache keys are stable', () => {
    expect(validatePeerId(VALID_PEER.toUpperCase())).toBe(VALID_PEER)
  })
  it.each([
    ['empty string', ''],
    ['path traversal', '../../etc/passwd'],
    ['embedded quote', `${VALID_PEER}"injected`],
    ['control byte', `${VALID_PEER.slice(0, -1)}\x00`],
    ['non-UUID alpha', 'not-a-uuid'],
    ['UUID v0 (invalid version nibble)', '00000000-0000-0000-0000-000000000000'],
    ['missing hyphens', 'a1b2c3d4e5f647899abcdef012345678'],
  ])('rejects %s', (_label, bad) => {
    expect(validatePeerId(bad)).toBeNull()
  })
})

describe('agentCardUrlFor', () => {
  it('builds the discover URL for a valid peer', () => {
    expect(agentCardUrlFor(VALID_PEER, PLATFORM)).toBe(
      `${PLATFORM}/registry/discover/${VALID_PEER}`,
    )
  })
  it('strips trailing slash from platform URL so the path is canonical', () => {
    expect(agentCardUrlFor(VALID_PEER, `${PLATFORM}/`)).toBe(
      `${PLATFORM}/registry/discover/${VALID_PEER}`,
    )
  })
  it('returns empty string for invalid peer id (refuses to interpolate)', () => {
    expect(agentCardUrlFor('../etc', PLATFORM)).toBe('')
    expect(agentCardUrlFor('', PLATFORM)).toBe('')
  })
})

describe('enrichPeerMetadata — happy path + cache hit', () => {
  it('returns the registry record on first fetch and caches subsequent calls', async () => {
    let calls = 0
    const fakeFetch = async () => {
      calls++
      return new Response(
        JSON.stringify({ id: VALID_PEER, name: 'ops-agent', role: 'sre' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    const r1 = await enrichPeerMetadata(VALID_PEER, PLATFORM, TOKEN, {
      fetch: fakeFetch as unknown as typeof fetch,
      now: () => 1000,
    })
    expect(r1).toEqual({ id: VALID_PEER, name: 'ops-agent', role: 'sre' })
    expect(calls).toBe(1)

    // Second call within TTL — cached.
    const r2 = await enrichPeerMetadata(VALID_PEER, PLATFORM, TOKEN, {
      fetch: fakeFetch as unknown as typeof fetch,
      now: () => 1500,
    })
    expect(r2).toEqual({ id: VALID_PEER, name: 'ops-agent', role: 'sre' })
    expect(calls).toBe(1)
  })

  it('re-fetches after TTL expires (5 min)', async () => {
    let calls = 0
    const fakeFetch = async () => {
      calls++
      return new Response(JSON.stringify({ id: VALID_PEER, name: `name-${calls}` }), {
        status: 200,
      })
    }
    await enrichPeerMetadata(VALID_PEER, PLATFORM, TOKEN, {
      fetch: fakeFetch as unknown as typeof fetch,
      now: () => 0,
    })
    const r2 = await enrichPeerMetadata(VALID_PEER, PLATFORM, TOKEN, {
      fetch: fakeFetch as unknown as typeof fetch,
      // 5 min + 1 ms past first fetch — should evict.
      now: () => 5 * 60 * 1000 + 1,
    })
    expect(r2?.name).toBe('name-2')
    expect(calls).toBe(2)
  })
})

describe('enrichPeerMetadata — negative caching (regression-critical)', () => {
  it('caches network failure as null for the TTL window', async () => {
    let calls = 0
    const fakeFetch = async (): Promise<Response> => {
      calls++
      throw new Error('connection refused')
    }
    const r1 = await enrichPeerMetadata(VALID_PEER, PLATFORM, TOKEN, {
      fetch: fakeFetch as unknown as typeof fetch,
      now: () => 0,
    })
    expect(r1).toBeNull()
    expect(calls).toBe(1)

    // Within TTL — must NOT re-fire. Without negative caching, every push
    // from a flaky/missing peer would burn a 2s GET, defeating the
    // cache's whole purpose for the failure scenarios it most needs to defend.
    const r2 = await enrichPeerMetadata(VALID_PEER, PLATFORM, TOKEN, {
      fetch: fakeFetch as unknown as typeof fetch,
      now: () => 100,
    })
    expect(r2).toBeNull()
    expect(calls).toBe(1)
  })

  it('caches non-200 responses as null', async () => {
    let calls = 0
    const fakeFetch = async () => {
      calls++
      return new Response('Not Found', { status: 404 })
    }
    await enrichPeerMetadata(VALID_PEER, PLATFORM, TOKEN, {
      fetch: fakeFetch as unknown as typeof fetch,
      now: () => 0,
    })
    await enrichPeerMetadata(VALID_PEER, PLATFORM, TOKEN, {
      fetch: fakeFetch as unknown as typeof fetch,
      now: () => 100,
    })
    expect(calls).toBe(1)
  })

  it('caches non-JSON 200 as null (registry returning HTML/text by mistake)', async () => {
    let calls = 0
    const fakeFetch = async () => {
      calls++
      return new Response('<html>...', { status: 200 })
    }
    const r = await enrichPeerMetadata(VALID_PEER, PLATFORM, TOKEN, {
      fetch: fakeFetch as unknown as typeof fetch,
      now: () => 0,
    })
    expect(r).toBeNull()
  })

  it('caches non-object JSON (e.g. registry returning array) as null', async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify(['not', 'an', 'object']), { status: 200 })
    const r = await enrichPeerMetadata(VALID_PEER, PLATFORM, TOKEN, {
      fetch: fakeFetch as unknown as typeof fetch,
      now: () => 0,
    })
    expect(r).toBeNull()
  })
})

describe('enrichPeerMetadata — boundary checks', () => {
  it('returns null + skips fetch entirely for invalid peer_id', async () => {
    let called = false
    const fakeFetch = async () => {
      called = true
      return new Response('{}', { status: 200 })
    }
    const r = await enrichPeerMetadata('../etc/passwd', PLATFORM, TOKEN, {
      fetch: fakeFetch as unknown as typeof fetch,
    })
    expect(r).toBeNull()
    expect(called).toBe(false)
  })

  it('sends Authorization + Origin headers (Origin needed for SaaS edge WAF)', async () => {
    let captured: Headers | null = null
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      captured = init?.headers as Headers
      return new Response(JSON.stringify({ id: VALID_PEER }), { status: 200 })
    }
    await enrichPeerMetadata(VALID_PEER, PLATFORM, TOKEN, {
      fetch: fakeFetch as unknown as typeof fetch,
    })
    // Memory: reference_saas_waf_origin_header — without Origin, /registry/*
    // is rewritten to Next.js and returns empty 404. Pinning explicitly so
    // a refactor that drops it doesn't silently regress to the same
    // misdiagnosis path that bit the workspace runtime before PR #2413.
    expect((captured as unknown as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`)
    expect((captured as unknown as Record<string, string>)['Origin']).toBe(PLATFORM)
  })
})
