import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getFeed,
  getThreadById,
  getMessagesForThread,
  getAnalysisForThread,
  setThreadStatus,
} from './db.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(projectRoot, 'public');

const VALID_STATUSES = new Set(['new', 'seen', 'done']);

export function startServer(port: number): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get('/api/feed', (_req, res) => {
    try {
      res.json(getFeed());
    } catch (err) {
      console.error('[server] /api/feed failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.get('/api/thread/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid thread id' });
      return;
    }
    try {
      const thread = getThreadById(id);
      if (!thread) {
        res.status(404).json({ error: 'thread not found' });
        return;
      }
      res.json({
        ...thread,
        messages: getMessagesForThread(id),
        analysis: getAnalysisForThread(id) ?? null,
      });
    } catch (err) {
      console.error('[server] /api/thread failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/api/thread/:id/status', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid thread id' });
      return;
    }
    const status = (req.body as { status?: unknown } | undefined)?.status;
    if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
      res.status(400).json({ error: "status must be one of 'new'|'seen'|'done'" });
      return;
    }
    try {
      const updated = setThreadStatus(id, status as 'new' | 'seen' | 'done');
      if (!updated) {
        res.status(404).json({ error: 'thread not found' });
        return;
      }
      res.json({ ok: true, id, status });
    } catch (err) {
      console.error('[server] status update failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.use(express.static(publicDir));

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      console.log(`[server] listening on http://127.0.0.1:${port}`);
      resolve();
    });
    server.on('error', reject);
  });
}
