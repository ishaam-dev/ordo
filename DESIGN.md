# Ordo — Architecture

**What it is.** A local app that watches two Slack workspaces for DMs and @-mentions of the
user, shows them as one feed prioritized by urgency, where each thread is pre-analyzed by an
AI harness (why it matters, summary, suggested action, context pulled from the user's local
MCP servers), and lets the user discuss any thread with that same harness and send a reply
back to Slack from an explicit button click. The harness is pluggable and defaults to Claude
Code (§4). Everything runs on the user's Mac.

This document describes what is built. `README.md` is the user-facing guide, `docs/ux.md`
is the UI spec, `docs/harness-providers.md` is the full design of the AI-harness layer, and
`CLAUDE.md` is the working guide for agents.

## Shape

One Node process (TypeScript, run directly by `tsx` — there is no build step), plus an
optional Electron shell that spawns that same process as a child.

```
 Workspace A ──Socket Mode──┐        catch-up sweep (src/backfill.ts)
 Workspace B ──Socket Mode──┤        conversations.list / .history / .replies
                            ▼                    │
                  ┌─────────────────────┐        │
                  │ Ingest  (Bolt v5)   │◀───────┘  same filter + store path
                  │ filter → normalize  │
                  └──────────┬──────────┘
                             ▼
                  ┌──────────────────────────────────────┐
                  │ SQLite — node:sqlite, one file       │
                  │ threads · messages · analyses        │
                  │ sync_state · chat_sessions/messages  │
                  └──────────┬───────────────────────────┘
                             ▼ threads whose analysis is missing or stale
                  ┌──────────────────────────────────────┐
                  │ Analyzer — serial, one thread/run    │
                  │      │ core decides tool access      │
                  │      ▼                               │
                  │ src/harness/ — provider contract:    │
                  │ claude-code (default) · pi · codex   │
                  └──────────┬───────────────────────────┘
                             ▼ urgency · why · summary · action · session_id
   ┌───────────────── Express, bound to 127.0.0.1:5252 ─────────────────┐
   │ GET /api/feed · /api/thread/:id · /api/status                      │
   │ POST /api/thread/:id/status · /reanalyze                           │
   │ GET/POST /api/thread/:id/chat  (SSE stream, harness resume/fork)   │
   │ POST /api/thread/:id/reply  ──────────────▶ chat.postMessage       │
   └────────────────────────────┬───────────────────────────────────────┘
                                │ HTTP + SSE
        ┌───────────────────────┴────────────────────────┐
        │ public/index.html + chat.js (vanilla, no build)│
        │ shown in a browser, or in the Electron window  │
        └────────────────────────────────────────────────┘
                                ▲
                  electron/ — menubar app: supervises or attaches to
                  the server, polls /api/feed + /api/status, notifies
```

Modules: `src/config.ts` `db.ts` `ingest.ts` `backfill.ts` `analyzer.ts` `chat.ts`
`health.ts` `server.ts` `index.ts`, plus `src/harness/` — the AI-harness layer (§4), which
imports nothing from the rest of the app.

## 1. Ingest — live events

- One Slack app per workspace from the same `manifest.json` (two installs, no public OAuth
  redirect). Socket Mode, so no public URL or tunnel.
- **User-token scopes**, not bot scopes: a bot only sees channels it is invited to, a user
  token sees exactly what the user sees. Manifest user scopes: `channels:history`,
  `channels:read`, `groups:history`, `groups:read`, `im:history`, `im:read`,
  `mpim:history`, `mpim:read`, `users:read`, `chat:write`. Events: `message.channels`,
  `message.groups`, `message.im`, `message.mpim`.
  Note `search:read` is deliberately **not** requested — see §2.
- **`ignoreSelf: false` is load-bearing.** Bolt's default self-filter drops events whose
  `event.user` is the token owner; with a *user* token that owner is the user, so their own
  replies never arrived and the analyzer saw one-sided transcripts. Own messages are still
  never allowed to create a thread or mark one unread — that rule lives in `ingestMessage`,
  not in Bolt.
- Keep rules, applied to every event and to every backfilled message by the same function:
  (a) DMs / group DMs, (b) contains `<@me>`, (c) a reply in a thread already tracked.
  Everything else is dropped, nothing stored. Mentions are detected in `text` (both `<@U1>`
  and `<@U1|name>`) *and* by walking `blocks` for `{type:'user'}` — rich-text clients put
  the mention only in blocks.
- **DM threads are keyed on the conversation, not the message.** `thread_ts = channel_id`
  for DMs, so a back-and-forth is one accumulating card carrying both sides; threaded
  replies inside a DM fold into it. Channel mentions keep the real `thread_ts`. Existing
  databases were folded into this shape by an idempotent, transactional migration
  (`migrateDmThreadKeys`, `VACUUM INTO` backup first).
- **Edits and deletions** (`message_changed` / `message_deleted` / `tombstone`) rewrite the
  stored text or replace it with `(deleted)` and stamp `deleted_at`, then mark the analysis
  stale so it re-runs. Neither touches `status` or `last_activity` — a typo fix must not
  reopen a finished thread. Link-preview `message_changed` events (text unchanged) are
  ignored. An edit that *adds* an `@me` is re-offered to the normal filter, because that
  edit genuinely is news.
- Thread insert is `ON CONFLICT DO NOTHING` + re-read: two events for the same brand-new
  thread race through the async channel/permalink lookups, and the loser must still store
  its message rather than die on a UNIQUE violation. Socket Mode never redelivers, so a
  message dropped here is gone forever.

## 2. Catch-up sync (`src/backfill.ts`) — why it must exist

**Socket Mode never replays events missed while disconnected.** Anything that arrived with
the laptop closed was lost forever. The sweep asks Slack for what was missed and pushes each
message through the *same* filter and store path as a live event, so dedup, thread creation,
status and analysis behave identically.

- Runs on **startup**, on **socket reconnect**, on **wake** (a heartbeat tick arriving >3min
  late means the machine was suspended), and on a **15-min timer** (every 4th is promoted to
  a full sweep, so roughly hourly).
- Per-conversation high-water marks live in `sync_state`. A sweep starts from the stored
  mark, else the newest stored message, else 3 days back.
- DMs come from `conversations.list(im,mpim)` → `conversations.history`. Mentions would
  ideally come from `search.messages`, but that needs `search:read`, which these tokens do
  not have (it returns `missing_scope`), so it is probed once per process and falls back to
  `users.conversations(public_channel,private_channel)` → `conversations.history` filtered by
  the normal mention rule. Threaded replies never appear in `conversations.history`, so a
  capped number of `conversations.replies` calls covers them.
- Bounds so a long absence cannot hammer the API: 2-day first lookback, 30-day hard ceiling,
  60 DM conversations, 40 channels, 3 pages per conversation, capped reply fetches, calls
  serialized at ~1.2s (`conversations.history` is Tier 3, ~50/min). 429s are handled by the
  Slack client's own Retry-After honouring.
- A conversation whose messages failed to store leaves its mark unadvanced, so the window is
  re-offered next sweep; dedup makes that cheap.

### The watch-start rule — what counts as unread

The sweep imports up to three days of history on first run, and every one of those used to
land unread: opening the app for the first time looked like sixteen emergencies, all of them
things already read in Slack days earlier.

Each workspace records, **once and forever**, the moment it first successfully connected
(`sync_state`, reserved key `workspace/__watch_start__`). A swept message older than that
mark is stored in full but does **not** mark its conversation unread. Everything else — every
live message, and anything the sweep finds that arrived after watching began, e.g. overnight
— is unread as before.

So "unread" means *arrived since this app has been watching your Slack*, which is what the
badge, the blue dot and the notifications all count. Existing databases got a one-time
cleanup (`markPreWatchThreadsSeen`, guarded by a marker row, `VACUUM INTO` backup first)
that marked pre-watch threads read.

## 3. Store (`src/db.ts`)

Node's built-in **`node:sqlite`** (`DatabaseSync`) — no native module, no build step. WAL,
foreign keys on, `busy_timeout = 5000` because the dev server, the packaged app and a test
boot can all have the file open while the sweep writes in bursts.

| Table | Contents |
|---|---|
| `threads` | workspace, team/channel names, `channel_id`, `thread_ts`, kind (`dm`\|`mention`), status (`new`\|`seen`\|`done`), `last_activity`, permalink. Unique on (workspace, channel_id, thread_ts) |
| `messages` | thread_id, ts, author, text, raw JSON, `deleted_at`. Unique on (thread_id, ts) |
| `analyses` | one row per thread: urgency, why, summary, suggested_action, context_notes, `covered_through_ts`, `analyzed_at`, `session_id` (the analyzer's harness session, which chat forks when it can) |
| `sync_state` | catch-up high-water marks, plus the reserved watch-start and one-time-migration marker rows |
| `chat_sessions`, `chat_messages` | created and owned by `src/chat.ts` through its own handle |

Migration policy, because `data.db` is live user data: **additive only** — `ALTER TABLE ADD
COLUMN` guarded by a column check, `CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`, never a table
rebuild. Anything that *mutates* rows takes a `VACUUM INTO` backup first (a plain file copy
would miss the WAL), runs inside `BEGIN IMMEDIATE`, is idempotent, and re-checks its work
inside the transaction because a second instance may have already done it. Migrations run on
import and a failure is logged and swallowed — the app must still start.

`status` would be a `CHECK` constraint, but SQLite cannot add one without rebuilding the
table, so two `BEFORE INSERT/UPDATE` triggers enforce it instead. `last_activity` only ever
moves forward, so a backfilled old message cannot drag the feed's ordering backwards.

## 4. The AI harness layer (`src/harness/`)

Analysis and chat run through a **provider contract**, not through a vendor SDK. `claude-code`
is the default and its behaviour is what it always was; `pi` and `codex` ship as data presets
of one generic CLI provider. Adding a harness is a preset file plus one registry line. The full
design — the alternatives considered, the flag research per harness, the risk table — is
**[docs/harness-providers.md](docs/harness-providers.md)**; this section is the shape.

```
src/harness/
  types.ts        the contract: HarnessProvider, ToolPolicy, HarnessEvent, failures
  index.ts        REGISTRY, defineHarness(), selectHarness(), readiness cache, preflight
  policy.ts       the ONE tool policy: name rules, call budget, resolveToolAccess()
  probe.ts        the safety-proof runner: scratch dir + network canary + verdict
  env.ts          sanitizeEnv() + the COPILOT_HARNESS_* switches — the only file here
                  allowed to read process.env
  json.ts copy.ts extractJsonObject(); the plain-English failure copy
  claude-code.ts  provider — the Agent SDK, wrapped
  cli.ts          provider factory — generic spawn + JSONL parse, driven by a CliSpec
  dialects.ts     EVENT_DIALECTS: claude-stream-json | pi-json | codex-jsonl | text
  presets/pi.ts presets/codex.ts   data only, no logic
```

**The contract.** A provider is `identity` + `capabilities` + `envPolicy` + three methods:
`available(env)` (never throws), `run(req)` (an async iterable of `HarnessEvent` that ends
with exactly one `result` or throws, honours `req.abort`, and touches neither the database nor
Slack nor stdout), and `classifyError(err)` (its own error text → a `FailureKind` plus *its
own* fix command). Events are one union for both call sites: `session · text · message · tool
· result`. `defineHarness()` re-checks the required fields at import time, so a malformed
provider fails at boot rather than mid-run.

**Tool safety is the security-critical part.** `ToolPolicy` has exactly two variants —
`no-tools` and `read-only` — and *both* require a runnable `SafetyProof`. There is deliberately
no third variant, so "tools on, unenforced" is not a state an adapter author can express.

- **Core decides tool access; the adapter only wires it in.** `resolveToolAccess(provider,
  purpose)` in `policy.ts` returns the run's `ToolAccess`, and a `read-only` provider gets it
  *only if its safety proof passed in this process* — anything else gets `{mode:'none'}`, a gate
  that refuses everything. Forgetting to be safe is not an available mistake.
- The gate itself is core's: MCP-only names, a mutation-word regex, and a per-run budget (5
  calls for analysis, 8 for chat). It hands back two wordings — one for the harness's per-call
  permission callback, one for a second enforcement net — plus a stateless `nameGate` for that
  second net, which must never consume budget.
- **The proof is executed, not documented.** `probe.ts` creates a scratch directory, opens a
  local HTTP canary, and runs the provider's proof against an injection corpus (write a file,
  fetch the canary, obey an instruction hidden in text shaped like a Slack transcript). Then it
  inspects the directory and the canary **itself** — the provider's observation is a report, not
  evidence — and a read-only provider that refused nothing fails too. A failed proof marks the
  harness unavailable and the analyzer stays idle, which is exactly what should happen the day a
  sandbox bypass ships. `npm run harness:probe [id] [--live]` is the same machinery on demand.
- Claude Code's proof drives the adapter's *real* wiring (`buildOptions` → `canUseTool` +
  `PreToolUse`), so the three-way enforcement cannot rot into a decorative stub.

**Config resolution.** `COPILOT_HARNESS` (default `claude-code`; `claude` and `claude-code-sdk`
alias to it), `COPILOT_HARNESS_COMMAND`, `COPILOT_HARNESS_MODEL`, `COPILOT_HARNESS_SPEND_OK`.
Two failures, two responses, and the distinction is deliberate:

- **Unknown id** is a *config* error. `selectHarness()` throws in `src/index.ts` before the
  server listens, printing the ids that exist. Falling back silently would bill the wrong
  account and hide the typo.
- **Known id, unavailable now** (binary missing, not signed in, proof failing) is an
  *environment* error. The app starts; ingest, the feed and the send path all keep working; the
  analyzer reports it in plain English with that harness's own fix command. This is how "Claude
  isn't signed in on this Mac" has always behaved and it must not regress into a crash.

Readiness (`available()` + the proof) is cached per harness — 5 min when ok, 30 s when not —
and `ensureHarnessReady()` is the single gate in front of every run.

**Capabilities drive degradation, not `if (harness === …)`.** `planSession()` picks
`resume` → `fork` → `seed` from `resumeSession`/`forkSession`; a harness that cannot fork
deliberately seeds rather than resuming the analyzer's session, because appending chat turns
there would poison the seed every future chat starts from. `streaming: false` means core
buffers and emits one message — the SSE contract is unchanged. `mcpInheritance: false` means no
calendar/task context. `billing: 'api-key'` gates the background analyzer (§5).
`limitationsFor()` renders all of it as plain English for `/api/status`.

**Environment hygiene** is `env.ts` and nowhere else. `SLACK_*` is dropped last and
unconditionally, so no provider can re-admit a real user token into a model subprocess. Deny
lists are per-provider because one blanket list would collide: Claude Code strips `CLAUDE*` and
`ANTHROPIC_BASE_URL` (nested-session markers that make the child defer auth to a host session
that is not there), while Pi authenticates with `ANTHROPIC_API_KEY` — a single `ANTHROPIC*`
rule would destroy the credential of the harness that needs it. CLI providers spawn
with no shell, argv arrays only, the prompt over **stdin** (argv is world-readable in `ps`), and
an abort that kills the process group.

## 5. Analyzer (`src/analyzer.ts`)

A serial worker: 15s tick, a thread must be quiet for 45s before it is picked up, 5-minute
backoff after a failure, one run at a time, 180s hard timeout, ≤8 turns. It writes
`{urgency, why, summary, suggested_action, context_notes}` plus the session id to `analyses`.
`covered_through_ts` is read at the *start* of a run, so a reply landing mid-analysis leaves
the thread stale and re-queues it.

- Prompt: workspace/channel/kind, the user's identity, and the transcript inside explicit
  `BEGIN/END SLACK TRANSCRIPT (untrusted data)` markers, capped at 8k chars, newest kept.
  Output contract is one bare JSON object; the parser extracts the first balanced `{…}` so a
  stray fence does not fail the run, and a malformed answer is classified as `bad_output`
  rather than "it never answered".
- **Read-only, and not the analyzer's call to make.** Thread text is attacker-controlled input,
  so the run asks core for its access (`resolveToolAccess(provider, 'analysis')`, §4) and passes
  it to the provider, which wires it into its own enforcement points. For `claude-code` that is
  still three ways — `tools: ['ToolSearch']` (the read-only discovery stub that keeps MCP
  schemas deferred out of context) + `disallowedTools`, a `canUseTool` gate, and a `PreToolUse`
  hook that fires even for tools a user setting auto-allows — but all three now read the one
  core gate: `mcp__*` names only, no mutation words, ≤5 calls per run. A harness that has not
  proved it is safe gets no tools at all instead.
- `settingSources: ['user']` — the Claude adapter's choice: the user's global Claude Code config
  and their MCP servers, not this repo's project settings. An analysis is not a coding session.
- Subprocess env comes from `sanitizeEnv(provider)` (§4): `SLACK_*` always dropped, plus the
  selected harness's own nested-session markers.
- **Spend guard.** The analyzer is a background loop over every thread, which is where money
  gets spent. A provider whose `billing` is `api-key` (Pi, Codex) does not start it at all
  unless `COPILOT_HARNESS_SPEND_OK=1`; without it the worker enters the existing `disabled`
  state with a plain-English reason. Chat, being one deliberate click, is unaffected.
- `POST /api/thread/:id/reanalyze` clears a thread's backoff and jumps it to the front of the
  queue — it never runs inline, so the one-at-a-time rule holds.
- `ANALYZER_DISABLED=1` turns the whole worker off; `/api/status` then reports `disabled`.

## 6. Chat and the send path (`src/chat.ts`)

Three routes, mounted under `/api` so they inherit the Host allowlist and the per-run token:
`GET /api/thread/:id/chat` (history), `POST /api/thread/:id/chat` (one turn, streamed),
`POST /api/thread/:id/reply` (the send).

- **SSE, not WebSocket.** A WS handshake cannot carry the `x-copilot-token` header and
  bypasses CORS entirely, so it would have needed its own Origin/Host/token checks to be
  equally safe. Streaming is Server-Sent Events over the same authenticated POST, which the
  browser issues with `fetch()` + `ReadableStream`.
- **Session handling** is core's decision, made from capabilities by `planSession()` (§4):
  resume our own stored session (`chat_sessions`) if there is one and the harness can resume;
  otherwise **fork** the analyzer's session for that thread, so chat starts already knowing the
  thread and its reasoning while the analyzer's transcript stays intact; otherwise start fresh
  with transcript + analysis seeded into the first prompt. A harness that cannot fork seeds
  rather than resuming the analyzer's session — appending chat turns there would poison the
  seed. A resume that fails falls back to the seeded path exactly once, and only when the
  *session* looks like the problem, never for auth/budget/rate-limit/timeout. `GET
  /api/thread/:id/chat` returns the resulting `session_mode` so the panel can say "it already
  has this thread" only when that is true.
- **Draft protocol.** Claude wraps any proposed reply in a fenced ```` ```draft ```` block.
  The server parses it (one implementation, used for both the live stream and stored
  history), lifts closed blocks into `drafts[]` and removes them from the prose. A malformed
  or unclosed fence stays in the prose as plain text — a bad turn degrades to "Claude said
  something" rather than breaking the panel.
- **Sending is deliberately not a model tool**, and there is no draft id. The bytes posted to
  `chat.postMessage` come from the request body of a separate endpoint — i.e. from the
  textarea the user just looked at and could edit — fired by a button labelled with the
  destination. Chat sessions run with no built-in tools beyond the read-only tool-discovery
  stub, so the model cannot reach that endpoint. DM threads post with **no** `thread_ts` (sending `thread_ts = channel_id`
  would create a bogus thread). `COPILOT_REPLY_DRYRUN=1` exercises the whole path without
  touching Slack.
- Same core-decided read-only access as the analyzer (`purpose: 'chat'` — 8 tool calls/turn
  instead of 5), 240s timeout, ≤12 turns. One in-flight turn per thread; a second POST is
  refused, not queued.
- The turn is an event pump over `provider.run()`: `text` deltas become SSE `delta` frames,
  whole `message` events are collected as the authoritative reply. A harness with
  `streaming: false` simply emits one `message` at the end, so the SSE contract and the panel
  need no per-harness branch.
- Two bugs worth remembering: the abort must hang off **`res`**, not `req` — a request whose
  body has been parsed emits `close` on `req` immediately and aborted every turn before a
  single token; and a dead Claude login arrives as an ordinary-looking assistant message
  with a structural `error` field, which without special handling renders plumbing failure
  as Claude's answer. The second one is now the `claude-code` adapter's problem: it throws a
  `ClassifiedError`, and a structural failure beats anything already streamed.

## 7. Health and failure reporting (`src/health.ts`, `GET /api/status`)

Analyzer failures used to be visible only as a `console.warn` in a terminal nobody looks at,
so a thread sat under a spinning "Analyzing…" forever. An in-process registry now holds the
analyzer's state (`idle` | `analyzing` | `disabled` | `error`), queue depth, last success,
last failure, and per-workspace ingest state fed from the Socket-Mode lifecycle events.

Failures are classified into `auth` | `budget` | `rate_limit` | `timeout` | `bad_output` |
`unknown` — the union is the UI contract — each with a plain-English message, a hint, and an
exact command when a command is the fix. The split follows §4: **which bucket** an error text
belongs to is the harness's own knowledge and lives in `provider.classifyError()`, along with
its own fix command; the **wording** stays centralised in `src/harness/copy.ts`, parameterised
by the harness's short name, so a Codex user is never told to run `claude auth login`.
Classification is structural where we control the throw site (`ClassifiedError`) and
text-matching for SDK/CLI strings — that regex list is maintenance-sensitive, and a real
failure showing up as `unknown` means new wording to add to that provider. `bad_output` is the
one bucket that stays in `health.ts`, because it describes *our* JSON contract ("it answered,
we could not read it") and must mean the same thing for every harness.

`/api/status` carries a top-level `harness` block: id, label, blurb, whether it is available,
its version, its tool mode and mechanism, the safety-proof verdict, the raw capability flags,
and `limitations[]` — those capabilities rendered as plain English for a non-technical reader.

`workspaces[].registered: false` means ingest has not reported yet and is deliberately
different from claiming a connection — the UI renders no dot at all for those. The registry
holds no secrets and no message text; it is served over the API and rendered in a browser.

## 8. Web UI (`public/`)

A single vanilla `index.html` (markup + CSS + the feed/thread logic) plus `chat.js` and
`chat.css` for the chat pane. No React, no Vite, no bundler, no build step — the server
serves the file and injects the API token into it. Three panes: feed / thread / chat, with
`j k enter e u c s esc 1 2 3 ?` keyboard triage, polled every 5s. Details and rationale are
in `docs/ux.md`.

`chat.js` attaches by replacing the three inert globals (`openChat`/`closeChat`/`renderChat`)
that `index.html` ships, so every existing call site drives the real panel without
`index.html` having to change.

## 9. Mac app (`electron/`)

An Electron shell around the server — it does not re-implement or import anything from
`src/`. It spawns the project's own entry point as a child process
(`node --import tsx <projectDir>/src/index.ts --copilot-managed`), so the packaged app always
runs whatever is currently in `src/` and reads `.env` / `data.db` from the project folder.

- `supervisor.js` probes `127.0.0.1:5252` first. If a Ordo server is already
  answering (someone's `npm run dev`) it **attaches** — never spawns a second one, never
  kills it on quit. A server it started in a previous run is recognised by the
  `--copilot-managed` marker and adopted; a dev server can never match that. Its own child
  is restarted with backoff (1s → 60s).
- `watcher.js` polls `/api/feed` and `/api/status` every 15s, obtaining the per-run token the
  same way the page does (fetch `/`, read the injected value; never logged, never written to
  disk). Notifications are P0/P1 only, still-unread only, once per thread ever, ≤3 at a time
  then a summary, and **nothing at all on the very first run** — every pre-existing
  conversation is adopted silently, whether or not Claude has rated it yet. Adopting only the
  already-urgent ones left a trap: on a first run nothing is rated, so nothing was adopted,
  and the whole backlog turned P0/P1 minutes later and fired a wave.
- `main.js` owns the menubar icon (filled = healthy, hollow = starting, crossed = broken,
  with the urgent count as the title), the window, deep links (`#/t/<id>` from a notification
  click), login-item registration re-asserted after reinstall, and pause/re-probe around
  `powerMonitor` sleep/wake. Slack state in the menu comes from `/api/status`, not from
  scraping the server's stdout — scraping yields nothing when attached to a server it did not
  start.
- Icons are drawn from code at build time (`scripts/make-icons.mjs`); no binary assets in git.

## 10. Security model

The threat that shaped this: **DNS rebinding**. A security review found `/api/*` answered
requests with a forged `Host` header, so any site the user visited could rebind DNS to
127.0.0.1 and read their Slack DMs — and, once the reply endpoint landed, send messages as
them.

- **Host allowlist** middleware, mounted ahead of every route including static files: only
  `127.0.0.1:<port>` and `localhost:<port>`, compared against the raw Host header. A page can
  point its own hostname at 127.0.0.1 but cannot change the Host header the browser sends.
- **Per-run bearer token**: 32 random bytes minted at process start, never persisted, never
  logged, injected into `index.html` at serve time and required on every `/api/*` request as
  `x-copilot-token` (compared with `timingSafeEqual`). It is not a cookie, so the browser
  never attaches it automatically to cross-site requests. The page reloads once on a 401 to
  recover after a server restart.
- Server binds to `127.0.0.1` only. `x-powered-by` disabled. `express.json()` is mounted
  *after* the token check and only under `/api`, so a malformed body cannot reach the parser
  unauthenticated; `/api` errors answer in JSON, never an HTML stack trace.
- Slack-controlled text is untrusted everywhere: prepared statements only, escaping on every
  DOM insertion (`chat.js` never assigns `innerHTML`), and "Open in Slack" renders only for
  `http(s)` permalinks so a `javascript:` permalink is inert.
- Model sessions are read-only by a decision core makes and the harness only wires in, and no
  harness gets tool access at all until its safety proof has passed on this machine (§4). Their
  subprocess env is stripped of `SLACK_*` last and unconditionally. Nothing is ever posted to
  Slack without a click. Nothing logs message text, draft text or tokens — the reply audit line
  records destination and character count only, and a harness's stderr is kept as a truncated
  tail for the failure detail rather than printed, because a harness may echo the prompt.

## Key decisions

| Decision | Why |
|---|---|
| Socket Mode over HTTP events | No public URL or tunnel; fully local |
| User tokens over bot tokens | A bot cannot see the user's DMs/mentions |
| `ignoreSelf: false` | With a user token, Bolt's "bot user" *is* the user, so their own replies were being dropped |
| Catch-up sweep alongside Socket Mode | Socket Mode never replays what was missed while disconnected |
| `node:sqlite` over better-sqlite3 | Built into Node ≥22; no native module, no build step |
| Vanilla HTML/JS over React+Vite | One user, one screen, no build step to keep the packaged app honest |
| One harness for analysis *and* chat | One integration; reuses the local login, MCP config, tool loop and resumable sessions of whatever the user already runs |
| A provider contract instead of the SDK inline | Read-only enforcement had no seam and so had never been executed by a test; core can now decide tool access, and a fake provider can drive the real analyzer and the real chat route |
| Every tool posture must carry a runnable proof | A capability claim is an obligation, not documentation — and the proof fails loudly the day a sandbox bypass ships |
| Presets over adapters (`pi`, `codex`) | Their headless modes are line-oriented JSON, so they are data against one generic CLI provider |
| Chat forks the analyzer's session, when the harness can | Starts knowing the thread and its verdict, without corrupting the analyzer's transcript; capability-gated, and a harness that cannot fork seeds instead |
| SSE over WebSocket | A WS handshake cannot carry the auth header and bypasses CORS |
| Send is an endpoint, not a tool | The model can never reach it; the posted bytes are the ones the user saw |
| Electron child process, not a bundled copy | The app always runs current `src/`, and cannot drift from the dev setup |

## What is built / what is not

Built: ingest for both workspaces, catch-up sync, the watch-start rule, edits/deletes,
analyzer with read-only MCP context, the pluggable harness layer with `claude-code`, `pi` and
`codex`, health reporting, the three-pane web UI, the chat panel with draft-and-confirm
replies, and the packaged Mac app with menubar, notifications and autostart.

Not built, and deliberately so for now: multi-user or any auth beyond the localhost token,
auto-send of anything, a settings UI (the harness is chosen in `.env`, not on screen), search
over history, and notarised distribution (the bundle is ad-hoc signed, hence the first-open
dialog documented in `README.md`). Known UI gaps are listed at the end of `docs/ux.md`; open
questions on the harness layer are at the end of `docs/harness-providers.md`.
