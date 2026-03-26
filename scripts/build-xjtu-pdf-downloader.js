#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const partsDir = path.join(rootDir, 'src', 'reader_downloader', 'parts');
const defaultOutput = path.join(rootDir, 'XJTUPdfDownloader.js');
const distOutput = path.join(rootDir, 'dist', 'XJTUPdfDownloader.user.js');

const cliOutput = process.argv[2]
  ? path.resolve(rootDir, process.argv[2])
  : defaultOutput;

if (!fs.existsSync(partsDir)) {
  console.error(`[build] parts directory not found: ${partsDir}`);
  process.exit(1);
}

const partFiles = fs.readdirSync(partsDir)
  .filter((file) => file.endsWith('.js'))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

if (partFiles.length === 0) {
  console.error('[build] no part files found under src/reader_downloader/parts');
  process.exit(1);
}

const bundle = partFiles
  .map((file) => {
    const filePath = path.join(partsDir, file);
    return fs.readFileSync(filePath, 'utf8').replace(/\s+$/, '');
  })
  .join('\n\n') + '\n';

fs.mkdirSync(path.dirname(cliOutput), { recursive: true });
fs.writeFileSync(cliOutput, bundle, 'utf8');

fs.mkdirSync(path.dirname(distOutput), { recursive: true });
fs.writeFileSync(distOutput, bundle, 'utf8');

console.log(`[build] assembled ${partFiles.length} parts`);
console.log(`[build] output: ${cliOutput}`);
console.log(`[build] dist  : ${distOutput}`);
