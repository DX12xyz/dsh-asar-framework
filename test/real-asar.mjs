/**
 * Shared facts about the REAL DSH desktop archives, indexed by DSH version.
 *
 * The suite used to assume one particular shipped archive. Every DSH release
 * repacks `app.asar`, so a new release silently broke half the suite — not
 * because anything was wrong, but because the tests could only describe one
 * version. This helper makes them version-aware:
 *
 *  - `SHELLS` maps `package.json.version` (as stored inside the archive) to the
 *    facts of that release: whole-file digest, byte geometry, the tray slot, and
 *    the machine's archive path.
 *  - Everything that varies with the release lives ONLY in ONE place — the
 *    registry `../lib/wire/shells.js`. A test asks `currentShell()` for the
 *    record of the archive on this machine instead of carrying its own numbers,
 *    and `evidence/shell-facts.mjs` prints the block to paste into the registry.
 *  - A version that is not in the table is reported as an explicit unsupported
 *    state (`unsupported: true`, reason `没有登记这个版本`), never thrown: the
 *    geometry tests skip with that reason instead of failing.
 *
 * What does NOT vary between releases (that is the whole premise of the
 * equal-length in-place patch, see `shell-drift.test.mjs`): the slot's offset
 * inside lib/main.js, its length and its bytes. What does not vary between
 * STATES of the same release is the `lib/main.js` size and the archive size —
 * except for the 0.2.0 SPLIT layout, which grows both by the reserved region.
 *
 * THREE states are now supported, not two:
 *
 *   stock          the shipped archive, untouched
 *   patched-by-us  in-slot layout: this package replaced one equal-length slot
 *   patched-by-us  split layout: the official slot is pristine and OUR region
 *                  was inserted right after it, so the archive and `lib/main.js`
 *                  are both exactly `split.addedBytes` larger
 *
 * The split layout is the reason this helper no longer compares a split install
 * against recorded digests. `buildSplitRegion()` produces the region's bytes, so
 * a body edit changes the region, `lib/main.js` and whole-file digests — while an
 * archive already on disk keeps the bytes of the build that wrote it. A digest
 * constant here would therefore call a healthy older install broken. The split
 * path instead proves the STRUCTURE (size, slot, insertion point) and leaves the
 * body-dependent part to {@link matchesCurrentBuild}, which is computed at test
 * time, and to {@link stripRegion}, which removes the region and demands the
 * remaining `lib/main.js` still be the STOCK digest.
 *
 * The numbers themselves are NOT in this file any more. They live in
 * `../lib/wire/shells.js` (`KNOWN_SHELLS`), because the installer needs the same
 * answer before it writes ("is this release verified?") that these tests need
 * afterwards. This helper adds the one thing only a test machine knows: the two
 * archive paths. Editing a digest here instead of there is therefore pointless —
 * the merge below takes every digest from the registry.
 *
 * The `patched` digests are the digests a stock archive takes after the
 * canonical equal-length patch is written into it. They were derived without
 * writing anything (slot bytes spliced in memory / streamed), by
 * `scratch/test-copies/derive-patched.mjs`. For rc.2 they reproduce the digest
 * pair of the historical v0.1.0 install, which is the cross-check that the
 * derivation is right.
 *
 * Nothing here writes: every archive is opened read-only and closed again.
 */
import { existsSync } from '../lib/fs-safe.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { INSTALL_ROOT, RESOURCES_DIR } from './desktop-root.mjs';

import { buildSplitRegion } from '../lib/asar/patch-body.js';
import { classifyAsar } from '../lib/asar/classify.js';
import { sha256Buffer } from '../lib/asar/hash.js';
import { closeAsar, entryInfo, openAsar, readEntry, readRootPackage } from '../lib/asar/reader.js';
import { locateRegion } from '../lib/asar/locate.js';
import { KNOWN_SHELLS } from '../lib/wire/shells.js';

/**
 * Where this machine's live DSH desktop install keeps its archive.
 *
 * The path is resolved from the environment (see `./desktop-root.mjs`), so this
 * file carries no machine-specific path of its own:
 *
 *   $env:DSH_DESKTOP_ROOT = '<DSH安装目录>'
 *   node --test --test-isolation=none test/*.test.mjs
 */
export const LIVE_ROOT = INSTALL_ROOT;
export const LIVE_ASAR = RESOURCES_DIR === '' ? '' : join(RESOURCES_DIR, 'app.asar');

/**
 * The archive the real-archive tests describe.
 *
 * Defaults to the live install. `DSH_REAL_ASAR` points the same suite at
 * another real shell (the kept rc.2 copy, a backup, another machine's install),
 * which is how "the tests pass on both releases" is actually demonstrated:
 *
 *   $env:DSH_REAL_ASAR = '<上一版档案副本>\app.asar'
 *   node --test --test-isolation=none test/*.test.mjs
 */
export const REAL_ASAR = process.env.DSH_REAL_ASAR ?? LIVE_ASAR;

/**
 * A kept copy of the previous release (@deepseek-ai/dsh-desktop@0.2.2-rc.2).
 *
 * Verified to be a pristine official build: its whole-file digest equals the
 * published one recorded for it in the registry, `package.json` says
 * 0.2.2-rc.2, and `lib/main.js` hashes to the digest the directory records. The
 * cross-version test uses it; when it is gone (a later cleanup, a fresh machine)
 * that test skips.
 *
 * `DSH_KEPT_ASAR` overrides the location; the default is the kept copy that
 * sits beside the repository.
 */
export const RC2_ASAR = process.env.DSH_KEPT_ASAR
  ?? fileURLToPath(new URL('../../../.dsh-p/app.asar', import.meta.url));

/** `false` when the machine has no archive at `REAL_ASAR` (those tests skip). */
export const missingAsar = !existsSync(REAL_ASAR);

/** Reason text used for a release that has no `SHELLS` entry yet. */
export const UNREGISTERED_REASON = '没有登记这个版本';

/**
 * @typedef {{
 *   size: number,
 *   headerSize: number,
 *   dataStart: number,
 *   entries: number,
 *   mainSize: number,
 *   mainOffset: number,
 *   mainAbsolute: number,
 * }} Geometry
 * @typedef {{
 *   mainSha: string,
 *   slotSha: string,
 *   slotOffsetInMain: number,
 *   slotLength: number,
 *   slotAbsolute: number,
 * }} StockFacts
 * @typedef {{
 *   archiveSha: string,
 *   mainSha: string,
 *   regionSha: string,
 * }} PatchedFacts
 * @typedef {{
 *   reserveBytes: number,
 *   insertAtInMain: number,
 *   slotOffsetInMain: number,
 *   slotLength: number,
 *   slotSha: string,
 *   addedBytes: number,
 *   mainSizeAfter: number,
 *   archiveSizeAfter: number,
 *   movingBytes: number,
 *   movedEntries: number,
 *   reserveLimit: number,
 * }} SplitFacts
 * @typedef {{
 *   version: string,
 *   path: string|null,
 *   archiveSha: string,
 *   geometry: Geometry,
 *   stock: StockFacts,
 *   patched: PatchedFacts,
 *   split: SplitFacts,
 * }} ShellRecord
 */

/**
 * Where THIS machine keeps each registered release's archive.
 *
 * The one thing a test needs that production must never carry: paths. Keyed by
 * DSH version (the same key as the registry). A release that is registered in
 * `lib/wire/shells.js` but has no entry here still appears in `SHELLS`, with
 * `path: null` — its facts stay assertable, only the "open the archive" tests
 * have nothing to point at.
 */
const SHELL_PATHS = Object.freeze({
  '0.2.2-rc.2': RC2_ASAR,
  '0.2.2-rc.3': LIVE_ASAR,
});

/**
 * One record per DSH desktop release this suite has been taught about.
 *
 * Built by merging the two halves: the verified facts come from the production
 * registry (`KNOWN_SHELLS`, imported above), the path from {@link SHELL_PATHS}.
 * So a test can never disagree with what the installer believes, and a digest
 * refreshed in the registry cannot be left stale here.
 *
 * @type {Record<string, ShellRecord>}
 */
export const SHELLS = Object.fromEntries(
  Object.entries(KNOWN_SHELLS).map(([version, facts]) => [
    version,
    { ...facts, path: Object.prototype.hasOwnProperty.call(SHELL_PATHS, version) ? SHELL_PATHS[version] : null },
  ]),
);

/** Versions this suite knows how to describe. */
export const KNOWN_VERSIONS = Object.freeze(Object.keys(SHELLS));

/**
 * The record for a DSH desktop version, or null when it is not registered.
 *
 * @param {string|null|undefined} version
 * @returns {ShellRecord|null}
 */
export function resolveShell(version) {
  if (typeof version !== 'string' || version.length === 0) return null;
  return Object.prototype.hasOwnProperty.call(SHELLS, version) ? SHELLS[version] : null;
}

/**
 * What one archive looks like right now.
 *
 * Field meanings, because two of them carry 0.1.x-era names that the split
 * layout made ambiguous:
 *
 *   regionSha / regionStartInMain / regionAbsolute
 *       the OFFICIAL tray slot as `locateRegion` measures it. That is what the
 *       in-slot layout rewrites, so the names stayed; in the split layout it is
 *       the pristine official slot, and in the stock state it is simply stock.
 *   splitLength / splitStartInMain / splitSha256
 *       OUR inserted region (0.2.0 split layout only; null otherwise), as
 *       `classifyAsar` reports it. Its digest is BUILD-DEPENDENT.
 *   archiveSize / mainSize
 *       measured sizes, so callers can compare against the layout arithmetic
 *       (`split.archiveSizeAfter` / `split.mainSizeAfter`) without re-opening.
 *   archiveSha
 *       always null: the whole-file digest is not stored in the archive and is
 *       far too expensive to compute here. The test that needs it hashes the file.
 *
 * @typedef {{
 *   present: boolean,
 *   state: 'stock'|'patched-by-us'|'foreign'|'unknown'|'missing',
 *   layout: 'pristine'|'in-slot'|'split'|'unknown',
 *   unsupported: boolean,
 *   version: string|null,
 *   shell: ShellRecord|null,
 *   reason: string,
 *   archiveSha: string|null,
 *   archiveSize: number|null,
 *   mainSize: number|null,
 *   mainSha: string|null,
 *   regionSha: string|null,
 *   regionStartInMain: number|null,
 *   regionAbsolute: number|null,
 *   splitLength: number|null,
 *   splitStartInMain: number|null,
 *   splitSha256: string|null,
 * }} RealState
 */

/** The `RealState` every failure path returns, so no caller sees a hole. */
function emptyState() {
  return {
    present: true,
    state: 'unknown',
    layout: 'unknown',
    unsupported: true,
    version: null,
    shell: null,
    reason: 'unreadable archive',
    archiveSha: null,
    archiveSize: null,
    mainSize: null,
    mainSha: null,
    regionSha: null,
    regionStartInMain: null,
    regionAbsolute: null,
    splitLength: null,
    splitStartInMain: null,
    splitSha256: null,
  };
}

/** Cached result; the archive does not change under a test run. */
let cached = null;

/**
 * Read the state of ONE archive, without caching.
 *
 * The version comes from the archive's own `package.json`, so the answer is
 * always about the archive that is actually there, not about the release this
 * code was written for. An unregistered version is a normal answer:
 * `state: 'unknown'`, `unsupported: true`, `reason: '没有登记这个版本'` — never a
 * throw, so a suite running against a brand-new DSH release reports "teach me
 * this version" instead of a stack trace.
 *
 * `allowStaleMainIntegrity` is required here: a patched archive legitimately
 * carries a stale `lib/main.js` digest in the directory header, and refusing to
 * read it would make the suite useless exactly when an install is present.
 *
 * Exported so a test can point it at a synthetic archive; production callers
 * use {@link realState}.
 *
 * @param {string} asarPath
 * @returns {RealState}
 */
export function readState(asarPath) {
  const empty = emptyState();

  const opened = openAsar(asarPath, { allowStaleMainIntegrity: true });
  if (opened.ok !== true) return { ...empty, reason: `${opened.code}: ${opened.message}` };

  try {
    const pkg = readRootPackage(opened);
    const version = pkg !== null && typeof pkg.version === 'string' ? pkg.version : null;
    const shell = resolveShell(version);

    if (shell === null) {
      // The explicit "we were never told about this release" answer.
      return { ...empty, version, reason: UNREGISTERED_REASON };
    }

    const classification = classifyAsar(opened);
    const main = readEntry(opened, 'lib/main.js');
    const located = locateRegion(opened);
    const mainInfo = entryInfo(opened, 'lib/main.js');
    // The split layout is a separate dimension, and its own facts (region
    // length/start/digest) live on the classification, not on `locateRegion`,
    // which deliberately keeps measuring the OFFICIAL slot.
    const isSplit = classification.layout === 'split';
    return {
      present: true,
      state: classification.state,
      layout: classification.layout,
      unsupported: false,
      version,
      shell,
      reason: classification.reason,
      // The whole-file digest is not stored anywhere in the archive and is far
      // too expensive to compute here; the table records it, and the test that
      // needs it hashes the file itself.
      archiveSha: null,
      archiveSize: opened.fileSize,
      mainSize: mainInfo === null ? null : Number(mainInfo.size),
      mainSha: main === null ? null : sha256Buffer(main),
      regionSha: located.ok === true ? located.sha256 : null,
      regionStartInMain: located.ok === true ? located.startInMain : null,
      regionAbsolute: located.ok === true ? located.absoluteOffset : null,
      splitLength: isSplit ? (classification.splitLength ?? null) : null,
      splitStartInMain: isSplit ? (classification.splitStartInMain ?? null) : null,
      splitSha256: isSplit ? (classification.splitSha256 ?? null) : null,
    };
  } finally {
    closeAsar(opened);
  }
}


/**
 * Read the LIVE archive's state, once per process.
 *
 * @returns {RealState}
 */
export function realState() {
  if (cached !== null) return cached;
  cached = missingAsar
    ? {
      ...emptyState(),
      present: false,
      state: 'missing',
      reason: 'no DSH desktop archive on this machine',
    }
    : readState(REAL_ASAR);
  return cached;
}

/**
 * The `SHELLS` record for the archive installed right now, or null when the
 * machine has none / runs a release that is not registered.
 *
 * @returns {ShellRecord|null}
 */
export function currentShell() {
  return realState().shell;
}

/**
 * The `package.json.version` the installed archive reports, or null.
 *
 * @returns {string|null}
 */
export function currentVersion() {
  return realState().version;
}

/**
 * `node:test` skip value for the real-archive tests: `false` when the installed
 * release is registered, otherwise the human-readable reason to skip with.
 *
 * @returns {false|string}
 */
export function shellGate() {
  return shellGateFor(realState());
}

/**
 * `node:test` skip value for an arbitrary {@link realState} result.
 *
 * @param {RealState} state
 * @returns {false|string}
 */
export function shellGateFor(state) {
  if (state.present !== true) return state.reason;
  if (state.shell === null) {
    const label = state.version === null ? '(unreadable package.json)' : state.version;
    return `shell ${label} ${UNREGISTERED_REASON}（${state.reason}）；用 evidence/shell-facts.mjs 生成表项`;
  }
  return false;
}

/**
 * Is the live archive in one of the states this package understands, for the
 * release it actually is?
 *
 * In-slot states (stock / patched-by-us on a pristine layout) are proven by
 * comparing `lib/main.js` against a digest the REGISTRY records: those bytes are
 * a function of the official release plus an equal-length slot replacement, so
 * they are stable.
 *
 * The SPLIT layout is proven STRUCTURALLY instead, and deliberately not by
 * digest: `buildSplitRegion()` decides the region's bytes, so every rebuild
 * changes the region, `lib/main.js` and whole-file digests, while an installed
 * archive keeps the release that wrote it. Comparing a split install against a
 * recorded digest would mark a healthy but older install as broken. What must
 * hold instead — and what a corrupted or foreign archive cannot fake — is that
 * the sizes are stock-plus-reserve, that the OFFICIAL SLOT is still the stock one
 * and that our region begins exactly where the layout says it does.
 *
 * @returns {{ ok: boolean, state: string, layout: string, reason: string }}
 */
export function realStateIsSupported() {
  const current = realState();
  if (current.present !== true) {
    return { ok: false, state: current.state, layout: current.layout, reason: current.reason };
  }
  if (current.shell === null) {
    return { ok: false, state: current.state, layout: current.layout, reason: current.reason };
  }
  if (current.state !== 'stock' && current.state !== 'patched-by-us') {
    return { ok: false, state: current.state, layout: current.layout, reason: current.reason };
  }

  if (current.layout === 'split') {
    const split = current.shell.split;
    if (current.archiveSize !== split.archiveSizeAfter) {
      return {
        ok: false,
        state: current.state,
        layout: current.layout,
        reason: `split layout but the archive is ${current.archiveSize} bytes, not ${split.archiveSizeAfter} (stock + ${split.reserveBytes})`,
      };
    }
    if (current.mainSize !== split.mainSizeAfter) {
      return {
        ok: false,
        state: current.state,
        layout: current.layout,
        reason: `split layout but lib/main.js is ${current.mainSize} bytes, not ${split.mainSizeAfter} (stock + ${split.reserveBytes})`,
      };
    }
    if (current.regionSha !== split.slotSha) {
      return {
        ok: false,
        state: current.state,
        layout: current.layout,
        reason: `split layout but the official slot is not the ${current.shell.version} stock digest — the slot must stay pristine`,
      };
    }
    if (current.splitStartInMain !== split.insertAtInMain) {
      return {
        ok: false,
        state: current.state,
        layout: current.layout,
        reason: `split layout but the region starts at in-file ${current.splitStartInMain}, not ${split.insertAtInMain} (the official slot's end)`,
      };
    }
    // NOT checked here, on purpose: the region digest, the lib/main.js digest and
    // the whole-file digest. All three depend on the body the installed build
    // wrote, so a stale-but-healthy install must not be reported as unsupported.
    return { ok: true, state: current.state, layout: current.layout, reason: current.reason };
  }

  if (current.layout === 'in-slot') {
    if (current.state === 'patched-by-us' && current.mainSha !== current.shell.patched.mainSha) {
      return {
        ok: false,
        state: 'patched-by-us',
        layout: current.layout,
        reason: `patched classification but lib/main.js digest is not this package's ${current.shell.version} patch`,
      };
    }
    return { ok: true, state: current.state, layout: current.layout, reason: current.reason };
  }

  if (current.state === 'stock' && current.mainSha !== current.shell.stock.mainSha) {
    return {
      ok: false,
      state: 'stock',
      layout: current.layout,
      reason: `stock classification but lib/main.js digest is not the ${current.shell.version} stock digest`,
    };
  }
  if (current.state === 'patched-by-us' && current.mainSha !== current.shell.patched.mainSha) {
    return {
      ok: false,
      state: 'patched-by-us',
      layout: current.layout,
      reason: `patched classification but lib/main.js digest is not this package's ${current.shell.version} patch`,
    };
  }
  return { ok: true, state: current.state, layout: current.layout, reason: current.reason };
}

/**
 * The digests expected for the state of the installed archive.
 *
 * For the two SLOT layouts every field is a recorded digest, because those bytes
 * are a function of the official release plus a slot replacement.
 *
 * A SPLIT install returns `{ layout: 'split', regionSha, slotSha, mainSha: null,
 * archiveSha: null }`: `regionSha` is the region measured off the disk (not the
 * build's), `slotSha` is the official slot it must still be, and the two
 * `null`s are the honest answer to "which digest should `lib/main.js` and the
 * whole file have" — that depends on the build that wrote this install, which
 * no registry can know. Callers must branch on `layout` and derive the
 * build-dependent answer with {@link matchesCurrentBuild} /
 * {@link stripRegion} instead of comparing against a constant.
 *
 * `slotSha` is always "what `locateRegion` should report for this state":
 * the stock digest on a pristine or split install, and the in-slot patch digest
 * on an in-slot install (there the official-looking slot is the one we rewrote).
 *
 * @returns {{
 *   layout: 'pristine'|'in-slot'|'split',
 *   archiveSha: string|null,
 *   mainSha: string|null,
 *   regionSha: string,
 *   slotSha: string,
 * }}
 * @throws {Error} when the archive is in neither supported state
 */
export function expectedForCurrentState() {
  const supported = realStateIsSupported();
  if (supported.ok !== true) {
    throw new Error(`real archive is in an unsupported state (${supported.state}): ${supported.reason}`);
  }
  const current = realState();
  const shell = current.shell;
  if (current.layout === 'split') {
    return {
      layout: 'split',
      // Measured off the archive: the region this install actually carries.
      regionSha: current.splitSha256,
      // The official slot does not move and stays pristine in this layout.
      slotSha: shell.split.slotSha,
      mainSha: null,
      archiveSha: null,
    };
  }
  return supported.state === 'stock'
    ? {
      layout: 'pristine',
      archiveSha: shell.archiveSha,
      mainSha: shell.stock.mainSha,
      regionSha: shell.stock.slotSha,
      slotSha: shell.stock.slotSha,
    }
    : {
      layout: 'in-slot',
      archiveSha: shell.patched.archiveSha,
      mainSha: shell.patched.mainSha,
      regionSha: shell.patched.regionSha,
      // An in-slot install rewrote the slot, so the locator reports our digest —
      // the STOCK digest lives in `shell.stock.slotSha` for that comparison.
      slotSha: shell.patched.regionSha,
    };
}

/**
 * The digest the CURRENT build produces for a split region of `length` bytes, or
 * null when the body no longer fits that length.
 *
 * Split out from {@link matchesCurrentBuild} so callers that only hold a recorded
 * digest (a classification's `splitSha256`, say) can ask the same question without
 * re-reading the bytes.
 *
 * @param {number} length region length in bytes
 * @returns {string|null}
 */
export function currentBuildRegionSha(length) {
  try {
    if (!Number.isInteger(length) || length < 0) return null;
    return sha256Buffer(buildSplitRegion(length));
  } catch {
    return null;
  }
}

/**
 * Does this region's bytes equal what the CURRENT build of `buildSplitRegion`
 * produces for the same length?
 *
 * This is the only sound way to ask "is the region what we would write today?"
 * on a split install, because the answer must come from the build in this
 * checkout, not from a digest written down when some earlier build was released.
 * A `false` answer is NOT an archive defect: it means the install predates a body
 * edit, so callers report it as "needs a reinstall to refresh", not as a failure.
 *
 * @param {Buffer} regionBytes region as read from the archive
 * @returns {boolean} false when the build cannot even produce that length
 */
export function matchesCurrentBuild(regionBytes) {
  if (!Buffer.isBuffer(regionBytes)) return false;
  const expected = currentBuildRegionSha(regionBytes.length);
  return expected !== null && sha256Buffer(regionBytes) === expected;
}

/**
 * Remove our split region from `lib/main.js` bytes.
 *
 * The reconstruction proof for the split layout: whatever the region says, a
 * healthy install must leave the REST of `lib/main.js` byte-for-byte official, so
 * stripping the region has to reproduce the STOCK digest the registry records.
 * This assertion never needs the build and must never skip — it is what separates
 * "installed with an older body" (fine) from "somebody rewrote the official
 * bytes" (broken).
 *
 * @param {Buffer} mainBytes `lib/main.js` as read from the archive
 * @param {{ startInMain: number, length: number }} split
 * @returns {Buffer}
 */
export function stripRegion(mainBytes, split) {
  const start = Number(split.startInMain);
  const length = Number(split.length);
  if (!Buffer.isBuffer(mainBytes)) throw new TypeError('stripRegion needs the lib/main.js bytes');
  if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length <= 0
    || start + length > mainBytes.length) {
    throw new Error(`split region ${start}..${start + length} does not fit lib/main.js (${mainBytes.length} bytes)`);
  }
  return Buffer.concat([mainBytes.subarray(0, start), mainBytes.subarray(start + length)]);
}

/** Absolute path of the scratch copy directory used by the write-path tests. */
export const COPY_DIR = fileURLToPath(new URL('../../scratch/test-copies/', import.meta.url));
