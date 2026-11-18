/**
 * Backup retention tests: does the install keep at most N `app.asar.*.bak`
 * copies beside the archive, and does it spare the one baseline that can still
 * restore this machine?
 *
 * The real archives are never touched here. Every fixture is a synthetic archive
 * plus a handful of a few-kilobyte `.bak` files under
 * `scratch/test-copies/retention-<pid>/`, deleted in `after()`. Digests come from
 * the same `sha256File` the production code uses, so the hashing path is the real
 * one — only the file sizes are small.
 *
 * The rules asserted here are the ones `runApply` relies on:
 *
 *   limit    defaults to BACKUP_KEEP_LIMIT (5); anything below 1 is clamped to 1,
 *            because "keep none" would delete the baseline itself
 *   protect  a `.bak` whose sha256 equals `protectSha256` is never removed, even
 *            when it is the oldest file in the directory
 *   at most  keepCount = limit - (protected ? 1 : 0) unprotected copies survive,
 *            so a directory holds at most `limit` backups INCLUDING the
 *            protected one
 *   delete   one undeletable file is reported in `skipped` and does not stop the
 *            rest; a listing failure is the only reason the whole call fails
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
// `utimesSync` is the one fs call the package's fs-safe facade does not
// re-export, and the fixtures need explicit mtimes to make "newest wins"
// deterministic instead of timing-dependent. Everything else goes through
// fs-safe, like the rest of the package.
import { utimesSync } from 'node:fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from '../lib/fs-safe.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backupFileName } from '../lib/install/backup.js';
import { pruneBackups } from '../lib/install/retention.js';
import { sha256File } from '../lib/asar/hash.js';
import { BACKUP_KEEP_LIMIT } from '../lib/wire/constants.js';

/** Scratch root shared with the rest of the write-path tests. */
const COPY_DIR = fileURLToPath(new URL('../../scratch/test-copies/', import.meta.url));

/** One directory per test process, removed in `after()`. */
const ROOT = join(COPY_DIR, `retention-${process.pid}`);

/** Archive size used by every fixture: small enough to hash instantly. */
const ARCHIVE_BYTES = 4096;

/** Fixed version tag, so the produced file names are checkable. */
const VERSION = '1.0.0';

/** Base mtime: fixtures are spaced by one minute so ordering is unambiguous. */
const BASE_MS = Date.parse('2026-01-01T00:00:00Z');

/** A 64-hex digest that matches no fixture, used for "protects nothing". */
const NO_SUCH_DIGEST = 'f'.repeat(64);

/** The exact name shape `createBackup` produces for VERSION. */
const BACKUP_NAME_PATTERN = /^app\.asar\.\d{8}-\d{4}\.v1\.0\.0\.bak$/;

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * Create one isolated case directory under the scratch root.
 * @param {string} name
 * @returns {string}
 */
function caseDir(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a synthetic `app.asar` of random bytes.
 * @param {string} dir
 * @param {number} [size]
 * @returns {string}
 */
function writeArchive(dir, size = ARCHIVE_BYTES) {
  const path = join(dir, 'app.asar');
  writeFileSync(path, randomBytes(size));
  return path;
}

/**
 * Write one backup file with an explicit mtime so "newest" is deterministic.
 * @param {string} dir
 * @param {string} name
 * @param {Buffer} bytes
 * @param {number} mtimeMs
 * @returns {string}
 */
function writeBackup(dir, name, bytes, mtimeMs) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

/**
 * Seed `count` backups of the same size, one minute apart.
 *
 * `index 0` is the OLDEST; the returned list is in that order (oldest first) so
 * an assertion can say "the k-th oldest" without re-sorting. `listBackups`
 * reports the opposite order (newest first), which is what the production code
 * consumes — that asymmetry is deliberate here and each test is explicit about
 * which list it means.
 *
 * @param {string} dir
 * @param {number} count
 * @param {{ size?: number, bytesOf?: (index: number) => Buffer }} [options]
 * @returns {{ index: number, name: string, path: string }[]}
 */
function seedBackups(dir, count, options = {}) {
  const size = options.size ?? ARCHIVE_BYTES;
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const name = backupFileName(VERSION, new Date(2026, 0, 1 + index, 0, index, 0));
    const bytes = options.bytesOf !== undefined ? options.bytesOf(index) : randomBytes(size);
    const path = writeBackup(dir, name, bytes, BASE_MS + index * 60_000);
    entries.push({ index, name, path });
  }
  return entries;
}

/** Names of every `app.asar.*.bak` file currently in a case directory, sorted. */
function backupNamesOnDisk(dir) {
  return readdirSync(dir)
    .filter((name) => name.startsWith('app.asar.') && name.endsWith('.bak'))
    .sort();
}

/**
 * Run `pruneBackups` while replacing one doomed backup with a DIRECTORY at the
 * same path, which is what makes deletion fail on Windows.
 *
 * `fs.rmSync(path, { force: true })` refuses a directory (ERR_FS_EISDIR) no
 * matter what `force` says — unlike an open handle or a read-only attribute,
 * which this box happily deletes — so this is a deterministic, side-effect-free
 * way to simulate "this old backup cannot be removed". The swap is queued as a
 * microtask: `pruneBackups` has already suspended on `listBackups` by then, but
 * has not reached `rmSync` yet, so the doomed entry is replaced between listing
 * and deletion — exactly the race a real locked file produces.
 *
 * @param {string} asarPath
 * @param {{ limit?: number }} [options]
 * @param {string} swapPath the doomed backup to replace with a directory
 * @returns {Promise<object>} the prune result
 */
async function pruneWithUndeletable(asarPath, options, swapPath) {
  const running = pruneBackups(asarPath, options);
  queueMicrotask(() => {
    renameSync(swapPath, `${swapPath}.swapped`);
    mkdirSync(swapPath);
  });
  return running;
}

test('six backups, no protection: the newest five survive and the oldest goes', async () => {
  const dir = caseDir('six-no-protection');
  const asarPath = writeArchive(dir);
  const seeded = seedBackups(dir, 6); // oldest first
  const oldestSha = await sha256File(seeded[0].path);
  const before = backupNamesOnDisk(dir);

  const result = await pruneBackups(asarPath);

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.limit, BACKUP_KEEP_LIMIT, 'the default limit is the hard-coded constant');
  assert.equal(result.total, 6, 'total counts the pile before pruning');
  assert.equal(result.protected, null, 'no digest was protected');
  assert.deepEqual(result.skipped, []);

  assert.equal(result.removed.length, 1, '6 backups with a limit of 5 leaves exactly one to remove');
  assert.equal(result.removed[0].name, seeded[0].name, 'the oldest backup is the one removed');
  assert.match(result.removed[0].sha256, /^[0-9a-f]{64}$/, 'removed entries carry the digest of the deleted bytes');
  assert.equal(result.removed[0].sha256, oldestSha, 'the digest describes the file that was deleted');
  assert.equal(result.removed[0].size, ARCHIVE_BYTES);

  assert.equal(result.kept.length, 5);
  // kept is newest-first, like listBackups: seeded[5] down to seeded[1].
  assert.deepEqual(result.kept.map((entry) => entry.name), seeded.slice(1).reverse().map((entry) => entry.name));
  for (const entry of result.kept) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(entry.size, ARCHIVE_BYTES);
  }

  // Invariant the caller can rely on: everything is accounted for.
  assert.equal(result.total, result.kept.length + result.removed.length + result.skipped.length);

  // And the disk agrees with the report.
  assert.deepEqual(backupNamesOnDisk(dir), before.filter((name) => name !== seeded[0].name));
  assert.equal(existsSync(seeded[0].path), false);
});

test('six backups, the OLDEST is protected: it survives and the total stays at the limit', async () => {
  const dir = caseDir('six-protect-oldest');
  const asarPath = writeArchive(dir);
  const archiveBytes = readFileSync(asarPath);
  // The oldest copy holds the archive's own bytes: the realistic "this is the
  // recorded baseline, and it happens to be the oldest file".
  const seeded = seedBackups(dir, 6, {
    bytesOf: (index) => (index === 0 ? archiveBytes : randomBytes(ARCHIVE_BYTES)),
  });
  const oldestSha = await sha256File(seeded[0].path);

  const result = await pruneBackups(asarPath, { protectSha256: oldestSha });

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.limit, BACKUP_KEEP_LIMIT);
  assert.equal(result.total, 6);
  assert.deepEqual(result.skipped, []);

  assert.deepEqual(result.protected, [{ name: seeded[0].name, size: ARCHIVE_BYTES }], 'the oldest copy is the protected one');
  assert.equal(existsSync(seeded[0].path), true, 'a protected backup is never removed, not even as the oldest');

  // keepCount = limit - 1 = 4 of the five unprotected copies survive, so the
  // directory still holds at most 5 backups (4 plain + 1 protected).
  assert.equal(result.kept.length, 5, 'the count includes the protected one');
  assert.equal(result.removed.length, 1, '6 backups, at most 5 may stay');
  assert.equal(result.removed[0].name, seeded[1].name, 'only the oldest UNPROTECTED copy goes');
  assert.equal(result.total, result.kept.length + result.removed.length + result.skipped.length);

  // Newest-first, protected copy included and last (it is the oldest file).
  assert.deepEqual(
    result.kept.map((entry) => entry.name),
    [seeded[5], seeded[4], seeded[3], seeded[2], seeded[0]].map((entry) => entry.name),
  );
  assert.equal(backupNamesOnDisk(dir).length, 5, 'on disk: at most the limit, protected copy included');
});

test('three backups: nothing is removed and total equals the kept count', async () => {
  const dir = caseDir('three-under-limit');
  const asarPath = writeArchive(dir);
  const seeded = seedBackups(dir, 3);
  const before = backupNamesOnDisk(dir);

  const result = await pruneBackups(asarPath);

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.limit, BACKUP_KEEP_LIMIT);
  assert.equal(result.total, 3);
  assert.equal(result.removed.length, 0);
  assert.equal(result.kept.length, 3);
  assert.equal(result.total, result.kept.length, 'nothing was removed');
  assert.deepEqual(result.kept.map((entry) => entry.name), [...seeded].reverse().map((entry) => entry.name));
  assert.deepEqual(backupNamesOnDisk(dir), before, 'the disk is untouched');
});

test('limit: 2 is applied honestly, not silently widened to the default', async () => {
  const dir = caseDir('limit-two');
  const asarPath = writeArchive(dir);
  const seeded = seedBackups(dir, 4);

  const result = await pruneBackups(asarPath, { limit: 2 });

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.limit, 2);
  assert.equal(result.total, 4);
  assert.equal(result.kept.length, 2);
  assert.equal(result.removed.length, 2);
  assert.deepEqual(result.kept.map((entry) => entry.name), [seeded[3].name, seeded[2].name], 'the two newest survive');
  assert.deepEqual(result.removed.map((entry) => entry.name), [seeded[1].name, seeded[0].name], 'the two oldest go');
  assert.equal(backupNamesOnDisk(dir).length, 2);
});

test('limit 0, -3, 2.5 and "x" all clamp to 1 and keep exactly one backup', async () => {
  const cases = [
    { label: 'zero', value: 0 },
    { label: 'negative', value: -3 },
    { label: 'fractional', value: 2.5 },
    { label: 'string', value: 'x' },
  ];

  for (const entry of cases) {
    const dir = caseDir(`clamp-${entry.label}`);
    const asarPath = writeArchive(dir);
    const seeded = seedBackups(dir, 3);

    const result = await pruneBackups(asarPath, { limit: entry.value });

    assert.equal(result.ok, true, `${entry.label}: ${result.ok === true ? '' : `${result.code}: ${result.message}`}`);
    // "Keep none" would delete the baseline, so the floor is 1 — never 0.
    assert.equal(result.limit, 1, `${entry.label}: clamped to 1`);
    assert.equal(result.kept.length, 1, `${entry.label}: exactly one backup survives`);
    assert.equal(result.kept[0].name, seeded[2].name, `${entry.label}: it is the newest one`);
    assert.equal(result.removed.length, 2, `${entry.label}: the other two go`);
    assert.equal(backupNamesOnDisk(dir).length, 1, `${entry.label}: on disk too`);
  }
});

test('dryRun computes the same plan and removes nothing', async () => {
  const dir = caseDir('dry-run');
  const asarPath = writeArchive(dir);
  const seeded = seedBackups(dir, 6);
  const before = backupNamesOnDisk(dir);

  const planned = await pruneBackups(asarPath, { dryRun: true });

  assert.equal(planned.ok, true, planned.ok === true ? '' : `${planned.code}: ${planned.message}`);
  assert.equal(planned.total, 6);
  assert.equal(planned.kept.length, 5);
  assert.equal(planned.removed.length, 1);
  assert.match(planned.removed[0].sha256, /^[0-9a-f]{64}$/, 'a dry run still hashes, so the audit line is complete');
  assert.deepEqual(backupNamesOnDisk(dir), before, 'dryRun must not delete anything');

  // The same call without dryRun must produce the same list and then delete it.
  const real = await pruneBackups(asarPath);
  assert.equal(real.ok, true, real.ok === true ? '' : `${real.code}: ${real.message}`);
  assert.deepEqual(real.removed.map((entry) => entry.name), planned.removed.map((entry) => entry.name));
  assert.deepEqual(real.kept.map((entry) => entry.name), planned.kept.map((entry) => entry.name));
  assert.equal(real.removed[0].sha256, planned.removed[0].sha256);
  assert.deepEqual(backupNamesOnDisk(dir), before.filter((name) => name !== seeded[0].name));
});

test('an unreadable or missing directory returns ok:false instead of throwing', async () => {
  const missing = join(ROOT, 'definitely-not-there', 'app.asar');
  const result = await pruneBackups(missing);

  assert.equal(result.ok, false, 'an unreadable directory is a failure object, not a throw');
  assert.equal(result.code, 'ENO_BACKUP');
  assert.equal(typeof result.message, 'string');

  // Same for a bad argument shape: still a failure object.
  const bad = await pruneBackups('');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'EINVALID_INPUT');
});

test('one undeletable backup lands in skipped while the others are still removed', async () => {
  const dir = caseDir('undeletable');
  const asarPath = writeArchive(dir);
  const seeded = seedBackups(dir, 4); // oldest first
  const doomed = seeded[1]; // the second-oldest: limit 2 makes seeded[0..1] doomed

  const result = await pruneWithUndeletable(asarPath, { limit: 2 }, doomed.path);

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.total, 4);
  assert.equal(result.kept.length, 2, 'the two newest are untouched');
  assert.equal(result.removed.length, 1, 'the other doomed backup was still deleted');
  assert.equal(result.removed[0].name, seeded[0].name, 'the deletable oldest copy went');

  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].name, doomed.name, 'the refused path is reported, not thrown');
  assert.equal(typeof result.skipped[0].reason, 'string');
  assert.match(result.skipped[0].reason, /EISDIR|is a directory/i, 'the reason carries the OS error');

  assert.equal(result.total, result.kept.length + result.removed.length + result.skipped.length);
  // The swap left the path as a directory: the file is gone but the name stays.
  assert.equal(existsSync(doomed.path), true, 'a skipped backup is still on disk, under its own name');
});

test('protectSha256 that matches nothing means plain newest-N, no protection', async () => {
  const dir = caseDir('protect-nothing');
  const asarPath = writeArchive(dir);
  const seeded = seedBackups(dir, 4);

  const result = await pruneBackups(asarPath, { protectSha256: NO_SUCH_DIGEST });

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.protected, null, 'an unknown digest protects nothing');
  assert.equal(result.limit, BACKUP_KEEP_LIMIT);
  assert.equal(result.kept.length, 4, '4 backups under a limit of 5: nothing is over the limit');
  assert.equal(result.removed.length, 0, 'under the limit, nothing is removed');
  assert.equal(backupNamesOnDisk(dir).length, 4, 'and the disk keeps all four');

  // Values that are not a non-empty string are "no protection" too, not a throw.
  for (const value of [undefined, null, '', '   ', 42]) {
    const quiet = await pruneBackups(asarPath, { protectSha256: value });
    assert.equal(quiet.ok, true);
    assert.equal(quiet.protected, null, `no protection for ${JSON.stringify(value)}`);
  }
});

test('a same-size decoy newer than the real baseline does not steal the protection', async () => {
  const dir = caseDir('protect-decoy');
  const asarPath = writeArchive(dir);
  const archiveBytes = readFileSync(asarPath);
  // All three candidates have the archive's size, so the size filter keeps every
  // one of them: only the digest can tell which copy is the recorded baseline.
  const seeded = seedBackups(dir, 3, {
    bytesOf: (index) => (index === 0 ? archiveBytes : randomBytes(ARCHIVE_BYTES)),
  });
  const baselineSha = await sha256File(seeded[0].path);

  const result = await pruneBackups(asarPath, { limit: 2, protectSha256: baselineSha });

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.total, 3);
  assert.deepEqual(result.protected, [{ name: seeded[0].name, size: ARCHIVE_BYTES }]);
  // keepCount = 2 - 1 = 1 of the two newer candidates survives, plus the
  // protected oldest one: at most 2 remain, and the newest decoy is the one cut.
  assert.equal(result.kept.length, 2);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].name, seeded[1].name, 'the older decoy goes, the newest stays');
  assert.deepEqual(result.kept.map((entry) => entry.name), [seeded[2].name, seeded[0].name]);
  assert.equal(existsSync(seeded[0].path), true);
});

test('the protected copy still counts against the limit when it is a fresh newest one', async () => {
  const dir = caseDir('protect-newest');
  const asarPath = writeArchive(dir);
  const seeded = seedBackups(dir, 6);
  const newestSha = await sha256File(seeded[5].path);

  const result = await pruneBackups(asarPath, { protectSha256: newestSha });

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.limit, BACKUP_KEEP_LIMIT);
  assert.equal(result.total, 6);
  assert.deepEqual(result.protected, [{ name: seeded[5].name, size: ARCHIVE_BYTES }]);
  // The usual install shape: the protected copy is the newest one, so the four
  // next-newest survive and only the single oldest copy goes — 6 backups become
  // exactly 5 on disk, the protected one occupying one of those five slots.
  assert.equal(result.kept.length, 5);
  assert.equal(result.removed.length, 1);
  assert.deepEqual(result.removed.map((entry) => entry.name), [seeded[0].name]);
  assert.equal(existsSync(seeded[5].path), true);
  assert.equal(backupNamesOnDisk(dir).length, 5);
});

test('limit 1 with a protected copy keeps exactly that one, never a negative slice', async () => {
  const dir = caseDir('limit-one-protected');
  const asarPath = writeArchive(dir);
  const seeded = seedBackups(dir, 4); // oldest first
  const oldestSha = await sha256File(seeded[0].path);

  const result = await pruneBackups(asarPath, { limit: 1, protectSha256: oldestSha });

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.limit, 1);
  // keepCount = 1 - 1 = 0, so every unprotected copy is doomed and only the
  // protected one remains: a negative count here would have sliced wrongly.
  assert.deepEqual(result.kept.map((entry) => entry.name), [seeded[0].name]);
  assert.equal(result.removed.length, 3);
  assert.equal(result.total, result.kept.length + result.removed.length + result.skipped.length);
  assert.deepEqual(backupNamesOnDisk(dir), [seeded[0].name]);
  assert.equal(existsSync(seeded[0].path), true);

  // Options shapes that are not a plain object must not throw either.
  for (const options of [undefined, null, [], 'x', 7]) {
    const quiet = await pruneBackups(asarPath, options);
    assert.equal(quiet.ok, true, `options ${JSON.stringify(options)}`);
    assert.equal(quiet.limit, BACKUP_KEEP_LIMIT, `options ${JSON.stringify(options)} fall back to the constant`);
  }
});

test('naming is untouched: a pruned pile still matches the backup name shape', async () => {
  const dir = caseDir('naming');
  const asarPath = writeArchive(dir);
  seedBackups(dir, 7);
  const result = await pruneBackups(asarPath);

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.removed.length, 2);
  assert.equal(result.kept.length, BACKUP_KEEP_LIMIT);
  assert.equal(statSync(asarPath).size, ARCHIVE_BYTES, 'pruning never touches the archive itself');
  for (const name of backupNamesOnDisk(dir)) {
    assert.match(name, BACKUP_NAME_PATTERN, 'every survivor keeps the backup naming');
  }
});
