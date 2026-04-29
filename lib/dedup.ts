// Per-workspace dedup state for the activity poll loop.
//
// Each /activity poll returns events from the last `since_secs` window.
// Across consecutive polls the same event id appears repeatedly until the
// window slides past it. The dedup state remembers ids long enough that
// each event surfaces as exactly one MCP notification.
//
// Eviction is BY AGE, not BY COUNT — an entry must stay in the set for at
// least `since_secs` after first sighting, otherwise an event seen at
// second 0 would get evicted at second 50 (count-based trim) and re-emit
// when the next poll's response still includes it within the 30s window.
// The v0.1 implementation used a hardcoded 1000-entry trim that hit this
// race on busy workspaces.
//
// Eviction is a no-op until the set holds entries beyond `evictAfterMs`,
// so on quiet workspaces the dedup state stays bounded organically.

export interface DedupOptions {
  /** Entries older than this (ms since first sighting) are evicted on
   *  the next call to evictExpired(). Should be ≥ POLL_WINDOW_SECS×1000
   *  with margin (2× is generous; 1.5× tighter). */
  evictAfterMs: number
}

export class Dedup {
  private readonly seen = new Map<string, number>()
  constructor(private readonly opts: DedupOptions) {}

  /** Returns true if id is new (caller should emit). False if already seen. */
  observe(id: string, nowMs: number = Date.now()): boolean {
    if (this.seen.has(id)) return false
    this.seen.set(id, nowMs)
    return true
  }

  /** Drop entries older than `evictAfterMs`. Returns count of evicted entries. */
  evictExpired(nowMs: number = Date.now()): number {
    const cutoff = nowMs - this.opts.evictAfterMs
    let evicted = 0
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) {
        this.seen.delete(id)
        evicted++
      }
    }
    return evicted
  }

  /** Current entry count — exposed for diagnostics, not control flow. */
  get size(): number {
    return this.seen.size
  }
}
