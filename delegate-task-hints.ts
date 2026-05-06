// delegate-task-hints.ts — pure helpers for delegate_task error
// messages, kept out of server.ts so the wording is testable without
// the boot side-effects (PID lock, env validation, MCP transport
// connect).
//
// Same factoring pattern as error-format.ts (formatRemovedWorkspaceError)
// + format-content.ts (formatChannelContent). Each error string the
// operator might paste into a bug report is a unit-tested string
// constant; that's the only way to keep wording stable across
// refactors when there's no display surface.

/**
 * The exact hint appended to delegate_task's error when a 404 fires in
 * multi-tenant mode. Closes a parked item from
 * Molecule-AI/molecule-core#3013.
 *
 * Surfaces three actionable pieces of info:
 *   1. The cross-tenant limitation (so the operator stops
 *      cross-tenant troubleshooting, like wondering if the peer's
 *      token rotated).
 *   2. The watching tenant the request actually went to (so a
 *      typo in MOLECULE_PLATFORM_URLS surfaces — e.g. "I expected
 *      tenant-b but the request hit tenant-a").
 *   3. The exact list_peers call shape to enumerate valid peers
 *      from the watching tenant's view.
 */
export function delegateTaskMultiTenantHint(
  watchingWorkspaceId: string,
  watchingPlatformUrl: string,
): string {
  return (
    ` — note: in multi-tenant mode (MOLECULE_PLATFORM_URLS), delegate_task ` +
    `must target a peer on the SAME tenant as the watching workspace (${watchingPlatformUrl}). ` +
    `Cross-tenant delegation is not supported by the platform's a2a_proxy. ` +
    `Run list_peers({workspace_id: "${watchingWorkspaceId}"}) to see peers on this tenant.`
  )
}
