/**
 * Host-side setup state: the single source of truth for "do we need to show the
 * install page, and what is the install root / asar state right now".
 *
 * Everything here is derived from read-only inspection of the install directory
 * and the state directory. Nothing in this module writes to an asar.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, renameSync } from '../fs-safe.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  STATE_DIR_NAME,
  ASAR_RELATIVE_PATH,
  BRIDGE_RELATIVE_PATH,
  MAIN_RELATIVE_PATH,
  REGION_RESERVE_BYTES,
  PACKAGE_NAME,
  FILES,
} from '../wire/constants.js';
import { FrameworkError, ERROR_CODES } from '../wire/errors.js';
import { normalizeInstallRoot } from '../scan/resolve.js';
import { readEditJournal } from '../install/record.js';
import { detectRegisteredNames } from './identity.js';
import { findPackageRoot, moduleDirOf } from './package-root.js';

/**
 * @typedef {'stock'|'patched-by-us'|'foreign'|'unknown'|'missing'} AsarState
 * @typedef {'pristine'|'in-slot'|'split'|'unknown'} AsarLayout
 * @typedef {{
 *   required: boolean,
 *   suppressed: boolean,
 *   installRoot: string|null,
 *   asarPath: string|null,
 *   state: AsarState,
 *   layout: AsarLayout,
 *   splitRegion: { length: number, sha256: string|null }|null,
 *   regionMatchesBuild: boolean|null,
 *   buildRegion: { length: number },
 *   dshVersion: string|null,
 *   backup: { name: string, size: number }|null,
 *   bridge: { present: boolean, size: number }|null,
 *   powerAvailable: boolean,
 *   installRecord: object|null,
 *   installState: InstallState,
 *   upgraded: boolean,
 *   compat: object|null,
 *   lastError: { code: string, message: string }|null,
 * }} SetupSnapshot
 *
 * @typedef {'never-installed'|'installed'|'spent'} InstallState
 */

/**
 * How many `app.asar.*.bak` backups sit beside the archive.
 *
 * Counting sibling of `findBackupName`: it answers "are there any backups left
 * at all" without caring which one is newest. An unreadable directory counts as
 * zero, because "no backup" is exactly what a vendor upgrade leaves behind.
 *
 * @param {string|null} asarPath
 * @returns {number}
 */
export function countBackups(asarPath) {
  if (!asarPath) return 0;
  try {
    return readdirSync(join(asarPath, '..'))
      .filter((name) => name.startsWith('app.asar.') && name.endsWith('.bak'))
      .length;
  } catch {
    return 0;
  }
}

/**
 * Decide what the install record means *now*, on this disk.
 *
 * A vendor upgrade of DSH replaces `resources\` wholesale: the archive becomes
 * pristine, every `*.bak` disappears and the unpacked bridge file goes with it,
 * while `install.json` still claims we installed something. A naive
 * "record exists => installed" check would therefore hide the install page
 * forever. This function reconciles the record against reality.
 *
 * Same semantics as `evidence/spent-install.mjs` (verified 8/8).
 *
 * @param {{ record: object|null, bridgePresent: boolean, backupCount: number, archiveSize: number }} input
 * @returns {InstallState}
 */
export function classifyInstall(input) {
  const record = input?.record ?? null;
  if (record === null || record.installed === false) return 'never-installed';
  // Older records may carry no size at all; a missing number must never be read
  // as "the size changed", so it falls back to 0 (= unknown).
  const recordedSize = Number(record.fileSize ?? record.asarSize ?? 0);
  const bridgeGone = input.bridgePresent !== true;
  const backupsGone = input.backupCount === 0;
  const sizeDiffers = recordedSize > 0 && recordedSize !== input.archiveSize;
  if (bridgeGone && backupsGone) return 'spent';
  if (sizeDiffers && backupsGone) return 'spent';
  return 'installed';
}

/** Resolve the state directory from an environment map (never throws). */
export function stateDirOf(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, STATE_DIR_NAME);
}

/** Read a small JSON file, returning null on any problem. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Atomic JSON write: temp file in the same directory, then rename. */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  } catch (error) {
    try { writeFileSync(tmp, ''); } catch { /* best effort */ }
    throw new FrameworkError(ERROR_CODES.EWRITE_FAILED, `写入 ${path} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The bundle-config key the Plugins page looks for.
 *
 * WHY IT IS ON THE SNAPSHOT AT ALL — the defect it repairs is silent:
 * `PluginManagerPage.tsx` decides `configured = ledger.bundles.has(openPkg.name)`
 * and `ledger.bundles` is the set of `key` options registered into
 * `plugins.bundle.config`. When a package RENAME leaves the profile calling us
 * `@local/dsh-asar-framework` while the bundle is `@dx12xyz/dsh-asar-framework`,
 * the lookup misses and the settings card is not rendered — no error, no empty
 * state, just a page without its configuration section.
 *
 * The Client half reads `identity.registeredNames` from `/state` and registers
 * one `plugins.bundle.config` entry per name, so the page finds at least one
 * matching key whichever of the two names it reports for this bundle.
 *
 * `registeredNames` ALWAYS contains `packageName`, so a caller that ignores the
 * field keeps the pre-0.7.1 behaviour exactly.
 *
 * The package name is read from the package's OWN `package.json` when it is
 * readable, not taken from a constant here: everything about this probe is
 * derived from `packageRoot`, so a copy whose manifest disagrees with the build
 * still reports the truth about itself. `fallbackName` is the compiled-in name
 * and the value used whenever the manifest cannot be read.
 *
 * @param {string|null} packageRoot
 * @param {string} fallbackName
 * @returns {{ packageName: string, registeredNames: string[], profileDir: string|null, ok: boolean }}
 */
function identityOf(packageRoot, fallbackName) {
  let packageName = fallbackName;
  if (packageRoot !== null) {
    const manifest = readJson(join(packageRoot, 'package.json'));
    if (manifest !== null && typeof manifest === 'object'
      && typeof manifest.name === 'string' && manifest.name.length > 0) {
      packageName = manifest.name;
    }
  }
  const fallback = { packageName, registeredNames: [packageName], profileDir: null, ok: false };
  try {
    const detected = detectRegisteredNames({ packageRoot, packageName });
    return {
      packageName: typeof detected.packageName === 'string' && detected.packageName.length > 0
        ? detected.packageName
        : packageName,
      registeredNames: Array.isArray(detected.registeredNames) && detected.registeredNames.length > 0
        ? detected.registeredNames
        : [packageName],
      profileDir: typeof detected.profileDir === 'string' ? detected.profileDir : null,
      ok: detected.ok === true,
    };
  } catch {
    // Fail-soft: a probe that cannot answer must not take the snapshot with it.
    return fallback;
  }
}

/**
 * Create the setup state holder.
 *
 * @param {{ stateDir?: string, env?: Record<string, string|undefined>, locate?: Function, classify?: Function, bridgePathFor?: Function, packageRoot?: string|null, packageName?: string }} options
 */
export function createSetupState(options = {}) {
  const stateDir = options.stateDir ?? stateDirOf(options.env ?? process.env);
  // The package root is only needed to locate the profile that registered this
  // plugin. `packageRootFrom` would throw when the copy on disk is broken, so
  // the search is done by hand and a null answer simply means "probe disabled"
  // (the identity then reports the package's own name).
  const packageRoot = options.packageRoot === undefined || options.packageRoot === null
    ? (() => { try { return findPackageRoot(moduleDirOf(import.meta.url)); } catch { return null; } })()
    : options.packageRoot;
  const fallbackPackageName = typeof options.packageName === 'string' && options.packageName.length > 0
    ? options.packageName
    : PACKAGE_NAME;
  let suppressed = false;
  let suppressReason = null;
  let lastSnapshot = null;
  // The probe reads a handful of small JSON files; doing it on every 5 s poll
  // would be pointless IO for a value that only changes when the profile is
  // edited and DSH is restarted. Computed once per state holder.
  let identityCache = null;

  /** The registration identity, computed at most once per state holder. */
  function identity() {
    if (identityCache === null) identityCache = identityOf(packageRoot, fallbackPackageName);
    return identityCache;
  }

  /**
   * Load the asar layer lazily so a missing/broken implementation degrades into
   * `unknown` instead of breaking Host startup.
   */
  async function loadAsarModule() {
    try {
      return await import('../asar/reader.js');
    } catch (error) {
      return { ok: false, importError: error };
    }
  }

  /** Pick a candidate install root: explicit, then install record, then env. */
  function resolveRoot(explicit) {
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    const record = readJson(join(stateDir, FILES.install));
    if (record && typeof record.installRoot === 'string') return record.installRoot;
    return null;
  }

  /** The newest `app.asar.*.bak` beside the asar, if any. */
  function findBackupName(asarPath) {
    if (!asarPath) return null;
    try {
      const dir = join(asarPath, '..');
      const names = readdirSync(dir).filter((name) => name.startsWith('app.asar.') && name.endsWith('.bak'));
      if (names.length === 0) return null;
      let best = null;
      for (const name of names) {
        try {
          const info = statSync(join(dir, name));
          if (best === null || info.mtimeMs > best.mtimeMs) best = { name, size: info.size, mtimeMs: info.mtimeMs };
        } catch { /* skip unreadable */ }
      }
      return best ? { name: best.name, size: best.size } : null;
    } catch {
      return null;
    }
  }

  /**
   * Recompute the snapshot. Read-only with respect to the install directory.
   * @param {{ root?: string, powerAvailable?: boolean }} [hints]
   * @returns {Promise<SetupSnapshot>}
   */
  async function refresh(hints = {}) {
    // A configured or recorded path may be the `resources` directory (or the
    // archive itself) rather than the install root; normalize it so every
    // consumer sees the same canonical shape.
    const hinted = resolveRoot(hints.root);
    const installRoot = hinted === null ? null : normalizeInstallRoot(hinted);
    const snapshot = {
      required: false,
      suppressed,
      installRoot,
      asarPath: null,
      state: 'missing',
      // Which of OUR two layouts is on disk: 'pristine' (nothing of ours),
      // 'in-slot' (0.1.x), 'split' (0.2.0) — or 'unknown' when the archive
      // could not be read far enough to say. Reported so the UI/CLI can name the
      // layout instead of leaving a human to infer it from `state`.
      layout: 'pristine',
      // Our region, when there is one: its length and digest as the classifier
      // measured them. Null for the two layouts that have no region.
      splitRegion: null,
      /**
       * "Is the region on disk the region THIS build would write?" — bytes AND
       * reserved length, in one boolean. `null` means "no region, the question
       * does not apply"; `false` means "a refresh is needed".
       *
       * WHY THE HOST NEEDS THIS AT ALL: `asarShell.channelSend` sends the reserved
       * `dsh-asar-bridge` type over real IPC, and an OLD region (one whose body
       * predates the guard) answers `false` to it — which makes the main process
       * kill the Host child, i.e. the user's session. The guard has to be here,
       * on the sending side, BEFORE `process.send`, and it must be cheap: this
       * flag comes from the classification that already happens on every
       * snapshot, so the send path reads a cached boolean instead of hashing 209 MB.
       *
       * WHY THE CLIENT NEEDS IT: the settings card used to offer only "重新打开安装页",
       * which only clears suppression — on a healthy install (`required === false`)
       * that button did nothing at all, exactly when the archive holds an older
       * region (8 KiB) than this build writes. The card now offers a reinstall
       * button and a warning line, and this flag is what decides when to show them.
       * The length is folded in HERE (see the assignment below) rather than left to
       * the caller, so every consumer gets the same "needs a refresh" answer.
       */
      regionMatchesBuild: null,
      /**
       * What THIS build would write, as a stable field instead of a constant the
       * client has to know.
       *
       * The settings card has to print both numbers ("installed 8192 B / current
       * 16384 B") to explain why an install that is otherwise healthy still needs
       * a refresh. `REGION_RESERVE_BYTES` is a packaging decision that has already
       * changed once (8,192 -> 16,384), so a client that hardcoded it would show a
       * WRONG number on the very build that changed it — and would keep showing
       * it on the next change. Reported here, from the same constant `planSplit`
       * uses, so the card and the writer can never disagree.
       */
      buildRegion: { length: REGION_RESERVE_BYTES },
      dshVersion: null,
      backup: null,
      bridge: null,
      powerAvailable: hints.powerAvailable === true,
      // The name(s) this package is registered under in THIS machine's profile.
      // Read by the Client half so the settings card key matches whatever the
      // Plugins page reports for the bundle (see `identityOf` above).
      identity: identity(),
      installRecord: readJson(join(stateDir, FILES.install)),
      // Replaced on the first branch that can actually see the disk; the
      // defaults describe "no record, nothing installed".
      installState: 'never-installed',
      upgraded: false,
      /**
       * Directory edits (`lib/asar/edit.js`): whether this package appended /
       * removed / repointed anything, which paths, and where the answer came
       * from (`journal` = the record we wrote, `archive` = a path under our own
       * namespace found by looking at the file alone).
       *
       * Why it is on the snapshot: `regionMatchesBuild` answers "is the region
       * current", and an edited archive is still current — but the SPLIT surgery
       * must not run on it (its geometry is no longer "stock + reserve"), so the
       * UI needs to know before it offers a refresh, and `--restore` needs the
       * journal to undo. The STATE vocabulary is untouched: an edited archive is
       * still `patched-by-us` + `split`.
       */
      edited: false,
      editPaths: [],
      editSource: null,
      editJournal: null,
      compat: null,
      lastError: null,
    };

    if (!installRoot) {
      snapshot.required = !suppressed;
      lastSnapshot = snapshot;
      return snapshot;
    }

    const asarPath = join(installRoot, ...ASAR_RELATIVE_PATH.split('/'));
    snapshot.asarPath = asarPath;
    if (!existsSync(asarPath)) {
      snapshot.state = 'missing';
      // No archive means no install history worth trusting either.
      snapshot.installState = 'never-installed';
      snapshot.upgraded = false;
      snapshot.lastError = { code: ERROR_CODES.EASAR_MISSING, message: '安装目录里没有 resources\\app.asar' };
      snapshot.required = !suppressed;
      lastSnapshot = snapshot;
      return snapshot;
    }

    const bridgePath = join(installRoot, ...BRIDGE_RELATIVE_PATH.split('/'));
    try {
      const info = statSync(bridgePath);
      snapshot.bridge = { present: true, size: info.size };
    } catch {
      snapshot.bridge = { present: false, size: 0 };
    }
    snapshot.backup = findBackupName(asarPath);

    // Reconcile the record with what is actually on disk. This runs as soon as
    // the archive size and the backup count are known, because every later
    // branch (and every consumer of snapshot.required) depends on it.
    let asarSize = 0;
    try {
      asarSize = statSync(asarPath).size;
    } catch {
      asarSize = 0;
    }
    const backupCount = countBackups(asarPath);
    const record = snapshot.installRecord;
    snapshot.installState = classifyInstall({
      record,
      bridgePresent: snapshot.bridge?.present === true,
      backupCount,
      archiveSize: asarSize,
    });
    snapshot.upgraded = snapshot.installState === 'spent';

    const reader = await loadAsarModule();
    if (!reader || typeof reader.openAsar !== 'function') {
      snapshot.state = 'unknown';
      snapshot.layout = 'unknown';
      snapshot.lastError = { code: ERROR_CODES.EASAR_HEADER, message: 'asar 读取模块不可用' };
      snapshot.required = !suppressed;
      lastSnapshot = snapshot;
      return snapshot;
    }

    try {
      const opened = reader.openAsar(asarPath, { allowStaleMainIntegrity: true });
      if (!opened || opened.ok !== true) {
        snapshot.state = 'unknown';
        snapshot.layout = 'unknown';
        snapshot.lastError = {
          code: opened?.code ?? ERROR_CODES.EASAR_HEADER,
          message: opened?.message ?? '无法解析 asar 目录头',
        };
        snapshot.required = !suppressed;
        lastSnapshot = snapshot;
        return snapshot;
      }

      const pkgText = reader.readEntryText(opened, 'package.json');
      if (pkgText) {
        try {
          const pkg = JSON.parse(pkgText);
          snapshot.dshVersion = typeof pkg.version === 'string' ? pkg.version : null;
        } catch { /* version stays null */ }
      }

      const locate = await import('../asar/locate.js').catch(() => null);
      const classifyModule = await import('../asar/classify.js').catch(() => null);
      // The journal summary is what classification treats as PROOF that a path
      // under our namespace is ours; without it, `describeEdits` falls back to the
      // archive itself and reports the weaker `source: 'archive'`.
      const editJournal = readEditJournal(stateDir);
      const editSummary = editJournal === null
        ? null
        : {
          paths: editJournal.records
            .filter((record) => record !== null && typeof record === 'object' && typeof record.path === 'string')
            .map((record) => record.path),
          baseSha: editJournal.base !== null && typeof editJournal.base === 'object'
            ? (editJournal.base.sha256 ?? null)
            : null,
        };
      const classification = classifyModule && typeof classifyModule.classifyAsar === 'function'
        ? classifyModule.classifyAsar(opened, { edits: editSummary })
        : { state: 'unknown', layout: 'unknown', reason: 'classify 模块不可用' };
      snapshot.state = classification.state ?? 'unknown';
      // Which of our two layouts is in use. `classifyAsar` answers both questions
      // independently: with the split layout (0.2.0) the OFFICIAL slot is stock
      // while our own region sits right after it, so `state` alone cannot say
      // "installed" — `layout` is what the UI/CLI shows the human.
      snapshot.layout = classification.layout ?? 'unknown';
      snapshot.edited = classification.edited === true;
      snapshot.editPaths = Array.isArray(classification.editPaths) ? classification.editPaths : [];
      snapshot.editSource = classification.editSource ?? null;
      snapshot.editJournal = editJournal === null
        ? null
        : {
          records: Array.isArray(editJournal.records) ? editJournal.records.length : 0,
          base: editJournal.base ?? null,
          ops: editJournal.records
            .filter((record) => record !== null && typeof record === 'object')
            .map((record) => ({ kind: record.kind ?? null, path: record.path ?? null })),
        };
      // The region's identity, straight off the classifier: it measured the
      // region's length and hashed its bytes against `buildSplitRegion(length)`,
      // so `regionMatchesBuild` is "this exact region is what this build writes".
      // Kept null for the two layouts that carry no region, so a caller cannot
      // mistake "no region" for "a stale one".
      if (classification.layout === 'split' && Number.isInteger(classification.splitLength)) {
        snapshot.splitRegion = {
          length: classification.splitLength,
          sha256: typeof classification.splitSha256 === 'string' ? classification.splitSha256 : null,
        };
        // "Is the installed region the region THIS build writes?" — bytes AND
        // length, folded into one boolean.
        //
        // `matchesExpectedPatch` alone answers the bytes half, measured at the
        // INSTALLED length. That is not enough for a caller: a region of the
        // right bytes but an older reserved LENGTH (8,192 from the previous build
        // vs 16,384 today) still has to be rewritten, because the tail offsets of
        // the layout are derived from the length. Such a region would read
        // `matchesExpectedPatch: true` whenever its body happens to fit the older
        // length, so the length test is applied HERE instead of leaving every
        // consumer to remember it. (The 8 KiB case also fails the byte test, since
        // `buildSplitRegion(8192)` cannot even fit today's body and throws — but
        // the predicate must not depend on that accident.)
        snapshot.regionMatchesBuild = classification.matchesExpectedPatch === true
          && classification.splitLength === REGION_RESERVE_BYTES;
      } else {
        snapshot.splitRegion = null;
        snapshot.regionMatchesBuild = null;
      }
      // stock is a perfectly normal state (it just means "bridge not installed
      // yet"), so it must NOT be reported as an error. Only states that actually
      // block a write are surfaced in lastError.
      if ((classification.state === 'foreign' || classification.state === 'unknown')
        && typeof classification.reason === 'string') {
        snapshot.lastError = {
          code: classification.state === 'foreign' ? ERROR_CODES.EFOREIGN_PATCH : ERROR_CODES.EUNKNOWN_LAYOUT,
          message: classification.reason,
        };
      }

      // Release check. This is what answers "may we write here, and must we
      // warn?" — and it is deliberately computed on every refresh, not only when
      // the human presses Install: an unregistered version must be visible in the
      // install page BEFORE the button is pressed, while there is still time to
      // read it.
      //
      // It is REPORTED, never collapsed into `lastError`. `lastError` means "the
      // archive or the install state is not what it should be"; the release check
      // is a property of a perfectly healthy stock archive (a new DSH release is
      // not an error). Folding it in would make every fresh install on a new
      // release look broken, and would duplicate the warnings the install page
      // already renders from `compat`.
      const compatModule = await import('../host/compat.js').catch(() => null);
      if (compatModule && typeof compatModule.assessSupport === 'function') {
        const mainText = reader.readEntryText(opened, MAIN_RELATIVE_PATH);
        snapshot.compat = compatModule.assessSupport({
          version: snapshot.dshVersion,
          classification,
          mainText,
        });
      }
    } catch (error) {
      snapshot.state = 'unknown';
      snapshot.layout = 'unknown';
      snapshot.lastError = {
        code: ERROR_CODES.EASAR_HEADER,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    // "Required" means the bridge is not installed *or* the archive is not ours.
    // Both of our layouts count: `patched-by-us` is the state the classifier
    // reports for the in-slot patch (0.1.x) AND for the split layout (0.2.0),
    // because rule 1 of `classifyAsar` answers "we are installed" for the split
    // region too. `layout` therefore does not need to be consulted here — but the
    // check below is written out with it so a future state rename cannot quietly
    // start hiding the page for a healthy split install.
    const installedByState = snapshot.state === 'patched-by-us';
    const installedByLayout = snapshot.layout === 'split' && snapshot.state !== 'foreign';
    const installed = (installedByState || installedByLayout) && snapshot.bridge?.present === true;
    snapshot.required = !installed && !suppressed;

    if (snapshot.installState === 'spent') {
      snapshot.required = !suppressed;
      // Overrides the (deliberately silent) stock branch above: this is the one
      // state where the user genuinely needs to be told to reinstall.
      snapshot.lastError = {
        code: ERROR_CODES.ESTATE_UPGRADED,
        message: 'DSH 已升级，原来的壳桥和备份都不见了，需要在新版本上重新安装',
      };
    }

    lastSnapshot = snapshot;
    return snapshot;
  }

  /** Remember a restored asar for this process only; also persists a flow marker. */
  function markRestored(reason = 'restored') {
    suppressed = true;
    suppressReason = reason;
    try {
      mkdirSync(stateDir, { recursive: true });
      writeJsonAtomic(join(stateDir, FILES.uninstallFlow), { phase: 'restored', at: new Date().toISOString(), reason });
    } catch {
      /* the in-memory suppression still holds for this run */
    }
    return snapshotNow();
  }

  /** Suppress the install page for this run (user dismissed it or restored). */
  function suppress(reason = 'dismissed') {
    suppressed = true;
    suppressReason = reason;
    return snapshotNow();
  }

  /** Undo a suppression (user explicitly asked to see the install page again). */
  function unsuppress() {
    suppressed = false;
    suppressReason = null;
    return snapshotNow();
  }

  /** The last snapshot, with suppression applied (never triggers disk IO). */
  function snapshotNow() {
    if (lastSnapshot === null) {
      return {
        required: !suppressed,
        suppressed,
        suppressReason,
        installRoot: resolveRoot(),
        asarPath: null,
        state: 'missing',
        layout: 'pristine',
        splitRegion: null,
        regionMatchesBuild: null,
        buildRegion: { length: REGION_RESERVE_BYTES },
        dshVersion: null,
        backup: null,
        bridge: null,
        powerAvailable: false,
        // Same shape as the refresh() literal: the card polls /state and has to
        // be robust to an early/empty reply, so the cold snapshot cannot be one
        // key short of the warm one.
        identity: identity(),
        installRecord: null,
        installState: 'never-installed',
        upgraded: false,
        compat: null,
        lastError: null,
      };
    }
    return { ...lastSnapshot, suppressed, suppressReason, required: lastSnapshot.required && !suppressed };
  }

  return {
    stateDir,
    refresh,
    snapshot: snapshotNow,
    suppress,
    unsuppress,
    markRestored,
    resolveRoot,
    get suppressed() { return suppressed; },
  };
}
