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
const DJI_LENS_CORRECTION_LEGACY_ENABLE_ENV = 'ACE_EXPERIMENTAL_DJI_M3_LENS_CORRECTION_PREMERGE';
const DJI_LENS_CORRECTION_DISABLE_ENV = 'ACE_DISABLE_DJI_M3_LENS_CORRECTION_PREMERGE';
const DNG_LENS_MARKERS = ['WarpRectilinear', 'GainMap', 'OpcodeList2', 'OpcodeList3'];
const DJI_M3_MANUAL_PROFILE = Object.freeze({
  id: 'dji-mavic3-l2d-manual-v1',
  distortionK1: -0.045,
  distortionK2: -0.001,
  vignetteR2: 0.038,
  vignetteR4: 0.044,
  maxGain: 1.17,
});
const DJI_M3_FILENAME_PATTERN = /_M3P(?:RO)?(?:\.[^.]+)?$/i;
const DJI_M3_MODEL_PATTERN = /(mavic\s*3|m3p(?:ro)?|l2d-20c|wm26\d)/i;

function envFlagEnabled(value) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value || '').trim().toLowerCase());
}

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

function getFileSizeBytes(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return stat.size;
  } catch {
    return null;
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
    let timeoutHandle = null;
    let timeoutKillHandle = null;

    const clearTimers = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (timeoutKillHandle) {
        clearTimeout(timeoutKillHandle);
        timeoutKillHandle = null;
      }
    };

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(value);
    };

    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      stdout = appendWithLimit(stdout, chunk.toString());
    });

    child.stderr.on('data', (chunk) => {
      stderr = appendWithLimit(stderr, chunk.toString());
    });

    child.on('error', settleReject);

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (settled) return;

        const timeoutError = new Error(
          `${options.timeoutLabel || command} timed out after ${Math.round(options.timeoutMs)}ms.`
        );
        timeoutError.code = 'ETIMEDOUT';
        timeoutError.stdout = stdout;
        timeoutError.stderr = stderr;

        try {
          child.kill('SIGTERM');
        } catch {}

        timeoutKillHandle = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
        }, 1000);

        settleReject(timeoutError);
      }, options.timeoutMs);
    }

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
    this.lensMarkerCache = new Map();
    this.adobeLensSupportProbe = null;
    this.djiCameraInfoCache = new Map();
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

  getExiftoolCandidates() {
    return uniquePaths([
      ...getHelperBinaryCandidates('exiftool', {
        baseDir: __dirname,
        envVar: 'ACE_EXIFTOOL',
      }),
      '/opt/homebrew/bin/exiftool',
      '/usr/local/bin/exiftool',
      'exiftool',
    ]);
  }

  getDjiLensCorrectionHelperScriptPath() {
    return path.join(__dirname, '..', 'shared', 'dji-m3-lens-correction-helper.js');
  }

  isRawFile(filePath) {
    return RAW_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  makeCachedTiffPath(rawPath, options = {}) {
    const ext = path.extname(rawPath);
    const base = path.basename(rawPath, ext);
    const hash = makeHashForPath(rawPath);
    const correctionSuffix = options?.lensCorrectionRequested ? '-lc1' : '';
    return path.join(this.rawCacheDir, `${base}-${hash}${correctionSuffix}.tiff`);
  }

  detectDngLensMarkers(rawPath) {
    const resolvedPath = path.resolve(rawPath);
    if (this.lensMarkerCache.has(resolvedPath)) {
      return this.lensMarkerCache.get(resolvedPath);
    }

    const result = {
      detected: false,
      markers: [],
      error: null,
    };

    try {
      const stat = fs.statSync(resolvedPath);
      const frontBytes = Math.min(stat.size, 4 * 1024 * 1024);
      const backBytes = stat.size > frontBytes
        ? Math.min(stat.size - frontBytes, 2 * 1024 * 1024)
        : 0;
      const fd = fs.openSync(resolvedPath, 'r');

      try {
        let merged = '';
        if (frontBytes > 0) {
          const front = Buffer.alloc(frontBytes);
          fs.readSync(fd, front, 0, frontBytes, 0);
          merged += front.toString('latin1');
        }
        if (backBytes > 0) {
          const back = Buffer.alloc(backBytes);
          fs.readSync(fd, back, 0, backBytes, stat.size - backBytes);
          merged += back.toString('latin1');
        }

        const markers = DNG_LENS_MARKERS.filter((marker) => merged.includes(marker));
        result.detected = markers.length > 0;
        result.markers = markers;
      } finally {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    } catch (error) {
      result.error = error.message || String(error);
    }

    this.lensMarkerCache.set(resolvedPath, result);
    return result;
  }

  async detectDngLensMarkersViaExiftool(rawPath) {
    const resolvedPath = path.resolve(rawPath);
    const result = {
      detected: false,
      markers: [],
      error: null,
    };

    try {
      const metadata = await runFirstAvailableCommand(
        this.getExiftoolCandidates(),
        ['-s', '-s', '-s', '-OpcodeList1', '-OpcodeList2', '-OpcodeList3', resolvedPath],
        'exiftool'
      );
      const text = `${metadata.stdout || ''}\n${metadata.stderr || ''}`;
      const markers = DNG_LENS_MARKERS.filter((marker) => new RegExp(marker, 'i').test(text));
      result.detected = markers.length > 0;
      result.markers = markers;
    } catch (error) {
      result.error = error.message || String(error);
    }

    return result;
  }

  async readDjiCameraInfo(rawPath) {
    const resolvedPath = path.resolve(rawPath);
    if (this.djiCameraInfoCache.has(resolvedPath)) {
      return this.djiCameraInfoCache.get(resolvedPath);
    }

    const cameraInfo = {
      make: '',
      model: '',
      uniqueCameraModel: '',
      lensModel: '',
      metadataSource: 'filename-only',
      command: null,
      error: null,
    };

    try {
      const metadata = await runFirstAvailableCommand(
        this.getExiftoolCandidates(),
        ['-json', '-Make', '-Model', '-UniqueCameraModel', '-LensModel', resolvedPath],
        'exiftool'
      );

      const parsed = JSON.parse(metadata.stdout || '[]');
      const entry = Array.isArray(parsed) && parsed.length ? parsed[0] : {};

      cameraInfo.make = String(entry.Make || '').trim();
      cameraInfo.model = String(entry.Model || '').trim();
      cameraInfo.uniqueCameraModel = String(entry.UniqueCameraModel || '').trim();
      cameraInfo.lensModel = String(entry.LensModel || '').trim();
      cameraInfo.metadataSource = 'exiftool';
      cameraInfo.command = metadata.command || null;
    } catch (error) {
      cameraInfo.error = error.message || String(error);
    }

    this.djiCameraInfoCache.set(resolvedPath, cameraInfo);
    return cameraInfo;
  }

  async resolveDjiM3ManualProfile(rawPath) {
    const resolvedPath = path.resolve(rawPath);
    const fileName = path.basename(resolvedPath);
    const cameraInfo = await this.readDjiCameraInfo(resolvedPath);

    const text = [
      cameraInfo.make,
      cameraInfo.model,
      cameraInfo.uniqueCameraModel,
      cameraInfo.lensModel,
      fileName,
    ].join(' ');

    const makeLooksCompatible = /(dji|hasselblad)/i.test(cameraInfo.make || '')
      || /^dji_/i.test(fileName)
      || /hasselblad/i.test(text);
    const modelLooksCompatible = DJI_M3_MODEL_PATTERN.test(text) || DJI_M3_FILENAME_PATTERN.test(fileName);
    const detected = Boolean(makeLooksCompatible && modelLooksCompatible);

    let reason = null;
    if (!makeLooksCompatible) {
      reason = 'camera-make-not-dji-or-hasselblad';
    } else if (!modelLooksCompatible) {
      reason = 'camera-model-not-mavic-3-profile-compatible';
    }

    return {
      detected,
      reason,
      profile: detected ? { ...DJI_M3_MANUAL_PROFILE } : null,
      cameraInfo,
    };
  }

  async applyDjiM3ManualProfileCorrection(sourceTiffPath, correctedTiffPath, profile) {
    const scriptPath = this.getDjiLensCorrectionHelperScriptPath();
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`DJI manual lens-correction helper is missing: ${scriptPath}`);
    }

    const tempOutPath = makeTempOutputPath(correctedTiffPath, 'dji-m3-lens');
    const startedAtMs = Date.now();
    try {
      try {
        fs.rmSync(tempOutPath, { force: true });
      } catch {}

      const args = [
        scriptPath,
        '--input',
        sourceTiffPath,
        '--output',
        tempOutPath,
        '--profile',
        profile.id,
        '--k1',
        String(profile.distortionK1),
        '--k2',
        String(profile.distortionK2),
        '--vignette-r2',
        String(profile.vignetteR2),
        '--vignette-r4',
        String(profile.vignetteR4),
        '--max-gain',
        String(profile.maxGain),
      ];

      const helperEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      };

      const helperResult = await runProcess(process.execPath, args, {
        env: helperEnv,
        timeoutMs: 120000,
        timeoutLabel: 'DJI Mavic 3 manual lens-correction helper',
      });
      ensureNonEmptyFile(tempOutPath, 'DJI Mavic 3 manual lens correction helper');
      fs.renameSync(tempOutPath, correctedTiffPath);
      const outputSizeBytes = getFileSizeBytes(correctedTiffPath);

      let helperJson = null;
      const stdout = String(helperResult.stdout || '').trim();
      if (stdout) {
        const maybeJsonLine = stdout.split('\n').map((line) => line.trim()).filter(Boolean).pop();
        if (maybeJsonLine && maybeJsonLine.startsWith('{') && maybeJsonLine.endsWith('}')) {
          try {
            helperJson = JSON.parse(maybeJsonLine);
          } catch {}
        }
      }

      const helperStdErr = String(helperResult.stderr || '').trim();

      return {
        helperCommand: process.execPath,
        helperScript: scriptPath,
        helperJson,
        helperStdErr,
        outputSizeBytes,
        elapsedMs: Date.now() - startedAtMs,
      };
    } finally {
      try {
        fs.rmSync(tempOutPath, { force: true });
      } catch {}
    }
  }

  async probeAdobeLensCorrectionSupport() {
    if (this.adobeLensSupportProbe) {
      return this.adobeLensSupportProbe;
    }

    const candidates = this.getAdobeDngHelperCandidates();
    const probe = {
      supported: false,
      helperCommand: null,
      argSets: [],
      reason: 'No Adobe helper command was available for lens-correction probing.',
    };

    for (const command of candidates) {
      try {
        const helpResult = await runProcess(command, ['--help']);
        const text = `${helpResult.stdout || ''}\n${helpResult.stderr || ''}`.toLowerCase();
        const argSets = [];

        if (text.includes('--apply-dng-opcodes')) argSets.push(['--apply-dng-opcodes']);
        if (text.includes('--use-dng-opcodes')) argSets.push(['--use-dng-opcodes']);
        if (text.includes('--apply-lens-correction')) argSets.push(['--apply-lens-correction']);
        if (text.includes('--enable-lens-correction')) argSets.push(['--enable-lens-correction']);
        if (text.includes('--lens-correction=on')) argSets.push(['--lens-correction=on']);
        if (text.includes('--lens-correction')) argSets.push(['--lens-correction', 'on']);

        const uniqueArgSets = [];
        const seen = new Set();
        for (const argSet of argSets) {
          const key = argSet.join('\u0000');
          if (seen.has(key)) continue;
          seen.add(key);
          uniqueArgSets.push(argSet);
        }

        probe.helperCommand = command;
        probe.argSets = uniqueArgSets;
        probe.supported = uniqueArgSets.length > 0;
        probe.reason = probe.supported
          ? 'Adobe helper reports lens/opcode flags.'
          : 'Adobe helper help output did not expose known lens/opcode flags.';
        break;
      } catch (error) {
        if (!isLaunchFailure(error)) {
          probe.helperCommand = command;
          probe.reason = `Adobe helper probe failed: ${error.message || error}`;
          break;
        }
      }
    }

    this.adobeLensSupportProbe = probe;
    return probe;
  }

  makeCachedPreviewPath(inputPath, options = {}) {
    const ext = path.extname(inputPath);
    const base = path.basename(inputPath, ext);
    const hash = makeHashForPath(inputPath);
    const rawVariantSuffix = String(options?.variantSuffix || '').trim();
    const variantSuffix = rawVariantSuffix
      ? `-${rawVariantSuffix.replace(/[^a-z0-9_-]/gi, '')}`
      : '';
    return path.join(this.previewCacheDir, `${base}-${hash}${variantSuffix}.jpg`);
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

  async convertWithAdobeHelper(rawPath, outPath, options = {}) {
    const candidates = this.getAdobeDngHelperCandidates();
    const tempOutPath = makeTempOutputPath(outPath, 'adobe');
    const lensArgSets = Array.isArray(options.lensCorrectionArgSets)
      ? options.lensCorrectionArgSets.filter((value) => Array.isArray(value) && value.length)
      : [];
    const processTimeoutMs = Number.isFinite(options.processTimeoutMs) && options.processTimeoutMs > 0
      ? Math.round(options.processTimeoutMs)
      : null;
    const timeoutLabel = options.timeoutLabel || 'Adobe DNG helper conversion';

    const argVariants = lensArgSets.length
      ? lensArgSets.flatMap((lensArgs) => [
        ['--input', rawPath, '--output', outPath, '--format', 'tiff16', ...lensArgs],
        ['decode', '--input', rawPath, '--output', outPath, '--format', 'tiff16', ...lensArgs],
      ])
      : [
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

          await runProcess(command, attemptArgs, {
            timeoutMs: processTimeoutMs,
            timeoutLabel,
          });
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
    const context = String(options.context || '').trim().toLowerCase();
    const lensCorrectionEligibleDng = ext === '.dng'
      && (context === 'hdr-merge-source' || context === 'single-import');
    const lensCorrectionContextLabel = context || 'default';
    const legacyEnableFlag = envFlagEnabled(process.env[DJI_LENS_CORRECTION_LEGACY_ENABLE_ENV]);
    const disableByEnv = envFlagEnabled(process.env[DJI_LENS_CORRECTION_DISABLE_ENV]);
    const disableByOption = options.enableLensCorrection === false;
    const correctionDisabled = disableByEnv || disableByOption;

    let resolvedDjiProfile = null;
    let lensCorrectionRequested = false;
    let initialLensMode = 'not-requested';
    let initialSkipReason = 'not-requested';

    if (lensCorrectionEligibleDng) {
      if (correctionDisabled) {
        initialLensMode = 'disabled';
        initialSkipReason = disableByEnv
          ? `disabled-by-env:${DJI_LENS_CORRECTION_DISABLE_ENV}`
          : 'disabled-by-options';
      } else {
        resolvedDjiProfile = await this.resolveDjiM3ManualProfile(resolvedPath);
        if (resolvedDjiProfile.detected) {
          lensCorrectionRequested = true;
          initialLensMode = 'pending';
          initialSkipReason = null;
        } else {
          initialLensMode = 'not-requested';
          initialSkipReason = resolvedDjiProfile.reason || 'not-dji-mavic-3';
        }
      }
    }

    const targetPath = outPath
      ? path.resolve(outPath)
      : this.makeCachedTiffPath(resolvedPath, { lensCorrectionRequested });
    const hadExistingTarget = fs.existsSync(targetPath);
    const allowCache = !lensCorrectionRequested;
    const lensCorrection = {
      requested: lensCorrectionRequested,
      metadataDetected: false,
      metadataMarkers: [],
      applied: false,
      skipped: false,
      skipReason: lensCorrectionRequested ? null : initialSkipReason,
      helperSupportsCorrection: null,
      mode: lensCorrectionRequested ? 'pending' : initialLensMode,
      djiMavic3Detected: resolvedDjiProfile ? Boolean(resolvedDjiProfile.detected) : null,
      djiProfileId: resolvedDjiProfile?.profile?.id || null,
      embeddedAttempted: false,
      manualFallbackAttempted: false,
      manualFallbackApplied: false,
      manualFallbackReason: resolvedDjiProfile?.reason || null,
    };
    let finalLensJsonEmitted = false;

    const emitLensCorrectionJson = (extra = {}) => {
      if (!lensCorrectionRequested) return;
      this.logger(
        `RAW_LENS_CORRECTION_JSON ${JSON.stringify({
          sourcePath: resolvedPath,
          requested: lensCorrection.requested,
          metadataDetected: lensCorrection.metadataDetected,
          metadataMarkers: lensCorrection.metadataMarkers || [],
          helperSupportsCorrection: lensCorrection.helperSupportsCorrection,
          mode: lensCorrection.mode || null,
          djiMavic3Detected: lensCorrection.djiMavic3Detected,
          djiProfileId: lensCorrection.djiProfileId || null,
          embeddedAttempted: lensCorrection.embeddedAttempted,
          manualFallbackAttempted: lensCorrection.manualFallbackAttempted,
          manualFallbackApplied: lensCorrection.manualFallbackApplied,
          manualFallbackReason: lensCorrection.manualFallbackReason || null,
          applied: lensCorrection.applied,
          skipped: lensCorrection.skipped,
          skipReason: lensCorrection.skipReason || null,
          stage: extra.stage || null,
          result: extra.result || null,
          error: extra.error || null,
          final: Boolean(extra.final),
        })}`
      );
    };

    const emitFinalLensCorrectionJson = (extra = {}) => {
      if (!lensCorrectionRequested || finalLensJsonEmitted) return;
      finalLensJsonEmitted = true;
      emitLensCorrectionJson({
        ...extra,
        final: true,
      });
    };

    ensureDir(path.dirname(targetPath));

    if (!options.force && allowCache && fs.existsSync(targetPath)) {
      this.logger(`RAW cache hit: ${resolvedPath} -> ${targetPath}`);
      return {
        outputPath: targetPath,
        backend: 'cache',
        cached: true,
        lensCorrection,
      };
    }

    this.logger(`RAW convert start: ${resolvedPath}`);
    if (lensCorrectionEligibleDng && correctionDisabled) {
      this.logger(
        `RAW lens correction disabled (${initialSkipReason}) for ${lensCorrectionContextLabel} DNG: ${resolvedPath}` +
        (disableByEnv && legacyEnableFlag
          ? `; ${DJI_LENS_CORRECTION_DISABLE_ENV} takes precedence over ${DJI_LENS_CORRECTION_LEGACY_ENABLE_ENV}`
          : '')
      );
    } else if (lensCorrectionRequested) {
      if (legacyEnableFlag) {
        this.logger(
          `RAW lens correction legacy flag detected (${DJI_LENS_CORRECTION_LEGACY_ENABLE_ENV}=ON); using default-on DJI Mavic 3 merge-source behavior.`
        );
      }
      this.logger(
        `RAW lens correction requested (default-on DJI Mavic 3 path, context=${lensCorrectionContextLabel}) for DNG: ${resolvedPath}`
      );
    } else if (lensCorrectionEligibleDng) {
      this.logger(
        `RAW lens correction not requested (${initialSkipReason || 'not-dji-mavic-3'}) for ${lensCorrectionContextLabel} DNG: ${resolvedPath}`
      );
    }

    let conversionError = null;
    let lensAttemptError = null;

    if (lensCorrectionRequested) {
      let markerInfo = this.detectDngLensMarkers(resolvedPath);
      if (!markerInfo.detected) {
        const exiftoolMarkerInfo = await this.detectDngLensMarkersViaExiftool(resolvedPath);
        if (exiftoolMarkerInfo.detected) {
          markerInfo = exiftoolMarkerInfo;
        } else if (exiftoolMarkerInfo.error && !markerInfo.error) {
          markerInfo = {
            ...markerInfo,
            error: exiftoolMarkerInfo.error,
          };
        }
      }
      lensCorrection.metadataDetected = Boolean(markerInfo.detected);
      lensCorrection.metadataMarkers = markerInfo.markers || [];
      if (markerInfo.error) {
        this.logger(`RAW lens correction metadata scan warning: ${markerInfo.error}`);
      }

      if (lensCorrection.metadataDetected) {
        const support = await this.probeAdobeLensCorrectionSupport();
        lensCorrection.helperSupportsCorrection = Boolean(support.supported);
        lensCorrection.embeddedAttempted = Boolean(support.supported && support.argSets.length);

        if (!support.supported || !support.argSets.length) {
          lensCorrection.skipReason = `helper-lens-opcode-flags-unsupported: ${support.reason}`;
          this.logger(`RAW embedded-opcode correction unavailable: ${lensCorrection.skipReason}`);
        } else {
          try {
            await this.convertWithAdobeHelper(resolvedPath, targetPath, {
              lensCorrectionArgSets: support.argSets,
            });
            ensureNonEmptyFile(targetPath, 'Adobe DNG SDK helper');
            lensCorrection.applied = true;
            lensCorrection.skipped = false;
            lensCorrection.skipReason = null;
            lensCorrection.mode = 'embedded-opcode';
            this.logger(
              `RAW convert success (Adobe helper + lens correction): ${targetPath} markers=${lensCorrection.metadataMarkers.join(',')}`
            );
            emitFinalLensCorrectionJson({
              stage: 'embedded-opcode',
              result: 'applied',
            });
            return {
              outputPath: targetPath,
              backend: 'adobe-dng-sdk-helper',
              cached: false,
              lensCorrection,
            };
          } catch (error) {
            lensAttemptError = error;
            lensCorrection.applied = false;
            lensCorrection.skipReason = `lens-correction-attempt-failed-fallback-to-neutral: ${error.message || error}`;
            this.logger(
              `RAW embedded-opcode correction attempt failed; falling back to manual-profile/neutral path. ${error.message || error}`
            );
            try {
              fs.rmSync(targetPath, { force: true });
            } catch {}
          }
        }
      } else {
        this.logger(
          'RAW embedded-opcode correction skipped: no embedded WarpRectilinear/GainMap/Opcode metadata markers detected.'
        );
      }

      this.logger(`RAW manual-profile detection start: ${resolvedPath}`);
      const profileResolution = resolvedDjiProfile || await this.resolveDjiM3ManualProfile(resolvedPath);
      lensCorrection.djiMavic3Detected = Boolean(profileResolution.detected);
      lensCorrection.djiProfileId = profileResolution.profile?.id || null;
      lensCorrection.manualFallbackAttempted = Boolean(profileResolution.detected);
      lensCorrection.manualFallbackReason = profileResolution.reason || null;
      this.logger(
        `RAW manual-profile detection result: detected=${lensCorrection.djiMavic3Detected ? 'yes' : 'no'} ` +
        `profile=${lensCorrection.djiProfileId || 'none'} ` +
        `reason=${profileResolution.reason || 'n/a'} ` +
        `make='${profileResolution.cameraInfo?.make || ''}' model='${profileResolution.cameraInfo?.model || ''}' ` +
        `unique='${profileResolution.cameraInfo?.uniqueCameraModel || ''}'`
      );
      emitLensCorrectionJson({
        stage: 'manual-profile-detection',
        result: lensCorrection.djiMavic3Detected ? 'detected' : 'not-detected',
      });

      if (profileResolution.detected && profileResolution.profile) {
        const neutralDecodePath = makeTempOutputPath(targetPath, 'neutral-source');
        try {
          try {
            fs.rmSync(neutralDecodePath, { force: true });
          } catch {}
          this.logger(`RAW manual-profile neutral decode start: ${resolvedPath} -> ${neutralDecodePath}`);
          await this.convertWithAdobeHelper(resolvedPath, neutralDecodePath, {
            processTimeoutMs: 90000,
            timeoutLabel: 'Adobe DNG helper neutral decode for manual lens-correction fallback',
          });
          ensureNonEmptyFile(neutralDecodePath, 'Adobe DNG SDK helper');
          const neutralSizeBytes = getFileSizeBytes(neutralDecodePath);
          this.logger(
            `RAW manual-profile neutral decode success: output=${neutralDecodePath} size=${neutralSizeBytes || 0} bytes`
          );

          this.logger(
            `RAW manual-profile helper invoke start: input=${neutralDecodePath} output=${targetPath} profile=${profileResolution.profile.id} ` +
            `runtime=${process.execPath} ELECTRON_RUN_AS_NODE=1`
          );
          const manualResult = await this.applyDjiM3ManualProfileCorrection(
            neutralDecodePath,
            targetPath,
            profileResolution.profile
          );
          ensureNonEmptyFile(targetPath, 'DJI Mavic 3 manual lens correction helper');
          const correctedSizeBytes = getFileSizeBytes(targetPath);
          lensCorrection.applied = true;
          lensCorrection.skipped = false;
          lensCorrection.skipReason = null;
          lensCorrection.mode = 'manual-profile';
          lensCorrection.manualFallbackApplied = true;
          this.logger(
            `RAW convert success (manual DJI Mavic 3 profile correction): ${targetPath} profile=${profileResolution.profile.id} ` +
            `size=${correctedSizeBytes || 0} bytes elapsedMs=${manualResult?.elapsedMs || 'n/a'}`
          );
          if (manualResult?.helperJson) {
            this.logger(`RAW manual-profile helper result: ${JSON.stringify(manualResult.helperJson)}`);
          }
          if (manualResult?.helperStdErr) {
            this.logger(`RAW manual-profile helper diagnostics: ${manualResult.helperStdErr}`);
          }
          emitLensCorrectionJson({
            stage: 'manual-profile-helper',
            result: 'applied',
          });
          emitFinalLensCorrectionJson({
            stage: 'manual-profile',
            result: 'applied',
          });
          return {
            outputPath: targetPath,
            backend: 'adobe-dng-sdk-helper+dji-m3-manual-profile',
            cached: false,
            lensCorrection,
          };
        } catch (error) {
          lensAttemptError = lensAttemptError || error;
          lensCorrection.manualFallbackApplied = false;
          lensCorrection.skipReason = `manual-profile-fallback-failed: ${error.message || error}`;
          lensCorrection.manualFallbackReason = error.message || String(error);
          this.logger(`RAW manual-profile correction failed; falling back to neutral decode. ${error.message || error}`);
          emitLensCorrectionJson({
            stage: 'manual-profile-helper',
            result: 'failed',
            error: error.message || String(error),
          });
          try {
            fs.rmSync(targetPath, { force: true });
          } catch {}
        } finally {
          try {
            fs.rmSync(neutralDecodePath, { force: true });
          } catch {}
        }
      } else {
        this.logger(
          `RAW manual-profile correction skipped: ${profileResolution.reason || 'camera did not match DJI Mavic 3 profile.'}`
        );
        emitLensCorrectionJson({
          stage: 'manual-profile-helper',
          result: 'skipped',
          error: profileResolution.reason || null,
        });
      }

      if (!lensCorrection.applied) {
        lensCorrection.skipped = true;
        lensCorrection.mode = 'neutral-fallback';
        if (!lensCorrection.skipReason) {
          lensCorrection.skipReason = 'no-supported-lens-correction-path-applied';
        }
      }
    }

    if (lensCorrectionRequested && !lensCorrection.applied) {
      this.logger(`RAW lens correction path result: neutral fallback (${lensCorrection.skipReason || 'unknown-reason'})`);
      this.logger(`RAW neutral fallback decode start: ${resolvedPath} -> ${targetPath}`);
    }

    try {
      await this.convertWithAdobeHelper(resolvedPath, targetPath);
      ensureNonEmptyFile(targetPath, 'Adobe DNG SDK helper');
      const finalSizeBytes = getFileSizeBytes(targetPath);
      this.logger(`RAW convert success (Adobe DNG helper): ${targetPath} size=${finalSizeBytes || 0} bytes`);
      emitFinalLensCorrectionJson({
        stage: lensCorrectionRequested ? 'neutral-fallback' : 'neutral',
        result: lensCorrectionRequested ? 'fallback-applied' : 'not-requested',
      });
      return {
        outputPath: targetPath,
        backend: 'adobe-dng-sdk-helper',
        cached: false,
        lensCorrection,
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
        `Original error: ${conversionError?.message || lensAttemptError?.message || 'Unknown DNG conversion error.'}`
      );
      dngError.code = conversionError?.code || lensAttemptError?.code || 'NO_PREFERRED_DNG_DECODER';
      dngError.lensCorrection = lensCorrectionRequested ? { ...lensCorrection } : null;
      emitFinalLensCorrectionJson({
        stage: 'neutral-fallback-failed',
        result: 'failed',
        error: dngError.message,
      });
      throw dngError;
    }

    const finalError = conversionError || new Error(`RAW conversion failed for ${resolvedPath}`);
    finalError.lensCorrection = lensCorrectionRequested ? { ...lensCorrection } : null;
    emitFinalLensCorrectionJson({
      stage: 'conversion-failed',
      result: 'failed',
      error: finalError.message || String(finalError),
    });
    throw finalError;
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
  async ensureRawPreviewImage(rawPath, tiffPath = null, options = {}) {
    const resolvedRawPath = path.resolve(rawPath);
    const previewVariant = options?.lensCorrectionRequested ? 'lc1' : '';
    const previewPath = this.makeCachedPreviewPath(resolvedRawPath, { variantSuffix: previewVariant });

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
