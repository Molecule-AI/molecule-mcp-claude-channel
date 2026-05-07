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

This plugin distributes through the Claude Code marketplace flow. From any shell:

```bash
# 1. Add the marketplace (one-time per machine)
claude plugin marketplace add https://git.moleculesai.app/molecule-ai/molecule-mcp-claude-channel.git

# 2. Install the plugin
claude plugin install molecule@molecule-channel
```

`molecule` is the plugin name (from `.claude-plugin/plugin.json`); `molecule-channel` is the marketplace name (from `.claude-plugin/marketplace.json`). Both live in the same repo — installing the marketplace makes the plugin available; installing the plugin enables it for your sessions.

To pin a specific version, append `#<tag>` to the marketplace URL — for example `…/molecule-mcp-claude-channel.git#v0.4.0-gitea.3`. Without a ref, you track `main`.

> **Note for users coming from the GitHub install path**: the GitHub `Molecule-AI` org was suspended on 2026-05-06 and is permanently gone. The earlier `claude --channels plugin:molecule@Molecule-AI/...` invocation no longer resolves. The new path (above) is the canonical replacement; behavior is unchanged.
>
> **Don't use the `claude --channels plugin:…` one-liner.** It silently no-ops on Claude Code 2.1.129 (and likely 2.1.x in general). The marketplace flow above is the only path that actually registers the plugin. If a previous setup guide pointed you at `claude --channels plugin:molecule@…`, ignore it.

### Allowing the channel via `allowedChannelPlugins`

The Claude Code host gates channel-plugin notifications behind an explicit allow-list. The plugin won't deliver `notifications/claude/channel` events to your session unless this list contains an entry that matches.

**Schema.** `allowedChannelPlugins` is an array of **objects**, not strings. The shape is `{ "plugin": "<plugin-name>", "marketplace": "<marketplace-name>" }`. The host's Zod validator silently ignores entries that aren't objects in this shape — so a bare-string entry like `"molecule"` or `"molecule@molecule-channel"` will load without error and contribute nothing to the allow-list. The symptom: poll loop runs cleanly, cursor advances, stderr says "delivered", and the message never reaches the conversation.

For this plugin, the entry is:

```json
{ "plugin": "molecule", "marketplace": "molecule-channel" }
```

**Location.** `allowedChannelPlugins` only takes effect from the **managed-settings** file:

- macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
- Linux: `/etc/claude-code/managed-settings.json`
- Windows: `C:\ProgramData\ClaudeCode\managed-settings.json`

Putting it in your user-level `~/.claude/settings.json` (or `~/.claude/settings.local.json`) does **not** work — the host reads the field only from the managed location. Most self-hosters try the user-level file first; this is the single most common reason a freshly-installed channel plugin appears to do nothing. The managed-settings file may need `sudo` to edit on macOS/Linux.

A minimal working `managed-settings.json`:

```json
{
  "allowedChannelPlugins": [
    { "plugin": "molecule", "marketplace": "molecule-channel" }
  ]
}
```

After editing, restart Claude Code (or `/reload-plugins`) for the host to re-read the file.

On first launch the plugin creates `~/.claude/channels/molecule/` and exits with a config-missing error pointing at `.env`. Fill it in:

```
# ~/.claude/channels/molecule/.env

# Required
MOLECULE_PLATFORM_URL=https://your-tenant.staging.moleculesai.app
MOLECULE_WORKSPACE_IDS=ws-uuid-1,ws-uuid-2
MOLECULE_WORKSPACE_TOKENS=tok-1,tok-2

# Optional
MOLECULE_POLL_INTERVAL_MS=5000     # default 5s
MOLECULE_POLL_WINDOW_SECS=30       # default 30s — only used to seed the first-run cursor
MOLECULE_AGENT_NAME="Claude Code (channel)"           # how the workspace appears in canvas
MOLECULE_AGENT_DESC="Local Claude Code session..."
MOLECULE_AUTO_REGISTER_POLL=true   # set to "false" if you've configured the workspace another way
MOLECULE_HEARTBEAT_INTERVAL_MS=30000  # default 30s — keeps the canvas presence badge on "online"; set to 0 to disable
```

The `.env` file is `chmod 600` after first read; tokens never appear in environment-block-style `claude doctor` dumps.

Re-launch Claude Code:

```bash
claude
```

(After the one-time `marketplace add` + `plugin install` above, the plugin loads automatically on every `claude` invocation; no per-launch flag needed.)

You should see on stderr:

```
molecule channel: connected — watching 2 workspace(s) at https://your-tenant.staging.moleculesai.app
  workspaces: ws-uuid-1, ws-uuid-2
  poll: every 5000ms with 30s window
```

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

## How replies work

When a peer's message lands in your session, the meta block carries the routing data Claude needs:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "Hey, can you take a look at this? <issue body>",
    "meta": {
      "source": "molecule",
      "workspace_id": "ws-uuid-1",
      "watching_as": "ws-uuid-1",
      "peer_id": "ws-uuid-pm-coordinator",
      "method": "user_message",
      "activity_id": "act-...",
      "ts": "2026-04-29T..."
    }
  }
}
```

Claude can call `reply_to_workspace({peer_id, text})` to send the response back. If only one workspace is watched, `workspace_id` is implicit. Multi-workspace setups need the watched id explicitly.

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

Single-file MCP server. The whole bridge lives in `server.ts`. Open issues at [molecule-ai/molecule-mcp-claude-channel](https://git.moleculesai.app/molecule-ai/molecule-mcp-claude-channel/issues).

## License

Apache-2.0 — see LICENSE.
