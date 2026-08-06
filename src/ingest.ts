import bolt from '@slack/bolt';
import type { Workspace } from './config.js';
import {
  findThread,
  insertThread,
  insertMessage,
  markThreadActive,
  touchThreadActivity,
  setThreadChannelName,
  setThreadPermalink,
  type ThreadRow,
} from './db.js';
import {
  runBackfill,
  startBackfillScheduler,
  type BackfillContext,
  type ConversationType,
} from './backfill.js';

const { App } = bolt;

const ALLOWED_SUBTYPES = new Set<string | undefined>([undefined, 'file_share', 'thread_broadcast']);

/** How long before we retry resolving a channel name / permalink that came back empty. */
const METADATA_RETRY_MS = 10 * 60_000;

/** Depth cap for walking untrusted `blocks` payloads. */
const BLOCK_SCAN_MAX_DEPTH = 8;

interface WorkspaceRuntime {
  key: string;
  myUserId: string;
  teamName: string;
  client: any;
  /** Successful lookups only — a failed users.info must not stick as "unknown" forever. */
  userNameCache: Map<string, string>;
  /** thread id → last time we tried to fill in missing channel_name / permalink. */
  metadataRetryAt: Map<number, number>;
}

// ---------- mention detection ----------

/**
 * Slack renders a mention as `<@U123>` in `text`, but a client that sends rich text puts it
 * in `blocks` as `{type:'user', user_id:'U123'}` — and older payloads use the labelled form
 * `<@U123|name>`. Scanning `text` alone silently misses both.
 */
function blocksMentionUser(node: unknown, userId: string, depth = 0): boolean {
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

function mentionsUser(ev: any, userId: string): boolean {
  const text = typeof ev?.text === 'string' ? ev.text : '';
  if (text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`)) return true;
  return blocksMentionUser(ev?.blocks, userId);
}

// ---------- Slack lookups ----------

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
    const name: string | null =
      u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || null;
    // Only successes are cached: a transient failure must not pin this user to "unknown"
    // for the lifetime of the process.
    if (name !== null) rt.userNameCache.set(userId, name);
    return name;
  } catch (err) {
    console.warn(`[ingest] users.info failed for ${userId}:`, (err as Error).message);
    return null;
  }
}

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
 */
async function ingestMessage(rt: WorkspaceRuntime, ev: any): Promise<boolean> {
  if (!ALLOWED_SUBTYPES.has(ev?.subtype)) return false;
  const ts: unknown = ev?.ts;
  const channelId: unknown = ev?.channel;
  if (typeof ts !== 'string' || typeof channelId !== 'string') return false;

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
      console.log(
        `[${rt.key}] new ${thread.kind} thread #${thread.id} in ` +
          `${channelName ?? channelId} (${rt.teamName})`,
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

  if (isMe) {
    touchThreadActivity(thread.id, ts);
  } else {
    markThreadActive(thread.id, ts);
  }

  if (!created) await fillMissingMetadata(rt, thread, ts);
  return true;
}

// ---------- connection lifecycle ----------

/**
 * Socket Mode never replays what happened while we were disconnected, so every reconnect
 * needs a catch-up sweep. @slack/socket-mode v3 (Bolt v5's receiver) emits its internal
 * State enum values on the SocketModeClient: 'connecting' | 'authenticated' | 'connected' |
 * 'reconnecting' | 'disconnecting' | 'disconnected' (verified in node_modules).
 */
function attachConnectionHooks(app: any, ctx: BackfillContext): void {
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
    if (!everConnected) {
      everConnected = true; // the startup sweep covers the first connect
      return;
    }
    console.log(`[${ctx.workspaceKey}] socket reconnected — catching up on the gap`);
    void runBackfill(ctx, 'full', 'reconnect');
  });
  smClient.on('disconnected', () => {
    console.log(
      `[${ctx.workspaceKey}] socket disconnected — anything sent now is caught up on reconnect`,
    );
  });
}

// ---------- startup ----------

export async function startIngest(ws: Workspace): Promise<void> {
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

  const auth = (await app.client.auth.test()) as any;
  const rt: WorkspaceRuntime = {
    key: ws.key,
    myUserId: auth.user_id as string,
    teamName: (auth.team as string) ?? ws.key,
    client: app.client,
    userNameCache: new Map(),
    metadataRetryAt: new Map(),
  };

  app.event('message', async ({ event }) => {
    try {
      await ingestMessage(rt, event as any);
    } catch (err) {
      console.error(`[${ws.key}] error handling message event:`, err);
    }
  });

  const backfillCtx: BackfillContext = {
    workspaceKey: ws.key,
    client: app.client,
    myUserId: rt.myUserId,
    myUserName: typeof auth.user === 'string' ? auth.user : null,
    ingest: (msg: any, channelId: string, channelType: ConversationType) =>
      ingestMessage(rt, { ...msg, channel: channelId, channel_type: channelType }),
  };

  attachConnectionHooks(app, backfillCtx);

  await app.start();
  console.log(`[${ws.key}] connected to "${rt.teamName}" as user ${rt.myUserId} (socket mode)`);

  startBackfillScheduler(backfillCtx);
  void runBackfill(backfillCtx, 'full', 'startup');
}
