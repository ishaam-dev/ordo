# Slack Copilot — UX Spec (v1)

Companion to `DESIGN.md`. Scope: the localhost UI only. Audience: the one developer building it; the one user using it (a wide desktop browser, all day, mostly peripheral vision + keyboard). Style targets: dark only, information-dense, scannable in under a second per card, no design-system machinery.

A static reference render of everything below lives at `docs/ux-mock.html`.

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
- The feed re-sorts live (WS pushes new messages and finished analyses). A persistent list with a stable cursor absorbs live updates; a routed list page would fight them.
- Chat is *about* a thread — you draft replies while re-reading the transcript. It must sit next to the transcript, not on its own page.
- Single user, localhost, wide monitor. No mobile, no deep-linking needs beyond refresh-survival.

Mechanics:

- Selection is mirrored into the URL hash (`#/t/<thread_id>`) via `replaceState` so a refresh restores the selected thread. That is the entire "routing" story.
- Chat panel is **closed by default**; opens on `c` / "Discuss with Claude". When closed, the thread pane takes the space.
- Below ~1200px viewport width, the chat panel overlays the thread pane (absolute, right-anchored, same 400px) instead of squeezing it. That is the only breakpoint.
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
| 1 | Stale marker | Amber `↻`, only when replies arrived after `covered_through_ts`. Tooltip: "2 new replies since analysis". |
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

Workspace badge + `#channel` (or DM participant names) · kind · "14 messages · updated 14:22". Actions right: **[Discuss with Claude]** (primary, accent), [Open in Slack], [Done], overflow (Re-analyze, Mark unseen).

### Analysis card (always above the transcript)

The analysis is the product; it renders first, transcript below for verification.

```
┌─────────────────────────────────────────────────────────────┐
│ ⚠ 2 replies since this analysis — re-analyzing…             │  ← only when stale
│ [P1]  Blocked on you: key rotation before 3pm infra sync    │  ← why = headline
│ Summary: Maya's deploy is blocked on the staging API keys…  │  ≤3 sentences
│ Suggested action: Confirm you'll rotate keys after the 3pm  │
│ sync and link the runbook.            [Draft this reply →]  │
│ Context                                                     │
│  • [calendar] "Infra sync" with Maya today 3:00–3:30        │
│  • [asana] Task "Rotate prod API keys" — due Fri, yours     │
│ analyzed 6m ago · covered through 14:18 · re-analyze        │  ← meta footer
└─────────────────────────────────────────────────────────────┘
```

- **Why** is the headline (chip inline). **Suggested action** gets a `[Draft this reply →]` button that opens chat pre-seeded with "Draft the suggested reply." — the shortest path from triage to reply.
- **Context notes** are bullets, each prefixed with a source tag (`[calendar]`, `[asana]`, `[email]`, `[granola]`) in mono — provenance makes MCP context trustworthy.
- Card is collapsible (chevron) to a single why-line; state remembered per session.
- Pending: skeleton card with "Analyzing…" shimmer. Analyzer error: gray card "Analysis unavailable — Retry".

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
| Files, images, custom emoji, rich blocks | v1 placeholder chip `[image: shot.png]` linking to the Slack permalink |

- **Grouping**: consecutive messages from one author within 5 min share one author header. Day dividers between dates.
- **You**: your own messages keep left alignment (Slack reading order) with the author name accent-tinted and suffixed `(you)`.
- **Stale divider**: when the thread is stale, an amber rule `— new since last analysis —` sits above the uncovered messages, so you instantly see what Claude hasn't read.
- Footer of transcript: inline CTA `Discuss with Claude — c` (duplicate entry point at the natural end of reading).

---

## 6. Chat panel

One session per thread (session id stored on the `analyses` row), panel scoped to the selected thread.

- **Header**: `Claude — #proj-atlas` + session chip: status dot (green live / gray idle / red error) + `session 9f2c · resumed · 14 msgs` or `new session`. Overflow: "New session" (unlinks, old log kept on disk). `×` / `esc` closes.
- **Preload**: the server seeds the session with transcript + analysis; the UI shows one system note: `Context loaded: thread + analysis`. Resumed sessions re-hydrate full scrollback.
- **Streaming**: assistant text streams token-wise with a `▍` cursor; autoscroll unless the user has scrolled up, in which case a `↓ latest` pill appears. A `Stop` button (and `⌘.`) interrupts; `esc` is reserved for closing the panel.
- **Tool use**: each MCP call renders as a one-line collapsed row — `⚙ calendar · list_events ✓ 1.2s` — expandable to args/result JSON (mono, max-height, scrollable). Keeps the "Claude is doing something" signal without log spam.
- **Draft-reply card** — the only send path:

```
┌─────────────────────────────────────────────┐
│ DRAFT REPLY → #proj-atlas (nimbus) · as you │
│ ┌─────────────────────────────────────────┐ │
│ │ On it — I'll rotate the staging keys    │ │  ← editable textarea
│ │ right after our 3pm sync…               │ │
│ └─────────────────────────────────────────┘ │
│ [ Send to #proj-atlas ]  [Copy] [Discard]   │
│ Posts as you via chat.postMessage.          │
│ Nothing sends without this click.           │
└─────────────────────────────────────────────┘
```

  - Drafts are produced by a `draft_reply` tool Claude calls (never inferred from prose); each draft is its own card; the text is editable in place before sending.
  - **Send = the green button** (label carries the destination) or `⌘enter` while that textarea is focused. No global send key. While posting: `Posting…`; success: card collapses to `✓ Sent 14:31 · view in Slack`; failure: inline red `not_in_channel — Retry / Copy`.
- **Composer**: bottom textarea, `enter` sends / `shift+enter` newline. Disabled with an inline note when Claude is unreachable.

---

## 7. States

| Surface | State | Treatment |
|---|---|---|
| Feed | Empty | Centered: "Watching acme + nimbus — no DMs or mentions yet" + per-workspace connection dots |
| Feed | Loading (boot) | 4 skeleton cards |
| Feed | Analysis pending | Pinned "Analyzing" group; dashed `…` chip; shimmer why-line |
| Feed | Analysis stale | Amber `↻` on card; keeps old urgency slot; why dimmed |
| Feed | Analyzer offline | Gray `–` chips, no why-lines; status strip explains |
| Feed | Slack disconnected | Amber/red strip under top bar per workspace: "nimbus reconnecting (retry 3)…" — cached feed stays fully browsable |
| Thread | Nothing selected | Muted placeholder: "Select a thread — j/k to move, enter to open" |
| Thread | Analysis pending | Skeleton analysis card, transcript renders immediately |
| Thread | Analysis stale | Amber banner in analysis card + amber transcript divider |
| Thread | Analysis error | Gray card "Analysis unavailable — Retry" |
| Chat | Connecting | Spinner row in panel |
| Chat | Claude unavailable | Red banner "Claude unavailable — Retry"; composer disabled |
| Chat | Send failed | Inline error on the draft card (see above) |

Global status strip (top bar, right): one dot per workspace + one for the analyzer (green / amber `reconnecting` / red `down`, tooltip has detail), plus `analyzing 2` queue chip when the analyzer is busy. Errors are ambient here, modal nowhere.

---

## 8. Favicon / title badge (passive-dashboard signal)

The tab is the notification surface (desktop notifications are out of scope per DESIGN.md).

- **Counted**: unseen threads at **P0 or P1 only**. Total unread would make the badge permanent and meaningless.
- **Title**: `(3!) Slack Copilot` — the `!` present iff ≥1 unseen P0; `(3) Slack Copilot` for P1-only; plain `Slack Copilot` otherwise.
- **Favicon**: drawn to a 32px canvas — base glyph + top-right dot, `--p0` red if any unseen P0, else `--p1` orange. Cleared as soon as those threads are seen or done (another reason `j`/`k` must not mark seen).
- Recompute on every store change, throttled to 1s.

---

## 9. Anti-goals (v1)

- No light theme, no responsive/mobile layout beyond the one chat-overlay breakpoint.
- No settings UI — constants live in code/config.
- No avatar fetching, no custom-workspace-emoji rendering, no rich Slack block rendering (placeholder chips instead).
- No list virtualization until the feed exceeds ~500 rows.
- No toasts/modals for errors — ambient status strip + inline errors only.
- No auto-send of anything, ever; no global send shortcut.
