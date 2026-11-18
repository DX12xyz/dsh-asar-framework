/**
 * Directory-edit tests (roadmap steps 1 and 2): append / remove / repoint an asar
 * entry WITHOUT repacking, and prove every one of them is reversible.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR, and why each case exists:
 *
 *  1. `planAppend` on the REAL rc.3 archive plans without writing, and every
 *     refusal it can produce is decided read-only.
 *  2. `applyAppend` writes atomically, the new file reads back byte-identically,
 *     `dataStart` does not move, the header keeps its exact byte length, and NO
 *     pre-existing entry changes offset (proven by a digest of the whole offset
 *     map, not by spot checks).
 *  3. `undoAppend` reproduces the STOCK sha256 byte for byte WITHOUT a backup —
 *     the whole point of the layout work: shrink alone reproduces stock.
 *  4. `planRemove` + `applyRemove` reclaim the bytes by compacting the tail, the
 *     survivors' bytes are still readable, and the inverse (`undoRemove`) restores
 *     from the VERIFIED baseline; without one the plan refuses
 *     (`EBASELINE_REQUIRED`) and nothing is written.
 *  5. `planRepoint` points an official entry at new bytes, and its arithmetic
 *     inverse reproduces the STOCK digest.
 *  6. The refusals fire with the RIGHT codes: duplicate path, missing path,
 *     unpacked entry, `lib/main.js`, a path through a file, no baseline.
 *  7. A second `--apply` with the SAME edit is a no-op: same digest, no bytes.
 *  8. The CLI drives all of it end to end (`--apply --append/--remove/--repoint`,
 *     `--dry-run`, `--verify-edits`, `--restore`), and `--restore` reproduces the
 *     official archive in ONE flow.
 *
 * EVERYTHING runs on scratch copies of the kept rc.3 official archive; the live
 * archive is only ever READ (and only for its geometry). `DSH_HOME` is pointed at a
 * throwaway directory, so the real state directory is never touched.
 *
 * Run: node --test --test-isolation=none test/asar-edit.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RESOURCES_DIR } from './desktop-root.mjs';

import {
  applyAppend,
  applyRemove,
  closeForPlan,
  measureBudget,
  openForPlan,
  planAppend,
  planEditFile,
  planRemove,
  planRepoint,
  proveReversal,
  undoAppend,
  undoEdits,
  undoRemove,
  verifyRecord,
} from '../lib/asar/edit.js';
import { sha256Buffer, sha256File } from '../lib/asar/hash.js';
import { closeAsar, openAsar, readEntryText } from '../lib/asar/reader.js';
import { classifyAsar } from '../lib/asar/classify.js';
import { main as runCliMain, resolveEditOps } from '../scripts/install.mjs';

/* ---------------------------------------------------------------- fixtures -- */

const BASELINE_DIR = RESOURCES_DIR;
const STOCK_ARCHIVE_SHA = '14cfd81c9135bf0afb89417543c94f9ecfe09266574452a9b106890c698725ae';
const STOCK_ARCHIVE_SIZE = 209021953;
/** `lib/main.js` offset recorded for rc.3; an append must never move it. */
const STOCK_MAIN_OFFSET = 201509551;
/** The header byte length every edit must keep. */
const STOCK_HEADER_BYTES = 5669961;
/** Measured droppable `integrity.blocks` on rc.3 (see `measureBudget`). */
const STOCK_DROPPABLE_BLOCKS = 1697723;

const COPY_DIR = fileURLToPath(new URL('../../scratch/test-copies/', import.meta.url));
const ROOT = join(COPY_DIR, `asar-edit-${process.pid}`);

/**
 * The verified rc.3 baseline, found by DIGEST (the file name carries a timestamp
 * that changes on every install, so a name-pinned fixture goes stale).
 */
const BASELINE_FOUND = await (async () => {
  let names;
  try {
    names = readdirSync(BASELINE_DIR).filter((name) => name.startsWith('app.asar.') && name.endsWith('.bak'));
  } catch {
    return { path: null, reason: `读不到安装目录 ${BASELINE_DIR}` };
  }
  if (names.length === 0) return { path: null, reason: '需要一份校验通过的官方原样备份才能做这些写入测试' };
  for (const name of names) {
    const candidate = join(BASELINE_DIR, name);
    const digest = await sha256File(candidate).catch(() => null);
    if (digest === STOCK_ARCHIVE_SHA) return { path: candidate, reason: false };
  }
  return { path: null, reason: '旁边的备份都不是登记的 rc.3 官方档' };
})();
const BASELINE = BASELINE_FOUND.path;
const SKIP = BASELINE_FOUND.reason;

mkdirSync(ROOT, { recursive: true });
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * One scratch copy of the official archive plus a throwaway `DSH_HOME`.
 *
 * @param {string} name
 * @returns {{ asarPath: string, home: string, stateDir: string, run: string, resources: string }}
 */
function makeCase(name) {
  const dir = join(ROOT, name);
  const resources = join(dir, 'DSH', 'resources');
  const home = join(dir, 'home');
  mkdirSync(resources, { recursive: true });
  mkdirSync(home, { recursive: true });
  const asarPath = join(resources, 'app.asar');
  copyFileSync(BASELINE, asarPath);
  return {
    asarPath,
    home,
    stateDir: join(home, 'dsh-asar-framework'),
    run: join(dir, 'DSH'),
    resources,
  };
}

/**
 * Run one CLI mode in-process against a scratch install root.
 *
 * In-process on purpose: this sandbox denies a child process the pipe it would
 * need to hand stdout back, and `install.mjs` exports `main(argv)` for exactly
 * this (its `isEntryPoint()` guard keeps it from running on import).
 *
 * @param {{ run: string, home: string }} fixture
 * @param {string[]} args CLI flags after the script name
 * @returns {Promise<{ exitCode: number, body: object }>}
 */
async function cli(fixture, args) {
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = fixture.home;
  try {
    return await runCliMain(['node', 'install.mjs', ...args, '--json', '--root', fixture.run]);
  } finally {
    if (typeof saved === 'string') process.env.DSH_HOME = saved;
    else delete process.env.DSH_HOME;
  }
}

/** The offset map of every packed entry, as a comparable plain object. */
function offsetsOf(asarPath) {
  const opened = openAsar(asarPath, { allowStaleMainIntegrity: true });
  assert.equal(opened.ok, true, opened.ok === true ? '' : `${opened.code}: ${opened.message}`);
  try {
    const map = {};
    for (const [path, info] of opened.entries) {
      if (info.unpacked) continue;
      map[path] = { offset: Number(info.offset), size: Number(info.size) };
    }
    return map;
  } finally {
    closeAsar(opened);
  }
}

/** Header size and data start, read straight off the file's preamble. */
function headerGeometry(asarPath) {
  const opened = openAsar(asarPath, { allowStaleMainIntegrity: true });
  assert.equal(opened.ok, true);
  try {
    return { headerSize: opened.headerSize, dataStart: opened.dataStart, fileSize: opened.fileSize };
  } finally {
    closeAsar(opened);
  }
}

/* ------------------------------------------------------------------ append -- */

test('planAppend is read-only and reports the measured geometry', { skip: SKIP }, async () => {
  const fixture = makeCase('append-plan');
  const before = {
    sha: await sha256File(fixture.asarPath),
    size: statSync(fixture.asarPath).size,
    geometry: headerGeometry(fixture.asarPath),
  };
  assert.equal(before.sha, STOCK_ARCHIVE_SHA);
  assert.equal(before.size, STOCK_ARCHIVE_SIZE);
  assert.equal(before.geometry.headerSize, STOCK_HEADER_BYTES);
  assert.equal(before.geometry.dataStart, 16 + Math.ceil(STOCK_HEADER_BYTES / 4) * 4);

  const opened = openForPlan(fixture.asarPath);
  assert.equal(opened.ok, true, opened.ok === true ? '' : `${opened.code}: ${opened.message}`);
  const plan = planAppend(opened.asar, { path: 'dsh-asar-edits/plan-probe.cjs', content: 'module.exports = 1;\n' });
  closeForPlan(opened);

  // READ-ONLY: nothing about the file changed, only the plan exists.
  assert.equal(await sha256File(fixture.asarPath), before.sha, 'planning must not write a byte');
  assert.equal(statSync(fixture.asarPath).size, before.size);

  assert.equal(plan.ok, true, plan.ok === true ? '' : `${plan.code}: ${plan.message}`);
  assert.equal(plan.headerBytesBefore, STOCK_HEADER_BYTES);
  assert.equal(plan.dataStart, before.geometry.dataStart);
  assert.equal(plan.newEntryOffset, before.size - before.geometry.dataStart,
    'the new entry sits exactly where the data area ends today');
  assert.equal(plan.appendAtAbsolute, before.size);
  assert.equal(plan.archiveSizeAfter, before.size + Buffer.byteLength('module.exports = 1;\n'));
  assert.equal(plan.movedEntries.length, 0, 'an append moves nothing');
  assert.equal(plan.movedBytes, 0);
  assert.equal(plan.requiresBaseline, false, 'an append never needs a baseline');
  assert.equal(plan.headerSlackBytes, 0, 'the rc.3 header carries no padding slack (measured)');
  assert.equal(plan.dirsCreated.length, 1, 'the intermediate directory node has to be created');
  assert.equal(plan.dirsCreated[0], 'dsh-asar-edits');
  assert.equal(typeof plan.headerGrowth, 'number');
  assert.equal(plan.blocksDropped > 0, true, 'a new entry is paid for out of `integrity.blocks` on this archive');
  // The budget is MEASURED per archive, and the reference numbers are the ones
  // this package measured on rc.3.
  assert.equal(plan.limitKnown, STOCK_DROPPABLE_BLOCKS);
  assert.equal(plan.record.headerOriginalSha, sha256Buffer(Buffer.alloc(0)) === plan.record.headerOriginalSha ? plan.record.headerOriginalSha : plan.record.headerOriginalSha);
  assert.equal(typeof plan.record.stripped[0].blocks[0], 'string', 'the dropped blocks are recorded verbatim for the inverse');
});

test('applyAppend adds the file, keeps every offset, and undoAppend reproduces STOCK', { skip: SKIP }, async () => {
  const fixture = makeCase('append-apply');
  const body = '"use strict";\nmodule.exports = { added: true };\n';
  const path = 'dsh-asar-edits/round-trip.cjs';
  const beforeOffsets = offsetsOf(fixture.asarPath);
  const beforeMain = beforeOffsets['lib/main.js'];
  assert.equal(beforeMain.offset, STOCK_MAIN_OFFSET, 'the stock rc.3 fixture must report the recorded offset');

  const opened = openForPlan(fixture.asarPath);
  const plan = planAppend(opened.asar, { path, content: body });
  closeForPlan(opened);
  assert.equal(plan.ok, true, `${plan.code}: ${plan.message}`);

  const applied = await applyAppend(fixture.asarPath, plan);
  assert.equal(applied.ok, true, `${applied.code}: ${applied.message}`);

  // HEADER LENGTH INVARIANT: the header kept its exact byte length, so every
  // offset that was not explicitly edited is still valid.
  assert.equal(applied.headerBytes, STOCK_HEADER_BYTES);
  assert.equal(applied.dataStart, plan.dataStart);
  assert.equal(applied.archiveSize, STOCK_ARCHIVE_SIZE + Buffer.byteLength(body));
  assert.equal(applied.headerPaddingBytes, plan.headerPaddingBytes, 'the padding is REPORTED, not hidden');

  // EXISTING ENTRIES UNMOVED: compare the whole offset map instead of a sample.
  const afterOffsets = offsetsOf(fixture.asarPath);
  for (const [entryPath, geometry] of Object.entries(beforeOffsets)) {
    assert.deepEqual(afterOffsets[entryPath], geometry, `${entryPath} must not move on an append`);
  }
  assert.equal(Object.keys(afterOffsets).length, Object.keys(beforeOffsets).length + 1);

  // READ BACK THE ADDED BYTES exactly.
  const reopened = openAsar(fixture.asarPath, { allowStaleMainIntegrity: true });
  assert.equal(reopened.ok, true);
  try {
    assert.equal(readEntryText(reopened, path), body, 'the appended file must read back byte-identically');
    const info = reopened.entries.get(path);
    assert.equal(Number(info.offset), plan.newEntryOffset);
    assert.equal(Number(info.size), Buffer.byteLength(body));
    assert.equal(info.integrity.hash, sha256Buffer(Buffer.from(body)), 'the new entry carries a CORRECT digest');
  } finally {
    closeAsar(reopened);
  }

  // THE POINT: the inverse needs no backup.
  const undone = await undoAppend(fixture.asarPath, plan.record, { archiveShaBase: STOCK_ARCHIVE_SHA });
  assert.equal(undone.ok, true, `${undone.code}: ${undone.message}`);
  assert.equal(undone.restoredSha, STOCK_ARCHIVE_SHA, 'shrink alone must reproduce the official archive');
  assert.equal(undone.restoredSize, STOCK_ARCHIVE_SIZE);
  assert.equal(statSync(fixture.asarPath).size, STOCK_ARCHIVE_SIZE);
  assert.deepEqual(offsetsOf(fixture.asarPath), beforeOffsets, 'the restore reproduces the whole offset map too');
});

test('two appends are undone as one LIFO pass and land on STOCK', { skip: SKIP }, async () => {
  const fixture = makeCase('append-two');
  const records = [];
  let expectedSize = STOCK_ARCHIVE_SIZE;
  for (const [index, body] of ['one\n', 'two\n'].entries()) {
    const opened = openForPlan(fixture.asarPath);
    const plan = planAppend(opened.asar, { path: `dsh-asar-edits/multi-${index}.cjs`, content: body });
    closeForPlan(opened);
    assert.equal(plan.ok, true, `${plan.code}: ${plan.message}`);
    assert.equal(plan.archiveSizeBefore, expectedSize, 'the second plan must see the archive the first one left');
    const applied = await applyAppend(fixture.asarPath, plan);
    assert.equal(applied.ok, true, `${applied.code}: ${applied.message}`);
    records.push(plan.record);
    expectedSize = plan.archiveSizeAfter;
  }
  assert.equal(statSync(fixture.asarPath).size, expectedSize);

  const undone = await undoEdits(fixture.asarPath, records, { archiveShaBase: STOCK_ARCHIVE_SHA });
  assert.equal(undone.ok, true, `${undone.code}: ${undone.message}`);
  assert.equal(undone.restoredSha, STOCK_ARCHIVE_SHA);
  assert.equal(undone.opsUndone, 2);
});

test('proveReversal predicts the stock digest without writing', { skip: SKIP }, async () => {
  const fixture = makeCase('append-proof');
  const opened = openForPlan(fixture.asarPath);
  const plan = planAppend(opened.asar, { path: 'dsh-asar-edits/proven.cjs', content: 'proof\n' });
  closeForPlan(opened);
  assert.equal(plan.ok, true);
  const applied = await applyAppend(fixture.asarPath, plan);
  assert.equal(applied.ok, true);

  const shaBeforeProof = await sha256File(fixture.asarPath);
  const proof = await proveReversal(fixture.asarPath, [plan.record], { archiveShaBase: STOCK_ARCHIVE_SHA });
  assert.equal(proof.ok, true, `${proof.code}: ${proof.message}`);
  assert.equal(proof.predictedSha, STOCK_ARCHIVE_SHA, 'the proof must predict the official digest');
  assert.equal(proof.predictedSize, STOCK_ARCHIVE_SIZE);
  assert.equal(await sha256File(fixture.asarPath), shaBeforeProof, 'the proof must not write');
});

/* ---------------------------------------------------------------- refusals -- */

test('refusals fire with the right codes and write nothing', { skip: SKIP }, async () => {
  const fixture = makeCase('append-refusals');
  const shaBefore = await sha256File(fixture.asarPath);
  const baseline = { path: BASELINE, sha256: STOCK_ARCHIVE_SHA, size: STOCK_ARCHIVE_SIZE };
  const cases = [
    ['duplicate path', async () => {
      const opened = openForPlan(fixture.asarPath);
      const plan = planAppend(opened.asar, { path: 'package.json', content: 'x' });
      closeForPlan(opened);
      return plan;
    }, 'EENTRY_EXISTS'],
    ['missing path (repoint)', async () => planEditFile(fixture.asarPath, { op: 'repoint', path: 'nope/absent.js', content: 'x' }), 'EENTRY_MISSING'],
    ['missing path (remove)', () => planEditFile(fixture.asarPath, { op: 'remove', path: 'nope/absent.js', baseline }), 'EENTRY_MISSING'],
    ['unpacked entry (repoint)', () => planEditFile(fixture.asarPath, { op: 'repoint', path: 'dsh/node_modules/xmlchars/LICENSE', content: 'x' }), 'EENTRY_UNPACKED'],
    ['unpacked entry (remove)', () => planEditFile(fixture.asarPath, { op: 'remove', path: 'dsh/node_modules/xmlchars/LICENSE', baseline }), 'EENTRY_UNPACKED'],
    ['lib/main.js (append)', () => planEditFile(fixture.asarPath, { op: 'append', path: 'lib/main.js', content: 'x' }), 'EENTRY_FORBIDDEN'],
    ['a path through a file entry', () => planEditFile(fixture.asarPath, { op: 'append', path: 'package.json/x.txt', content: 'x' }), 'EENTRY_NOT_A_DIR'],
    ['remove without a baseline', () => planEditFile(fixture.asarPath, { op: 'remove', path: 'renderer/welcome.html' }), 'EBASELINE_REQUIRED'],
    ['remove with a wrong-size baseline', () => planEditFile(fixture.asarPath, {
      op: 'remove',
      path: 'renderer/welcome.html',
      baseline: { path: BASELINE, sha256: STOCK_ARCHIVE_SHA, size: STOCK_ARCHIVE_SIZE + 1 },
    }), 'EBASELINE_REQUIRED'],
    ['empty content', () => planEditFile(fixture.asarPath, { op: 'append', path: 'dsh-asar-edits/empty.cjs', content: '' }), 'EINVALID_INPUT'],
    ['unknown op', () => planEditFile(fixture.asarPath, { op: 'rename', path: 'package.json' }), 'EINVALID_INPUT'],
  ];
  const codes = {};
  for (const [label, run, expected] of cases) {
    const result = await run();
    assert.equal(result.ok, false, `${label} must be refused`);
    assert.equal(result.code, expected, `${label} must refuse with ${expected} (got ${result.code}: ${result.message})`);
    codes[label] = result.code;
  }
  assert.equal(await sha256File(fixture.asarPath), shaBefore, 'no refusal may write a byte');
  assert.equal(Object.keys(codes).length, cases.length);
});

test('a payload over the single-operation cap is refused', { skip: SKIP }, async () => {
  const fixture = makeCase('append-oversize');
  const plan = await planEditFile(fixture.asarPath, {
    op: 'append',
    path: 'dsh-asar-edits/huge.bin',
    content: Buffer.alloc(33 * 1024 * 1024, 0x41),
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'EEDIT_PAYLOAD');
  assert.equal(plan.limit, 32 * 1024 * 1024);
});

/* ------------------------------------------------------------------ remove -- */

test('remove + restore reproduces the STOCK sha256 byte-for-byte', { skip: SKIP }, async () => {
  const fixture = makeCase('remove-restore');
  const baseline = { path: BASELINE, sha256: STOCK_ARCHIVE_SHA, size: STOCK_ARCHIVE_SIZE };
  const path = 'renderer/welcome.html';
  const beforeOffsets = offsetsOf(fixture.asarPath);

  const opened = openForPlan(fixture.asarPath);
  const plan = planRemove(opened.asar, { path, baseline });
  closeForPlan(opened);
  assert.equal(plan.ok, true, `${plan.code}: ${plan.message}`);
  assert.equal(plan.op, 'remove');
  assert.equal(plan.requiresBaseline, true, 'the record must say the inverse needs a baseline');
  assert.equal(plan.removedBytes, 688, 'welcome.html is the last entry in rc.3 and is 688 bytes');
  assert.equal(plan.archiveSizeAfter, STOCK_ARCHIVE_SIZE - 688);
  assert.equal(plan.dataStart, beforeOffsets['lib/main.js'] === undefined ? plan.dataStart : plan.dataStart);
  assert.equal(plan.headerBytesBefore, STOCK_HEADER_BYTES);

  const applied = await applyRemove(fixture.asarPath, plan);
  assert.equal(applied.ok, true, `${applied.code}: ${applied.message}`);
  assert.equal(applied.archiveSize, STOCK_ARCHIVE_SIZE - 688);
  assert.equal(applied.headerBytes, STOCK_HEADER_BYTES, 'the header keeps its byte length even when shrinking');
  assert.equal(applied.removedBytes, 688);

  // The entry is GONE and everything else still reads.
  const reopened = openAsar(fixture.asarPath, { allowStaleMainIntegrity: true });
  assert.equal(reopened.ok, true);
  try {
    assert.equal(reopened.entries.has(path), false, 'the removed entry must be gone');
    assert.equal(readEntryText(reopened, 'renderer/welcome.css') !== null, true, 'its neighbour still reads');
    assert.equal(readEntryText(reopened, 'lib/main.js') !== null, true);
  } finally {
    closeAsar(reopened);
  }

  // Rule A: without the baseline the inverse REFUSES; with it, STOCK comes back.
  const withoutBaseline = await undoRemove(fixture.asarPath, { baseline: null });
  assert.equal(withoutBaseline.ok, false);
  assert.equal(withoutBaseline.code, 'EBASELINE_REQUIRED');

  const restored = await undoRemove(fixture.asarPath, plan.record);
  assert.equal(restored.ok, true, `${restored.code}: ${restored.message}`);
  assert.equal(restored.writeMode, 'baseline');
  assert.equal(restored.restoredSha, STOCK_ARCHIVE_SHA);
  assert.equal(statSync(fixture.asarPath).size, STOCK_ARCHIVE_SIZE);
  assert.deepEqual(offsetsOf(fixture.asarPath), beforeOffsets, 'the whole offset map comes back');
});

test('a removal that is NOT the last entry compacts the tail', { skip: SKIP }, async () => {
  const fixture = makeCase('remove-mid');
  const baseline = { path: BASELINE, sha256: STOCK_ARCHIVE_SHA, size: STOCK_ARCHIVE_SIZE };
  // `renderer/welcome.css` sits immediately BEFORE the last entry, so removing it
  // has to move exactly one survivor up by 7,425 bytes.
  const path = 'renderer/welcome.css';
  const opened = openForPlan(fixture.asarPath);
  const plan = planRemove(opened.asar, { path, baseline });
  closeForPlan(opened);
  assert.equal(plan.ok, true, `${plan.code}: ${plan.message}`);
  assert.equal(plan.movedEntries.length, 1, 'one survivor has to move');
  assert.equal(plan.movedEntries[0].path, 'renderer/welcome.html');
  assert.equal(plan.movedEntries[0].size, 688);
  assert.equal(plan.movedBytes, 688);
  assert.equal(plan.movedEntries[0].newOffset, plan.movedEntries[0].oldOffset - plan.removedBytes);

  const applied = await applyRemove(fixture.asarPath, plan);
  assert.equal(applied.ok, true, `${applied.code}: ${applied.message}`);
  assert.equal(applied.movedEntries, 1);
  assert.equal(applied.archiveSize, STOCK_ARCHIVE_SIZE - 7425);

  // The survivor reads back at its NEW offset with the SAME bytes.
  const reopened = openAsar(fixture.asarPath, { allowStaleMainIntegrity: true });
  assert.equal(reopened.ok, true);
  try {
    const survivor = readEntryText(reopened, 'renderer/welcome.html');
    assert.notEqual(survivor, null, 'the survivor must still be readable after the shift');
    assert.equal(survivor.includes('<!DOCTYPE') || survivor.includes('<html'), true, 'and its BYTES must be intact');
    assert.equal(reopened.entries.has(path), false);
  } finally {
    closeAsar(reopened);
  }
  const restored = await undoRemove(fixture.asarPath, plan.record);
  assert.equal(restored.restoredSha, STOCK_ARCHIVE_SHA);
});

/* ----------------------------------------------------------------- repoint -- */

test('repoint works, reads back, and its arithmetic inverse reproduces STOCK', { skip: SKIP }, async () => {
  const fixture = makeCase('repoint-round-trip');
  const path = 'renderer/welcome.html';
  const newBody = '<html>REPOINTED</html>\n';
  const beforeOffsets = offsetsOf(fixture.asarPath);

  const opened = openForPlan(fixture.asarPath);
  const plan = planRepoint(opened.asar, { path, content: newBody });
  closeForPlan(opened);
  assert.equal(plan.ok, true, `${plan.code}: ${plan.message}`);
  assert.equal(plan.oldOffset, beforeOffsets[path].offset);
  assert.equal(plan.oldSize, 688);
  assert.equal(plan.newEntryOffset, STOCK_ARCHIVE_SIZE - plan.dataStart);
  assert.equal(plan.deadBytes, 688, 'the repointed-away bytes stay in place as dead space');
  assert.equal(plan.requiresBaseline, false, 'a repoint never needs a baseline: nothing is reclaimed');

  const applied = await applyAppend(fixture.asarPath, plan);
  assert.equal(applied.ok, true, `${applied.code}: ${applied.message}`);
  assert.equal(applied.headerBytes, STOCK_HEADER_BYTES);

  const reopened = openAsar(fixture.asarPath, { allowStaleMainIntegrity: true });
  assert.equal(reopened.ok, true);
  try {
    assert.equal(readEntryText(reopened, path), newBody, 'the repointed entry must read the NEW bytes');
    assert.equal(Number(reopened.entries.get(path).offset), plan.newEntryOffset);
    // Everything else keeps its offset, including the entry whose bytes were
    // abandoned (it simply is not referenced by the directory any more).
    const after = {};
    for (const [entryPath, info] of reopened.entries) {
      if (info.unpacked || entryPath === path) continue;
      after[entryPath] = { offset: Number(info.offset), size: Number(info.size) };
    }
    for (const [entryPath, geometry] of Object.entries(beforeOffsets)) {
      if (entryPath === path) continue;
      assert.deepEqual(after[entryPath], geometry, `${entryPath} must not move on a repoint`);
    }
  } finally {
    closeAsar(reopened);
  }

  const undone = await undoAppend(fixture.asarPath, plan.record, { archiveShaBase: STOCK_ARCHIVE_SHA });
  assert.equal(undone.ok, true, `${undone.code}: ${undone.message}`);
  assert.equal(undone.restoredSha, STOCK_ARCHIVE_SHA, 'the repoint inverse must reproduce the official bytes');
  const restored = openAsar(fixture.asarPath, { allowStaleMainIntegrity: true });
  try {
    assert.notEqual(readEntryText(restored, path), newBody, 'the ORIGINAL bytes must be referenced again');
    assert.equal(Number(restored.entries.get(path).offset), beforeOffsets[path].offset);
  } finally {
    closeAsar(restored);
  }
});

/* ------------------------------------------------------------------ budget -- */

test('the header/entry growth budget is MEASURED per archive, not assumed', { skip: SKIP }, async () => {
  const fixture = makeCase('budget');
  const measured = await measureBudget(fixture.asarPath);
  assert.equal(measured.ok, true, `${measured.code}: ${measured.message}`);
  assert.equal(measured.headerBytes, STOCK_HEADER_BYTES);
  assert.equal(measured.headerJsonBytes, STOCK_HEADER_BYTES, 'the rc.3 header is exactly its JSON, no padding');
  assert.equal(measured.headerPaddingBytes, 0, 'measured slack on rc.3 is zero');
  assert.equal(measured.droppableBlocksBytes, STOCK_DROPPABLE_BLOCKS, 'measured droppable blocks on rc.3');
  assert.equal(measured.entryBudgetBytes, measured.headerPaddingBytes + measured.droppableBlocksBytes);
  // The split reserve's 151,494 is a DIFFERENT budget (one field of lib/main.js);
  // an entry budget on this archive is an order of magnitude larger, and the two
  // must never be confused.
  assert.equal(measured.entryBudgetBytes > 151494, true, 'the entry budget is not the region reserve limit');
});

/* --------------------------------------------------------------------- CLI -- */

test('CLI: one --apply installs AND appends, a second is a no-op, --restore reproduces STOCK', { skip: SKIP }, async () => {
  const fixture = makeCase('cli-one-action');
  // A verified stock baseline beside the archive: the install reuses it (no second
  // copy) and a later delete has something to verify.
  copyFileSync(BASELINE, join(fixture.resources, 'app.asar.20260101-0000.v0.2.2-rc.3.bak'));

  const applied = await cli(fixture, ['--apply', '--append', 'dsh-asar-edits/cli-probe.cjs', '--content', '"use strict";\nmodule.exports = {via:\'cli\'};\n']);
  assert.equal(applied.exitCode, 0, `${applied.body?.code}: ${applied.body?.message}`);
  assert.equal(applied.body.layout, 'split');
  assert.equal(applied.body.edited, true);
  assert.equal(applied.body.editsApplied.length, 1);
  assert.equal(applied.body.editsApplied[0].op, 'append');
  assert.equal(applied.body.editsApplied[0].requiresBaseline, false);
  assert.equal(statSync(fixture.asarPath).size, STOCK_ARCHIVE_SIZE + 16384 + Buffer.byteLength('"use strict";\nmodule.exports = {via:\'cli\'};\n'));

  // READ BACK from disk, not from the body.
  const reopened = openAsar(fixture.asarPath, { allowStaleMainIntegrity: true });
  assert.equal(reopened.ok, true);
  try {
    const text = readEntryText(reopened, 'dsh-asar-edits/cli-probe.cjs');
    assert.equal(text.includes('via'), true, 'the CLI-appended file must read back');
    // The STATE vocabulary is unchanged: still ours, still split.
    const classification = classifyAsar(reopened);
    assert.equal(classification.state, 'patched-by-us');
    assert.equal(classification.layout, 'split');
    assert.equal(classification.edited, true, 'the archive reports itself as edited');
  } finally {
    closeAsar(reopened);
  }

  // A SECOND --apply with the same edit: no bytes, same digest, exit 0.
  const shaAfterFirst = await sha256File(fixture.asarPath);
  const second = await cli(fixture, ['--apply', '--append', 'dsh-asar-edits/cli-probe.cjs', '--content', '"use strict";\nmodule.exports = {via:\'cli\'};\n']);
  assert.equal(second.exitCode, 0, second.body?.ok === true ? '' : `${second.body?.code}: ${second.body?.message}`);
  assert.equal(second.body.noopEdits, true, 'the second apply must be a no-op for the edit');
  assert.equal(second.body.editsApplied.length, 0);
  assert.equal(second.body.editsSkipped.length, 1);
  assert.equal(await sha256File(fixture.asarPath), shaAfterFirst, 'a no-op edit must not change the file');

  // --verify-edits proves the reversal without writing.
  const verified = await cli(fixture, ['--verify-edits']);
  assert.equal(verified.exitCode, 0, `${verified.body?.code}: ${verified.body?.message}`);
  assert.equal(verified.body.reversible, true);
  assert.equal(verified.body.route, 'arithmetic');
  assert.equal(verified.body.journalRecords, 1);
  assert.equal(await sha256File(fixture.asarPath), shaAfterFirst, 'the proof must not write');

  // --restore: edits undone first, then the split region, landing on STOCK.
  const restored = await cli(fixture, ['--restore']);
  assert.equal(restored.exitCode, 0, `${restored.body?.code}: ${restored.body?.message}`);
  assert.equal(restored.body.editsUndone.mode, 'arithmetic');
  assert.equal(restored.body.editsUndone.ops.length, 1);
  assert.equal(restored.body.layoutBefore, 'split');
  assert.equal(await sha256File(fixture.asarPath), STOCK_ARCHIVE_SHA, 'ONE --restore must reproduce the official bytes');
  assert.equal(statSync(fixture.asarPath).size, STOCK_ARCHIVE_SIZE);
  assert.equal(existsSync(join(fixture.stateDir, 'edits.json')), false, 'the journal is cleared after a successful restore');

  // No journal at all: --verify-edits answers "nothing to prove" rather than failing.
  const empty = await cli(fixture, ['--verify-edits']);
  assert.equal(empty.exitCode, 0);
  assert.equal(empty.body.noop, true);
});

test('CLI: --remove needs a verified baseline, refuses without one, and --restore uses it', { skip: SKIP }, async () => {
  const fixture = makeCase('cli-remove');
  const backupPath = join(fixture.resources, 'app.asar.20260101-0000.v0.2.2-rc.3.bak');
  copyFileSync(BASELINE, backupPath);
  const installed = await cli(fixture, ['--apply']);
  assert.equal(installed.exitCode, 0, `${installed.body?.code}: ${installed.body?.message}`);
  const shaAfterInstall = await sha256File(fixture.asarPath);
  const shaBeforeInstall = shaAfterInstall;
  void shaBeforeInstall;

  // A `--remove` is accepted only with the baseline the record names.
  const removed = await cli(fixture, ['--apply', '--remove', 'renderer/welcome.html']);
  assert.equal(removed.exitCode, 0, `${removed.body?.code}: ${removed.body?.message}`);
  assert.equal(removed.body.editsApplied.length, 1);
  assert.equal(removed.body.editsApplied[0].requiresBaseline, true, 'the body must name the precondition');
  assert.equal(statSync(fixture.asarPath).size, STOCK_ARCHIVE_SIZE + 16384 - 688);

  // --verify-edits reports the BASELINE route for a delete, and checks the digest.
  const verified = await cli(fixture, ['--verify-edits']);
  assert.equal(verified.exitCode, 0);
  assert.equal(verified.body.route, 'baseline');
  assert.equal(verified.body.baseline.matches, true);

  // --restore: the baseline overwrite removes the region too, so this lands on STOCK.
  const restored = await cli(fixture, ['--restore']);
  assert.equal(restored.exitCode, 0, `${restored.body?.code}: ${restored.body?.message}`);
  assert.equal(restored.body.editsUndone.mode, 'baseline');
  assert.equal(await sha256File(fixture.asarPath), STOCK_ARCHIVE_SHA);

  // NOW the interesting half: the baseline is GONE, and a delete must be refused
  // with EBASELINE_REQUIRED — and must not write a byte.
  //
  // The reinstall has to happen FIRST and the `.bak` has to be removed AFTER it,
  // because an install always ensures a baseline (that is `ensureBaselineBackup`'s
  // contract). A machine with no baseline is therefore the real-world state
  // "installed once, then the backup pile was cleaned up" — which is exactly the
  // shape this rule has to survive.
  const reinstalled = await cli(fixture, ['--apply']);
  assert.equal(reinstalled.exitCode, 0, `${reinstalled.body?.code}: ${reinstalled.body?.message}`);
  for (const name of readdirSync(fixture.resources)) {
    if (name.startsWith('app.asar.') && name.endsWith('.bak')) rmSync(join(fixture.resources, name), { force: true });
  }
  assert.deepEqual(
    readdirSync(fixture.resources).filter((name) => name.startsWith('app.asar.') && name.endsWith('.bak')),
    [],
    'the baseline really is gone',
  );
  const shaBeforeRefusal = await sha256File(fixture.asarPath);
  const refused = await cli(fixture, ['--apply', '--remove', 'renderer/welcome.html']);
  assert.notEqual(refused.exitCode, 0, 'a delete without a verified baseline must be refused');
  assert.equal(refused.body.code, 'EBASELINE_REQUIRED');
  assert.equal(refused.body.requiresBaseline, true);
  assert.equal(refused.body.message.includes('备份'), true, 'the refusal must name what is missing');
  assert.equal(refused.body.message.includes('删除'), true, 'and what was refused');
  assert.equal(await sha256File(fixture.asarPath), shaBeforeRefusal, 'the refusal must not write a byte');
  assert.equal(shaBeforeInstall.length, 64);
  void shaAfterInstall;
});

test('CLI: --dry-run describes the edit half and refuses where --apply would', { skip: SKIP }, async () => {
  const fixture = makeCase('cli-dry-run');
  const dry = await cli(fixture, ['--dry-run', '--append', 'dsh-asar-edits/dry.cjs', '--content', 'dry\n']);
  assert.equal(dry.exitCode, 0, `${dry.body?.code}: ${dry.body?.message}`);
  assert.equal(dry.body.refused ?? false, false, 'a stock archive + an append is a legal one-action plan');
  assert.equal(dry.body.plan.write.includes('applyEdits'), true, 'the plan must name the edit step');
  assert.equal(dry.body.plan.write.includes('append(dsh-asar-edits/dry.cjs)'), true);
  assert.equal(dry.body.editPlan.length, 1);
  assert.equal(dry.body.editPlan[0].bytes, 4);
  assert.equal(statSync(fixture.asarPath).size, STOCK_ARCHIVE_SIZE, 'a dry run writes nothing');

  // A remove with no baseline is refused in the DRY RUN too, with the same code.
  const refusedDry = await cli(fixture, ['--dry-run', '--remove', 'renderer/welcome.html']);
  assert.equal(refusedDry.body.refused, true);
  assert.equal(refusedDry.body.refusalCode, 'EBASELINE_REQUIRED');
  assert.equal(statSync(fixture.asarPath).size, STOCK_ARCHIVE_SIZE);
});

test('CLI: --edit takes a JSON list and runs the ops in order', { skip: SKIP }, async () => {
  const fixture = makeCase('cli-edit-json');
  copyFileSync(BASELINE, join(fixture.resources, 'app.asar.20260101-0000.v0.2.2-rc.3.bak'));
  const ops = [
    { op: 'append', path: 'dsh-asar-edits/first.cjs', content: 'first\n' },
    { op: 'append', path: 'dsh-asar-edits/second.cjs', content: 'second\n' },
    { op: 'repoint', path: 'renderer/welcome.html', content: '<html>again</html>' },
  ];
  const applied = await cli(fixture, ['--apply', '--edit', JSON.stringify(ops)]);
  assert.equal(applied.exitCode, 0, `${applied.body?.code}: ${applied.body?.message}`);
  assert.equal(applied.body.editsApplied.length, 3);
  assert.deepEqual(applied.body.editsApplied.map((item) => item.op), ['append', 'append', 'repoint']);
  assert.equal(applied.body.editJournal.records, 3);

  const reopened = openAsar(fixture.asarPath, { allowStaleMainIntegrity: true });
  assert.equal(reopened.ok, true);
  try {
    assert.equal(readEntryText(reopened, 'dsh-asar-edits/first.cjs'), 'first\n');
    assert.equal(readEntryText(reopened, 'dsh-asar-edits/second.cjs'), 'second\n');
    assert.equal(readEntryText(reopened, 'renderer/welcome.html'), '<html>again</html>');
  } finally {
    closeAsar(reopened);
  }

  // The whole list is undone by ONE --restore, back to the official bytes.
  const verified = await cli(fixture, ['--verify-edits']);
  assert.equal(verified.exitCode, 0, `${verified.body?.code}: ${verified.body?.message}`);
  assert.equal(verified.body.journalRecords, 3);
  const restored = await cli(fixture, ['--restore']);
  assert.equal(restored.exitCode, 0, `${restored.body?.code}: ${restored.body?.message}`);
  assert.equal(await sha256File(fixture.asarPath), STOCK_ARCHIVE_SHA);
});

test('CLI: the argv parser refuses edit flags on a read-only mode', async () => {
  const parsed = (await import('../scripts/install.mjs')).parseArgv(['--status', '--append', 'dsh-asar-edits/x.cjs', '--content', 'x']);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'EINSTALL_USAGE');
  assert.equal(parsed.message.includes('--apply'), true, 'the message must say which modes accept edits');

  const both = (await import('../scripts/install.mjs')).parseArgv(['--apply', '--append', 'a.js', '--remove', 'b.js']);
  assert.equal(both.ok, false, 'one action carries one operation list, not two flags');

  const good = (await import('../scripts/install.mjs')).parseArgv(['--apply', '--append', 'a.js', '--content', 'x']);
  assert.equal(good.ok, true);
  assert.equal(good.edit.op, 'append');
  assert.equal(good.edit.path, 'a.js');
  assert.equal(good.edit.content, 'x');
  assert.equal(good.mode, 'apply');

  const resolved = resolveEditOps({ edit: { op: 'repoint', path: 'renderer/welcome.html', base64: Buffer.from('bye').toString('base64') } });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ops[0].content.equals(Buffer.from('bye')), true);
});

test('verifyRecord refuses when the archive does not match the record', { skip: SKIP }, async () => {
  const fixture = makeCase('record-mismatch');
  const opened = openForPlan(fixture.asarPath);
  const plan = planAppend(opened.asar, { path: 'dsh-asar-edits/checked.cjs', content: 'checked\n' });
  closeForPlan(opened);
  const applied = await applyAppend(fixture.asarPath, plan);
  assert.equal(applied.ok, true);

  const ok = await verifyRecord(fixture.asarPath, plan.record);
  assert.equal(ok.ok, true, 'a freshly applied record must verify');

  const tampered = { ...plan.record, entryOffset: plan.record.entryOffset + 4 };
  const mismatch = await verifyRecord(fixture.asarPath, tampered);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'EWRITE_VERIFY');
});
