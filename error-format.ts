// Pure formatter — kept in its own module so unit tests can import it
// without triggering server.ts's boot-time side-effects (env validation,
// PID-file lock, MCP transport connect, top-level await). molecule-core#2429.

export function formatRemovedWorkspaceError(
  workspaceId: string,
  body: { id?: string; removed_at?: string; hint?: string } | null | undefined,
): string {
  const safeBody = body ?? {}
  const id = safeBody.id ?? workspaceId
  const hint = safeBody.hint ?? 'Regenerate workspace + token from the canvas → Tokens tab.'
  const removed = safeBody.removed_at ? ` at ${safeBody.removed_at}` : ''
  return `Workspace ${id} was deleted on the platform${removed}. ${hint}`
}
