#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const sourceHeaderPath = path.join(rootDir, 'src', 'reader_downloader', 'parts', '00_userscript_header.js');

function main() {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const nextVersion = String(packageJson.version || '').trim();
  if (!nextVersion) {
    throw new Error('package.json version is empty');
  }

  const source = fs.readFileSync(sourceHeaderPath, 'utf8');
  const currentMatch = source.match(/@version\s+([^\s]+)/);
  if (currentMatch && currentMatch[1] === nextVersion) {
    console.log(`[version:sync] userscript header already at ${nextVersion}`);
    return;
  }

  const updated = source.replace(/(@version\s+)([^\s]+)/, `$1${nextVersion}`);

  if (updated === source) {
    throw new Error('failed to update userscript header version');
  }

  fs.writeFileSync(sourceHeaderPath, updated, 'utf8');
  console.log(`[version:sync] synced userscript header to ${nextVersion}`);
}

main();
