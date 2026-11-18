/**
 * Read-only verification of the real DSH desktop asar.
 *
 * These assertions describe the archive that is ACTUALLY installed, using the
 * per-release table in `./real-asar.mjs` (`SHELLS`) instead of one frozen
 * release. The version is read from the archive's own `package.json`, so the
 * same file passes on 0.2.2-rc.2, on 0.2.2-rc.3, and on any later release once
 * its table entry is added. A release that is not registered skips with a
 * reason naming it (see `shellGate`), it does not fail on stale numbers.
 *
 * In the states a supported install can legitimately be in:
 *
 *   stock          the shipped archive, untouched
 *   patched-by-us  the 0.1.x IN-SLOT layout: one equal-length slot replaced
 *   patched-by-us  the 0.2.0 SPLIT layout: official slot pristine, OUR region
 *                  inserted after it, so the archive and `lib/main.js` are both
 *                  exactly `split.addedBytes` larger
 *
 * The in-slot patch is an equal-length in-place write, so size / header / entry
 * table / `lib/main.js` position are identical in both SLOT states — only digests
 * differ. The split layout does change two numbers (archive size and `main.js`
 * size), which is why every assertion below is written against the layout rather
 * than against "stock geometry".
 *
 * A split install cannot be checked against recorded digests: its region comes
 * from `buildSplitRegion()`, so an older install legitimately carries an older
 * body. This file therefore proves the ARCHITECTURE for split — sizes, position,
 * pristine official slot — and proves the REST of `lib/main.js` is official by
 * stripping the region (see `stripRegion`). Anything else (foreign or unknown)
 * fails loudly instead of being silently tolerated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from '../lib/fs-safe.js';
import { join } from 'node:path';

import {
  absoluteOffsetOf,
  align4,
  closeAsar,
  entryInfo,
  openAsar,
  readEntry,
  readEntryText,
  readRootPackage,
} from '../lib/asar/reader.js';
import { locateRegion } from '../lib/asar/locate.js';
import { sha256Buffer, sha256File } from '../lib/asar/hash.js';
import {
  COPY_DIR,
  KNOWN_VERSIONS,
  REAL_ASAR,
  SHELLS,
  UNREGISTERED_REASON,
  currentBuildRegionSha,
  expectedForCurrentState,
  currentShell,
  currentVersion,
  matchesCurrentBuild,
  missingAsar,
  readState,
  realState,
  realStateIsSupported,
  resolveShell,
  shellGate,
  shellGateFor,
  stripRegion,
} from './real-asar.mjs';

/** Create a throwaway directory under `scratch/test-copies/`. */
function scratchDir(prefix) {
  mkdirSync(COPY_DIR, { recursive: true });
  return mkdtempSync(join(COPY_DIR, prefix));
}

/**
 * Build a minimal asar: pickle preamble, JSON directory, 4-byte padded header,
 * data area. Used to prove the integrity gate rejects a wrong data start.
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

test('align4 rounds up to the next multiple of four', () => {
  assert.equal(align4(0), 0);
  assert.equal(align4(1), 4);
  assert.equal(align4(4), 4);
  assert.equal(align4(5), 8);
});

test('align4: dataStart is 16 + align4(headerSize) for every recorded geometry', () => {
  // Version-aware replacement for the old "align4(5660805) == 5660808": the
  // pickle layout rule has to hold for every release, whatever its header size.
  for (const [version, shell] of Object.entries(SHELLS)) {
    assert.equal(shell.geometry.dataStart, 16 + align4(shell.geometry.headerSize),
      `${version}: dataStart must follow 16 + align4(headerSize)`);
  }
});

test('every registered release agrees on the split layout arithmetic', () => {
  // Table-level, so a future release cannot be registered with a `split` record
  // that was copy-pasted instead of measured. All of it is arithmetic over
  // numbers that a body edit cannot move, which is the whole reason the record is
  // allowed to exist in a shipped file.
  for (const [version, shell] of Object.entries(SHELLS)) {
    const split = shell.split;
    assert.equal(split.slotOffsetInMain, shell.stock.slotOffsetInMain, `${version}: the official slot does not move`);
    assert.equal(split.slotLength, shell.stock.slotLength, `${version}: the official slot keeps its length`);
    assert.equal(split.slotSha, shell.stock.slotSha, `${version}: the split layout leaves the slot pristine`);
    assert.equal(split.insertAtInMain, split.slotOffsetInMain + split.slotLength,
      `${version}: the region is inserted exactly where the official slot ends`);
    assert.equal(split.addedBytes, split.reserveBytes, `${version}: what grows is the reserve`);
    assert.equal(split.archiveSizeAfter, shell.geometry.size + split.reserveBytes,
      `${version}: archiveSizeAfter must be stock size plus the reserve`);
    assert.equal(split.mainSizeAfter, shell.geometry.mainSize + split.reserveBytes,
      `${version}: mainSizeAfter must be stock main size plus the reserve`);
    assert.ok(split.reserveBytes <= split.reserveLimit, `${version}: the reserve must stay inside the header boundary`);
    assert.equal(split.movedEntries, 29, `${version}: the same 29 trailing entries move`);
  }
});

test('real asar: size, header size, dataStart and flat entry count match the recorded geometry', { skip: shellGate() }, () => {
  const shell = currentShell();
  const current = realState();
  // The split layout is the ONE state that changes the archive size: it appends
  // the reserved region at EOF and grows `lib/main.js` in place. Everything else
  // in this test is layout-independent, so it stays asserted against stock.
  const expectedSize = current.layout === 'split' ? shell.split.archiveSizeAfter : shell.geometry.size;
  assert.equal(statSync(REAL_ASAR).size, expectedSize);

  const asar = openAsar(REAL_ASAR, { allowStaleMainIntegrity: true });
  assert.equal(asar.ok, true, asar.ok === true ? '' : `${asar.code}: ${asar.message}`);
  try {
    // The directory header is not touched by either layout: the split region is
    // appended, and the header keeps its exact byte length (that is the invariant
    // the uninstall path rests on).
    assert.equal(asar.headerSize, shell.geometry.headerSize);
    assert.equal(asar.dataStart, shell.geometry.dataStart);
    assert.equal(asar.entries.size, shell.geometry.entries);
    assert.equal(asar.fileSize, expectedSize);
    assert.ok(asar.entries instanceof Map);
    assert.notEqual(asar.mainEntry, null);
  } finally {
    closeAsar(asar);
  }
});

test('real asar: lib/main.js bytes match the digest expected for the current state', { skip: shellGate() }, async (t) => {
  const shell = currentShell();
  const current = realState();
  const expected = expectedForCurrentState();
  const asar = openAsar(REAL_ASAR, { allowStaleMainIntegrity: true });
  assert.equal(asar.ok, true, asar.ok === true ? '' : `${asar.code}: ${asar.message}`);
  try {
    const info = entryInfo(asar, 'lib/main.js');
    assert.notEqual(info, null);
    assert.equal(info.unpacked, false);

    const bytes = readEntry(asar, 'lib/main.js');
    assert.notEqual(bytes, null);
    assert.equal(info.offset, shell.geometry.mainOffset);

    // The directory digest is NOT updated by either write path — it always keeps
    // the stock value — so assert exactly that instead of claiming they match.
    assert.notEqual(info.integrity, null);
    assert.equal(info.integrity.algorithm, 'SHA256');
    assert.equal(info.integrity.hash, shell.stock.mainSha);

    if (current.layout === 'split') {
      // SIZE: stock main.js plus the region, which is the layout's arithmetic.
      assert.equal(info.size, shell.split.mainSizeAfter);
      assert.equal(bytes.length, shell.split.mainSizeAfter);

      // The official slot is still where it was and still hashes to the STOCK
      // slot digest: the split layout writes AFTER it, never into it.
      const located = locateRegion(asar);
      assert.equal(located.ok, true, located.ok === true ? '' : `${located.code}: ${located.message}`);
      assert.equal(located.startInMain, shell.split.slotOffsetInMain);
      assert.equal(located.length, shell.split.slotLength);
      assert.equal(located.sha256, shell.split.slotSha,
        'the official slot must stay byte-for-byte pristine in the split layout');

      // MANDATORY and never skipped: removing our region has to reproduce the
      // STOCK digest. That is the build-independent proof that the rest of
      // lib/main.js is untouched official bytes — it does not care what the
      // region says, so a region written by an older build still passes.
      const stripped = stripRegion(bytes, { startInMain: current.splitStartInMain, length: current.splitLength });
      assert.equal(stripped.length, shell.geometry.mainSize,
        'the stock main.js size must come back after removing the region');
      assert.equal(sha256Buffer(stripped), shell.stock.mainSha,
        'stripping our split region must reproduce the STOCK lib/main.js — the rest of the file must be official bytes');

      // The region must sit exactly where the layout says: right after the slot.
      assert.equal(current.splitStartInMain, shell.split.insertAtInMain);

      // BIRTH-DEPENDENT, so it may only ever SKIP: the region was produced by
      // `buildSplitRegion()` at install time, and that body changes between
      // builds. An install older than the current body is healthy, not broken —
      // the structural proof above already passed, so this is a "reinstall to
      // refresh" notice, not a defect.
      const regionBytes = bytes.subarray(current.splitStartInMain, current.splitStartInMain + current.splitLength);
      assert.equal(regionBytes.length, current.splitLength);
      if (!matchesCurrentBuild(regionBytes)) {
        t.skip(`已安装的区域早于当前构建，需要重装才能刷新（region sha ${current.splitSha256}，当前构建是 ${currentBuildRegionSha(current.splitLength)}）`);
        return;
      }
      assert.equal(current.splitSha256, currentBuildRegionSha(current.splitLength),
        'the installed region must be what the current build writes');
      return;
    }

    // SLOT layouts: sizes never move and the digest is recorded.
    assert.equal(info.size, shell.geometry.mainSize);
    assert.equal(bytes.length, shell.geometry.mainSize);
    assert.equal(sha256Buffer(bytes), expected.mainSha);

    // The streamed file helper must agree with the in-memory digest.
    const dir = scratchDir('reader-');
    try {
      const scratch = join(dir, 'main.js');
      writeFileSync(scratch, bytes);
      assert.equal(await sha256File(scratch), expected.mainSha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Absolute placement inside the archive: dataStart + entry offset.
    assert.equal(absoluteOffsetOf(asar, 'lib/main.js'), shell.geometry.mainAbsolute);
  } finally {
    closeAsar(asar);
  }
});

test('real asar: whole-file sha256 matches the digest of the current state', { skip: shellGate() }, async () => {
  const shell = currentShell();
  const current = realState();
  const expected = expectedForCurrentState();
  const actual = await sha256File(REAL_ASAR);

  if (current.layout !== 'split') {
    assert.equal(actual, expected.archiveSha);
    return;
  }

  // SPLIT: the whole-file digest CANNOT be predicted. It is a function of the
  // region bytes, and those come from `buildSplitRegion()` — an archive keeps
  // the body its install was born with, so a later body edit changes what a
  // FRESH install would hash to without changing anything about this file.
  // Comparing against any recorded digest would either hard-code one build's
  // output (wrong the moment the body is edited) or fail a healthy install.
  //
  // What CAN be asserted is the layout's arithmetic: the file is the stock
  // archive plus the reserve, and therefore it is NOT the stock archive.
  assert.equal(statSync(REAL_ASAR).size, shell.split.archiveSizeAfter);
  assert.equal(current.archiveSize, shell.split.archiveSizeAfter);
  assert.notEqual(actual, shell.archiveSha,
    'a split install must not hash like the stock archive — it carries our region');
  assert.match(actual, /^[0-9a-f]{64}$/);

  // Structural proof, so "the digest is unpredictable" is not an excuse for
  // "nothing was checked": the rest of lib/main.js is still official.
  const asar = openAsar(REAL_ASAR, { allowStaleMainIntegrity: true });
  assert.equal(asar.ok, true, asar.ok === true ? '' : `${asar.code}: ${asar.message}`);
  try {
    const bytes = readEntry(asar, 'lib/main.js');
    assert.equal(bytes.length, shell.split.mainSizeAfter);
    const stripped = stripRegion(bytes, { startInMain: current.splitStartInMain, length: current.splitLength });
    assert.equal(sha256Buffer(stripped), shell.stock.mainSha);
    const located = locateRegion(asar);
    assert.equal(located.ok === true ? located.sha256 : null, shell.split.slotSha);
  } finally {
    closeAsar(asar);
  }
});

test('real asar: package.json identifies the DSH desktop app', { skip: missingAsar }, () => {
  const asar = openAsar(REAL_ASAR, { allowStaleMainIntegrity: true });
  assert.equal(asar.ok, true, asar.ok === true ? '' : `${asar.code}: ${asar.message}`);
  try {
    const pkg = readRootPackage(asar);
    assert.notEqual(pkg, null);
    // package.json lives outside the patched region and is never touched, so
    // it still reports the release that is actually installed.
    assert.equal(pkg.name, '@deepseek-ai/dsh-desktop');
    assert.equal(pkg.version, currentVersion());
    assert.equal(pkg.main, 'lib/main.js');

    const text = readEntryText(asar, 'package.json');
    assert.equal(typeof text, 'string');
    assert.equal(JSON.parse(text).name, '@deepseek-ai/dsh-desktop');
  } finally {
    closeAsar(asar);
  }
});

test('real asar: the installed release is one this suite has been taught about', { skip: missingAsar }, () => {
  // The single loud failure that replaces the old "we only know rc.2" guesses:
  // it names the release and says exactly how to register it. Everything else
  // in this file skips on an unregistered release instead of comparing against
  // numbers from another version.
  const current = realState();
  assert.equal(current.present, true);
  assert.notEqual(current.version, null, `cannot read package.json.version from ${REAL_ASAR}`);
  assert.ok(
    KNOWN_VERSIONS.includes(current.version),
    `DSH desktop ${current.version} 没有登记这个版本 — 运行 node evidence/shell-facts.mjs 并把生成的表项贴到 pkg/test/real-asar.mjs 的 SHELLS 里（已知版本：${KNOWN_VERSIONS.join(', ')}）`,
  );
  assert.equal(current.unsupported, false);
});

test('real asar: absent and unpacked entries read as null', { skip: missingAsar }, () => {
  const asar = openAsar(REAL_ASAR, { allowStaleMainIntegrity: true });
  assert.equal(asar.ok, true, asar.ok === true ? '' : `${asar.code}: ${asar.message}`);
  try {
    assert.equal(readEntry(asar, 'no-such-file.js'), null);
    assert.equal(readEntryText(asar, 'no-such-file.js'), null);
    assert.equal(entryInfo(asar, 'no-such-file.js'), null);
    assert.equal(absoluteOffsetOf(asar, 'no-such-file.js'), null);

    const unpacked = [...asar.entries.entries()].find(([, entry]) => entry.unpacked === true);
    assert.ok(unpacked !== undefined, 'expected at least one unpacked entry in this build');
    const [path, entry] = unpacked;
    assert.equal(readEntry(asar, path), null);
    assert.equal(entryInfo(asar, path).unpacked, true);
    assert.equal(absoluteOffsetOf(asar, path), null);
  } finally {
    closeAsar(asar);
  }
});

test('real asar: the install is in a state this package understands', { skip: missingAsar }, () => {
  // The gate the other real-archive tests rely on. Three shapes are understood:
  // a pristine stock archive, an in-slot patch (proven by its recorded digest),
  // and the split layout (proven structurally — sizes, pristine official slot and
  // insertion point — because its digests depend on the build that wrote it).
  // A foreign or half-written archive fails here first, so the failure names the
  // real cause instead of "hash mismatch".
  const supported = realStateIsSupported();
  assert.equal(supported.ok, true, `state=${supported.state} layout=${supported.layout}: ${supported.reason}`);
  const current = realState();
  assert.ok(current.state === 'stock' || current.state === 'patched-by-us', `unexpected state: ${current.state} (${current.reason})`);
  const expected = expectedForCurrentState();
  assert.equal(expected.layout, current.layout, 'the expectation must name the layout it describes');

  if (current.layout === 'split') {
    const split = current.shell.split;
    // The structural claims, restated here because this is the gate test.
    assert.equal(current.archiveSize, split.archiveSizeAfter);
    assert.equal(current.mainSize, split.mainSizeAfter);
    assert.equal(current.regionSha, split.slotSha, 'the official slot must be the stock one');
    assert.equal(current.splitStartInMain, split.insertAtInMain);
    // `mainSha`/`archiveSha` are deliberately null here: those are the
    // birth-dependent digests, and `expectedForCurrentState` refuses to invent
    // them. The build-independent proof is done in the lib/main.js test above.
    assert.equal(expected.mainSha, null);
    assert.equal(expected.archiveSha, null);
  } else {
    assert.equal(current.mainSha, expected.mainSha);
  }
});

test('an unregistered release is reported as unsupported, not thrown', () => {
  // The whole point of the version table: a DSH release that nobody has taught
  // the suite about must produce a plain, readable answer. This is what makes
  // a future upgrade a "run evidence/shell-facts.mjs and paste the block"
  // chore instead of six failing assertions with another version's numbers.
  const dir = scratchDir('unknown-version-');
  try {
    const pkgBody = Buffer.from(
      JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '9.9.9-not-a-release', main: 'lib/main.js' }),
      'utf8',
    );
    const mainBody = Buffer.from('//#region lib/types/tray.js\nsome body\n//#endregion\n', 'utf8');
    const header = {
      files: {
        'package.json': {
          size: pkgBody.length,
          offset: 0,
          integrity: { algorithm: 'SHA256', hash: sha256Buffer(pkgBody), blockSize: 4194304, blocks: [sha256Buffer(pkgBody)] },
        },
        lib: {
          files: {
            'main.js': {
              size: mainBody.length,
              offset: pkgBody.length,
              integrity: { algorithm: 'SHA256', hash: sha256Buffer(mainBody), blockSize: 4194304, blocks: [sha256Buffer(mainBody)] },
            },
          },
        },
      },
    };
    const target = join(dir, 'app.asar');
    writeFileSync(target, buildSyntheticAsar({ header, data: Buffer.concat([pkgBody, mainBody]) }));

    const state = readState(target);
    assert.equal(state.present, true);
    assert.equal(state.state, 'unknown');
    assert.equal(state.unsupported, true);
    assert.equal(state.version, '9.9.9-not-a-release');
    assert.equal(state.shell, null);
    assert.equal(state.reason, UNREGISTERED_REASON);
    assert.equal(state.mainSha, null, 'an unsupported release must not be graded');
    assert.equal(resolveShell('9.9.9-not-a-release'), null);
    assert.equal(shellGateFor(state).includes('9.9.9-not-a-release'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openAsar on a missing path returns EASAR_MISSING instead of throwing', () => {
  const missing = join(COPY_DIR, 'definitely-missing-asar', 'app.asar');
  const result = openAsar(missing);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EASAR_MISSING');
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
});

test('openAsar on a truncated file returns EASAR_HEADER instead of throwing', () => {
  const dir = scratchDir('bad-');
  try {
    const bad = join(dir, 'app.asar');
    const bytes = Buffer.alloc(24);
    bytes.writeUInt32LE(0x7fffffff, 12); // header size far beyond the file
    writeFileSync(bad, bytes);
    const result = openAsar(bad);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EASAR_HEADER');
    assert.equal(typeof result.message, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openAsar rejects a synthetic asar whose data start is wrong', () => {
  // The directory claims one main.js digest but the data area holds other
  // bytes: this is exactly the "dataStart computed wrong" case.
  const dir = scratchDir('gate-');
  try {
    const mainBody = Buffer.from('//#region lib/types/tray.js\nstock body\n//#endregion\n', 'utf8');
    const wrongBody = Buffer.from(mainBody.toString('utf8').replace('stock body', 'other body'), 'utf8');

    const header = {
      files: {
        'package.json': {
          size: 24,
          offset: 0,
          integrity: { algorithm: 'SHA256', hash: sha256Buffer(Buffer.alloc(24)), blockSize: 4194304, blocks: [sha256Buffer(Buffer.alloc(24))] },
        },
        lib: {
          files: {
            'main.js': {
              size: mainBody.length,
              offset: 24,
              // digest of the bytes we are NOT writing
              integrity: { algorithm: 'SHA256', hash: sha256Buffer(mainBody), blockSize: 4194304, blocks: [sha256Buffer(mainBody)] },
            },
          },
        },
      },
    };
    const data = Buffer.concat([Buffer.from('{"name":"x"}'.padEnd(24, ' '), 'utf8'), wrongBody]);
    const target = join(dir, 'app.asar');
    writeFileSync(target, buildSyntheticAsar({ header, data }));

    const result = openAsar(target);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EASAR_HEADER');
    if (result.ok !== true) assert.match(result.message, /哈希|不一致/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a synthetic asar with a correct integrity digest opens fine', () => {
  // Sanity control for the gate above: same shape, matching digest.
  const dir = scratchDir('gate-ok-');
  try {
    const pkgBody = Buffer.from('{"name":"@deepseek-ai/dsh-desktop"}', 'utf8');
    const mainBody = Buffer.from('//#region lib/types/tray.js\nstock body\n//#endregion\n', 'utf8');
    const header = {
      files: {
        'package.json': {
          size: pkgBody.length,
          offset: 0,
          integrity: { algorithm: 'SHA256', hash: sha256Buffer(pkgBody), blockSize: 4194304, blocks: [sha256Buffer(pkgBody)] },
        },
        lib: {
          files: {
            'main.js': {
              size: mainBody.length,
              offset: pkgBody.length,
              integrity: { algorithm: 'SHA256', hash: sha256Buffer(mainBody), blockSize: 4194304, blocks: [sha256Buffer(mainBody)] },
            },
          },
        },
      },
    };
    const target = join(dir, 'app.asar');
    writeFileSync(target, buildSyntheticAsar({ header, data: Buffer.concat([pkgBody, mainBody]) }));

    const asar = openAsar(target);
    assert.equal(asar.ok, true, asar.ok === true ? '' : `${asar.code}: ${asar.message}`);
    try {
      assert.equal(asar.entries.size, 2);
      assert.equal(absoluteOffsetOf(asar, 'lib/main.js'), asar.dataStart + pkgBody.length);
      assert.equal(readEntryText(asar, 'package.json'), pkgBody.toString('utf8'));
    } finally {
      closeAsar(asar);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
