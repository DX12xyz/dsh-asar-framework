/**
 * Region locator: find the exact byte range of the DesktopTray slot inside
 * `lib/main.js`.
 *
 * The slot is delimited by the emitted `//#region` marker and the first
 * `//#endregion` after it. The start marker character of a region is part of
 * the region; everything between them is the stock body. Both markers survive
 * patching, so the same locator works on stock and on a patched asar.
 */

import {
  REGION_END_MARKER,
  REGION_LENGTH,
  REGION_START_MARKER,
  MAIN_RELATIVE_PATH,
} from '../wire/constants.js';
import { ERROR_CODES } from '../wire/errors.js';
import { sha256Buffer } from './hash.js';
import { MINIMUM_REGION_LENGTH } from './patch-body.js';
import { entryInfo, readEntry } from './reader.js';

/**
 * @typedef {{
 *   ok: true,
 *   startInMain: number,
 *   mainOffset: number,
 *   absoluteOffset: number,
 *   length: number,
 *   stockBytes: Buffer,
 *   sha256: string,
 *   endInMain: number,
 * }} LocateRegionOk
 * @typedef {{ ok: false, code: string, message: string }} LocateRegionFailure
 */

/**
 * Locate the tray region inside an already-opened asar.
 *
 * @param {import('./reader.js').OpenAsarOk} asar result of {@link openAsar}
 * @returns {LocateRegionOk | LocateRegionFailure}
 */
export function locateRegion(asar) {
  if (asar === null || typeof asar !== 'object' || asar.ok !== true) {
    return { ok: false, code: ERROR_CODES.EREGION_UNKNOWN, message: 'asar 没有打开，无法定位托盘槽位' };
  }
  const entry = entryInfo(asar, MAIN_RELATIVE_PATH);
  if (entry === null) {
    return {
      ok: false,
      code: ERROR_CODES.EASAR_MAIN_MISSING,
      message: `asar 里没有 ${MAIN_RELATIVE_PATH}`,
    };
  }
  if (entry.unpacked) {
    return {
      ok: false,
      code: ERROR_CODES.EASAR_MAIN_MISSING,
      message: `${MAIN_RELATIVE_PATH} 是 unpacked 条目，不在 asar 数据区里`,
    };
  }
  const mainBytes = readEntry(asar, MAIN_RELATIVE_PATH);
  if (mainBytes === null) {
    return {
      ok: false,
      code: ERROR_CODES.EASAR_MAIN_MISSING,
      message: `读不到 ${MAIN_RELATIVE_PATH} 的内容`,
    };
  }

  // Byte-level search keeps the offset exact even for multi-byte UTF-8 text.
  const startNeedle = Buffer.from(REGION_START_MARKER, 'utf8');
  const startInMain = mainBytes.indexOf(startNeedle);
  if (startInMain < 0) {
    return {
      ok: false,
      code: ERROR_CODES.EREGION_NOT_FOUND,
      message: `lib/main.js 里找不到托盘槽位起点标记 ${REGION_START_MARKER}`,
    };
  }

  const endNeedle = Buffer.from(REGION_END_MARKER, 'utf8');
  const endAt = mainBytes.indexOf(endNeedle, startInMain + startNeedle.length);
  if (endAt < 0) {
    return {
      ok: false,
      code: ERROR_CODES.EREGION_NOT_FOUND,
      message: 'lib/main.js 里找不到托盘槽位终点标记 //#endregion',
    };
  }

  const endInMain = endAt + endNeedle.length;
  const length = endInMain - startInMain;
  // The slot's LENGTH is a property of the shell's layout, not a constant of
  // this plugin: rc2 shipped 1253 bytes, rc3 still ships 1253, but a future
  // release may legitimately differ. What must never be guessed is the CONTENT
  // — the caller checks the digest against a known-stock digest before writing,
  // and `buildPatchedRegion(length)` then produces a body of exactly that size.
  if (length < MINIMUM_REGION_LENGTH) {
    return {
      ok: false,
      code: ERROR_CODES.EREGION_LENGTH,
      message: `托盘槽位只有 ${length} 字节，补丁体最小需要 ${MINIMUM_REGION_LENGTH} 字节（放不下，拒绝写入）`,
    };
  }

  const stockBytes = mainBytes.subarray(startInMain, endInMain);
  const sha256 = sha256Buffer(stockBytes);

  return {
    ok: true,
    startInMain,
    mainOffset: entry.offset,
    absoluteOffset: asar.dataStart + entry.offset + startInMain,
    length,
    stockBytes: Buffer.from(stockBytes),
    sha256,
    endInMain,
    /**
     * True when the slot no longer matches the length this plugin was built and
     * verified against. The caller may still proceed (the length is measured,
     * not assumed), but it must WARN: an unverified length means the body's
     * padding assumption is untested on that release.
     */
    lengthIsFamiliar: length === REGION_LENGTH,
  };
}
