/**
 * Backup retention: keep at most N `app.asar.*.bak` copies beside the archive.
 *
 * Why: every backup is a full stream copy of `app.asar` — 209,021,953 bytes on
 * the rc.3 install, i.e. ~209 MB per copy. An install that is repeated a few
 * times (re-applying after a DSH upgrade, retrying after a failed bridge copy)
 * leaves that much on disk every time, and nothing ever removed the old ones.
 * A hard, small limit keeps the install honest without turning the install
 * directory into a disk hog. The limit is `BACKUP_KEEP_LIMIT` (5) by default and
 * callers cannot raise it above the constant by omission: passing nothing means
 * the constant, not "unlimited".
 *
 * The protected-baseline rule is the one constraint that outranks the limit: the
 * install record names the sha256 of the stock bytes this machine was installed
 * from, and `runApply` passes it here. That copy is NEVER removed, even when it
 * is the oldest of the pile — deleting it would leave a patched archive with no
 * way back to the official bytes. This is also why a limit below 1 is clamped to
 * 1 rather than honoured: "keep none" would delete the baseline itself.
 *
 * "At most N" counts the protected copy too. A directory with a protected
 * baseline therefore keeps N-1 *other* backups, so the total on disk stays N and
 * the caller does not have to reason about "N plus maybe one".
 *
 * Failure policy: deleting an old backup is housekeeping, not the install. One
 * undeletable file (locked by another process, replaced by a directory, ...) is
 * reported in `skipped` and the rest of the pruning still happens; only a
 * listing failure makes the whole call fail, because then there is nothing to
 * reason about.
 */
import { rmSync } from '../fs-safe.js';

import { ERROR_CODES } from '../wire/errors.js';
import { BACKUP_KEEP_LIMIT } from '../wire/constants.js';
import { backupSizeOf, sha256OfBackup } from './backup.js';
import { listBackups } from './baseline.js';

/**
 * Clamp a caller-supplied limit to a usable one.
 *
 * `undefined` means "the caller said nothing", so the constant applies. Anything
 * else that is not a positive integer becomes 1: never 0, never "keep none".
 * `2.5` is not an integer and `'x'` is not a number, and neither may silently
 * become a different number than the caller asked for — 1 is the smallest
 * meaningful limit, and it is the one that leaves a restorable copy.
 *
 * @param {unknown} value
 * @param {number} fallback used when the caller passed nothing at all
 * @returns {number}
 */
function normalizeLimit(value, fallback) {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

/**
 * Prune old backups, keeping at most `limit` copies (the protected one included).
 *
 * @param {string} asarPath path of the archive whose siblings get pruned
 * @param {{ limit?: number, protectSha256?: string, dryRun?: boolean }} [options]
 *   `protectSha256` is the digest of the baseline that must survive (normally the
 *   copy `ensureBaselineBackup` just returned); `dryRun` computes the plan and
 *   deletes nothing.
 * @returns {Promise<
 *   { ok: true, limit: number, total: number,
 *     kept: { name: string, size: number }[],
 *     removed: { name: string, size: number, sha256: string|null }[],
 *     protected: { name: string, size: number }[] | null,
 *     skipped: { name: string, reason: string }[] }
 *   | { ok: false, code: string, message: string }
 * >}
 *   `total` counts the backups before pruning; in the ordinary case
 *   `total === kept.length + removed.length + skipped.length` (a file that
 *   vanishes mid-run lands in `skipped` instead of `removed`). Never throws.
 */
export async function pruneBackups(asarPath, options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {};
  const limit = normalizeLimit(settings.limit, BACKUP_KEEP_LIMIT);
  const dryRun = settings.dryRun === true;
  const wantSha = typeof settings.protectSha256 === 'string' && settings.protectSha256.trim().length > 0
    ? settings.protectSha256.trim().toLowerCase()
    : '';

  try {
    const listed = await listBackups(asarPath);
    if (listed.ok !== true) {
      // An unreadable (or missing) directory is the only failure that stops the
      // call: there is no backlog to reason about.
      return { ok: false, code: listed.code ?? ERROR_CODES.ENO_BACKUP, message: listed.message };
    }

    const backups = listed.backups; // newest first
    const total = backups.length;

    // One hash per file, even when the protection scan and the removal both
    // want it. Entries are immutable files under a `.bak` name; a replaced path
    // is caught by the size check at each use site.
    const digests = new Map();
    const digestOf = async (entry) => {
      if (digests.has(entry.path)) return digests.get(entry.path);
      const digest = await sha256OfBackup(entry.path);
      digests.set(entry.path, digest);
      return digest;
    };

    // --- protection scan -------------------------------------------------
    //
    // Same size-then-hash approach `findReusableBackup` uses: a backup that
    // could restore THIS archive must have the archive's exact length, so those
    // candidates are hashed first and the matching one is usually the newest
    // (the copy the install just wrote). The remaining candidates are only
    // hashed when the first group does not contain the wanted digest — that
    // keeps the common case at a single 209 MB read instead of N of them.
    let protectedEntry = null;
    if (wantSha.length > 0) {
      const archiveSize = backupSizeOf(asarPath);
      const sameSize = [];
      const rest = [];
      for (const entry of backups) {
        if (archiveSize > 0 && entry.size === archiveSize) sameSize.push(entry);
        else rest.push(entry);
      }
      for (const group of [sameSize, rest]) {
        for (const candidate of group) {
          // Cheap TOCTOU guard: a file replaced since the listing is not the
          // same candidate, and hashing it would only produce a stale answer.
          if (backupSizeOf(candidate.path) !== candidate.size) continue;
          const digest = await digestOf(candidate);
          if (digest === null) continue; // unreadable mid-scan: try the next one
          if (digest === wantSha) {
            protectedEntry = candidate;
            break;
          }
        }
        if (protectedEntry !== null) break;
      }
    }

    // --- keep/remove arithmetic -----------------------------------------
    //
    // The protected copy survives no matter where it sits in the newest-first
    // list, and it spends one slot of the limit: `keepCount = limit - 1` of the
    // unprotected entries survive when a baseline is protected, `limit` when
    // nothing is. Clamped at 0 so a limit of 1 plus a protected copy means "keep
    // only the protected one" instead of a negative slice.
    const others = protectedEntry === null ? backups : backups.filter((entry) => entry !== protectedEntry);
    const keepCount = Math.max(0, limit - (protectedEntry === null ? 0 : 1));
    const survivors = others.slice(0, keepCount);
    const doomed = others.slice(keepCount);

    // --- delete ----------------------------------------------------------
    //
    // Hash first: `removed[].sha256` is what lets the audit say *which* baseline
    // was thrown away, and after the file is gone that is no longer knowable.
    const removed = [];
    const skipped = [];
    for (const entry of doomed) {
      const digest = await digestOf(entry);
      if (dryRun) {
        removed.push({ name: entry.name, size: entry.size, sha256: digest });
        continue;
      }
      try {
        rmSync(entry.path, { force: true });
        removed.push({ name: entry.name, size: entry.size, sha256: digest });
      } catch (error) {
        // One undeletable file must not abort the rest: record it and move on.
        // The file stays on disk, so it is still a backup, just not a counted
        // one for this run.
        skipped.push({
          name: entry.name,
          reason: `删除失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // `kept` is what remains on disk, ordered like the listing: newest first,
    // protected copy included (it is still a backup).
    const kept = [...survivors, ...(protectedEntry === null ? [] : [protectedEntry])]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((entry) => ({ name: entry.name, size: entry.size }));

    return {
      ok: true,
      limit,
      total,
      kept,
      removed,
      protected: protectedEntry === null ? null : [{ name: protectedEntry.name, size: protectedEntry.size }],
      skipped,
    };
  } catch (error) {
    // Last-resort net: nothing above is supposed to throw, and housekeeping must
    // never take an install down with it. Reported as a write failure because
    // that is what the caller would otherwise have had to catch.
    return {
      ok: false,
      code: ERROR_CODES.EWRITE_FAILED,
      message: `清理旧备份失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
