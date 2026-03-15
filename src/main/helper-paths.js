const fs = require('fs');
const os = require('os');
const path = require('path');

function normalizeCandidate(candidate) {
  if (candidate === null || candidate === undefined) return null;

  const value = String(candidate).trim();
  if (!value) return null;

  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }

  const hasPathSeparator = value.includes('/') || value.includes('\\');
  const looksLikePath = hasPathSeparator || value.startsWith('.') || path.isAbsolute(value);

  if (looksLikePath) {
    return path.resolve(value);
  }

  // Keep bare command names (e.g. "exiftool") untouched so PATH lookup works.
  return value;
}

function uniquePaths(paths) {
  const seen = new Set();
  const out = [];

  for (const candidate of paths || []) {
    const normalized = normalizeCandidate(candidate);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

function getHelperRootCandidates(options = {}) {
  const baseDir = path.resolve(options.baseDir || __dirname);
  const cwd = path.resolve(options.cwd || process.cwd());
  const resourcesPath = options.resourcesPath || process.resourcesPath || null;
  const projectRoot = path.resolve(baseDir, '..', '..');

  const candidates = [];

  if (process.env.ACE_HELPER_ROOT) {
    candidates.push(process.env.ACE_HELPER_ROOT);
  }

  // Packaged app roots.
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'helpers'));
    candidates.push(path.join(resourcesPath, 'helpers', 'macos'));
    candidates.push(path.join(resourcesPath, 'app.asar.unpacked', 'helpers'));
    candidates.push(path.join(resourcesPath, 'app.asar.unpacked', 'helpers', 'macos'));
  }

  // Development roots.
  candidates.push(path.join(projectRoot, 'build', 'helpers'));
  candidates.push(path.join(projectRoot, 'build', 'helpers', 'macos'));
  candidates.push(path.join(baseDir, 'helpers'));
  candidates.push(path.join(baseDir, 'helpers', 'macos'));
  candidates.push(path.join(baseDir, '..', 'helpers'));
  candidates.push(path.join(baseDir, '..', 'helpers', 'macos'));
  candidates.push(path.join(baseDir, '..', '..', 'build', 'helpers'));
  candidates.push(path.join(baseDir, '..', '..', 'build', 'helpers', 'macos'));
  candidates.push(path.join(cwd, 'helpers'));
  candidates.push(path.join(cwd, 'helpers', 'macos'));
  candidates.push(path.join(cwd, 'build', 'helpers'));
  candidates.push(path.join(cwd, 'build', 'helpers', 'macos'));

  return uniquePaths(candidates)
    .filter((candidate) => {
      const isPathLike = candidate.includes('/') || candidate.includes('\\') || path.isAbsolute(candidate);
      if (!isPathLike) return true;
      return fs.existsSync(candidate);
    });
}

function getHelperBinaryCandidates(binaryName, options = {}) {
  const out = [];
  const envVar = options.envVar;

  if (envVar && process.env[envVar]) {
    out.push(process.env[envVar]);
  }

  const roots = getHelperRootCandidates(options);
  for (const root of roots) {
    out.push(path.join(root, 'bin', binaryName));
    out.push(path.join(root, binaryName));
  }

  return uniquePaths(out)
    .filter((candidate) => {
      const isPathLike = candidate.includes('/') || candidate.includes('\\') || path.isAbsolute(candidate);
      if (!isPathLike) return true;
      return fs.existsSync(candidate);
    });
}

module.exports = {
  uniquePaths,
  getHelperRootCandidates,
  getHelperBinaryCandidates,
};
