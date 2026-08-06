#!/usr/bin/env node
/**
 * Builds "Slack Copilot.app" into release/mac-arm64/.
 *
 * There is no Apple Developer certificate involved, so the finished bundle gets an
 * ad-hoc signature (`codesign --sign -`). That does not make macOS trust the app —
 * the user still has to right-click → Open the first time — but it does mean the
 * bundle has a valid, self-consistent signature, which avoids the much worse
 * "the application is damaged" dialog.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.join(root, 'release', 'mac-arm64', 'Slack Copilot.app');

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    console.error(`\n${cmd} failed with exit code ${res.status}`);
    process.exit(res.status ?? 1);
  }
}

run(process.execPath, [path.join(root, 'scripts', 'prepare-app.mjs')]);

const builder = path.join(root, 'node_modules', '.bin', 'electron-builder');
run(builder, ['--mac', '--config', path.join(root, 'electron', 'builder.yml')], {
  env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
});

if (!existsSync(appPath)) {
  console.error(`\nExpected the app at ${appPath} but it is not there.`);
  process.exit(1);
}

console.log('\nApplying an ad-hoc signature…');
run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath]);
try {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });
  console.log('Signature verified.');
} catch {
  console.warn('Signature check reported problems; the app will still run.');
}

console.log(`\nBuilt: ${appPath}`);
console.log('Install it by double-clicking install.command in the project folder.');
