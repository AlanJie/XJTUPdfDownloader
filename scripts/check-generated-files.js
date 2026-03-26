#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const trackedTargets = ['XJTUPdfDownloader.js', 'dist/XJTUPdfDownloader.user.js'];

function main() {
  const diffArgs = ['diff', '--exit-code', '--', ...trackedTargets];

  try {
    execFileSync('git', diffArgs, {
      cwd: rootDir,
      stdio: 'ignore',
    });
    console.log('[check:generated] generated files are up to date');
  } catch {
    console.error(
      `[check:generated] generated files differ from source. Re-run build and commit updates for: ${trackedTargets.join(', ')}`,
    );
    process.exit(1);
  }
}

main();
