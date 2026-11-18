/**
 * Upgrade-spent detection tests.
 *
 * A DSH upgrade replaces `resources\` wholesale: the archive comes back
 * pristine, every `*.bak` disappears and the unpacked bridge goes with it, while
 * `install.json` still claims an install. Those states are reproduced here on
 * synthetic asars inside a throwaway directory; nothing touches the real DSH
 * install directory, and nothing here writes an asar outside the temp dir.
 *
 * `node --test --test-isolation=none test/upgrade-detect.test.mjs`
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync,
} from '../lib/fs-safe.js';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { classifyInstall, countBackups, createSetupState } from '../lib/host/state.js';
import { buildPatchedRegion } from '../lib/asar/patch-body.js';
import { REGION_LENGTH, REGION_START_MARKER, REGION_END_MARKER } from '../lib/wire/constants.js';

/** sha256 of a buffer, lowercase hex. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * A stock-style region: every anchor classify() requires, padded to the frozen
 * length so the byte geometry stays honest.
 * @returns {string}
 */
function stockRegionText() {
  const anchors = [
    REGION_START_MARKER,
    'var DesktopTray = class',
    'new Tray(nativeImage.createFromPath(options.iconPath))',
    'tray.on("click", () => {',
    'setContextMenu(Menu.buildFromTemplate([',
    'tray?.destroy();',
  ];
  // Padding goes BEFORE the end marker so the region ends with `//#endregion`
  // (the locator takes the first end marker after the start marker).
  const head = anchors.join('\n\t');
  const tail = `\n${REGION_END_MARKER}`;
  const padding = REGION_LENGTH - head.length - tail.length;
  assert.equal(padding > 0, true, 'fixture must leave room for the end marker');
  return head + ' '.repeat(padding) + tail;
}

/**
 * Build `lib/main.js` with one region of exactly REGION_LENGTH bytes.
 * @param {string} [regionText]
 * @returns {string}
 */
function mainSource(regionText = stockRegionText()) {
  const region = regionText.slice(0, REGION_LENGTH).padEnd(REGION_LENGTH, ' ');
  const prefix = '//#region lib/app.js\nexport const app = 1;\n//#endregion\n';
  const suffix = '\n//#region lib/next.js\nexport const next = 2;\n//#endregion\n';
  return prefix + region + suffix;
}

/**
 * Build a structurally valid asar around one package.json and one lib/main.js.
 *
 * Layout: 16-byte pickle preamble, JSON directory padded to 4 bytes, then the
 * data area (package.json first, lib/main.js second).
 *
 * @param {{ mainSource: string, pkgSource?: string }} input
 * @returns {Buffer}
 */
function buildAsar(input) {
  const pkg = Buffer.from(input.pkgSource ?? JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.2-rc.2' }), 'utf8');
  const main = Buffer.from(input.mainSource, 'utf8');

  const pkgPadded = pkg.length + ((4 - (pkg.length % 4)) % 4);
  const entries = {
    files: {
      'package.json': {
        size: pkg.length,
        offset: '0',
        integrity: { algorithm: 'SHA256', hash: sha256(pkg), blockSize: 4194304, blocks: [sha256(pkg)] },
      },
      lib: {
        files: {
          'main.js': {
            size: main.length,
            offset: String(pkgPadded),
            integrity: { algorithm: 'SHA256', hash: sha256(main), blockSize: 4194304, blocks: [sha256(main)] },
          },
        },
      },
    },
  };

  const headerJson = Buffer.from(JSON.stringify(entries), 'utf8');
  const headerPadded = headerJson.length + ((4 - (headerJson.length % 4)) % 4);

  // Pickle preamble: [4][headerLen + 4][headerLen][dataLen]; the reader rounds
  // the raw header length up to a 4-byte boundary itself, exactly like Electron.
  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(headerJson.length + 4, 4);
  preamble.writeUInt32LE(headerJson.length, 8);
  preamble.writeUInt32LE(headerJson.length, 12);

  const header = Buffer.concat([headerJson, Buffer.alloc(headerPadded - headerJson.length, 0)]);
  const payload = Buffer.concat([pkg, Buffer.alloc(pkgPadded - pkg.length, 0), main]);
  return Buffer.concat([preamble, header, payload]);
}

/**
 * Write `<dir>/resources/app.asar` (plus the optional bridge and backups).
 *
 * @param {string} dir
 * @param {{ mainSource: string, pkgSource?: string, bridge?: boolean, backup?: string, backups?: number }} input
 * @returns {{ root: string, asarPath: string, bridgePath: string }}
 */
function writeInstallRoot(dir, input) {
  const resources = path.join(dir, 'resources');
  mkdirSync(resources, { recursive: true });
  const asarPath = path.join(resources, 'app.asar');
  writeFileSync(asarPath, buildAsar(input));

  const bridgePath = path.join(resources, 'app.asar.unpacked', 'dsh', 'tray-bridge.js');
  if (input.bridge === true) {
    mkdirSync(path.dirname(bridgePath), { recursive: true });
    writeFileSync(bridgePath, 'module.exports = {};\n', 'utf8');
  }
  if (typeof input.backup === 'string') {
    writeFileSync(path.join(resources, 'app.asar.20260101-0000.v0.2.2-rc.2.bak'), input.backup);
  }
  // `backups` is this file's addition: an upgrade test needs zero, one *and*
  // several backups, and the count is what the rule actually reads.
  const backups = typeof input.backups === 'number' ? input.backups : 0;
  for (let index = 0; index < backups; index += 1) {
    writeFileSync(
      path.join(resources, `app.asar.20260101-000${index}.v0.2.2-rc.2.bak`),
      `backup ${index}`,
      'utf8',
    );
  }
  return { root: dir, asarPath, bridgePath };
}

/**
 * Write the install record the plugin itself writes after a successful apply.
 *
 * @param {string} stateDir
 * @param {object} record
 */
function writeRecordFixture(stateDir, record) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'install.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** Run a body inside a temp directory that is always removed. */
async function withScratch(body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-upgrade-detect-'));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A record shaped like the one this plugin writes, pointing at a given size. */
function recordOf(asarPath, installRoot, fileSize) {
  const record = { schema: 2, installed: true, installRoot, asarPath };
  if (typeof fileSize === 'number') record.fileSize = fileSize;
  return record;
}

test('record + bridge + a backup: the install still stands and nothing prompts', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    const stateDir = path.join(dir, 'state');
    const written = writeInstallRoot(installRoot, {
      mainSource: mainSource(buildPatchedRegion(REGION_LENGTH).toString('utf8')),
      bridge: true,
      backups: 1,
    });
    writeRecordFixture(stateDir, recordOf(
      written.asarPath,
      installRoot,
      statSync(written.asarPath).size,
    ));
    const state = createSetupState({ stateDir });
    const snapshot = await state.refresh({ root: installRoot });
    assert.equal(snapshot.state, 'patched-by-us');
    assert.equal(snapshot.installState, 'installed', 'nothing is missing, so nothing is spent');
    assert.equal(snapshot.upgraded, false);
    assert.equal(snapshot.required, false, 'a complete install must not prompt');
    assert.equal(snapshot.lastError, null, 'a healthy install reports no error');
  }));

test('record but bridge and backups are gone: spent, and the page is forced back', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    const stateDir = path.join(dir, 'state');
    const written = writeInstallRoot(installRoot, { mainSource: mainSource() });
    writeRecordFixture(stateDir, recordOf(
      written.asarPath,
      installRoot,
      statSync(written.asarPath).size,
    ));
    const state = createSetupState({ stateDir });
    const snapshot = await state.refresh({ root: installRoot });
    // The vendor upgrade leaves a pristine archive behind: stock, not ours.
    assert.equal(snapshot.state, 'stock');
    assert.equal(snapshot.bridge.present, false);
    assert.equal(snapshot.installState, 'spent');
    assert.equal(snapshot.upgraded, true);
    assert.equal(snapshot.required, true, 'a spent install must always ask again');
    assert.equal(snapshot.lastError.code, 'ESTATE_UPGRADED');
    assert.equal(typeof snapshot.lastError.message, 'string');
    assert.equal(snapshot.lastError.message.includes('重新安装'), true);
  }));

test('record whose size no longer matches, backups gone: also spent (even with the bridge present)', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    const stateDir = path.join(dir, 'state');
    const written = writeInstallRoot(installRoot, {
      mainSource: mainSource(buildPatchedRegion(REGION_LENGTH).toString('utf8')),
      bridge: true,
      backups: 0,
    });
    const actualSize = statSync(written.asarPath).size;
    writeRecordFixture(stateDir, recordOf(written.asarPath, installRoot, actualSize - 1000));
    const state = createSetupState({ stateDir });
    const snapshot = await state.refresh({ root: installRoot });
    assert.equal(snapshot.installState, 'spent', 'a stale size plus no backup means the record is spent');
    assert.equal(snapshot.upgraded, true);
    // The explicit spent rule outranks "patched-by-us + bridge => installed".
    assert.equal(snapshot.required, true);
    assert.equal(snapshot.lastError.code, 'ESTATE_UPGRADED');
  }));

test('no install.json at all: never-installed', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    const stateDir = path.join(dir, 'state');
    writeInstallRoot(installRoot, { mainSource: mainSource() });
    const state = createSetupState({ stateDir });
    const snapshot = await state.refresh({ root: installRoot });
    assert.equal(snapshot.state, 'stock');
    assert.equal(snapshot.installRecord, null);
    assert.equal(snapshot.installState, 'never-installed');
    assert.equal(snapshot.upgraded, false);
    assert.equal(snapshot.required, true);
    assert.equal(snapshot.lastError, null, 'never-installed is not an error, just a fresh install');
  }));

test('a record with no size field is not read as "the size changed"', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    const stateDir = path.join(dir, 'state');
    // Bridge present, no backup beside it: the old record simply predates the
    // size field, which must NOT be mistaken for a spent install.
    const written = writeInstallRoot(installRoot, {
      mainSource: mainSource(buildPatchedRegion(REGION_LENGTH).toString('utf8')),
      bridge: true,
      backups: 0,
    });
    writeRecordFixture(stateDir, recordOf(written.asarPath, installRoot));
    const state = createSetupState({ stateDir });
    const snapshot = await state.refresh({ root: installRoot });
    assert.equal(snapshot.state, 'patched-by-us');
    assert.equal(snapshot.installState, 'installed', 'a missing size means "unknown", never "differs"');
    assert.equal(snapshot.upgraded, false);
    assert.equal(snapshot.required, false);
    assert.equal(snapshot.lastError, null);
  }));

test('classifyInstall follows the rule on its own, without any disk', () => {
  const record = { schema: 2, installed: true, fileSize: 1000 };
  assert.equal(classifyInstall({ record: null, bridgePresent: true, backupCount: 1, archiveSize: 1000 }), 'never-installed');
  assert.equal(classifyInstall({ record: { installed: false }, bridgePresent: true, backupCount: 1, archiveSize: 1000 }), 'never-installed');
  assert.equal(classifyInstall({ record, bridgePresent: true, backupCount: 1, archiveSize: 1000 }), 'installed');
  assert.equal(classifyInstall({ record, bridgePresent: false, backupCount: 0, archiveSize: 1000 }), 'spent');
  assert.equal(classifyInstall({ record, bridgePresent: true, backupCount: 0, archiveSize: 1000 }), 'installed',
    'a missing backup alone is not proof of an upgrade');
  assert.equal(classifyInstall({ record, bridgePresent: true, backupCount: 1, archiveSize: 2000 }), 'installed',
    'a size change alone is not proof of an upgrade either');
  assert.equal(classifyInstall({ record, bridgePresent: false, backupCount: 1, archiveSize: 1000 }), 'installed');
  assert.equal(classifyInstall({ record: { installed: true }, bridgePresent: false, backupCount: 0, archiveSize: 1000 }), 'spent',
    'no size in the record still classifies spent through the bridge-and-backup rule');
  assert.equal(classifyInstall({ record: { installed: true }, bridgePresent: true, backupCount: 0, archiveSize: 1000 }), 'installed',
    'no size in the record must not be read as sizeDiffers');
  // A malformed/odd input degrades rather than throws.
  assert.equal(classifyInstall({ record: { installed: true, asarSize: 1000 }, bridgePresent: false, backupCount: 0, archiveSize: 1000 }), 'spent');
});

test('countBackups counts every *.bak beside the archive and ignores everything else', () =>
  withScratch(async (dir) => {
    const written = writeInstallRoot(dir, { mainSource: mainSource(), backups: 3 });
    const resources = path.dirname(written.asarPath);
    // Neighbours a real install root has, none of which is a backup.
    writeFileSync(path.join(resources, 'app-update.yml'), 'x', 'utf8');
    writeFileSync(path.join(resources, 'default_app.asar'), 'x', 'utf8');
    // `app.asar.bak` (no prefix segment) is a genuinely different file name,
    // not one of our dated backups, so it must not be counted either.
    writeFileSync(path.join(resources, 'old.bak'), 'x', 'utf8');
    assert.equal(countBackups(written.asarPath), 3);
    assert.equal(readdirSync(resources).filter((name) => name.endsWith('.bak')).length, 4,
      'the fixture really holds four .bak files, only three of which match app.asar.*');
    assert.equal(countBackups(null), 0);
    assert.equal(countBackups(path.join(dir, 'nope', 'app.asar')), 0, 'an unreadable directory counts as zero');
  }));
