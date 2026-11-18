/**
 * Region write path: the only module that modifies bytes of `app.asar`.
 *
 * A "region" is a fixed-length byte range inside `lib/main.js`. Everything here
 * is length-preserving: the archive size, its JSON directory and every entry
 * offset must stay byte-identical, and the only thing that changes is the
 * content of that one range. Backups are the job of `lib/install/backup.js`;
 * locating the range is the job of `./locate.js`, re-exported here so callers
 * have a single import for the whole region contract.
 */

import { closeSync, fsyncSync, openSync, readSync, statSync, writeSync } from '../fs-safe.js';

import { REGION_LENGTH } from '../wire/constants.js';
import { ERROR_CODES } from '../wire/errors.js';
import { sha256Buffer } from './hash.js';
import { locateRegion } from './locate.js';
import {
  buildPatchedRegion,
  PATCH_BODY_BYTES,
  MINIMUM_REGION_LENGTH,
  PATCH_MARKER,
  REGION_END_MARKER,
  REGION_START_MARKER,
} from './patch-body.js';

export {
  buildPatchedRegion,
  PATCH_BODY_BYTES,
  MINIMUM_REGION_LENGTH,
  PATCH_MARKER,
  REGION_END_MARKER,
  REGION_START_MARKER,
  locateRegion,
};

/**
 * The stock region unchanged (identity, guarded by an optional digest check).
 *
 * @param {Buffer} stockBytes the region bytes read from a stock archive
 * @param {string} [expectedSha256] when given, must match `stockBytes`
 * @returns {Buffer} a copy of `stockBytes`
 * @throws {Error} when the digest does not match
 */
export function buildStockRegion(stockBytes, expectedSha256) {
  if (!Buffer.isBuffer(stockBytes)) throw new TypeError('buildStockRegion expects a Buffer');
  if (typeof expectedSha256 === 'string' && expectedSha256.length > 0) {
    const actual = sha256Buffer(stockBytes);
    if (actual !== expectedSha256) {
      throw new Error(`stock region 哈希不符：期望 ${expectedSha256}，实际 ${actual}`);
    }
  }
  return Buffer.from(stockBytes);
}

/**
 * Overwrite a byte range in place. The file length is never changed.
 *
 * @param {string} asarPath
 * @param {number} absoluteOffset absolute byte offset of the range
 * @param {Buffer} buffer replacement bytes
 * @returns {{ ok: true, bytesWritten: number, sha256: string } | { ok: false, code: string, message: string }}
 */
export function writeRegion(asarPath, absoluteOffset, buffer) {
  if (typeof asarPath !== 'string' || asarPath.length === 0) {
    return { ok: false, code: ERROR_CODES.EINVALID_INPUT, message: '没有给出 asar 路径' };
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, code: ERROR_CODES.EINVALID_INPUT, message: '没有给出要写入的槽位内容' };
  }
  if (!Number.isInteger(absoluteOffset) || absoluteOffset < 0) {
    return { ok: false, code: ERROR_CODES.EINVALID_INPUT, message: `槽位绝对偏移非法：${absoluteOffset}` };
  }

  let expectedSize;
  try {
    expectedSize = statSync(asarPath).size;
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.EASAR_MISSING,
      message: `打不开 asar：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (absoluteOffset + buffer.length > expectedSize) {
    return {
      ok: false,
      code: ERROR_CODES.EWRITE_FAILED,
      message: `槽位区间越界：${absoluteOffset}+${buffer.length} 超过文件 ${expectedSize} 字节`,
    };
  }

  let fd;
  try {
    fd = openSync(asarPath, 'r+');
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.EWRITE_FAILED,
      message: `以读写方式打开 asar 失败（DSH 可能正锁着它）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    let written = 0;
    while (written < buffer.length) {
      const wrote = writeSync(fd, buffer, written, buffer.length - written, absoluteOffset + written);
      if (wrote <= 0) throw new Error(`写入停在第 ${written} 字节`);
      written += wrote;
    }
    fsyncSync(fd);
    const afterSize = statSync(asarPath).size;
    if (afterSize !== expectedSize) {
      return {
        ok: false,
        code: ERROR_CODES.EWRITE_FAILED,
        message: `写入后文件长度变了：${afterSize} != ${expectedSize}`,
      };
    }
    return { ok: true, bytesWritten: written, sha256: sha256Buffer(buffer) };
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.EWRITE_FAILED,
      message: `写入槽位失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Re-read a range and compare its digest with the expected one.
 *
 * @param {string} asarPath
 * @param {number} absoluteOffset
 * @param {string} expectedSha256
 * @param {number} [length] defaults to the stock region length
 * @returns {{ ok: true, actual: string } | { ok: false, code: string, actual: string, expected: string, message: string }}
 */
export function verifyRegion(asarPath, absoluteOffset, expectedSha256, length = REGION_LENGTH) {
  let fd;
  try {
    fd = openSync(asarPath, 'r');
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const got = readSync(fd, buffer, read, length - read, absoluteOffset + read);
      if (got <= 0) break;
      read += got;
    }
    if (read !== length) {
      return {
        ok: false,
        code: ERROR_CODES.EWRITE_VERIFY,
        actual: '',
        expected: expectedSha256,
        message: `回读只得到 ${read}/${length} 字节`,
      };
    }
    const actual = sha256Buffer(buffer);
    if (actual === expectedSha256) return { ok: true, actual };
    return {
      ok: false,
      code: ERROR_CODES.EWRITE_VERIFY,
      actual,
      expected: expectedSha256,
      message: '写入后的回读校验未通过：槽位内容与期望哈希不一致',
    };
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.EWRITE_VERIFY,
      actual: '',
      expected: expectedSha256,
      message: `回读校验失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Assert the archive still has the size we recorded before writing.
 *
 * @param {string} asarPath
 * @param {number} expectedSize
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function verifyArchiveSize(asarPath, expectedSize) {
  try {
    const actual = statSync(asarPath).size;
    if (actual === expectedSize) return { ok: true };
    return {
      ok: false,
      code: ERROR_CODES.EWRITE_VERIFY,
      message: `asar 大小变了：${actual} != ${expectedSize}`,
    };
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.EWRITE_FAILED,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
