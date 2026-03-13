const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { uniquePaths, getHelperBinaryCandidates } = require('./helper-paths');

const STANDARD_IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff',
]);

const RAW_IMAGE_EXTENSIONS = new Set([
  '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.pef', '.srw',
]);

const RAW_FILE_FILTER_EXTENSIONS = [
  'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'pef', 'srw',
];

const ALL_SUPPORTED_EXTENSIONS = new Set([
  ...STANDARD_IMAGE_EXTENSIONS,
  ...RAW_IMAGE_EXTENSIONS,
]);
const PROCESS_OUTPUT_LIMIT_BYTES = 512 * 1024;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function makeHashForPath(filePath) {
  const resolvedPath = path.resolve(filePath);
  let suffix = resolvedPath;

  try {
    const stat = fs.statSync(resolvedPath);
    suffix += `|${stat.size}|${stat.mtimeMs}`;
  } catch {
    suffix += '|missing';
  }

  return crypto.createHash('md5').update(suffix).digest('hex').slice(0, 16);
}

function appendWithLimit(existing, chunk, limit = PROCESS_OUTPUT_LIMIT_BYTES) {
  if (!chunk) return existing;
  const next = existing + chunk;
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}

function summarizeErrorOutput(error) {
  const text = String(error?.stderr || error?.stdout || error?.message || '').trim();
  if (!text) return '';
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

function isLaunchFailure(error) {
  if (!error) return false;
  if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ENOTDIR') return true;

  if (typeof error.code === 'number' && (error.code === 126 || error.code === 127)) {
    return true;
  }

  const output = `${error.stderr || ''}\n${error.stdout || ''}\n${error.message || ''}`;
  return /library not loaded|image not found|bad cpu type|cannot execute|permission denied|not found/i.test(output);
}

function ensureNonEmptyFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} did not produce an output file.`);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`${label} produced an empty output file.`);
  }
}

function makeTempOutputPath(finalPath, label = 'tmp') {
  const stamp = `${Date.now()}-${process.pid}-${Math.round(Math.random() * 10000)}`;
  return `${finalPath}.${label}.${stamp}.tmp`;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      stdout = appendWithLimit(stdout, chunk.toString());
    });

    child.stderr.on('data', (chunk) => {
      stderr = appendWithLimit(stderr, chunk.toString());
    });

    child.on('error', settleReject);

    child.on('close', (code) => {
      if (settled) return;

      if (code === 0) {
        settleResolve({ code, stdout, stderr });
        return;
      }

      const error = new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      settleReject(error);
    });
  });
}

async function runFirstAvailableCommand(candidates, args, toolName) {
  let launchError = null;
  let commandError = null;
  const launchFailures = [];

  for (const command of candidates) {
    try {
      const result = await runProcess(command, args);
      return { ...result, command };
    } catch (error) {
      if (isLaunchFailure(error)) {
        launchError = error;
        launchFailures.push(`${command}: ${summarizeErrorOutput(error) || 'launch failed'}`);
        continue;
      }

      commandError = error;
      break;
    }
  }

  if (commandError) {
    throw commandError;
  }

  if (launchError) {
    const details = launchFailures.slice(0, 4).join(' | ');
    const notFound = new Error(
      `${toolName} was not found or could not be launched. Tried: ${candidates.join(', ')}` +
      (details ? ` | Launch issues: ${details}` : '')
    );
    notFound.code = 'ENOENT';
    throw notFound;
  }

  throw new Error(`${toolName} could not be launched.`);
}

async function probeFirstAvailableCommand(candidates, toolName, probeArgs = ['--version']) {
  const launchFailures = [];

  for (const command of candidates) {
    try {
      const result = await runProcess(command, probeArgs);
      return {
        available: true,
        command,
        output: (result.stdout || result.stderr || '').trim(),
      };
    } catch (error) {
      if (isLaunchFailure(error)) {
        launchFailures.push(`${command}: ${summarizeErrorOutput(error) || 'launch failed'}`);
        continue;
      }

      return {
        available: false,
        command,
        output: (error.stdout || error.stderr || error.message || '').trim(),
        error: `${toolName} probe failed.`,
      };
    }
  }

  return {
    available: false,
    command: null,
    output: '',
    error: launchFailures.length
      ? `${toolName} was not found or could not be launched. ${launchFailures.slice(0, 4).join(' | ')}`
      : `${toolName} was not found.`,
  };
}

class RawService {
  constructor(options = {}) {
    this.cacheRoot = ensureDir(options.cacheRoot || path.join(os.tmpdir(), 'ace-photo-studio-cache'));
    this.rawCacheDir = ensureDir(path.join(this.cacheRoot, 'raw-tiff-cache'));
    this.previewCacheDir = ensureDir(path.join(this.cacheRoot, 'preview-cache'));
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
  }

  getAdobeDngHelperCandidates() {
    return uniquePaths([
      ...getHelperBinaryCandidates('ace-dng-sdk-helper', {
        baseDir: __dirname,
        envVar: 'ACE_DNG_SDK_HELPER',
      }),
      '/opt/homebrew/bin/ace-dng-sdk-helper',
      '/usr/local/bin/ace-dng-sdk-helper',
      'ace-dng-sdk-helper',
    ]);
  }

  getSipsCandidates() {
    return [
      '/usr/bin/sips',
      'sips',
    ];
  }

  isRawFile(filePath) {
    return RAW_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  makeCachedTiffPath(rawPath) {
    const ext = path.extname(rawPath);
    const base = path.basename(rawPath, ext);
    const hash = makeHashForPath(rawPath);
    return path.join(this.rawCacheDir, `${base}-${hash}.tiff`);
  }

  makeCachedPreviewPath(inputPath) {
    const ext = path.extname(inputPath);
    const base = path.basename(inputPath, ext);
    const hash = makeHashForPath(inputPath);
    return path.join(this.previewCacheDir, `${base}-${hash}.jpg`);
  }

  async checkPipeline() {
    const adobeHelper = await probeFirstAvailableCommand(
      this.getAdobeDngHelperCandidates(),
      'Adobe DNG SDK helper',
      ['--version']
    );

    const sips = await probeFirstAvailableCommand(
      this.getSipsCandidates(),
      'sips',
      ['-h']
    );

    const dngPreferredAvailable = adobeHelper.available;
    const decoder = dngPreferredAvailable ? 'adobe-dng-sdk-helper' : null;

    return {
      ok: Boolean(decoder),
      decoder,
      dngPreferredDecoder: dngPreferredAvailable ? 'adobe-dng-sdk-helper' : null,
      dngPreferredAvailable,
      error: decoder
        ? null
        : 'No RAW decoder is available. Install/configure the Adobe-compatible DNG helper and try again.',
      warning: dngPreferredAvailable
        ? null
        : 'Adobe-compatible DNG helper is required for neutral DNG conversion.',
      backends: {
        adobeDngSdkHelper: adobeHelper,
        macOSSips: sips,
      },
    };
  }

  async convertWithAdobeHelper(rawPath, outPath) {
    const candidates = this.getAdobeDngHelperCandidates();
    const tempOutPath = makeTempOutputPath(outPath, 'adobe');

    const argVariants = [
      ['--input', rawPath, '--output', outPath, '--format', 'tiff16'],
      ['decode', '--input', rawPath, '--output', outPath, '--format', 'tiff16'],
      [rawPath, outPath],
    ];

    let launchError = null;
    let commandError = null;

    for (const command of candidates) {
      for (const args of argVariants) {
        try {
          const attemptArgs = args.map((arg) => (arg === outPath ? tempOutPath : arg));
          try {
            fs.rmSync(tempOutPath, { force: true });
          } catch {}

          await runProcess(command, attemptArgs);
          ensureNonEmptyFile(tempOutPath, 'Adobe DNG SDK helper');
          fs.renameSync(tempOutPath, outPath);

          return { backend: 'adobe-dng-sdk-helper', command, args };
        } catch (error) {
          try {
            fs.rmSync(tempOutPath, { force: true });
          } catch {}

          if (isLaunchFailure(error)) {
            launchError = error;
            break;
          }

          commandError = error;
        }
      }
    }

    if (commandError) {
      throw commandError;
    }

    const notFound = new Error(`Adobe DNG SDK helper was not found. Tried: ${candidates.join(', ')}`);
    notFound.code = launchError?.code || 'ENOENT';
    throw notFound;
  }

  async convertWithSips(rawPath, outPath) {
    const tempOutPath = makeTempOutputPath(outPath, 'sips');
    try {
      fs.rmSync(tempOutPath, { force: true });
    } catch {}

    await runFirstAvailableCommand(
      this.getSipsCandidates(),
      ['-s', 'format', 'tiff', rawPath, '--out', tempOutPath],
      'sips'
    );

    ensureNonEmptyFile(tempOutPath, 'sips');

    fs.renameSync(tempOutPath, outPath);
    return { backend: 'macos-sips' };
  }

  // Convert a RAW input to a 16-bit TIFF using a provider chain.
  async convertRawToTiff(filePath, outPath = null, options = {}) {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`RAW file does not exist: ${resolvedPath}`);
    }

    if (!this.isRawFile(resolvedPath)) {
      throw new Error(`Unsupported RAW extension: ${resolvedPath}`);
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const targetPath = outPath ? path.resolve(outPath) : this.makeCachedTiffPath(resolvedPath);
    const hadExistingTarget = fs.existsSync(targetPath);

    ensureDir(path.dirname(targetPath));

    if (!options.force && fs.existsSync(targetPath)) {
      this.logger(`RAW cache hit: ${resolvedPath} -> ${targetPath}`);
      return {
        outputPath: targetPath,
        backend: 'cache',
        cached: true,
      };
    }

    this.logger(`RAW convert start: ${resolvedPath}`);

    let conversionError = null;

    try {
      await this.convertWithAdobeHelper(resolvedPath, targetPath);
      ensureNonEmptyFile(targetPath, 'Adobe DNG SDK helper');
      this.logger(`RAW convert success (Adobe DNG helper): ${targetPath}`);
      return {
        outputPath: targetPath,
        backend: 'adobe-dng-sdk-helper',
        cached: false,
      };
    } catch (error) {
      conversionError = conversionError || error;
      this.logger(`RAW convert error (Adobe DNG helper failed): ${error.message || error}`);
    }

    if (!hadExistingTarget) {
      try {
        fs.rmSync(targetPath, { force: true });
      } catch {}
    }

    if (ext === '.dng') {
      const dngError = new Error(
        'DJI DNG conversion requires an Adobe-compatible DNG helper. ' +
        `Original error: ${conversionError?.message || 'Unknown DNG conversion error.'}`
      );
      dngError.code = conversionError?.code || 'NO_PREFERRED_DNG_DECODER';
      throw dngError;
    }

    throw conversionError || new Error(`RAW conversion failed for ${resolvedPath}`);
  }

  // Convert any image path into a cached JPEG preview for renderer display.
  async ensurePreviewImage(inputPath, outPath = null) {
    const resolvedPath = path.resolve(inputPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Preview source does not exist: ${resolvedPath}`);
    }

    const targetPath = outPath ? path.resolve(outPath) : this.makeCachedPreviewPath(resolvedPath);

    if (fs.existsSync(targetPath)) {
      return {
        previewPath: targetPath,
        cached: true,
      };
    }

    ensureDir(path.dirname(targetPath));
    const tempPreviewPath = makeTempOutputPath(targetPath, 'preview');
    try {
      fs.rmSync(tempPreviewPath, { force: true });
    } catch {}

    try {
      await runFirstAvailableCommand(
        this.getSipsCandidates(),
        ['-s', 'format', 'jpeg', '-s', 'formatOptions', 'best', resolvedPath, '--out', tempPreviewPath],
        'sips'
      );

      ensureNonEmptyFile(tempPreviewPath, 'Preview JPEG');
      fs.renameSync(tempPreviewPath, targetPath);
    } finally {
      try {
        fs.rmSync(tempPreviewPath, { force: true });
      } catch {}
    }

    return {
      previewPath: targetPath,
      cached: false,
    };
  }

  // RAW preview prefers converted TIFF as source, then falls back to RAW input.
  async ensureRawPreviewImage(rawPath, tiffPath = null) {
    const resolvedRawPath = path.resolve(rawPath);
    const previewPath = this.makeCachedPreviewPath(resolvedRawPath);

    if (fs.existsSync(previewPath)) {
      return {
        previewPath,
        cached: true,
      };
    }

    const attempts = [
      tiffPath ? path.resolve(tiffPath) : null,
      resolvedRawPath,
    ].filter(Boolean);

    let lastError = null;

    for (const sourcePath of attempts) {
      try {
        const result = await this.ensurePreviewImage(sourcePath, previewPath);
        return result;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error(`Could not create RAW preview image: ${resolvedRawPath}`);
  }
}

module.exports = {
  RawService,
  STANDARD_IMAGE_EXTENSIONS,
  RAW_IMAGE_EXTENSIONS,
  RAW_FILE_FILTER_EXTENSIONS,
  ALL_SUPPORTED_EXTENSIONS,
};
