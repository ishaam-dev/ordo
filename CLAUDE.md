# Ordo — agent guide

Local, single-user app: watches two Slack workspaces for DMs/@-mentions, stores them in SQLite, analyzes each thread through a pluggable AI harness (default: Claude Code via the Agent SDK), shows an urgency-prioritized feed, and offers a per-thread chat that can draft a reply the user sends with a click. Ships as a menubar Mac app. Architecture: `DESIGN.md`. Harness layer: `docs/harness-providers.md`. UI spec: `docs/ux.md` (+ `docs/ux-mock.html`). User-facing guide: `README.md` (rewritten deliberately — don't "fix" its tone).

## Commands

```bash
npm run dev        # tsx watch src/index.ts — serves http://127.0.0.1:5252
npm start          # same, no watch
npm run typecheck  # tsc --noEmit (keep clean; no build step, tsx runs TS directly)
npm test           # node --test over test/**/*.test.ts; test:watch to iterate
npm run harness:probe   # per-harness: tool posture, availability, safety proof (--live spends a real run)
npm run app:dev    # prepare + run the Electron shell from source
npm run app:build  # package release/mac-arm64/Ordo.app (ad-hoc signed)
npm run app:icons  # regenerate assets/ from code (no binary assets in git)
```

Node is Homebrew v26 at `/opt/homebrew/bin` (prepend to PATH in non-login shells).

Env switches for safe poking: `PORT`, `COPILOT_DB_PATH` (throwaway db), `ANALYZER_DISABLED=1`, `COPILOT_REPLY_DRYRUN=1` (exercise the send path without messaging anyone). Email ingest is **off by default**: `COPILOT_EMAIL=1` turns it on (each poll is a harness run), `COPILOT_EMAIL_POLL_MINUTES` re-paces it (default 30, clamp 5–240), `COPILOT_EMAIL_ADDRESS` names the mailbox (better Gmail deep links + UI label; identity stays in .env, never in code). First poll seeds the 5 most recent threads as 'seen'; after that, new-mail-only.

`COPILOT_HARNESS` picks the AI harness: `claude-code` (default, unset = unchanged behaviour) | `pi` | `codex`. An **unknown id is fatal at boot** (before the server listens, printing the valid ids); a **known id that is unavailable** (missing binary, logged out, failed safety proof) is *not* fatal — the app starts and the analyzer reports it in that harness's own words with that harness's own fix command. Also `COPILOT_HARNESS_COMMAND` (binary path), `COPILOT_HARNESS_MODEL`, and `COPILOT_HARNESS_SPEND_OK=1` (a `billing: 'api-key'` harness refuses to start the background analyzer without it).

## Layout

- `src/config.ts` — .env parsing; a workspace is active only if BOTH tokens present with `xoxp-`/`xapp-` prefixes
- `src/db.ts` — schema (threads / messages / analyses / sync_state), all SQL, and the migrations; Node's built-in `node:sqlite`, positional `?` params only. Do not add better-sqlite3. Read the WATCH-START RULE comment before touching read/unread
- `src/ingest.ts` — one Bolt (v5) Socket-Mode App per workspace; keep/drop rules live here (DMs, `<@me>`, replies to tracked threads; own messages never create a thread or mark unread). `ignoreSelf: false` is load-bearing — with a user token Bolt's "self" is the user
- `src/backfill.ts` — catch-up sweep on startup / reconnect / wake / 15-min timer. Socket Mode never replays missed events, so this is not optional. Bounded on purpose (2-day first lookback, 30-day ceiling, ~50 calls/min)
- `src/harness/` — the AI-harness layer, and the only place that knows what a vendor is. `types.ts` the contract (`HarnessProvider`, `ToolPolicy`, `HarnessEvent`); `index.ts` the REGISTRY + `selectHarness()` + the readiness cache + the boot preflight; `policy.ts` the tool policy (see Guardrails); `probe.ts` the safety-proof runner (scratch dir + network canary, and it checks both itself); `env.ts` the **only** file here allowed to read `process.env`; `json.ts` / `copy.ts` the JSON extraction and the plain-English failure copy; `claude-code.ts` the default provider; `cli.ts` + `dialects.ts` + `presets/*.ts` the generic CLI provider that `pi` and `codex` are pure data for. Adding a harness = one preset file + one line in REGISTRY. Nothing under `src/harness/` may import `health.ts`, `db.ts`, `config.ts` or `ingest.ts` (a test greps for it)
- `src/analyzer.ts` — serial worker, one harness run per thread, tool access handed in by core, 5-call budget, writes `analyses` incl. the session id chat forks. An `api-key` harness doesn't start the loop without `COPILOT_HARNESS_SPEND_OK=1`. Also maintains the thread's **items** (`items` table): discrete obligations extracted per run, identity = (thread_id, slug) with the model updating by slug; a user's checkbox-done always beats the model (`reconcileItems` in `src/db.ts`); unmentioned items persist untouched
- `src/email.ts` — email ingest v1 (`docs/email-ingest.md`), off unless `COPILOT_EMAIL=1`. One fused harness run per poll: search Gmail via the user's own MCP connector, read new threads, triage them — thread/message DATA comes from raw tool-result payloads (`wantToolResults`), never the model's transcription; the reply carries only verdicts keyed by thread id. Email rows share the tables with `source='gmail'`, workspace `'G'`; the Slack analyzer and backfill never touch them (tested). Purpose `'email'` runs against an ALLOWLIST gate (`search_threads`/`get_thread`/`get_message` only — `policy.ts`). Watch-start rule: no history import, ever. Read-only end to end: the reply endpoint 400s email threads; drafts are copy-only
- `src/chat.ts` — chat routes + SSE streaming + the draft protocol + **the only Slack write path**. An event pump over `provider.run()`; session strategy (resume/fork/seed) comes from `planSession()`. Owns `chat_sessions` / `chat_messages` through its own db handle
- `src/health.ts` — in-process health registry and the failure buckets (auth / budget / rate_limit / timeout / bad_output / unknown). Which bucket an error text lands in is the provider's `classifyError()`; the wording is `src/harness/copy.ts`; `bad_output` stays here because it's our JSON contract. Every string here is shown to a non-technical user
- `src/server.ts` — express: Host allowlist → token check → body parser → routes (`/api/feed`, `/api/thread/:id`, `/status`, `/reanalyze`, chat routes), static `public/`
- `public/index.html` — feed + thread UI, single vanilla file (~2k lines, no build). `public/chat.js` + `chat.css` — the chat pane, attaches by replacing three globals index.html exports
- `electron/` — Mac app: `main.js` (window/tray/notifications wiring), `supervisor.js` (spawn-or-attach the server), `watcher.js` (poll feed + status, notify), `env.js`, `builder.yml`
- `scripts/` — `make-icons.mjs`, `prepare-app.mjs`, `build-app.mjs` (generated output: `assets/`, `electron/assets/`, `electron/project-path.json`, `release/`)
- `manifest.json` — Slack app manifest. Changing scopes/events requires reinstalling the apps (`slack app install`)
- `.slack/` — Slack CLI project config; `apps.json` maps workspaces → app IDs

Workspace slots **A** and **B** are whatever the local `.env` configures — this repo is per-person, so don't hardcode team or app IDs anywhere. `slack auth list` shows the connected workspaces; `.slack/apps.json` (untracked) maps them to app IDs.

## Guardrails (non-negotiable)

- `.env` holds real Slack **user** tokens (full read/write as the user). Never read, print, log, or commit it. Validate tokens only by prefix/length.
- **Never log message text**, draft text, or tokens — logs are shown to the user and attached to bug reports. Destination + character count is the pattern (see the reply audit line in `src/chat.ts`).
- **Never run two servers against `data.db`.** Both would ingest and analyze the same threads: double the Slack API usage, double the Claude spend, duplicate work. The Electron app deliberately *attaches* to an already-running server rather than starting a second one — so check `127.0.0.1:5252` (and whether the Mac app is running) before you start anything, and use a different `PORT` + `COPILOT_DB_PATH` for test boots.
- **`data.db` is live user data.** Additive migrations only — `ADD COLUMN` guarded by a column check, `CREATE … IF NOT EXISTS`, never a table rebuild. Anything that *mutates rows* takes a `VACUUM INTO` backup first (a file copy misses the WAL), runs in `BEGIN IMMEDIATE`, is idempotent, and re-checks inside the transaction. The established pattern is in `src/db.ts`.
- **The send-to-Slack path must never become a model tool.** `POST /api/thread/:id/reply` posts the bytes in its request body — the text the user just looked at — and fires only from a click. Model sessions run with no built-in tools (bar `ToolSearch`, the read-only tool-discovery stub that keeps MCP schemas out of context — `TOOL_DISCOVERY_TOOLS` in `src/harness/policy.ts`) and a mutation-name deny list precisely so the model cannot reach it. No draft ids, no "send" tool, no auto-send, ever.
- **The tool policy has exactly one home: `src/harness/policy.ts`.** It used to be copy-pasted into `analyzer.ts` and `chat.ts`, and any divergence between the copies was a silent security hole. **Core decides a run's `ToolAccess`** (`resolveToolAccess`) and hands it to the provider; an adapter wires that decision into its own enforcement points and never filters, wraps, shortcuts or decides its own tool access. Read-only is granted *only* to a provider whose safety proof passed in this process — anything else runs with no tools at all. Do not add a third `ToolPolicy` variant ("tools on, unenforced" must stay unrepresentable), and do not add a capability claim without a runnable proof.
- Server stays bound to `127.0.0.1`, behind the Host allowlist and the per-run `x-copilot-token`. Both exist because of a real DNS-rebinding finding; don't add a route above them, and don't add a WebSocket (a WS handshake can't carry the token header).
- Slack-controlled text is untrusted: escape before DOM insertion (`chat.js` never assigns `innerHTML`), prepared statements only, links gated to `http(s)`, and thread text is data-not-instructions in every prompt.
- `public/index.html` is large and shared. Make surgical edits, and **re-read the region right before editing** — it moves.
- `data.db*`, `release/`, `assets/` are generated/runtime (gitignored). Delete freely in tests, never the user's live db.

## Conventions

- TypeScript strict, ESM (`"type": "module"`), NodeNext resolution. Keep Slack's messy event unions behind localized `any` casts in `src/ingest.ts` — don't fight Bolt types elsewhere.
- User-facing strings (UI, health messages, tray, notifications) are written for a non-technical reader: no "OAuth", "SDK", "token", "daemon". Say what broke and what to do.
- Port 5252 is the user's live server and often hot-reloading. Assume it is in use.
