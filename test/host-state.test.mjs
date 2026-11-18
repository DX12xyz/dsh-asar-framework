/**
 * Host setup-state tests.
 *
 * A tiny synthetic asar (pickle header + JSON directory + data area) is written
 * to a throwaway directory and handed to the state holder. Nothing here touches
 * the real DSH install directory.
 *
 * `node --test --test-isolation=none test/host-state.test.mjs`
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from '../lib/fs-safe.js';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createSetupState } from '../lib/host/state.js';
import { buildPatchedRegion, buildSplitRegion } from '../lib/asar/patch-body.js';
import {
  REGION_LENGTH,
  REGION_RESERVE_BYTES,
  REGION_START_MARKER,
  REGION_END_MARKER,
  SPLIT_START_MARKER,
} from '../lib/wire/constants.js';

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
 * Write `<dir>/resources/app.asar` (plus the optional bridge and backup).
 *
 * @param {string} dir
 * @param {{ mainSource: string, pkgSource?: string, bridge?: boolean, backup?: string }} input
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
  return { root: dir, asarPath, bridgePath };
}

/**
 * Build `lib/main.js` for the split layout: the OFFICIAL slot kept byte-for-byte
 * pristine, then OUR region of `splitRegionText`, then the rest.
 *
 * @param {string} splitRegionText exact bytes of our region
 * @returns {string}
 */
function splitMainSource(splitRegionText) {
  const official = stockRegionText();
  assert.equal(official.length, REGION_LENGTH, 'the official slot fixture must be exactly REGION_LENGTH');
  const prefix = '//#region lib/app.js\nexport const app = 1;\n//#endregion\n';
  const suffix = '\n//#region lib/next.js\nexport const next = 2;\n//#endregion\n';
  return prefix + official + splitRegionText + suffix;
}

/**
 * A split region of exactly `length` bytes whose bytes are NOT what this build
 * writes — the shape an older build left behind (a smaller reserve, older body).
 *
 * `buildSplitRegion(8192)` cannot even be called (today's body needs more than
 * that), which is itself the proof that an 8 KiB region is stale; the locator
 * however only needs the two markers, so a fabricated region is enough to
 * reproduce the state the human is looking at.
 *
 * @param {number} length
 * @returns {string}
 */
function staleSplitRegionText(length) {
  const head = `\n${SPLIT_START_MARKER}\n/* dsh-asar-bridge-slot v0.2.0 */`;
  const tail = `\n${REGION_END_MARKER}`;
  const padding = length - head.length - tail.length;
  assert.equal(padding > 0, true, 'stale fixture must leave room for the end marker');
  return head + ' '.repeat(padding) + tail;
}

/**
 * Run a body inside a temp directory that is always removed.
 */
async function withScratch(body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-host-state-'));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a stock asar without a bridge asks for the install page', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    const stateDir = path.join(dir, 'state');
    writeInstallRoot(installRoot, { mainSource: mainSource() });
    const state = createSetupState({ stateDir });
    const snapshot = await state.refresh({ root: installRoot });
    assert.equal(snapshot.state, 'stock', 'synthetic stock must classify as stock');
    assert.equal(snapshot.required, true, 'a stock archive with no bridge must prompt');
    assert.equal(snapshot.suppressed, false);
    assert.equal(snapshot.dshVersion, '0.2.2-rc.2');
    assert.equal(snapshot.bridge.present, false);
  }));

test('a patched asar with the bridge installed needs no prompt', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    const stateDir = path.join(dir, 'state');
    writeInstallRoot(installRoot, {
      mainSource: mainSource(buildPatchedRegion(REGION_LENGTH).toString('utf8')),
      bridge: true,
    });
    const state = createSetupState({ stateDir });
    const snapshot = await state.refresh({ root: installRoot });
    assert.equal(snapshot.state, 'patched-by-us');
    assert.equal(snapshot.bridge.present, true);
    assert.equal(snapshot.required, false, 'a complete install must not prompt');
  }));

test('a foreign region still asks for the page but is never auto-written', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    const stateDir = path.join(dir, 'state');
    const foreignMarker = '/* dsh-tray-restart */';
    const head = `${REGION_START_MARKER}\n${foreignMarker}\n`;
    const tail = `\n${REGION_END_MARKER}`;
    const filler = 'x'.repeat(REGION_LENGTH - head.length - tail.length);
    const foreign = `${head}${filler}${tail}`;
    assert.equal(foreign.length, REGION_LENGTH, 'foreign fixture must be exactly one region long');
    writeInstallRoot(installRoot, { mainSource: mainSource(foreign) });
    const state = createSetupState({ stateDir });
    const snapshot = await state.refresh({ root: installRoot });
    assert.equal(snapshot.state, 'foreign');
    assert.equal(snapshot.required, true);
    assert.equal(statSync(path.join(installRoot, 'resources', 'app.asar')).isFile(), true);
  }));

test('suppress() hides the page for this run only', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    const stateDir = path.join(dir, 'state');
    writeInstallRoot(installRoot, { mainSource: mainSource() });
    const state = createSetupState({ stateDir });
    await state.refresh({ root: installRoot });
    state.suppress('dismissed');
    assert.equal(state.snapshot().suppressed, true);
    assert.equal(state.snapshot().required, false);
    state.unsuppress();
    assert.equal(state.snapshot().required, true, 'unsuppress brings the page back');
  }));

test('markRestored() records the flow and suppresses this run', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    const stateDir = path.join(dir, 'state');
    writeInstallRoot(installRoot, { mainSource: mainSource() });
    const state = createSetupState({ stateDir });
    await state.refresh({ root: installRoot });
    state.markRestored('restored');
    assert.equal(state.snapshot().required, false);
    const flow = JSON.parse(readFileSync(path.join(stateDir, 'uninstall-flow.json'), 'utf8'));
    assert.equal(flow.phase, 'restored');
    assert.equal(typeof flow.at, 'string');
  }));

test('a missing install root degrades to "required" without throwing', () =>
  withScratch(async (dir) => {
    const state = createSetupState({ stateDir: path.join(dir, 'state') });
    const snapshot = await state.refresh({ root: path.join(dir, 'nope') });
    assert.equal(snapshot.state, 'missing');
    assert.equal(snapshot.required, true);
    assert.equal(typeof snapshot.lastError.code, 'string');
  }));

test('the backup found next to the asar is reported by name', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    writeInstallRoot(installRoot, { mainSource: mainSource(), backup: 'backup bytes' });
    const state = createSetupState({ stateDir: path.join(dir, 'state') });
    const snapshot = await state.refresh({ root: installRoot });
    assert.equal(snapshot.backup.name.startsWith('app.asar.'), true);
    assert.equal(snapshot.backup.name.endsWith('.bak'), true);
    assert.equal(snapshot.backup.size > 0, true);
  }));

// ---------------------------------------------------------------- 0.4.0 fields --
// The settings card is driven by three facts that must reach the client instead
// of being re-derived or hardcoded there: which layout is on disk (`layout`),
// how long our installed region is (`splitRegion.length`), whether that region
// is the one THIS build writes (`regionMatchesBuild`), and what this build would
// write (`buildRegion.length`). The card's reinstall button and its "old build"
// warning are exactly these fields — so they are asserted on a refresh(), which
// is the same object `/state` returns.

/**
 * Read `client.js` and split it into the two built-in dictionaries.
 *
 * The client half cannot be imported here: `client.js` is a browser module
 * (`window.__ModuleLoader__.load({ … })`) and there is no DOM in a `node --test`
 * run. The dictionaries are plain object literals inside that file, so this is
 * a source-level check — cheap, and enough to catch the one failure that would
 * be visible to a human: a label the card renders in one language and blanks in
 * the other.
 *
 * @returns {{ source: string, zh: string, en: string }}
 */
function readClientDictionaries() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const zhAt = source.indexOf('const ZHDICT = {');
  const enAt = source.indexOf('const ENDICT = {');
  assert.equal(zhAt >= 0, true, 'client.js must still contain a ZHDICT literal');
  assert.equal(enAt > zhAt, true, 'client.js must still contain an ENDICT literal after ZHDICT');
  const zh = source.slice(zhAt, enAt);
  const en = source.slice(enAt, source.indexOf('\n    };', enAt));
  assert.equal(en.length > 0, true, 'ENDICT must have a closing brace');
  return { source, zh, en };
}

/** `true` when one dictionary literal defines `key`. */
function dictHasKey(dictionaryText, key) {
  return dictionaryText.includes(`'${key}':`);
}

test('a split snapshot exposes splitRegion, regionMatchesBuild and buildRegion', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    const stateDir = path.join(dir, 'state');
    // A region of exactly the CURRENT reserve and exactly the bytes this build
    // writes: the healthy install the card must NOT warn about.
    const region = buildSplitRegion(REGION_RESERVE_BYTES).toString('utf8');
    writeInstallRoot(installRoot, { mainSource: splitMainSource(region), bridge: true });
    const state = createSetupState({ stateDir });
    const snapshot = await state.refresh({ root: installRoot });

    assert.equal(snapshot.layout, 'split', 'the inserted region must classify as the split layout');
    assert.equal(snapshot.state, 'patched-by-us');
    assert.equal(snapshot.required, false, 'a healthy complete install must not prompt');
    assert.equal(snapshot.regionMatchesBuild, true, 'the region is exactly what this build writes');
    assert.equal(Number.isInteger(snapshot.splitRegion.length), true);
    assert.equal(snapshot.splitRegion.length, REGION_RESERVE_BYTES, 'installed region length');
    assert.equal(typeof snapshot.splitRegion.sha256, 'string');
    assert.equal(snapshot.splitRegion.sha256.length, 64);
    // The build's own reserve, so the client can print both numbers without
    // repeating 16,384.
    assert.equal(typeof snapshot.buildRegion, 'object');
    assert.equal(snapshot.buildRegion.length, REGION_RESERVE_BYTES);
  }));

test('a stale-length region yields regionMatchesBuild === false (the reinstall case)', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    const stateDir = path.join(dir, 'state');
    // The live situation: the archive holds an 8 KiB region from an older build
    // while this build writes REGION_RESERVE_BYTES. The install is COMPLETE
    // (`required === false`), which is why 「重新打开安装页」 did nothing for the
    // human — only a reinstall can fix it.
    const staleLength = 8192;
    assert.equal(staleLength < REGION_RESERVE_BYTES, true, 'fixture must be an older, smaller reserve');
    writeInstallRoot(installRoot, {
      mainSource: splitMainSource(staleSplitRegionText(staleLength)),
      bridge: true,
    });
    const state = createSetupState({ stateDir });
    const snapshot = await state.refresh({ root: installRoot });

    assert.equal(snapshot.layout, 'split');
    assert.equal(snapshot.splitRegion.length, staleLength, 'the installed length is reported as measured');
    assert.equal(snapshot.regionMatchesBuild, false, 'an older reserved length is never "this build"');
    assert.equal(snapshot.buildRegion.length, REGION_RESERVE_BYTES, 'the client can print both numbers');
    // The consequence the card relies on: no prompt, so clearing suppression is
    // a no-op and the reinstall button is the only working path.
    assert.equal(snapshot.required, false, 'a complete install does not ask for the install page');
  }));

test('regionMatchesBuild is null when there is no region to compare', () =>
  withScratch(async (dir) => {
    const installRoot = path.join(dir, 'DSH');
    const stateDir = path.join(dir, 'state');
    writeInstallRoot(installRoot, { mainSource: mainSource() });
    const state = createSetupState({ stateDir });
    const snapshot = await state.refresh({ root: installRoot });
    assert.equal(snapshot.layout, 'pristine');
    assert.equal(snapshot.splitRegion, null, '"no region" must never look like "a stale region"');
    assert.equal(snapshot.regionMatchesBuild, null);
    // The build's reserve is reported even here: it is a property of the build,
    // not of the install.
    assert.equal(snapshot.buildRegion.length, REGION_RESERVE_BYTES);
    // snapshotNow() before any refresh must carry the same shape, because the
    // card polls /state and has to be robust to an early/empty reply.
    const fresh = createSetupState({ stateDir }).snapshot();
    assert.equal(fresh.splitRegion, null);
    assert.equal(fresh.regionMatchesBuild, null);
    assert.equal(fresh.buildRegion.length, REGION_RESERVE_BYTES);
  }));

// ------------------------------------------------------- settings-card labels --
// The settings card pulls every string through `t()`, which falls back to the
// zh dictionary and then to the KEY ITSELF. A key that exists in only one
// dictionary therefore renders either Chinese text inside an English card or a
// raw `settings.reinstall` label — both are user-visible defects, and neither is
// catchable without a DOM. So the source is read directly.

test('both dictionaries define every key the settings card uses', () => {
  const { zh, en } = readClientDictionaries();
  // The keys this card is built around. They are listed by name (not derived
  // from the file) so that a rename in client.js fails this test instead of
  // silently passing with a stale list.
  const cardKeys = [
    'settings.reinstall',
    'settings.reinstalling',
    'settings.reinstallOk',
    'settings.reinstallFailed',
    'settings.reinstallNoRoot',
    'settings.regionStale',
    'settings.regionStaleSame',
    'settings.reopenHint',
    // The three existing actions the card must keep working alongside it.
    'setup.reopen',
    'uninstall.button',
    'settings.state',
  ];
  for (const key of cardKeys) {
    assert.equal(dictHasKey(zh, key), true, `zh dictionary is missing ${key}`);
    assert.equal(dictHasKey(en, key), true, `en dictionary is missing ${key}`);
  }
  // Placeholders are part of the contract: a message rendered with `t(key, {…})`
  // whose template lacks the placeholder silently drops the number the human
  // needs (which size is installed, which size this build writes).
   // The same template the card renders with `t(key, {installed, current})`.
   const zhStale = zh.slice(zh.indexOf("'settings.regionStale':"));
   assert.equal(zhStale.includes('{installed}'), true, 'zh regionStale must print the installed length');
   assert.equal(zhStale.includes('{current}'), true, 'zh regionStale must print the build length');
   const enStale = en.slice(en.indexOf("'settings.regionStale':"));
   assert.equal(enStale.includes('{installed}'), true, 'en regionStale must print the installed length');
   assert.equal(enStale.includes('{current}'), true, 'en regionStale must print the build length');
});

test('locale/*.json carries the same settings-card keys as the built-in tables', () => {
  // The JSON files are a SECOND copy of the same vocabulary (they ship in the
  // package's `exports` map and are read by tooling outside the bundle). Two
  // copies drift, and the browser bundle is the one a human sees, so the JSON is
  // asserted against the keys the card uses rather than the other way round.
  const here = new URL('../locale/', import.meta.url);
  const locales = {
    zh: JSON.parse(readFileSync(new URL('zh.json', here), 'utf8')),
    en: JSON.parse(readFileSync(new URL('en.json', here), 'utf8')),
  };
  const cardKeys = [
    'reinstall', 'reinstalling', 'reinstallOk', 'reinstallFailed',
    'reinstallNoRoot', 'regionStale', 'regionStaleSame', 'reopenHint',
  ];
  for (const [language, table] of Object.entries(locales)) {
    assert.equal(typeof table.settings, 'object', `${language}.json must have a settings section`);
    for (const key of cardKeys) {
      assert.equal(typeof table.settings[key], 'string', `${language}.json settings.${key} must be a string`);
      assert.equal(table.settings[key].length > 0, true, `${language}.json settings.${key} must not be empty`);
    }
    assert.equal(table.settings.regionStale.includes('{installed}'), true);
    assert.equal(table.settings.regionStale.includes('{current}'), true);
  }
});

test('the card never hardcodes the reserve size it should read from the snapshot', () => {
  const { source } = readClientDictionaries();
  // `buildRegion.length` is the whole reason the field exists: a client that
  // repeated `16384` would print the WRONG "current" number on the next build
  // that changes the reserve, which is exactly how the 8 KiB/16 KiB mismatch
  // became invisible in the first place.
  assert.equal(/16384|16,384/.test(source), false, 'client.js must not hardcode REGION_RESERVE_BYTES');
  assert.equal(source.includes('snapshot.buildRegion'), true, 'the card must read buildRegion from the snapshot');
});
