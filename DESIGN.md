# Slack Copilot — Design (v0)

**Goal.** A local app that watches two Slack workspaces for DMs and @-mentions of me, shows them as one feed prioritized by urgency, where each item is pre-analyzed by Claude (why it matters, summary, suggested action, context pulled from MCPs), and lets me open a Claude Code chat about any item — everything running on my machine.

## Architecture

```
 Workspace A ──(Socket Mode)──┐
 Workspace B ──(Socket Mode)──┤
                              ▼
                      ┌──────────────┐        ┌──────────────────┐
                      │   Ingest     │───────▶│   SQLite         │
                      │  (Bolt.js)   │        │ threads/messages │
                      └──────────────┘        └────────┬─────────┘
                                                       │ new / updated threads
                                                       ▼
                      ┌───────────────────────────────────────────┐
                      │ Analyzer — Claude Agent SDK (headless      │
                      │ Claude Code, read-only MCP tools)          │
                      └────────────────────┬──────────────────────┘
                                           │ urgency / summary / context
                                           ▼
 Browser (localhost) ◀──HTTP + WS──  App server (Express)
   feed · thread view · chat  ──────────▶ Chat sessions (Agent SDK, resumable)
```

One TypeScript process (Node), four modules. TypeScript because both `@slack/bolt` and `@anthropic-ai/claude-agent-sdk` are first-class there.

### 1. Ingest
- One Slack app manifest ("Slack Copilot"), created separately in each workspace (two apps, same manifest — avoids needing a public OAuth redirect). Socket Mode enabled, so no public URL or tunnel is needed.
- Installed with **user-token scopes**, not bot scopes — a bot only sees channels it's invited to; the user token sees exactly what I see (my DMs, my channels).
  - Scopes: `im:history`, `mpim:history`, `channels:history`, `groups:history`, `users:read`, `channels:read`
  - User events: `message.im`, `message.mpim`, `message.channels`, `message.groups`
- `message.channels` delivers every message in every channel I'm in — high volume. Filter immediately, keep a message only if:
  - (a) it's a DM / group DM to me,
  - (b) it contains `<@my_user_id>`, or
  - (c) it's a reply in a thread we already track.
  Everything else is dropped on the floor, nothing stored.
- Store normalized messages + the Slack permalink (for deep-linking back into Slack).

### 2. Store (SQLite via better-sqlite3)
- `threads` — workspace, channel id/name, thread_ts, kind (`dm` | `mention`), status (`new` | `seen` | `done`), last_activity, permalink
- `messages` — thread_id, ts, author, text, raw JSON
- `analyses` — thread_id, urgency (`P0`–`P3`), one-line "why", summary, suggested_action, context_notes, covered_through_ts, chat session_id

### 3. Analyzer
- Debounced worker: ~45s after the last message in a thread, run one Agent SDK `query()` for that thread.
- Prompt: thread transcript + participants + my identity/role. Ask for strict JSON: `{urgency, why, summary, suggested_action, context_notes}`. Re-analyze when new replies arrive (feed shows a "stale" badge in the meantime).
- MCP context: the session runs with the local Claude Code MCP config (calendar, email, Asana, Granola, …). Restrict `allowedTools` to read-only tools and cap the tool-call budget (~5 calls) to keep latency and cost sane. This is where "sender is on your 3pm invite" / "relates to Asana task X" comes from.

### 4. App server + UI
- Express + small React (Vite) SPA. Localhost only, no auth.
- **Feed** — cards sorted P0→P3 then recency. Card = workspace/channel badge, sender, snippet, Claude's one-liner, urgency chip, "Open in Slack" link.
- **Thread view** — full transcript + full analysis.
- **Chat** — "Discuss with Claude" starts (or resumes, via stored session id) an Agent SDK session preloaded with the thread; streamed to the browser over WebSocket. Full Claude Code capabilities: it can pull more MCP context or draft a reply mid-conversation.
- **Replies** — Claude drafts; a "Send to Slack" button posts via `chat.postMessage` as me. Nothing is ever sent without an explicit click.

## Key decisions
| Decision | Why |
|---|---|
| Socket Mode over HTTP events | No public URL/tunnel; fully local |
| User tokens over bot tokens | Bot can't see my DMs/mentions; user token sees what I see |
| Agent SDK for analysis *and* chat | One integration; reuses local Claude Code login, MCP config, tool loop, resumable sessions |
| SQLite | Single file, zero ops |
| Human-in-the-loop replies | v1 never auto-sends anything |

## Prerequisites (check before building)
1. **Ability to create/install a custom Slack app with user-token scopes in both workspaces.** Company workspaces often gate app installs behind admin approval — this is the only hard blocker; check it first.
2. Claude Code logged in locally (the Agent SDK reuses that auth).
3. The MCPs wanted for context (calendar, email, Asana, …) added to the **local** Claude Code config — claude.ai connectors don't carry over automatically; remote MCP servers can be added locally via `claude mcp add`.

## Out of scope for v1
Auto-send replies, desktop notifications, historical backfill/search, multi-user/auth, packaging (runs via `npm run dev`).

## Build order
1. Scaffold + Slack app manifest + workspace A ingest → raw items appear in a bare feed. *(De-risks the only risky integration first.)*
2. Workspace B (second install of the same manifest).
3. Analyzer via Agent SDK → urgency-sorted feed with explanations.
4. Chat panel with resumable sessions + draft-reply → confirm-send.
