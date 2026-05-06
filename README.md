# molecule-mcp-claude-channel

Claude Code channel plugin for [Molecule AI](https://moleculesai.app). Bridges Molecule A2A traffic into a Claude Code session: peer messages from your watched workspaces surface as conversation turns, and your replies route back through Molecule's A2A.

## What it does

When you launch Claude Code with this plugin enabled and configure it to watch one or more Molecule workspaces, every A2A message your watched workspaces receive shows up in the session as a user-turn. You reply normally; the plugin's MCP `reply_to_workspace` tool sends the response back through Molecule.

```
Molecule peer ──A2A──> [your workspace] ──poll──> [this plugin] ──MCP notification──> Claude Code session
                                  ^                                                     │
                                  └────────── POST /workspaces/:id/a2a ◄── reply_to_workspace tool ──┘
```

No tunnel. No public endpoint. The plugin self-registers each watched workspace as `delivery_mode=poll` on startup and then long-polls `/workspaces/:id/activity?since_id=<cursor>` for new A2A traffic. Replies POST back to `/workspaces/:peer_id/a2a` via the same bearer token.

## Install

Install via the [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) flow:

```
/plugin marketplace add Molecule-AI/molecule-mcp-claude-channel
/plugin install molecule-channel@molecule-mcp-claude-channel
```

`/reload-plugins` to activate the plugin in the current session (or restart Claude Code).

On first MCP-server launch the plugin creates `~/.claude/channels/molecule/` and exits with a config-missing error pointing at `.env`. Fill it in:

```
# ~/.claude/channels/molecule/.env

# Required (single-tenant — every watched workspace lives on the same Molecule tenant)
MOLECULE_PLATFORM_URL=https://your-tenant.staging.moleculesai.app
MOLECULE_WORKSPACE_IDS=ws-uuid-1,ws-uuid-2
MOLECULE_WORKSPACE_TOKENS=tok-1,tok-2

# Required (multi-tenant — watched workspaces span multiple Molecule tenants)
# Replace MOLECULE_PLATFORM_URL with a comma-separated list, same order as IDS:
# MOLECULE_PLATFORM_URLS=https://personal.moleculesai.app,https://team.moleculesai.app
# MOLECULE_WORKSPACE_IDS=ws-personal,ws-team
# MOLECULE_WORKSPACE_TOKENS=tok-personal,tok-team

# Optional
MOLECULE_POLL_INTERVAL_MS=5000     # default 5s
MOLECULE_POLL_WINDOW_SECS=30       # default 30s — only used to seed the first-run cursor
MOLECULE_AGENT_NAME="Claude Code (channel)"           # how the workspace appears in canvas
MOLECULE_AGENT_DESC="Local Claude Code session..."
MOLECULE_AUTO_REGISTER_POLL=true   # set to "false" if you've configured the workspace another way
```

The `.env` file is `chmod 600` after first read; tokens never appear in environment-block-style `claude doctor` dumps.

The config dir name (`molecule`) is intentionally NOT renamed in v0.4 even though the plugin is now `molecule-channel` — the rename would silently lose every existing user's `.env` on upgrade. The dir name is only visible if you're editing the `.env` manually.

### Multi-tenant: watch workspaces across multiple Molecule tenants

If your watched workspaces live on different Molecule tenants (a personal subdomain + a team subdomain, say), use `MOLECULE_PLATFORM_URLS` (plural) instead of `MOLECULE_PLATFORM_URL` (singular). One URL per workspace, same order as `MOLECULE_WORKSPACE_IDS`:

```
MOLECULE_PLATFORM_URLS=https://personal.moleculesai.app,https://team.moleculesai.app
MOLECULE_WORKSPACE_IDS=ws-uuid-personal,ws-uuid-team
MOLECULE_WORKSPACE_TOKENS=tok-personal,tok-team
```

The plural shape and the singular shape are mutually exclusive — when both are set, the plural wins. The plural's parity check is strict: `MOLECULE_PLATFORM_URLS` MUST have the same number of entries as `MOLECULE_WORKSPACE_IDS`, otherwise the plugin refuses to start (a missing entry would otherwise silently route through the wrong tenant). The singular shape is preserved for back-compat with single-tenant users — no `.env` changes needed on upgrade.

Cross-tenant `delegate_task` is NOT supported: a watched workspace can only delegate to peers on its own tenant. The `peer_id` in `reply_to_workspace` must also be a peer of the watching workspace's tenant. Closes [#3013 issue 4](https://github.com/Molecule-AI/molecule-core/issues/3013).

Restart Claude Code or run `/reload-plugins`. You should see on stderr:

```
molecule channel: connected — watching 2 workspace(s) at https://your-tenant.staging.moleculesai.app
  workspaces: ws-uuid-1, ws-uuid-2
  poll: every 5000ms with 30s window
```

Confirm the MCP server is registered: run `/mcp` and look for `molecule-channel`. If you previously had a Molecule MCP server named `molecule` in `~/.claude/settings.json`, it stays — `molecule-channel` does not collide with it (this rename closes [#3013](https://github.com/Molecule-AI/molecule-core/issues/3013)).

### Migrating from pre-0.4

Pre-0.4 docs suggested an undocumented `claude --channels plugin:NAME@OWNER/REPO` syntax that silently no-op'd on Claude Code 2.1.x ([#3013](https://github.com/Molecule-AI/molecule-core/issues/3013)). v0.4 ships the standard marketplace install path above.

If you had the pre-0.4 plugin somehow installed under the name `molecule`, uninstall it before installing `molecule-channel`:

```
/plugin uninstall molecule@molecule-mcp-claude-channel
/plugin install   molecule-channel@molecule-mcp-claude-channel
```

Your `.env` at `~/.claude/channels/molecule/.env` is preserved.

## Getting workspace_id + token

Every Molecule workspace has a workspace-scoped bearer that authenticates against `/activity` (read) and `/a2a` (write). Two ways to get one:

### From Canvas (recommended)

1. Open the workspace in Canvas
2. Settings tab → "Auth tokens" → **Create channel token**
3. Copy the workspace_id (UUID at the top) and the token (shown once)

### From the API

```bash
curl -X POST "$MOLECULE_PLATFORM_URL/admin/workspaces/$WORKSPACE_ID/tokens" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "claude-channel"}'
```

### Token rotation

Rotate when:

- you suspect compromise (token logged accidentally, `.env` shared, laptop lost)
- a teammate with `.env` access leaves the org
- the token has been in use long enough to want a fresh one (no hard expiry on platform-issued workspace tokens; rotate at your own cadence)

How:

1. Canvas → workspace → Settings → "Auth tokens" → **revoke** the old token
2. Same surface → **Create channel token** → copy the new value
3. Update `MOLECULE_WORKSPACE_TOKENS` in `~/.claude/channels/molecule/.env` (multi-workspace: same comma-separated order as `MOLECULE_WORKSPACE_IDS` — replace just the entry being rotated)
4. Restart Claude Code (or `/reload-plugins`); the plugin re-reads `.env` on startup

Revoke happens server-side immediately. The plugin's next poll against the revoked token returns 401, the polling loop logs the failure with the workspace id (and the platform URL — see v0.4.1), and the operator sees the rotation didn't fully complete.

### `.env` is host-local

Each host running this plugin (your laptop, a second workstation, a personal devbox) needs its own `~/.claude/channels/molecule/.env`. Tokens aren't synced — by design, since a stolen token shouldn't auto-grant access from another machine. Multi-workspace fan-out (`MOLECULE_WORKSPACE_IDS=a,b,c`) lives within ONE host's `.env`; running the same plugin on a second host with the same `.env` is supported but means both hosts will compete on the dedup state for those workspaces (the second host wins by writing the PID file later — there's a singleton lock per `.env` directory).

## How replies work

When a peer's message lands in your session, both the rendered `content` and the structured `meta` block carry the routing data Claude needs:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "[from ops-agent (sre) · peer_id=ws-uuid-pm-coordinator · watching=ws-uuid-1]\nHey, can you take a look at this? <issue body>\n↩ Reply: reply_to_workspace({workspace_id: \"ws-uuid-1\", peer_id: \"ws-uuid-pm-coordinator\", text: \"...\"})",
    "meta": {
      "source": "molecule",
      "workspace_id": "ws-uuid-1",
      "watching_as": "ws-uuid-1",
      "peer_id": "ws-uuid-pm-coordinator",
      "peer_name": "ops-agent",
      "peer_role": "sre",
      "agent_card_url": "https://your-tenant.staging.moleculesai.app/registry/discover/ws-uuid-pm-coordinator",
      "method": "user_message",
      "activity_id": "act-...",
      "ts": "2026-04-29T..."
    }
  }
}
```

`content` is the conversation turn Claude reads. The plugin wraps the raw inbound text with two extra lines:

- A header (`[from <identity> · peer_id=<uuid> · watching=<uuid>]`) so Claude can tell who's talking without parsing `meta`.
- A reply hint (`↩ Reply: reply_to_workspace({...})`) showing the exact tool call shape needed to respond. Routing differs by sender kind:
  - **canvas_user** (typed in the canvas chat) → `reply_to_workspace({workspace_id, text})` — no `peer_id`, lands in the user's chat panel.
  - **peer_agent** (A2A from another workspace) → `reply_to_workspace({workspace_id, peer_id, text})` — sends a JSON-RPC reply to the calling peer.

`peer_name` and `peer_role` come from the registry (`/registry/discover/<peer_id>`) and are sanitised before being interpolated into `content` — control characters, brackets, and newlines are stripped to prevent a maliciously-registered name from injecting pseudo-instructions into the conversation turn. Both fields may be absent if the registry lookup fails (e.g. the peer hasn't registered yet); `agent_card_url` is always populated because it's computed deterministically from `peer_id`.

Single-watch setups can omit `workspace_id` from the reply call (it defaults to the only watched workspace). Multi-workspace setups need it explicitly — the header surfaces it so Claude doesn't have to guess.

## Architecture notes

### Why polling instead of push?

The existing external-agent integration in Molecule originally used **push**: register an inbound URL, platform POSTs A2A to that URL. That's lower latency but requires a tunnel (ngrok/Cloudflare) or a static IP — non-trivial for a laptop-launched Claude Code session.

The platform now supports `delivery_mode=poll` natively (`#2339` in `molecule-core`): when a workspace is registered with `delivery_mode=poll`, the platform's a2a_proxy short-circuits inbound A2A directly into `activity_logs` instead of attempting an HTTP dispatch. This plugin sets that mode automatically on startup, so peer messages land in `activity_logs` regardless of whether your laptop has a public URL.

### Cursor-based polling (v0.2+)

v0.2 switched from a v0.1-style time-window dedup (`since_secs=30` + in-memory seen-id Set) to a Telegram-shaped cursor:

```
GET /workspaces/:id/activity?since_id=<last-delivered>&limit=100
  → ASC-ordered rows strictly after the cursor
  → 410 Gone if the cursor row was pruned (plugin re-seeds automatically)
```

The cursor is persisted to `~/.claude/channels/molecule/cursor.json` (`chmod 600`, atomic temp+rename writes), so a restart resumes exactly where the previous session left off — no replay window, no missed messages, no growing in-memory dedup set.

`MOLECULE_POLL_WINDOW_SECS` is only used to seed the first-ever cursor for a workspace: on the very first poll the plugin asks for the most-recent event in that window and remembers its id WITHOUT delivering it (events that arrived BEFORE you started this Claude session are out of context). Every subsequent poll uses the cursor.

### Singleton lock

Only one channel server can poll a given workspace set at a time — multiple instances would race the dedup state and double-deliver. The plugin maintains a PID file at `~/.claude/channels/molecule/bot.pid` and on startup kills any stale predecessor (matches the telegram channel pattern).

### File attachments

A2A messages can carry `Part` entries with `url` and `media_type`. The MVP delivers attachments by-reference (URL surfaces in the meta block, Claude can fetch via the workspace_secrets-scoped token); inline image-content delivery (mirroring telegram's `image_path` mechanism) is a v0.2 feature.

## Limitations (v0.2)

- **Polling-only inbound.** Latency floor is `MOLECULE_POLL_INTERVAL_MS` (default 5s). Push mode is still possible by setting `MOLECULE_AUTO_REGISTER_POLL=false` and configuring the workspace with `delivery_mode=push` + a routable URL via canvas.
- **No pairing flow.** Tokens are configured manually via `.env`; no canvas-side approval handshake.
- **No file-attachment download.** URLs surface in the meta block; the host fetches on-demand.
- **No outbound channel-init.** The plugin only sends replies (in response to inbound A2A); starting a fresh A2A conversation initiated FROM the channel side requires a future `start_workspace_chat` tool.

## Compatibility

- **molecule-runtime/workspace-server**: requires `delivery_mode=poll` support (`/registry/register` + a2a_proxy short-circuit, molecule-core PRs #2348 + #2353) and the `since_id` cursor on `GET /activity` (PR #2354). All three shipped under issue #2339, available staging-onward. The plugin probes for cursor support on startup (sends a known-invalid UUID, expects `410 Gone`) and exits with code 2 if the platform predates PR #2354 — silent re-delivery is a worse failure mode than failing to start. `401`/`403`/`404`/`5xx` from the probe are treated as inconclusive (orthogonal to cursor support — usually a token, workspace_id, or transient-network issue) and the plugin continues to the poll loop where the real failure surfaces with workspace-level context.
- **Claude Code**: tested against the channel-plugin contract that expects `notifications/claude/channel` with `{content, meta}` (matches `@claude-plugins-official/telegram` v0.0.6).
- **bun**: the MCP server runs under bun for fast startup; `package.json` `start` does `bun install --no-summary && bun server.ts` so no global install needed.

## Contributing

Single-file MCP server. The whole bridge lives in `server.ts`. Open issues at [Molecule-AI/molecule-mcp-claude-channel](https://github.com/Molecule-AI/molecule-mcp-claude-channel/issues).

## License

Apache-2.0 — see LICENSE.
