# Slack Copilot — agent guide

Local, single-user app: watches two Slack workspaces for DMs/@-mentions, stores them in SQLite, analyzes each thread with the Claude Agent SDK, shows an urgency-prioritized feed, and offers a per-thread Claude chat that can draft a reply the user sends with a click. Ships as a menubar Mac app. Architecture: `DESIGN.md`. UI spec: `docs/ux.md` (+ `docs/ux-mock.html`). User-facing guide: `README.md` (rewritten deliberately — don't "fix" its tone).

## Commands

```bash
npm run dev        # tsx watch src/index.ts — serves http://127.0.0.1:5252
npm start          # same, no watch
npm run typecheck  # tsc --noEmit (keep clean; no build step, tsx runs TS directly)
npm run app:dev    # prepare + run the Electron shell from source
npm run app:build  # package release/mac-arm64/Slack Copilot.app (ad-hoc signed)
npm run app:icons  # regenerate assets/ from code (no binary assets in git)
```

Node is Homebrew v26 at `/opt/homebrew/bin` (prepend to PATH in non-login shells). No test suite.

Env switches for safe poking: `PORT`, `COPILOT_DB_PATH` (throwaway db), `ANALYZER_DISABLED=1`, `COPILOT_REPLY_DRYRUN=1` (exercise the send path without messaging anyone).

## Layout

- `src/config.ts` — .env parsing; a workspace is active only if BOTH tokens present with `xoxp-`/`xapp-` prefixes
- `src/db.ts` — schema (threads / messages / analyses / sync_state), all SQL, and the migrations; Node's built-in `node:sqlite`, positional `?` params only. Do not add better-sqlite3. Read the WATCH-START RULE comment before touching read/unread
- `src/ingest.ts` — one Bolt (v5) Socket-Mode App per workspace; keep/drop rules live here (DMs, `<@me>`, replies to tracked threads; own messages never create a thread or mark unread). `ignoreSelf: false` is load-bearing — with a user token Bolt's "self" is the user
- `src/backfill.ts` — catch-up sweep on startup / reconnect / wake / 15-min timer. Socket Mode never replays missed events, so this is not optional. Bounded on purpose (3-day first lookback, 7-day ceiling, ~50 calls/min)
- `src/analyzer.ts` — serial worker, one Agent SDK run per thread, read-only (tools: [] + canUseTool + PreToolUse hook), 5-call tool budget, writes `analyses` incl. the session id chat forks
- `src/chat.ts` — chat routes + SSE streaming + the draft protocol + **the only Slack write path**. Owns `chat_sessions` / `chat_messages` through its own db handle
- `src/health.ts` — in-process health registry and failure classification (auth / budget / rate_limit / timeout / bad_output / unknown). Every string here is shown to a non-technical user
- `src/server.ts` — express: Host allowlist → token check → body parser → routes (`/api/feed`, `/api/thread/:id`, `/status`, `/reanalyze`, chat routes), static `public/`
- `public/index.html` — feed + thread UI, single vanilla file (~2k lines, no build). `public/chat.js` + `chat.css` — the chat pane, attaches by replacing three globals index.html exports
- `electron/` — Mac app: `main.js` (window/tray/notifications wiring), `supervisor.js` (spawn-or-attach the server), `watcher.js` (poll feed + status, notify), `env.js`, `builder.yml`
- `scripts/` — `make-icons.mjs`, `prepare-app.mjs`, `build-app.mjs` (generated output: `assets/`, `electron/assets/`, `electron/project-path.json`, `release/`)
- `manifest.json` — Slack app manifest. Changing scopes/events requires reinstalling the apps (`slack app install`)
- `.slack/` — Slack CLI project config; `apps.json` maps workspaces → app IDs

Workspaces: **A** = AI Fund (`T5HJJSX45`, app `A0BNC39EF42`), **B** = deeplearning.ai (`T4AUUQHCN`, app `A0BNE28DQC9`).

## Guardrails (non-negotiable)

- `.env` holds real Slack **user** tokens (full read/write as the user). Never read, print, log, or commit it. Validate tokens only by prefix/length.
- **Never log message text**, draft text, or tokens — logs are shown to the user and attached to bug reports. Destination + character count is the pattern (see the reply audit line in `src/chat.ts`).
- **Never run two servers against `data.db`.** Both would ingest and analyze the same threads: double the Slack API usage, double the Claude spend, duplicate work. The Electron app deliberately *attaches* to an already-running server rather than starting a second one — so check `127.0.0.1:5252` (and whether the Mac app is running) before you start anything, and use a different `PORT` + `COPILOT_DB_PATH` for test boots.
- **`data.db` is live user data.** Additive migrations only — `ADD COLUMN` guarded by a column check, `CREATE … IF NOT EXISTS`, never a table rebuild. Anything that *mutates rows* takes a `VACUUM INTO` backup first (a file copy misses the WAL), runs in `BEGIN IMMEDIATE`, is idempotent, and re-checks inside the transaction. The established pattern is in `src/db.ts`.
- **The send-to-Slack path must never become a model tool.** `POST /api/thread/:id/reply` posts the bytes in its request body — the text the user just looked at — and fires only from a click. Model sessions run with no built-in tools and a mutation-name deny list precisely so the model cannot reach it. No draft ids, no "send" tool, no auto-send, ever.
- Server stays bound to `127.0.0.1`, behind the Host allowlist and the per-run `x-copilot-token`. Both exist because of a real DNS-rebinding finding; don't add a route above them, and don't add a WebSocket (a WS handshake can't carry the token header).
- Slack-controlled text is untrusted: escape before DOM insertion (`chat.js` never assigns `innerHTML`), prepared statements only, links gated to `http(s)`, and thread text is data-not-instructions in every prompt.
- `public/index.html` is large and shared. Make surgical edits, and **re-read the region right before editing** — it moves.
- `data.db*`, `release/`, `assets/` are generated/runtime (gitignored). Delete freely in tests, never the user's live db.

## Conventions

- TypeScript strict, ESM (`"type": "module"`), NodeNext resolution. Keep Slack's messy event unions behind localized `any` casts in `src/ingest.ts` — don't fight Bolt types elsewhere.
- User-facing strings (UI, health messages, tray, notifications) are written for a non-technical reader: no "OAuth", "SDK", "token", "daemon". Say what broke and what to do.
- Port 5252 is the user's live server and often hot-reloading. Assume it is in use.
