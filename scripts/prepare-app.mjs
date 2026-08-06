#!/usr/bin/env node
/**
 * Everything the Mac app needs before it can be run or packaged:
 *   1. draw the icons
 *   2. copy them next to the main process (so the bundle is self-contained)
 *   3. record where this project folder lives, so the app can find src/index.ts,
 *      .env and data.db at runtime
 *
 * Both generated outputs (electron/assets/, electron/project-path.json) are build
 * artefacts — safe to delete, regenerated every build.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');
const appAssets = path.join(root, 'electron', 'assets');

execFileSync(process.execPath, [path.join(root, 'scripts', 'make-icons.mjs')], {
  stdio: 'inherit',
});

rmSync(appAssets, { recursive: true, force: true });
mkdirSync(appAssets, { recursive: true });
for (const file of readdirSync(assets)) {
  if (/\.(png|icns)$/i.test(file)) cpSync(path.join(assets, file), path.join(appAssets, file));
}

const port = Number(process.env.SLACK_COPILOT_PORT) || 5252;
writeFileSync(
  path.join(root, 'electron', 'project-path.json'),
  JSON.stringify({ projectDir: root, port, generatedAt: new Date().toISOString() }, null, 2) + '\n',
);

console.log(`app assets  -> ${appAssets}`);
console.log(`project dir -> ${root} (port ${port})`);
