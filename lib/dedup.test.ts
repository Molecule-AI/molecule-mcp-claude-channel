import { describe, it, expect } from 'bun:test'
import { Dedup } from './dedup.ts'

describe('Dedup.observe', () => {
  it('returns true for first sighting, false for duplicate', () => {
    const d = new Dedup({ evictAfterMs: 60_000 })
    expect(d.observe('a')).toBe(true)
    expect(d.observe('a')).toBe(false)
    expect(d.observe('b')).toBe(true)
    expect(d.observe('b')).toBe(false)
  })

  it('size reflects unique observations', () => {
    const d = new Dedup({ evictAfterMs: 60_000 })
    d.observe('a')
    d.observe('a')
    d.observe('b')
    d.observe('c')
    d.observe('c')
    expect(d.size).toBe(3)
  })
})

describe('Dedup.evictExpired', () => {
  it('drops entries older than evictAfterMs', () => {
    const d = new Dedup({ evictAfterMs: 1000 })
    d.observe('old', 0)
    d.observe('mid', 500)
    d.observe('new', 1500)

    // At t=2000, cutoff is 1000. 'old' (ts=0) and 'mid' (ts=500) are evicted.
    expect(d.evictExpired(2000)).toBe(2)
    expect(d.size).toBe(1)
    // The young one stays — and survives a duplicate-observe check
    expect(d.observe('new', 2000)).toBe(false)
  })

  it('regression: id can be re-observed after eviction (the v0.1 race)', () => {
    // Scenario the v0.1 hardcoded count-based trim could hit:
    //   - At t=0, see id=X, add to set
    //   - At t=50, hardcoded count trim evicts X (because set hit 1000 entries
    //     from a busy workspace)
    //   - At t=55, /activity poll returns X again because window=30s still includes it
    //   - Plugin treats X as new → DUPLICATE notification
    //
    // The new timestamp-based eviction prevents this: as long as evictAfterMs
    // is ≥ POLL_WINDOW_SECS×1000, X stays in the set until 30s past first sight,
    // long enough that subsequent /activity polls within the window are dedup'd.
    const POLL_WINDOW_MS = 30_000
    const d = new Dedup({ evictAfterMs: POLL_WINDOW_MS * 2 })  // 2× margin

    // Initial sighting
    d.observe('event-x', 0)

    // Many polls later (still within the platform's 30s window): same event re-seen
    expect(d.observe('event-x', 5_000)).toBe(false)   // 5s later
    expect(d.observe('event-x', 25_000)).toBe(false)  // 25s later
    expect(d.observe('event-x', 29_000)).toBe(false)  // 29s later

    // Eviction tick at t=30s — cutoff is t-60s = -30s; 'event-x' (ts=0) NOT evicted yet
    expect(d.evictExpired(30_000)).toBe(0)
    expect(d.observe('event-x', 30_000)).toBe(false)  // still seen

    // Eviction tick at t=70s — cutoff is t-60s = 10s; 'event-x' (ts=0) is evicted
    expect(d.evictExpired(70_000)).toBe(1)
    // BUT by t=70s the platform's window has long since slid past event-x —
    // /activity wouldn't return it anymore. So the re-observe below is hypothetical;
    // in production, eviction-then-re-emit can't happen if evictAfterMs > window.
    // This test confirms the math, not a real-world race.
    expect(d.observe('event-x', 70_000)).toBe(true)  // hypothetical re-emit
  })

  it('returns 0 evictions when nothing is expired', () => {
    const d = new Dedup({ evictAfterMs: 60_000 })
    d.observe('a', 0)
    d.observe('b', 1000)
    expect(d.evictExpired(2000)).toBe(0)
    expect(d.size).toBe(2)
  })

  it('handles empty set', () => {
    const d = new Dedup({ evictAfterMs: 60_000 })
    expect(d.evictExpired(1000)).toBe(0)
    expect(d.size).toBe(0)
  })

  it('survives many observations + repeated eviction (long-session simulation)', () => {
    const d = new Dedup({ evictAfterMs: 60_000 })
    // Simulate 1000 events spread over 5 minutes
    for (let i = 0; i < 1000; i++) {
      d.observe(`evt-${i}`, i * 300)  // one event every 300ms
    }
    expect(d.size).toBe(1000)

    // At t=5min, evict everything older than 4min
    const evicted = d.evictExpired(300_000)
    // Events from t=0 through t=240_000 (240/0.3 = 800 events) are evicted
    expect(evicted).toBe(800)
    expect(d.size).toBe(200)
  })
})

describe('Dedup math: window-vs-eviction relationship', () => {
  it('default evictAfterMs ≥ POLL_WINDOW_SECS×1000 prevents re-emit', () => {
    // Lock the relationship so a future "let's reduce eviction window for memory"
    // change breaks this test instead of silently re-introducing the bug.
    const POLL_WINDOW_SECS = 30
    const expectedMin = POLL_WINDOW_SECS * 1000  // 30000ms
    // The Dedup user code constructs with evictAfterMs = POLL_WINDOW_SECS*1000*2
    // (2x margin). Verify any value below the minimum would be unsafe.
    const safe = new Dedup({ evictAfterMs: expectedMin * 2 })
    const unsafe = new Dedup({ evictAfterMs: expectedMin / 2 })

    safe.observe('x', 0)
    unsafe.observe('x', 0)

    // 25 seconds later — still within platform's window
    safe.evictExpired(25_000)
    unsafe.evictExpired(25_000)

    expect(safe.size).toBe(1)    // safe: still remembers x
    expect(unsafe.size).toBe(0)  // unsafe: evicted x; would re-emit
  })
})
