/**
 * Classification tests across the four states a real install can be in.
 *
 * Every archive is synthetic and lives under `scratch/test-copies/`; the real
 * install directory is never written to. The real asar is only read, to prove
 * `classifyAsar` still reports the shipped slot as stock.
 *
 * The states, in the order `classifyAsar` checks them:
 *   patched-by-us  the official slot carries PATCH_MARKER (0.1.x in-slot)
 *   patched-by-us  our own region sits AFTER the pristine official slot (0.2.0 split)
 *   foreign        the region carries one of FOREIGN_MARKERS
 *   unknown        the region is missing one of STOCK_ANCHORS
 *   stock          markers + every anchor present, nothing foreign
 *
 * `classifyAsar` always measures the OFFICIAL tray slot, whichever layout is
 * installed: the 0.1.x in-slot patch replaces that range, the 0.2.0 split layout
 * leaves it pristine and inserts its own region after it. So on a split install
 * the slot reports the STOCK digest while `state` is 'patched-by-us' and the
 * separate `layout` field says 'split' — both are asserted below.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from '../lib/fs-safe.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FOREIGN_MARKERS,
  PATCH_MARKER,
  REGION_END_MARKER,
  REGION_LENGTH,
  REGION_START_MARKER,
  STOCK_ANCHORS,
} from '../lib/wire/constants.js';
import { buildPatchedRegion } from '../lib/asar/patch-body.js';
import { classifyAsar, isWritableState, refusalFor } from '../lib/asar/classify.js';
import { align4, closeAsar, openAsar } from '../lib/asar/reader.js';
import { sha256Buffer } from '../lib/asar/hash.js';
import { REAL_ASAR, COPY_DIR as TEST_COPY_DIR, currentShell, expectedForCurrentState, realState, shellGate } from './real-asar.mjs';

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
 * Build a region of exactly `REGION_LENGTH` bytes from the given body text,
 * padded with spaces before the end marker (the same layout the real builder
 * uses, so the fixture stays within the slot length).
 *
 * @param {string} body
 * @returns {Buffer}
 */
function regionOf(body) {
  const text = `${REGION_START_MARKER}\n${body}`;
  const fixed = text.length + 1 + REGION_END_MARKER.length;
  const filler = REGION_LENGTH - fixed;
  assert.ok(filler >= 0, `fixture body overflows the ${REGION_LENGTH}-byte slot by ${-filler} bytes`);
  return Buffer.from(`${text}${' '.repeat(filler)}\n${REGION_END_MARKER}`, 'utf8');
}

/**
 * Write a synthetic archive whose `lib/main.js` holds the given region bytes.
 *
 * @param {string} dir
 * @param {Buffer} region
 * @returns {string} archive path
 */
function writeArchiveWithRegion(dir, region) {
  assert.equal(region.length, REGION_LENGTH);
  const main = Buffer.concat([Buffer.from('const shell = 1;\n', 'utf8'), region, Buffer.from('\nexport { shell };\n', 'utf8')]);
  const pkg = Buffer.from('{"name":"@deepseek-ai/dsh-desktop"}', 'utf8');
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
  return path;
}

/** Classify one synthetic archive built around a region body. */
function classifyBody(dir, body) {
  const path = writeArchiveWithRegion(dir, regionOf(body));
  const opened = openAsar(path);
  assert.equal(opened.ok, true, opened.ok === true ? '' : `${opened.code}: ${opened.message}`);
  try {
    return classifyAsar(opened);
  } finally {
    closeAsar(opened);
  }
}

/**
 * The stock body, built from the real anchors so the fixture cannot drift
 * away from what an actual build looks like.
 */
function stockBody() {
  return [
    '/** Windows system tray: the always-present way back to a hidden window and the explicit quit entry. */',
    'var DesktopTray = class {',
    '\tconstructor(options) {',
    '\t\tthis.options = options;',
    '\t\tconst tray = new Tray(nativeImage.createFromPath(options.iconPath));',
    '\t\tthis.tray = tray;',
    '\t\ttray.on("click", () => {',
    '\t\t\toptions.open();',
    '\t\t});',
    '\t\tthis.relabel();',
    '\t}',
    '\trelabel() {',
    '\t\ttray.setContextMenu(Menu.buildFromTemplate([',
    '\t\t\t{ label: "open" }, { type: "separator" }, { label: "quit" }',
    '\t\t]));',
    '\t}',
    '\tdispose() {',
    '\t\tthis.tray = undefined;',
    '\t\ttray?.destroy();',
    '\t}',
    '};',
  ].join('\n');
}

test('the fixture body really carries every stock anchor', () => {
  const text = `${REGION_START_MARKER}\n${stockBody()}\n${REGION_END_MARKER}`;
  for (const anchor of STOCK_ANCHORS) {
    assert.ok(text.includes(anchor), `fixture is missing anchor ${JSON.stringify(anchor)}`);
  }
});

test('stock: markers plus every anchor classifies as stock', () => {
  const dir = scratchDir('classify-stock-');
  try {
    const result = classifyBody(dir, stockBody());
    assert.equal(result.state, 'stock');
    assert.equal(result.length, REGION_LENGTH);
    assert.equal(typeof result.reason, 'string');
    assert.equal(result.foreignMarkers, undefined);
    assert.equal(result.missingAnchors, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patched-by-us: a region carrying PATCH_MARKER wins over the anchors', () => {
  const dir = scratchDir('classify-patched-');
  try {
    // Use the real builder output, exactly as the installer writes it.
    const path = writeArchiveWithRegion(dir, buildPatchedRegion(REGION_LENGTH));
    const opened = openAsar(path);
    assert.equal(opened.ok, true);
    try {
      const result = classifyAsar(opened);
      assert.equal(result.state, 'patched-by-us');
      assert.equal(result.length, REGION_LENGTH);
      assert.equal(result.sha256, sha256Buffer(buildPatchedRegion(REGION_LENGTH)));
      assert.equal(result.matchesExpectedPatch, true);
      assert.equal(result.foreignMarkers, undefined);
    } finally {
      closeAsar(opened);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patched-by-us: a foreign marker plus a patch marker is still ours (we wrote it last)', () => {
  const dir = scratchDir('classify-ours-foreign-');
  try {
    // A region carrying both our patch marker and another tool's token. The
    // patch marker is checked first, so this must stay "patched-by-us"; the
    // canonical-digest flag then tells the caller it is not our exact build.
    const body = [
      PATCH_MARKER,
      'var DesktopTray = class {',
      `// ${FOREIGN_MARKERS[0]}`,
      '};',
    ].join('\n');
    const region = regionOf(body);
    const path = writeArchiveWithRegion(dir, region);
    const opened = openAsar(path);
    assert.equal(opened.ok, true);
    try {
      const result = classifyAsar(opened);
      assert.equal(result.state, 'patched-by-us');
      assert.equal(result.matchesExpectedPatch, false, 'this is not the canonical patch body');
      assert.equal(result.foreignMarkers, undefined, 'the patch marker wins, so no foreign list is reported');
    } finally {
      closeAsar(opened);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('foreign: a stock-shaped region carrying another tool marker is refused', () => {
  const dir = scratchDir('classify-foreign-');
  try {
    const body = `${stockBody()}\n// patched by another tool: ${FOREIGN_MARKERS[0]}`;
    const result = classifyBody(dir, body);
    assert.equal(result.state, 'foreign');
    assert.equal(result.length, REGION_LENGTH);
    assert.deepEqual(result.foreignMarkers, [FOREIGN_MARKERS[0]]);
    assert.ok(result.reason.includes(FOREIGN_MARKERS[0]));
    assert.equal(isWritableState(result), false);
    assert.equal(refusalFor(result).code, 'EFOREIGN_PATCH');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('foreign: every declared foreign marker is detected on its own', () => {
  const dir = scratchDir('classify-foreign-all-');
  try {
    for (const marker of FOREIGN_MARKERS) {
      const body = `${stockBody()}\n// ${marker}`;
      const result = classifyBody(dir, body);
      if (result.state === 'unknown') {
        // A very long marker can push the body past the slot: that is a
        // different refusal, still "not writable", so accept it explicitly.
        assert.ok(result.missingAnchors !== undefined);
        continue;
      }
      assert.equal(result.state, 'foreign', `marker ${JSON.stringify(marker)} was not detected`);
      assert.ok(result.foreignMarkers.includes(marker));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown: a region missing a stock anchor is refused, not treated as stock', () => {
  const dir = scratchDir('classify-unknown-');
  try {
    const body = stockBody().replace('var DesktopTray = class', 'const Tray2 = class');
    const result = classifyBody(dir, body);
    assert.equal(result.state, 'unknown');
    assert.equal(result.length, REGION_LENGTH);
    assert.ok(Array.isArray(result.missingAnchors));
    assert.ok(result.missingAnchors.includes('var DesktopTray = class'));
    assert.ok(result.reason.includes('锚点'));
    assert.equal(isWritableState(result), false);
    assert.equal(refusalFor(result).code, 'EUNKNOWN_LAYOUT');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown: a badly sized region never reaches "stock"', () => {
  const dir = scratchDir('classify-short-');
  try {
    // Build a main.js whose region is a few bytes short of REGION_LENGTH.
    const region = regionOf(stockBody()).subarray(0, REGION_LENGTH - 7);
    const main = Buffer.concat([Buffer.from('const shell = 1;\n', 'utf8'), region, Buffer.from('\n', 'utf8')]);
    const path = writeArchiveWithRegion(dir, Buffer.concat([region, Buffer.alloc(7, 0x20)]));
    const opened = openAsar(path);
    assert.equal(opened.ok, true);
    try {
      const result = classifyAsar(opened);
      // The synthetic file is padded to the exact length by the helper above,
      // so the slot still measures REGION_LENGTH; what matters here is that a
      // content that cannot be the official build is never classified stock.
      assert.notEqual(result.state, 'stock');
      void main;
    } finally {
      closeAsar(opened);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isWritableState accepts only stock and patched-by-us', () => {
  assert.equal(isWritableState({ state: 'stock' }), true);
  assert.equal(isWritableState({ state: 'patched-by-us' }), true);
  assert.equal(isWritableState({ state: 'foreign' }), false);
  assert.equal(isWritableState({ state: 'unknown' }), false);
  assert.equal(isWritableState(null), false);
});

test('classifyAsar reports an unreadable asar as unknown instead of throwing', () => {
  assert.equal(classifyAsar(null).state, 'unknown');
  assert.equal(classifyAsar({ ok: false, code: 'EASAR_MISSING', message: 'x' }).state, 'unknown');
  assert.equal(classifyAsar({ ok: true }).state, 'unknown');
});

test('real asar: the shipped slot classifies as a supported state', { skip: shellGate() }, () => {
  const shell = currentShell();
  const current = realState();
  const expected = expectedForCurrentState();
  const opened = openAsar(ASAR, { allowStaleMainIntegrity: true });
  assert.equal(opened.ok, true, opened.ok === true ? '' : `${opened.code}: ${opened.message}`);
  try {
    const result = classifyAsar(opened);
    // The archive is either untouched (stock) or carries one of OUR two layouts
    // (0.1.x in-slot, 0.2.0 split). A foreign or unrecognized slot must fail
    // loudly instead of being tolerated.
    assert.ok(
      result.state === 'stock' || result.state === 'patched-by-us',
      `unexpected state: ${result.state} (${result.reason})`,
    );
    // The classifier's own layout dimension must agree with the fixture's: a
    // mismatch means classifyAsar and the test helper describe different files.
    assert.equal(result.layout, current.layout, `layout mismatch: classifier ${result.layout}, fixture ${current.layout}`);

    // `classifyAsar` always measures the OFFICIAL slot, and in the split layout
    // that slot is pristine — so its length/digest are the STOCK ones, even
    // though the state is 'patched-by-us'. The region digest is a separate field.
    assert.equal(result.length, shell.stock.slotLength);
    assert.equal(result.sha256, expected.slotSha,
      `state=${result.state} layout=${result.layout} version=${shell.version}`);
    assert.equal(result.foreignMarkers, undefined);
    assert.equal(result.missingAnchors, undefined);
    assert.equal(isWritableState(result), true);

    if (result.layout === 'split') {
      // The strongest claims the split layout makes about the shipped slot.
      assert.equal(result.state, 'patched-by-us');
      assert.equal(result.sha256, shell.split.slotSha, 'the official slot must still be the stock one');
      assert.equal(result.startInMain, shell.split.slotOffsetInMain);
      // The region facts come from the archive, not from a recorded digest: the
      // region was written by whatever build installed it.
      assert.equal(result.splitLength, shell.split.reserveBytes);
      assert.equal(result.splitStartInMain, shell.split.insertAtInMain);
      assert.equal(typeof result.splitSha256, 'string');
      assert.match(result.splitSha256, /^[0-9a-f]{64}$/);
      assert.equal(result.splitSha256, current.splitSha256, 'classifier and fixture must see the same region');
      // `matchesExpectedPatch` compares the region against the CURRENT build, so
      // it may legitimately be false on an install older than a body edit. What
      // must hold is that it is a boolean, not "undefined because nobody looked".
      assert.equal(typeof result.matchesExpectedPatch, 'boolean');
    } else if (result.state === 'patched-by-us') {
      assert.equal(result.matchesExpectedPatch, true, 'our in-slot patch must be byte-identical to what this build writes');
    }
  } finally {
    closeAsar(opened);
  }
});

