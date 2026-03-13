#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const PROFILE_PRESETS = Object.freeze({
  'dji-mavic3-l2d-manual-v1': Object.freeze({
    id: 'dji-mavic3-l2d-manual-v1',
    distortionK1: -0.045,
    distortionK2: -0.001,
    vignetteR2: 0.038,
    vignetteR4: 0.044,
    maxGain: 1.17,
  }),
});

const TIFF_TYPES = Object.freeze({
  BYTE: 1,
  ASCII: 2,
  SHORT: 3,
  LONG: 4,
  RATIONAL: 5,
});

const TIFF_TYPE_SIZES = Object.freeze({
  [TIFF_TYPES.BYTE]: 1,
  [TIFF_TYPES.ASCII]: 1,
  [TIFF_TYPES.SHORT]: 2,
  [TIFF_TYPES.LONG]: 4,
  [TIFF_TYPES.RATIONAL]: 8,
});

const TIFF_TAGS = Object.freeze({
  IMAGE_WIDTH: 256,
  IMAGE_HEIGHT: 257,
  BITS_PER_SAMPLE: 258,
  COMPRESSION: 259,
  PHOTOMETRIC_INTERPRETATION: 262,
  STRIP_OFFSETS: 273,
  SAMPLES_PER_PIXEL: 277,
  ROWS_PER_STRIP: 278,
  STRIP_BYTE_COUNTS: 279,
  PLANAR_CONFIGURATION: 284,
});

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function emitDiag(enabled, message) {
  if (!enabled) return;
  process.stderr.write(`[dji-m3-lens-helper] ${message}\n`);
}

function fail(message, code = 2) {
  process.stderr.write(`ace-dji-m3-lens-correction-helper error: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    profile: 'dji-mavic3-l2d-manual-v1',
    distortionK1: null,
    distortionK2: null,
    vignetteR2: null,
    vignetteR4: null,
    maxGain: null,
    diagnostics: true,
  };

  const tokens = [...argv];
  while (tokens.length) {
    const token = tokens.shift();
    switch (token) {
      case '--input':
        args.input = tokens.shift() || null;
        break;
      case '--output':
        args.output = tokens.shift() || null;
        break;
      case '--profile':
        args.profile = tokens.shift() || args.profile;
        break;
      case '--k1':
        args.distortionK1 = Number(tokens.shift());
        break;
      case '--k2':
        args.distortionK2 = Number(tokens.shift());
        break;
      case '--vignette-r2':
        args.vignetteR2 = Number(tokens.shift());
        break;
      case '--vignette-r4':
        args.vignetteR4 = Number(tokens.shift());
        break;
      case '--max-gain':
        args.maxGain = Number(tokens.shift());
        break;
      case '--diag':
        args.diagnostics = true;
        break;
      case '--no-diag':
        args.diagnostics = false;
        break;
      case '--help':
      case '-h':
        return null;
      default:
        fail(`Unknown argument: ${token}`);
    }
  }

  if (!args.input || !args.output) {
    fail('Both --input and --output are required.');
  }

  return args;
}

function readUInt(buffer, offset, byteSize, littleEndian) {
  if (offset < 0 || offset + byteSize > buffer.length) {
    throw new Error(`TIFF read out of bounds (offset=${offset}, bytes=${byteSize}).`);
  }
  switch (byteSize) {
    case 1:
      return buffer.readUInt8(offset);
    case 2:
      return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    case 4:
      return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    default:
      throw new Error(`Unsupported TIFF integer width: ${byteSize}.`);
  }
}

function readTagValues(buffer, entryOffset, type, count, littleEndian) {
  const typeSize = TIFF_TYPE_SIZES[type];
  if (!typeSize || typeSize > 4) {
    return [];
  }

  const dataLength = typeSize * count;
  const valueOrOffset = readUInt(buffer, entryOffset + 8, 4, littleEndian);
  const dataOffset = dataLength <= 4 ? entryOffset + 8 : valueOrOffset;
  const values = [];

  for (let i = 0; i < count; i += 1) {
    const valueOffset = dataOffset + (i * typeSize);
    values.push(readUInt(buffer, valueOffset, typeSize, littleEndian));
  }
  return values;
}

function getTagValue(tags, tagId, fallback = null) {
  const values = tags.get(tagId);
  if (!values || !values.length) return fallback;
  return values[0];
}

function getTagValues(tags, tagId, fallback = []) {
  const values = tags.get(tagId);
  if (!values || !values.length) return fallback;
  return values;
}

function parseTiffMetadata(buffer) {
  const byteOrder = buffer.toString('ascii', 0, 2);
  if (byteOrder !== 'II' && byteOrder !== 'MM') {
    throw new Error('Input is not a valid TIFF file (missing II/MM byte order marker).');
  }
  if (byteOrder !== 'II') {
    throw new Error('Only little-endian TIFF files are supported by this helper.');
  }

  const littleEndian = byteOrder === 'II';
  const magic = readUInt(buffer, 2, 2, littleEndian);
  if (magic !== 42) {
    throw new Error(`Unsupported TIFF magic number: ${magic}.`);
  }

  const ifdOffset = readUInt(buffer, 4, 4, littleEndian);
  const entryCount = readUInt(buffer, ifdOffset, 2, littleEndian);
  const tags = new Map();

  for (let i = 0; i < entryCount; i += 1) {
    const entryOffset = ifdOffset + 2 + (i * 12);
    const tagId = readUInt(buffer, entryOffset, 2, littleEndian);
    const type = readUInt(buffer, entryOffset + 2, 2, littleEndian);
    const count = readUInt(buffer, entryOffset + 4, 4, littleEndian);
    const values = readTagValues(buffer, entryOffset, type, count, littleEndian);
    if (values.length) {
      tags.set(tagId, values);
    }
  }

  const width = getTagValue(tags, TIFF_TAGS.IMAGE_WIDTH, 0);
  const height = getTagValue(tags, TIFF_TAGS.IMAGE_HEIGHT, 0);
  const samplesPerPixel = getTagValue(tags, TIFF_TAGS.SAMPLES_PER_PIXEL, 0)
    || getTagValues(tags, TIFF_TAGS.BITS_PER_SAMPLE, []).length
    || 0;
  const bitsPerSample = getTagValues(tags, TIFF_TAGS.BITS_PER_SAMPLE, []);
  const compression = getTagValue(tags, TIFF_TAGS.COMPRESSION, 1);
  const planarConfiguration = getTagValue(tags, TIFF_TAGS.PLANAR_CONFIGURATION, 1);
  const stripOffsets = getTagValues(tags, TIFF_TAGS.STRIP_OFFSETS, []);
  const stripByteCounts = getTagValues(tags, TIFF_TAGS.STRIP_BYTE_COUNTS, []);
  const rowsPerStrip = getTagValue(tags, TIFF_TAGS.ROWS_PER_STRIP, height);

  if (width <= 0 || height <= 0) {
    throw new Error('TIFF metadata is missing width/height.');
  }
  if (samplesPerPixel < 3) {
    throw new Error(`Unsupported SamplesPerPixel=${samplesPerPixel}; expected at least RGB.`);
  }
  if (compression !== 1) {
    throw new Error(`Unsupported TIFF compression=${compression}; expected uncompressed strip TIFF.`);
  }
  if (planarConfiguration !== 1) {
    throw new Error(`Unsupported PlanarConfiguration=${planarConfiguration}; expected chunky RGB.`);
  }
  if (!stripOffsets.length || !stripByteCounts.length || stripOffsets.length !== stripByteCounts.length) {
    throw new Error('TIFF strip metadata is invalid.');
  }

  const bits = bitsPerSample.length ? bitsPerSample : [16];
  if (!bits.every((value) => value === 16)) {
    throw new Error(`Unsupported BitsPerSample=${bits.join(',')}; expected 16-bit channels.`);
  }

  const bytesPerSample = 2;
  const expectedPixelBytes = width * height * samplesPerPixel * bytesPerSample;
  if (expectedPixelBytes <= 0 || !Number.isFinite(expectedPixelBytes)) {
    throw new Error('Computed TIFF pixel byte size is invalid.');
  }

  return {
    littleEndian,
    width,
    height,
    rowsPerStrip,
    samplesPerPixel,
    bitsPerSample: bits,
    stripOffsets,
    stripByteCounts,
    expectedPixelBytes,
  };
}

function extractPackedPixelData(buffer, metadata) {
  let contiguousStart = metadata.stripOffsets[0];
  let contiguousLength = 0;
  let contiguous = true;

  for (let i = 0; i < metadata.stripOffsets.length; i += 1) {
    if (metadata.stripOffsets[i] !== contiguousStart + contiguousLength) {
      contiguous = false;
      break;
    }
    contiguousLength += metadata.stripByteCounts[i];
  }

  if (contiguous && contiguousLength >= metadata.expectedPixelBytes) {
    const contiguousEnd = contiguousStart + metadata.expectedPixelBytes;
    if (contiguousStart >= 0 && contiguousEnd <= buffer.length) {
      return {
        packed: buffer.subarray(contiguousStart, contiguousEnd),
        copied: false,
      };
    }
  }

  const packed = Buffer.allocUnsafe(metadata.expectedPixelBytes);
  let writeOffset = 0;

  for (let i = 0; i < metadata.stripOffsets.length && writeOffset < packed.length; i += 1) {
    const stripOffset = metadata.stripOffsets[i];
    const stripByteCount = metadata.stripByteCounts[i];
    const stripEnd = stripOffset + stripByteCount;
    if (stripOffset < 0 || stripEnd > buffer.length) {
      throw new Error(`TIFF strip ${i} points outside file bounds.`);
    }

    const bytesRemaining = packed.length - writeOffset;
    const copyLength = Math.min(bytesRemaining, stripByteCount);
    buffer.copy(packed, writeOffset, stripOffset, stripOffset + copyLength);
    writeOffset += copyLength;
  }

  if (writeOffset < packed.length) {
    throw new Error(
      `TIFF pixel payload is truncated (expected=${packed.length} bytes, copied=${writeOffset} bytes).`
    );
  }

  return {
    packed,
    copied: true,
  };
}

function makeUint16ArrayFromBuffer(buffer, forceCopy = false) {
  if (!forceCopy && (buffer.byteOffset % 2) === 0) {
    return new Uint16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
  }

  const aligned = Buffer.allocUnsafe(buffer.length);
  buffer.copy(aligned, 0, 0, buffer.length);
  return new Uint16Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 2));
}

function precomputeNormalizedOffsets(size, center, invRadius) {
  const normalized = new Float64Array(size);
  const squared = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    const value = (i - center) * invRadius;
    normalized[i] = value;
    squared[i] = value * value;
  }
  return { normalized, squared };
}

function applyDistortionRemap(sourcePixels, destinationPixels, metadata, profile, precomputed) {
  const { width, height, samplesPerPixel } = metadata;
  const centerX = precomputed.centerX;
  const centerY = precomputed.centerY;
  const normX = precomputed.normX;
  const normY = precomputed.normY;
  const squaredX = precomputed.squaredX;
  const squaredY = precomputed.squaredY;

  const k1 = Number(profile.distortionK1) || 0;
  const k2 = Number(profile.distortionK2) || 0;

  for (let y = 0; y < height; y += 1) {
    const ny = normY[y];
    const ny2 = squaredY[y];
    const rowStart = y * width * samplesPerPixel;
    for (let x = 0; x < width; x += 1) {
      const nx = normX[x];
      const r2 = squaredX[x] + ny2;
      const radial = 1 + (k1 * r2) + (k2 * r2 * r2);

      let sampleX = centerX + (nx * radial * centerX);
      let sampleY = centerY + (ny * radial * centerY);
      if (sampleX < 0) sampleX = 0;
      if (sampleY < 0) sampleY = 0;
      if (sampleX > width - 1) sampleX = width - 1;
      if (sampleY > height - 1) sampleY = height - 1;

      const sourceIndex = (((sampleY + 0.5) | 0) * width + ((sampleX + 0.5) | 0)) * samplesPerPixel;
      const destinationIndex = rowStart + (x * samplesPerPixel);
      for (let channel = 0; channel < samplesPerPixel; channel += 1) {
        destinationPixels[destinationIndex + channel] = sourcePixels[sourceIndex + channel];
      }
    }
  }
}

function applyVignetteGain(destinationPixels, metadata, profile, precomputed) {
  const { width, height, samplesPerPixel } = metadata;
  const squaredX = precomputed.squaredX;
  const squaredY = precomputed.squaredY;

  const channelsToCorrect = Math.min(3, samplesPerPixel);
  const vR2 = Number(profile.vignetteR2) || 0;
  const vR4 = Number(profile.vignetteR4) || 0;
  const maxGain = Math.max(1, Number(profile.maxGain) || 1);

  for (let y = 0; y < height; y += 1) {
    const ny2 = squaredY[y];
    const rowStart = y * width * samplesPerPixel;
    for (let x = 0; x < width; x += 1) {
      const r2 = squaredX[x] + ny2;
      let gain = 1 + (vR2 * r2) + (vR4 * r2 * r2);
      if (gain > maxGain) gain = maxGain;

      const pixelIndex = rowStart + (x * samplesPerPixel);
      for (let channel = 0; channel < channelsToCorrect; channel += 1) {
        const corrected = destinationPixels[pixelIndex + channel] * gain;
        destinationPixels[pixelIndex + channel] = corrected >= 65535 ? 65535 : (corrected + 0.5) | 0;
      }
    }
  }
}

function writeCorrectedTiff(inputBuffer, correctedPixels, metadata, outputPath) {
  const outputBuffer = Buffer.from(inputBuffer);
  const correctedBytes = Buffer.from(
    correctedPixels.buffer,
    correctedPixels.byteOffset,
    correctedPixels.byteLength
  );
  let readOffset = 0;

  for (let i = 0; i < metadata.stripOffsets.length && readOffset < correctedBytes.length; i += 1) {
    const stripOffset = metadata.stripOffsets[i];
    const stripByteCount = metadata.stripByteCounts[i];
    const copyLength = Math.min(stripByteCount, correctedBytes.length - readOffset);
    correctedBytes.copy(outputBuffer, stripOffset, readOffset, readOffset + copyLength);
    readOffset += copyLength;
  }

  if (readOffset < correctedBytes.length) {
    throw new Error(
      `Could not write corrected pixels into TIFF strips (written=${readOffset}, expected=${correctedBytes.length}).`
    );
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outputBuffer);
}

function mergeProfileArgs(args) {
  const preset = PROFILE_PRESETS[args.profile];
  if (!preset) {
    throw new Error(`Unsupported profile '${args.profile}'.`);
  }

  return {
    id: preset.id,
    distortionK1: Number.isFinite(args.distortionK1) ? args.distortionK1 : preset.distortionK1,
    distortionK2: Number.isFinite(args.distortionK2) ? args.distortionK2 : preset.distortionK2,
    vignetteR2: Number.isFinite(args.vignetteR2) ? args.vignetteR2 : preset.vignetteR2,
    vignetteR4: Number.isFinite(args.vignetteR4) ? args.vignetteR4 : preset.vignetteR4,
    maxGain: Number.isFinite(args.maxGain) ? args.maxGain : preset.maxGain,
  };
}

function printUsage() {
  process.stdout.write(
    [
      'ace-dji-m3-lens-correction-helper',
      '',
      'Usage:',
      '  dji-m3-lens-correction-helper.js --input <neutral.tiff> --output <corrected.tiff> [options]',
      '',
      'Options:',
      '  --profile <id>           Profile id (default: dji-mavic3-l2d-manual-v1)',
      '  --k1 <num>               Distortion k1 override',
      '  --k2 <num>               Distortion k2 override',
      '  --vignette-r2 <num>      Vignette r^2 gain override',
      '  --vignette-r4 <num>      Vignette r^4 gain override',
      '  --max-gain <num>         Vignette max gain clamp override',
      '  --diag / --no-diag       Enable or disable stage diagnostics (default: enabled)',
    ].join('\n') + '\n'
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    printUsage();
    return;
  }

  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  if (!fs.existsSync(inputPath)) {
    fail(`Input TIFF does not exist: ${inputPath}`);
  }

  const profile = mergeProfileArgs(args);
  const timings = {};
  const startedAt = nowMs();

  emitDiag(args.diagnostics, `start input='${inputPath}' output='${outputPath}' profile='${profile.id}'`);

  let stageStart = nowMs();
  const inputBuffer = fs.readFileSync(inputPath);
  timings.inputLoad = nowMs() - stageStart;

  stageStart = nowMs();
  const metadata = parseTiffMetadata(inputBuffer);
  timings.metadataParse = nowMs() - stageStart;

  stageStart = nowMs();
  const packedInfo = extractPackedPixelData(inputBuffer, metadata);
  timings.packedExtract = nowMs() - stageStart;

  stageStart = nowMs();
  const sourcePixels = makeUint16ArrayFromBuffer(packedInfo.packed, packedInfo.copied);
  timings.sourceView = nowMs() - stageStart;

  stageStart = nowMs();
  const centerX = (metadata.width - 1) * 0.5;
  const centerY = (metadata.height - 1) * 0.5;
  const invXRadius = 1 / Math.max(centerX, 1);
  const invYRadius = 1 / Math.max(centerY, 1);
  const xPrecomputed = precomputeNormalizedOffsets(metadata.width, centerX, invXRadius);
  const yPrecomputed = precomputeNormalizedOffsets(metadata.height, centerY, invYRadius);
  timings.precompute = nowMs() - stageStart;

  stageStart = nowMs();
  const destinationPixels = new Uint16Array(sourcePixels.length);
  timings.destinationAlloc = nowMs() - stageStart;

  stageStart = nowMs();
  applyDistortionRemap(sourcePixels, destinationPixels, metadata, profile, {
    centerX,
    centerY,
    normX: xPrecomputed.normalized,
    normY: yPrecomputed.normalized,
    squaredX: xPrecomputed.squared,
    squaredY: yPrecomputed.squared,
  });
  timings.distortionRemap = nowMs() - stageStart;

  stageStart = nowMs();
  applyVignetteGain(destinationPixels, metadata, profile, {
    squaredX: xPrecomputed.squared,
    squaredY: yPrecomputed.squared,
  });
  timings.vignettePass = nowMs() - stageStart;

  stageStart = nowMs();
  writeCorrectedTiff(inputBuffer, destinationPixels, metadata, outputPath);
  timings.outputWrite = nowMs() - stageStart;
  timings.total = nowMs() - startedAt;

  emitDiag(
    args.diagnostics,
    `timings inputLoad=${roundMs(timings.inputLoad)}ms metadataParse=${roundMs(timings.metadataParse)}ms ` +
    `packedExtract=${roundMs(timings.packedExtract)}ms sourceView=${roundMs(timings.sourceView)}ms ` +
    `precompute=${roundMs(timings.precompute)}ms dstAlloc=${roundMs(timings.destinationAlloc)}ms ` +
    `distortionRemap=${roundMs(timings.distortionRemap)}ms vignettePass=${roundMs(timings.vignettePass)}ms ` +
    `outputWrite=${roundMs(timings.outputWrite)}ms total=${roundMs(timings.total)}ms`
  );

  const result = {
    ok: true,
    profileId: profile.id,
    width: metadata.width,
    height: metadata.height,
    samplesPerPixel: metadata.samplesPerPixel,
    processingMs: roundMs(timings.total),
    timingsMs: {
      inputLoad: roundMs(timings.inputLoad),
      metadataParse: roundMs(timings.metadataParse),
      packedExtract: roundMs(timings.packedExtract),
      sourceView: roundMs(timings.sourceView),
      precompute: roundMs(timings.precompute),
      destinationAlloc: roundMs(timings.destinationAlloc),
      distortionRemap: roundMs(timings.distortionRemap),
      vignettePass: roundMs(timings.vignettePass),
      outputWrite: roundMs(timings.outputWrite),
      total: roundMs(timings.total),
    },
    pixelBuffer: {
      copiedPackedPixels: packedInfo.copied,
      stripCount: metadata.stripOffsets.length,
      bytes: metadata.expectedPixelBytes,
    },
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error) {
  fail(error.message || String(error), 1);
}
