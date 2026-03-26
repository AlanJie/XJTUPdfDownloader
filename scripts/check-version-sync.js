#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const sourceHeaderPath = path.join(rootDir, 'src', 'reader_downloader', 'parts', '00_userscript_header.js');
const rootBundlePath = path.join(rootDir, 'XJTUPdfDownloader.js');
const distBundlePath = path.join(rootDir, 'dist', 'XJTUPdfDownloader.user.js');

function readVersionFromFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const match = text.match(/@version\s+([^\s]+)/);
  if (!match) {
    throw new Error(`unable to find @version in ${path.relative(rootDir, filePath)}`);
  }
  return match[1].trim();
}

function main() {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const packageVersion = String(packageJson.version || '').trim();
  if (!packageVersion) {
    throw new Error('package.json version is empty');
  }

  const targets = [
    { label: 'source header', filePath: sourceHeaderPath },
    { label: 'root bundle', filePath: rootBundlePath },
    { label: 'dist bundle', filePath: distBundlePath },
  ];

  const mismatches = targets
    .map((target) => ({
      ...target,
      version: readVersionFromFile(target.filePath),
    }))
    .filter((target) => target.version !== packageVersion);

  if (mismatches.length > 0) {
    mismatches.forEach((item) => {
      console.error(
        `[check:version] ${item.label} version mismatch: expected ${packageVersion}, got ${item.version}`,
      );
    });
    process.exit(1);
  }

  console.log(`[check:version] version synced at ${packageVersion}`);
}

main();
