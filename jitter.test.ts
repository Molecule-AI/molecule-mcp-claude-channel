// jitter.test.ts — bounds contract for computeJitteredInterval.
// The original inline `Math.floor((Math.random() - 0.5) * 0.2 *
// intervalMs)` was untestable because Math.random isn't seedable;
// extracting the helper with optional random injection lets us pin
// the contract a regression would otherwise silently break.

import { describe, expect, test } from 'bun:test'
import { computeJitteredInterval } from './jitter.ts'

describe('computeJitteredInterval — bounds contract', () => {
  test('random=0.5 returns intervalMs unchanged (the midpoint, no jitter)', () => {
    // The midpoint of [0,1) maps to no offset. Pinning this catches
    // a refactor that accidentally drops the `- 0.5` re-centering
    // and turns the helper into "intervalMs + 0..2*factor*intervalMs"
    // (always-positive, always-bigger-than-baseline).
    expect(computeJitteredInterval(1000, { random: () => 0.5 })).toBe(1000)
  })

  test('random=0 returns the lower bound (intervalMs - factor*intervalMs)', () => {
    // 0 → -0.5 → -factor*intervalMs offset. With factor=0.1 + base 1000,
    // expect 900.
    expect(computeJitteredInterval(1000, { random: () => 0 })).toBe(900)
  })

  test('random just under 1 returns just under the upper bound', () => {
    // Math.random's spec is [0, 1) — 1 itself never occurs. The OPEN
    // upper bound means the exact +factor*intervalMs is never hit; one
    // less. With factor=0.1 + base 1000, expect 1099 (since
    // floor((0.99999 - 0.5) * 0.2 * 1000) = floor(99.998) = 99).
    const r = computeJitteredInterval(1000, { random: () => 0.99999 })
    expect(r).toBeGreaterThanOrEqual(1099)
    expect(r).toBeLessThan(1100)
  })

  test('default factor is 0.1 (the herd-avoidance budget v0.4.1 picked)', () => {
    // Caller-with-no-opts MUST get the same behavior as caller passing
    // factor=0.1 explicitly. A regression that silently changed the
    // default factor would otherwise only surface in production
    // tail-latency anomalies.
    const withDefault = computeJitteredInterval(1000, { random: () => 0.25 })
    const withExplicit = computeJitteredInterval(1000, { random: () => 0.25, factor: 0.1 })
    expect(withDefault).toBe(withExplicit)
  })

  test('larger factor widens the range proportionally', () => {
    // Discriminating: if a refactor accidentally hard-codes 0.1 instead
    // of using opts.factor, this test goes red. With factor=0.5 +
    // random=0, expect intervalMs - 0.5*intervalMs = 500.
    expect(computeJitteredInterval(1000, { random: () => 0, factor: 0.5 })).toBe(500)
  })

  test('factor=0 is the no-jitter degenerate case', () => {
    // For operators who want to opt out of jitter entirely (e.g. for a
    // deterministic reproduction). Both random extremes collapse to
    // intervalMs.
    expect(computeJitteredInterval(1000, { random: () => 0, factor: 0 })).toBe(1000)
    expect(computeJitteredInterval(1000, { random: () => 0.99, factor: 0 })).toBe(1000)
  })

  test('20 random samples all stay within [intervalMs * (1 - factor), intervalMs * (1 + factor))', () => {
    // Sanity check using the real Math.random — proves the helper as
    // wired into production cannot produce out-of-bounds offsets.
    // 20 samples is enough to catch a "factor doubled" regression
    // statistically (would yield ~10 samples outside the tight band).
    const intervalMs = 5000
    const factor = 0.1
    for (let i = 0; i < 20; i++) {
      const r = computeJitteredInterval(intervalMs, { factor })
      expect(r).toBeGreaterThanOrEqual(intervalMs * (1 - factor))
      expect(r).toBeLessThan(intervalMs * (1 + factor))
    }
  })

  test('larger intervalMs scales the absolute jitter linearly (factor is relative)', () => {
    // If a refactor broke the multiplication and made jitter absolute
    // (e.g. always ±100ms regardless of intervalMs), this test goes
    // red. With random=0 + factor=0.1: 1000ms → 900, 10000ms → 9000.
    expect(computeJitteredInterval(1000, { random: () => 0 })).toBe(900)
    expect(computeJitteredInterval(10000, { random: () => 0 })).toBe(9000)
  })
})
