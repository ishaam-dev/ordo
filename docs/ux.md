# Slack Copilot — UX Spec (v1)

Companion to `DESIGN.md`. Scope: the localhost UI only. Audience: the one developer building it; the one user using it (a wide desktop browser, all day, mostly peripheral vision + keyboard). Style targets: dark only, information-dense, scannable in under a second per card, no design-system machinery.

A static reference render of everything below lives at `docs/ux-mock.html`.

**Status.** This spec has been reconciled against the shipped UI (`public/index.html`, `public/chat.js`). Most of it was built as written. Where the build differs, the section says so:

- **Built, differs** — implemented, but not in the shape specced; the text describes what exists and why it changed.
- **Not implemented** — still a good idea, not built. Kept, not deleted. Rolled up in §10.

Copy changes since the spec was written are folded in, notably **Re-analyze → "Check this again"** everywhere it appears.

---

## 1. Information architecture: one screen, three panels

**Recommendation: a single screen with a three-panel master–detail layout. No routed pages.**

```
┌──────────────────────────────────────────────────────────────────────┐
│ Top bar: brand · Inbox/Done/All tabs · ws dots · analyzer status     │
├────────────┬────────────────────────────────────┬────────────────────┤
│ FEED       │ THREAD                             │ CHAT (collapsible) │
│ 380px      │ flex, min 480px                    │ 400px              │
│ fixed,     │ analysis card + transcript         │ Claude session for │
│ scrolls    │                                    │ selected thread    │
└────────────┴────────────────────────────────────┴────────────────────┘
```

Why one screen, not routes:

- The core loop is triage: `j`/`k` down the feed while the thread pane updates instantly. Routes add a navigate-back-restore-scroll cycle to every item; a cursor + preview pane costs zero.
- The feed re-sorts live. A persistent list with a stable cursor absorbs live updates; a routed list page would fight them. *(Built, differs: updates arrive by polling `GET /api/feed` every 5s, not by a push socket. The chat stream is the only server push, and it is SSE on its own request — see `DESIGN.md` §5 for why there is no WebSocket anywhere.)*
- Chat is *about* a thread — you draft replies while re-reading the transcript. It must sit next to the transcript, not on its own page.
- Single user, localhost, wide monitor. No mobile, no deep-linking needs beyond refresh-survival.

Mechanics:

- Selection is mirrored into the URL hash (`#/t/<thread_id>`) via `replaceState` so a refresh restores the selected thread. That is the entire "routing" story.
- Chat panel is **closed by default**; opens on `c` / "Discuss with Claude". When closed, the thread pane takes the space.
- Below **1260px** viewport width, the chat panel overlays the thread pane (absolute, right-anchored, same 400px) instead of squeezing it. That is the only breakpoint — 380 feed + 480 thread minimum + 400 chat, i.e. the exact width below which the three-column grid starts clipping.
- Focus model: exactly one pane owns keyboard focus — feed by default; `enter` moves focus to thread (arrow/space scroll), chat composer grabs focus when the panel opens; `esc` walks back (chat → thread → feed).

---

## 2. Visual foundation

Dark only. GitHub-dark-adjacent palette — proven contrast on dark, and urgency hues stay distinguishable.

```css
--bg:        #0d1117;  /* app background */
--surface:   #151b23;  /* cards, panels */
--surface-2: #1d2530;  /* hover / selected */
--border:    #2a313c;
--text:      #e6edf3;  /* primary */
--text-2:    #9aa4b2;  /* secondary */
--text-3:    #646d79;  /* faint / meta */
--accent:    #4c8dff;  /* selection ring, links, mentions, unseen dot */
--ok:        #3fb950;  /* send, done, connected */
--warn:      #e3b341;  /* stale, reconnecting */
--p0: #f85149;  --p1: #f0883e;  --p2: #d29922;  --p3: #8b949e;
```

- Type: system stack (`-apple-system, "Segoe UI", sans-serif`), base **13px / 1.45**. Mono (`ui-monospace, "SF Mono"`) for timestamps, code, tool rows.
- Radius 6px, borders 1px `--border`, no shadows except the chat-overlay breakpoint.
- Motion budget: 150ms fades and a single 300ms background pulse for newly-arrived cards. Nothing else animates.
- No avatars — 2-letter initials in a small square when a face-slot is needed. (Avoids image fetching entirely.)

Workspace identity: each workspace gets a fixed non-urgency color + one-letter badge (e.g. `A` teal `#39c5cf`, `N` purple `#bc8cff`). Assigned in config, never derived from urgency hues.

---

## 3. Feed

### Sort order

1. **Analyzing** — never-analyzed threads, pinned as a labeled group at the very top, newest first. They are at most ~a minute old (45s debounce), so they self-resolve into the ranked list quickly. Honest about unknown urgency instead of inventing a rank.
2. **P0 → P1 → P2 → P3**, and within each band `last_activity` desc. No band headers — the colored left edges make bands visible.
3. **Stale threads keep their old urgency slot** (marked, see below) until re-analysis lands, then re-sort.
4. `done` threads are excluded from Inbox (live under the Done / All tabs).

Live-update policy: re-sort immediately on data change, but selection is keyed by `thread_id` (never index) and the scroll position is compensated so the selected card doesn't jump under the cursor. New cards get one 300ms background pulse.

### Card anatomy

Fixed ~80px, three rows, one card per thread:

```
┌──────────────────────────────────────────────────┐
│▌ [P1] ↻  N #proj-atlas · @              14:22   │   row 1: meta
│▌ ● Maya Chen   can you rotate the staging API k… │   row 2: who + latest
│▌ ✦ Blocked on you: key rotation before 3pm sync  │   row 3: Claude's why
└──────────────────────────────────────────────────┘
 ▌= 3px urgency edge   ● = unseen dot   ✦ = analysis glyph
```

| # | Field | Rules |
|---|---|---|
| 1 | Urgency chip | See table below. Leftmost — it is the sort key, so it anchors the scan. |
| 1 | Stale marker | Amber `↻`, only when replies arrived after `covered_through_ts`. Tooltip: "2 new replies since analysis". *(Built, differs: `/api/feed` carries no `covered_through_ts`, so staleness is computed from per-thread detail, which is hydrated lazily for the **top 10 visible rows only**. Cards below that never show the marker even when stale — the thread pane always does.)* |
| 1 | Workspace badge + channel | `A #infra` / `DM` / `DM+` (group DM). Channel truncates at ~18ch. |
| 1 | Kind glyph | `@` for mentions; DMs already say DM. |
| 1 | Time | Right-aligned, mono, relative (`now`, `5m`, `2h`, `Mon`, `Jul 28`). |
| 2 | Unseen dot | 6px `--accent` dot. Only in `new` status. |
| 2 | Sender + snippet | Latest message's author (bold) + its text, single line, ellipsis. Slack markup stripped to plain text here. |
| 3 | Why line | Claude's one-liner behind a `✦`, single line, ellipsis. This is the row your eye reads; it earns its own line. |

Not on the card: summary, suggested action, context notes. Those live in the thread pane — the card must stay 3 lines forever.

### Urgency encoding (chip + edge, so it survives peripheral vision)

| State | Chip | Left edge | Extra |
|---|---|---|---|
| P0 | Solid `--p0` fill, dark text | `--p0` | Card bg tinted `rgba(248,81,73,.06)` — the only tinted state |
| P1 | Outlined, `--p1` text | `--p1` | |
| P2 | Outlined, `--p2` text | `--p2` | |
| P3 | Outlined, `--p3` text | `--p3` | |
| Not yet analyzed | Dashed gray outline, `…` | none | Why line = shimmer "Analyzing…" |
| Stale analysis | Chip unchanged (old value) | unchanged | `↻` marker; why line dimmed to 60% |
| Analyzer offline | Gray `–` chip | none | Why line absent; global status strip explains |

**Analyzer offline — built, differs.** The gray `–` chip was not built. Unrated cards keep the dashed `…` chip and the why line changes instead: **"Waiting to be prioritized"**, static, with the plain-English reason and hint from `/api/status` in the tooltip. The pinned group header changes from "Analyzing · n" to "Waiting to be prioritized · n" at the same time.

The reasoning: a shimmer is a promise that work is in progress. When nothing is running, animating at someone is a lie, and a `–` chip says "no rating" without saying why. Wording that names the state, plus the reason on hover, does both jobs and needs no new chip variant.

### Read-state encoding

| Status | Treatment |
|---|---|
| `new` | Accent dot, sender + snippet in `--text` (bright), sender bold |
| `seen` | No dot, sender + snippet drop to `--text-2`, normal weight |
| `done` | Hidden from Inbox. In Done/All: 45% opacity, green `✓` where the dot was |

Glance test: the Inbox answers "anything red? anything with a dot?" from across the room.

### Tabs

`Inbox (n)` / `Done` / `All` in the top bar; `n` = unseen count. Keys `1`/`2`/`3`. No other filters in v1.

---

## 4. Triage interactions

| Key | Action |
|---|---|
| `j` / `↓` | Cursor down. **Previews** in thread pane; does *not* change status. |
| `k` / `↑` | Cursor up. |
| `enter` / `o` | Engage: mark `seen`, move focus to thread pane. |
| `e` | Mark `done`, advance cursor to next card. |
| `u` | Toggle back to `new` (unseen). |
| `c` | Open chat for cursored thread (also marks `seen`). |
| `s` | Open in Slack (permalink). No status change. |
| `esc` | Close chat → refocus thread → refocus feed (one level per press). |
| `1` `2` `3` | Inbox / Done / All. |
| `?` | Shortcut overlay. |

Deliberate choices:

- **`j`/`k` do not mark seen.** Skimming must not clear the favicon badge — `new` means "not yet engaged", and engagement is `enter`, a click, or `c`. This keeps the P0/P1 badge trustworthy.
- **Mouse click on a card = select + mark seen** (clicking *is* engaging; no two-step for mouse users).
- **"Open in Slack" never changes status.** Handling something in Slack doesn't mean it's done here; you come back and press `e`. Auto-done on link-click loses items. It's a discrete button (card hover + thread header) with `stopPropagation`.
- Card hover reveals two icon buttons on row 1's right: `✓` (done) and `↗` (Slack) — mouse parity for `e`/`s`.

---

## 5. Thread view

Layout top to bottom: header → analysis card → transcript.

### Header

Workspace badge + `#channel` (or DM participant names) · kind · "14 messages · updated 14:22". Actions right: **[Discuss with Claude]** (primary, accent), [Open in Slack], [Done], overflow `⋯` (**Mark unseen (u)**, **Check this again**).

"Check this again" posts `/api/thread/:id/reanalyze`, which clears that thread's failure backoff and jumps it to the front of the queue — it never analyzes inline, so the one-at-a-time rule holds. While the request is in flight the control reads "asking Claude…", then "queued ✓" for a couple of seconds. [Open in Slack] is disabled with an explanatory tooltip when the thread has no `http(s)` permalink.

### Analysis card (always above the transcript)

The analysis is the product; it renders first, transcript below for verification.

```
┌─────────────────────────────────────────────────────────────┐
│ ⚠ 2 new replies since Claude last read this — checking…     │  ← only when stale
│ [P1]  Blocked on you: key rotation before 3pm infra sync    │  ← why = headline
│ Summary: Maya's deploy is blocked on the staging API keys…  │  ≤3 sentences
│ Suggested action: Confirm you'll rotate keys after the 3pm  │
│ sync and link the runbook.            [Draft this reply →]  │
│ Context                                                     │
│  • [calendar] "Infra sync" with Maya today 3:00–3:30        │
│  • [asana] Task "Rotate prod API keys" — due Fri, yours     │
│ Claude read this 6m ago · up to the 14:18 message           │  ← meta footer
│                                       · check this again    │
└─────────────────────────────────────────────────────────────┘
```

- **Why** is the headline (chip inline). **Suggested action** gets a `[Draft this reply →]` button that opens chat pre-seeded with "Draft the suggested reply." — the shortest path from triage to reply.
- **Context notes** are bullets, each prefixed with a source tag (`[calendar]`, `[asana]`, `[email]`, `[granola]`) in mono — provenance makes MCP context trustworthy.
- Card is collapsible (chevron) to a single why-line; state remembered per session.
- **Pending, analyzer healthy:** skeleton card, `…` chip, "Analyzing this thread…", footer "Claude picks threads up ~45s after the last message".
- **Pending, analyzer stalled — built, differs.** The specced gray "Analysis unavailable — Retry" card was not built. The pending card instead says "Waiting to be prioritized" and then spells out, in the plain English `/api/status` supplies, what broke and what to do — followed by "The message itself is safe and the conversation below is complete. Only the urgency rating and summary are missing." Its footer becomes "it keeps its place in the list until Claude can rate it". "Retry" is the same `· check this again` control the healthy card carries, so there is one affordance for it, not two.

### Transcript rendering (Slack mrkdwn — do NOT feed to a Markdown library; asterisk/underscore semantics differ)

| Slack raw | Render as |
|---|---|
| `<@U123>` | `@Display Name` accent-colored token, resolved from the `users:read` cache; fallback literal `@U123` |
| `<#C42\|general>` | `#general` accent token |
| `<https://x\|label>` | link showing `label` |
| `<https://x>` | link showing shortened `host/first-path-seg…` |
| `:tada:` | Unicode via a small static map (~50 common codes); unknown codes render literal `:code:` in `--text-3` (don't pretend) |
| `*bold*` `_italic_` `~strike~` | styled inline (Slack semantics: single `*` = bold) |
| `` `code` `` / ``` fences ``` | mono inline / block |
| `> quote` | left-border quote block |
| Files, images, custom emoji, rich blocks | v1 placeholder chip `[image: shot.png]` linking to the Slack permalink — **not implemented**. A message with no text renders one faint note, `(no text — file, attachment, or rich block)`. Named, linked chips would need the file metadata off the raw event, which nothing reads today. |

- **Grouping**: consecutive messages from one author within 5 min share one author header. Day dividers between dates.
- **You**: **not implemented.** Own messages render exactly like anyone else's — same alignment, same author styling, no `(you)` suffix. They are stored and shown (Bolt's self-filter is disabled precisely so they are), so a thread reads as a real conversation, but nothing marks which side is yours. Worth doing: the analyzer's prompt already resolves "me" per workspace, so the id is available.
- **Stale divider**: when the thread is stale, an amber rule `new since last analysis` sits above the uncovered messages, so you instantly see what Claude hasn't read.
- **Deleted messages** keep their row and read `(deleted)`; the transcript never grows a hole.
- Footer of transcript: inline CTA `Discuss with Claude — c` (duplicate entry point at the natural end of reading).

---

## 6. Chat panel

One session per thread, panel scoped to the selected thread. *(Built, differs: the session id on the `analyses` row belongs to the **analyzer**. The chat's first turn **forks** it — so Claude starts already knowing the thread and its verdict without corrupting the analyzer's transcript — and the forked id is kept in its own `chat_sessions` table, so conversations survive a restart. See `DESIGN.md` §5.)*

- **Header**: `Claude — #proj-atlas` + session chip: status dot (green live / gray idle / red error) + `session 9f2c · 14 msgs`, or `new session` / `loading…`. `×` / `esc` closes. *(Built, differs: the chip does not say `resumed`, and the "New session" overflow was **not implemented** — there is no way to unlink a thread's session from the UI.)*
- **Preload**: the server seeds the session with transcript + analysis; resumed sessions re-hydrate full scrollback from the server on every open, so a send, a restart or a second window all show the same transcript. *(Built, differs: no `Context loaded` system note. An empty panel instead opens with "Claude already has this thread and its analysis. Ask anything" and three example prompts, plus a standing note: "nothing is ever posted to Slack without your click".)*
- **Streaming**: assistant text streams token-wise with a `▍` cursor; autoscroll while the view is at the bottom, and it stops following as soon as the user scrolls up. A `Stop` button interrupts; `esc` is reserved for closing the panel. *(Built, differs: no `↓ latest` pill — scrolling back up simply stops the autoscroll and scrolling down re-arms it. `⌘.` was **not implemented**; the Stop button is the only interrupt.)*
- **Tool use**: each MCP call renders as a one-line row — `⚙ calendar · list_events` while running, then `✓` or `✕`. Keeps the "Claude is doing something" signal without log spam. *(Built, differs: not expandable — no args, no result JSON, no duration. The SDK stream carries the tool name and the pass/fail of its result, and showing arguments would put attacker-influenced text into the panel for no triage benefit.)*
- **Turn failure**: an inline banner with the classifier's plain-English message and hint (the same copy `/api/status` and the terminal use), a `Retry` that re-sends the same message, and the copyable command when a command is the fix.
- **Draft-reply card** — the only send path:

```
┌─────────────────────────────────────────────┐
│ draft reply → #proj-atlas · as you          │
│ ┌─────────────────────────────────────────┐ │
│ │ On it — I'll rotate the staging keys    │ │  ← editable textarea
│ │ right after our 3pm sync…               │ │
│ └─────────────────────────────────────────┘ │
│ [ Send to #proj-atlas ]  [Copy] [Discard]   │
│ Posts as you via chat.postMessage.          │
│ Nothing sends without this click.           │
└─────────────────────────────────────────────┘
```

  - **Built, differs — and this one matters.** Drafts are *not* produced by a `draft_reply` tool. Sending is deliberately not reachable by the model at all: chat sessions run with no built-in tools, and every tool name is checked against a mutation-word deny list. Claude instead wraps a proposed reply in a fenced ```` ```draft ```` block, the **server** parses it (one implementation, shared by the live stream and stored history) and hands back prose + `drafts[]`. An unclosed or mistagged fence stays in the prose as plain text, so a malformed turn degrades to "Claude said something" instead of breaking the panel — and cannot conjure a send button.
  - Each draft is its own card; the text is editable in place before sending; the bytes posted are the bytes in that textarea, carried in the request body. There is no draft id, on purpose — the server has no way to post something the user did not have in front of them.
  - **Send = the green button** (label carries the destination) or `⌘enter` while that textarea is focused. No global send key. While posting: `Posting…`; success: the card collapses to `✓ Sent 14:31 · view in Slack` over the sent text, plus a `sent to Slack · view in Slack` note in the log; failure: inline red error with `Retry` / `Copy`. With `COPILOT_REPLY_DRYRUN=1` the card says "dry run — nothing left this machine".
  - A DM draft posts to the conversation with no `thread_ts`; only channel mentions reply in-thread.
- **Composer**: bottom textarea, `enter` sends / `shift+enter` newline, `esc` closes. *(Built, differs: the composer stays enabled when Claude is unreachable — failures surface as a banner with a Retry after the attempt, rather than as a disabled box. While a turn streams, Send is disabled, Stop appears, and the placeholder reads "Claude is replying…".)*

---

## 7. States

| Surface | State | Treatment |
|---|---|---|
| Feed | Empty | Centered: "Watching acme + nimbus — no DMs or mentions yet" + per-workspace connection dots |
| Feed | Loading (boot) | 4 skeleton cards |
| Feed | Analysis pending | Pinned "Analyzing" group; dashed `…` chip; shimmer why-line |
| Feed | Analysis stale | Amber `↻` on card; keeps old urgency slot; why dimmed |
| Feed | Analyzer offline | *(differs)* `…` chips, why-line reads "Waiting to be prioritized" with the reason on hover; pinned group relabels; status strip explains |
| Feed | **Claude not signed in** | *(added)* A persistent banner above the panes — "Claude isn't signed in — items can't be prioritized yet", the reassurance that messages are still arriving and nothing is lost, the exact command in a `<code>` block with a **Copy** button, and how to recover. This is the one analyzer fault that gets a banner instead of the ambient strip, because it is the only one the user must fix by hand. Rebuilt only when the situation changes, so the 5s poll never resets a "Copied ✓" or a half-made selection |
| Feed | Slack disconnected | *(differs)* Per-workspace dot in the top bar goes amber with the reason in its tooltip; the ambient strip carries analyzer trouble and feed-poll failure. Cached feed stays fully browsable either way |
| Feed | Feed poll failing | *(added)* Amber strip: "Feed refresh failed (…) — showing last known data, updated 14:22. Retrying…", and the server dot flips to `offline`. On a cold boot with no cached data: "Can't reach your messages" placeholder |
| Thread | Nothing selected | Muted placeholder: "Select a thread — j/k to move, enter to open" |
| Thread | Analysis pending | Skeleton analysis card, transcript renders immediately |
| Thread | Analysis stale | Amber banner in analysis card + amber transcript divider |
| Thread | Analysis error | *(differs)* Not a separate gray card — the pending card says "Waiting to be prioritized" and explains the fault (§5) |
| Chat | Loading history | Session chip reads `loading…` |
| Chat | Claude unavailable | *(differs)* Inline banner with the classifier's message + hint + `Retry`; composer stays enabled |
| Chat | Send failed | Inline error on the draft card (see above) |

Global status strip (top bar, right), left to right:

- **Analyzer chip** *(differs — a worded chip, not a dot)*: `Claude · up to date` / `Claude · 3 waiting` / `Claude · prioritizing` / `Claude · not signed in` / `Claude · prioritizing off` / `Claude · paused`, amber or red when in trouble, with the message and hint in the tooltip.
- **One dot + name per workspace**, sourced from `GET /api/status` — green connected, amber connecting/reconnecting, red can't sign in, with the plain-English reason on hover. **No dot at all** when the server has not reported on that workspace yet: an uncoloured dot reads as a bug and a green one would be a claim we cannot back up. `/api/status` is also the only source that lists a configured workspace which has produced no messages yet.
- **A `live` / `offline` dot** *(added)* for the feed poll itself, tooltip carrying the poll interval and last-success time — "the server is answering" and "Slack is connected" are different questions.
- **A `?` button** for the shortcut overlay.

Errors are ambient here, modal nowhere.

---

## 8. Favicon / title badge (passive-dashboard signal)

The tab is the in-window notification surface. *(Desktop notifications were out of scope when this was written; the Mac app now has them — same counting rule, P0/P1 and still-unread only. See `DESIGN.md` §8.)*

- **Counted**: unseen threads at **P0 or P1 only**. Total unread would make the badge permanent and meaningless.
- **Title**: `(3!) Slack Copilot` — the `!` present iff ≥1 unseen P0; `(3) Slack Copilot` for P1-only; plain `Slack Copilot` otherwise.
- **Favicon**: drawn to a 32px canvas — base glyph + top-right dot, `--p0` red if any unseen P0, else `--p1` orange. Cleared as soon as those threads are seen or done (another reason `j`/`k` must not mark seen).
- Recompute on every store change, throttled to 1s.

### The menubar, when the UI runs inside the Mac app

Outside this spec's scope but adjacent to it, and the spec-era assumption was wrong: **it is not right-click-only.** Both mouse buttons open the same menu, and **"Open Slack Copilot" is its first item** — so the old left-click-to-open habit still reaches the window in one more click, and the status lines sit directly under it. Nothing about the app's state is reachable only by right-clicking: when something was wrong, an odd-looking icon with no discoverable way to ask why was the entire failure mode. Icon: filled = healthy, hollow = starting, crossed with a `!` = broken; the urgent count rides next to it as the title.

---

## 9. Anti-goals (v1)

- No light theme, no responsive/mobile layout beyond the one chat-overlay breakpoint.
- No settings UI — constants live in code/config.
- No avatar fetching, no custom-workspace-emoji rendering, no rich Slack block rendering (placeholder chips instead).
- No list virtualization until the feed exceeds ~500 rows.
- No toasts/modals for errors — ambient status strip + inline errors only.
- No auto-send of anything, ever; no global send shortcut.

---

## 10. Specced but not built

Still good ideas; kept here rather than deleted. None are blocked by anything structural.

| # | Item | Where | Note |
|---|---|---|---|
| 1 | `(you)` marker on own messages | §5 transcript | Own messages are stored and rendered, but nothing distinguishes them. The Slack user id is already resolved per workspace for the analyzer's prompt |
| 2 | Stale `↻` marker beyond the top 10 cards | §3 card anatomy | Staleness needs `covered_through_ts`, which `/api/feed` does not carry; detail is hydrated lazily for the top 10 visible rows. Either widen the hydrate window or add the field to the feed row |
| 3 | Gray `–` "analyzer offline" chip | §3 urgency encoding | Superseded in practice by the "Waiting to be prioritized" why-line, which says more in the same space |
| 4 | Named file/attachment chips | §5 transcript | Text-less messages get one generic note instead of `[image: shot.png]` linked to the permalink. The file metadata is in the stored raw event; nothing reads it yet |
| 5 | `↓ latest` pill, `⌘.` stop, "New session" | §6 chat panel | Small chat-panel affordances; autoscroll pin/unpin, the Stop button and a per-thread session cover the same ground more cheaply |
| 6 | Expandable tool rows (args / result JSON) | §6 chat panel | Deliberately parked: it would put attacker-influenced text into the panel for little triage benefit. The one-line row keeps the signal |
