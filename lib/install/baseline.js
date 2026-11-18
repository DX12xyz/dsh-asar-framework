/**
 * Baseline discovery: reuse a verified backup instead of copying the archive again.
 *
 * `createBackup` is a full stream copy of `app.asar`, which on this install is
 * 209,021,953 bytes: half a gigabyte of I/O and a few seconds of wall time every
 * time. The rule this module implements is: at install time, if backups already
 * exist, verify their sha256; only when none of them carries the baseline bytes
 * do we write a new copy. A stock baseline already on disk — written by an
 * earlier install, copied by hand, or left behind by a vendor upgrade — is just
 * as good as a fresh one, and "just as good" is decided by the digest alone.
 *
 * What "the baseline" means depends on the archive state:
 *
 *   stock                 The bytes a fresh copy would contain are exactly the
 *                         current archive, so the whole question is "is there a
 *                         backup with the same size AND the same sha256 as the
 *                         current archive?". Callers derive `expected` from the
 *                         archive itself.
 *   patched-by-us         The current archive is NOT the baseline; it is the
 *                         stock bytes plus our equal-length patch. The baseline
 *                         is whatever the install record says it was
 *                         (`record.backup.sha256`, `record.backup.size`). If no
 *                         such backup is on disk the baseline is unrecoverable:
 *                         the caller must say so, never fabricate one — a copy
 *                         of the patched archive labelled "stock" would turn a
 *                         broken state into a lying one.
 *
 * Cost note: the digest is the only proof, so it must be computed at least once
 * per candidate that is worth checking. Candidates are therefore filtered by
 * size first — hashing 209 MB for a file that cannot possibly match is pure
 * waste — and then streamed through `sha256File` in 4 MiB chunks
 * (`lib/asar/hash.js`), so memory stays flat. On a directory holding several
 * same-size 209 MB candidates the worst case is one full read per candidate
 * until the match is found (newest first, so a baseline from the last install
 * usually hits immediately).
 */
import { readdirSync, statSync } from '../fs-safe.js';
import { basename, dirname, join } from 'node:path';

import { ERROR_CODES } from '../wire/errors.js';
import { backupSizeOf, createBackup, sha256OfBackup } from './backup.js';

/** Backups always sit beside the archive and share this prefix/suffix. */
const BACKUP_PREFIX = 'app.asar.';
const BACKUP_SUFFIX = '.bak';

/**
 * List the backups next to the archive, newest first.
 *
 * A missing/unreadable directory and a bad path are reported as failure objects
 * instead of throws: "there are no backups" and "the directory cannot be read"
 * are both states the installer has to explain, and both callers would have to
 * wrap a throwing listing in the same try/catch anyway.
 *
 * Entries that vanish between `readdir` and `stat` (a concurrent `--restore`,
 * a user deleting a `.bak`) are skipped: they are not candidates any more.
 *
 * @param {string} asarPath path of the archive whose siblings to list
 * @returns {Promise<
 *   { ok: true, dir: string, backups: { name: string, path: string, size: number, mtimeMs: number }[] }
 *   | { ok: false, code: string, message: string }
 * >}
 */
export async function listBackups(asarPath) {
  if (typeof asarPath !== 'string' || asarPath.length === 0) {
    return {
      ok: false,
      code: ERROR_CODES.EINVALID_INPUT,
      message: 'listBackups 需要一个 app.asar 路径',
    };
  }

  const dir = dirname(asarPath);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.ENO_BACKUP,
      message: `无法读取备份目录 ${dir}：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const backups = [];
  for (const entry of entries) {
    if (entry.isFile() !== true) continue;
    if (!entry.name.startsWith(BACKUP_PREFIX) || !entry.name.endsWith(BACKUP_SUFFIX)) continue;
    const path = join(dir, entry.name);
    try {
      const info = statSync(path);
      backups.push({ name: entry.name, path, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      /* vanished between readdir and stat: no longer a candidate */
    }
  }

  // Newest first: the freshest baseline is the most likely match (the copy the
  // last install wrote), and it keeps `findBackup`'s historical "newest wins"
  // default expressible as "the first entry of this list".
  backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { ok: true, dir, backups };
}

/**
 * Find an existing backup whose bytes are the wanted baseline.
 *
 * `expected` is `{ sha256, size }`, normally taken from the install record or
 * from the stock archive itself. Only candidates with that exact size are
 * hashed; a size mismatch is already a definitive answer, and a 209 MB hash for
 * a file that cannot match would be wasted I/O.
 *
 * When `expected.sha256` is not a non-empty string there is nothing to verify
 * against, so nothing is hashed and nothing is claimed: the answer is "no
 * reusable baseline". That is deliberate — a missing digest must never degrade
 * into "reuse whatever is lying around", which would silently bless an
 * unverified file as the stock baseline.
 *
 * `checked` counts the candidates that were actually hashed, which is what lets
 * a caller (and a test) see the cost of the decision.
 *
 * @param {string} asarPath
 * @param {{ sha256?: unknown, size?: unknown }} expected
 * @returns {Promise<
 *   { ok: true, checked: number, backup: { name: string, path: string, size: number, sha256: string } | null }
 *   | { ok: false, code: string, message: string }
 * >}
 */
export async function findReusableBackup(asarPath, expected) {
  const record = expected !== null && typeof expected === 'object' ? expected : {};
  const wantSha = typeof record.sha256 === 'string' ? record.sha256.trim().toLowerCase() : '';
  // No wanted digest means no question to answer: nothing is hashed and nothing
  // is claimed, even before the directory is touched.
  if (wantSha.length === 0) return { ok: true, checked: 0, backup: null };

  const listed = await listBackups(asarPath);
  if (listed.ok !== true) return listed;

  // Without a usable size every candidate has to be hashed: correctness first.
  const wantSize = Number.isInteger(record.size) && record.size >= 0 ? record.size : null;
  const candidates = wantSize === null
    ? listed.backups
    : listed.backups.filter((backup) => backup.size === wantSize);

  let checked = 0;
  for (const candidate of candidates) {
    // Cheap TOCTOU guard: a file replaced since the listing is not the same
    // candidate, and hashing it would only produce a stale answer.
    if (backupSizeOf(candidate.path) !== candidate.size) continue;
    const digest = await sha256OfBackup(candidate.path);
    if (digest === null) continue; // unreadable mid-scan: skip, do not abort the search
    checked += 1;
    if (digest === wantSha) {
      return {
        ok: true,
        checked,
        backup: { name: candidate.name, path: candidate.path, size: candidate.size, sha256: digest },
      };
    }
  }
  return { ok: true, checked, backup: null };
}

/**
 * Guarantee that a baseline backup exists: reuse a verified one, otherwise copy.
 *
 * This is the single entry point the install flow needs. It first asks
 * `findReusableBackup`, and only when that finds nothing does it fall back to
 * `createBackup` — so the expensive copy happens at most once per baseline, and
 * a second install that finds its own earlier copy does no copying at all.
 *
 * Failure codes are passed through untouched (`EBASAR_MISSING`,
 * `EBACKUP_FAILED`, unreadable directory, …) so the CLI and the client keep
 * reporting the same reasons they do today.
 *
 * Caller contract: `expected` must describe the **stock** bytes. This function
 * deliberately does not decide whether a copy is legitimate — in the
 * `patched-by-us` state the archive is not the baseline, so a caller that
 * cannot name the stock digest (the record has none) must not call this at all:
 * `createBackup` would faithfully copy the patched archive and label it "stock",
 * which is worse than having no backup. `findReusableBackup` already encodes
 * that refusal: without a wanted digest it matches nothing.
 *
 * @param {string} asarPath
 * @param {string} version DSH version, used only when a new backup is named
 * @param {{ sha256?: unknown, size?: unknown }} expected wanted baseline bytes
 * @param {{ date?: Date }} [options] forwarded to `createBackup` (name timestamp)
 * @returns {Promise<
 *   { ok: true, reused: boolean, checked: number,
 *     backup: { name: string, path: string, size: number, sha256: string } }
 *   | { ok: false, code: string, message: string }
 * >}
 */
export async function ensureBaselineBackup(asarPath, version, expected, options = {}) {
  const reusable = await findReusableBackup(asarPath, expected);
  if (reusable.ok !== true) return reusable;
  if (reusable.backup !== null) {
    return { ok: true, reused: true, checked: reusable.checked, backup: reusable.backup };
  }

  const created = await createBackup(asarPath, version, options);
  if (created.ok !== true) return created;
  return {
    ok: true,
    reused: false,
    checked: reusable.checked,
    backup: {
      name: basename(created.backupPath),
      path: created.backupPath,
      size: created.size,
      sha256: created.sha256,
    },
  };
}
