/**
 * Split-region surgery: insert OUR OWN region into `lib/main.js` right after the
 * pristine official tray slot, and shift everything that follows.
 *
 * WHY (the full measurement is in evidence/split-region-proto.mjs)
 * The 0.1.x layout REPLACES the official 1,253-byte tray slot with our own
 * `var DesktopTray = class`, padded back to exactly 1,253 bytes. That works only
 * because the byte COUNT of the archive never changes: every directory `offset`
 * stays valid for free. The price is that the replacement body must fit in
 * 1,253 bytes (it needs 1,214 — 39 B of slack).
 *
 * This layout leaves the official slot BYTE-FOR-BYTE pristine and adds a SECOND
 * region of its own (`SPLIT_START_MARKER` … `//#endregion`) immediately after it.
 * A `var` redeclaration of `DesktopTray` inside that region is legal, both
 * declarations run in source order, and the only `new DesktopTray(` call site is
 * far later in the file — so OUR class is the one that gets constructed. The
 * region can be any size (8 KiB by default), so the 39 B ceiling is gone.
 *
 * THE PRICE: inserting bytes INTO the middle of `lib/main.js` moves everything
 * after it, so this module is the part of the package that changes the archive's
 * LAYOUT (entry offsets and `lib/main.js`.`size`), not just its contents.
 *
 * The one invariant everything here is built around — and the only reason
 * uninstall is cheap — is that **the directory header keeps its exact byte
 * length**:
 *   - growing appends N bytes at EOF and rewrites integer fields whose digit
 *     count does not change, so no `integrity.blocks` payback and no re-hash of
 *     a 209 MB archive;
 *   - shrinking is pure arithmetic in reverse and reproduces the stock archive
 *     byte-for-byte, so uninstall needs the region length and the stock
 *     geometry, never a 209 MB backup.
 *
 * That property is BOUNDED: `lib/main.js`.`size` reaches 1,000,000 at a reserve
 * of 151,495 B, gaining a seventh digit (and the offsets would need another
 * ~797 MB). `planSplit` MEASURES that boundary on the archive in front of it —
 * it does not trust `REGION_RESERVE_LIMIT` — and REFUSES to plan when the rewrite
 * would change the header length. Dropping `integrity.blocks` to pay the byte
 * back is never an option here: it would make "shrink == stock" false.
 *
 * CONVENTIONS
 *   - Nothing here decides whether an install should happen: `planSplit` is
 *     read-only, and the caller decides.
 *   - `growRegion` / `shrinkRegion` re-derive the whole geometry from the FILE
 *     and cross-check it against the plan; a plan that disagrees with the file
 *     is refused instead of "corrected", because a wrong delta silently corrupts
 *     every offset after `lib/main.js`.
 *   - Every function returns a failure object instead of throwing; the only
 *     unavoidable throw is `buildSplitRegion` for a region that cannot fit.
 *   - Every refusal that depends on a NUMBER (header length, region fit, bounds,
 *     archive size) is decided BEFORE the first byte is written, so a refusal
 *     never leaves a half-written archive behind.
 *
 * Not-atomic, by construction: there is no in-place shift whose intermediate
 * state the OLD directory can still read (writing the grown `lib/main.js`
 * necessarily overwrites the first N bytes of the first moved entry), so a crash
 * between the data move and the directory rewrite is recovered from the baseline
 * backup. This module therefore performs NO backup work of its own — the caller
 * owns that, and must hold a verified baseline before calling `growRegion`.
 *
 * Known cost, unchanged here and worth repeating where it matters:
 * `lib/main.js`.`integrity.hash` keeps recording the STOCK digest, because
 * re-hashing would rewrite a 64-digit string and change the header length. A
 * grown archive therefore has to be read with `allowStaleMainIntegrity: true`;
 * after a shrink the recorded digest matches the bytes again by itself.
 */

import { closeSync, fsPromises, fsyncSync, openSync, readSync, statSync, writeSync } from '../fs-safe.js';

import {
  MAIN_RELATIVE_PATH,
  PATCH_MARKER,
  REGION_END_MARKER,
  REGION_RESERVE_BYTES,
  REGION_RESERVE_LIMIT,
  SPLIT_PATCH_MARKER,
  SPLIT_START_MARKER,
} from '../wire/constants.js';
import { ERROR_CODES } from '../wire/errors.js';
import { sha256Buffer, sha256File } from './hash.js';
import { locateRegion } from './locate.js';
import { SPLIT_MINIMUM_REGION_LENGTH } from './patch-body.js';
import { PICKLE_PREAMBLE_BYTES, closeAsar, entryInfo, openAsar, readEntry } from './reader.js';

/** Leading newline the region builder may put in front of the start marker. */
const REGION_LEAD = '\n';

/**
 * Build a failure object. Everything that can go wrong is reported this way —
 * the caller is a GUI action handler and has to be able to explain why nothing
 * happened.
 *
 * @param {string} code one of {@link ERROR_CODES}
 * @param {string} message human-readable reason
 * @param {Record<string, unknown>} [extra] machine-readable detail
 * @returns {{ ok: false, code: string, message: string }}
 */
function fail(code, message, extra = undefined) {
  return extra === undefined ? { ok: false, code, message } : { ok: false, code, message, ...extra };
}

/* --------------------------------------------------------------- plumbing -- */

/**
 * Read exactly `count` bytes at `position` through an already-open descriptor.
 *
 * @param {number} fd
 * @param {number} position absolute byte offset
 * @param {number} count
 * @returns {Buffer}
 * @throws {Error} on a short read (an environment failure, caught by the caller)
 */
function readAt(fd, position, count) {
  if (count === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(count);
  let got = 0;
  while (got < count) {
    const read = readSync(fd, buffer, got, count - got, position + got);
    if (read <= 0) throw new Error(`read stalled at byte ${position + got} (wanted ${count}, got ${got})`);
    got += read;
  }
  return buffer;
}

/**
 * Write `buffer` at `position` through an already-open `r+` descriptor. A write
 * starting at EOF extends the file, which is how the append works.
 *
 * @param {number} fd
 * @param {number} position absolute byte offset
 * @param {Buffer} buffer
 * @returns {number} bytes written
 * @throws {Error} when a write stalls (an environment failure)
 */
function writeAt(fd, position, buffer) {
  let written = 0;
  while (written < buffer.length) {
    const wrote = writeSync(fd, buffer, written, buffer.length - written, position + written);
    if (wrote <= 0) throw new Error(`write stalled at byte ${position + written}`);
    written += wrote;
  }
  return written;
}

/**
 * Read a byte range of the archive through an opened asar, falling back to a
 * dedicated descriptor when that handle carries none.
 *
 * @param {import('./reader.js').OpenAsarOk} asar
 * @param {number} absolute absolute byte offset in the file
 * @param {number} size
 * @returns {Buffer}
 */
function readThrough(asar, absolute, size) {
  if (typeof asar.fd === 'number') return readAt(asar.fd, absolute, size);
  const fd = openSync(asar.asarPath, 'r');
  try {
    return readAt(fd, absolute, size);
  } finally {
    closeSync(fd);
  }
}

/**
 * Open the archive read-only for planning, preferring the STRICT integrity gate
 * (which proves the computed `dataStart`) and falling back to the relaxed one for
 * an archive whose recorded `lib/main.js` digest is legitimately stale.
 *
 * @param {string} asarPath
 * @returns {{ ok: true, asar: import('./reader.js').OpenAsarOk, integrityVerified: boolean, integrityFallback: boolean } | { ok: false, code: string, message: string }}
 */
export function openArchive(asarPath) {
  if (typeof asarPath !== 'string' || asarPath.length === 0) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有给出 asar 路径');
  }
  const strict = openAsar(asarPath, { keepOpen: true });
  if (strict.ok === true) {
    return { ok: true, asar: strict, integrityVerified: strict.integrityVerified === true, integrityFallback: false };
  }
  const relaxed = openAsar(asarPath, { keepOpen: true, allowStaleMainIntegrity: true });
  if (relaxed.ok === true) {
    return { ok: true, asar: relaxed, integrityVerified: relaxed.integrityVerified === true, integrityFallback: true };
  }
  return fail(relaxed.code ?? ERROR_CODES.EASAR_HEADER, relaxed.message ?? 'asar 打不开');
}

/** Message used for every "our region is already where it belongs" answer. */
const PRESENT_REASON = 'split 区域已经在官方托盘槽位之后；二次安装需要搬移 0 字节，这里不重复插入';

/* ----------------------------------------------------------- layout facts -- */

/**
 * The packed entries that sit AFTER `lib/main.js`, sorted ascending — plus the
 * four properties the surgery needs, all verified here:
 * nothing overlaps `lib/main.js`; the tail starts exactly where that entry ends;
 * it has no gaps; it ends exactly at EOF.
 *
 * Why these properties and not merely "sorted offsets": moving a CONTIGUOUS tail
 * that ends at EOF by N and appending N at EOF is the only shape whose reverse is
 * exact. A gap would leave bytes `shrinkRegion` could not remove without knowing
 * the original file, and a tail not reaching EOF would need trailing junk moved
 * too. Refusing is honest; guessing is not.
 *
 * @param {import('./reader.js').OpenAsarOk} asar
 * @param {{ offset: number, size: number }} mainEntry
 * @returns {{ ok: true, trailing: Array<{ path: string, offset: number, size: number }>, dataBytes: number } | { ok: false, code: string, message: string }}
 */
function measureLayout(asar, mainEntry) {
  return measureTrailingLayout(asar, { ...mainEntry, path: MAIN_RELATIVE_PATH });
}

/**
 * The packed entries that sit AFTER an arbitrary anchor entry, sorted ascending
 * — plus the four properties a shift needs, all verified here.
 *
 * This is `measureLayout`'s body with the anchor generalised, so the append
 * surgery and the edit layer share EXACTLY ONE implementation of "what follows
 * this entry and can it be moved exactly". The anchor's own path is skipped; every
 * other packed entry is either part of the contiguous tail or must end before
 * the anchor starts.
 *
 * @param {import('./reader.js').OpenAsarOk} asar
 * @param {{ offset: number, size: number, path?: string }} anchor entry the tail starts after
 * @returns {{ ok: true, trailing: Array<{ path: string, offset: number, size: number }>, dataBytes: number } | { ok: false, code: string, message: string }}
 */
export function measureTrailingLayout(asar, anchor) {
  const mainStart = Number(anchor.offset);
  const mainSize = Number(anchor.size);
  const anchorPath = typeof anchor.path === 'string' ? anchor.path : MAIN_RELATIVE_PATH;
  const mainEnd = mainStart + mainSize;
  if (!Number.isInteger(mainStart) || !Number.isInteger(mainSize) || mainStart < 0 || mainSize < 0) {
    return fail(ERROR_CODES.EASAR_HEADER, `${anchorPath} 的目录项不可信：offset=${anchor.offset} size=${anchor.size}`);
  }
  const dataBytes = asar.fileSize - asar.dataStart;
  if (mainEnd > dataBytes) {
    return fail(ERROR_CODES.EASAR_HEADER, `${anchorPath} 越过了数据区末尾：${mainEnd} > ${dataBytes}`);
  }

  /** @type {Array<{ path: string, offset: number, size: number }>} */
  const trailing = [];
  for (const [path, info] of asar.entries) {
    if (info.unpacked || path === anchorPath) continue;
    // A zero-length entry occupies no bytes, so it can sit anywhere without
    // making the tail ambiguous; it never needs to move for a shift either.
    if (Number.isInteger(info.size) && info.size === 0 && Number.isInteger(info.offset) && info.offset >= mainStart) {
      continue;
    }
    if (!Number.isInteger(info.offset) || !Number.isInteger(info.size) || info.size < 0) {
      return fail(ERROR_CODES.EUNKNOWN_LAYOUT, `目录项 ${path} 的 offset/size 不是整数，无法安全搬移`);
    }
    if (info.offset >= mainEnd) {
      trailing.push({ path, offset: info.offset, size: info.size });
      continue;
    }
    // Starts before the end of main.js: only legal when it also ENDS before that
    // entry starts. Anything that straddles lib/main.js makes offsets ambiguous.
    if (info.offset + info.size > mainStart) {
      return fail(
        ERROR_CODES.EUNKNOWN_LAYOUT,
        `目录项 ${path} 与 lib/main.js 的字节区间重叠（${info.offset}+${info.size} > ${mainStart}），拒绝写入`,
      );
    }
  }
  trailing.sort((left, right) => left.offset - right.offset || left.path.localeCompare(right.path));

  if (trailing.length === 0) {
    if (mainEnd !== dataBytes) {
      return fail(
        ERROR_CODES.EUNKNOWN_LAYOUT,
        `lib/main.js 之后还有 ${dataBytes - mainEnd} 字节无人认领的数据，拒绝写入`,
        { unaccounted: dataBytes - mainEnd },
      );
    }
    return { ok: true, trailing, dataBytes };
  }
  if (trailing[0].offset !== mainEnd) {
    return fail(
      ERROR_CODES.EUNKNOWN_LAYOUT,
      `lib/main.js 之后的数据不紧接其后：main 结束于 ${mainEnd}，第一个条目 ${trailing[0].path} 起始于 ${trailing[0].offset}`
      + `（差 ${trailing[0].offset - mainEnd} 字节）。搬移带空隙的布局无法逐字节还原，拒绝写入`,
      { gap: trailing[0].offset - mainEnd, firstPath: trailing[0].path },
    );
  }
  for (let index = 1; index < trailing.length; index += 1) {
    const previous = trailing[index - 1];
    const current = trailing[index];
    const previousEnd = previous.offset + previous.size;
    if (previousEnd !== current.offset) {
      return fail(
        ERROR_CODES.EUNKNOWN_LAYOUT,
        `main.js 之后的数据有空隙：${previous.path} 结束于 ${previousEnd}，${current.path} 起始于 ${current.offset}`
        + `（差 ${current.offset - previousEnd} 字节），拒绝写入`,
        { gap: current.offset - previousEnd, afterPath: previous.path, beforePath: current.path },
      );
    }
  }
  const last = trailing[trailing.length - 1];
  const lastEnd = last.offset + last.size;
  if (lastEnd !== dataBytes) {
    return fail(
      ERROR_CODES.EUNKNOWN_LAYOUT,
      `数据区在最后一个条目之后还有 ${dataBytes - lastEnd} 字节尾部数据，拒绝写入`,
      { trailingJunk: dataBytes - lastEnd, lastPath: last.path },
    );
  }
  return { ok: true, trailing, dataBytes };
}

/**
 * Read the raw directory header text and parse it.
 *
 * @param {import('./reader.js').OpenAsarOk} asar
 * @returns {{ ok: true, text: string, parsed: object, canonical: string, padded: boolean } | { ok: false, code: string, message: string }}
 */
export function readHeader(asar) {
  try {
    const text = readThrough(asar, PICKLE_PREAMBLE_BYTES, asar.headerSize).toString('utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || parsed.files === null || typeof parsed.files !== 'object') {
      return fail(ERROR_CODES.EASAR_HEADER, 'asar 目录头不是带 files 的 JSON 对象');
    }
    // Some packers pad the JSON up to the aligned size with NULs; the reader drops
    // them. Keep the raw text so a grown header can be written back unchanged.
    const canonical = JSON.stringify(parsed);
    const padded = canonical.length <= text.length
      && text.slice(0, canonical.length) === canonical
      && /^ *$/.test(text.slice(canonical.length));
    // How many bytes of the header are SPACE padding. The edit layer needs this
    // as its first source of header growth budget: the stock rc.3 archive
    // measures 0, so a new entry has to be paid for out of `integrity.blocks`.
    const paddingBytes = padded
      ? Buffer.byteLength(text, 'utf8') - Buffer.byteLength(canonical, 'utf8')
      : 0;
    return { ok: true, text, parsed, canonical, padded, paddingBytes };
  } catch (error) {
    return fail(ERROR_CODES.EASAR_HEADER, `读不到 asar 目录头：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Split a slash-separated entry path into directory segments and a leaf name.
 *
 * @param {string} path
 * @returns {{ dirs: string[], name: string }}
 */
function splitPath(path) {
  const parts = path.split('/').filter((part) => part.length > 0);
  return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] };
}

/**
 * Resolve the node that holds `path` inside a parsed directory header.
 *
 * @param {object} header parsed directory
 * @param {string} path slash-separated entry path
 * @returns {Record<string, unknown>|null}
 */
export function nodeAt(header, path) {
  const { dirs, name } = splitPath(path);
  let cursor = header.files;
  for (const dir of dirs) {
    const next = cursor === null || typeof cursor !== 'object' ? undefined : cursor[dir];
    if (next === null || typeof next !== 'object') return null;
    const files = next.files;
    if (files === null || typeof files !== 'object') return null;
    cursor = files;
  }
  if (cursor === null || typeof cursor !== 'object') return null;
  const node = cursor[name];
  return node !== null && typeof node === 'object' ? node : null;
}

/**
 * Add a signed `delta` to an integer directory field, PRESERVING ITS JSON TYPE.
 *
 * Type preservation is not cosmetic: the shrink path is exact only when it
 * re-serialises the same tokens. On this shell `lib/main.js`.`size` is a JSON
 * number while the moved `offset`s are decimal STRINGS, so a numeric-izing
 * rewrite would turn `"offset":202358056` into `"offset":"202358056"` (or the
 * reverse) and break byte-for-byte restore.
 *
 * Also reports the HEADROOM: how much this field could still grow before its
 * digit count (and therefore the whole header's length) changes.
 *
 * @param {Record<string, unknown>} node directory node owning the field
 * @param {string} field `size` or `offset`
 * @param {number} delta signed byte delta
 * @returns {{ ok: true, before: number, after: number, headroom: number } | { ok: false, code: string, message: string }}
 */
export function shiftField(node, field, delta) {
  const value = node[field];
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isInteger(numeric) || numeric < 0) {
    return fail(ERROR_CODES.EUNKNOWN_LAYOUT, `目录字段 ${field}=${JSON.stringify(value)} 不是非负整数，无法安全加减`);
  }
  const after = numeric + delta;
  if (after < 0) {
    return fail(ERROR_CODES.EUNKNOWN_LAYOUT, `目录字段 ${field}=${numeric} 减去 ${-delta} 会变成负数`);
  }
  const digits = String(numeric).length;
  const headroom = Math.pow(10, digits) - numeric - 1;
  node[field] = typeof value === 'string' ? String(after) : after;
  return { ok: true, before: numeric, after, headroom };
}

/**
 * The directory text a grow (`mainDelta > 0`) or shrink (`mainDelta < 0`) would
 * write, computed WITHOUT touching the file.
 *
 * @param {string} headerText current raw header text (parsed fresh here)
 * @param {number} mainDelta signed delta for `lib/main.js`.`size`
 * @param {Array<{ path: string, delta: number }>} offsetShifts trailing entries
 * @returns {{ ok: true, text: string, bytes: number, headroom: number } | { ok: false, code: string, message: string }}
 */
function materializeHeader(headerText, mainDelta, offsetShifts) {
  let header;
  try {
    header = JSON.parse(headerText);
  } catch (error) {
    return fail(ERROR_CODES.EASAR_HEADER, `目录头 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const mainNode = nodeAt(header, MAIN_RELATIVE_PATH);
  if (mainNode === null) return fail(ERROR_CODES.EASAR_MAIN_MISSING, `目录头里没有 ${MAIN_RELATIVE_PATH} 的条目`);
  const mainShift = shiftField(mainNode, 'size', mainDelta);
  if (mainShift.ok !== true) return mainShift;

  let headroom = mainShift.headroom;
  for (const entry of offsetShifts) {
    const node = nodeAt(header, entry.path);
    if (node === null) return fail(ERROR_CODES.EUNKNOWN_LAYOUT, `目录头里找不到条目 ${entry.path}`);
    const moved = shiftField(node, 'offset', entry.delta);
    if (moved.ok !== true) return moved;
    if (moved.headroom < headroom) headroom = moved.headroom;
  }

  const text = JSON.stringify(header);
  return { ok: true, text, bytes: Buffer.byteLength(text, 'utf8'), headroom };
}

/* ------------------------------------------------------- region presence -- */

/**
 * Find OUR split region inside an opened archive's `lib/main.js`.
 *
 * Used three ways: by `planSplit` (refuse when it is already there), by the
 * shrink path (measure the exact range to remove), and by state detection (a
 * grown archive still classifies as `stock` from the official slot, so this
 * marker is the second signal that an install exists).
 *
 * @param {import('./reader.js').OpenAsarOk} asar
 * @returns {{ ok: true, startInMain: number, endInMain: number, absoluteOffset: number, length: number, sha256: string, bytes: Buffer, mainBytes: Buffer, mainEntry: object } | { ok: false, code: string, message: string }}
 */
export function findSplitRegion(asar) {
  if (asar === null || typeof asar !== 'object' || asar.ok !== true) {
    return fail(ERROR_CODES.EREGION_UNKNOWN, 'asar 没有打开，无法查找 split 区域');
  }
  const entry = entryInfo(asar, MAIN_RELATIVE_PATH);
  if (entry === null) return fail(ERROR_CODES.EASAR_MAIN_MISSING, `asar 里没有 ${MAIN_RELATIVE_PATH}`);
  if (entry.unpacked) return fail(ERROR_CODES.EASAR_MAIN_MISSING, `${MAIN_RELATIVE_PATH} 是 unpacked 条目，不在 asar 数据区里`);
  const mainBytes = readEntry(asar, MAIN_RELATIVE_PATH);
  if (mainBytes === null) return fail(ERROR_CODES.EASAR_MAIN_MISSING, `读不到 ${MAIN_RELATIVE_PATH} 的内容`);

  const startNeedle = Buffer.from(SPLIT_START_MARKER, 'utf8');
  const markerAt = mainBytes.indexOf(startNeedle);
  if (markerAt < 0) {
    return fail(ERROR_CODES.EREGION_NOT_FOUND, `lib/main.js 里没有 split 区域起点标记 ${SPLIT_START_MARKER}`);
  }
  // The builder MAY open the region with a newline (the official slot ends with
  // `//#endregion` and no trailing newline). Include it when present, so `length`
  // is exactly the length `buildSplitRegion` produced.
  const startInMain = markerAt > 0 && mainBytes[markerAt - 1] === 0x0a ? markerAt - 1 : markerAt;
  const endNeedle = Buffer.from(REGION_END_MARKER, 'utf8');
  const endAt = mainBytes.indexOf(endNeedle, markerAt + startNeedle.length);
  if (endAt < 0) {
    return fail(ERROR_CODES.EREGION_NOT_FOUND, 'split 区域缺少收尾的 //#endregion');
  }
  const endInMain = endAt + endNeedle.length;
  const bytes = Buffer.from(mainBytes.subarray(startInMain, endInMain));
  return {
    ok: true,
    startInMain,
    endInMain,
    absoluteOffset: asar.dataStart + entry.offset + startInMain,
    length: bytes.length,
    sha256: sha256Buffer(bytes),
    bytes,
    mainBytes,
    mainEntry: entry,
  };
}

/* ------------------------------------------------------------------ plan -- */

/**
 * Derive a grow plan from an open archive. Read-only.
 *
 * Check order is deliberate: "is our region already there" comes before every
 * numeric guard, because a grown archive has a stale `lib/main.js` digest, a
 * moved tail and a larger `size`; reporting it as "weird layout" would bury the
 * one fact the caller needs ("this is already installed").
 *
 * @param {import('./reader.js').OpenAsarOk} asar
 * @param {number} regionLength bytes our region should occupy
 * @param {{ verifyBoundary?: boolean, integrityVerified?: boolean }} [options]
 * @returns {{ ok: true, plan: object, internals: object } | { ok: false, code: string, message: string }}
 */
function deriveSplitPlan(asar, regionLength, options = {}) {
  const verifyBoundary = options.verifyBoundary !== false;

  const slot = locateRegion(asar);
  if (slot.ok !== true) {
    return fail(slot.code ?? ERROR_CODES.EREGION_UNKNOWN, slot.message ?? '无法定位官方托盘槽位');
  }
  // A 0.1.x install put OUR OLD marker inside the official slot. Stacking a
  // second region next to it would leave the "official slot is pristine" premise
  // false, so it is refused with a named layout instead of failing later as a
  // weird checksum error.
  if (slot.stockBytes.toString('utf8').includes(PATCH_MARKER)) {
    return fail(
      ERROR_CODES.EREGION_PRESENT,
      '托盘槽位里已经是 0.1.x 的补丁（槽位不再原样），split 布局要求官方槽位逐字节保持原样；请先还原成官方版本',
      { layout: 'in-slot', regionAlreadyPresent: false, slotStartInMain: slot.startInMain, slotLength: slot.length },
    );
  }

  const existing = findSplitRegion(asar);
  if (existing.ok === true) {
    const resizing = Number.isInteger(regionLength) && regionLength !== existing.length;
    return fail(
      ERROR_CODES.EREGION_PRESENT,
      `${PRESENT_REASON}${resizing ? `（已存在 ${existing.length} 字节，请求的是 ${regionLength} 字节，改大小就要移动尾部）` : ''}`,
      {
        layout: 'split',
        regionAlreadyPresent: true,
        existingRegion: {
          startInMain: existing.startInMain,
          endInMain: existing.endInMain,
          absoluteOffset: existing.absoluteOffset,
          length: existing.length,
          sha256: existing.sha256,
        },
        insertAtInFile: existing.startInMain,
        insertAtAbsolute: existing.absoluteOffset,
        requestRegionLength: regionLength,
        resizeDelta: resizing ? regionLength - existing.length : 0,
        movedEntries: [],
        movingBytes: 0,
        zeroMovement: !resizing,
      },
    );
  }

  const mainEntry = entryInfo(asar, MAIN_RELATIVE_PATH);
  if (mainEntry === null) return fail(ERROR_CODES.EASAR_MAIN_MISSING, `asar 里没有 ${MAIN_RELATIVE_PATH}`);
  if (mainEntry.unpacked) {
    return fail(ERROR_CODES.EASAR_MAIN_MISSING, `${MAIN_RELATIVE_PATH} 是 unpacked 条目，不在 asar 数据区里`);
  }

  if (!Number.isInteger(regionLength) || regionLength <= 0) {
    return fail(ERROR_CODES.EREGION_LENGTH, `预留的 split 区域长度必须是正整数，收到 ${regionLength}`);
  }
  if (regionLength < SPLIT_MINIMUM_REGION_LENGTH) {
    return fail(
      ERROR_CODES.EREGION_LENGTH,
      `split 区域至少要 ${SPLIT_MINIMUM_REGION_LENGTH} 字节（起止标记 + 补丁体），收到 ${regionLength}`,
      { minimum: SPLIT_MINIMUM_REGION_LENGTH, requested: regionLength },
    );
  }

  const layout = measureLayout(asar, mainEntry);
  if (layout.ok !== true) return layout;

  const header = readHeader(asar);
  if (header.ok !== true) return header;
  // The header must re-serialise byte-identically. Not an aesthetic requirement:
  // it is what lets the reverse path reproduce the stock header TEXT (and
  // therefore the stock archive). A header that does not round-trip could be
  // grown but not restored exactly, so it is refused NOW rather than discovered
  // at uninstall time.
  if (!header.padded) {
    return fail(
      ERROR_CODES.EUNKNOWN_LAYOUT,
      'asar 目录头重新序列化后与原始字节不一致（格式非规范），无法保证退装时逐字节还原，拒绝写入',
      { headerBytes: asar.headerSize, roundTripBytes: Buffer.byteLength(header.canonical, 'utf8') },
    );
  }

  const mainBytes = readEntry(asar, MAIN_RELATIVE_PATH);
  if (mainBytes === null) return fail(ERROR_CODES.EASAR_MAIN_MISSING, `读不到 ${MAIN_RELATIVE_PATH} 的内容`);
  if (mainBytes.length !== Number(mainEntry.size)) {
    return fail(
      ERROR_CODES.EASAR_HEADER,
      `目录里的 lib/main.js 是 ${mainEntry.size} 字节，实际读到 ${mainBytes.length} 字节，拒绝写入`,
    );
  }

  const insertAtInFile = slot.endInMain;
  if (insertAtInFile !== slot.startInMain + slot.length || insertAtInFile > mainBytes.length) {
    return fail(ERROR_CODES.EUNKNOWN_LAYOUT, `插入点 ${insertAtInFile} 不是官方托盘槽位的结尾，拒绝写入`);
  }
  const mainAbsolute = asar.dataStart + Number(mainEntry.offset);
  const insertAtAbsolute = mainAbsolute + insertAtInFile;
  const mainTail = Buffer.from(mainBytes.subarray(insertAtInFile));

  const shifted = materializeHeader(
    header.canonical,
    regionLength,
    layout.trailing.map((entry) => ({ path: entry.path, delta: regionLength })),
  );
  if (shifted.ok !== true) return shifted;
  const headerStaysSameLength = shifted.bytes === asar.headerSize;
  if (!headerStaysSameLength) {
    return fail(
      ERROR_CODES.EREGION_LENGTH,
      `预留 ${regionLength} 字节会让目录头从 ${asar.headerSize} 变成 ${shifted.bytes} 字节（某个字段多了一位数字）；`
      + '那会迫使删掉 integrity.blocks 来填平长度，退装就无法逐字节还原官方档。'
      + `本档实测最多可预留 ${shifted.headroom} 字节（改用更小的预留，或等本包登记这个 shell 的实测值 ${REGION_RESERVE_LIMIT}）`,
      {
        headerBytesBefore: asar.headerSize,
        headerBytesAfter: shifted.bytes,
        reserveLimit: shifted.headroom,
        requestedReserve: regionLength,
        headerStaysSameLength: false,
      },
    );
  }

  // Prove the reported boundary instead of trusting the arithmetic: serialise at
  // the limit (must still fit) and one byte past it (must not). Two passes over a
  // 5.6 MB header (~30 ms) turn "848505 + 151494 < 1000000" into a measurement of
  // THIS archive.
  let boundaryProven = null;
  if (verifyBoundary && Number.isFinite(shifted.headroom) && shifted.headroom > 0) {
    const atLimit = materializeHeader(
      header.canonical,
      shifted.headroom,
      layout.trailing.map((entry) => ({ path: entry.path, delta: shifted.headroom })),
    );
    const overLimit = materializeHeader(
      header.canonical,
      shifted.headroom + 1,
      layout.trailing.map((entry) => ({ path: entry.path, delta: shifted.headroom + 1 })),
    );
    boundaryProven = {
      limit: shifted.headroom,
      fitsAtLimit: atLimit.ok === true && atLimit.bytes === asar.headerSize,
      bytesAtLimit: atLimit.ok === true ? atLimit.bytes : null,
      overflowsOverLimit: overLimit.ok !== true || overLimit.bytes > asar.headerSize,
      bytesOverLimit: overLimit.ok === true ? overLimit.bytes : null,
    };
  }

  const movingEntryBytes = layout.trailing.reduce((sum, entry) => sum + entry.size, 0);
  const movingBytes = movingEntryBytes + mainTail.length;

  const plan = {
    ok: true,
    layout: 'split',
    reserve: regionLength,
    regionLength,
    /** Measured on this archive: the largest reserve that keeps the header length. */
    reserveLimit: shifted.headroom,
    /** The value this package shipped with, for comparison on a new shell. */
    reserveLimitKnown: REGION_RESERVE_LIMIT,
    reserveLimitProven: boundaryProven,
    regionAlreadyPresent: false,
    insertAtInFile,
    insertAtAbsolute,
    slot: {
      startInMain: slot.startInMain,
      endInMain: slot.endInMain,
      length: slot.length,
      sha256: slot.sha256,
      lengthIsFamiliar: slot.lengthIsFamiliar === true,
    },
    slotShaBefore: slot.sha256,
    movedEntries: layout.trailing.map((entry) => ({
      path: entry.path,
      oldOffset: entry.offset,
      newOffset: entry.offset + regionLength,
      size: entry.size,
    })),
    movedEntryCount: layout.trailing.length,
    movingEntryBytes,
    mainTailBytes: mainTail.length,
    mainTailSha: sha256Buffer(mainTail),
    movingBytes,
    mainOffset: Number(mainEntry.offset),
    mainAbsolute,
    mainSizeBefore: Number(mainEntry.size),
    mainSizeAfter: Number(mainEntry.size) + regionLength,
    dataStart: asar.dataStart,
    headerBytesBefore: asar.headerSize,
    headerBytesAfter: shifted.bytes,
    headerStaysSameLength,
    headerRoundTrips: true,
    archiveSizeBefore: asar.fileSize,
    archiveSizeAfter: asar.fileSize + regionLength,
    integrityVerified: options.integrityVerified === true,
    minimumRegionLength: SPLIT_MINIMUM_REGION_LENGTH,
  };

  return {
    ok: true,
    plan,
    internals: {
      slot,
      mainBytes,
      mainTail,
      headerText: header.canonical,
      trailing: layout.trailing,
    },
  };
}

/**
 * Read-only: what would inserting `regionLength` bytes after the official tray
 * slot cost, and is it allowed at all?
 *
 * @param {import('./reader.js').OpenAsarOk} opened result of {@link openAsar}
 * @param {number} [regionLength] defaults to {@link REGION_RESERVE_BYTES}
 * @param {{ verifyBoundary?: boolean, integrityVerified?: boolean }} [options]
 *   `verifyBoundary: false` skips two extra header serialisations when the
 *   caller is on a polling path and only needs the go/no-go answer.
 * @returns {{
 *   ok: true, insertAtInFile: number, insertAtAbsolute: number, reserve: number,
 *   regionLength: number, movedEntries: Array<{path: string, oldOffset: number, newOffset: number, size: number}>,
 *   mainSizeBefore: number, mainSizeAfter: number, mainOffset: number, dataStart: number,
 *   headerBytesBefore: number, movingBytes: number, headerStaysSameLength: boolean,
 *   [key: string]: unknown,
 * } | { ok: false, code: string, message: string }}
 */
export function planSplit(opened, regionLength = REGION_RESERVE_BYTES, options = {}) {
  if (opened === null || typeof opened !== 'object' || opened.ok !== true) {
    return fail(ERROR_CODES.EINVALID_INPUT, 'asar 没有成功打开，无法推导 split 写入计划');
  }
  const derived = deriveSplitPlan(opened, regionLength, {
    ...options,
    integrityVerified: options.integrityVerified ?? opened.integrityVerified === true,
  });
  if (derived.ok !== true) return derived;
  return derived.plan;
}

/**
 * {@link planSplit} for a path: opens the archive, derives the plan, closes it.
 *
 * @param {string} asarPath
 * @param {number} [regionLength] defaults to {@link REGION_RESERVE_BYTES}
 * @param {{ verifyBoundary?: boolean }} [options]
 * @returns {{ ok: true, [key: string]: unknown } | { ok: false, code: string, message: string }}
 */
export function planSplitFile(asarPath, regionLength = REGION_RESERVE_BYTES, options = {}) {
  const opened = openArchive(asarPath);
  if (opened.ok !== true) return opened;
  try {
    return planSplit(opened.asar, regionLength, { ...options, integrityVerified: opened.integrityVerified });
  } finally {
    closeAsar(opened.asar);
  }
}

/**
 * Compare a caller-supplied plan with a freshly derived one.
 *
 * `growRegion`/`shrinkRegion` do this before writing: a plan made against a
 * different archive state is refused rather than "corrected", because a wrong
 * delta corrupts every offset after `lib/main.js`.
 *
 * @param {object} plan caller's plan
 * @param {object} fresh freshly derived plan
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function comparePlans(plan, fresh) {
  const fields = [
    'regionLength', 'insertAtInFile', 'insertAtAbsolute', 'mainOffset', 'dataStart',
    'mainSizeBefore', 'headerBytesBefore', 'archiveSizeBefore', 'mainTailSha',
  ];
  for (const field of fields) {
    const planned = plan[field];
    const measured = fresh[field];
    const equal = typeof planned === 'number' || typeof measured === 'number'
      ? Number(planned) === Number(measured)
      : planned === measured;
    if (!equal) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `计划与文件当前状态不一致（${field}: 计划 ${JSON.stringify(planned)}，实测 ${JSON.stringify(measured)}），拒绝写入`,
        { field, planned, measured },
      );
    }
  }
  const plannedEntries = Array.isArray(plan.movedEntries) ? plan.movedEntries : [];
  if (plannedEntries.length !== fresh.movedEntries.length) {
    return fail(
      ERROR_CODES.EWRITE_VERIFY,
      `计划与文件当前状态不一致（要搬移的条目数：计划 ${plannedEntries.length}，实测 ${fresh.movedEntries.length}），拒绝写入`,
    );
  }
  for (let index = 0; index < fresh.movedEntries.length; index += 1) {
    const left = plannedEntries[index];
    const right = fresh.movedEntries[index];
    if (left === null || typeof left !== 'object'
      || left.path !== right.path
      || Number(left.oldOffset) !== right.oldOffset
      || Number(left.size) !== right.size) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `计划与文件当前状态不一致（第 ${index + 1} 个条目：计划 ${JSON.stringify(left ?? null)}，实测 ${JSON.stringify(right)}），拒绝写入`,
        { index, planned: left ?? null, measured: right },
      );
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ grow -- */

/**
 * Perform the insertion: append N bytes at EOF, move the trailing entries
 * upwards by N, write the grown `lib/main.js`, rewrite the directory.
 *
 * Order, and why:
 *   1. everything refusable (region length, plan mismatch, header length, archive
 *      size) is decided BEFORE the first write;
 *   2. read the bytes that will move THROUGH THE SAME WRITABLE DESCRIPTOR, so the
 *      comparison is against exactly what is on disk at write time;
 *   3. append N bytes at EOF (harmless on its own);
 *   4. move the tail end-first (each write lands above its own source, so no
 *      un-read byte is ever clobbered);
 *   5. write the grown `lib/main.js` (this step consumes the first N bytes of the
 *      old tail, already duplicated by step 4);
 *   6. write the directory LAST, which is the moment the new layout becomes
 *      valid.
 *
 * @param {string} asarPath archive to grow
 * @param {object} plan result of {@link planSplit}
 * @param {Buffer} regionBytes bytes for the inserted region, e.g. buildSplitRegion(8192)
 * @returns {Promise<{ ok: true, archiveShaAfter: string, archiveSizeBefore: number, archiveSizeAfter: number, updatedEntries: number, mainSizeAfter: number, headerBytesAfter: number, regionSha: string, officialSlotSha: string, insertAtInFile: number, movedEntries: number } | { ok: false, code: string, message: string }>}
 */
export async function growRegion(asarPath, plan, regionBytes) {
  if (typeof asarPath !== 'string' || asarPath.length === 0) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有给出 asar 路径');
  }
  if (plan === null || typeof plan !== 'object' || plan.ok !== true) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有可执行的方案：planSplit 必须先返回 ok:true');
  }
  if (!Buffer.isBuffer(regionBytes)) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有给出区域字节（需要 Buffer，例如 buildSplitRegion(8192)）');
  }
  if (plan.regionAlreadyPresent === true) {
    return fail(
      ERROR_CODES.EREGION_PRESENT,
      `${PRESENT_REASON}（零搬移安装不走这里）`,
      { zeroMovement: plan.zeroMovement === true, existingRegion: plan.existingRegion ?? null },
    );
  }
  if (regionBytes.length !== Number(plan.regionLength)) {
    return fail(
      ERROR_CODES.EREGION_LENGTH,
      `区域字节 ${regionBytes.length} 字节与计划预留的 ${plan.regionLength} 字节不一致，拒绝写入`,
      { bytes: regionBytes.length, planned: plan.regionLength },
    );
  }
  if (regionBytes.length < SPLIT_MINIMUM_REGION_LENGTH) {
    return fail(ERROR_CODES.EREGION_LENGTH, `split 区域至少要 ${SPLIT_MINIMUM_REGION_LENGTH} 字节，收到 ${regionBytes.length}`);
  }

  // 1. Re-derive from the file; a plan that disagrees is refused.
  const opened = openArchive(asarPath);
  if (opened.ok !== true) return opened;
  let fresh;
  try {
    fresh = deriveSplitPlan(opened.asar, Number(plan.regionLength), {
      // The numeric boundary was already decided when the plan was made; two
      // extra serialisations buy nothing here.
      verifyBoundary: false,
      integrityVerified: opened.integrityVerified,
    });
  } finally {
    closeAsar(opened.asar);
  }
  if (fresh.ok !== true) {
    return fail(fresh.code ?? ERROR_CODES.EUNKNOWN_LAYOUT, `无法从文件重新推导写入计划：${fresh.message}`, { derived: fresh });
  }
  const compared = comparePlans(plan, fresh.plan);
  if (compared.ok !== true) return compared;

  const derived = fresh.plan;
  const region = regionBytes.length;
  const regionSha = sha256Buffer(regionBytes);

  // 2. The directory text, and its LENGTH, before any write: a difference here
  //    is the one thing that would make the archive non-restorable.
  const shifted = materializeHeader(
    fresh.internals.headerText,
    region,
    fresh.internals.trailing.map((entry) => ({ path: entry.path, delta: region })),
  );
  if (shifted.ok !== true) return shifted;
  if (shifted.bytes !== derived.headerBytesBefore) {
    return fail(
      ERROR_CODES.EWRITE_VERIFY,
      `目录头长度会从 ${derived.headerBytesBefore} 变成 ${shifted.bytes} 字节，拒绝写入（退装将无法逐字节还原）`,
      { headerBytesBefore: derived.headerBytesBefore, headerBytesAfter: shifted.bytes },
    );
  }

  const archiveSizeBefore = statSync(asarPath).size;
  if (archiveSizeBefore !== derived.archiveSizeBefore) {
    return fail(
      ERROR_CODES.EWRITE_VERIFY,
      `asar 大小在计划之后变了：计划 ${derived.archiveSizeBefore}，现在 ${archiveSizeBefore}，拒绝写入`,
    );
  }

  /** @type {Array<{ path: string, offset: number, size: number, bytes: Buffer }>} */
  let movedBytes = [];
  let mainBefore = Buffer.alloc(0);
  let fd;
  try {
    fd = openSync(asarPath, 'r+');
  } catch (error) {
    return fail(
      ERROR_CODES.EWRITE_FAILED,
      `以读写方式打开 asar 失败（DSH 可能正锁着它）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    mainBefore = readAt(fd, derived.mainAbsolute, derived.mainSizeBefore);
    movedBytes = fresh.internals.trailing.map((entry) => ({
      ...entry,
      bytes: readAt(fd, derived.dataStart + entry.offset, entry.size),
    }));

    writeAt(fd, archiveSizeBefore, Buffer.alloc(region));
    for (const entry of [...movedBytes].reverse()) {
      writeAt(fd, derived.dataStart + entry.offset + region, entry.bytes);
    }

    const grownMain = Buffer.concat([
      mainBefore.subarray(0, derived.insertAtInFile),
      regionBytes,
      mainBefore.subarray(derived.insertAtInFile),
    ]);
    if (grownMain.length !== derived.mainSizeAfter) {
      throw new Error(`grown lib/main.js is ${grownMain.length} bytes, planned ${derived.mainSizeAfter}`);
    }
    writeAt(fd, derived.mainAbsolute, grownMain);

    writeAt(fd, PICKLE_PREAMBLE_BYTES, Buffer.concat([
      Buffer.from(shifted.text, 'utf8'),
      Buffer.alloc(derived.headerBytesBefore - shifted.bytes, 0x20),
    ]));
    try {
      fsyncSync(fd);
    } catch {
      // Durability nicety only; the read-back below is the real gate.
    }
  } catch (error) {
    return fail(
      ERROR_CODES.EWRITE_FAILED,
      `写入 split 区域失败：${error instanceof Error ? error.message : String(error)}（需要从基线备份恢复）`,
    );
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }

  // 3. Read back through the framework reader and compare BYTES.
  const verified = verifySplit(asarPath, derived, regionSha, { expectedEntries: movedBytes });
  if (verified.ok !== true) return verified;

  const grownSize = statSync(asarPath).size;
  if (grownSize !== archiveSizeBefore + region) {
    return fail(
      ERROR_CODES.EWRITE_VERIFY,
      `写入后 asar 是 ${grownSize} 字节，期望 ${archiveSizeBefore + region}`,
    );
  }

  const archiveShaAfter = await sha256File(asarPath);
  return {
    ok: true,
    archiveShaAfter,
    archiveSizeBefore,
    archiveSizeAfter: archiveSizeBefore + region,
    updatedEntries: fresh.internals.trailing.length + 1,
    movedEntries: fresh.internals.trailing.length,
    mainSizeAfter: derived.mainSizeAfter,
    headerBytesAfter: derived.headerBytesBefore,
    regionSha,
    officialSlotSha: derived.slot.sha256,
    insertAtInFile: derived.insertAtInFile,
    regionLength: region,
  };
}

/* ---------------------------------------------------------------- shrink -- */

/**
 * Working shape of the shrink path: what this archive looks like right now,
 * measured from the FILE and never from a plan's stored numbers.
 *
 * @param {import('./reader.js').OpenAsarOk} asar
 * @param {{ offset: number, size: number }} mainEntry
 * @returns {{ ok: true, region: object, mainBytes: Buffer, headerText: string, trailing: Array<object>, dataStart: number, mainAbsolute: number, mainSizeNow: number, archiveSizeNow: number } | { ok: false, code: string, message: string }}
 */
function deriveShrinkPlan(asar, mainEntry) {
  const region = findSplitRegion(asar);
  if (region.ok !== true) {
    return fail(ERROR_CODES.EREGION_NOT_FOUND, `这个 asar 里没有 split 区域，无法退回：${region.message}`);
  }
  const layout = measureLayout(asar, mainEntry);
  if (layout.ok !== true) return layout;
  const header = readHeader(asar);
  if (header.ok !== true) return header;
  if (!header.padded) {
    return fail(
      ERROR_CODES.EUNKNOWN_LAYOUT,
      'asar 目录头重新序列化后与原始字节不一致（格式非规范），无法保证退装时逐字节还原，拒绝写入',
    );
  }

  const mainBytes = readEntry(asar, MAIN_RELATIVE_PATH);
  if (mainBytes === null) return fail(ERROR_CODES.EASAR_MAIN_MISSING, `读不到 ${MAIN_RELATIVE_PATH} 的内容`);
  const mainSizeNow = Number(mainEntry.size);
  if (mainSizeNow !== mainBytes.length) {
    return fail(
      ERROR_CODES.EASAR_HEADER,
      `目录里的 lib/main.js 是 ${mainSizeNow} 字节，实际读到 ${mainBytes.length} 字节，拒绝写入`,
    );
  }
  if (region.endInMain > mainBytes.length || region.startInMain < 0) {
    return fail(ERROR_CODES.EUNKNOWN_LAYOUT, `split 区域 ${region.startInMain}..${region.endInMain} 越过了 lib/main.js 末尾`);
  }

  return {
    ok: true,
    region,
    mainBytes,
    headerText: header.canonical,
    trailing: layout.trailing,
    dataStart: asar.dataStart,
    mainAbsolute: asar.dataStart + Number(mainEntry.offset),
    mainSizeNow,
    archiveSizeNow: asar.fileSize,
  };
}

/**
 * Undo the insertion: move the tail back, restore `lib/main.js`, rewrite the
 * directory, truncate.
 *
 * The inputs are the region bytes and the stock geometry only — never a backup
 * of the archive. Where the pre-grow size comes from: the tail was contiguous to
 * EOF before the grow and every entry moved by exactly `region.length`, so the
 * original size is `current - region.length`, re-derived here from the file.
 *
 * @param {string} asarPath grown archive
 * @param {object|null} [plan] the plan that produced it; used to cross-check the
 *   measured geometry, never as the source of the numbers
 * @returns {Promise<{ ok: true, archiveShaAfter: string, archiveSizeBefore: number, archiveSizeAfter: number, updatedEntries: number, mainSizeAfter: number, removedRegionBytes: number, regionSha: string } | { ok: false, code: string, message: string }>}
 */
export async function shrinkRegion(asarPath, plan = null) {
  if (typeof asarPath !== 'string' || asarPath.length === 0) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有给出 asar 路径');
  }

  const opened = openArchive(asarPath);
  if (opened.ok !== true) return opened;
  let shrink;
  try {
    const mainEntry = entryInfo(opened.asar, MAIN_RELATIVE_PATH);
    if (mainEntry === null) return fail(ERROR_CODES.EASAR_MAIN_MISSING, `asar 里没有 ${MAIN_RELATIVE_PATH}`);
    shrink = deriveShrinkPlan(opened.asar, mainEntry);
  } finally {
    closeAsar(opened.asar);
  }
  if (shrink.ok !== true) return shrink;

  const region = shrink.region;
  const regionBytes = region.length;
  if (plan !== null && typeof plan === 'object') {
    const expectedLength = Number(plan.regionLength);
    const expectedInsert = Number(plan.insertAtInFile);
    if (Number.isInteger(expectedLength) && expectedLength !== regionBytes) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `计划说区域是 ${expectedLength} 字节，文件里实测 ${regionBytes} 字节，拒绝写入`,
        { planned: expectedLength, measured: regionBytes },
      );
    }
    if (Number.isInteger(expectedInsert) && expectedInsert !== shrink.region.startInMain) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `计划说区域起点在 in-file ${expectedInsert}，文件里实测 ${shrink.region.startInMain}，拒绝写入`,
        { planned: expectedInsert, measured: shrink.region.startInMain },
      );
    }
  }

  // Everything refusable is decided before the first write.
  const shifted = materializeHeader(
    shrink.headerText,
    -regionBytes,
    shrink.trailing.map((entry) => ({ path: entry.path, delta: -regionBytes })),
  );
  if (shifted.ok !== true) return shifted;
  const restoredMain = Buffer.concat([
    shrink.mainBytes.subarray(0, region.startInMain),
    shrink.mainBytes.subarray(region.endInMain),
  ]);
  if (restoredMain.length + regionBytes !== shrink.mainSizeNow) {
    return fail(
      ERROR_CODES.EWRITE_VERIFY,
      `还原后的 lib/main.js 长度不对：${restoredMain.length} + ${regionBytes} != ${shrink.mainSizeNow}`,
    );
  }
  const archiveSizeBefore = statSync(asarPath).size;
  if (archiveSizeBefore !== shrink.archiveSizeNow) {
    return fail(
      ERROR_CODES.EWRITE_VERIFY,
      `asar 大小在计划之后变了：计划 ${shrink.archiveSizeNow}，现在 ${archiveSizeBefore}，拒绝写入`,
    );
  }
  const archiveSizeAfter = archiveSizeBefore - regionBytes;
  // The grown header was written at exactly its ORIGINAL length (that is the
  // invariant the whole layout rests on), so the restored text must serialise to
  // that same length again. Anything else means the header would need padding,
  // and padding is precisely what would stop the archive from being stock again.
  const headerBytes = opened.asar.headerSize;
  if (shifted.bytes !== headerBytes) {
    return fail(
      ERROR_CODES.EWRITE_VERIFY,
      `还原后的目录头是 ${shifted.bytes} 字节，但原档目录头是 ${headerBytes} 字节，退装无法逐字节还原，拒绝写入`,
      { headerBytesExpected: headerBytes, headerBytesRestored: shifted.bytes },
    );
  }

  let fd;
  try {
    fd = openSync(asarPath, 'r+');
  } catch (error) {
    return fail(
      ERROR_CODES.EWRITE_FAILED,
      `以读写方式打开 asar 失败（DSH 可能正锁着它）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    // Read every moved entry BEFORE writing anything, so the move-back is order
    // independent and can never read a byte it already overwrote.
    const movedBytes = shrink.trailing.map((entry) => ({
      ...entry,
      bytes: readAt(fd, shrink.dataStart + entry.offset, entry.size),
    }));
    const mainNow = readAt(fd, shrink.mainAbsolute, shrink.mainSizeNow);
    const restored = Buffer.concat([
      mainNow.subarray(0, region.startInMain),
      mainNow.subarray(region.endInMain),
    ]);
    if (restored.length !== restoredMain.length) throw new Error('restored lib/main.js length mismatch');

    for (const entry of movedBytes) {
      writeAt(fd, shrink.dataStart + entry.offset - regionBytes, entry.bytes);
    }
    writeAt(fd, shrink.mainAbsolute, restored);
    writeAt(fd, PICKLE_PREAMBLE_BYTES, Buffer.from(shifted.text, 'utf8'));
    try {
      fsyncSync(fd);
    } catch {
      // see the grow path.
    }
  } catch (error) {
    return fail(
      ERROR_CODES.EWRITE_FAILED,
      `撤回 split 区域失败：${error instanceof Error ? error.message : String(error)}（需要从基线备份恢复）`,
    );
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }

  try {
    await fsPromises.truncate(asarPath, archiveSizeAfter);
  } catch (error) {
    return fail(
      ERROR_CODES.EWRITE_FAILED,
      `截断 asar 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const verified = verifyShrunk(asarPath, {
    archiveSizeAfter,
    mainSizeAfter: restoredMain.length,
    mainSha: sha256Buffer(restoredMain),
    entryCount: shrink.trailing.length,
    headerBytes,
  });
  if (verified.ok !== true) return verified;

  const archiveShaAfter = await sha256File(asarPath);
  return {
    ok: true,
    archiveShaAfter,
    archiveSizeBefore,
    archiveSizeAfter,
    updatedEntries: shrink.trailing.length + 1,
    mainSizeAfter: restoredMain.length,
    removedRegionBytes: regionBytes,
    regionSha: region.sha256,
  };
}

/**
 * Post-shrink read-back: the archive must be the pre-grow shape again.
 *
 * @param {string} asarPath
 * @param {{ archiveSizeAfter: number, mainSizeAfter: number, mainSha: string, entryCount: number, headerBytes: number }} expected
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function verifyShrunk(asarPath, expected) {
  let size;
  try {
    size = statSync(asarPath).size;
  } catch (error) {
    return fail(ERROR_CODES.EWRITE_VERIFY, `回读失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (size !== expected.archiveSizeAfter) {
    return fail(ERROR_CODES.EWRITE_VERIFY, `截断后 asar 是 ${size} 字节，期望 ${expected.archiveSizeAfter}`);
  }
  // STRICT first: on a correctly restored stock archive the recorded digest
  // matches again, which also re-proves the computed data start.
  const strict = openAsar(asarPath);
  const opened = strict.ok === true ? strict : openAsar(asarPath, { allowStaleMainIntegrity: true });
  if (opened.ok !== true) {
    return fail(ERROR_CODES.EWRITE_VERIFY, `还原后的 asar 打不开：${opened.message}`);
  }
  try {
    if (opened.headerSize !== expected.headerBytes) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `还原后目录头是 ${opened.headerSize} 字节，期望 ${expected.headerBytes}`,
      );
    }
    const present = findSplitRegion(opened);
    if (present.ok === true) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `还原后仍能找到 split 区域（${present.length} 字节），撤回不完整`);
    }
    const entry = entryInfo(opened, MAIN_RELATIVE_PATH);
    if (entry === null) return fail(ERROR_CODES.EWRITE_VERIFY, '还原后 asar 里没有 lib/main.js');
    if (Number(entry.size) !== expected.mainSizeAfter) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `还原后 lib/main.js 是 ${entry.size} 字节，期望 ${expected.mainSizeAfter}`);
    }
    const mainBytes = readEntry(opened, MAIN_RELATIVE_PATH);
    if (mainBytes === null || sha256Buffer(mainBytes) !== expected.mainSha) {
      return fail(ERROR_CODES.EWRITE_VERIFY, '还原后 lib/main.js 的内容与撤回前的副本不一致');
    }
    const layout = measureLayout(opened, entry);
    if (layout.ok !== true) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `还原后的布局不可信：${layout.message}`);
    }
    if (layout.trailing.length !== expected.entryCount) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `还原后要搬回的条目数是 ${layout.trailing.length}，期望 ${expected.entryCount}`,
      );
    }
    return { ok: true };
  } finally {
    closeAsar(opened);
  }
}

/* ---------------------------------------------------------------- verify -- */

/**
 * Re-read a grown archive and assert the layout it claims.
 *
 * Checks, in order: archive size; header length and data start; `lib/main.js`
 * size and offset; our region exactly at the planned insertion point with the
 * expected digest and both markers; exactly ONE such region; the official slot
 * still at its original position with its original digest; the `lib/main.js`
 * tail after the region unchanged; and every moved entry readable — byte-
 * identical too, when the caller passes the bytes it wrote.
 *
 * @param {string} asarPath
 * @param {object} plan result of {@link planSplit}
 * @param {string|null} [expectedRegionSha] digest the region must have; null skips it
 * @param {{ expectedEntries?: Array<{ path: string, bytes: Buffer|Uint8Array }> }} [options]
 * @returns {{ ok: true, archiveSize: number, mainSize: number, regionSha: string, regionStartInMain: number, regionLength: number, officialSlotSha: string, officialSlotStartInMain: number, mainTailSha: string, movedEntries: number, updatedEntries: number, headerBytes: number, dataStart: number, integrityVerified: boolean } | { ok: false, code: string, message: string }}
 */
export function verifySplit(asarPath, plan, expectedRegionSha = null, options = {}) {
  if (typeof asarPath !== 'string' || asarPath.length === 0) {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有给出 asar 路径');
  }
  if (plan === null || typeof plan !== 'object') {
    return fail(ERROR_CODES.EINVALID_INPUT, '没有方案可以作为校验依据');
  }

  let size;
  try {
    size = statSync(asarPath).size;
  } catch (error) {
    return fail(ERROR_CODES.EWRITE_VERIFY, `校验时读不到 asar：${error instanceof Error ? error.message : String(error)}`);
  }
  if (Number.isInteger(plan.archiveSizeAfter) && size !== plan.archiveSizeAfter) {
    return fail(
      ERROR_CODES.EWRITE_VERIFY,
      `asar 大小是 ${size} 字节，期望 ${plan.archiveSizeAfter}`,
      { expected: plan.archiveSizeAfter, actual: size },
    );
  }

  const opened = openArchive(asarPath);
  if (opened.ok !== true) {
    return fail(ERROR_CODES.EWRITE_VERIFY, `校验时 asar 打不开：${opened.message}`);
  }
  try {
    const asar = opened.asar;
    if (Number.isInteger(plan.headerBytesBefore) && asar.headerSize !== plan.headerBytesBefore) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `目录头长度是 ${asar.headerSize} 字节，期望 ${plan.headerBytesBefore}`);
    }
    if (Number.isInteger(plan.dataStart) && asar.dataStart !== plan.dataStart) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `dataStart 是 ${asar.dataStart}，期望 ${plan.dataStart}`);
    }
    const entry = entryInfo(asar, MAIN_RELATIVE_PATH);
    if (entry === null) return fail(ERROR_CODES.EWRITE_VERIFY, '校验时 asar 里没有 lib/main.js');
    if (Number.isInteger(plan.mainSizeAfter) && Number(entry.size) !== plan.mainSizeAfter) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `lib/main.js 是 ${entry.size} 字节，期望 ${plan.mainSizeAfter}`);
    }
    if (Number.isInteger(plan.mainOffset) && Number(entry.offset) !== plan.mainOffset) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `lib/main.js 的 offset 是 ${entry.offset}，期望 ${plan.mainOffset}`);
    }
    const mainBytes = readEntry(asar, MAIN_RELATIVE_PATH);
    if (mainBytes === null) return fail(ERROR_CODES.EWRITE_VERIFY, '校验时读不到 lib/main.js');

    const regionLength = Number(plan.regionLength);
    const insertAtInFile = Number(plan.insertAtInFile);
    if (!Number.isInteger(regionLength) || !Number.isInteger(insertAtInFile)) {
      return fail(ERROR_CODES.EWRITE_VERIFY, '方案里缺少 insertAtInFile / regionLength，无法校验');
    }
    const regionAt = Buffer.from(mainBytes.subarray(insertAtInFile, insertAtInFile + regionLength));
    const regionText = regionAt.toString('utf8');
    if (regionAt.length !== regionLength || !regionText.includes(SPLIT_START_MARKER)) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `插入点 in-file ${insertAtInFile} 处找不到 ${regionLength} 字节的 split 区域`,
        { regionAtLength: regionAt.length },
      );
    }
    if (!regionText.includes(SPLIT_PATCH_MARKER)) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `插入点处的区域没有 ${SPLIT_PATCH_MARKER} 标记`);
    }
    const regionSha = sha256Buffer(regionAt);
    if (typeof expectedRegionSha === 'string' && expectedRegionSha.length > 0 && regionSha !== expectedRegionSha) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `split 区域的摘要是 ${regionSha}，期望 ${expectedRegionSha}`,
        { expected: expectedRegionSha, actual: regionSha },
      );
    }
    const found = findSplitRegion(asar);
    if (found.ok !== true || found.startInMain !== insertAtInFile || found.length !== regionLength) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        '按标记定位到的 split 区域与计划的插入点/长度不一致',
        {
          insertAtInFile,
          regionLength,
          locatedStart: found.ok === true ? found.startInMain : null,
          locatedLength: found.ok === true ? found.length : null,
        },
      );
    }
    if (mainBytes.indexOf(Buffer.from(SPLIT_START_MARKER, 'utf8'), insertAtInFile + regionLength) >= 0) {
      return fail(ERROR_CODES.EWRITE_VERIFY, 'lib/main.js 里出现了第二个 split 区域标记');
    }

    const slot = locateRegion(asar);
    if (slot.ok !== true) {
      return fail(ERROR_CODES.EWRITE_VERIFY, `校验时定位不到官方托盘槽位：${slot.message}`);
    }
    if (plan.slot !== undefined && plan.slot !== null && Number.isInteger(plan.slot.startInMain)
      && (slot.startInMain !== plan.slot.startInMain || slot.length !== plan.slot.length)) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `官方托盘槽位移动了：${slot.startInMain}+${slot.length}，期望 ${plan.slot.startInMain}+${plan.slot.length}`,
      );
    }
    if (typeof plan.slotShaBefore === 'string' && slot.sha256 !== plan.slotShaBefore) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `官方托盘槽位的摘要是 ${slot.sha256}，期望 ${plan.slotShaBefore}（槽位必须逐字节保持原样）`,
        { expected: plan.slotShaBefore, actual: slot.sha256 },
      );
    }

    const tailNow = Buffer.from(mainBytes.subarray(insertAtInFile + regionLength));
    const tailSha = sha256Buffer(tailNow);
    if (typeof plan.mainTailSha === 'string' && tailSha !== plan.mainTailSha) {
      return fail(
        ERROR_CODES.EWRITE_VERIFY,
        `区域之后的 lib/main.js 尾部摘要变了（${tailSha} != ${plan.mainTailSha}）`,
      );
    }

    const expectedEntries = Array.isArray(options.expectedEntries) ? options.expectedEntries : null;
    const lookup = expectedEntries === null ? null : new Map(expectedEntries.map((item) => [item.path, item.bytes]));
    const planEntries = Array.isArray(plan.movedEntries) ? plan.movedEntries : [];
    for (const moved of planEntries) {
      const info = entryInfo(asar, moved.path);
      if (info === null) return fail(ERROR_CODES.EWRITE_VERIFY, `搬移后的条目 ${moved.path} 在目录里不见了`);
      if (Number(info.offset) !== Number(moved.newOffset) || Number(info.size) !== Number(moved.size)) {
        return fail(
          ERROR_CODES.EWRITE_VERIFY,
          `条目 ${moved.path} 现在在 ${info.offset}+${info.size}，期望 ${moved.newOffset}+${moved.size}`,
        );
      }
      const bytes = readEntry(asar, moved.path);
      if (bytes === null || bytes.length !== Number(moved.size)) {
        return fail(ERROR_CODES.EWRITE_VERIFY, `搬移后的条目 ${moved.path} 在 ${moved.newOffset} 处读不出来`);
      }
      if (lookup !== null) {
        const expected = lookup.get(moved.path);
        if (expected === undefined) {
          return fail(ERROR_CODES.EWRITE_VERIFY, `校验时缺少条目 ${moved.path} 的期望字节`);
        }
        if (!bytes.equals(Buffer.from(expected))) {
          return fail(ERROR_CODES.EWRITE_VERIFY, `搬移后的条目 ${moved.path} 的字节与写入前不同`);
        }
      }
    }

    return {
      ok: true,
      archiveSize: size,
      mainSize: mainBytes.length,
      regionSha,
      regionStartInMain: insertAtInFile,
      regionLength,
      officialSlotSha: slot.sha256,
      officialSlotStartInMain: slot.startInMain,
      mainTailSha: tailSha,
      movedEntries: planEntries.length,
      updatedEntries: planEntries.length + 1,
      headerBytes: asar.headerSize,
      dataStart: asar.dataStart,
      integrityVerified: opened.integrityVerified,
    };
  } finally {
    closeAsar(opened.asar);
  }
}

/** Re-exported so callers do not have to reach into `patch-body.js` for markers. */
export { REGION_LEAD };
