# Changelog

## v0.4.2 — testability + SSOT cleanup (closes #30, the 3 weak spots from PR #28)

No behavior change for end users. Internal quality-of-implementation
improvements: every promise made by v0.4.1 now has a discriminating
unit test behind it, and the duplicate predicate is gone.

### Changed (no user-visible behavior)

- **Jitter math extracted to `./jitter.ts` as `computeJitteredInterval`.** The inline `Math.floor((Math.random() - 0.5) * 0.2 * POLL_INTERVAL_MS)` in v0.4.1 was untestable because `Math.random` isn't seedable; `computeJitteredInterval(intervalMs, opts?)` accepts an injected `random` source and an explicit `factor`. 8 new tests pin the bounds contract (default ±10% half-range, midpoint = no jitter, scales linearly with intervalMs, factor=0 opt-out).
- **Duplicate `hasMixedPlatformTenants()` removed** in favour of `hasMixedTenants()` from `./platform-urls.ts`. v0.4.1 unintentionally shipped two implementations of `new Set(urls).size > 1`; consolidating to the platform-urls.ts SSOT (already test-covered there) means a future predicate change lands in one place. Computed once at startup as `MIXED_PLATFORM_TENANTS` since `URL_BY_WORKSPACE` is immutable post-init.
- **Shutdown-drain test now pins the in-flight count, not just the log shape.** v0.4.1's test ran against `https://t.example/` so polls fast-failed before SIGTERM and N=0 was the typical outcome — drain-with-N-pollers was untested. v0.4.2 adds a second test case that spins up a local `Bun.serve` fixture holding poll responses; the test waits until exactly N pollers are observed at the fixture, SIGTERMs, and asserts `draining 2 in-flight poll(s)` literally + the deadline-hit path (drain returns gracefully even when polls are wedged). The original fast-fail test stays as the cheap regression guard for the no-work case.

### Test counts

- 80 → 89 tests across 8 → 9 files (8 new jitter tests + 1 net new shutdown-drain test case for the deterministic in-flight scenario).

## v0.4.1 — channel hygiene (closes #4 + #7 + #9 + 2 parked items from #3013)

No breaking changes; drop-in upgrade from v0.4.0.

### Fixed

- **#4 Shutdown drain.** SIGTERM/SIGINT now stops scheduling new polls, awaits in-flight pollers within an 8s deadline, then exits cleanly. Pre-fix `process.exit(0)` raced against any HTTP fetch mid-flight (verified on hongmingwang tenant 2026-04-30: SIGTERM during a slow `/activity` poll surfaced as a fetch-failed log on the NEXT process boot for the same `activity_id`). Also aligned the file-header docstring to match reality (the pre-fix docstring promised peer-facing notifications that aren't implementable without a platform-side peer-notification API).
- **#7 extractText non-text part visibility.** When a peer's A2A carries non-text parts (image, file, data) alongside text, the plugin now logs `N non-text part(s) in activity X (workspace Y) skipped` to stderr. Pre-fix the parts were filtered silently, so the operator saw the text in the conversation turn but had no idea attachments shipped alongside it were dropped. (Attachment delivery itself is still tracked separately as a v0.5 feature.)
- **#9 Poll-loop thundering herd.** `setInterval` now adds ±10% jitter to `POLL_INTERVAL_MS` so N pollers don't all fire at the same instant after the initial 500ms-stagger converges within ~5min of clock drift. Cadence stays smooth across N watched workspaces.

### Improved

- **Probe / poll / register-as-poll error logs include the platform URL.** Pre-v0.4.1 `poll ws-X fetch failed: ...` named the workspace_id but not the URL, so a multi-tenant misconfiguration (typo in one entry of `MOLECULE_PLATFORM_URLS`) required cross-referencing the startup banner. Now each error log line shows `(${platformUrl})` inline. Closes a parked item from #3013.
- **`delegate_task` 404 hint in multi-tenant mode.** When `delegate_task` returns 404 AND the install is multi-tenant (more than one distinct platform URL across watched workspaces), the error message now appends a hint that cross-tenant delegation is not supported by the platform's `a2a_proxy`, names the watching tenant the request was routed to, and points at `list_peers` for the right peer set. Closes a parked item from #3013.

## v0.4.0 — installable + namespaced (closes Molecule-AI/molecule-core#3013)

**Breaking change.** The MCP server name + plugin name change. If you had any pre-0.4 install, see "Migrating from pre-0.4" in the README.

### Added

- `.claude-plugin/marketplace.json` — the repo is now a single-plugin Claude Code marketplace, so the documented install path works:

      /plugin marketplace add Molecule-AI/molecule-mcp-claude-channel
      /plugin install molecule-channel@molecule-mcp-claude-channel

  Pre-0.4 the README documented `claude --channels plugin:NAME@OWNER/REPO`, which is not in current Claude Code docs and silently no-op'd on 2.1.x.

### Changed

- **MCP server name: `molecule` → `molecule-channel`** (`.mcp.json` `mcpServers.molecule-channel` + `plugin.json` `name`). The pre-0.4 name collided with the standalone `molecule` MCP server many users already have configured in `~/.claude/settings.json` (the target audience for this plugin) — collision silently shadowed the channel's `reply_to_workspace` tool. New name is unambiguous.
- README install section pivots to the standard `/plugin marketplace add` flow, drops the broken `claude --channels` line, adds a "Migrating from pre-0.4" section.

### Not changed (deliberate)

- **State directory stays at `~/.claude/channels/molecule/`** (where `.env`, `cursor.json`, `bot.pid` live). Renaming would silently lose every existing user's `.env` on upgrade. The dir name is internal — only visible if you're editing `.env` manually.
- `meta.source = 'molecule'` in the JSON-RPC envelope. That's the channel-kind identifier the host's plugin handler routes on (parallel to `telegram` channel's `source: 'telegram'`), distinct from the MCP server's process name.
