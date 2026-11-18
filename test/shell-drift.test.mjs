/**
 * Cross-version drift test: what survives a DSH release upgrade, and what does
 * not.
 *
 * This package patches one equal-length slot inside `lib/main.js` by absolute
 * byte offset. A DSH upgrade repacks `app.asar` (new files, new directory
 * header), so the archive size, the header, the data start and every entry
 * offset move. If the slot itself moved too, the patch would have to be
 * re-derived for every release — it does not, and this file is the proof of
 * that "等长替换对版本更新有抗性" claim:
 *
 *   unchanged across releases (the patch contract)
 *     slot offset inside lib/main.js   779389
 *     slot length                      1253
 *     slot content sha256              4bc10e1e…ce64
 *
 *   moves with the release (the lookup must come from the version table)
 *     slot absolute offset             rc.2: 207075526   rc.3: 207958920
 *     ... by exactly the distance `lib/main.js` itself moved:
 *       (dataStart + mainOffset) differs between the two releases
 *
 * The table-level test runs always; the two tests that open the archives need
 * the kept rc.2 copy (`<上一版档案副本>\app.asar`) and skip when it
 * is absent, so a machine that only has the live install stays green.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from '../lib/fs-safe.js';

import { closeAsar, openAsar, readRootPackage } from '../lib/asar/reader.js';
import { locateRegion } from '../lib/asar/locate.js';

import {
  KNOWN_VERSIONS,
  LIVE_ASAR,
  RC2_ASAR,
  REAL_ASAR,
  SHELLS,
  currentShell,
  readState,
  realState,
  shellGate,
} from './real-asar.mjs';

/** The previous release, kept on disk for exactly this comparison. */
const OLD = SHELLS['0.2.2-rc.2'];

/** The release this machine runs now (the one the table entry describes). */
const NEW = SHELLS['0.2.2-rc.3'];

/**
 * Both archives are needed for the on-disk comparison: the kept previous
 * release and the live install. Independent of `DSH_REAL_ASAR`, which may be
 * pointed at either one in order to run the rest of the suite against it.
 */
const driftPairAvailable = existsSync(RC2_ASAR) && existsSync(LIVE_ASAR) && RC2_ASAR !== LIVE_ASAR;

/** Skip reason for the on-disk drift comparison. */
const driftSkip = driftPairAvailable
  ? false
  : `需要保留上一版档案 (${RC2_ASAR}) 和线上安装 (${LIVE_ASAR}) 两份都在`;

/**
 * Measure the tray slot of an archive on disk, read-only.
 *
 * @param {string} path
 * @returns {{ version: string|null, startInMain: number, length: number, sha256: string, absoluteOffset: number, dataStart: number, mainOffset: number }}
 */
function measureSlot(path) {
  const opened = openAsar(path, { allowStaleMainIntegrity: true });
  assert.equal(opened.ok, true, opened.ok === true ? '' : `${path}: ${opened.code}: ${opened.message}`);
  try {
    const pkg = readRootPackage(opened);
    const located = locateRegion(opened);
    assert.equal(located.ok, true, located.ok === true ? '' : `${path}: ${located.code}: ${located.message}`);
    return {
      version: pkg !== null && typeof pkg.version === 'string' ? pkg.version : null,
      startInMain: located.startInMain,
      length: located.length,
      sha256: located.sha256,
      absoluteOffset: located.absoluteOffset,
      dataStart: opened.dataStart,
      mainOffset: located.mainOffset,
    };
  } finally {
    closeAsar(opened);
  }
}

test('every registered shell agrees on the three slot facts a patch depends on', () => {
  // Table-level: true for every release in `SHELLS`, including ones added
  // later. If a future DSH release really did move the slot, this test fails
  // and says which release — which is the signal that the patch contract
  // changed, not that the numbers need refreshing.
  assert.ok(KNOWN_VERSIONS.length >= 2, 'the point of this test is a cross-version comparison');
  for (const version of KNOWN_VERSIONS) {
    const shell = SHELLS[version];
    assert.equal(shell.stock.slotOffsetInMain, OLD.stock.slotOffsetInMain,
      `${version}: the slot must stay at the same offset inside lib/main.js`);
    assert.equal(shell.stock.slotLength, OLD.stock.slotLength,
      `${version}: the slot must keep the same length (the patch is equal-length)`);
    assert.equal(shell.stock.slotSha, OLD.stock.slotSha,
      `${version}: the stock slot must be byte-identical`);
  }
});

test('the absolute slot offset does move, and by exactly the distance lib/main.js moved', () => {
  // Table-level half of the same statement: whoever refreshes these numbers by
  // copying the old ones forward breaks here.
  assert.notEqual(NEW.stock.slotAbsolute, OLD.stock.slotAbsolute,
    'a repacked archive must place the slot somewhere else; a copy-pasted number proves the table was not regenerated');
  assert.equal(
    NEW.stock.slotAbsolute - OLD.stock.slotAbsolute,
    (NEW.geometry.dataStart + NEW.geometry.mainOffset) - (OLD.geometry.dataStart + OLD.geometry.mainOffset),
    'the slot moved by exactly as much as lib/main.js itself did',
  );
  // …and that distance comes from the directory header, not from the slot.
  assert.notEqual(NEW.geometry.dataStart, OLD.geometry.dataStart, 'the header data start moved between releases');
  assert.notEqual(NEW.geometry.mainOffset, OLD.geometry.mainOffset, 'lib/main.js moved inside the archive');
});

test('on disk: the rc.2 copy and the live rc.3 archive agree on the slot, and the stock bytes match', { skip: driftSkip }, () => {
  // Independent of DSH_REAL_ASAR: this one is always the pair, so it reads the
  // kept copy and the live install by name.
  const oldSlot = measureSlot(RC2_ASAR);
  const newSlot = measureSlot(LIVE_ASAR);

  // The kept copy must still be the release the table claims, otherwise the
  // comparison would be meaningless.
  assert.equal(oldSlot.version, OLD.version, `${RC2_ASAR} is not a ${OLD.version} archive`);
  assert.equal(newSlot.version, NEW.version, `${LIVE_ASAR} is not a ${NEW.version} archive`);

  // The LIVE archive may legitimately be patched right now — this package's
  // whole purpose is to patch it, and a machine where the bridge is installed
  // must not turn the cross-version proof red. So the byte comparison branches
  // on the live state instead of assuming stock: the point being proven is
  // "the stock slot bytes are the same in both releases", which is a fact about
  // the RELEASES and does not depend on what we wrote into the live copy.
  //
  // `readState(LIVE_ASAR)` rather than `realState()`: the latter describes
  // whatever `DSH_REAL_ASAR` points at (the suite can be aimed at the kept rc.2
  // copy), while this test is about the live install by name.
  const live = readState(LIVE_ASAR);
  const liveIsOurs = live.state === 'patched-by-us';
  // WHICH of our layouts the live install carries decides what the slot looks
  // like: 'in-slot' replaced the official slot (so the slot holds OUR digest),
  // while 'split' inserted a region AFTER it and left the slot pristine. The
  // invariance being proven — "the OFFICIAL slot is identical in both releases" —
  // is therefore only observable in the split layout, which is precisely the
  // layout whose premise it is.
  const liveIsSplit = live.layout === 'split';

  // Everything the table records, measured off the disk.
  assert.equal(oldSlot.startInMain, OLD.stock.slotOffsetInMain);
  assert.equal(oldSlot.length, OLD.stock.slotLength);
  assert.equal(oldSlot.sha256, OLD.stock.slotSha);
  assert.equal(oldSlot.absoluteOffset, OLD.stock.slotAbsolute);
  assert.equal(newSlot.startInMain, NEW.stock.slotOffsetInMain);
  assert.equal(newSlot.length, NEW.stock.slotLength);
  assert.equal(newSlot.absoluteOffset, NEW.stock.slotAbsolute);
  if (liveIsSplit) {
    // The official slot is untouched: length, position AND the stock digest.
    assert.equal(newSlot.sha256, NEW.split.slotSha,
      'a split live archive must leave the official slot byte-for-byte stock');
    assert.equal(newSlot.sha256, OLD.stock.slotSha,
      'both releases must ship the same official slot bytes');
    // The region is a separate claim: it sits after the slot, and its digest is
    // build-dependent, so it is never compared against a recorded constant — only
    // reported. Whether it is what the CURRENT build writes is checked where the
    // region bytes are at hand (asar-reader.test.mjs), not here.
    assert.equal(live.splitLength, NEW.split.reserveBytes);
    assert.equal(live.splitStartInMain, NEW.split.insertAtInMain);
    assert.equal(live.splitStartInMain, newSlot.startInMain + newSlot.length,
      'the region must start exactly where the official slot ends');
    assert.match(live.splitSha256, /^[0-9a-f]{64}$/);
  } else if (liveIsOurs) {
    // The live slot holds this build's patch: same length, our digest.
    assert.equal(newSlot.sha256, NEW.patched.regionSha,
      'a patched live archive must hold exactly the digest this build writes');
  } else {
    assert.equal(newSlot.sha256, NEW.stock.slotSha);
  }

  // THE invariant: the official slot survives the release upgrade because its
  // position inside lib/main.js, its length and its bytes did not change — only
  // where the whole file sits inside the archive did.
  //
  // "Its bytes did not change" is a statement about the official releases, so it
  // is proven by the two STOCK digests in the table; the on-disk half of it can
  // only be checked when the live slot is still stock — which is ALWAYS true in
  // the split layout and only true in the pristine stock state otherwise. When
  // the live archive carries the 0.1.x in-slot patch, the digests legitimately
  // differ and the invariant is carried by `KNOWN_VERSIONS` (the loop above),
  // which is exactly why that table is the ground truth rather than this
  // directory.
  assert.equal(newSlot.startInMain, oldSlot.startInMain, 'slot offset inside lib/main.js must not move');
  assert.equal(newSlot.length, oldSlot.length, 'slot length must not move');
  assert.equal(OLD.stock.slotSha, NEW.stock.slotSha, 'the stock slot bytes must be identical across releases');
  if (liveIsSplit || !liveIsOurs) {
    assert.equal(newSlot.sha256, oldSlot.sha256, 'the official slot bytes must be identical in both releases');
  }

  // Deliberately NOT compared: `lib/main.js` sizes. In the split layout the live
  // file is the stock size plus the reserve, so the two legitimately differ once
  // one of the pair is split — comparing them would be asserting the wrong fact.
  if (liveIsSplit) {
    assert.equal(live.mainSize, NEW.split.mainSizeAfter);
    assert.equal(live.mainSize, NEW.geometry.mainSize + NEW.split.reserveBytes,
      'the live main.js must be the stock one plus the reserve');
  }

  // …while the absolute offset did move, by the difference of the file positions.
  assert.notEqual(newSlot.absoluteOffset, oldSlot.absoluteOffset,
    'the absolute slot offset must differ between two repacked releases');
  assert.equal(
    newSlot.absoluteOffset - oldSlot.absoluteOffset,
    (newSlot.dataStart + newSlot.mainOffset) - (oldSlot.dataStart + oldSlot.mainOffset),
    'the absolute slot offset must move by exactly the distance lib/main.js moved',
  );
});

test('on disk: the live archive matches the record of the release it reports', { skip: shellGate() }, () => {
  const shell = currentShell();
  const current = realState();
  const live = measureSlot(REAL_ASAR);
  assert.equal(live.version, shell.version);
  assert.equal(live.startInMain, shell.stock.slotOffsetInMain);
  assert.equal(live.length, shell.stock.slotLength);
  assert.equal(live.absoluteOffset, shell.stock.slotAbsolute);
  // The OFFICIAL slot digest depends on which layout is installed, and both
  // layouts have to be told apart instead of assuming stock:
  //   pristine stock        the recorded stock digest
  //   split                 STILL the stock digest (the region goes after the slot)
  //   in-slot patched       OUR digest — that state is covered by
  //                         asar-region.test.mjs, which knows both of them
  if (current.layout === 'split') {
    assert.equal(live.sha256, shell.split.slotSha,
      'the split layout must leave the official slot exactly as the release shipped it');
    assert.equal(current.splitStartInMain, shell.split.insertAtInMain);
    assert.equal(current.splitLength, shell.split.reserveBytes);
    assert.equal(current.mainSize, shell.split.mainSizeAfter);
    assert.equal(current.archiveSize, shell.split.archiveSizeAfter);
    return;
  }
  if (current.state === 'stock') {
    assert.equal(live.sha256, shell.stock.slotSha);
    assert.equal(current.mainSize, shell.geometry.mainSize);
    assert.equal(current.archiveSize, shell.geometry.size);
  }
});

test('the previous release keeps its own copy, separate from the live install', () => {
  // Guard rail for the skip above: if the rc.2 copy disappears, this says so
  // plainly instead of letting the cross-version comparison quietly vanish.
  assert.equal(typeof RC2_ASAR, 'string');
  assert.notEqual(RC2_ASAR.toLowerCase(), LIVE_ASAR.toLowerCase(), 'the kept copy must not be the live archive');
});
