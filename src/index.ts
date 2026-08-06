import { workspaces, PORT } from './config.js';
import { DB_PATH } from './db.js';
import { startServer } from './server.js';
import { startIngest } from './ingest.js';

async function main(): Promise<void> {
  console.log(`[main] db: ${DB_PATH}`);

  await startServer(PORT);

  if (workspaces.length === 0) {
    console.warn(
      '[main] no workspaces configured — set tokens in .env (see .env.example). ' +
        'Web UI is up; Slack ingest is idle.',
    );
    return;
  }

  console.log(`[main] configured workspaces: ${workspaces.map((w) => w.key).join(', ')}`);
  for (const ws of workspaces) {
    try {
      await startIngest(ws);
    } catch (err) {
      console.error(
        `[main] failed to start ingest for workspace ${ws.key} — check its tokens:`,
        err,
      );
    }
  }
}

main().catch((err) => {
  console.error('[main] fatal:', err);
  process.exit(1);
});
