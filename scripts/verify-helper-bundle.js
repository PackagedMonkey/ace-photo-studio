#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');

const args = process.argv.slice(2);

function readArgValue(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}

const rootOverride = readArgValue('--root');
const appOverride = readArgValue('--app');
const helperRoot = rootOverride
  ? path.resolve(rootOverride)
  : appOverride
  ? path.join(path.resolve(appOverride), 'Contents', 'Resources', 'helpers')
  : path.join(rootDir, 'helpers', 'macos');

const requiredExecutableFiles = [
  'bin/ace-dng-sdk-helper',
  'bin/align_image_stack',
  'bin/enfuse',
  'bin/dcraw_emu',
  'bin/exiftool',
  'bin/exiftool-real',
];

const requiredFiles = [
  'libraw/libraw.24.dylib',
  'libraw/libomp.dylib',
  'libraw/libjpeg.8.dylib',
  'libraw/liblcms2.2.dylib',
];

const requiredDirs = [
  'Libraries',
  'exiftool-lib/perl5',
];

const smokeChecks = [
  { label: 'enfuse', relPath: 'bin/enfuse', args: ['--version'] },
  { label: 'align_image_stack', relPath: 'bin/align_image_stack', args: ['--help'] },
  { label: 'dcraw_emu', relPath: 'bin/dcraw_emu', args: ['-v'] },
  { label: 'exiftool', relPath: 'bin/exiftool', args: ['-ver'] },
];

function fileExists(relPath) {
  const fullPath = path.join(helperRoot, relPath);
  return fs.existsSync(fullPath) ? fullPath : null;
}

function commandExists(command) {
  const result = spawnSync('which', [command], { stdio: 'ignore' });
  return result.status === 0;
}

function isExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return Boolean(stat.mode & 0o111);
  } catch {
    return false;
  }
}

function walkFiles(dirPath) {
  const found = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      found.push(fullPath);
    }
  }
  return found;
}

function isMachO(filePath) {
  const probe = spawnSync('file', ['-b', filePath], { encoding: 'utf8' });
  return probe.status === 0 && (probe.stdout || '').includes('Mach-O');
}

function listMachOFiles() {
  const scanRoots = ['bin', 'Libraries', 'libraw']
    .map((subdir) => path.join(helperRoot, subdir))
    .filter((dirPath) => fs.existsSync(dirPath));

  const machOFiles = [];
  for (const scanRoot of scanRoots) {
    for (const filePath of walkFiles(scanRoot)) {
      if (isMachO(filePath)) {
        machOFiles.push(filePath);
      }
    }
  }

  return machOFiles;
}

function getDependencies(filePath) {
  const result = spawnSync('otool', ['-L', filePath], { encoding: 'utf8' });
  if (result.status !== 0) {
    return { deps: [], error: result.stderr || result.stdout || `otool failed for ${filePath}` };
  }

  const deps = (result.stdout || '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0]);
  return { deps, error: null };
}

function hasQuarantineAttr(filePath) {
  const result = spawnSync('xattr', ['-p', 'com.apple.quarantine', filePath], { encoding: 'utf8' });
  return result.status === 0;
}

function verifyCodesign(filePath) {
  const result = spawnSync('codesign', ['--verify', '--verbose=2', filePath], { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

function runSmokeCheck(fullPath, argsList) {
  const run = spawnSync(fullPath, argsList, { encoding: 'utf8', timeout: 12000 });
  const output = `${run.stdout || ''}${run.stderr || ''}`;

  if (run.error && run.error.code === 'ETIMEDOUT') {
    return { ok: false, reason: `timed out after 12s` };
  }
  if (run.error) {
    return { ok: false, reason: run.error.message || 'spawn failed' };
  }
  if (run.signal) {
    return { ok: false, reason: `exited via signal ${run.signal}` };
  }
  if (/Library not loaded|image not found|code signature|not valid for use in process|dyld/i.test(output)) {
    return { ok: false, reason: output.trim() || 'dynamic loader error' };
  }

  return { ok: true, reason: '' };
}

const errors = [];

if (!fs.existsSync(helperRoot)) {
  errors.push(`Missing helper root: ${helperRoot}`);
}

for (const relPath of requiredDirs) {
  const fullPath = fileExists(relPath);
  if (!fullPath) {
    errors.push(`Missing required directory: ${relPath}`);
    continue;
  }

  try {
    const entries = fs.readdirSync(fullPath);
    if (!entries.length) {
      errors.push(`Required directory is empty: ${relPath}`);
    }
  } catch (error) {
    errors.push(`Could not read required directory ${relPath}: ${error.message || error}`);
  }
}

for (const relPath of requiredFiles) {
  if (!fileExists(relPath)) {
    errors.push(`Missing required file: ${relPath}`);
  }
}

for (const relPath of requiredExecutableFiles) {
  const fullPath = fileExists(relPath);
  if (!fullPath) {
    errors.push(`Missing required executable: ${relPath}`);
    continue;
  }

  if (!isExecutable(fullPath)) {
    errors.push(`File is not executable: ${relPath}`);
  }
}

if (process.platform === 'darwin') {
  const machOFiles = listMachOFiles();
  if (!machOFiles.length) {
    errors.push('No Mach-O binaries found in helper bundle.');
  }

  const hasXattr = commandExists('xattr');
  const hasCodesign = commandExists('codesign');
  const hasOtool = commandExists('otool');

  for (const machOFile of machOFiles) {
    const relPath = path.relative(helperRoot, machOFile);

    if (hasXattr && hasQuarantineAttr(machOFile)) {
      errors.push(`Quarantine attribute still present: ${relPath}`);
    }

    if (hasCodesign) {
      const verification = verifyCodesign(machOFile);
      if (!verification.ok) {
        errors.push(`Invalid code signature: ${relPath} (${verification.output || 'unknown error'})`);
      }
    }

    if (hasOtool) {
      const { deps, error } = getDependencies(machOFile);
      if (error) {
        errors.push(`Could not inspect dependencies for ${relPath}: ${error}`);
      } else {
        for (const dep of deps) {
          const allowed =
            dep.startsWith('/System/') ||
            dep.startsWith('/usr/lib/') ||
            dep.startsWith('/Library/Apple/') ||
            dep.startsWith('@executable_path/') ||
            dep.startsWith('@loader_path/');

          if (!allowed) {
            errors.push(`Unexpected dependency in ${relPath}: ${dep}`);
          }
        }
      }
    }
  }

  for (const smokeCheck of smokeChecks) {
    const fullPath = path.join(helperRoot, smokeCheck.relPath);
    if (!fs.existsSync(fullPath)) {
      errors.push(`Smoke check target missing: ${smokeCheck.relPath}`);
      continue;
    }

    const result = runSmokeCheck(fullPath, smokeCheck.args);
    if (!result.ok) {
      errors.push(`Smoke check failed for ${smokeCheck.label}: ${result.reason}`);
    }
  }
}

if (errors.length) {
  console.error('Helper bundle verification failed.');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Helper bundle verification passed.');
console.log(`Helper root: ${helperRoot}`);
