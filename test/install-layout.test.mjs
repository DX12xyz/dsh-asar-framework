/**
 * Layout wiring tests: the installer CLI must pick the RIGHT branch for each
 * (state, layout) pair, and the archive on disk must prove it afterwards.
 *
 * The three layouts (see `lib/asar/classify.js`):
 *
 *   pristine  the official tray slot is untouched          -> install the 0.2.0 split region
 *   in-slot   our 0.1.x patch REPLACED the official slot   -> restore official bytes, then split
 *   split     our region sits AFTER a pristine official slot -> refresh in place, zero movement
 *
 * What makes this suite different from `split-surgery.test.mjs` (which proves the
 * surgery layer): every case here drives `scripts/install.mjs`'s exported
 * `main(argv)` end to end and then RE-OPENS the archive from disk to assert what
 * was actually written. A body that says `layout:'split'` while the bytes say
 * otherwise is exactly the failure this file exists to catch.
 *
 * Every case starts from a copy of the official baseline beside the installation:
 *
 *   <install root>\resources\app.asar.<stamp>.v0.2.2-rc.3.bak
 *
 * verified by digest before a single byte is written; the suite SKIPS (never
 * fails) when the baseline is absent or is not that release. `DSH_HOME` is
 * pointed at a throwaway directory, so the real state directory is never touched,
 * and nothing outside `scratch/test-copies/` is written.
 *
 * Why the CLI is called in-process: this sandbox denies a child process the pipe
 * it would need to hand stdout back (spawn EPERM), and `install.mjs` exports
 * `main(argv)` for exactly this (its `isEntryPoint()` guard keeps it from running
 * on import).
 *
 * Run: node --test --test-isolation=none test/install-layout.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RESOURCES_DIR } from './desktop-root.mjs';

import { main as runCliMain } from '../scripts/install.mjs';
import {
  FOREIGN_MARKERS,
  REGION_LENGTH,
  REGION_RESERVE_BYTES,
} from '../lib/wire/constants.js';
import { buildPatchedRegion, buildSplitRegion } from '../lib/asar/patch-body.js';
import { sha256Buffer, sha256File } from '../lib/asar/hash.js';
import { classifyAsar } from '../lib/asar/classify.js';
import { closeAsar, openAsar } from '../lib/asar/reader.js';
import { findSplitRegion, growRegion, planSplitFile } from '../lib/asar/split.js';
import { applyAppend, closeForPlan, openForPlan, planAppend } from '../lib/asar/edit.js';
import { locateRegion, writeRegion } from '../lib/asar/region.js';

/**
 * Where this machine keeps its official baseline(s).
 *
 * Deliberately a DIRECTORY, not a file name: every install writes its backup with
 * a timestamp in the name, so a fixture that pinned one specific stamp went stale
 * the first time the machine installed again (that is exactly what happened —
 * `…20261114-2125….bak` was replaced by `…20261115-1529….bak`). The baseline is
 * identified by its DIGEST, which is the thing that actually matters.
 */
const BASELINE_DIR = RESOURCES_DIR;

/** Digest of the rc.3 official archive; a copy that does not hash to this is not a fixture. */
const STOCK_ARCHIVE_SHA = '14cfd81c9135bf0afb89417543c94f9ecfe09266574452a9b106890c698725ae';
/** Digest of the OFFICIAL 1,253-byte tray slot inside it. */
const STOCK_SLOT_SHA = '4bc10e1ee26b0961f14ea9357bbb0c72f669a9ccf1f8c07c911cf55e4a15ce64';
/** The released archive's exact size (209,021,953 bytes). */
const STOCK_ARCHIVE_SIZE = 209021953;
/**
 * Digest of `buildSplitRegion(REGION_RESERVE_BYTES)` for the body this package ships.
 *
 * DERIVED, never written down: this fixture used to be a hard-coded digest, and
 * a hard-coded digest is a second source of truth that goes stale the moment the
 * region body changes — which is exactly what happened when the IPC guard block
 * was appended to it.
 */
const SPLIT_REGION_SHA = sha256Buffer(buildSplitRegion(REGION_RESERVE_BYTES));

/** Scratch root, shared with the other write-path tests. */
const COPY_DIR = fileURLToPath(new URL('../../scratch/test-copies/', import.meta.url));
/** One directory per test process, removed in `after()`. */
const ROOT = join(COPY_DIR, `install-layout-${process.pid}`);

/**
 * `node:test` skip value for the whole file: `false` when a verified official
 * baseline exists, otherwise the human-readable reason.
 *
 * Hashed once at module load. A machine without that baseline is a normal
 * machine, not a defect — copying "some archive" and calling it stock would make
 * every assertion below worthless.
 *
 * Resolved by DIGEST across every `app.asar.*.bak` beside the install, because a
 * baseline's file name carries a timestamp that changes on every install.
 */
const BASELINE_FOUND = await (async () => {
  let names;
  try {
    names = readdirSync(BASELINE_DIR).filter((name) => name.startsWith('app.asar.') && name.endsWith('.bak'));
  } catch {
    return { path: null, reason: `读不到安装目录 ${BASELINE_DIR}` };
  }
  if (names.length === 0) {
    return { path: null, reason: `需要一份校验通过的官方原样备份（${join(BASELINE_DIR, 'app.asar.*.bak')}）才能驱动安装器` };
  }
  const tried = [];
  for (const name of names) {
    const candidate = join(BASELINE_DIR, name);
    let digest;
    try {
      digest = await sha256File(candidate);
    } catch {
      tried.push(`${name}: 读不到`);
      continue;
    }
    if (digest === STOCK_ARCHIVE_SHA) return { path: candidate, reason: false };
    tried.push(`${name}: ${digest.slice(0, 16)}…`);
  }
  return { path: null, reason: `旁边的备份都不是登记的 rc.3 官方档（检查过 ${tried.join('、')}）` };
})();

/** Absorbed into every test's skip argument; `false` means "run". */
const BASELINE = BASELINE_FOUND.path;
const SKIP = BASELINE_FOUND.reason;

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/* --------------------------------------------------------------- fixtures -- */

/**
 * Build one isolated case: `cases/<name>/DSH/resources/app.asar` from the official
 * baseline, plus a throwaway `DSH_HOME`.
 *
 * @param {string} name case directory name
 * @returns {{ run: string, resources: string, asarPath: string, bridgePath: string, home: string, stateDir: string }}
 */
function makeCase(name) {
  const run = join(ROOT, name, 'DSH');
  const home = join(ROOT, name, 'home');
  const resources = join(run, 'resources');
  mkdirSync(resources, { recursive: true });
  mkdirSync(home, { recursive: true });
  const asarPath = join(resources, 'app.asar');
  copyFileSync(BASELINE, asarPath);
  return {
    run,
    home,
    resources,
    asarPath,
    bridgePath: join(resources, 'app.asar.unpacked', 'dsh', 'tray-bridge.js'),
    stateDir: join(home, 'dsh-asar-framework'),
  };
}

/**
 * Run one CLI mode in-process against a case's install root.
 *
 * `DSH_HOME` is set for the duration of the call: the CLI resolves its state
 * directory from the environment at call time, and it must never read or write
 * this machine's real one.
 *
 * Accepts flags as separate arguments (the historical `cli(fixture, '--apply')`
 * shape used by every layout case) or as one array, which is how the edit cases
 * name their `--append` / `--content` arguments without a long argument list.
 *
 * @param {{ run: string, home: string }} fixture
 * @param {string|string[]} rest one mode string, or a flag list
 * @returns {Promise<{ exitCode: number, body: object }>}
 */
async function cli(fixture, ...rest) {
  const flags = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = fixture.home;
  try {
    const outcome = await runCliMain(['node', 'install.mjs', ...flags, '--json', '--root', fixture.run]);
    return { exitCode: outcome.exitCode, body: outcome.body };
  } finally {
    if (typeof saved === 'string') process.env.DSH_HOME = saved;
    else delete process.env.DSH_HOME;
  }
}

/** `app.asar` size in bytes. */
function sizeOf(path) {
  return statSync(path).size;
}

/** Backups sitting beside the fixture archive (the names only). */
function backupsOf(resources) {
  try {
    return readdirSync(resources)
      .filter((name) => name.startsWith('app.asar.') && name.endsWith('.bak'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read the archive from disk and report everything the assertions need.
 *
 * This is the point of the whole file: it does not trust the CLI's body. It
 * re-opens the file and asks the two independent detectors what is really there.
 *
 * @param {string} asarPath
 * @returns {{
 *   state: string, layout: string, doubleInstall: boolean,
 *   officialSlotSha: string|null, splitRegionSha: string|null,
 *   splitStartInMain: number|null, splitLength: number|null, mainSize: number|null,
 * }}
 */
function diskFacts(asarPath) {
  const opened = openAsar(asarPath, { allowStaleMainIntegrity: true });
  assert.equal(opened.ok, true, opened.ok === true ? '' : `${opened.code}: ${opened.message}`);
  try {
    const classification = classifyAsar(opened);
    const slot = locateRegion(opened);
    const split = findSplitRegion(opened);
    const main = opened.entries.get('lib/main.js') ?? null;
    return {
      state: classification.state,
      layout: classification.layout,
      doubleInstall: classification.doubleInstall === true,
      officialSlotSha: slot.ok === true ? slot.sha256 : null,
      splitRegionSha: split.ok === true ? split.sha256 : null,
      splitStartInMain: split.ok === true ? split.startInMain : null,
      splitLength: split.ok === true ? split.length : null,
      mainSize: main === null ? null : Number(main.size),
    };
  } finally {
    closeAsar(opened);
  }
}

/**
 * Overwrite the OFFICIAL slot with the 0.1.x patch body, producing an `in-slot`
 * archive by hand (this is the state a 0.1.x install left behind).
 *
 * @param {string} asarPath
 * @returns {number} absolute offset that was written
 */
function handPatchSlot(asarPath) {
  const opened = openAsar(asarPath, { allowStaleMainIntegrity: true });
  assert.equal(opened.ok, true);
  let located;
  try {
    located = locateRegion(opened);
  } finally {
    closeAsar(opened);
  }
  assert.equal(located.ok, true, located.ok === true ? '' : `${located.code}: ${located.message}`);
  const written = writeRegion(asarPath, located.absoluteOffset, buildPatchedRegion(located.length));
  assert.equal(written.ok, true, written.ok === true ? '' : `${written.code}: ${written.message}`);
  return located.absoluteOffset;
}

/**
 * Splice a third-party marker INTO the official slot without changing its
 * length or its two region markers.
 *
 * The marker goes immediately before the closing `//#endregion`, so `locateRegion`
 * still resolves the slot and `classifyAsar` sees a foreign marker — which is
 * checked BEFORE the anchor rules, so damaging nothing else matters.
 *
 * @param {string} asarPath
 */
function handForeignSlot(asarPath) {
  const opened = openAsar(asarPath, { allowStaleMainIntegrity: true });
  assert.equal(opened.ok, true);
  let located;
  try {
    located = locateRegion(opened);
  } finally {
    closeAsar(opened);
  }
  assert.equal(located.ok, true);
  const slot = Buffer.from(located.stockBytes);
  const marker = Buffer.from(FOREIGN_MARKERS[0], 'utf8');
  const endMarker = '//#endregion';
  const at = slot.indexOf(Buffer.from(endMarker, 'utf8'), 0);
  assert.equal(at >= 0, true, 'the fixture slot must carry the official end marker');
  const start = at - marker.length - 1;
  assert.equal(start > 0, true, 'the fixture slot must have room for the foreign marker');
  marker.copy(slot, start);
  const written = writeRegion(asarPath, located.absoluteOffset, slot);
  assert.equal(written.ok, true, written.ok === true ? '' : `${written.code}: ${written.message}`);
  assert.equal(slot.length, located.length, 'the fixture must keep the slot length');
}

/**
 * Write a 0.1.x-era install record naming the official baseline digest, exactly
 * as a 0.1.x apply left it (`backup.sha256` is where that era kept the stock
 * digest).
 *
 * @param {{ stateDir: string, run: string, asarPath: string }} fixture
 * @param {{ backupPath: string|null }} options
 */
function writeInSlotRecord(fixture, options) {
  mkdirSync(fixture.stateDir, { recursive: true });
  const record = {
    schema: 2,
    pluginVersion: '0.1.4',
    installRoot: fixture.run,
    asarPath: fixture.asarPath,
    asarSha: 'unknown-in-this-fixture',
    patchedRegionSha: sha256Buffer(buildPatchedRegion(REGION_LENGTH)),
    dshVersion: '0.2.2-rc.3',
    backup: options.backupPath === null
      ? null
      : { name: 'app.asar.20260101-0000.v0.2.2-rc.3.bak', path: options.backupPath, size: STOCK_ARCHIVE_SIZE, sha256: STOCK_ARCHIVE_SHA },
  };
  writeFileSync(join(fixture.stateDir, 'install.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/**
 * Write the install record an EARLIER split build left behind: the layout, the
 * reserve it installed, and the digest of the official bytes this machine came
 * from.
 *
 * The regrow path reads exactly two things from a record — `stockSha` (its proof
 * that the shrink reproduced the bytes this machine was installed over) and the
 * layout — so a fixture without one would be testing a machine that cannot
 * really exist (a split install always writes a record).
 *
 * `stockSha` is written under `backup.sha256` as well as `stockSha`, because
 * `recordedStockShaOf()` accepts either: that is the compatibility rule for
 * records written by 0.1.x, and the fixture keeps both keys honest.
 *
 * @param {{ stateDir: string, run: string, asarPath: string }} fixture
 * @param {number} reserve the region length the old install carried
 */
function writeSplitRecord(fixture, reserve) {
  mkdirSync(fixture.stateDir, { recursive: true });
  const record = {
    schema: 2,
    pluginVersion: '0.3.0',
    installRoot: fixture.run,
    asarPath: fixture.asarPath,
    layout: 'split',
    layoutBefore: null,
    migrated: false,
    asarSha: 'not-this-archive-anymore',
    patchedRegionSha: null,
    regionOffset: null,
    regionLength: REGION_LENGTH,
    splitRegion: {
      length: reserve,
      sha256: sha256Buffer(buildSplitRegion(reserve)),
      startInMain: 779389 + REGION_LENGTH,
      absoluteOffset: 0,
    },
    stockSha: STOCK_ARCHIVE_SHA,
    dshVersion: '0.2.2-rc.3',
    backup: {
      name: 'app.asar.20260101-0000.v0.2.2-rc.3.bak',
      path: join(fixture.resources, 'app.asar.20260101-0000.v0.2.2-rc.3.bak'),
      size: STOCK_ARCHIVE_SIZE,
      sha256: STOCK_ARCHIVE_SHA,
    },
  };
  writeFileSync(join(fixture.stateDir, 'install.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/**
 * Place a backup holding the OFFICIAL bytes beside the archive.
 *
 * @param {string} resources
 * @returns {string} its path
 */
function placeStockBackup(resources) {
  const path = join(resources, 'app.asar.20260101-0000.v0.2.2-rc.3.bak');
  copyFileSync(BASELINE, path);
  return path;
}

/** Read the install record the CLI wrote, or null. */
function readRecord(stateDir) {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'install.json'), 'utf8'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ cases -- */

test('a stock archive installs the split layout: +16,384 bytes, official slot untouched', { skip: SKIP }, async () => {
  const fixture = makeCase('stock-to-split');
  // A stock backup is provided so the baseline is REUSED (no second 209 MB copy),
  // which is what makes "the *.bak pile did not grow" an assertable fact.
  const providedBackup = placeStockBackup(fixture.resources);
  const backupsBefore = backupsOf(fixture.resources).length;
  assert.equal(diskFacts(fixture.asarPath).layout, 'pristine', 'the fixture must start pristine');
  assert.equal(sizeOf(fixture.asarPath), STOCK_ARCHIVE_SIZE);

  const applied = await cli(fixture, '--apply');
  assert.equal(applied.exitCode, 0, applied.body?.ok === true ? '' : `${applied.body?.code}: ${applied.body?.message}`);
  assert.equal(applied.body.layout, 'split', 'the body must name the layout it installed');
  assert.equal(applied.body.state, 'patched-by-us');
  assert.equal(applied.body.migrated, false);
  assert.equal(applied.body.backupReused, true, 'a verified baseline must be reused');
  assert.equal(applied.body.backup.path, providedBackup);
  assert.equal(applied.body.splitRegion.length, REGION_RESERVE_BYTES);
  assert.equal(applied.body.splitRegion.sha256, SPLIT_REGION_SHA);
  assert.equal(typeof applied.body.movedBytes, 'number');
  assert.equal(applied.body.movedBytes > 0, true, 'inserting 16 KiB into lib/main.js has to move the tail');

  // ---- what is on DISK, not what the body says ------------------------------
  const facts = diskFacts(fixture.asarPath);
  assert.equal(facts.layout, 'split');
  assert.equal(facts.state, 'patched-by-us');
  assert.equal(facts.officialSlotSha, STOCK_SLOT_SHA, 'the official tray slot must stay byte-for-byte pristine');
  assert.equal(facts.splitRegionSha, SPLIT_REGION_SHA, 'the region must be exactly what this build produces');
  assert.equal(facts.splitLength, REGION_RESERVE_BYTES);
  assert.equal(facts.splitStartInMain, 779389 + REGION_LENGTH, 'the region sits right after the official slot');

  assert.equal(sizeOf(fixture.asarPath), STOCK_ARCHIVE_SIZE + REGION_RESERVE_BYTES,
    'the archive must grow by exactly the reserve');
  assert.equal(facts.mainSize, 848505 + REGION_RESERVE_BYTES, 'lib/main.js must grow by exactly the reserve');
  assert.equal(backupsOf(fixture.resources).length, backupsBefore, 'reusing a baseline must not write another copy');

  const record = readRecord(fixture.stateDir);
  assert.notEqual(record, null, 'the install record must exist');
  assert.equal(record.layout, 'split', 'the record must name the layout');
  assert.equal(record.splitRegion.sha256, SPLIT_REGION_SHA);
  assert.equal(record.stockSha, STOCK_ARCHIVE_SHA, 'the record must remember the official bytes this machine came from');

  // A second status must describe the same file, and must NOT call it "stock".
  const status = await cli(fixture, '--status');
  assert.equal(status.exitCode, 0);
  assert.equal(status.body.layout, 'split');
  assert.equal(status.body.state, 'patched-by-us');
  assert.equal(status.body.installState, 'installed');
});

test('a second apply on a split archive refreshes with ZERO movement', { skip: SKIP }, async () => {
  const fixture = makeCase('split-refresh');
  placeStockBackup(fixture.resources);
  const first = await cli(fixture, '--apply');
  assert.equal(first.exitCode, 0, `${first.body?.code}: ${first.body?.message}`);

  const digestAfterFirst = (await import('../lib/asar/hash.js')).sha256File(fixture.asarPath);
  const shaBefore = await digestAfterFirst;
  const backupsBefore = backupsOf(fixture.resources).length;
  const sizeBefore = sizeOf(fixture.asarPath);

  const second = await cli(fixture, '--apply');
  assert.equal(second.exitCode, 0, second.body?.ok === true ? '' : `${second.body?.code}: ${second.body?.message}`);
  assert.equal(second.body.refreshed, true, 'a second apply is a refresh, not a second install');
  assert.equal(second.body.layout, 'split');
  assert.equal(typeof second.body.regionRewritten, 'boolean');
  assert.equal(second.body.movedBytes, 0, 'nothing may move on a refresh');

  // THE property: the archive digest is unchanged, so no byte moved at all.
  const { sha256File } = await import('../lib/asar/hash.js');
  const shaAfter = await sha256File(fixture.asarPath);
  assert.equal(shaAfter, shaBefore, 'a refresh must not change the archive when the region already matches');
  assert.equal(sizeOf(fixture.asarPath), sizeBefore);
  assert.equal(backupsOf(fixture.resources).length, backupsBefore, 'a refresh writes no backup');

  const facts = diskFacts(fixture.asarPath);
  assert.equal(facts.layout, 'split');
  assert.equal(facts.officialSlotSha, STOCK_SLOT_SHA);
  assert.equal(facts.splitRegionSha, SPLIT_REGION_SHA);
});

test('a split install of an OLDER reserve is regrown to 16,384 by ONE --apply', { skip: SKIP }, async () => {
  const fixture = makeCase('split-regrow');
  const providedBackup = placeStockBackup(fixture.resources);

  // THE FIXTURE: a legitimately installed split machine whose region is NOT this
  // build's reserve. That is what a machine looks like between "new plugin code
  // deployed" and "archive migrated" — the state the audit found on this machine
  // (an 8 KiB region left by an earlier build).
  //
  // Why not literally 8 KiB: this build cannot CONSTRUCT one. `buildSplitRegion(8192)`
  // throws (`needs 15331 bytes, region is 8192`), and `growRegion` refuses any
  // region below `SPLIT_MINIMUM_REGION_LENGTH` (15,331). The next-best real-world
  // shape is a reserve of a DIFFERENT LENGTH that the surgery layer accepts, and
  // 20 KiB exercises the same branch (`existing.length !== REGION_RESERVE_BYTES`)
  // with a geometry that is legal on both sides. The branch itself is length
  // agnostic — it only compares against `REGION_RESERVE_BYTES`.
  //
  // AND THE POINT OF THE WHOLE CASE, stated here because it is the property that
  // makes one action safe: the intermediate state `regrowSplit` passes through is
  // a LEGAL stock archive (`state:'stock'` + `layout:'pristine'`), not a
  // half-written file. So an interrupted regrow RESUMES: the next `--apply` takes
  // the `pristine` branch and finishes the job, with no `--restore` and no manual
  // procedure. Everything below therefore asserts the END geometry of a single
  // call (stock-then-split), and the last assertion re-proves that the equal-length
  // fast path is still zero-movement afterwards.
  const OLD_RESERVE = 20 * 1024;
  const oldPlan = planSplitFile(fixture.asarPath, OLD_RESERVE);
  assert.equal(oldPlan.ok, true, `the fixture plan must be legal: ${oldPlan.code}: ${oldPlan.message}`);
  const oldRegion = buildSplitRegion(OLD_RESERVE);
  const grown = await growRegion(fixture.asarPath, oldPlan, oldRegion);
  assert.equal(grown.ok, true, `${grown.code}: ${grown.message}`);
  assert.equal(sizeOf(fixture.asarPath), STOCK_ARCHIVE_SIZE + OLD_RESERVE);

  // A real install would have written a record naming the reserve it installed
  // and the official bytes this machine came from; the regrow path reads those
  // two facts (the second one is its digest cross-check).
  writeSplitRecord(fixture, OLD_RESERVE);

  const before = diskFacts(fixture.asarPath);
  assert.equal(before.layout, 'split', 'the fixture must be an installed split machine');
  assert.equal(before.state, 'patched-by-us');
  assert.equal(before.splitLength, OLD_RESERVE, 'the fixture really carries the old reserve');
  assert.equal(before.officialSlotSha, STOCK_SLOT_SHA, 'the official slot is still pristine');
  assert.equal(before.mainSize, 848505 + OLD_RESERVE);

  // --dry-run must describe BOTH steps of the one action, not a plain refresh.
  const dry = await cli(fixture, '--dry-run');
  assert.equal(dry.body.refused ?? false, false, 'an older reserve is upgradeable, not refused');
  assert.equal(dry.body.plan.write[0], 'shrinkRegion', 'the plan must start by reversing the old region');
  assert.equal(dry.body.plan.write.includes('growRegion'), true, 'and must re-insert this build’s region');

  // THE ONE ACTION: a single --apply. No --restore in between, one body.
  const applied = await cli(fixture, '--apply');
  assert.equal(applied.exitCode, 0, applied.body?.ok === true ? '' : `${applied.body?.code}: ${applied.body?.message}`);
  assert.equal(applied.body.refreshed, 'regrown', 'the body must say HOW it was refreshed');
  assert.equal(applied.body.regrown, true);
  assert.equal(applied.body.reserveBefore, OLD_RESERVE, 'the body must name the reserve it replaced');
  assert.equal(applied.body.reserveAfter, REGION_RESERVE_BYTES);
  assert.equal(applied.body.layout, 'split');
  assert.equal(applied.body.layoutBefore, 'split', 'the archive was already ours before this call');
  assert.equal(applied.body.removedRegionBytes, OLD_RESERVE);
  assert.equal(applied.body.stockShaConfirmed, true, 'the recorded official digest must be checked');
  assert.equal(applied.body.backupReused, true, 'the baseline is reused, not copied again');
  assert.equal(applied.body.backup.path, providedBackup);

  // ---- what is on DISK: the stock-then-split geometry, in ONE step ---------
  const facts = diskFacts(fixture.asarPath);
  assert.equal(facts.layout, 'split');
  assert.equal(facts.state, 'patched-by-us');
  assert.equal(facts.splitLength, REGION_RESERVE_BYTES, 'the region is now this build’s reserve');
  assert.equal(facts.splitRegionSha, SPLIT_REGION_SHA, 'and it is byte-for-byte what this build produces');
  assert.equal(facts.officialSlotSha, STOCK_SLOT_SHA, 'the official slot came back pristine through the shrink');
  assert.equal(facts.splitStartInMain, 779389 + REGION_LENGTH, 'the region sits right after the official slot again');

  const sizeAfter = sizeOf(fixture.asarPath);
  assert.equal(sizeAfter, STOCK_ARCHIVE_SIZE + REGION_RESERVE_BYTES,
    'the archive ends at exactly the stock size plus the CURRENT reserve');
  assert.equal(sizeAfter, applied.body.archiveSizeAfter);
  assert.equal(sizeOf(fixture.asarPath) > 0 && applied.body.stockArchiveSize === STOCK_ARCHIVE_SIZE, true,
    'the intermediate stock size is reported, not hidden');
  assert.equal(facts.mainSize, 848505 + REGION_RESERVE_BYTES);

  const record = readRecord(fixture.stateDir);
  assert.notEqual(record, null);
  assert.equal(record.layout, 'split');
  assert.equal(record.layoutBefore, 'split', 'the record must say the machine was already split');
  assert.equal(record.splitRegion.length, REGION_RESERVE_BYTES);
  assert.equal(record.splitRegion.sha256, SPLIT_REGION_SHA);
  assert.equal(record.stockSha, STOCK_ARCHIVE_SHA, 'the official digest is carried forward for --restore');

  // AND THE FAST PATH IS STILL THE FAST PATH: a second --apply on the regrown
  // archive is the equal-length refresh with zero movement, not another regrow.
  const second = await cli(fixture, '--apply');
  assert.equal(second.exitCode, 0);
  assert.equal(second.body.refreshed, true, 'the equal-length refresh must keep reporting `true`');
  assert.equal(second.body.regrown, undefined, 'a refresh is not a regrow');
  assert.equal(second.body.movedBytes, 0);
  assert.equal(sizeOf(fixture.asarPath), sizeAfter, 'the fast path moves nothing');
});

test('restore on a split archive reproduces the stock bytes WITHOUT a backup', { skip: SKIP }, async () => {
  const fixture = makeCase('split-restore');
  placeStockBackup(fixture.resources);
  const applied = await cli(fixture, '--apply');
  assert.equal(applied.exitCode, 0, `${applied.body?.code}: ${applied.body?.message}`);
  assert.equal(sizeOf(fixture.asarPath), STOCK_ARCHIVE_SIZE + REGION_RESERVE_BYTES);

  // DELETE the backup first: the whole point of the split layout is that
  // uninstalling is arithmetic, not a 209 MB copy. If the restore path silently
  // needed a backup, this case would fail with ENO_BACKUP instead of passing.
  for (const name of backupsOf(fixture.resources)) rmSync(join(fixture.resources, name), { force: true });
  assert.equal(backupsOf(fixture.resources).length, 0, 'the backup really is gone');

  const restored = await cli(fixture, '--restore');
  assert.equal(restored.exitCode, 0, restored.body?.ok === true ? '' : `${restored.body?.code}: ${restored.body?.message}`);
  assert.equal(restored.body.backupUsed, false, 'the shrink path needs no backup');
  assert.equal(restored.body.writeMode, 'shrink');
  assert.equal(restored.body.layoutBefore, 'split');

  const { sha256File } = await import('../lib/asar/hash.js');
  const shaAfter = await sha256File(fixture.asarPath);
  assert.equal(shaAfter, STOCK_ARCHIVE_SHA, 'the reverse surgery must reproduce the official archive byte for byte');
  assert.equal(sizeOf(fixture.asarPath), STOCK_ARCHIVE_SIZE);
  assert.equal(existsSync(fixture.bridgePath), false, 'the bridge must be removed');

  const facts = diskFacts(fixture.asarPath);
  assert.equal(facts.layout, 'pristine');
  assert.equal(facts.state, 'stock');
  assert.equal(facts.officialSlotSha, STOCK_SLOT_SHA);
  assert.equal(facts.splitRegionSha, null, 'no split region may survive the restore');

  const record = readRecord(fixture.stateDir);
  assert.notEqual(record, null);
  assert.equal(record.installed, false, 'the record must say "nothing installed"');
  assert.equal(record.previous.layout, 'split', 'the record remembers what it undid');
});

test('an in-slot 0.1.x install is migrated: official bytes restored first, then the split', { skip: SKIP }, async () => {
  const fixture = makeCase('migrate');
  handPatchSlot(fixture.asarPath);
  const backupPath = placeStockBackup(fixture.resources);
  writeInSlotRecord(fixture, { backupPath });

  const before = diskFacts(fixture.asarPath);
  assert.equal(before.layout, 'in-slot', 'the fixture must be a 0.1.x install');
  assert.equal(before.state, 'patched-by-us');
  assert.notEqual(before.officialSlotSha, STOCK_SLOT_SHA, 'the fixture slot really is OURS, not official');
  assert.equal(sizeOf(fixture.asarPath), STOCK_ARCHIVE_SIZE, 'the 0.1.x patch never changed the length');

  // --dry-run must describe the migration, not a plain install.
  const dry = await cli(fixture, '--dry-run');
  assert.equal(dry.body.plan?.write?.[0], 'restoreFromBackup', 'the plan must start by restoring the official bytes');

  const applied = await cli(fixture, '--apply');
  assert.equal(applied.exitCode, 0, applied.body?.ok === true ? '' : `${applied.body?.code}: ${applied.body?.message}`);
  assert.equal(applied.body.migrated, true, 'the body must say this was a migration');
  assert.equal(applied.body.layoutBefore, 'in-slot');
  assert.equal(applied.body.layout, 'split');
  assert.equal(applied.body.migrationBackup, 'app.asar.20260101-0000.v0.2.2-rc.3.bak');

  // ---- what is on DISK -----------------------------------------------------
  const facts = diskFacts(fixture.asarPath);
  assert.equal(facts.layout, 'split');
  assert.equal(facts.state, 'patched-by-us');
  assert.equal(facts.officialSlotSha, STOCK_SLOT_SHA,
    'the migration must have restored the OFFICIAL slot bytes before inserting the region');
  assert.equal(facts.splitRegionSha, SPLIT_REGION_SHA);
  assert.equal(sizeOf(fixture.asarPath), STOCK_ARCHIVE_SIZE + REGION_RESERVE_BYTES,
    'the final archive is the stock one plus exactly the reserve');
  assert.equal(facts.mainSize, 848505 + REGION_RESERVE_BYTES);
});

test('migration WITHOUT a backup refuses with ENO_BACKUP and leaves the archive untouched', { skip: SKIP }, async () => {
  const fixture = makeCase('migrate-no-backup');
  handPatchSlot(fixture.asarPath);
  writeInSlotRecord(fixture, { backupPath: null });
  assert.deepEqual(backupsOf(fixture.resources), [], 'there must be no backup for this case to mean anything');

  const { sha256File } = await import('../lib/asar/hash.js');
  const before = await sha256File(fixture.asarPath);

  const applied = await cli(fixture, '--apply');
  assert.notEqual(applied.exitCode, 0, 'a migration without official bytes must be refused');
  assert.equal(applied.body.code, 'ENO_BACKUP');
  assert.match(applied.body.message, /RESTORE-STOCK\.md/, 'the refusal must name the manual way out');
  assert.equal(applied.body.layoutBefore, 'in-slot');

  const after = await sha256File(fixture.asarPath);
  assert.equal(after, before, 'a refusal must not write a single byte');
  assert.equal(diskFacts(fixture.asarPath).layout, 'in-slot', 'the archive must still be the 0.1.x install');
});

test('a double install (in-slot patch AND split region) is refused, naming both layouts', { skip: SKIP }, async () => {
  const fixture = makeCase('double-install');
  placeStockBackup(fixture.resources);
  const applied = await cli(fixture, '--apply');
  assert.equal(applied.exitCode, 0, `${applied.body?.code}: ${applied.body?.message}`);
  assert.equal(diskFacts(fixture.asarPath).layout, 'split');

  // Stack the OTHER layout on top by hand: the 0.1.x patch goes back into the
  // official slot, which leaves our region after it. That is exactly the shape
  // `classifyAsar` reports as `foreign` + `doubleInstall`.
  handPatchSlot(fixture.asarPath);
  const doubled = diskFacts(fixture.asarPath);
  assert.equal(doubled.layout, 'split');
  assert.equal(doubled.state, 'foreign');
  assert.equal(doubled.doubleInstall, true, 'the fixture must be a real double install');

  const { sha256File } = await import('../lib/asar/hash.js');
  const before = await sha256File(fixture.asarPath);

  const refused = await cli(fixture, '--apply');
  assert.notEqual(refused.exitCode, 0, 'a double install must never be written over');
  assert.equal(refused.body.code, 'EFOREIGN_PATCH');
  assert.equal(refused.body.doubleInstall, true);
  assert.match(refused.body.message, /0\.1\.x/, 'the message must name the in-slot layout');
  assert.match(refused.body.message, /0\.2\.0/, 'the message must name the split layout');
  assert.match(refused.body.message, /RESTORE-STOCK\.md/, 'the message must name the way out');

  const after = await sha256File(fixture.asarPath);
  assert.equal(after, before, 'a refusal must not write a single byte');

  // The dry-run must refuse too, with the same explanation.
  const dry = await cli(fixture, '--dry-run');
  assert.equal(dry.body.refused, true);
  assert.equal(dry.body.refusalCode, 'EFOREIGN_PATCH');
});

test('a foreign slot is still refused with EFOREIGN_PATCH (regression)', { skip: SKIP }, async () => {
  const fixture = makeCase('foreign');
  handForeignSlot(fixture.asarPath);
  const factsBefore = diskFacts(fixture.asarPath);
  assert.equal(factsBefore.state, 'foreign', 'the fixture must carry a third-party marker');
  assert.equal(factsBefore.layout, 'pristine');

  const { sha256File } = await import('../lib/asar/hash.js');
  const before = await sha256File(fixture.asarPath);

  const refused = await cli(fixture, '--apply');
  assert.notEqual(refused.exitCode, 0);
  assert.equal(refused.body.code, 'EFOREIGN_PATCH', 'a third-party slot must be refused, never repaired');
  assert.equal(refused.body.doubleInstall ?? false, false, 'this is not our own double install');

  const after = await sha256File(fixture.asarPath);
  assert.equal(after, before, 'a refusal must not write a single byte');
  assert.equal(diskFacts(fixture.asarPath).state, 'foreign');
});

/* ------------------------------------------------- directory edits (step 1/2) -- */

/**
 * Append one file through the CLI and return its body, plus the journal the
 * install wrote.
 *
 * The edits live in `lib/asar/edit.js`; this file's job is the WIRING — that one
 * `--apply` still installs AND edits, that `--restore` still undoes both, and that
 * the state vocabulary the rest of the suite asserts stays exactly the same.
 *
 * @param {{ run: string, home: string }} fixture
 * @param {string} path
 * @param {string} content
 */
async function appendVia(fixture, path, content) {
  return cli(fixture, ['--apply', '--append', path, '--content', content]);
}

test('ONE --apply installs the split layout AND appends a file; state vocabulary unchanged', { skip: SKIP }, async () => {
  const fixture = makeCase('edit-one-action');
  placeStockBackup(fixture.resources);
  const body = 'module.exports = { edited: true };\n';
  const applied = await appendVia(fixture, 'dsh-asar-edits/one-action.cjs', body);
  assert.equal(applied.exitCode, 0, applied.body?.ok === true ? '' : `${applied.body?.code}: ${applied.body?.message}`);
  assert.equal(applied.body.layout, 'split', 'the layout step ran first, in the same call');
  assert.equal(applied.body.edited, true);
  assert.equal(applied.body.editsApplied.length, 1);
  assert.equal(applied.body.editsApplied[0].op, 'append');
  // THE STATE VOCABULARY IS FROZEN: an edit does not add a state, it adds a
  // dimension. Both detectors still answer exactly what they answered before.
  assert.equal(applied.body.state, 'patched-by-us');
  assert.equal(applied.body.migrated, false);
  // A FIRST install reports no previous layout (there was nothing of ours). The
  // field exists so an upgrade can name where it came from, not to fake a value.
  assert.equal(applied.body.layoutBefore ?? null, null);

  const facts = diskFacts(fixture.asarPath);
  assert.equal(facts.state, 'patched-by-us');
  assert.equal(facts.layout, 'split');
  assert.equal(facts.officialSlotSha, STOCK_SLOT_SHA, 'the official slot is untouched by an append');
  assert.equal(facts.splitRegionSha, SPLIT_REGION_SHA, 'and so is our region');
  assert.equal(sizeOf(fixture.asarPath), STOCK_ARCHIVE_SIZE + REGION_RESERVE_BYTES + Buffer.byteLength(body));

  const record = readRecord(fixture.stateDir);
  assert.notEqual(record, null);
  assert.equal(record.layout, 'split', 'the record still says which layout it installed');
  assert.equal(record.stockSha, STOCK_ARCHIVE_SHA, 'and still names the official bytes this machine came from');
  assert.equal(typeof record.editCount, 'number', 'and now also names how many edits it carries');
  assert.equal(record.editCount, 1);

  // --status must report the edit without changing the state words.
  const status = await cli(fixture, '--status');
  assert.equal(status.exitCode, 0);
  assert.equal(status.body.state, 'patched-by-us');
  assert.equal(status.body.layout, 'split');
  assert.equal(status.body.edited, true, 'status must say the archive carries edits');
  assert.equal(status.body.editPaths.includes('dsh-asar-edits/one-action.cjs'), true);
  assert.equal(status.body.editSource, 'journal', 'the journal is the proof, not the archive heuristic');
});

test('--restore undoes the edits FIRST and still reproduces the stock bytes', { skip: SKIP }, async () => {
  const fixture = makeCase('edit-restore');
  placeStockBackup(fixture.resources);
  const basis = 'baseline\n';
  const appended = await appendVia(fixture, 'dsh-asar-edits/to-undo.cjs', basis);
  assert.equal(appended.exitCode, 0, `${appended.body?.code}: ${appended.body?.message}`);

  // The plain refresh path would refuse on an edited archive whose reserve has to
  // change; here the reserve is current, so the ONLY thing that must happen is a
  // zero-movement refresh plus the edit staying put.
  const again = await appendVia(fixture, 'dsh-asar-edits/to-undo.cjs', basis);
  assert.equal(again.body.noopEdits, true, 'the same edit twice is a no-op, not a duplicate');

  const restored = await cli(fixture, '--restore');
  assert.equal(restored.exitCode, 0, restored.body?.ok === true ? '' : `${restored.body?.code}: ${restored.body?.message}`);
  assert.equal(restored.body.editsUndone.mode, 'arithmetic', 'the inverse is arithmetic, not a backup copy');
  assert.equal(restored.body.editsUndone.ops.length, 1);
  assert.equal(restored.body.writeMode, 'shrink', 'the layout half is still the byte-exact shrink');
  assert.equal(restored.body.backupUsed, false);

  const { sha256File } = await import('../lib/asar/hash.js');
  assert.equal(await sha256File(fixture.asarPath), STOCK_ARCHIVE_SHA,
    'edits undone + region shrunk must equal the official archive, byte for byte');
  assert.equal(sizeOf(fixture.asarPath), STOCK_ARCHIVE_SIZE);
  assert.equal(existsSync(join(fixture.stateDir, 'edits.json')), false, 'the journal is cleared');
  assert.equal(diskFacts(fixture.asarPath).state, 'stock');
});

test('--dry-run with an edit names the edit step, and a delete without a baseline is refused there too', { skip: SKIP }, async () => {
  const fixture = makeCase('edit-dry-run');
  const dry = await cli(fixture, '--dry-run', '--append', 'dsh-asar-edits/planned.cjs', '--content', 'planned\n');
  assert.equal(dry.exitCode, 0, `${dry.body?.code}: ${dry.body?.message}`);
  assert.equal(dry.body.plan.write.includes('applyEdits'), true, 'the plan must name the edit half');
  assert.equal(dry.body.plan.write.includes('append(dsh-asar-edits/planned.cjs)'), true);
  assert.equal(dry.body.editPlan[0].bytes, 8);
  assert.equal(sizeOf(fixture.asarPath), STOCK_ARCHIVE_SIZE, 'a dry run writes nothing, not even the layout');

  // A machine that HAS the layout and NO verified baseline: removing a file needs
  // one, and the dry run must say so with the code the apply path would use.
  const installed = await cli(fixture, '--apply');
  assert.equal(installed.exitCode, 0, `${installed.body?.code}: ${installed.body?.message}`);
  for (const name of backupsOf(fixture.resources)) rmSync(join(fixture.resources, name), { force: true });
  const removedDry = await cli(fixture, '--dry-run', '--remove', 'renderer/welcome.html');
  assert.equal(removedDry.body.refused, true);
  assert.equal(removedDry.body.refusalCode, 'EBASELINE_REQUIRED');
  assert.equal(sizeOf(fixture.asarPath) > STOCK_ARCHIVE_SIZE, true);
});

test('an edited archive refuses a reserve-changing refresh with EEDIT_PRESENT, and writes nothing', { skip: SKIP }, async () => {
  const fixture = makeCase('edit-refuse-regrow');
  placeStockBackup(fixture.resources);

  // An OLDER reserve (20 KiB) so the next `--apply` would have to RE-LAY-OUT the
  // archive: shrink the old region, then insert the current one. That silently
  // moves every trailing entry, which would invalidate the offsets the journal
  // recorded — so the edit layer refuses instead of quietly rewriting history.
  const OLD_RESERVE = 20 * 1024;
  const oldPlan = planSplitFile(fixture.asarPath, OLD_RESERVE);
  assert.equal(oldPlan.ok, true, `${oldPlan.code}: ${oldPlan.message}`);
  const grown = await growRegion(fixture.asarPath, oldPlan, buildSplitRegion(OLD_RESERVE));
  assert.equal(grown.ok, true, `${grown.code}: ${grown.message}`);
  writeSplitRecord(fixture, OLD_RESERVE);

  // The edit is applied with the LIBRARY, not the CLI: a CLI `--apply --append`
  // would first regrow the old region and only then append, which is the legal
  // one-action path and not the state this case is about. What a real machine
  // actually looks like here is "edited by an older build, then this build runs":
  // the archive carries BOTH an old reserve and a journalled append.
  const { sha256File } = await import('../lib/asar/hash.js');
  const splitSha = await sha256File(fixture.asarPath);
  const splitSize = sizeOf(fixture.asarPath);
  const opened = openForPlan(fixture.asarPath);
  const plan = planAppend(opened.asar, { path: 'dsh-asar-edits/sits-on-old-region.cjs', content: 'x\n' });
  closeForPlan(opened);
  assert.equal(plan.ok, true, `${plan.code}: ${plan.message}`);
  const written = await applyAppend(fixture.asarPath, plan);
  assert.equal(written.ok, true, `${written.code}: ${written.message}`);
  const { appendEditJournal } = await import('../lib/install/record.js');
  appendEditJournal(fixture.stateDir, {
    installRoot: fixture.run,
    asarPath: fixture.asarPath,
    baseArchiveSha: splitSha,
    baseArchiveSize: splitSize,
  }, plan.record);

  const before = await sha256File(fixture.asarPath);

  const refused = await cli(fixture, '--apply');
  assert.notEqual(refused.exitCode, 0, 'a re-layout over recorded offsets must be refused');
  assert.equal(refused.body.code, 'EEDIT_PRESENT');
  assert.equal(refused.body.message.includes('--restore'), true, 'the refusal must name the one action that works');
  assert.equal(refused.body.edited, true);
  assert.equal(await sha256File(fixture.asarPath), before, 'a refusal must not write a single byte');

  // And --restore DOES work: edits undone, old region shrunk, official bytes back.
  const restored = await cli(fixture, '--restore');
  assert.equal(restored.exitCode, 0, restored.body?.ok === true ? '' : `${restored.body?.code}: ${restored.body?.message}`);
  assert.equal(restored.body.editsUndone.mode, 'arithmetic');
  assert.equal(await sha256File(fixture.asarPath), STOCK_ARCHIVE_SHA, 'one --restore must undo edits AND layout');
});
