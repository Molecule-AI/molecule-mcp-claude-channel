// platform-urls.ts — pure resolver for the per-workspace platform URL list
// added in v0.4 (closes Molecule-AI/molecule-core#3013 issue 4).
//
// Why factored out: server.ts boots top-level (PID lock, .env load,
// process.exit on missing env). Putting the resolver here lets
// platform-urls.test.ts exercise every branch without standing up a
// real server. The single load-bearing decision — "broadcast singular
// or use plural" — needs branch-count coverage so a future regression
// (e.g. silently dropping the singular fallback) fails CI instead of
// shipping.

export interface ResolveInput {
  /** WORKSPACE_IDS, post-trim/filter. */
  workspaceIds: string[]
  /** MOLECULE_PLATFORM_URLS (plural), post-trim/filter/trailing-slash-strip. Empty array if unset. */
  platformUrls: string[]
  /** MOLECULE_PLATFORM_URL (singular), trailing slash stripped. undefined if unset. */
  platformUrl: string | undefined
}

export interface ResolveOk {
  ok: true
  /** Resolved per-workspace URL list, same length as workspaceIds, same order. */
  urls: string[]
  /** True iff the resolution used the plural shape (multi-tenant). */
  multiTenant: boolean
}

export interface ResolveErr {
  ok: false
  /** Human-readable error message; safe to print to stderr verbatim. */
  message: string
}

export type ResolveResult = ResolveOk | ResolveErr

/**
 * Resolve the per-workspace platform URL list.
 *
 * Resolution order (first match wins):
 *   1. plural MOLECULE_PLATFORM_URLS set → use it directly. Length must
 *      equal workspaceIds.length; else error.
 *   2. singular MOLECULE_PLATFORM_URL set → broadcast to every watched
 *      workspace (preserves pre-v0.4 single-tenant behavior verbatim).
 *   3. neither set → error.
 *
 * NOT a back-compat path: when BOTH are set, plural wins and singular
 * is silently ignored. Documented in CHANGELOG; an alternative
 * (singular-as-default-fallback-for-unspecified-entries) was rejected
 * because mixed semantics make the parity check meaningless.
 */
export function resolvePlatformUrls(input: ResolveInput): ResolveResult {
  const { workspaceIds, platformUrls, platformUrl } = input

  if (workspaceIds.length === 0) {
    return {
      ok: false,
      message: 'MOLECULE_WORKSPACE_IDS is empty — set at least one workspace id.',
    }
  }

  // Plural wins — explicit per-workspace routing.
  if (platformUrls.length > 0) {
    if (platformUrls.length !== workspaceIds.length) {
      return {
        ok: false,
        message:
          `MOLECULE_PLATFORM_URLS must have the same number of entries as ` +
          `MOLECULE_WORKSPACE_IDS (got ${platformUrls.length} urls vs ${workspaceIds.length} ids). ` +
          `Either drop MOLECULE_PLATFORM_URLS and use MOLECULE_PLATFORM_URL ` +
          `(single URL fanned out to all watched workspaces), or set MOLECULE_PLATFORM_URLS ` +
          `to a comma-separated list with one entry per workspace_id.`,
      }
    }
    return { ok: true, urls: platformUrls.slice(), multiTenant: hasMixedTenants(platformUrls) }
  }

  // Singular fallback — broadcast.
  if (platformUrl !== undefined && platformUrl.length > 0) {
    return {
      ok: true,
      urls: workspaceIds.map(() => platformUrl),
      multiTenant: false,
    }
  }

  return {
    ok: false,
    message:
      `Either MOLECULE_PLATFORM_URL (single, fanned out to all watched workspaces) ` +
      `or MOLECULE_PLATFORM_URLS (per-workspace, comma-separated, same order as ` +
      `MOLECULE_WORKSPACE_IDS) must be set.`,
  }
}

/**
 * True iff the URL list spans more than one distinct tenant. Used by
 * the startup banner to switch between the single-line "watching N at
 * URL" form and the multi-line per-workspace breakdown.
 *
 * Pure helper so the banner-shape decision is testable without booting.
 */
export function hasMixedTenants(urls: string[]): boolean {
  return new Set(urls).size > 1
}
