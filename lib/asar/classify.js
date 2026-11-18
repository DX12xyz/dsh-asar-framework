/**
 * Classification of the tray slot: is this asar stock, already patched by us,
 * patched by somebody else, or a layout we do not recognize?
 *
 * TWO independent questions, answered by two independent detectors pointed at the
 * same file. The package can carry its tray implementation in two ways (see the
 * split-layout block in `lib/wire/constants.js`):
 *
 *   state   what the OFFICIAL tray slot contains
 *           'stock' | 'patched-by-us' | 'foreign' | 'unknown'   (v0.1.x vocabulary, unchanged)
 *   layout  which of our TWO layouts is actually on disk
 *           'pristine' | 'in-slot' | 'split'                    (v0.2.0 addition)
 *
 * `state` keeps every existing state name so all current consumers keep working;
 * `layout` is the added dimension that says WHICH install produced the bytes. The
 * two are not derivable from each other, and that is the point:
 *
 *   - the in-slot layout (0.1.x) replaces the official 1,253-byte slot, so the
 *     official slot is the only place to look for it;
 *   - the split layout (0.2.0) leaves the official slot BYTE-FOR-BYTE PRISTINE
 *     and inserts a region of our own right after it, so the official slot says
 *     `stock` even though we ARE installed. Detection that looked only at the
 *     slot made `snapshot.state` stock -> `installed = false` -> the setup page
 *     popped up on every launch, and `compat.assessSupport` ran its "stock"
 *     branch for an installed machine.
 *
 * Rules, in order:
 *  1. our split region is present                     -> layout 'split'
 *       a) the official slot ALSO carries `PATCH_MARKER` -> state 'foreign'
 *          (a self-inflicted double install: both layouts stacked up; never
 *          write over it silently, report it and let a human undo one of them)
 *       b) the official slot cannot be measured         -> state 'unknown'
 *          (our region is there but the official slot it was inserted after is
 *          no longer identifiable: report the deform, do not guess)
 *       c) otherwise                                     -> state 'patched-by-us'
 *  2. the official slot carries `PATCH_MARKER`        -> layout 'in-slot', patched-by-us
 *  3. the official slot carries `FOREIGN_MARKERS`     -> layout 'pristine', foreign
 *  4. the official slot is missing a `STOCK_ANCHORS` entry, or its start/end
 *     markers are incomplete                          -> layout 'pristine', unknown
 *  5. otherwise                                       -> layout 'pristine', stock
 * Plus the degenerate case: no official slot measurable AND no split region
 * -> layout 'pristine', state 'unknown'.
 *
 * Why the split detector runs FIRST: it is the only signal that survives the
 * split layout's whole premise (a pristine official slot). Why it does not
 * replace the slot detector: a stock-shaped split archive still needs rules 3-5,
 * and the in-slot layout is detected nowhere else.
 *
 * `locateRegion` is deliberately unchanged and still measures the OFFICIAL slot
 * (the in-slot layout rewrites exactly that range; the split layout inserts
 * after it). The two detectors are separate eyes on the same file on purpose.
 */

import {
  FOREIGN_MARKERS,
  PATCH_MARKER,
  REGION_END_MARKER,
  REGION_START_MARKER,
  STOCK_ANCHORS,
} from '../wire/constants.js';

/**
 * The one directory under which this package may append entries.
 *
 * It is a NAMESPACE, not a marker: everything else this framework writes goes into
 * `lib/main.js` (the split region) or into `app.asar.unpacked`, so a path under
 * here is ours by construction. `describeEdits` uses it as the fallback evidence
 * when no journal exists, and `lib/host/service.js` uses it to answer "which paths
 * may a caller append/remove/repoint". Narrowing it further would silently
 * disqualify a working install on the next classification, so it is a constant and
 * not a per-call option.
 */
export const EDIT_OWNED_ROOT = 'dsh-asar-edits';

import { buildPatchedRegion, buildSplitRegion } from './patch-body.js';
import { sha256Buffer } from './hash.js';
import { locateRegion } from './locate.js';
import { findSplitRegion } from './split.js';

/**
 * @typedef {'stock'|'patched-by-us'|'foreign'|'unknown'} AsarStateName
 * @typedef {'pristine'|'in-slot'|'split'} AsarLayoutName
 * @typedef {{
 *   state: AsarStateName,
 *   layout: AsarLayoutName,
 *   reason: string,
 *   foreignMarkers?: string[],
 *   missingAnchors?: string[],
 *   length?: number,
 *   sha256?: string,
 *   startInMain?: number,
 *   absoluteOffset?: number,
 *   matchesExpectedPatch?: boolean,
 *   splitLength?: number,
 *   splitStartInMain?: number,
 *   splitAbsoluteOffset?: number,
 *   splitSha256?: string,
 *   doubleInstall?: boolean,
 * }} Classification
 */

/**
 * Describe the DIRECTORY EDITS a caller knows about.
 *
 * Two independent sources, in this order, and the answer says which one it used —
 * "the journal says we appended X" and "the archive contains a path shaped like
 * one of ours" are different levels of proof:
 *
 *  1. `context.edits` (the journal's summary: `{ paths, baseSha }`). Authoritative
 *     when present: it was written by the operation that changed the archive, and
 *     it is what `--restore` undoes.
 *  2. The archive itself: any packed entry whose path lives under
 *     {@link EDIT_OWNED_ROOT}. That is THIS package's namespace — nothing else
 *     writes it, and a lost journal after a crash is exactly the case in which
 *     that fallback is the only evidence left. It is reported as the heuristic it
 *     is (`source: 'archive'`, `known: false`), so a caller can decide how much to
 *     believe it. Without it, an append whose journal was lost would read as "a
 *     stock archive carrying a file nobody knows about", which is the one answer
 *     that makes a user distrust a working install.
 *
 * Never throws. An unreadable archive reports `{ edited: false, known: false }`,
 * and the caller's state stays whatever the slot detectors said.
 *
 * @param {import('./reader.js').OpenAsarOk} asar
 * @param {{ edits?: { paths?: string[], baseSha?: string|null }|null }} [context]
 * @returns {{ edited: boolean, paths: string[], source: 'journal'|'archive'|null, known: boolean }}
 */
export function describeEdits(asar, context = {}) {
  const journal = context !== null && typeof context === 'object' && context !== undefined ? context.edits : null;
  if (journal !== null && typeof journal === 'object' && Array.isArray(journal.paths) && journal.paths.length > 0) {
    return { edited: true, paths: [...journal.paths], source: 'journal', known: true };
  }
  if (asar === null || typeof asar !== 'object' || asar.ok !== true || asar.entries === undefined) {
    return { edited: false, paths: [], source: null, known: false };
  }
  const paths = [];
  for (const path of asar.entries.keys()) {
    if (path.startsWith(`${EDIT_OWNED_ROOT}/`)) paths.push(path);
  }
  if (paths.length > 0) return { edited: true, paths, source: 'archive', known: false };
  return { edited: false, paths: [], source: null, known: true };
}

/**
 * Classify an opened asar. Never throws: an unreadable asar is `unknown`.
 *
 * THE STATE VOCABULARY IS FROZEN (`stock` | `patched-by-us` | `foreign` |
 * `unknown`, plus the `layout` dimension). Directory edits (append / remove /
 * repoint, `lib/asar/edit.js`) deliberately do NOT add a state: an appended
 * entry leaves the OFFICIAL tray slot and `lib/main.js` byte-for-byte alone, so
 * the archive is still ours and still `patched-by-us` + `split`. What the edits
 * DO add is a second, quieter dimension — `edited` — answered from the edit
 * journal in the state directory (`context.edits`, if the caller has one) with
 * a fallback to the archive itself: a path this package appended is yours even
 * if the journal was lost, because it lives under a directory name we own.
 *
 * WHY A MARKER IN THE RECORD AND NOT BYTES IN THE ARCHIVE: the technique's whole
 * premise is that the directory header keeps its EXACT byte length (that is what
 * keeps every offset valid, and what lets `--restore` reproduce the official
 * bytes). A signature entry inside the header would spend exactly the budget the
 * added file needs, and writing one into the appended payload would make the
 * archive digest depend on a receipt instead of on the bytes. So the receipt
 * lives in `edits.json` beside `install.json`, and the archive is judged by what
 * it contains.
 *
 * @param {import('./reader.js').OpenAsarOk} asar
 * @param {{ edits?: { paths?: string[], baseSha?: string|null }|null }} [context]
 *   `edits` is the journal's summary, when the caller has one. It is optional on
 *   purpose: classification must keep working on a bare archive.
 * @returns {Classification}
 */
export function classifyAsar(asar, context = {}) {
  // Both detectors return a failure OBJECT when their target is absent — that is
  // "not this layout", not an error, so it must never be thrown.
  const split = findSplitRegion(asar);
  const located = locateRegion(asar);
  const edits = describeEdits(asar, context);

  if (split.ok === true) {
    let matchesExpectedPatch = false;
    try {
      matchesExpectedPatch = split.sha256 === sha256Buffer(buildSplitRegion(split.length));
    } catch {
      matchesExpectedPatch = false;
    }
    /** @type {Classification} */
    const splitBase = {
      // A split region needs no official measurement to BE the split layout.
      layout: 'split',
      reason: '',
      splitLength: split.length,
      splitStartInMain: split.startInMain,
      splitAbsoluteOffset: split.absoluteOffset,
      splitSha256: split.sha256,
      // Directory edits do not change the state — an appended entry leaves the
      // official slot and lib/main.js alone — so they ride along as their own
      // dimension, which is what a UI has to render ("installed, with 2 files
      // added") and what `--restore` has to undo before shrinking.
      edited: edits.edited,
      editPaths: edits.paths,
      editSource: edits.source,
    };
    if (located.ok === true) {
      splitBase.length = located.length;
      splitBase.sha256 = located.sha256;
      splitBase.startInMain = located.startInMain;
      splitBase.absoluteOffset = located.absoluteOffset;
    }

    if (located.ok !== true) {
      // Rule 1b: the region we inserted is there, but the official slot markers
      // it must sit AFTER are gone. Deformed; report, never guess.
      return {
        ...splitBase,
        state: 'unknown',
        matchesExpectedPatch,
        reason: `split 区域在，但官方托盘槽位定位失败（${located.message ?? '未知原因'}），拒绝写入`,
      };
    }

    const slotText = located.stockBytes.toString('utf8');
    if (slotText.includes(PATCH_MARKER)) {
      // Rule 1a: our region AND our old in-slot patch in the same file. Both were
      // written by this package, so it is neither "foreign tool" nor "healthy":
      // it is a double install whose two definitions of DesktopTray disagree
      // about which one runs. Writing over it would hide the state from the
      // human, so it is reported as foreign and refused.
      return {
        ...splitBase,
        state: 'foreign',
        doubleInstall: true,
        // Informational only: with state 'foreign' no caller may write.
        matchesExpectedPatch,
        reason:
          '托盘槽位里是 0.1.x 的补丁，槽位之后又有 0.2.0 的自有区域：这是重复安装的结果，'
          + '两种布局不能叠加（哪一份 DesktopTray 生效取决于源码顺序），拒绝再次覆盖；请先还原成官方原样',
      };
    }

    return {
      ...splitBase,
      state: 'patched-by-us',
      matchesExpectedPatch,
      reason: '官方槽位保持原样，槽位之后是我们插入的自有区域（0.2.0 split 布局）',
    };
  }

  if (located.ok !== true) {
    return {
      state: 'unknown',
      // Nothing of ours is established, so both dimensions report "no layout".
      layout: 'pristine',
      edited: edits.edited,
      editPaths: edits.paths,
      editSource: edits.source,
      reason: located.message ?? '托盘槽位无法定位',
    };
  }

  const text = located.stockBytes.toString('utf8');
  const base = {
    layout: /** @type {AsarLayoutName} */ ('pristine'),
    length: located.length,
    sha256: located.sha256,
    startInMain: located.startInMain,
    absoluteOffset: located.absoluteOffset,
    edited: edits.edited,
    editPaths: edits.paths,
    editSource: edits.source,
  };

  if (text.includes(PATCH_MARKER)) {
    let matchesExpectedPatch = false;
    try {
      matchesExpectedPatch = located.sha256 === sha256Buffer(buildPatchedRegion(located.length));
    } catch {
      matchesExpectedPatch = false;
    }
    return {
      ...base,
      layout: /** @type {AsarLayoutName} */ ('in-slot'),
      state: 'patched-by-us',
      reason: '托盘槽位里已是我们写入的补丁标记',
      matchesExpectedPatch,
    };
  }

  const foreignMarkers = FOREIGN_MARKERS.filter((marker) => text.includes(marker));
  if (foreignMarkers.length > 0) {
    return {
      ...base,
      state: 'foreign',
      reason: `托盘槽位里有其他工具留下的标记：${foreignMarkers.join('、')}`,
      foreignMarkers,
    };
  }

  const missingAnchors = STOCK_ANCHORS.filter((anchor) => !text.includes(anchor));
  if (missingAnchors.length > 0) {
    return {
      ...base,
      state: 'unknown',
      reason: `托盘槽位缺少 ${missingAnchors.length} 个官方锚点，版本不认识，拒绝写入`,
      missingAnchors,
    };
  }

  if (!text.startsWith(REGION_START_MARKER) || !text.endsWith(REGION_END_MARKER)) {
    return {
      ...base,
      state: 'unknown',
      reason: '托盘槽位的起止标记不完整',
    };
  }

  return { ...base, state: 'stock', reason: '托盘槽位是官方原样' };
}

/**
 * Whether a classification may be written to by this framework.
 *
 * Both of OUR layouts are writable: `in-slot` is the 0.1.x refresh path (rewrite
 * the same range) and `split` is ours too (the 0.2.0 region is already installed;
 * a refresh writes the bridge and record, not the asar). `pristine` is writable
 * only in the `stock` state — an unknown or foreign pristine asar is a guess, and
 * a guess is never permission.
 *
 * A classification carrying no `layout` at all (an older caller-built shape) is
 * judged by its state alone, so this stays backward compatible.
 *
 * @param {Classification} classification
 * @returns {boolean}
 */
export function isWritableState(classification) {
  if (classification === null || typeof classification !== 'object') return false;
  if (classification.state !== 'stock' && classification.state !== 'patched-by-us') return false;
  if (classification.layout === undefined || classification.layout === null) return true;
  if (classification.layout !== 'pristine'
    && classification.layout !== 'in-slot'
    && classification.layout !== 'split') return false;
  // An archive carrying DIRECTORY EDITS is frozen in shape: `planSplit` reasons
  // about the exact geometry it measures, and an added entry at EOF (or a
  // compacted tail) makes every "stock + reserve" arithmetic wrong. The way
  // forward is `--restore`, which undoes the edits first and then shrinks; the
  // way forward is NOT "write a second layout on top". So the state stays
  // writable (it really is ours) but this predicate says no.
  if (classification.edited === true) return false;
  return true;
}

/**
 * Whether an archive carrying directory edits may be written to by the SPLIT
 * surgery (as opposed to merely being classified).
 *
 * Kept separate from {@link isWritableState} so the two questions stay
 * distinguishable in a report: "is this archive ours" (`isWritableState` minus the
 * edit clause) and "may the split surgery move bytes here" (this one). Nothing
 * else should call it.
 *
 * @param {object} classification
 * @returns {boolean}
 */
export function editsBlockSplitSurgery(classification) {
  if (classification === null || typeof classification !== 'object') return false;
  return classification.edited === true;
}

/**
 * The failure code and message a caller should report for a refused state.
 *
 * @param {Classification} classification
 * @returns {{ code: string, message: string }}
 */
export function refusalFor(classification) {
  if (classification === null || typeof classification !== 'object') {
    return {
      code: 'EUNKNOWN_LAYOUT',
      message: '无法识别这个 asar 的版本或结构，拒绝写入',
    };
  }
  if (classification.state === 'foreign') {
    return {
      code: 'EFOREIGN_PATCH',
      // The double install is OUR OWN doing, but it is still "this file must not
      // be written again"; it gets its own wording so a human knows to restore
      // one layout instead of hunting for a third-party tool that does not exist.
      message: classification.doubleInstall === true
        ? '槽位里是 0.1.x 的补丁、槽位之后又有 0.2.0 的自有区域（重复安装），拒绝再次覆盖；请先还原成官方原样，再只装一种布局'
        : (classification.reason ?? '检测到其他工具修改过这个 asar，拒绝覆盖'),
    };
  }
  return {
    code: 'EUNKNOWN_LAYOUT',
    message: classification.reason ?? '无法识别这个 asar 的版本或结构，拒绝写入',
  };
}
