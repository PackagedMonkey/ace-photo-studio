#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const verifyScript = path.join(rootDir, 'scripts', 'verify-helper-bundle.js');

function parseArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

function findAppBundles(dirPath, maxDepth = 4, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(dirPath)) return [];

  const found = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.name.endsWith('.app')) {
      found.push(fullPath);
      continue;
    }
    found.push(...findAppBundles(fullPath, maxDepth, depth + 1));
  }
  return found;
}

const appArg = parseArg('--app');
const appBundles = appArg
  ? [path.resolve(appArg)]
  : findAppBundles(distDir);

if (!appBundles.length) {
  console.error(`No .app bundle found to verify under ${distDir}`);
  process.exit(1);
}

let hasFailure = false;
for (const appBundle of appBundles) {
  console.log(`Verifying helper bundle in ${appBundle}`);
  const result = spawnSync(process.execPath, [verifyScript, '--app', appBundle], { stdio: 'inherit' });
  if (result.status !== 0) {
    hasFailure = true;
  }
}

if (hasFailure) {
  console.error('Packaged helper verification failed.');
  process.exit(1);
}

console.log(`Packaged helper verification passed for ${appBundles.length} app bundle(s).`);
