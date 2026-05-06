# Changelog

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
