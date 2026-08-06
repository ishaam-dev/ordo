/**
 * Catch-up sync — "nothing was missed while the laptop was closed".
 *
 * Socket Mode does not replay events that happened while we were disconnected, so every
 * DM and @-mention that arrives overnight is invisible to the live event stream. This
 * module asks Slack for what we missed and pushes each message through the *same* filter
 * and store path as a live event (`BackfillContext.ingest`), so dedup, thread creation,
 * status handling and analysis all behave identically. Backfilled items are not announced
 * anywhere special — they just show up as normal feed rows.
 *
 * Strategy (chosen after probing what these user tokens can actually do):
 *   - DMs / group DMs: `conversations.list(types:'im,mpim')` → `conversations.history`
 *     from each conversation's high-water mark.
 *   - Mentions: `search.messages` is tried once (it needs `search:read`, which this app's
 *     manifest does not request — it fails with missing_scope here) and we fall back to
 *     `users.conversations(types:'public_channel,private_channel')` →
 *     `conversations.history` filtered by the normal `<@ME>` mention rule in ingest.
 *   - Threads: replies do not appear in `conversations.history`, so threads with new
 *     replies (and the mention threads we already track) get a capped number of
 *     `conversations.replies` calls.
 *
 * Bounds, so a long absence can never hammer the API: first sight of a conversation looks
 * back 3 days, any sweep looks back at most 7 days, conversation counts are capped, each
 * conversation gets at most 3 pages of history, and calls are serialized with a delay
 * (conversations.history is Tier 3, ~50/min). 429s are handled by the Slack WebClient
 * itself, which honours Retry-After by default.
 *
 * Nothing here logs message text.
 */
import {
  getSyncMark,
  setSyncMark,
  latestStoredTsForChannel,
  listRecentMentionThreads,
  listTrackedConversations,
} from './db.js';

export type ConversationType = 'im' | 'mpim' | 'channel' | 'group';

export interface BackfillContext {
  workspaceKey: string;
  /** Bolt's WebClient for this workspace (already carries the user token). */
  client: any;
  myUserId: string;
  /** Slack handle for `search.messages` queries; null if unknown. */
  myUserName: string | null;
  /**
   * The live-event filter + store path. Returns true when a new message row was stored.
   */
  ingest: (msg: any, channelId: string, channelType: ConversationType) => Promise<boolean>;
}

// ---------- bounds ----------

const FIRST_RUN_LOOKBACK_S = 3 * 24 * 60 * 60; // first sight of a conversation
const MAX_LOOKBACK_S = 7 * 24 * 60 * 60; // hard ceiling for any sweep
const MAX_DM_CONVERSATIONS = 60;
const MAX_CHANNELS = 40;
const MAX_INCREMENTAL_CONVERSATIONS = 80;
const HISTORY_PAGE_LIMIT = 200;
const MAX_HISTORY_PAGES = 3; // ≤600 messages per conversation per sweep
const MAX_REPLY_FETCHES_FULL = 20;
const MAX_REPLY_FETCHES_INCREMENTAL = 10;
const API_DELAY_MS = 1_200; // ~50 calls/min, matching Tier 3
const MARK_SAFETY_S = 300; // clock-skew slack when advancing a mark to "now"
const LIST_PAGE_LIMIT = 200;
const MAX_LIST_PAGES = 2;

// ---------- scheduling ----------

const HEARTBEAT_MS = 60_000; // wake detector granularity
const WAKE_GAP_MS = 3 * 60_000; // heartbeat this late ⇒ the machine was asleep
const INCREMENTAL_MS = 15 * 60_000; // cheap safety net
const FULL_EVERY_N_INCREMENTAL = 4; // ⇒ a full sweep about hourly
const MIN_RUN_GAP_MS = 30_000; // debounce reconnect storms

export type BackfillMode = 'full' | 'incremental';

interface Target {
  channelId: string;
  type: ConversationType;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowSec(): number {
  return Date.now() / 1000;
}

function errText(err: unknown): string {
  const anyErr = err as { data?: { error?: string }; message?: string };
  return anyErr?.data?.error ?? anyErr?.message ?? String(err);
}

// ---------- target discovery ----------

async function listDmTargets(ctx: BackfillContext, cap: number): Promise<Target[]> {
  const targets: Target[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res: any = await ctx.client.conversations.list({
      types: 'im,mpim',
      limit: LIST_PAGE_LIMIT,
      exclude_archived: true,
      ...(cursor ? { cursor } : {}),
    });
    for (const c of res.channels ?? []) {
      if (c?.id === undefined || c.is_user_deleted === true) continue;
      targets.push({ channelId: c.id, type: c.is_mpim === true ? 'mpim' : 'im' });
      if (targets.length >= cap) return targets;
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
    await sleep(API_DELAY_MS);
  }
  return targets;
}

async function listChannelTargets(ctx: BackfillContext, cap: number): Promise<Target[]> {
  const targets: Target[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res: any = await ctx.client.users.conversations({
      types: 'public_channel,private_channel',
      limit: LIST_PAGE_LIMIT,
      exclude_archived: true,
      ...(cursor ? { cursor } : {}),
    });
    for (const c of res.channels ?? []) {
      if (c?.id === undefined) continue;
      targets.push({ channelId: c.id, type: c.is_private === true ? 'group' : 'channel' });
      if (targets.length >= cap) return targets;
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
    await sleep(API_DELAY_MS);
  }
  return targets;
}

/** Whether `search.messages` is usable on this token — probed once per process. */
const searchAvailable = new Map<string, boolean>();

/**
 * Preferred mention strategy: ask Slack which channels mentioned me recently, so we sweep
 * those first. Needs `search:read`; when that is missing (the common case for these user
 * tokens) we return null and the caller falls back to iterating my channels.
 */
async function searchMentionChannels(
  ctx: BackfillContext,
  oldest: number,
): Promise<Target[] | null> {
  if (searchAvailable.get(ctx.workspaceKey) === false) return null;
  if (ctx.myUserName === null) return null;
  try {
    const after = new Date((oldest - 24 * 60 * 60) * 1000).toISOString().slice(0, 10);
    const res: any = await ctx.client.search.messages({
      query: `@${ctx.myUserName} after:${after}`,
      count: 100,
    });
    searchAvailable.set(ctx.workspaceKey, true);
    const seen = new Set<string>();
    const targets: Target[] = [];
    for (const m of res.messages?.matches ?? []) {
      const id = m?.channel?.id;
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      targets.push({ channelId: id, type: m.channel?.is_private === true ? 'group' : 'channel' });
    }
    return targets;
  } catch (err) {
    if (searchAvailable.get(ctx.workspaceKey) === undefined) {
      console.log(
        `[backfill] ${ctx.workspaceKey}: search.messages unavailable (${errText(err)}) — ` +
          'using users.conversations + conversations.history for mentions',
      );
    }
    searchAvailable.set(ctx.workspaceKey, false);
    return null;
  }
}

function trackedTargets(ctx: BackfillContext, cap: number): Target[] {
  const targets: Target[] = [];
  for (const c of listTrackedConversations(ctx.workspaceKey)) {
    // We do not persist whether a tracked channel is private; 'channel' vs 'group' only
    // affects DM-vs-mention classification, and both are non-DM, so either is correct.
    targets.push({ channelId: c.channel_id, type: c.kind === 'dm' ? 'im' : 'channel' });
    if (targets.length >= cap) break;
  }
  return targets;
}

// ---------- fetching ----------

interface HistoryResult {
  messages: any[];
  truncated: boolean;
}

async function historySince(
  ctx: BackfillContext,
  channelId: string,
  oldest: string,
): Promise<HistoryResult> {
  const messages: any[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const res: any = await ctx.client.conversations.history({
      channel: channelId,
      oldest,
      limit: HISTORY_PAGE_LIMIT,
      inclusive: false,
      ...(cursor ? { cursor } : {}),
    });
    for (const m of res.messages ?? []) messages.push(m);
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor || res.has_more !== true) {
      cursor = undefined;
      break;
    }
    if (page === MAX_HISTORY_PAGES - 1) truncated = true;
    else await sleep(API_DELAY_MS);
  }
  return { messages, truncated };
}

async function repliesSince(
  ctx: BackfillContext,
  channelId: string,
  parentTs: string,
  oldest: number,
): Promise<any[]> {
  const res: any = await ctx.client.conversations.replies({
    channel: channelId,
    ts: parentTs,
    oldest: oldest.toFixed(6),
    inclusive: false,
    limit: HISTORY_PAGE_LIMIT,
  });
  return (res.messages ?? []).filter((m: any) => {
    const t = Number.parseFloat(m?.ts ?? '');
    return Number.isFinite(t) && t > oldest && m.ts !== parentTs;
  });
}

// ---------- the sweep ----------

/** Where this conversation's sweep starts: stored mark → newest stored message → 3 days. */
function oldestFor(ctx: BackfillContext, channelId: string): number {
  const floor = nowSec() - MAX_LOOKBACK_S;
  const mark =
    getSyncMark(ctx.workspaceKey, channelId) ??
    latestStoredTsForChannel(ctx.workspaceKey, channelId);
  const parsed = mark === null ? NaN : Number.parseFloat(mark);
  const start = Number.isFinite(parsed) ? parsed : nowSec() - FIRST_RUN_LOOKBACK_S;
  return Math.max(start, floor);
}

const inFlight = new Set<string>();
const lastRunAt = new Map<string, number>();

export async function runBackfill(
  ctx: BackfillContext,
  mode: BackfillMode,
  reason: string,
): Promise<void> {
  const key = ctx.workspaceKey;
  if (inFlight.has(key)) return; // a sweep is already running for this workspace
  const since = Date.now() - (lastRunAt.get(key) ?? 0);
  if (since < MIN_RUN_GAP_MS) return; // debounce reconnect storms

  inFlight.add(key);
  lastRunAt.set(key, Date.now());
  const startedAt = Date.now();
  let swept = 0;
  let stored = 0;
  let failed = 0;
  let replyBudget = mode === 'full' ? MAX_REPLY_FETCHES_FULL : MAX_REPLY_FETCHES_INCREMENTAL;

  try {
    // --- pick targets ---
    const targets = new Map<string, Target>();
    const add = (t: Target): void => {
      if (!targets.has(t.channelId)) targets.set(t.channelId, t);
    };

    try {
      for (const t of await listDmTargets(ctx, MAX_DM_CONVERSATIONS)) add(t);
    } catch (err) {
      console.warn(`[backfill] ${key}: conversations.list failed: ${errText(err)}`);
    }

    if (mode === 'full') {
      const windowStart = nowSec() - FIRST_RUN_LOOKBACK_S;
      const viaSearch = await searchMentionChannels(ctx, windowStart);
      try {
        for (const t of viaSearch ?? (await listChannelTargets(ctx, MAX_CHANNELS))) add(t);
      } catch (err) {
        console.warn(`[backfill] ${key}: channel listing failed: ${errText(err)}`);
      }
    } else {
      for (const t of trackedTargets(ctx, MAX_INCREMENTAL_CONVERSATIONS)) add(t);
    }

    // --- sweep each conversation, serialized ---
    // Marks move to ~now as we go, so remember where each conversation *started* — the
    // tracked-thread pass below still needs the pre-sweep window to find old replies.
    const sweepStart = new Map<string, number>();
    for (const target of targets.values()) {
      if (swept > 0) await sleep(API_DELAY_MS);
      swept += 1;
      const oldest = oldestFor(ctx, target.channelId);
      sweepStart.set(target.channelId, oldest);
      const oldestTs = oldest.toFixed(6);
      let newestSeen: number | null = null;

      // A message we failed to store must be re-offered next sweep, so any failure here
      // pins this conversation's high-water mark.
      let incomplete = false;
      const ingestOne = async (msg: any): Promise<void> => {
        const t = Number.parseFloat(msg?.ts ?? '');
        try {
          if (await ctx.ingest(msg, target.channelId, target.type)) stored += 1;
          if (Number.isFinite(t)) newestSeen = newestSeen === null ? t : Math.max(newestSeen, t);
        } catch (err) {
          incomplete = true;
          console.warn(`[backfill] ${key}: store failed in ${target.channelId}: ${errText(err)}`);
        }
      };

      try {
        const { messages, truncated } = await historySince(ctx, target.channelId, oldestTs);
        messages.sort((a, b) => Number.parseFloat(a.ts ?? '0') - Number.parseFloat(b.ts ?? '0'));

        for (const msg of messages) await ingestOne(msg);

        // Threaded replies never appear in conversations.history.
        for (const msg of messages) {
          if (replyBudget <= 0) break;
          const replyCount = Number(msg?.reply_count ?? 0);
          const latestReply = Number.parseFloat(msg?.latest_reply ?? '');
          if (replyCount <= 0 || !Number.isFinite(latestReply) || latestReply <= oldest) continue;
          replyBudget -= 1;
          await sleep(API_DELAY_MS);
          try {
            for (const reply of await repliesSince(ctx, target.channelId, msg.ts, oldest)) {
              await ingestOne(reply);
            }
          } catch (err) {
            incomplete = true;
            console.warn(
              `[backfill] ${key}: conversations.replies failed for ${target.channelId}: ${errText(err)}`,
            );
          }
        }

        // Advance the high-water mark. Anything that failed to store leaves the mark alone
        // so the whole window is re-offered next sweep (dedup makes that cheap). If we
        // stopped paginating early we can only trust what we actually read; otherwise the
        // window is fully covered up to ~now.
        const mark = incomplete
          ? null
          : truncated
            ? newestSeen
            : Math.max(newestSeen ?? 0, oldest, nowSec() - MARK_SAFETY_S);
        if (mark !== null && mark > 0) {
          setSyncMark(key, target.channelId, mark.toFixed(6));
        }
      } catch (err) {
        failed += 1;
        console.warn(
          `[backfill] ${key}: conversations.history failed for ${target.channelId}: ${errText(err)}`,
        );
      }
    }

    // --- tracked mention threads: catch replies to threads whose parent is out of window ---
    const sinceTs = (nowSec() - MAX_LOOKBACK_S).toFixed(6);
    for (const thread of listRecentMentionThreads(key, sinceTs, replyBudget)) {
      if (replyBudget <= 0) break;
      replyBudget -= 1;
      await sleep(API_DELAY_MS);
      const oldest = sweepStart.get(thread.channel_id) ?? oldestFor(ctx, thread.channel_id);
      try {
        for (const reply of await repliesSince(ctx, thread.channel_id, thread.thread_ts, oldest)) {
          if (await ctx.ingest(reply, thread.channel_id, 'channel')) stored += 1;
        }
      } catch (err) {
        console.warn(
          `[backfill] ${key}: conversations.replies failed for tracked thread in ` +
            `${thread.channel_id}: ${errText(err)}`,
        );
      }
    }
  } catch (err) {
    console.error(`[backfill] ${key}: sweep aborted: ${errText(err)}`);
  } finally {
    inFlight.delete(key);
    lastRunAt.set(key, Date.now());
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    const problems = failed > 0 ? `, ${failed} failed` : '';
    console.log(
      `[backfill] ${key} (${mode}, ${reason}): ${swept} conversations, ` +
        `${stored} new messages${problems} (${secs}s)`,
    );
  }
}

/**
 * Periodic safety net + wake detection.
 *
 * The heartbeat doubles as a sleep detector: if a tick lands much later than scheduled the
 * machine was suspended (laptop lid closed), which is exactly the case Socket Mode cannot
 * cover, so we run a full sweep instead of waiting for the next cheap one.
 */
export function startBackfillScheduler(ctx: BackfillContext): void {
  let expected = Date.now() + HEARTBEAT_MS;
  let nextIncremental = Date.now() + INCREMENTAL_MS;
  let incrementalCount = 0;

  const timer = setInterval(() => {
    const now = Date.now();
    const drift = now - expected;
    expected = now + HEARTBEAT_MS;

    if (drift > WAKE_GAP_MS) {
      const minutes = Math.round(drift / 60_000);
      console.log(`[backfill] ${ctx.workspaceKey}: woke after ~${minutes}m asleep — catching up`);
      nextIncremental = now + INCREMENTAL_MS;
      void runBackfill(ctx, 'full', 'wake');
      return;
    }

    if (now >= nextIncremental) {
      nextIncremental = now + INCREMENTAL_MS;
      incrementalCount += 1;
      const promote = incrementalCount % FULL_EVERY_N_INCREMENTAL === 0;
      void runBackfill(ctx, promote ? 'full' : 'incremental', 'periodic');
    }
  }, HEARTBEAT_MS);
  timer.unref();
}
