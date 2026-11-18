/**
 * Baseline reuse tests: does the installer re-copy a 209 MB archive when a
 * verified baseline copy is already sitting on disk?
 *
 * The real archives are never touched here. Every fixture is a synthetic
 * archive of a few tens of kilobytes under
 * `scratch/test-copies/backup-reuse-<pid>/`, which is deleted in `after()`.
 * Digests are computed with the same `sha256File` production code uses, so the
 * tests exercise the real hashing path — just on small files.
 *
 * The rule under test (the whole reason `lib/install/baseline.js` exists):
 *
 *   reuse = same SIZE **and** same SHA-256 as the wanted baseline bytes
 *   copy  = only when no candidate satisfies both
 *
 * The size filter is not cosmetic: it is what keeps a full 209 MB hash per
 * useless candidate out of the install path, which is why `checked` (the
 * number of files actually hashed) is asserted explicitly instead of inferred.
 *
 * A genuinely byte-identical file cannot have a different length, so the
 * "different size" case uses the archive's bytes plus one trailing byte. What
 * that asserts is not "the digest would differ" but "this candidate was
 * rejected BEFORE any hashing" (`checked: 0`) — the property the filter exists
 * for.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
// `utimesSync` is the one fs call the package's fs-safe facade does not
// re-export, and the fixtures need explicit mtimes to make "newest wins"
// deterministic instead of timing-dependent. Everything else goes through
// fs-safe, like the rest of the package.
import { utimesSync } from 'node:fs';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from '../lib/fs-safe.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backupFileName, createBackup, findBackup } from '../lib/install/backup.js';
import { ensureBaselineBackup, findReusableBackup, listBackups } from '../lib/install/baseline.js';
import { sha256File } from '../lib/asar/hash.js';

/** Scratch root shared with the rest of the write-path tests. */
const COPY_DIR = fileURLToPath(new URL('../../scratch/test-copies/', import.meta.url));

/** One directory per test process, removed in `after()`. */
const ROOT = join(COPY_DIR, `backup-reuse-${process.pid}`);

/** Archive size used by every fixture: small enough to hash instantly. */
const ARCHIVE_BYTES = 48 * 1024;

/** Fixed version tag, so the produced file name is checkable. */
const VERSION = '1.0.0';

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
 * Write a backup file with an explicit mtime so "newest" is deterministic.
 * @param {string} dir
 * @param {string} name
 * @param {Buffer} bytes
 * @param {number} [mtimeMs]
 * @returns {string}
 */
function writeBackup(dir, name, bytes, mtimeMs = Date.now()) {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}

/** The archive's own bytes, used to forge a "byte-identical" backup. */
function archiveBytes(asarPath) {
  return readFileSync(asarPath);
}

/**
 * `{ sha256, size }` of a file: the shape every caller passes as `expected`.
 * @param {string} path
 * @returns {Promise<{ sha256: string, size: number }>}
 */
async function expectedOf(path) {
  return { sha256: await sha256File(path), size: statSync(path).size };
}

/** Entry names in a case directory, sorted: used to count what got written. */
function fileNames(dir) {
  return readdirSync(dir).sort();
}

test('no backups at all: exactly one backup is created and no re-use is claimed', async () => {
  const dir = caseDir('empty');
  const asarPath = writeArchive(dir);
  const expected = await expectedOf(asarPath);
  const date = new Date(2026, 0, 2, 3, 4, 5);

  const result = await ensureBaselineBackup(asarPath, VERSION, expected, { date });

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.reused, false);
  assert.equal(result.checked, 0, 'there was nothing to hash');
  assert.equal(result.backup.name, backupFileName(VERSION, date));
  assert.match(result.backup.name, BACKUP_NAME_PATTERN);
  assert.equal(result.backup.path, join(dir, result.backup.name));
  assert.equal(result.backup.size, expected.size);
  assert.equal(result.backup.sha256, expected.sha256, 'the copy must hold the archive bytes');

  assert.deepEqual(fileNames(dir), ['app.asar', result.backup.name].sort(), 'exactly one new file');
});

test('a byte-identical backup is re-used and no second copy is written', async () => {
  const dir = caseDir('identical');
  const asarPath = writeArchive(dir);
  const expected = await expectedOf(asarPath);
  const name = backupFileName(VERSION, new Date(2026, 0, 3, 4, 5, 6));
  const existing = writeBackup(dir, name, archiveBytes(asarPath), Date.now() - 60_000);
  const before = fileNames(dir);

  const result = await ensureBaselineBackup(asarPath, VERSION, expected);

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.reused, true);
  assert.equal(result.checked, 1, 'exactly the one same-size candidate was hashed');
  assert.equal(result.backup.path, existing);
  assert.equal(result.backup.name, name);
  assert.equal(result.backup.sha256, expected.sha256, 'the returned digest is the verified one');
  assert.deepEqual(fileNames(dir), before, 're-use must not create a file');
});

test('same size, different bytes: the hash rejects it and a new backup is written', async () => {
  const dir = caseDir('same-size-different-bytes');
  const asarPath = writeArchive(dir);
  const expected = await expectedOf(asarPath);
  const name = backupFileName(VERSION, new Date(2026, 0, 4, 5, 6, 7));
  writeBackup(dir, name, randomBytes(expected.size), Date.now() - 60_000);

  const result = await ensureBaselineBackup(asarPath, VERSION, expected);

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.reused, false);
  assert.equal(result.checked, 1, 'the same-size candidate was hashed and did not match');
  assert.match(result.backup.name, BACKUP_NAME_PATTERN);
  assert.notEqual(result.backup.name, name);
  assert.equal(result.backup.sha256, expected.sha256);
  assert.equal(fileNames(dir).length, 3, 'app.asar + the rejected backup + the new one');
});

test('different size: rejected before any hashing, then a new backup is written', async () => {
  const dir = caseDir('different-size');
  const asarPath = writeArchive(dir);
  const expected = await expectedOf(asarPath);
  const name = backupFileName(VERSION, new Date(2026, 0, 5, 6, 7, 8));
  // The archive's bytes plus one trailing byte: the digest can never match.
  const forged = Buffer.concat([archiveBytes(asarPath), Buffer.from([0x00])]);
  writeBackup(dir, name, forged, Date.now() - 60_000);

  const result = await ensureBaselineBackup(asarPath, VERSION, expected);

  assert.equal(result.ok, true, result.ok === true ? '' : `${result.code}: ${result.message}`);
  assert.equal(result.reused, false);
  assert.equal(result.checked, 0, 'a different size is a definitive "no": nothing to hash');
  assert.match(result.backup.name, BACKUP_NAME_PATTERN);
  assert.equal(fileNames(dir).length, 3, 'the rejected candidate is left untouched');

  // The rejected candidate is still the *newest*; the fresh copy is the match.
  const found = await findBackup(asarPath);
  assert.equal(found.ok, true, found.ok === true ? '' : `${found.code}: ${found.message}`);
  assert.equal(await found.sha256, expected.sha256, 'the new copy is the correct baseline');
});

test('several candidates: the matching one is found even when it is the older one', async () => {
  const dir = caseDir('older-match');
  const asarPath = writeArchive(dir);
  const expected = await expectedOf(asarPath);
  const older = writeBackup(dir, backupFileName(VERSION, new Date(2026, 0, 6, 7, 8, 9)),
    archiveBytes(asarPath), Date.now() - 120_000);
  writeBackup(dir, backupFileName(VERSION, new Date(2026, 0, 7, 8, 9, 10)),
    randomBytes(expected.size), Date.now() - 60_000);
  // A third candidate of another size: it must not even be listed as hashable.
  writeBackup(dir, backupFileName(VERSION, new Date(2026, 0, 8, 9, 10, 11)),
    randomBytes(expected.size - 1), Date.now() - 30_000);

  const listed = await listBackups(asarPath);
  assert.equal(listed.ok, true, listed.ok === true ? '' : `${listed.code}: ${listed.message}`);
  assert.equal(listed.backups.length, 3);
  assert.deepEqual(
    listed.backups.map((entry) => entry.size === expected.size),
    [false, true, true],
    'newest-first: the wrong-size candidate is freshest, the match is the oldest of the three',
  );

  const found = await findReusableBackup(asarPath, expected);
  assert.equal(found.ok, true, found.ok === true ? '' : `${found.code}: ${found.message}`);
  assert.equal(found.checked, 2, 'only the two same-size candidates were hashed');
  assert.equal(found.backup.path, older, 'the older identical copy is the reusable baseline');
  assert.equal(found.backup.sha256, expected.sha256);

  // The ensure path agrees, so both exports tell the same story.
  const ensured = await ensureBaselineBackup(asarPath, VERSION, expected);
  assert.equal(ensured.ok, true, ensured.ok === true ? '' : `${ensured.code}: ${ensured.message}`);
  assert.equal(ensured.reused, true);
  assert.equal(ensured.backup.path, older);
  assert.equal(ensured.checked, 2);
  assert.equal(fileNames(dir).length, 4, 'no new backup was written');
});

test('a non-string or empty expected sha claims nothing and creates nothing', async () => {
  const dir = caseDir('no-wanted-sha');
  const asarPath = writeArchive(dir);
  // A backup that *would* match the archive is present; it must still not be
  // blessed, because without a wanted digest there is nothing to verify against.
  writeBackup(dir, backupFileName(VERSION, new Date(2026, 0, 9, 10, 11, 12)), archiveBytes(asarPath));
  const before = fileNames(dir);

  for (const expected of [undefined, null, {}, { sha256: '' }, { sha256: '   ' }, { sha256: 42 }, { sha256: null }]) {
    const result = await findReusableBackup(asarPath, expected);
    assert.equal(result.ok, true);
    assert.equal(result.checked, 0, `nothing hashed for ${JSON.stringify(expected)}`);
    assert.equal(result.backup, null);
  }
  assert.deepEqual(fileNames(dir), before, 'findReusableBackup never writes');
});

test('findBackup prefers the recorded digest, and still prefers the newest by default', async () => {
  const dir = caseDir('prefer-sha');
  const asarPath = writeArchive(dir);
  const stockSha = await sha256File(asarPath);
  const older = writeBackup(dir, backupFileName(VERSION, new Date(2026, 0, 10, 11, 12, 13)),
    archiveBytes(asarPath), Date.now() - 120_000);
  const newer = writeBackup(dir, backupFileName(VERSION, new Date(2026, 0, 11, 12, 13, 14)),
    randomBytes(statSync(asarPath).size), Date.now() - 60_000);

  const preferred = await findBackup(asarPath, { preferSha256: stockSha });
  assert.equal(preferred.ok, true, preferred.ok === true ? '' : `${preferred.code}: ${preferred.message}`);
  assert.equal(preferred.backupPath, older, 'the recorded baseline outranks the newest file');
  assert.equal(await preferred.sha256, stockSha, 'the returned digest describes the preferred file');

  // Backward compatibility: no option -> newest wins, exactly as the CLI's
  // inspect() and --restore already rely on.
  const newest = await findBackup(asarPath);
  assert.equal(newest.ok, true, newest.ok === true ? '' : `${newest.code}: ${newest.message}`);
  assert.equal(newest.backupPath, newer);

  // An unknown recorded digest must NOT make the directory unrestorable: the
  // search falls back to newest-wins instead of refusing.
  const unmatched = await findBackup(asarPath, { preferSha256: 'f'.repeat(64) });
  assert.equal(unmatched.ok, true);
  assert.equal(unmatched.backupPath, newer, 'no match -> unchanged newest-wins fallback');
});

test('listBackups reports an empty list and a missing directory without throwing', async () => {
  const dir = caseDir('list-empty');
  const asarPath = writeArchive(dir);

  const empty = await listBackups(asarPath);
  assert.equal(empty.ok, true);
  assert.equal(empty.dir, dir);
  assert.deepEqual(empty.backups, []);

  const missing = await listBackups(join(ROOT, 'definitely-not-there', 'app.asar'));
  assert.equal(missing.ok, false, 'an unreadable directory is a failure object, not a throw');
  assert.equal(missing.code, 'ENO_BACKUP');
  assert.equal(typeof missing.message, 'string');

  const bad = await listBackups('');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'EINVALID_INPUT');
});

test('listBackups sorts by mtime and reports name/path/size/mtimeMs', async () => {
  const dir = caseDir('list-order');
  const asarPath = writeArchive(dir);
  const bytes = randomBytes(4096);
  const oldest = writeBackup(dir, backupFileName(VERSION, new Date(2026, 0, 12, 13, 14, 15)), bytes, Date.now() - 120_000);
  const newest = writeBackup(dir, backupFileName(VERSION, new Date(2026, 0, 13, 14, 15, 16)), bytes, Date.now() - 60_000);

  const listed = await listBackups(asarPath);
  assert.equal(listed.ok, true, listed.ok === true ? '' : `${listed.code}: ${listed.message}`);
  assert.equal(listed.backups.length, 2);
  assert.equal(listed.backups[0].path, newest, 'newest-first');
  assert.equal(listed.backups[1].path, oldest);
  for (const entry of listed.backups) {
    assert.equal(typeof entry.name, 'string');
    assert.equal(entry.name, entry.path.split(/[\\/]/).pop());
    assert.equal(entry.size, 4096);
    assert.equal(typeof entry.mtimeMs, 'number');
    // Only files matching the backup naming are candidates at all.
    assert.match(entry.name, BACKUP_NAME_PATTERN);
  }
});

test('naming is untouched: the reuse layer never renames what createBackup produces', async () => {
  const dir = caseDir('naming');
  const asarPath = writeArchive(dir);
  const date = new Date(2026, 0, 14, 15, 16, 17);

  const legacy = await createBackup(asarPath, VERSION, { date });
  assert.equal(legacy.ok, true, legacy.ok === true ? '' : `${legacy.code}: ${legacy.message}`);
  assert.equal(legacy.backupPath, join(dir, backupFileName(VERSION, date)));

  // Same minute again: createBackup's own de-duplication still applies, so the
  // reuse layer inheriting its name is the only naming rule involved.
  const second = await createBackup(asarPath, VERSION, { date });
  assert.equal(second.ok, true, second.ok === true ? '' : `${second.code}: ${second.message}`);
  assert.match(second.backupPath.split(/[\\/]/).pop(), /^app\.asar\.20260114-1516\.v1\.0\.0-2\.bak$/);
});
