const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { uniquePaths, getHelperBinaryCandidates } = require('./helper-paths');

let shouldCancel = false;
const activeChildren = new Set();
const PROCESS_OUTPUT_LIMIT_BYTES = 512 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function readStdInJson() {
  return new Promise((resolve, reject) => {
    let body = '';

    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (chunk) => {
      body += chunk;
    });

    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (error) {
        reject(error);
      }
    });

    process.stdin.on('error', reject);
  });
}

function appendLog(logPath, message) {
  if (!logPath) return;

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${nowIso()}] ${message}\n`);
  } catch {
    // Do not fail merge because log file append failed.
  }
}

function createLogger(logPath, jobId) {
  return (message) => {
    const scoped = jobId ? `[${jobId}] ${message}` : message;
    appendLog(logPath, scoped);
  };
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
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
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

function readUInt16ByEndian(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
}

function readUInt32ByEndian(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function readUInt64ByEndian(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
}

function toSafeNumber(value, label) {
  if (typeof value === 'number') return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds supported range.`);
  }
  return Number(value);
}

function readFileChunk(fd, offset, length, label) {
  if (!Number.isFinite(offset) || offset < 0) {
    throw new Error(`Invalid TIFF read offset for ${label}.`);
  }
  if (!Number.isFinite(length) || length < 0) {
    throw new Error(`Invalid TIFF read length for ${label}.`);
  }

  const safeOffset = Math.floor(offset);
  const safeLength = Math.floor(length);
  const buffer = Buffer.alloc(safeLength);
  const bytesRead = fs.readSync(fd, buffer, 0, safeLength, safeOffset);
  if (bytesRead !== safeLength) {
    throw new Error(`Unexpected EOF while reading ${label}.`);
  }
  return buffer;
}

function tiffTypeByteSize(type) {
  switch (type) {
    case 1: // BYTE
    case 2: // ASCII
    case 6: // SBYTE
    case 7: // UNDEFINED
      return 1;
    case 3: // SHORT
    case 8: // SSHORT
      return 2;
    case 4: // LONG
    case 9: // SLONG
    case 11: // FLOAT
    case 13: // IFD
      return 4;
    case 5: // RATIONAL
    case 10: // SRATIONAL
    case 12: // DOUBLE
    case 16: // LONG8
    case 17: // SLONG8
    case 18: // IFD8
      return 8;
    default:
      return 0;
  }
}

function decodeTagIntegerValues(buffer, type, count, littleEndian) {
  const values = [];
  for (let i = 0; i < count; i += 1) {
    const offset = i * tiffTypeByteSize(type);
    let value;
    if (type === 3) {
      value = readUInt16ByEndian(buffer, offset, littleEndian);
    } else if (type === 4) {
      value = readUInt32ByEndian(buffer, offset, littleEndian);
    } else if (type === 16) {
      value = toSafeNumber(readUInt64ByEndian(buffer, offset, littleEndian), 'TIFF LONG8 value');
    } else {
      throw new Error(`BitsPerSample uses unsupported TIFF field type ${type}.`);
    }
    values.push(Number(value));
  }
  return values;
}

function readBitsPerSampleEntry(fd, options) {
  const {
    type,
    count,
    valueOffset,
    inlineValueBytes,
    inlineValueLength,
    littleEndian,
    fileSize,
    isBigTiff,
  } = options;

  const countNumber = Number(count);
  if (!Number.isFinite(countNumber) || countNumber < 1 || countNumber > 16) {
    throw new Error(`Unexpected BitsPerSample count: ${countNumber}.`);
  }

  const typeSize = tiffTypeByteSize(type);
  if (!typeSize) {
    throw new Error(`Unsupported TIFF field type ${type} for BitsPerSample.`);
  }

  const totalBytes = countNumber * typeSize;
  if (totalBytes > 1024) {
    throw new Error(`BitsPerSample payload too large (${totalBytes} bytes).`);
  }

  let valuesBuffer;
  if (totalBytes <= inlineValueLength) {
    valuesBuffer = Buffer.from(inlineValueBytes.subarray(0, totalBytes));
  } else {
    const valueDataOffset = Number(valueOffset);
    if (!Number.isFinite(valueDataOffset) || valueDataOffset < 0) {
      throw new Error('BitsPerSample offset is invalid.');
    }
    if ((valueDataOffset + totalBytes) > fileSize) {
      throw new Error('BitsPerSample offset is outside TIFF bounds.');
    }
    valuesBuffer = readFileChunk(fd, valueDataOffset, totalBytes, 'BitsPerSample payload');
  }

  const values = decodeTagIntegerValues(valuesBuffer, type, countNumber, littleEndian);
  if (!values.length) {
    throw new Error('BitsPerSample tag is empty.');
  }

  return {
    values,
    tiffVariant: isBigTiff ? 'BigTIFF' : 'ClassicTIFF',
  };
}

function inspectTiffBitsPerSample(filePath) {
  const fileStat = fs.statSync(filePath);
  const fileSize = Number(fileStat.size || 0);
  if (fileSize < 8) {
    throw new Error('TIFF file is too small to contain a valid header.');
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const header = readFileChunk(fd, 0, 16, 'TIFF header');
    const byteOrder = header.toString('ascii', 0, 2);
    const littleEndian = byteOrder === 'II' ? true : byteOrder === 'MM' ? false : null;
    if (littleEndian === null) {
      throw new Error(`Invalid TIFF byte order marker: ${JSON.stringify(byteOrder)}.`);
    }

    const magic = readUInt16ByEndian(header, 2, littleEndian);
    const isBigTiff = magic === 43;
    if (magic !== 42 && !isBigTiff) {
      throw new Error(`Unsupported TIFF magic value: ${magic}.`);
    }

    let nextIfdOffset;
    let ifdIndex = 0;

    if (isBigTiff) {
      const offsetByteSize = readUInt16ByEndian(header, 4, littleEndian);
      const zeroField = readUInt16ByEndian(header, 6, littleEndian);
      if (offsetByteSize !== 8 || zeroField !== 0) {
        throw new Error('Invalid BigTIFF header layout.');
      }
      nextIfdOffset = toSafeNumber(readUInt64ByEndian(header, 8, littleEndian), 'BigTIFF IFD offset');
    } else {
      nextIfdOffset = readUInt32ByEndian(header, 4, littleEndian);
    }

    while (nextIfdOffset > 0 && ifdIndex < 8) {
      if (nextIfdOffset >= fileSize) {
        throw new Error(`IFD offset ${nextIfdOffset} is outside TIFF bounds.`);
      }

      if (isBigTiff) {
        const countBuffer = readFileChunk(fd, nextIfdOffset, 8, 'BigTIFF IFD count');
        const entryCount = toSafeNumber(readUInt64ByEndian(countBuffer, 0, littleEndian), 'BigTIFF IFD entry count');
        const tableBytes = (entryCount * 20) + 8;
        if (tableBytes > (32 * 1024 * 1024)) {
          throw new Error(`BigTIFF IFD table is unexpectedly large (${tableBytes} bytes).`);
        }
        const tableBuffer = readFileChunk(fd, nextIfdOffset + 8, tableBytes, 'BigTIFF IFD entries');

        for (let i = 0; i < entryCount; i += 1) {
          const base = i * 20;
          const tag = readUInt16ByEndian(tableBuffer, base, littleEndian);
          if (tag !== 258) continue; // BitsPerSample

          const type = readUInt16ByEndian(tableBuffer, base + 2, littleEndian);
          const count = toSafeNumber(readUInt64ByEndian(tableBuffer, base + 4, littleEndian), 'BitsPerSample count');
          const valueOffset = toSafeNumber(readUInt64ByEndian(tableBuffer, base + 12, littleEndian), 'BitsPerSample value offset');
          return readBitsPerSampleEntry(fd, {
            type,
            count,
            valueOffset,
            inlineValueBytes: tableBuffer.subarray(base + 12, base + 20),
            inlineValueLength: 8,
            littleEndian,
            fileSize,
            isBigTiff: true,
          });
        }

        nextIfdOffset = toSafeNumber(
          readUInt64ByEndian(tableBuffer, entryCount * 20, littleEndian),
          'BigTIFF next IFD offset'
        );
      } else {
        const countBuffer = readFileChunk(fd, nextIfdOffset, 2, 'TIFF IFD count');
        const entryCount = readUInt16ByEndian(countBuffer, 0, littleEndian);
        const tableBytes = (entryCount * 12) + 4;
        if (tableBytes > (32 * 1024 * 1024)) {
          throw new Error(`TIFF IFD table is unexpectedly large (${tableBytes} bytes).`);
        }
        const tableBuffer = readFileChunk(fd, nextIfdOffset + 2, tableBytes, 'TIFF IFD entries');

        for (let i = 0; i < entryCount; i += 1) {
          const base = i * 12;
          const tag = readUInt16ByEndian(tableBuffer, base, littleEndian);
          if (tag !== 258) continue; // BitsPerSample

          const type = readUInt16ByEndian(tableBuffer, base + 2, littleEndian);
          const count = readUInt32ByEndian(tableBuffer, base + 4, littleEndian);
          const valueOffset = readUInt32ByEndian(tableBuffer, base + 8, littleEndian);
          return readBitsPerSampleEntry(fd, {
            type,
            count,
            valueOffset,
            inlineValueBytes: tableBuffer.subarray(base + 8, base + 12),
            inlineValueLength: 4,
            littleEndian,
            fileSize,
            isBigTiff: false,
          });
        }

        nextIfdOffset = readUInt32ByEndian(tableBuffer, entryCount * 12, littleEndian);
      }

      ifdIndex += 1;
    }

    throw new Error('BitsPerSample tag (258) was not found in merged TIFF.');
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

function verifyMergedHdrMasterBitDepth(filePath, logger) {
  const info = inspectTiffBitsPerSample(filePath);
  const bits = info.values.map((value) => Number(value));
  const valid16Bit = bits.length > 0 && bits.every((value) => value === 16);

  if (!valid16Bit) {
    const error = new Error(
      `Merged HDR master was not written as 16-bit TIFF (BitsPerSample=${bits.join(',') || 'unknown'}).`
    );
    error.code = 'HDR_OUTPUT_NOT_16BIT_TIFF';
    throw error;
  }

  logger(`Merged HDR bit-depth check passed: BitsPerSample=${bits.join(',')} (${info.tiffVariant}).`);
}

function runProcess(command, args, logger, options = {}) {
  return new Promise((resolve, reject) => {
    if (shouldCancel) {
      const cancelled = new Error('Merge cancelled.');
      cancelled.code = 'CANCELLED';
      reject(cancelled);
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    activeChildren.add(child);

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
      const text = chunk.toString();
      stdout = appendWithLimit(stdout, text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = appendWithLimit(stderr, text);
    });

    child.on('error', (error) => {
      activeChildren.delete(child);
      settleReject(error);
    });

    child.on('close', (code, signal) => {
      activeChildren.delete(child);
      if (settled) return;

      if (shouldCancel) {
        const cancelled = new Error('Merge cancelled.');
        cancelled.code = 'CANCELLED';
        settleReject(cancelled);
        return;
      }

      if (code === 0) {
        settleResolve({ code, signal, stdout, stderr });
        return;
      }

      const error = new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`);
      error.code = code;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      logger(`error: ${command} exited with code ${code}${signal ? ` (signal ${signal})` : ''} ${summarizeErrorOutput(error)}`);
      settleReject(error);
    });

    logger(`run: ${command} ${args.join(' ')}`);
  });
}

async function runFirstAvailableCommand(candidates, args, logger, toolName) {
  let launchError = null;
  let commandError = null;
  const launchFailures = [];

  for (const command of candidates) {
    try {
      const result = await runProcess(command, args, logger);
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getAlignImageStackCandidates() {
  return uniquePaths([
    ...getHelperBinaryCandidates('align_image_stack', { baseDir: __dirname }),
    '/Applications/Hugin/Hugin.app/Contents/MacOS/align_image_stack',
    '/Applications/Hugin/PTBatcherGUI.app/Contents/MacOS/align_image_stack',
    '/Applications/Hugin/HuginStitchProject.app/Contents/MacOS/align_image_stack',
    '/opt/homebrew/bin/align_image_stack',
    '/usr/local/bin/align_image_stack',
    'align_image_stack',
  ]);
}

function getEnfuseCandidates() {
  return uniquePaths([
    ...getHelperBinaryCandidates('enfuse', { baseDir: __dirname }),
    '/Applications/Hugin/Hugin.app/Contents/MacOS/enfuse',
    '/Applications/Hugin/PTBatcherGUI.app/Contents/MacOS/enfuse',
    '/Applications/Hugin/HuginStitchProject.app/Contents/MacOS/enfuse',
    '/opt/homebrew/bin/enfuse',
    '/usr/local/bin/enfuse',
    'enfuse',
  ]);
}

function getOpenCvHelperCandidates() {
  return uniquePaths([
    ...getHelperBinaryCandidates('ace-opencv-hdr-helper', {
      baseDir: __dirname,
      envVar: 'ACE_OPENCV_HDR_HELPER',
    }),
    '/opt/homebrew/bin/ace-opencv-hdr-helper',
    '/usr/local/bin/ace-opencv-hdr-helper',
    'ace-opencv-hdr-helper',
  ]);
}

function collectAlignedFiles(alignPrefix, expectedCount) {
  const aligned = [];

  for (let i = 0; i < expectedCount; i += 1) {
    const suffix = String(i).padStart(4, '0');
    const tifPath = `${alignPrefix}${suffix}.tif`;
    const tiffPath = `${alignPrefix}${suffix}.tiff`;

    if (fs.existsSync(tifPath)) {
      aligned.push(path.resolve(tifPath));
      continue;
    }
    if (fs.existsSync(tiffPath)) {
      aligned.push(path.resolve(tiffPath));
      continue;
    }

    throw new Error(`Missing aligned TIFF for index ${suffix}. Expected ${tifPath} or ${tiffPath}.`);
  }

  return aligned;
}

function sanitizeLabel(value, fallback = 'input') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned || fallback;
}

function listWorkDirTiffs(workDir) {
  return fs.readdirSync(workDir)
    .filter((name) => /\.(tif|tiff)$/i.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(workDir, name));
}

function stageInputsForSet(inputTiffs, workDir, logger) {
  const stagedInputs = [];

  for (let i = 0; i < inputTiffs.length; i += 1) {
    const sourcePath = path.resolve(inputTiffs[i]);
    const sourceBaseName = sanitizeLabel(path.basename(sourcePath), `source_${i + 1}`);
    const stagedName = `input_${String(i + 1).padStart(4, '0')}_${sourceBaseName}`;
    const stagedPath = path.join(workDir, stagedName);

    fs.copyFileSync(sourcePath, stagedPath);
    ensureNonEmptyFile(stagedPath, 'Staged input TIFF');
    stagedInputs.push(stagedPath);

    logger(`Staged input ${i + 1}/${inputTiffs.length}: ${sourcePath} -> ${stagedPath}`);
  }

  logger(`STAGED_INPUT_TIFFS_JSON ${JSON.stringify(stagedInputs)}`);
  return stagedInputs;
}

function assertNoUnexpectedWorkTiffs(workDir, expectedTiffPaths, logger) {
  const expected = new Set((expectedTiffPaths || []).map((filePath) => path.resolve(filePath)));
  const found = listWorkDirTiffs(workDir).map((filePath) => path.resolve(filePath));
  const unexpected = found.filter((filePath) => !expected.has(filePath));
  const missing = [...expected].filter((filePath) => !found.includes(filePath));

  if (unexpected.length || missing.length) {
    const message = [
      'Set workspace TIFF isolation check failed.',
      unexpected.length ? `Unexpected TIFFs: ${unexpected.join(', ')}` : null,
      missing.length ? `Missing expected TIFFs: ${missing.join(', ')}` : null,
    ].filter(Boolean).join(' ');

    throw new Error(message);
  }

  logger(`Workspace TIFF isolation check passed (${found.length} TIFF files).`);
}

async function alignInputs(inputTiffs, options) {
  const { autoAlign, workDir, logger } = options;

  if (!autoAlign) {
    return {
      alignedInputs: inputTiffs,
      alignmentApplied: false,
      alignmentNote: 'Auto alignment disabled.',
    };
  }

  const alignPrefix = path.join(workDir, 'aligned_');

  try {
    await runFirstAvailableCommand(
      getAlignImageStackCandidates(),
      ['-m', '-a', alignPrefix, ...inputTiffs],
      logger,
      'align_image_stack'
    );

    const aligned = collectAlignedFiles(alignPrefix, inputTiffs.length);

    logger(`ALIGNED_TIFFS_JSON ${JSON.stringify(aligned)}`);

    return {
      alignedInputs: aligned,
      alignmentApplied: true,
      alignmentNote: 'Alignment applied with align_image_stack.',
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger(`ALIGNED_TIFFS_JSON ${JSON.stringify(inputTiffs)}`);
      return {
        alignedInputs: inputTiffs,
        alignmentApplied: false,
        alignmentNote: 'align_image_stack not found. Merge continues without alignment.',
      };
    }

    const wrapped = new Error(`Exposure alignment failed: ${error.message || error}`);
    wrapped.code = 'ALIGNMENT_FAILED';
    wrapped.details = summarizeErrorOutput(error) || null;
    throw wrapped;
  }
}

async function runEnfuseFusion(inputTiffs, outputPath, logger) {
  await runFirstAvailableCommand(
    getEnfuseCandidates(),
    [
      '-o',
      outputPath,
      '--depth=16',
      '--hard-mask',
      ...inputTiffs,
    ],
    logger,
    'enfuse'
  );
}

async function runOpenCvTrueHdr(inputTiffs, outputPath, logger) {
  const candidates = getOpenCvHelperCandidates();

  const argVariants = [
    ['--mode', 'hdr', '--output', outputPath, '--inputs', ...inputTiffs],
    ['hdr', '--output', outputPath, ...inputTiffs],
  ];

  let launchError = null;
  let commandError = null;
  const launchFailures = [];

  for (const command of candidates) {
    for (const args of argVariants) {
      try {
        await runProcess(command, args, logger);
        return {
          modeUsed: 'hdr',
          warning: null,
        };
      } catch (error) {
        if (isLaunchFailure(error)) {
          launchError = error;
          launchFailures.push(`${command}: ${summarizeErrorOutput(error) || 'launch failed'}`);
          break;
        }

        commandError = error;
      }
    }
  }

  if (commandError) {
    throw commandError;
  }

  const notFound = new Error(
    `True HDR helper was not found. Set ACE_OPENCV_HDR_HELPER or install ace-opencv-hdr-helper. ` +
    `Tried: ${candidates.join(', ')}` +
    (launchFailures.length ? ` | Launch issues: ${launchFailures.slice(0, 4).join(' | ')}` : '')
  );
  notFound.code = launchError?.code || 'ENOENT';
  throw notFound;
}

async function merge(payload) {
  const {
    jobId,
    mode,
    inputTiffs,
    outputPath,
    autoAlign,
    workRoot,
    logPath,
  } = payload;

  if (!Array.isArray(inputTiffs) || inputTiffs.length < 2) {
    throw new Error('At least two TIFF inputs are required for HDR merge.');
  }

  for (const inputPath of inputTiffs) {
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input TIFF does not exist: ${inputPath}`);
    }
  }

  ensureDir(path.dirname(outputPath));

  const workLabel = sanitizeLabel(jobId || 'job', 'job');
  const workDir = ensureDir(fs.mkdtempSync(path.join(workRoot, `merge-${workLabel}-`)));
  const logger = createLogger(logPath, jobId);
  logger(`Merge started. mode=${mode}, inputs=${inputTiffs.length}, output=${outputPath}`);
  logger(`SOURCE_INPUT_TIFFS_JSON ${JSON.stringify(inputTiffs.map((filePath) => path.resolve(filePath)))}`);

  try {
    const stagedInputTiffs = stageInputsForSet(inputTiffs, workDir, logger);
    assertNoUnexpectedWorkTiffs(workDir, stagedInputTiffs, logger);

    let modeUsed = mode;
    const warnings = [];
    let alignmentFallbackUsed = false;
    let alignmentFailureMessage = null;

    let alignment;
    try {
      alignment = await alignInputs(stagedInputTiffs, {
        autoAlign,
        workDir,
        logger,
      });
    } catch (error) {
      if (!autoAlign) {
        throw error;
      }

      alignmentFallbackUsed = true;
      alignmentFailureMessage = error?.message || String(error);
      logger(`Auto alignment failed. Retrying merge without alignment. ${alignmentFailureMessage}`);
      if (error?.details) {
        logger(`Alignment error details: ${error.details}`);
      }

      warnings.push('Auto alignment failed. Retrying merge without alignment.');

      const fallbackWarning = /control points/i.test(alignmentFailureMessage)
        ? 'Merged without alignment due to control-point failure.'
        : 'Merged without alignment due to alignment failure.';

      warnings.push(fallbackWarning);

      alignment = {
        alignedInputs: stagedInputTiffs,
        alignmentApplied: false,
        alignmentNote: 'Auto alignment failed. Merged without alignment.',
      };

      logger(`ALIGNED_TIFFS_JSON ${JSON.stringify(stagedInputTiffs)}`);
    }

    const expectedWorkTiffs = [...new Set([
      ...stagedInputTiffs.map((filePath) => path.resolve(filePath)),
      ...(alignment?.alignedInputs || []).map((filePath) => path.resolve(filePath)),
    ])];
    assertNoUnexpectedWorkTiffs(workDir, expectedWorkTiffs, logger);

    for (const alignedPath of alignment.alignedInputs || []) {
      const resolved = path.resolve(alignedPath);
      if (!resolved.startsWith(path.resolve(workDir) + path.sep)) {
        throw new Error(`Alignment output is outside set workspace: ${resolved}`);
      }
    }
    logger(`FUSION_INPUT_TIFFS_JSON ${JSON.stringify(alignment.alignedInputs || [])}`);

    const outputDir = path.dirname(outputPath);
    const outputBaseName = path.basename(outputPath);
    const tempOutputPath = path.join(
      outputDir,
      `.tmp-${process.pid}-${Date.now()}-${outputBaseName}`
    );
    try {
      fs.rmSync(tempOutputPath, { force: true });
    } catch {}

    if (mode === 'hdr') {
      try {
        await runOpenCvTrueHdr(alignment.alignedInputs, tempOutputPath, logger);
      } catch (error) {
        if (alignmentFallbackUsed) {
          const wrapped = new Error(`Merge failed after alignment fallback. ${error.message || error}`);
          wrapped.code = error.code || 'MERGE_FAILED_AFTER_ALIGNMENT_FALLBACK';
          wrapped.stderr = error.stderr;
          wrapped.stdout = error.stdout;
          throw wrapped;
        }

        if (error.code === 'ENOENT') {
          warnings.push('True HDR helper unavailable. Falling back to exposure fusion.');
          modeUsed = 'fusion-fallback';
          await runEnfuseFusion(alignment.alignedInputs, tempOutputPath, logger);
        } else {
          throw new Error(`True HDR merge failed: ${error.message || error}`);
        }
      }
    } else {
      modeUsed = 'fusion';
      try {
        await runEnfuseFusion(alignment.alignedInputs, tempOutputPath, logger);
      } catch (error) {
        if (alignmentFallbackUsed) {
          const wrapped = new Error(`Merge failed after alignment fallback. ${error.message || error}`);
          wrapped.code = error.code || 'MERGE_FAILED_AFTER_ALIGNMENT_FALLBACK';
          wrapped.stderr = error.stderr;
          wrapped.stdout = error.stdout;
          throw wrapped;
        }
        throw error;
      }
    }

    ensureNonEmptyFile(tempOutputPath, 'HDR merge');

    // Final write is atomic: only rename after merge output is complete.
    fs.renameSync(tempOutputPath, outputPath);
    ensureNonEmptyFile(outputPath, 'HDR merge');
    try {
      verifyMergedHdrMasterBitDepth(outputPath, logger);
    } catch (error) {
      try {
        fs.rmSync(outputPath, { force: true });
        logger(`Removed invalid merged output after bit-depth verification failure: ${outputPath}`);
      } catch {}
      throw error;
    }

    logger(`Merge finished. modeUsed=${modeUsed}, output=${outputPath}`);

    return {
      ok: true,
      mergedPath: outputPath,
      modeRequested: mode,
      modeUsed,
      alignmentApplied: alignment.alignmentApplied,
      alignmentNote: alignment.alignmentNote,
      warnings,
    };
  } catch (error) {
    logger(`Merge failed: ${error.message || error}`);
    throw error;
  } finally {
    try {
      const outputDir = path.dirname(outputPath);
      const outputBaseName = path.basename(outputPath);
      const staleTemps = fs.readdirSync(outputDir)
        .filter((name) => name.startsWith('.tmp-') && name.endsWith(`-${outputBaseName}`))
        .map((name) => path.join(outputDir, name));

      for (const staleTempPath of staleTemps) {
        try {
          fs.rmSync(staleTempPath, { force: true });
        } catch {}
      }
    } catch {}

    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

function cleanupAndExitWithResult(result, exitCode = 0) {
  const payload = JSON.stringify(result);

  if (process.stdout.write(payload)) {
    process.exit(exitCode);
    return;
  }

  process.stdout.once('drain', () => {
    process.exit(exitCode);
  });
}

function cancelActiveChildren() {
  for (const child of activeChildren) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
}

process.on('SIGTERM', () => {
  shouldCancel = true;
  cancelActiveChildren();
});

process.on('SIGINT', () => {
  shouldCancel = true;
  cancelActiveChildren();
});

(async () => {
  try {
    const payload = await readStdInJson();
    const result = await merge(payload);
    cleanupAndExitWithResult(result, 0);
  } catch (error) {
    cleanupAndExitWithResult({
      ok: false,
      error: error.message || String(error),
      code: error.code || null,
      details: summarizeErrorOutput(error) || null,
    }, 1);
  }
})();
