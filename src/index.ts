import { workspaces, PORT } from './config.js';
import { DB_PATH } from './db.js';
import { selectHarness } from './harness/index.js';
import { startServer } from './server.js';
import { startIngest } from './ingest.js';
import { startAnalyzer, preflightAnalyzerHarness } from './analyzer.js';
import { startEmailIngest } from './email.js';

async function main(): Promise<void> {
  console.log(`[main] db: ${DB_PATH}`);

  /*
   * Resolve COPILOT_HARNESS before anything listens. An unknown id is a config error and
   * is fatal here, with the valid ids printed — falling back to Claude Code silently
   * would bill the wrong account and hide the typo. A KNOWN harness that is merely
   * unavailable right now is not fatal: the app starts, Slack ingest and the feed and
   * the send path all work, and the analyzer reports it with that harness's own fix
   * command (see preflightAnalyzerHarness below).
   */
  selectHarness();

  await startServer(PORT);

  if (workspaces.length === 0) {
    console.warn(
      '[main] no workspaces configured — set tokens in .env (see .env.example). ' +
        'Web UI is up; Slack ingest is idle.',
    );
  } else {
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

  await preflightAnalyzerHarness(); // never throws: reports, it does not crash
  startAnalyzer(); // no-op with ANALYZER_DISABLED=1
  startEmailIngest(); // no-op unless COPILOT_EMAIL=1
}

main().catch((err) => {
  console.error('[main] fatal:', err);
  process.exit(1);
});
