/**
 * Backup, restore and naming for the asar.
 *
 * A backup is the only trusted source of stock bytes. Restoring prefers an
 * in-place overwrite of an equal-size archive because Windows keeps `app.asar`
 * open while DSH runs: a rename over it fails with EPERM, while an in-place
 * write of the same length succeeds.
 */
import { closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, fsyncSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeSync } from '../fs-safe.js';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { ERROR_CODES } from '../wire/errors.js';
import { sha256File } from '../asar/hash.js';

/** Pad a number to two digits. */
function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Build the backup file name: local time plus the DSH version.
 * Example: `app.asar.20261113-0200.v0.2.2-rc.2.bak`
 *
 * @param {string} version
 * @param {Date} [date]
 * @returns {string}
 */
export function backupFileName(version, date = new Date()) {
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
  const raw = String(version ?? 'unknown').trim();
  const tag = raw.startsWith('v') ? raw : `v${raw}`;
  return `app.asar.${stamp}.${tag}.bak`;
}

/**
 * Stream-copy the asar into a fresh backup file and verify it byte for byte.
 *
 * @param {string} asarPath
 * @param {string} version
 * @param {{ date?: Date }} [options]
 * @returns {Promise<{ ok: true, backupPath: string, size: number, sha256: string } | { ok: false, code: string, message: string }>}
 */
export async function createBackup(asarPath, version, options = {}) {
  if (!existsSync(asarPath)) {
    return { ok: false, code: ERROR_CODES.EBASAR_MISSING, message: '找不到要备份的 app.asar' };
  }

  const dir = dirname(asarPath);
  const base = backupFileName(version, options.date ?? new Date());
  let target = join(dir, base);
  for (let index = 2; existsSync(target) && index < 100; index += 1) {
    target = join(dir, base.replace(/\.bak$/, `-${index}.bak`));
  }

  try {
    const sourceSha = await sha256File(asarPath);
    await pipeline(createReadStream(asarPath), createWriteStream(target));
    const copiedSha = await sha256File(target);
    if (copiedSha !== sourceSha) {
      rmSync(target, { force: true });
      return {
        ok: false,
        code: ERROR_CODES.EBACKUP_FAILED,
        message: '备份复制后哈希与源不一致（磁盘错误？），已删除坏备份',
      };
    }
    return { ok: true, backupPath: target, size: statSync(target).size, sha256: copiedSha };
  } catch (error) {
    try { rmSync(target, { force: true }); } catch { /* best effort */ }
    return {
      ok: false,
      code: ERROR_CODES.EBACKUP_FAILED,
      message: `备份失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Size of a backup file, or 0 when it cannot be read.
 *
 * The size is the cheapest discriminator there is: two backups of the same DSH
 * version are either equal in length (and worth hashing) or not (and cannot be
 * the wanted bytes at all). 0 is a safe sentinel because a real archive backup
 * is never empty, and the callers only ever compare it against a positive size.
 *
 * @param {string} path
 * @returns {number}
 */
export function backupSizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Verify a backup's digest, swallowing every failure.
 *
 * Callers here are *searching* for a match: an unreadable or half-deleted
 * candidate must make that one candidate useless, not abort the search — the
 * next backup may still be the one we want. `null` therefore means "no verified
 * digest available", never "this file has no bytes".
 *
 * @param {string} path
 * @returns {Promise<string|null>}
 */
export async function sha256OfBackup(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  if (backupSizeOf(path) === 0) return null;
  try {
    return await sha256File(path);
  } catch {
    return null;
  }
}

/**
 * Find a backup whose verified digest is `want`: same-size-as-the-archive
 * candidates first, then the rest, each group newest-first.
 *
 * `restoreFromBackup` can only rewrite in place when the backup and the archive
 * have the same length, so a same-size candidate is both the only one that is
 * likely to work *and* the only one worth hashing early. Trying those first
 * means the common case needs one hash, while the full scan stays the rare
 * fallback: a 209 MB hash per remaining candidate, until one matches.
 *
 * @param {{ path: string, size: number, mtimeMs: number }[]} candidates
 * @param {string} want lower-case hex sha256
 * @param {number} archiveSize length that makes a candidate restorable in place
 * @returns {Promise<{ path: string, size: number, sha256: string } | null>}
 */
async function findBySha(candidates, want, archiveSize) {
  const ordered = [...candidates].sort((a, b) => {
    const aInPlace = Number(a.size === archiveSize);
    const bInPlace = Number(b.size === archiveSize);
    return aInPlace !== bInPlace ? bInPlace - aInPlace : b.mtimeMs - a.mtimeMs;
  });
  for (const candidate of ordered) {
    if (backupSizeOf(candidate.path) !== candidate.size) continue; // replaced since listing
    const digest = await sha256OfBackup(candidate.path);
    if (digest === null) continue;
    if (digest === want) return { path: candidate.path, size: candidate.size, sha256: digest };
  }
  return null;
}

/**
 * Find a backup next to the archive: newest one, or the recorded baseline.
 *
 * Default behaviour is unchanged from the first version of this module: the
 * newest `app.asar.*.bak` wins, because "undo the last install" means the copy
 * the last install wrote. `options.preferSha256` exists for the other question:
 * after an upgrade, the *newest* backup may be a leftover of some other
 * version, while the install record still names the digest that would restore
 * this machine's stock baseline — then that recorded digest outranks mtime.
 * The recorded candidate is verified by hashing (a few hundred milliseconds
 * for a 209 MB backup, acceptable for a restore), and when nothing matches we
 * quietly fall back to newest-wins rather than refuse: a stale record must not
 * make a perfectly restorable archive unrestorable.
 *
 * @param {string} asarPath
 * @param {{ preferSha256?: string }} [options]
 * @returns {{ ok: true, backupPath: string, size: number, sha256: string } | { ok: false, code: string, message: string }}
 */
export async function findBackup(asarPath, options = {}) {
  try {
    const dir = dirname(asarPath);
    const names = readdirSync(dir).filter((name) => name.startsWith('app.asar.') && name.endsWith('.bak'));
    if (names.length === 0) {
      return { ok: false, code: ERROR_CODES.ENO_BACKUP, message: '没有找到备份，无法还原' };
    }
    const candidates = [];
    let best = null;
    for (const name of names) {
      const path = join(dir, name);
      const info = statSync(path);
      candidates.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      if (best === null || info.mtimeMs > best.mtimeMs) best = { path, size: info.size, mtimeMs: info.mtimeMs };
    }

    const prefer = typeof options?.preferSha256 === 'string' ? options.preferSha256.trim().toLowerCase() : '';
    if (prefer.length > 0) {
      const archiveSize = backupSizeOf(asarPath);
      const preferred = await findBySha(candidates, prefer, archiveSize);
      if (preferred !== null) {
        return { ok: true, backupPath: preferred.path, size: preferred.size, sha256: preferred.sha256 };
      }
    }

    return { ok: true, backupPath: best.path, size: best.size, sha256: await sha256File(best.path) };
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.ENO_BACKUP,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Copy one file into another in place, without changing the target's length
 * (4 MiB blocks, then fsync).
 *
 * @param {string} source
 * @param {string} target
 * @param {number} length
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function overwriteInPlace(source, target, length) {
  let src;
  let dst;
  try {
    src = openSync(source, 'r');
    dst = openSync(target, 'r+');
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    let written = 0;
    while (written < length) {
      const want = Math.min(buffer.length, length - written);
      const got = readSync(src, buffer, 0, want, written);
      if (got <= 0) break;
      writeSync(dst, buffer, 0, got, written);
      written += got;
    }
    fsyncSync(dst);
    if (written !== length) {
      return { ok: false, code: ERROR_CODES.EWRITE_FAILED, message: `原位还原只写了 ${written}/${length} 字节` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.ERUNNING_LOCKED,
      message: `原位还原失败（DSH 可能正锁着 asar）：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (src !== undefined) { try { closeSync(src); } catch { /* closed */ } }
    if (dst !== undefined) { try { closeSync(dst); } catch { /* closed */ } }
  }
}

/**
 * Restore the archive from a backup.
 *
 * Equal sizes are restored in place (works while DSH runs). A size mismatch
 * means a different DSH version, which cannot be done safely while the archive
 * is open: refuse and tell the user to quit DSH first.
 *
 * @param {string} asarPath
 * @param {string} backupPath
 * @param {{ expectedStockSha?: string }} [options]
 * @returns {Promise<{ ok: true, restoredSha: string, mode: 'in-place' } | { ok: false, code: string, message: string }>}
 */
export async function restoreFromBackup(asarPath, backupPath, options = {}) {
  if (!existsSync(backupPath)) {
    return { ok: false, code: ERROR_CODES.ENO_BACKUP, message: '备份文件不存在' };
  }
  const backupInfo = statSync(backupPath);
  const asarInfo = statSync(asarPath);

  if (options.expectedStockSha) {
    const actual = await sha256File(backupPath);
    if (actual !== options.expectedStockSha) {
      return {
        ok: false,
        code: ERROR_CODES.EBACKUP_HASH,
        message: '备份的哈希与期望的官方版本不一致，拒绝还原',
      };
    }
  }

  if (backupInfo.size !== asarInfo.size) {
    return {
      ok: false,
      code: ERROR_CODES.ERUNNING_LOCKED,
      message: `备份大小 ${backupInfo.size} 与当前 asar ${asarInfo.size} 不同（跨版本），请先完全退出 DSH 再还原`,
    };
  }

  const inPlace = overwriteInPlace(backupPath, asarPath, asarInfo.size);
  if (inPlace.ok !== true) return inPlace;

  const restoredSha = await sha256File(asarPath);
  const backupSha = await sha256File(backupPath);
  if (restoredSha !== backupSha) {
    return {
      ok: false,
      code: ERROR_CODES.EWRITE_VERIFY,
      message: '还原后哈希与备份不一致',
    };
  }
  return { ok: true, restoredSha, mode: 'in-place' };
}

/**
 * Whether a same-size restore is possible right now (a cheap pre-flight check).
 *
 * @param {string} asarPath
 * @param {string} backupPath
 * @returns {boolean}
 */
export function canRestoreInPlace(asarPath, backupPath) {
  try {
    return statSync(asarPath).size === statSync(backupPath).size;
  } catch {
    return false;
  }
}


