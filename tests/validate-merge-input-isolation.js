#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const { HdrService } = require('../src/main/hdr-service');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

function parseJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function extractSequenceIds(filePaths) {
  return filePaths
    .map((filePath) => {
      const base = path.basename(filePath);
      const match = base.match(/_(\d{4})_D_M3P/i);
      if (match) return Number(match[1]);

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const fromContent = content.match(/sequence=(\d{4})/i);
        if (fromContent) return Number(fromContent[1]);
      } catch {}

      return null;
    })
    .filter((value) => Number.isFinite(value));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createMockTools(helperRoot, logsDir) {
  const binDir = ensureDir(path.join(helperRoot, 'bin'));
  const alignLog = path.join(logsDir, 'align.jsonl');
  const enfuseLog = path.join(logsDir, 'enfuse.jsonl');

  const alignScript = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
let prefix = 'aligned_';
const inputs = [];
for (let i = 0; i < args.length; i += 1) {
  const value = args[i];
  if (value === '-a') {
    prefix = args[i + 1];
    i += 1;
    continue;
  }
  if (value.startsWith('-')) continue;
  inputs.push(value);
}
if (!inputs.length) {
  process.stderr.write('No align inputs provided.\\n');
  process.exit(2);
}
for (let i = 0; i < inputs.length; i += 1) {
  const index = String(i).padStart(4, '0');
  const outPath = prefix + index + '.tif';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.copyFileSync(inputs[i], outPath);
}
if (process.env.ACE_TEST_ALIGN_LOG) {
  fs.appendFileSync(
    process.env.ACE_TEST_ALIGN_LOG,
    JSON.stringify({ inputs, prefix }) + '\\n'
  );
}
`;

const enfuseScript = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
let outputPath = null;
const inputs = [];
for (let i = 0; i < args.length; i += 1) {
  const value = args[i];
  if (value === '-o') {
    outputPath = args[i + 1];
    i += 1;
    continue;
  }
  if (value.startsWith('-')) continue;
  inputs.push(value);
}
if (!outputPath) {
  process.stderr.write('Missing enfuse output path.\\n');
  process.exit(2);
}
if (!inputs.length) {
  process.stderr.write('Missing enfuse inputs.\\n');
  process.exit(2);
}
if (process.env.ACE_TEST_ENFUSE_LOG) {
  fs.appendFileSync(
    process.env.ACE_TEST_ENFUSE_LOG,
    JSON.stringify({ outputPath, inputs }) + '\\n'
  );
}
function writeTinyRgbTiff(targetPath, bitDepth) {
  const ifdOffset = 8;
  const entryCount = 9;
  const ifdByteLength = 2 + (entryCount * 12) + 4;
  const bitsOffset = ifdOffset + ifdByteLength;
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const stripByteCount = 3 * bytesPerSample;
  const pixelOffset = bitsOffset + 6;
  const fileSize = pixelOffset + stripByteCount;
  const tiff = Buffer.alloc(fileSize, 0);

  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(ifdOffset, 4);

  let cursor = ifdOffset;
  tiff.writeUInt16LE(entryCount, cursor);
  cursor += 2;

  const writeEntry = (tag, type, count, valueOrOffset) => {
    tiff.writeUInt16LE(tag, cursor);
    tiff.writeUInt16LE(type, cursor + 2);
    tiff.writeUInt32LE(count, cursor + 4);
    tiff.writeUInt32LE(valueOrOffset, cursor + 8);
    cursor += 12;
  };

  writeEntry(256, 4, 1, 1); // ImageWidth
  writeEntry(257, 4, 1, 1); // ImageLength
  writeEntry(258, 3, 3, bitsOffset); // BitsPerSample
  writeEntry(259, 3, 1, 1); // Compression = none
  writeEntry(262, 3, 1, 2); // PhotometricInterpretation = RGB
  writeEntry(273, 4, 1, pixelOffset); // StripOffsets
  writeEntry(277, 3, 1, 3); // SamplesPerPixel
  writeEntry(278, 4, 1, 1); // RowsPerStrip
  writeEntry(279, 4, 1, stripByteCount); // StripByteCounts
  tiff.writeUInt32LE(0, cursor); // next IFD offset

  tiff.writeUInt16LE(bitDepth, bitsOffset);
  tiff.writeUInt16LE(bitDepth, bitsOffset + 2);
  tiff.writeUInt16LE(bitDepth, bitsOffset + 4);

  if (bitDepth === 16) {
    // 1x1 pixel RGB sample values (16-bit).
    tiff.writeUInt16LE(24576, pixelOffset + 0);
    tiff.writeUInt16LE(20480, pixelOffset + 2);
    tiff.writeUInt16LE(16384, pixelOffset + 4);
  } else {
    // 1x1 pixel RGB sample values (8-bit).
    tiff.writeUInt8(160, pixelOffset + 0);
    tiff.writeUInt8(132, pixelOffset + 1);
    tiff.writeUInt8(104, pixelOffset + 2);
  }

  fs.writeFileSync(targetPath, tiff);
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const outputBits = Number(process.env.ACE_TEST_ENFUSE_BITS || '16');
writeTinyRgbTiff(outputPath, outputBits === 8 ? 8 : 16);
`;

  const alignPath = path.join(binDir, 'align_image_stack');
  const enfusePath = path.join(binDir, 'enfuse');
  writeExecutable(alignPath, alignScript);
  writeExecutable(enfusePath, enfuseScript);

  return {
    alignPath,
    enfusePath,
    alignLog,
    enfuseLog,
  };
}

function createSyntheticGroups(inputRoot) {
  const groups = [];
  let sequence = 31;

  for (let setIndex = 1; setIndex <= 4; setIndex += 1) {
    const sourcePaths = [];
    for (let i = 0; i < 5; i += 1) {
      const sequenceText = String(sequence).padStart(4, '0');
      const fileName = `DJI_20260309161600_${sequenceText}_D_M3P.tif`;
      const filePath = path.join(inputRoot, fileName);
      fs.writeFileSync(filePath, `set=${setIndex},sequence=${sequenceText}\n`, 'utf8');
      sourcePaths.push(filePath);
      sequence += 1;
    }

    groups.push({
      id: `set-${setIndex}`,
      setIndex,
      sourcePaths,
      sourceCount: sourcePaths.length,
      firstFileName: path.basename(sourcePaths[0]),
    });
  }

  return groups;
}

async function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-merge-isolation-'));
  const helperRoot = ensureDir(path.join(tempRoot, 'helpers'));
  const inputRoot = ensureDir(path.join(tempRoot, 'inputs'));
  const outputRoot = ensureDir(path.join(tempRoot, 'outputs'));
  const logsRoot = ensureDir(path.join(tempRoot, 'logs'));
  const queueLogPath = path.join(logsRoot, 'queue.log');
  const previousHelperRoot = process.env.ACE_HELPER_ROOT;
  const previousAlignLog = process.env.ACE_TEST_ALIGN_LOG;
  const previousEnfuseLog = process.env.ACE_TEST_ENFUSE_LOG;

  try {
    const mockTools = createMockTools(helperRoot, logsRoot);
    process.env.ACE_HELPER_ROOT = helperRoot;
    process.env.ACE_TEST_ALIGN_LOG = mockTools.alignLog;
    process.env.ACE_TEST_ENFUSE_LOG = mockTools.enfuseLog;

    const groups = createSyntheticGroups(inputRoot);
    const rawService = { isRawFile: () => false };
    const serviceLogLines = [];

    const hdrService = new HdrService({
      cacheRoot: path.join(tempRoot, 'cache'),
      rawService,
      logger: (line) => serviceLogLines.push(String(line || '')),
    });

    for (const group of groups) {
      const outputPath = path.join(outputRoot, `set-${String(group.setIndex).padStart(4, '0')}.tif`);
      await hdrService.mergeGroup(group, {
        mode: 'fusion',
        outputPath,
        autoAlign: true,
        logPath: queueLogPath,
        workerId: `SET${String(group.setIndex).padStart(4, '0')}`,
        cacheKeySuffix: `set-${group.setIndex}`,
      });
      assert(fs.existsSync(outputPath), `Missing merged output for set ${group.setIndex}.`);
    }

    const alignCalls = parseJsonLines(mockTools.alignLog);
    const enfuseCalls = parseJsonLines(mockTools.enfuseLog);
    assert(alignCalls.length === 4, `Expected 4 align calls, got ${alignCalls.length}.`);
    assert(enfuseCalls.length === 4, `Expected 4 enfuse calls, got ${enfuseCalls.length}.`);

    for (let i = 0; i < 4; i += 1) {
      const alignCall = alignCalls[i];
      const enfuseCall = enfuseCalls[i];
      const setIndex = i + 1;
      const expectedIds = new Set([
        30 + (setIndex * 5) - 4,
        30 + (setIndex * 5) - 3,
        30 + (setIndex * 5) - 2,
        30 + (setIndex * 5) - 1,
        30 + (setIndex * 5),
      ]);

      assert(alignCall.inputs.length === 5, `Set ${setIndex} expected 5 aligned inputs, got ${alignCall.inputs.length}.`);
      assert(enfuseCall.inputs.length === 5, `Set ${setIndex} expected 5 fusion inputs, got ${enfuseCall.inputs.length}.`);

      for (const fusedInput of enfuseCall.inputs) {
        assert(
          fusedInput.startsWith(alignCall.prefix),
          `Set ${setIndex} enfuse input escaped align prefix. input=${fusedInput} prefix=${alignCall.prefix}`
        );
      }

      const ids = extractSequenceIds(alignCall.inputs);
      assert(
        ids.length === 5,
        `Set ${setIndex} did not contain 5 parseable sequence ids. inputs=${JSON.stringify(alignCall.inputs)}`
      );

      for (const id of ids) {
        assert(expectedIds.has(id), `Set ${setIndex} used cross-set sequence ${id}.`);
      }
    }

    const sourceJsonLines = serviceLogLines.filter((line) => line.includes('SOURCE_FILES_JSON'));
    const convertedJsonLines = serviceLogLines.filter((line) => line.includes('CONVERTED_TIFFS_JSON'));
    assert(sourceJsonLines.length === 4, `Expected 4 SOURCE_FILES_JSON log entries, got ${sourceJsonLines.length}.`);
    assert(convertedJsonLines.length === 4, `Expected 4 CONVERTED_TIFFS_JSON log entries, got ${convertedJsonLines.length}.`);

    const queueLogContent = fs.existsSync(queueLogPath) ? fs.readFileSync(queueLogPath, 'utf8') : '';
    const alignedEntries = (queueLogContent.match(/ALIGNED_TIFFS_JSON/g) || []).length;
    assert(alignedEntries >= 4, `Expected aligned TIFF log entries for all sets, got ${alignedEntries}.`);
    const bitDepthChecks = (queueLogContent.match(/bit-depth check passed/gi) || []).length;
    assert(bitDepthChecks >= 4, `Expected 16-bit verification log entries for all sets, got ${bitDepthChecks}.`);

    console.log('merge-input-isolation: PASS');
    console.log(`Temp root: ${tempRoot}`);
  } finally {
    if (previousHelperRoot === undefined) delete process.env.ACE_HELPER_ROOT;
    else process.env.ACE_HELPER_ROOT = previousHelperRoot;

    if (previousAlignLog === undefined) delete process.env.ACE_TEST_ALIGN_LOG;
    else process.env.ACE_TEST_ALIGN_LOG = previousAlignLog;

    if (previousEnfuseLog === undefined) delete process.env.ACE_TEST_ENFUSE_LOG;
    else process.env.ACE_TEST_ENFUSE_LOG = previousEnfuseLog;
  }
}

run().catch((error) => {
  console.error(`merge-input-isolation: FAIL: ${error.message || error}`);
  process.exitCode = 1;
});
