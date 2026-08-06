import bolt from '@slack/bolt';
import type { Workspace } from './config.js';
import {
  findThread,
  insertThread,
  insertMessage,
  markThreadActive,
  markThreadSeenIfNew,
  touchThreadActivity,
  setThreadChannelName,
  setThreadPermalink,
  updateMessageText,
  markMessageDeleted,
  markAnalysisStale,
  ensureWatchStart,
  upsertSlackUser,
  listUserIdsNeedingProfile,
  type SlackUserProfile,
  type ThreadRow,
} from './db.js';
import { registerIngestHealth } from './health.js';
import {
  runBackfill,
  startBackfillScheduler,
  type BackfillContext,
  type ConversationType,
} from './backfill.js';

const { App } = bolt;

const ALLOWED_SUBTYPES = new Set<string | undefined>([undefined, 'file_share', 'thread_broadcast']);

/**
 * Subtypes that are not new messages but corrections to ones we may already show:
 * someone edited or deleted their message in Slack. Dropping these (as we used to) leaves
 * a card quoting words that no longer exist — the single most misleading thing this app
 * could do to someone triaging. Payload shapes verified in
 * node_modules/@slack/types/dist/events/message.d.ts:
 *   message_changed: { channel, ts (event ts), message, previous_message }
 *   message_deleted: { channel, ts (event ts), deleted_ts, previous_message }
 * Note `ts` is the *event's* time in both — the message itself is `message.ts` /
 * `deleted_ts`.
 */
const MUTATION_SUBTYPES = new Set<string>(['message_changed', 'message_deleted']);

/** How long before we retry resolving a channel name / permalink that came back empty. */
const METADATA_RETRY_MS = 10 * 60_000;

/** Depth cap for walking untrusted `blocks` payloads. */
const BLOCK_SCAN_MAX_DEPTH = 8;

/**
 * Profile sweep bounds. `users.info` is Tier 4 (~100 calls/minute), and the Slack
 * WebClient already honours Retry-After on a 429 — these keep a sweep an order of
 * magnitude under the limit anyway, because filling in who people are is never urgent.
 */
const PROFILE_SWEEP_DELAY_MS = 600;
const PROFILE_SWEEP_MAX_USERS = 100;
/** Let the catch-up sweep have the connection to itself first. */
const PROFILE_SWEEP_START_DELAY_MS = 30_000;
/** Titles change (promotions, role moves), so a stored profile is refreshed eventually. */
const PROFILE_STALE_MS = 14 * 24 * 60 * 60_000;
const PROFILE_SWEEP_EVERY_MS = 6 * 60 * 60_000;
/** Slack profile text is written by the person themselves: cap what we store. */
const MAX_PROFILE_FIELD = 120;

export interface WorkspaceRuntime {
  key: string;
  myUserId: string;
  teamName: string;
  client: any;
  /** Successful lookups only — a failed users.info must not stick as "unknown" forever. */
  userNameCache: Map<string, string>;
  /** thread id → last time we tried to fill in missing channel_name / permalink. */
  metadataRetryAt: Map<number, number>;
  /**
   * Slack ts (seconds) of the moment we first ever connected to this workspace. Messages
   * the catch-up sweep finds from before it are history the user already read in Slack, so
   * they are stored without marking the conversation unread. See the WATCH-START RULE in
   * src/db.ts. -Infinity until the mark is loaded (which happens before the first sweep),
   * so the failure direction is "a message stays unread", never "a real message is
   * silently filed as already-read".
   */
  watchStart: number;
}

// ---------- mention detection ----------

/**
 * Slack renders a mention as `<@U123>` in `text`, but a client that sends rich text puts it
 * in `blocks` as `{type:'user', user_id:'U123'}` — and older payloads use the labelled form
 * `<@U123|name>`. Scanning `text` alone silently misses both.
 */
export function blocksMentionUser(node: unknown, userId: string, depth = 0): boolean {
  if (node === null || typeof node !== 'object' || depth > BLOCK_SCAN_MAX_DEPTH) return false;
  if (Array.isArray(node)) {
    return node.some((child) => blocksMentionUser(child, userId, depth + 1));
  }
  const obj = node as Record<string, unknown>;
  if (obj.type === 'user' && obj.user_id === userId) return true;
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === 'object' && blocksMentionUser(value, userId, depth + 1)) {
      return true;
    }
  }
  return false;
}

export function mentionsUser(ev: any, userId: string): boolean {
  const text = typeof ev?.text === 'string' ? ev.text : '';
  if (text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`)) return true;
  return blocksMentionUser(ev?.blocks, userId);
}

// ---------- who the sender is ----------

/**
 * One field of a Slack profile, made safe to store and to put in a prompt: people write
 * their own display name and job title, so a newline in one could otherwise forge a
 * transcript line or a section marker. Collapsed to a single line and capped.
 */
export function cleanProfileField(value: unknown, max = MAX_PROFILE_FIELD): string | null {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * What `users.info` carries beyond the display name, distilled for storage.
 *
 * Verified against both of this install's workspaces under the manifest's existing
 * `users:read` scope: `profile.title`, `profile.real_name` / `display_name`, the top-level
 * `is_admin` / `is_owner` / `is_primary_owner` / `is_bot` flags and `tz` / `tz_label` all
 * come back. (`profile.email` does NOT — that needs `users:read.email`, which this app does
 * not request, and nothing here wants it.) Every field is optional: a workspace that hides
 * titles, or a response we only half understand, yields nulls rather than an exception.
 */
export function profileFromUsersInfo(
  workspace: string,
  userId: string,
  user: unknown,
): SlackUserProfile {
  const u = (user ?? {}) as Record<string, any>;
  const profile = (u.profile ?? {}) as Record<string, unknown>;
  return {
    workspace,
    userId,
    displayName: cleanProfileField(profile.display_name) ?? cleanProfileField(u.name),
    realName: cleanProfileField(profile.real_name) ?? cleanProfileField(u.real_name),
    title: cleanProfileField(profile.title),
    isAdmin: boolOrNull(u.is_admin),
    isOwner: boolOrNull(u.is_owner),
    isPrimaryOwner: boolOrNull(u.is_primary_owner),
    isBot: boolOrNull(u.is_bot),
    tz: cleanProfileField(u.tz, 60),
    tzLabel: cleanProfileField(u.tz_label, 60),
  };
}

function nameFromUsersInfo(user: unknown): string | null {
  const u = (user ?? {}) as Record<string, any>;
  return u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || null;
}

/**
 * Store what a `users.info` response says about someone. Best effort in the strongest
 * sense: a database hiccup here must never cost us the message that triggered the lookup.
 */
function storeProfile(rt: WorkspaceRuntime, userId: string, user: unknown): void {
  try {
    upsertSlackUser(profileFromUsersInfo(rt.key, userId, user));
  } catch (err) {
    console.warn(`[${rt.key}] could not store the profile for ${userId}:`, (err as Error).message);
  }
}

async function resolveUserName(
  rt: WorkspaceRuntime,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  const cached = rt.userNameCache.get(userId);
  if (cached !== undefined) return cached;
  try {
    const res = await rt.client.users.info({ user: userId });
    const u = (res as any).user;
    const name: string | null = nameFromUsersInfo(u);
    // The same response already carries the title and the admin/owner flags, so learning
    // who this person is costs no extra API call — just a row.
    storeProfile(rt, userId, u);
    // Only successes are cached: a transient failure must not pin this user to "unknown"
    // for the lifetime of the process.
    if (name !== null) rt.userNameCache.set(userId, name);
    return name;
  } catch (err) {
    console.warn(`[ingest] users.info failed for ${userId}:`, (err as Error).message);
    return null;
  }
}

const profileSweepInFlight = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fill in the people we already have messages from but no profile for — the backlog in an
 * existing database, plus anyone whose stored profile has gone stale.
 *
 * Live messages fill themselves in for free (the name lookup already calls `users.info`),
 * so this only ever has the leftovers to do. Serialized and paced, capped per run, and
 * every failure is skipped rather than retried: a profile we cannot fetch is a line the
 * prompt simply does not have, never a reason to stop ingesting.
 */
export async function syncUserProfiles(rt: WorkspaceRuntime): Promise<number> {
  if (profileSweepInFlight.has(rt.key)) return 0;
  profileSweepInFlight.add(rt.key);
  let filled = 0;
  try {
    let userIds: string[] = [];
    try {
      userIds = listUserIdsNeedingProfile(
        rt.key,
        new Date(Date.now() - PROFILE_STALE_MS).toISOString(),
        PROFILE_SWEEP_MAX_USERS,
      );
    } catch (err) {
      console.warn(`[${rt.key}] could not list people needing a profile:`, (err as Error).message);
      return 0;
    }

    for (let i = 0; i < userIds.length; i++) {
      if (i > 0) await sleep(PROFILE_SWEEP_DELAY_MS);
      const userId = userIds[i];
      try {
        const res = await rt.client.users.info({ user: userId });
        const u = (res as any).user;
        storeProfile(rt, userId, u);
        const name = nameFromUsersInfo(u);
        if (name !== null) rt.userNameCache.set(userId, name);
        filled += 1;
      } catch (err) {
        console.warn(`[${rt.key}] users.info failed for ${userId}:`, (err as Error).message);
      }
    }
    if (filled > 0) {
      console.log(`[${rt.key}] filled in ${filled} Slack profile(s) for people in the feed`);
    }
  } finally {
    profileSweepInFlight.delete(rt.key);
  }
  return filled;
}

// ---------- Slack lookups ----------

async function resolveChannelName(rt: WorkspaceRuntime, channelId: string): Promise<string | null> {
  try {
    const res = await rt.client.conversations.info({ channel: channelId });
    const ch = (res as any).channel;
    if (ch?.is_im) {
      // DM: name it after the counterpart user.
      return (await resolveUserName(rt, ch.user)) ?? channelId;
    }
    return ch?.name ?? null;
  } catch (err) {
    console.warn(`[ingest] conversations.info failed for ${channelId}:`, (err as Error).message);
    return null;
  }
}

async function resolvePermalink(
  rt: WorkspaceRuntime,
  channelId: string,
  ts: string,
): Promise<string | null> {
  try {
    const res = await rt.client.chat.getPermalink({ channel: channelId, message_ts: ts });
    return (res as any).permalink ?? null;
  } catch (err) {
    console.warn(
      `[ingest] chat.getPermalink failed for ${channelId}/${ts}:`,
      (err as Error).message,
    );
    return null;
  }
}

/**
 * A thread first seen while Slack was unreachable keeps NULL channel_name/permalink
 * forever otherwise — the UI then shows a nameless card with a dead "open in Slack"
 * button. Retry on later messages, rate-limited per thread.
 */
async function fillMissingMetadata(
  rt: WorkspaceRuntime,
  thread: ThreadRow,
  messageTs: string,
): Promise<void> {
  if (thread.channel_name !== null && thread.permalink !== null) return;
  const lastTry = rt.metadataRetryAt.get(thread.id);
  if (lastTry !== undefined && Date.now() - lastTry < METADATA_RETRY_MS) return;
  rt.metadataRetryAt.set(thread.id, Date.now());

  if (thread.channel_name === null) {
    const name = await resolveChannelName(rt, thread.channel_id);
    if (name !== null) {
      setThreadChannelName(thread.id, name);
      thread.channel_name = name;
    }
  }
  if (thread.permalink === null) {
    // DM cards are keyed on the channel id, which is not a message ts — link to this
    // message instead; Slack resolves it to the conversation either way.
    const anchor = thread.kind === 'dm' ? messageTs : thread.thread_ts;
    const permalink = await resolvePermalink(rt, thread.channel_id, anchor);
    if (permalink !== null) {
      setThreadPermalink(thread.id, permalink);
      thread.permalink = permalink;
    }
  }
}

// ---------- the one filter + store path (live events *and* catch-up) ----------

/**
 * Apply the keep/drop rules and store the message. Returns true only when a new message
 * row was written, so redelivered or re-swept messages never re-open a thread the user
 * already handled.
 *
 * Keep rules (DESIGN.md): DMs, messages containing `<@me>`, replies in threads we already
 * track. My own messages are appended to threads we track but never create one and never
 * mark it unread.
 *
 * `historical` (WATCH-START RULE, src/db.ts) means "this predates the moment we started
 * watching, so the user read it in Slack days ago": the message is stored in full, but the
 * conversation is not marked unread on its account.
 */
export async function ingestMessage(
  rt: WorkspaceRuntime,
  ev: any,
  opts: { historical?: boolean } = {},
): Promise<boolean> {
  if (!ALLOWED_SUBTYPES.has(ev?.subtype)) return false;
  const ts: unknown = ev?.ts;
  const channelId: unknown = ev?.channel;
  if (typeof ts !== 'string' || typeof channelId !== 'string') return false;

  const historical = opts.historical === true;
  const isDM = ev.channel_type === 'im' || ev.channel_type === 'mpim';
  const text: string = typeof ev.text === 'string' ? ev.text : '';
  const authorId: string | null = typeof ev.user === 'string' ? ev.user : null;
  const isMe = authorId === rt.myUserId;
  const mentionsMe = mentionsUser(ev, rt.myUserId);

  /*
   * DMs are keyed on the conversation, not on each message: a back-and-forth with one
   * person is a single accumulating card carrying both sides, instead of one card per
   * message. Threaded replies inside a DM fold into that same card. Channel/group
   * mentions stay keyed on the real thread_ts.
   */
  const parentTs = isDM
    ? channelId
    : typeof ev.thread_ts === 'string' && ev.thread_ts !== ''
      ? ev.thread_ts
      : ts;

  let thread = findThread(rt.key, channelId, parentTs);
  let created = false;

  if (isMe) {
    // My own message: only append when the conversation is already tracked.
    if (!thread) return false;
  } else if (!thread && !isDM && !mentionsMe) {
    // Not a DM, doesn't mention me, not a tracked thread — drop silently.
    return false;
  }

  if (!thread) {
    // First sight of this thread: resolve channel name + permalink (best effort).
    const channelName = await resolveChannelName(rt, channelId);
    const permalink = await resolvePermalink(rt, channelId, isDM ? ts : parentTs);
    const inserted = insertThread({
      workspace: rt.key,
      teamName: rt.teamName,
      channelId,
      channelName,
      threadTs: parentTs,
      kind: isDM ? 'dm' : 'mention',
      lastActivity: ts,
      permalink,
    });
    created = inserted.created;
    // Whether we won or lost the insert race, read back the row that actually exists —
    // the loser must keep going and store its message, not throw it away.
    thread = findThread(rt.key, channelId, parentTs);
    if (!thread) return false;
    if (created) {
      // Threads are born unread; one we only learned about from history starts read, so a
      // first launch shows what is actually waiting instead of a wall of old news.
      if (historical) {
        markThreadSeenIfNew(thread.id);
        thread.status = 'seen';
      }
      console.log(
        `[${rt.key}] ${historical ? 'catching up on an older' : 'new'} ${thread.kind} ` +
          `thread #${thread.id} in ${channelName ?? channelId} (${rt.teamName})`,
      );
    }
  }

  const authorName = await resolveUserName(rt, authorId);

  let raw: string | null = null;
  try {
    raw = JSON.stringify(ev);
  } catch {
    raw = null;
  }

  const stored = insertMessage({
    threadId: thread.id,
    ts,
    authorId,
    authorName,
    text: text || null,
    raw,
  });
  if (!stored) return false; // already had it (redelivery or catch-up overlap)

  if (isMe || historical) {
    // Mine, or already read in Slack before this app existed: keep the conversation in the
    // right place in the feed, but do not claim it needs attention.
    touchThreadActivity(thread.id, ts);
  } else {
    markThreadActive(thread.id, ts);
  }

  if (!created) await fillMissingMetadata(rt, thread, ts);
  return true;
}

// ---------- edits and deletions made in Slack ----------

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/**
 * Someone changed or removed a message in Slack after we stored it.
 *
 * What this must get right:
 *   - An edited card must show the *current* wording, never the original.
 *   - A deleted message must stop being quoted.
 *   - Either way the analysis underneath is now about text that changed, so it is marked
 *     stale and re-runs.
 *   - Neither counts as new activity: a thread the user already marked done stays done,
 *     and a thread already read stays read. Someone fixing a typo must not put a
 *     conversation back in the inbox.
 */
export async function handleMessageMutation(rt: WorkspaceRuntime, ev: any): Promise<void> {
  const channelId: unknown = ev?.channel;
  if (typeof channelId !== 'string') return;

  const forget = (ts: string, what: string): void => {
    const done = markMessageDeleted({ workspace: rt.key, channelId, ts });
    // null = we never had it, so there is nothing on screen to correct; changed = false
    // means it was already gone and the analyzer has no reason to look again.
    if (done === null || !done.changed) return;
    markAnalysisStale(done.threadId);
    console.log(`[${rt.key}] ${what} in Slack — thread #${done.threadId} updated and re-queued`);
  };

  if (ev.subtype === 'message_deleted') {
    const ts =
      typeof ev.deleted_ts === 'string'
        ? ev.deleted_ts
        : typeof ev.previous_message?.ts === 'string'
          ? ev.previous_message.ts
          : null;
    if (ts !== null) forget(ts, 'a message was deleted');
    return;
  }

  // message_changed
  const msg = ev.message;
  if (msg === null || typeof msg !== 'object') return;
  const ts: unknown = msg.ts;
  if (typeof ts !== 'string') return;

  // Deleting the first message of a thread that has replies does not delete it — Slack
  // rewrites it as a tombstone, which arrives as an edit. Same meaning to a reader.
  if (msg.subtype === 'tombstone') {
    forget(ts, 'a message was removed');
    return;
  }

  const text: string = typeof msg.text === 'string' ? msg.text : '';
  const previous: string | null =
    typeof ev.previous_message?.text === 'string' ? ev.previous_message.text : null;
  // Slack also sends message_changed when it merely attaches a link preview or a reaction
  // summary. Nobody rewrote anything, so there is nothing to correct and no reason to make
  // the analyzer redo the thread.
  if (previous !== null && previous === text) return;

  const edit = updateMessageText({
    workspace: rt.key,
    channelId,
    ts,
    text: text === '' ? null : text,
    raw: safeJson(msg),
  });
  if (edit !== null) {
    if (edit.changed) {
      markAnalysisStale(edit.threadId);
      console.log(
        `[${rt.key}] a message was edited in Slack — thread #${edit.threadId} updated and re-queued`,
      );
    }
    return;
  }

  /*
   * We never stored this message. Usually that means it was never ours to keep — but an
   * edit can *add* an `@me` to a channel message, and that is the one case where an edit is
   * genuinely news. Offer the edited message to the normal filter, which applies the same
   * keep/drop rules as any live message and dedupes if we somehow already had it.
   */
  await ingestMessage(rt, { ...msg, channel: channelId, channel_type: ev.channel_type });
}

// ---------- connection lifecycle ----------

/**
 * Socket Mode never replays what happened while we were disconnected, so every reconnect
 * needs a catch-up sweep. @slack/socket-mode v3 (Bolt v5's receiver) emits its internal
 * State enum values on the SocketModeClient: 'connecting' | 'authenticated' | 'connected' |
 * 'reconnecting' | 'disconnecting' | 'disconnected' (verified in node_modules).
 *
 * These same events are the only honest source for "is Slack actually connected?", so each
 * one is also reported to the health registry (src/health.ts) and ends up in GET
 * /api/status. Before this, a silent disconnect looked exactly like a quiet afternoon: the
 * feed simply stopped growing and nothing anywhere said why.
 */
function attachConnectionHooks(app: any, rt: WorkspaceRuntime, ctx: BackfillContext): void {
  const smClient = app?.receiver?.client;
  if (smClient === undefined || typeof smClient.on !== 'function') {
    console.warn(
      `[${ctx.workspaceKey}] socket-mode client not reachable — catch-up will rely on the ` +
        'periodic sweep only',
    );
    return;
  }

  let everConnected = false;
  smClient.on('connected', () => {
    registerIngestHealth(rt.key, {
      state: 'connected',
      teamName: rt.teamName,
      message: null,
    });
    if (!everConnected) {
      everConnected = true; // the startup sweep covers the first connect
      return;
    }
    console.log(`[${ctx.workspaceKey}] socket reconnected — catching up on the gap`);
    void runBackfill(ctx, 'full', 'reconnect');
  });
  smClient.on('disconnected', () => {
    registerIngestHealth(rt.key, {
      state: 'reconnecting',
      teamName: rt.teamName,
      message: 'Lost the connection to Slack — trying again. Nothing sent meanwhile is lost.',
    });
    console.log(
      `[${ctx.workspaceKey}] socket disconnected — anything sent now is caught up on reconnect`,
    );
  });
  smClient.on('reconnecting', () => {
    registerIngestHealth(rt.key, {
      state: 'reconnecting',
      teamName: rt.teamName,
      message: 'Reconnecting to Slack…',
    });
  });
  smClient.on('connecting', () => {
    registerIngestHealth(rt.key, { state: 'connecting', teamName: rt.teamName, message: null });
  });
}

// ---------- startup ----------

export async function startIngest(ws: Workspace): Promise<void> {
  registerIngestHealth(ws.key, { state: 'connecting', message: 'Connecting to Slack…' });

  const app = new App({
    token: ws.userToken,
    appToken: ws.appToken,
    socketMode: true,
    /*
     * These are *user* tokens, so Bolt's auth.test resolves "me" as the app identity and
     * its default self-filter would drop every message I send — leaving the analyzer with
     * one-sided transcripts and re-flagging things I already answered. Own messages are
     * still never allowed to create a thread or mark one unread (see ingestMessage).
     */
    ignoreSelf: false,
  });

  let auth: any;
  try {
    auth = (await app.client.auth.test()) as any;
  } catch (err) {
    registerIngestHealth(ws.key, {
      state: 'error',
      message: "Slack would not accept this workspace's sign-in details.",
    });
    throw err;
  }

  const rt: WorkspaceRuntime = {
    key: ws.key,
    myUserId: auth.user_id as string,
    teamName: (auth.team as string) ?? ws.key,
    client: app.client,
    userNameCache: new Map(),
    metadataRetryAt: new Map(),
    watchStart: Number.NEGATIVE_INFINITY,
  };
  registerIngestHealth(ws.key, {
    state: 'connecting',
    teamName: rt.teamName,
    message: 'Connecting to Slack…',
  });

  app.event('message', async ({ event }) => {
    try {
      const ev = event as any;
      // Edits and deletions are corrections to what we already show, not new messages.
      if (MUTATION_SUBTYPES.has(ev?.subtype)) {
        await handleMessageMutation(rt, ev);
        return;
      }
      await ingestMessage(rt, ev);
    } catch (err) {
      console.error(`[${ws.key}] error handling message event:`, err);
    }
  });

  const backfillCtx: BackfillContext = {
    workspaceKey: ws.key,
    client: app.client,
    myUserId: rt.myUserId,
    myUserName: typeof auth.user === 'string' ? auth.user : null,
    ingest: (msg: any, channelId: string, channelType: ConversationType) => {
      /*
       * WATCH-START RULE (src/db.ts): anything the sweep finds from before we first
       * connected is history the user has already read in Slack. It is stored in full, but
       * it does not light up the feed, the menubar badge, or a notification.
       */
      const at = Number.parseFloat(msg?.ts ?? '');
      const historical = Number.isFinite(at) && at < rt.watchStart;
      return ingestMessage(
        rt,
        { ...msg, channel: channelId, channel_type: channelType },
        { historical },
      );
    },
    onSweep: (active: boolean) => {
      registerIngestHealth(rt.key, {
        state: 'connected',
        teamName: rt.teamName,
        message: active ? 'Catching up on messages from while the app was closed…' : null,
      });
    },
  };

  attachConnectionHooks(app, rt, backfillCtx);

  try {
    await app.start();
  } catch (err) {
    registerIngestHealth(ws.key, {
      state: 'error',
      teamName: rt.teamName,
      message: 'Could not connect to Slack.',
    });
    throw err;
  }
  registerIngestHealth(ws.key, { state: 'connected', teamName: rt.teamName, message: null });
  console.log(`[${ws.key}] connected to "${rt.teamName}" as user ${rt.myUserId} (socket mode)`);

  // Set before the first sweep can store anything, and only ever set once per workspace:
  // this is the line between "history" and "arrived while we were watching".
  rt.watchStart = ensureWatchStart(ws.key, Date.now() / 1000);
  console.log(
    `[${ws.key}] watching since ${new Date(rt.watchStart * 1000).toISOString()} — ` +
      'anything older than that is caught up quietly, without marking it unread',
  );

  startBackfillScheduler(backfillCtx);
  void runBackfill(backfillCtx, 'full', 'startup');

  /*
   * Who everyone is, in the background: the backlog of people already in the database, then
   * a slow refresh so a changed job title is not stale forever. Deliberately not awaited,
   * and deliberately behind the catch-up sweep — knowing someone's job title is never worth
   * competing for API calls with the messages themselves.
   */
  setTimeout(() => {
    void syncUserProfiles(rt);
  }, PROFILE_SWEEP_START_DELAY_MS).unref();
  setInterval(() => {
    void syncUserProfiles(rt);
  }, PROFILE_SWEEP_EVERY_MS).unref();
}
