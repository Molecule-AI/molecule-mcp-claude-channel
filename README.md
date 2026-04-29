# molecule-mcp-claude-channel

Claude Code channel plugin for [Molecule AI](https://moleculesai.app). Bridges Molecule A2A traffic into a Claude Code session: peer messages from your watched workspaces surface as conversation turns, and your replies route back through Molecule's A2A.

> **⚠ v0.1 known limitation (issue #2):** Reply path requires manual peer_id input. The platform currently doesn't surface the sender's workspace_id into the activity log row that the plugin reads ([Molecule-AI/molecule-core#2306](https://github.com/Molecule-AI/molecule-core/issues/2306)), so notifications arrive with `meta.peer_id: ""`. Until the upstream fix lands, replying via `reply_to_workspace` requires Claude (or you) to know the peer's workspace_id from out-of-band context (e.g. canvas chat). Receiving works fully; replies require a manual workspace_id.

## What it does

When you launch Claude Code with this plugin enabled and configure it to watch one or more Molecule workspaces, every A2A message your watched workspaces receive shows up in the session as a user-turn. You reply normally; the plugin's MCP `reply_to_workspace` tool sends the response back through Molecule.

```
Molecule peer ──A2A──> [your workspace] ──poll──> [this plugin] ──MCP notification──> Claude Code session
                                  ^                                                     │
                                  └────────── POST /workspaces/:id/a2a ◄── reply_to_workspace tool ──┘
```

No tunnel. No public endpoint. The plugin polls your tenant for new A2A activity (using the `?since_secs=` filter on `/workspaces/:id/activity`); replies POST back to `/workspaces/:peer_id/a2a` via the same bearer token.

## Step 0 — register an inbound URL for the workspace

**Required.** The plugin polls `/workspaces/:id/activity` for `a2a_receive` events; these events are only created when the platform forwards A2A to the workspace's registered URL. If your workspace has no URL registered, the platform never forwards anything to it, and the plugin sees no events.

This means: **Step 0 is to register a URL** — even if the URL just points at a stub HTTP server that 200s every request. Two paths:

**Option A — local stub (simplest for dev):**
```bash
# Run a stub HTTP server on port 9000 that 200s any POST
python3 -c "
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        l = int(self.headers.get('content-length', 0)); self.rfile.read(l)
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(json.dumps({'jsonrpc':'2.0','id':1,'result':{'parts':[{'type':'text','text':'ok'}]}}).encode())
    def log_message(self,*a): pass
HTTPServer(('127.0.0.1',9000),H).serve_forever()
" &

# Register the workspace's URL (use 'localhost' — SSRF check rejects 127.0.0.1 literal)
curl -X POST "$MOLECULE_PLATFORM_URL/registry/register" \
  -H "Authorization: Bearer $WORKSPACE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"id\":\"$WORKSPACE_ID\",\"url\":\"http://localhost:9000/agent\",\"agent_card\":{\"name\":\"My Claude Code\",\"version\":\"0.1.0\"}}"
```

**Option B — real A2A handler (production):** Use the [Python SDK A2AServer](https://github.com/Molecule-AI/molecule-sdk-python) or any HTTP server that handles A2A JSON-RPC.

Either way, the URL is required because that's how the platform attributes inbound A2A. The plugin handles **surfacing** those events into Claude Code; it does not handle **receiving** A2A in the first place.

## Install

```bash
claude --channels plugin:molecule@Molecule-AI/molecule-mcp-claude-channel
```

On first launch the plugin creates `~/.claude/channels/molecule/` and exits with a config-missing error pointing at `.env`. Fill it in:

```
# ~/.claude/channels/molecule/.env

# Required
MOLECULE_PLATFORM_URL=https://your-tenant.staging.moleculesai.app
MOLECULE_WORKSPACE_IDS=ws-uuid-1,ws-uuid-2
MOLECULE_WORKSPACE_TOKENS=tok-1,tok-2

# Optional
MOLECULE_POLL_INTERVAL_MS=5000     # default 5s
MOLECULE_POLL_WINDOW_SECS=30       # default 30s — overlap protects against missed ticks
```

The `.env` file is `chmod 600` after first read; tokens never appear in environment-block-style `claude doctor` dumps.

Re-launch Claude Code:

```bash
claude --channels plugin:molecule@Molecule-AI/molecule-mcp-claude-channel
```

You should see on stderr:

```
molecule channel: connected — watching 2 workspace(s) at https://your-tenant.staging.moleculesai.app
  workspaces: ws-uuid-1, ws-uuid-2
  poll: every 5000ms with 30s window
```

## Token rotation

Workspace tokens authenticate both polling (`/activity` reads) and replies (`/a2a` posts). Treat them as long-lived secrets:

- **When to rotate:** suspect compromise, leaked `.env`, leaving an org, or after a token has been on a shared/cloud-synced machine
- **How to rotate:**
  1. Canvas → workspace Settings → "Auth tokens" → click revoke on the affected token, then create a new one
  2. Update `MOLECULE_WORKSPACE_TOKENS` in your local `.env` with the new value
  3. Re-launch Claude Code (the plugin re-loads `.env` on startup)
- **Multi-host:** `.env` is host-local; if you run Claude Code on multiple machines watching the same workspace, each host needs its own copy. Don't sync `.env` via Dropbox/iCloud/etc — colocated tokens defeat the rotation isolation.

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

The existing external-agent integration in Molecule uses **push**: register an inbound URL, platform POSTs A2A to that URL. That's lower latency but requires a tunnel (ngrok/Cloudflare) or a static IP — non-trivial for a laptop-launched Claude Code session.

This plugin uses **polling** as the default because it works through every NAT/firewall with zero infra. The cost is up to `MOLECULE_POLL_INTERVAL_MS` (default 5s) of inbound latency. For production setups where lower latency matters, a future `MOLECULE_INBOUND_MODE=push` can opt into the existing register-and-receive flow.

### Why `since_secs=30` overlapping a `5s` poll interval?

A single missed tick (transient network blip, GC pause, laptop sleep) shouldn't lose messages. The plugin re-fetches the last 30 seconds on every poll and dedups by `activity_id`, so 25 seconds of overlap is the recovery margin. Set `MOLECULE_POLL_WINDOW_SECS` higher for noisier networks.

### Singleton lock

Only one channel server can poll a given workspace set at a time — multiple instances would race the dedup state and double-deliver. The plugin maintains a PID file at `~/.claude/channels/molecule/bot.pid` and on startup kills any stale predecessor (matches the telegram channel pattern).

### File attachments

A2A messages can carry `Part` entries with `url` and `media_type`. The MVP delivers attachments by-reference (URL surfaces in the meta block, Claude can fetch via the workspace_secrets-scoped token); inline image-content delivery (mirroring telegram's `image_path` mechanism) is a v0.2 feature.

## Limitations (v0.1)

- **Polling-only inbound.** No push mode yet; latency floor is `MOLECULE_POLL_INTERVAL_MS`.
- **No pairing flow.** Tokens are configured manually via `.env`; no canvas-side approval handshake. Add `MOLECULE_ACCESS_MODE=pair` (mirroring telegram) in v0.2.
- **No file-attachment download.** URLs surface in the meta block; the host fetches on-demand.
- **No outbound channel-init.** The plugin only sends replies (in response to inbound A2A); starting a fresh A2A conversation initiated FROM the channel side requires a future `start_workspace_chat` tool.

## Compatibility

- **molecule-runtime/workspace-server**: requires the `?since_secs=` query parameter on `GET /workspaces/:id/activity` (shipped in molecule-core PR #2300, available staging-onward).
- **Claude Code**: tested against the channel-plugin contract that expects `notifications/claude/channel` with `{content, meta}` (matches `@claude-plugins-official/telegram` v0.0.6).
- **bun**: the MCP server runs under bun for fast startup; `package.json` `start` does `bun install --no-summary && bun server.ts` so no global install needed.

## Contributing

Single-file MCP server. The whole bridge lives in `server.ts`. Open issues at [Molecule-AI/molecule-mcp-claude-channel](https://github.com/Molecule-AI/molecule-mcp-claude-channel/issues).

## License

Apache-2.0 — see LICENSE.
