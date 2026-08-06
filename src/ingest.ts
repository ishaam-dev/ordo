import bolt from '@slack/bolt';
import type { Workspace } from './config.js';
import {
  findThread,
  insertThread,
  insertMessage,
  markThreadActive,
  touchThreadActivity,
} from './db.js';

const { App } = bolt;

const ALLOWED_SUBTYPES = new Set<string | undefined>([undefined, 'file_share', 'thread_broadcast']);

interface WorkspaceRuntime {
  myUserId: string;
  teamName: string;
  userNameCache: Map<string, string | null>;
}

async function resolveUserName(
  client: any,
  rt: WorkspaceRuntime,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  if (rt.userNameCache.has(userId)) return rt.userNameCache.get(userId) ?? null;
  let name: string | null = null;
  try {
    const res = await client.users.info({ user: userId });
    const u = (res as any).user;
    name = u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || null;
  } catch (err) {
    console.warn(`[ingest] users.info failed for ${userId}:`, (err as Error).message);
  }
  rt.userNameCache.set(userId, name);
  return name;
}

async function resolveChannelName(
  client: any,
  rt: WorkspaceRuntime,
  channelId: string,
): Promise<string | null> {
  try {
    const res = await client.conversations.info({ channel: channelId });
    const ch = (res as any).channel;
    if (ch?.is_im) {
      // DM: name it after the counterpart user.
      return (await resolveUserName(client, rt, ch.user)) ?? channelId;
    }
    return ch?.name ?? null;
  } catch (err) {
    console.warn(`[ingest] conversations.info failed for ${channelId}:`, (err as Error).message);
    return null;
  }
}

async function resolvePermalink(
  client: any,
  channelId: string,
  ts: string,
): Promise<string | null> {
  try {
    const res = await client.chat.getPermalink({ channel: channelId, message_ts: ts });
    return (res as any).permalink ?? null;
  } catch (err) {
    console.warn(`[ingest] chat.getPermalink failed for ${channelId}/${ts}:`, (err as Error).message);
    return null;
  }
}

export async function startIngest(ws: Workspace): Promise<void> {
  const app = new App({
    token: ws.userToken,
    appToken: ws.appToken,
    socketMode: true,
  });

  const auth = (await app.client.auth.test()) as any;
  const rt: WorkspaceRuntime = {
    myUserId: auth.user_id as string,
    teamName: (auth.team as string) ?? ws.key,
    userNameCache: new Map(),
  };

  app.event('message', async ({ event, client }) => {
    try {
      const ev = event as any;

      if (!ALLOWED_SUBTYPES.has(ev.subtype)) return;
      if (!ev.ts || !ev.channel) return;

      const channelId: string = ev.channel;
      const ts: string = ev.ts;
      const parentTs: string = ev.thread_ts || ev.ts;
      const text: string = ev.text ?? '';
      const authorId: string | null = ev.user ?? null;

      const isDM = ev.channel_type === 'im' || ev.channel_type === 'mpim';
      const mentionsMe = text.includes(`<@${rt.myUserId}>`);
      const isMe = authorId === rt.myUserId;

      let thread = findThread(ws.key, channelId, parentTs);

      if (isMe) {
        // My own message: only append when the thread is already tracked.
        if (!thread) return;
      } else if (!thread && !isDM && !mentionsMe) {
        // Not a DM, doesn't mention me, not a tracked thread — drop silently.
        return;
      }

      if (!thread) {
        // First sight of this thread: resolve channel name + permalink (best effort).
        const channelName = await resolveChannelName(client, rt, channelId);
        const permalink = await resolvePermalink(client, channelId, parentTs);
        const id = insertThread({
          workspace: ws.key,
          teamName: rt.teamName,
          channelId,
          channelName,
          threadTs: parentTs,
          kind: isDM ? 'dm' : 'mention',
          lastActivity: ts,
          permalink,
        });
        thread = {
          id,
          workspace: ws.key,
          team_name: rt.teamName,
          channel_id: channelId,
          channel_name: channelName,
          thread_ts: parentTs,
          kind: isDM ? 'dm' : 'mention',
          status: 'new',
          last_activity: ts,
          permalink,
        };
        console.log(
          `[${ws.key}] new ${thread.kind} thread #${id} in ${channelName ?? channelId} (${rt.teamName})`,
        );
      }

      const authorName = await resolveUserName(client, rt, authorId);

      let raw: string | null = null;
      try {
        raw = JSON.stringify(ev);
      } catch {
        raw = null;
      }

      insertMessage({
        threadId: thread.id,
        ts,
        authorId,
        authorName,
        text: text || null,
        raw,
      });

      if (isMe) {
        touchThreadActivity(thread.id, ts);
      } else {
        markThreadActive(thread.id, ts);
      }
    } catch (err) {
      console.error(`[${ws.key}] error handling message event:`, err);
    }
  });

  await app.start();
  console.log(
    `[${ws.key}] connected to "${rt.teamName}" as user ${rt.myUserId} (socket mode)`,
  );
}
