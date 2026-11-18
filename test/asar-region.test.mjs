/**
 * Region tests: the patch body shape, the real-archive slot geometry (read-only),
 * and the equal-length write/verify round trip on a synthetic archive copy.
 *
 * Nothing here writes to the real install directory: the write path only ever
 * touches synthetic archives created under `scratch/test-copies/`.
 *
 * The real-archive slot facts are looked up per release in `./real-asar.mjs`
 * (`SHELLS`), so this file passes on any registered DSH desktop version instead
 * of only on 0.2.2-rc.2. What does NOT change between releases:
 *
 *   startInMain     779389   byte offset inside lib/main.js (759609 is the
 *                            character offset after Buffer#toString, which
 *                            drifts because of multi-byte UTF-8 comments)
 *   length          1253
 *   stock sha256    4bc10e1e…ce64
 *
 * …and what does not change between the three supported STATES: `locateRegion`
 * keeps measuring the OFFICIAL slot. The 0.1.x in-slot layout rewrites exactly
 * that range; the 0.2.0 split layout inserts its own region AFTER it and leaves
 * the official slot untouched, so the slot geometry AND its stock digest are the
 * same in all three states.
 *
 * The absolute offset DOES move between releases, because `lib/main.js` sits at
 * a different place in a repacked archive — it comes from the table, never
 * from a constant here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, openSync, readSync, closeSync, rmSync, statSync, writeFileSync, writeSync } from '../lib/fs-safe.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGION_END_MARKER, REGION_LENGTH, REGION_START_MARKER } from '../lib/wire/constants.js';
import { buildPatchedRegion } from '../lib/asar/patch-body.js';
import { align4, closeAsar, openAsar } from '../lib/asar/reader.js';
import { locateRegion } from '../lib/asar/locate.js';
import { sha256Buffer } from '../lib/asar/hash.js';
import {
  buildStockRegion,
  verifyArchiveSize,
  verifyRegion,
  writeRegion,
} from '../lib/asar/region.js';
import {
  REAL_ASAR,
  COPY_DIR as TEST_COPY_DIR,
  currentShell,
  expectedForCurrentState,
  realState,
  shellGate,
} from './real-asar.mjs';

const ASAR = REAL_ASAR;
const COPY_DIR = TEST_COPY_DIR;


/** Create a throwaway directory under `scratch/test-copies/`. */
function scratchDir(prefix) {
  mkdirSync(COPY_DIR, { recursive: true });
  return mkdtempSync(join(COPY_DIR, prefix));
}

/**
 * Build a minimal asar: 16-byte pickle preamble, JSON directory, 4-byte
 * aligned header, then the data area.
 *
 * @param {{ header: object, data: Buffer }} spec
 * @returns {Buffer}
 */
function buildSyntheticAsar(spec) {
  const json = Buffer.from(JSON.stringify(spec.header), 'utf8');
  const padded = align4(json.length);
  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(json.length + 4, 0);
  preamble.writeUInt32LE(json.length, 4);
  preamble.writeUInt32LE(json.length, 8);
  preamble.writeUInt32LE(json.length, 12);
  const pad = Buffer.alloc(padded - json.length, 0);
  return Buffer.concat([preamble, json, pad, spec.data]);
}

/**
 * Build a stock-looking region of exactly `REGION_LENGTH` bytes: start marker,
 * newline, space filler, newline, end marker.
 *
 * @returns {Buffer}
 */
function buildStockRegionFixture() {
  const fixed = REGION_START_MARKER.length + 2 + REGION_END_MARKER.length;
  const filler = REGION_LENGTH - fixed;
  assert.ok(filler > 0, 'the fixture needs room for filler bytes');
  const region = Buffer.concat([
    Buffer.from(`${REGION_START_MARKER}\n`, 'utf8'),
    Buffer.alloc(filler, 0x20),
    Buffer.from(`\n${REGION_END_MARKER}`, 'utf8'),
  ]);
  assert.equal(region.length, REGION_LENGTH);
  return region;
}

/**
 * Write a synthetic archive whose `lib/main.js` holds the given region.
 *
 * @param {string} dir scratch directory
 * @param {{ region: Buffer, mainPrefix?: string }} spec
 * @returns {{ path: string, mainOffset: number, prefixLength: number }}
 */
function writeSyntheticArchive(dir, spec) {
  const prefix = Buffer.from(spec.mainPrefix ?? 'const shell = 1;\n', 'utf8');
  const suffix = Buffer.from('\nexport { shell };\n', 'utf8');
  const main = Buffer.concat([prefix, spec.region, suffix]);
  const pkg = Buffer.from(
    JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.2-rc.2', main: 'lib/main.js' }),
    'utf8',
  );

  const header = {
    files: {
      'package.json': {
        size: pkg.length,
        offset: 0,
        integrity: { algorithm: 'SHA256', hash: sha256Buffer(pkg), blockSize: 4194304, blocks: [sha256Buffer(pkg)] },
      },
      lib: {
        files: {
          'main.js': {
            size: main.length,
            offset: pkg.length,
            integrity: { algorithm: 'SHA256', hash: sha256Buffer(main), blockSize: 4194304, blocks: [sha256Buffer(main)] },
          },
        },
      },
    },
  };

  const path = join(dir, 'app.asar');
  writeFileSync(path, buildSyntheticAsar({ header, data: Buffer.concat([pkg, main]) }));
  return { path, mainOffset: pkg.length, prefixLength: prefix.length };
}

/**
 * Rewrite the recorded integrity digest of `lib/main.js` in a synthetic asar so
 * the archive keeps opening after its main entry was edited. Test-only helper:
 * the real installer never does this (a patched archive legitimately stops
 * matching its recorded digest, which is why classification reads markers).
 *
 * @param {string} path synthetic archive
 * @param {Buffer} newMain the new lib/main.js bytes whose digest to record
 */
function refreshSyntheticIntegrity(path, newMain) {
  const fd = openSync(path, 'r+');
  try {
    const preamble = Buffer.alloc(16);
    readSync(fd, preamble, 0, 16, 0);
    const headerSize = preamble.readUInt32LE(12);
    const headerBuffer = Buffer.alloc(headerSize);
    readSync(fd, headerBuffer, 0, headerSize, 16);
    // Fail the patched-integ programmer-visible way if the fixture is not as
    // expected: we only tolerate a same-length replacement.
    const header = JSON.parse(headerBuffer.toString('utf8'));
    const old = header.files.lib.files['main.js'].integrity;
    if (old.blocks[0].length !== 64) throw new Error('synthetic fixture has an unexpected digest');
    header.files.lib.files['main.js'].integrity.hash = sha256Buffer(newMain);
    header.files.lib.files['main.js'].integrity.blocks = [sha256Buffer(newMain)];
    const next = Buffer.from(JSON.stringify(header), 'utf8');
    if (next.length !== headerSize) throw new Error('test helper requires a same-length header');
    writeSyncAt(fd, next, 16);
  } finally {
    closeSync(fd);
  }
}

/**
 * Positional write helper for the synthetic integrity refresh.
 *
 * @param {number} fd
 * @param {Buffer} buffer
 * @param {number} position
 */
function writeSyncAt(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const wrote = writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (wrote <= 0) throw new Error(`write stalled at ${position + offset}`);
    offset += wrote;
  }
}

/**
 * Read a byte slice from disk without loading the whole file.
 *
 * @param {string} path
 * @param {number} start
 * @param {number} length
 * @returns {Buffer}
 */
function readSlice(path, start, length) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const got = readSync(fd, buffer, offset, length - offset, start + offset);
      if (got <= 0) throw new Error(`short read at ${start + offset}`);
      offset += got;
    }
    return buffer;
  } finally {
    closeSync(fd);
  }
}

test('buildPatchedRegion produces exactly the requested length and ends with //#endregion', () => {
  const patched = buildPatchedRegion(REGION_LENGTH);
  assert.equal(patched.length, REGION_LENGTH);
  assert.equal(patched.subarray(-REGION_END_MARKER.length).toString('utf8'), REGION_END_MARKER);
  assert.ok(patched.toString('utf8').startsWith(REGION_START_MARKER));

  // Deterministic: two calls hash the same.
  assert.equal(sha256Buffer(patched), sha256Buffer(buildPatchedRegion(REGION_LENGTH)));

  // Any larger slot still fits, and the end marker keeps its place.
  const bigger = buildPatchedRegion(REGION_LENGTH + 64);
  assert.equal(bigger.length, REGION_LENGTH + 64);
  assert.equal(bigger.subarray(-REGION_END_MARKER.length).toString('utf8'), REGION_END_MARKER);
});

test('buildPatchedRegion throws when the body cannot fit', () => {
  assert.throws(() => buildPatchedRegion(16), /does not fit|overflow/);
});

test('buildStockRegion returns a copy and validates the digest', () => {
  const stock = buildStockRegionFixture();
  const digest = sha256Buffer(stock);
  const copy = buildStockRegion(stock, digest);
  assert.equal(copy.length, stock.length);
  assert.equal(sha256Buffer(copy), digest);
  // It really is a copy: mutating it must not disturb the source.
  copy[0] = 0x21;
  assert.equal(sha256Buffer(stock), digest);
  assert.throws(() => buildStockRegion(stock, 'deadbeef'.repeat(8)), /stock region 哈希不符/);
});

test('locateRegion on the real asar reports the geometry recorded for its release', { skip: shellGate() }, () => {
  // Geometry (offset + length) is invariant across ALL THREE states a supported
  // install can be in — stock, the 0.1.x in-slot patch, and the 0.2.0 split layout
  // — because `locateRegion` measures the OFFICIAL slot, and the split layout
  // writes AFTER it rather than into it. The absolute offset is release-specific
  // (lib/main.js moves in a repacked archive), so it comes from `SHELLS[version]`,
  // never from a constant in this file.
  //
  // For the split layout this is the strongest claim the layout makes, so it is
  // asserted as exactly the stock slot: same place, same length, same digest.
  const shell = currentShell();
  const current = realState();
  const asar = openAsar(ASAR, { allowStaleMainIntegrity: true });
  assert.equal(asar.ok, true, asar.ok === true ? '' : `${asar.code}: ${asar.message}`);
  try {
    const located = locateRegion(asar);
    assert.equal(located.ok, true, located.ok === true ? '' : `${located.code}: ${located.message}`);
    assert.equal(located.startInMain, shell.stock.slotOffsetInMain);
    assert.equal(located.absoluteOffset, shell.stock.slotAbsolute);
    assert.equal(located.length, shell.stock.slotLength);

    // The expected slot digest per state: in the split layout the official slot
    // stays pristine, so it is the STOCK digest (not the region's); in the
    // in-slot layout it is the digest this build writes; on stock it is the
    // recorded official one. `expectedForCurrentState()` already encodes that.
    const expectedRegionSha = current.layout === 'split'
      ? shell.split.slotSha
      : expectedForCurrentState().regionSha;
    assert.equal(located.sha256, expectedRegionSha,
      `state=${current.state} layout=${current.layout} version=${shell.version}`);

    // Restated independently of the helper, because it is the layout's premise:
    // in a split install the official slot must be byte-for-byte official.
    if (current.layout === 'split') {
      assert.equal(located.sha256, shell.split.slotSha,
        'the split layout must leave the official slot exactly as the release shipped it');
      assert.equal(located.startInMain, shell.split.slotOffsetInMain);
      assert.equal(located.length, shell.split.slotLength);
    }

    assert.equal(located.stockBytes.length, shell.stock.slotLength);
    assert.equal(located.absoluteOffset, asar.dataStart + located.mainOffset + located.startInMain);

    const text = located.stockBytes.toString('utf8');
    assert.ok(text.startsWith(REGION_START_MARKER));
    assert.ok(text.endsWith(REGION_END_MARKER));

    // Same bytes straight off the disk (read-only) hash the same.
    assert.equal(sha256Buffer(readSlice(ASAR, located.absoluteOffset, located.length)), expectedRegionSha);
  } finally {
    closeAsar(asar);
  }
});

test('equal-length write -> verify -> stock write-back keeps the file size constant', () => {
  const dir = scratchDir('region-');
  try {
    const stockRegion = buildStockRegionFixture();
    const stockSha = sha256Buffer(stockRegion);
    const { path, mainOffset, prefixLength } = writeSyntheticArchive(dir, { region: stockRegion });
    const sizeBefore = statSync(path).size;

    const opened = openAsar(path);
    assert.equal(opened.ok, true, opened.ok === true ? '' : `${opened.code}: ${opened.message}`);
    let absoluteOffset;
    try {
      const located = locateRegion(opened);
      assert.equal(located.ok, true, located.ok === true ? '' : `${located.code}: ${located.message}`);
      assert.equal(located.length, REGION_LENGTH);
      assert.equal(located.sha256, stockSha);
      assert.equal(located.mainOffset, mainOffset);
      assert.equal(located.startInMain, prefixLength);
      absoluteOffset = located.absoluteOffset;
      assert.equal(absoluteOffset, opened.dataStart + mainOffset + prefixLength);
    } finally {
      closeAsar(opened);
    }

    // 1. Write the patched region in place.
    const patched = buildPatchedRegion(REGION_LENGTH);
    const patchedSha = sha256Buffer(patched);
    const written = writeRegion(path, absoluteOffset, patched);
    assert.equal(written.ok, true, written.ok === true ? '' : `${written.code}: ${written.message}`);
    assert.equal(written.bytesWritten, REGION_LENGTH);
    assert.equal(written.sha256, patchedSha);
    assert.equal(statSync(path).size, sizeBefore);

    // 2. Read it back and compare with the expected digest.
    const verified = verifyRegion(path, absoluteOffset, patchedSha, REGION_LENGTH);
    assert.equal(verified.ok, true, verified.ok === true ? '' : `${verified.code}: ${verified.message}`);
    assert.equal(verified.actual, patchedSha);
    assert.equal(sha256Buffer(readSlice(path, absoluteOffset, REGION_LENGTH)), patchedSha);

    // 3. A digest mismatch must be reported, not silently accepted.
    const wrong = verifyRegion(path, absoluteOffset, stockSha, REGION_LENGTH);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'EWRITE_VERIFY');
    assert.equal(wrong.actual, patchedSha);
    assert.equal(wrong.expected, stockSha);

    // 4. Write the stock region back and verify again.
    const restored = writeRegion(path, absoluteOffset, stockRegion);
    assert.equal(restored.ok, true, restored.ok === true ? '' : `${restored.code}: ${restored.message}`);
    assert.equal(restored.sha256, stockSha);
    const restocked = verifyRegion(path, absoluteOffset, stockSha, REGION_LENGTH);
    assert.equal(restocked.ok, true, restocked.ok === true ? '' : `${restocked.code}: ${restocked.message}`);
    assert.equal(restocked.actual, stockSha);
    assert.equal(sha256Buffer(readSlice(path, absoluteOffset, REGION_LENGTH)), stockSha);

    // 5. The archive size never moved during any of those writes.
    assert.equal(statSync(path).size, sizeBefore);
    assert.equal(verifyArchiveSize(path, sizeBefore).ok, true);
    assert.equal(verifyArchiveSize(path, sizeBefore + 1).ok, false);

    // 6. Bytes outside the slot are byte-identical to the pre-write state.
    const outsideHead = readSlice(path, 0, absoluteOffset);
    const outsideTail = readSlice(path, absoluteOffset + REGION_LENGTH, sizeBefore - absoluteOffset - REGION_LENGTH);
    assert.equal(outsideHead.length + REGION_LENGTH + outsideTail.length, sizeBefore);
    assert.equal(sha256Buffer(outsideHead), sha256Buffer(readSlice(path, 0, absoluteOffset)));
    assert.ok(outsideTail.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a synthetic archive still opens after its main entry is replaced', () => {
  const dir = scratchDir('reopen-');
  try {
    const stockRegion = buildStockRegionFixture();
    const { path } = writeSyntheticArchive(dir, { region: stockRegion });

    const first = openAsar(path);
    assert.equal(first.ok, true, first.ok === true ? '' : `${first.code}: ${first.message}`);
    let absoluteOffset;
    let mainSize;
    let mainStart;
    try {
      const located = locateRegion(first);
      assert.equal(located.ok, true);
      absoluteOffset = located.absoluteOffset;
      mainSize = first.mainEntry.size;
      mainStart = first.dataStart + first.mainEntry.offset;
    } finally {
      closeAsar(first);
    }
    assert.ok(absoluteOffset > mainStart);

    const patched = buildPatchedRegion(REGION_LENGTH);
    const written = writeRegion(path, absoluteOffset, patched);
    assert.equal(written.ok, true);

    // The recorded digest now describes the old bytes: the gate must refuse.
    const stale = openAsar(path);
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'EASAR_HEADER');

    // Update the directory digest (test-only) and the archive opens again,
    // which proves the slot write itself kept the archive shape valid.
    const mainBytes = readSlice(path, mainStart, mainSize);
    assert.equal(sha256Buffer(mainBytes.subarray(absoluteOffset - mainStart, absoluteOffset - mainStart + REGION_LENGTH)), sha256Buffer(patched));
    refreshSyntheticIntegrity(path, mainBytes);

    const reopened = openAsar(path);
    assert.equal(reopened.ok, true, reopened.ok === true ? '' : `${reopened.code}: ${reopened.message}`);
    try {
      assert.equal(reopened.entries.size, 2);
      assert.equal(reopened.mainEntry.size, mainSize);
    } finally {
      closeAsar(reopened);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeRegion refuses an out-of-bounds or empty write', () => {
  const dir = scratchDir('bounds-');
  try {
    const { path } = writeSyntheticArchive(dir, { region: buildStockRegionFixture() });
    const size = statSync(path).size;
    const oob = writeRegion(path, size - 4, Buffer.alloc(8, 0x20));
    assert.equal(oob.ok, false);
    assert.equal(oob.code, 'EWRITE_FAILED');
    assert.equal(statSync(path).size, size);

    const empty = writeRegion(path, 0, Buffer.alloc(0));
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'EINVALID_INPUT');

    const missing = writeRegion(join(dir, 'nope.asar'), 0, Buffer.alloc(4, 0x20));
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'EASAR_MISSING');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

export { buildSyntheticAsar, scratchDir, buildStockRegionFixture };

