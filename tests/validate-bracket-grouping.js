#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { detectBracketGroups } = require('../bracket-detector');
const { RawService } = require('../raw-service');

const TEST_FOLDER = path.resolve(__dirname, 'hdr-samples', 'hdr-set-3');
const EXPOSURE_CYCLE = [-2, -1, 0, 1, 2];

function parseSequenceNumber(filePath) {
  const stem = path.basename(filePath, path.extname(filePath));
  const match = stem.match(/_(\d{3,6})(?:_|$)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseExifDateFromName(filePath) {
  const stem = path.basename(filePath, path.extname(filePath));
  const match = stem.match(/(20\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;
  return `${match[1]}:${match[2]}:${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function buildSyntheticMetadataMap(files) {
  const map = new Map();
  for (const filePath of files) {
    const sequenceNumber = parseSequenceNumber(filePath);
    const exposureIndex = Number.isFinite(sequenceNumber)
      ? Math.abs((sequenceNumber - 1) % EXPOSURE_CYCLE.length)
      : 0;
    map.set(path.resolve(filePath), {
      exposureCompensation: EXPOSURE_CYCLE[exposureIndex],
      dateTimeOriginal: parseExifDateFromName(filePath),
    });
  }
  return map;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function validateNoCrossMix(completeGroups) {
  let previousEnd = null;
  for (const group of completeGroups) {
    const sequences = group.sourcePaths
      .map(parseSequenceNumber)
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);

    assert(sequences.length === 5, `Expected 5 sequence values, got ${sequences.length} in ${group.id}`);

    const span = sequences[sequences.length - 1] - sequences[0];
    assert(span <= 4, `Group ${group.id} has suspicious sequence span ${span}: ${sequences.join(', ')}`);

    for (let i = 1; i < sequences.length; i++) {
      const gap = sequences[i] - sequences[i - 1];
      assert(gap === 1, `Group ${group.id} has non-consecutive sequence gap ${gap}: ${sequences.join(', ')}`);
    }

    if (Number.isFinite(previousEnd)) {
      assert(sequences[0] === previousEnd + 1, `Detected set boundary overlap/mix near ${group.id}`);
    }

    previousEnd = sequences[sequences.length - 1];
    assert(group.validForMerge !== false, `Group ${group.id} unexpectedly failed merge validation.`);
  }
}

async function runDetection(mode, sourceFiles, metadataMap, rawService) {
  return detectBracketGroups(sourceFiles, {
    bracketMode: mode,
    isRawFile: (filePath) => rawService.isRawFile(filePath),
    readMetadata: async (paths) => {
      const subset = new Map();
      for (const filePath of paths || []) {
        subset.set(path.resolve(filePath), metadataMap.get(path.resolve(filePath)) || null);
      }
      return subset;
    },
  });
}

async function main() {
  if (!fs.existsSync(TEST_FOLDER)) {
    throw new Error(`Test folder not found: ${TEST_FOLDER}`);
  }

  const rawService = new RawService({ logger: () => {} });
  const sourceFiles = fs.readdirSync(TEST_FOLDER)
    .map((name) => path.join(TEST_FOLDER, name))
    .filter((filePath) => rawService.isRawFile(filePath))
    .sort((a, b) => a.localeCompare(b));

  assert(sourceFiles.length === 20, `Expected 20 files in test set, got ${sourceFiles.length}`);

  const metadataMap = buildSyntheticMetadataMap(sourceFiles);

  const forcedFive = await runDetection('5', sourceFiles, metadataMap, rawService);
  assert(forcedFive.completeGroups.length === 4, `Forced-5 detection expected 4 complete groups, got ${forcedFive.completeGroups.length}`);
  assert(forcedFive.incompleteGroups.length === 0, `Forced-5 detection expected 0 incomplete groups, got ${forcedFive.incompleteGroups.length}`);
  validateNoCrossMix(forcedFive.completeGroups);

  const auto = await runDetection('auto', sourceFiles, metadataMap, rawService);
  assert(auto.completeGroups.length === 4, `Auto detection expected 4 complete groups, got ${auto.completeGroups.length}`);
  assert(auto.incompleteGroups.length === 0, `Auto detection expected 0 incomplete groups, got ${auto.incompleteGroups.length}`);
  validateNoCrossMix(auto.completeGroups);

  const summary = {
    ok: true,
    folder: TEST_FOLDER,
    sourceCount: sourceFiles.length,
    forcedFiveGroups: forcedFive.completeGroups.map((group) => ({
      id: group.id,
      partitionMethod: group.partitionMethod,
      sequenceRange: group.sequenceRange,
      validForMerge: group.validForMerge,
    })),
    autoGroups: auto.completeGroups.map((group) => ({
      id: group.id,
      partitionMethod: group.partitionMethod,
      sequenceRange: group.sequenceRange,
      validForMerge: group.validForMerge,
    })),
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exit(1);
});
