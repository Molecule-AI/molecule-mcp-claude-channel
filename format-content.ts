// format-content — prepend a structured header + reply-tool hint to the
// message text Claude Code surfaces as the conversation turn.
//
// Why: Claude Code renders `notifications/claude/channel` as
// `← molecule: <content>`. Without context in `content`, Claude has to
// remember (a) who sent the message, (b) which tool to call to reply,
// and (c) which routing arg to pass. That's three pieces of meta the
// model has to reconstruct from the meta block — and in practice tools
// are often forgotten across turns. Putting it in `content` makes the
// reply path self-documenting at the cost of ~80 extra chars per turn.
//
// Tradeoff acknowledged: this couples display to behaviour. Operators
// who don't want the header can compose without it (formatHeader is
// pure + exported). The default emit path includes it because the
// memory `feedback_doc_tool_alignment` warns specifically against
// shipping a docs-promised behaviour the code doesn't deliver — the
// README has documented these meta fields since 2026-05-02 but the
// inline rendering never reflected them.

export type ChannelKind = 'canvas_user' | 'peer_agent'

export interface FormatChannelContentArgs {
  // The raw text extracted from the activity row's request_body. This is
  // what extractText returns — assumed already trimmed but otherwise
  // verbatim user/peer prose.
  text: string
  kind: ChannelKind
  // Watched workspace id this push belongs to. Single-watch setups can
  // omit `workspace_id` from the reply tool call; we still emit it so
  // multi-watch users see the disambiguation up front.
  watchingAs: string
  // peer_id + (optional) registry-resolved name/role. Empty peerId
  // signals canvas_user kind regardless of what's claimed by `kind`,
  // since the reply tool routes purely on peer_id presence. Caller is
  // expected to keep them in sync.
  peerId: string
  peerName?: string
  peerRole?: string
}

export function formatChannelContent(args: FormatChannelContentArgs): string {
  const header = formatHeader(args)
  const hint = formatReplyHint(args)
  return `${header}\n${args.text}\n${hint}`
}

export function formatHeader(args: FormatChannelContentArgs): string {
  if (args.kind === 'canvas_user') {
    // Canvas-user pushes don't carry a peer_id (the platform sends them
    // with source_id=null). The "workspace=" disambiguator matters when
    // an operator watches several workspaces from the same Claude Code
    // session — without it, replies route to whatever workspace the
    // model assumes is current.
    return `[from canvas user · workspace=${args.watchingAs}]`
  }

  // peer_agent. Compose `name (role)` when we have both, name alone if
  // only the name resolved, "peer-agent" as the last resort. Avoid
  // surfacing the bare uuid in the human-facing line — it's still in the
  // meta block for tool calls. peer_id IS shown so the reply call has a
  // copyable value without needing to round-trip through meta.
  let identity = 'peer-agent'
  if (args.peerName && args.peerRole) {
    identity = `${args.peerName} (${args.peerRole})`
  } else if (args.peerName) {
    identity = args.peerName
  }
  return `[from ${identity} · peer_id=${args.peerId} · watching=${args.watchingAs}]`
}

export function formatReplyHint(args: FormatChannelContentArgs): string {
  // Reply path differs by kind:
  //   canvas_user → reply_to_workspace with no peer_id (routes to /notify
  //                 and lands in the canvas chat panel)
  //   peer_agent  → reply_to_workspace with peer_id (routes to /a2a as a
  //                 proper JSON-RPC reply)
  //
  // The TS template strings here mirror the channel plugin's actual tool
  // surface (server.ts:reply_to_workspace) — drift between this hint and
  // the tool name is the bug class memory `feedback_doc_tool_alignment`
  // exists to defend against, so the hint and the @tool live in the same
  // PR.
  if (args.kind === 'canvas_user') {
    return `↩ Reply: reply_to_workspace({workspace_id: "${args.watchingAs}", text: "..."})`
  }
  return `↩ Reply: reply_to_workspace({workspace_id: "${args.watchingAs}", peer_id: "${args.peerId}", text: "..."})`
}
