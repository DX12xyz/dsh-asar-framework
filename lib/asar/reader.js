/**
 * Read-only asar reader: the single definition of "what is inside app.asar".
 *
 * Layout of an asar file (Chromium pickle preamble + JSON directory + data):
 *
 *   offset 0  u32  pickle payload size     (header size - 4; ignored here)
 *   offset 4  u32  header pickle size      (unused)
 *   offset 8  u32  header payload size     (unused)
 *   offset 12 u32  raw JSON header size    <- reported as `headerSize`
 *   offset 16 ...  JSON directory, padded up to a multiple of 4
 *   dataStart = 16 + align4(rawHeaderSize)
 *
 * Every entry `offset` in the directory is relative to `dataStart`.
 *
 * The directory alone cannot prove the computed data start: a truncated or
 * wrongly re-packed archive still parses as JSON. So `openAsar` hashes the real
 * bytes of `lib/main.js` and compares them with the digest the directory
 * records in `integrity.hash`. A mismatch means the data start (or the file) is
 * wrong -> `EASAR_HEADER`. This is the gate that makes every later absolute
 * offset trustworthy.
 *
 * Nothing in this module writes anything.
 */

import { closeSync, openSync, readSync, statSync } from '../fs-safe.js';

import { ERROR_CODES } from '../wire/errors.js';
import { MAIN_RELATIVE_PATH } from '../wire/constants.js';
import { sha256Buffer } from './hash.js';

/** Size of the pickle preamble that precedes the JSON header. */
export const PICKLE_PREAMBLE_BYTES = 16;

/** Chunk size used when hashing one entry inside an open file descriptor. */
const ENTRY_HASH_CHUNK = 4 * 1024 * 1024;

/**
 * Round a byte count up to the next multiple of four.
 *
 * @param {number} value
 * @returns {number}
 */
export function align4(value) {
  return value % 4 === 0 ? value : value + (4 - (value % 4));
}

/**
 * @typedef {{
 *   size: number,
 *   offset: number,
 *   unpacked: boolean,
 *   integrity: object|null,
 * }} EntryInfo
 * @typedef {{
 *   ok: true,
 *   headerSize: number,
 *   dataStart: number,
 *   entries: Map<string, EntryInfo>,
 *   mainEntry: EntryInfo|null,
 *   asarPath: string,
 *   fileSize: number,
 *   header: object,
 *   fd: number|null,
 * }} OpenAsarOk
 * @typedef {{ ok: false, code: string, message: string }} OpenAsarFailure
 */

/**
 * Open an asar read-only and build a flat entry map.
 *
 * The archive is read through a short-lived descriptor: by default the returned
 * object holds none, and {@link readEntry} / {@link readEntryRange} open the
 * file for the duration of a single read. Pass `{ keepOpen: true }` when many
 * entries are read in a row (or when a consistent view matters more than
 * descriptor hygiene) and call {@link closeAsar} afterwards.
 *
 * @param {string} asarPath
 * @param {{ keepOpen?: boolean }} [options]
 * @returns {OpenAsarOk | OpenAsarFailure}
 */
export function openAsar(asarPath, options = {}) {
  if (typeof asarPath !== 'string' || asarPath.length === 0) {
    return { ok: false, code: ERROR_CODES.EINVALID_INPUT, message: '没有给出 asar 路径' };
  }
  // Descriptors are NOT held by default: the Host re-opens the archive on
  // every snapshot and never calls closeAsar, so holding one per call would
  // leak a handle every few seconds. Callers that read many entries in a row
  // (or need a consistent view) opt in with { keepOpen: true } and must then
  // call closeAsar.
  const keepOpen = options.keepOpen === true;
    // Detection and restore must be able to read a patched archive whose
    // `lib/main.js` digest is legitimately stale (we changed those bytes).
    const allowStaleMainIntegrity = options.allowStaleMainIntegrity === true;

  let fileSize;
  try {
    fileSize = statSync(asarPath).size;
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.EASAR_MISSING,
      message: `打不开 asar：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (fileSize < PICKLE_PREAMBLE_BYTES + 8) {
    return { ok: false, code: ERROR_CODES.EASAR_HEADER, message: '文件太小，不是 asar' };
  }

  let fd;
  try {
    fd = openSync(asarPath, 'r');
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.EASAR_MISSING,
      message: `打不开 asar：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  /** Set to true only on the success path, where the caller owns the descriptor. */
  let handOff = false;
  try {
    const preamble = Buffer.alloc(PICKLE_PREAMBLE_BYTES);
    readSync(fd, preamble, 0, PICKLE_PREAMBLE_BYTES, 0);
    const headerSize = preamble.readUInt32LE(12);
    if (headerSize === 0 || PICKLE_PREAMBLE_BYTES + headerSize > fileSize) {
      return {
        ok: false,
        code: ERROR_CODES.EASAR_HEADER,
        message: `asar 目录头长度不合理：${headerSize}（文件 ${fileSize} 字节）`,
      };
    }

    const headerBuffer = Buffer.alloc(headerSize);
    readSync(fd, headerBuffer, 0, headerSize, PICKLE_PREAMBLE_BYTES);
    // Some packers include the 4-byte alignment padding inside the recorded
    // header size; the real DSH build does not. Trailing NUL bytes carry no
    // information, so drop them before parsing rather than reject a file that
    // is otherwise readable. The integrity gate below is what proves the
    // computed data start, not the absence of padding.
    const text = headerBuffer.toString('utf8').replace(/\u0000+$/, '');
    if (!text.trimStart().startsWith('{')) {
      return { ok: false, code: ERROR_CODES.EASAR_HEADER, message: 'asar 目录头不是 JSON 对象' };
    }

    let header;
    try {
      header = JSON.parse(text);
    } catch (error) {
      return {
        ok: false,
        code: ERROR_CODES.EASAR_HEADER,
        message: `asar 目录头 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (header === null || typeof header !== 'object' || header.files === null || typeof header.files !== 'object') {
      return { ok: false, code: ERROR_CODES.EASAR_HEADER, message: 'asar 目录头缺少 files 结构' };
    }

    let dataStart = PICKLE_PREAMBLE_BYTES + align4(headerSize);
    if (dataStart > fileSize) {
      return { ok: false, code: ERROR_CODES.EASAR_HEADER, message: '数据区起点越过文件末尾' };
    }

    const entries = flattenEntries(header.files);
    const mainEntry = entries.get(MAIN_RELATIVE_PATH) ?? null;

    // Integrity gate: hash the real main-entry bytes and compare with the digest
    // the directory claims. This does two jobs:
    //   1. it PROVES the computed data start (a shifted start changes the digest);
    //   2. it tells the caller whether the archive is pristine.
    //
    // By default a mismatch is a hard failure. `allowStaleMainIntegrity: true`
    // relaxes that for the two workflows that must still read a patched archive:
    // status detection and restore (they *need* to see the patched bytes).
    let integrityVerified = false;
    let integrityDetail = 'no lib/main.js entry to verify';
    if (mainEntry !== null && mainEntry.unpacked === false) {
      const expected = readIntegrityHash(mainEntry);
      if (expected === null) {
        if (allowStaleMainIntegrity !== true) {
          return {
            ok: false,
            code: ERROR_CODES.EASAR_HEADER,
            message: '目录头里 lib/main.js 没有 integrity 哈希，无法确认数据区起点',
          };
        }
        integrityDetail = 'lib/main.js has no integrity hash in the directory';
      } else {
        // The pickle spec fixes the start at 16 + align4(headerSize); neighbouring
        // values are tried only to diagnose a non-conforming header.
        const candidates = [dataStart, dataStart + 4, dataStart - 4, dataStart + 8];
        for (const candidate of candidates) {
          if (candidate < PICKLE_PREAMBLE_BYTES) continue;
          const absolute = candidate + mainEntry.offset;
          if (absolute + mainEntry.size > fileSize) continue;
          const digest = sha256FdRange(fd, absolute, mainEntry.size);
          if (digest === expected) {
            dataStart = candidate;
            integrityVerified = true;
            integrityDetail = 'lib/main.js matches its recorded digest';
            break;
          }
        }
        if (!integrityVerified) {
          integrityDetail = 'lib/main.js differs from its recorded digest (patched or foreign)';
          if (allowStaleMainIntegrity !== true) {
            return {
              ok: false,
              code: ERROR_CODES.EASAR_HEADER,
              message: `lib/main.js 实际哈希与目录头不一致（dataStart=${dataStart} 可能算错，或 asar 已被打补丁）`,
            };
          }
        }
      }
    }

    handOff = true;
    return {
      ok: true,
      headerSize,
      dataStart,
      entries,
      mainEntry,
      asarPath,
      fileSize,
      header,
      integrityVerified,
      integrityDetail,
      fd: keepOpen ? fd : null,
    };
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.EASAR_HEADER,
      message: `读取 asar 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (!handOff || !keepOpen) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Close the descriptor held by an opened asar. Safe to call twice.
 *
 * @param {OpenAsarOk|OpenAsarFailure|null} asar
 * @returns {void}
 */
export function closeAsar(asar) {
  if (asar === null || typeof asar !== 'object' || asar.ok !== true) return;
  if (typeof asar.fd === 'number') {
    try { closeSync(asar.fd); } catch { /* already closed */ }
    asar.fd = null;
  }
}

/**
 * Walk the nested `files` tree into a flat `Map<"a/b/c", entry>`.
 * Directory nodes (those that carry `files`) are not entries themselves.
 *
 * @param {Record<string, object>} files
 * @returns {Map<string, EntryInfo>}
 */
function flattenEntries(files) {
  /** @type {Map<string, EntryInfo>} */
  const map = new Map();
  const stack = [{ node: files, prefix: '' }];
  while (stack.length > 0) {
    const item = stack.pop();
    for (const [name, value] of Object.entries(item.node)) {
      if (value === null || typeof value !== 'object') continue;
      const path = item.prefix === '' ? name : `${item.prefix}/${name}`;
      if (value.files !== null && typeof value.files === 'object') {
        stack.push({ node: value.files, prefix: path });
        continue;
      }
      map.set(path, {
        size: Number(value.size ?? 0),
        offset: Number(value.offset ?? 0),
        unpacked: value.unpacked === true,
        integrity: value.integrity ?? null,
      });
    }
  }
  return map;
}

/**
 * The SHA-256 digest a directory entry claims, or null when it carries none
 * (or claims another algorithm).
 *
 * @param {EntryInfo} entry
 * @returns {string|null}
 */
function readIntegrityHash(entry) {
  const integrity = entry.integrity;
  if (integrity === null || typeof integrity !== 'object') return null;
  if (typeof integrity.hash !== 'string' || integrity.hash.length !== 64) return null;
  const algorithm = typeof integrity.algorithm === 'string' ? integrity.algorithm.toUpperCase() : 'SHA256';
  if (algorithm !== 'SHA256') return null;
  return integrity.hash.toLowerCase();
}

/**
 * Hash `size` bytes of an open descriptor starting at `absolute`, in chunks.
 *
 * @param {number} fd
 * @param {number} absolute
 * @param {number} size
 * @returns {string}
 */
function sha256FdRange(fd, absolute, size) {
  const parts = [];
  let position = 0;
  while (position < size) {
    const length = Math.min(ENTRY_HASH_CHUNK, size - position);
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const got = readSync(fd, buf, read, length - read, absolute + position + read);
      if (got <= 0) throw new Error(`hashing stalled at byte ${absolute + position + read}`);
      read += got;
    }
    parts.push(buf);
    position += length;
  }
  return sha256Buffer(Buffer.concat(parts));
}

/**
 * Read one entry's bytes.
 *
 * @param {OpenAsarOk} asar
 * @param {string} path slash-separated entry path
 * @returns {Buffer|null} null when the entry is missing or unpacked on disk
 */
export function readEntry(asar, path) {
  const info = entryInfo(asar, path);
  if (info === null || info.unpacked) return null;
  return readEntryRange(asar, info.offset, info.size);
}

/**
 * Read one entry as UTF-8 text.
 *
 * @param {OpenAsarOk} asar
 * @param {string} path
 * @returns {string|null}
 */
export function readEntryText(asar, path) {
  const buf = readEntry(asar, path);
  return buf === null ? null : buf.toString('utf8');
}

/**
 * Look up an entry without reading its bytes.
 *
 * @param {OpenAsarOk} asar
 * @param {string} path
 * @returns {{ size: number, offset: number, unpacked: boolean, integrity: object|null }|null}
 */
export function entryInfo(asar, path) {
  if (asar === null || typeof asar !== 'object' || asar.ok !== true) return null;
  if (asar.entries === null || typeof asar.entries !== 'object' || typeof asar.entries.get !== 'function') return null;
  const normalized = normalizeEntryPath(path);
  if (normalized === null) return null;
  const entry = asar.entries.get(normalized);
  if (entry === undefined) return null;
  return {
    size: entry.size,
    offset: entry.offset,
    unpacked: entry.unpacked,
    integrity: entry.integrity ?? null,
  };
}

/**
 * Absolute position of an entry's first byte inside the asar file.
 *
 * @param {OpenAsarOk} asar
 * @param {string} path
 * @returns {number|null} null when missing, unpacked, or out of bounds
 */
export function absoluteOffsetOf(asar, path) {
  const info = entryInfo(asar, path);
  if (info === null || info.unpacked) return null;
  if (asar.dataStart + info.offset + info.size > asar.fileSize) return null;
  return asar.dataStart + info.offset;
}

/**
 * Read a byte range measured from the data start (entry-relative offsets).
 *
 * @param {OpenAsarOk} asar
 * @param {number} offset relative to `dataStart`
 * @param {number} size
 * @returns {Buffer|null}
 */
export function readEntryRange(asar, offset, size) {
  if (asar === null || typeof asar !== 'object' || asar.ok !== true) return null;
  if (!Number.isInteger(offset) || !Number.isInteger(size) || offset < 0 || size < 0) return null;
  const absolute = asar.dataStart + offset;
  if (absolute + size > asar.fileSize) return null;
  if (size === 0) return Buffer.alloc(0);

  const own = typeof asar.fd === 'number' ? asar.fd : null;
  let fd = own;
  let opened = false;
  try {
    if (fd === null) {
      fd = openSync(asar.asarPath, 'r');
      opened = true;
    }
    const buf = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const got = readSync(fd, buf, read, size - read, absolute + read);
      if (got <= 0) return null;
      read += got;
    }
    return buf;
  } catch {
    return null;
  } finally {
    if (opened && fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Normalize a caller-supplied entry path: forward slashes, no leading or
 * trailing slash, no `.` segments.
 *
 * @param {unknown} path
 * @returns {string|null}
 */
export function normalizeEntryPath(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  const parts = path.replace(/\\/g, '/').split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.length === 0) return null;
  return parts.join('/');
}

/**
 * Read and parse the root `package.json` of an opened asar.
 *
 * @param {OpenAsarOk} asar
 * @returns {{ name?: string, version?: string, main?: string }|null}
 */
export function readRootPackage(asar) {
  const text = readEntryText(asar, 'package.json');
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Number of flat file entries (directories excluded).
 *
 * @param {OpenAsarOk} asar
 * @returns {number}
 */
export function entryCount(asar) {
  if (asar === null || typeof asar !== 'object' || asar.ok !== true) return 0;
  return asar.entries instanceof Map ? asar.entries.size : 0;
}
