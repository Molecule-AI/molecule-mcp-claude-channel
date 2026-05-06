// jitter.ts — pure helper for the poll-loop jitter added in v0.4.1
// (closes #9). Extracted to its own module in v0.4.2 (closes #30
// weak spot 2) so the bounds contract is unit-testable: the original
// inline math `Math.floor((Math.random() - 0.5) * 0.2 * intervalMs)`
// was untestable because Math.random isn't seedable, so a regression
// that silently dropped the herd-avoidance budget (e.g. ±10% → ±0%)
// would only have been caught in code review.
//
// Injection pattern: optional `random` source defaulting to
// Math.random. Same shape as Go's `time.Now()` injection
// (Cloudflare's pkg/now), Netflix RxJava's `Schedulers.test()`,
// and Stripe's clocks-via-context. Principle: nondeterminism is a
// dependency, inject it.
//
// Single caller today (server.ts setInterval setup); per "Identify
// the smallest change that achieves the goal. Reject abstractions
// that have only one caller today" — but a pure helper that exposes
// the contract is the smallest change, NOT an abstraction. The
// alternative (a `JitterScheduler` class) would be the abstraction.

export interface JitterOptions {
  /** Fraction of intervalMs to use as the jitter half-range.
   *  e.g. 0.1 → result is in [intervalMs - 0.1*intervalMs, intervalMs + 0.1*intervalMs).
   *  Default 0.1 (the herd-avoidance budget v0.4.1 picked). */
  factor?: number
  /** Random source returning a value in [0, 1). Defaults to Math.random.
   *  Tests pass a deterministic source to pin the bounds contract. */
  random?: () => number
}

/**
 * Return intervalMs with jitter applied. Pure function; same
 * (intervalMs, random) input always produces the same output.
 *
 * Bounds: result is in [intervalMs * (1 - factor), intervalMs * (1 + factor)).
 * The upper bound is OPEN (Math.random returns < 1 by spec), so the
 * exact-positive-extreme is never hit; tests assert just-under.
 *
 * Negative factor or factor > 1 is accepted but degenerate (factor=0
 * → no jitter, factor=1 → result can be 0). The 0.1 default is what
 * v0.4.1 picked — bigger ranges stretch effective tail latency
 * without much herd benefit; smaller ranges don't move the needle.
 */
export function computeJitteredInterval(intervalMs: number, opts: JitterOptions = {}): number {
  const factor = opts.factor ?? 0.1
  const random = opts.random ?? Math.random
  return intervalMs + Math.floor((random() - 0.5) * 2 * factor * intervalMs)
}
