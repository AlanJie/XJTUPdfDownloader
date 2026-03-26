#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const tagName = String(process.argv[2] || '').trim();
if (!tagName) {
  console.error('[check:tag] missing tag name argument');
  process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const expectedTag = `v${String(packageJson.version || '').trim()}`;

if (tagName !== expectedTag) {
  console.error(`[check:tag] tag mismatch: expected ${expectedTag}, got ${tagName}`);
  process.exit(1);
}

console.log(`[check:tag] tag matches package version (${expectedTag})`);
