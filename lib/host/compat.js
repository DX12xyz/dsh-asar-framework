/**
 * Compatibility gate: "may this installer write, and must it warn?"
 *
 * Two questions that used to be answered in three different places — the locator
 * measured the slot, the classifier named the state, the installer trusted
 * `version` — and none of them answered the one that matters: *is this release
 * one whose result we have actually seen working?* The consequences of getting
 * it wrong are not symmetric: a refused install is annoying, a wrong install
 * leaves a desktop app that cannot draw its tray, or that cannot start at all.
 *
 * So the answer is computed here, once, from three inputs:
 *
 *   version         what the archive's own `package.json` says
 *   classification  what the slot actually looks like (see `lib/asar/classify.js`)
 *   mainText        the official `lib/main.js`, which must still contain every
 *                   name the injected body references
 *
 * Three levels, and only the first two may write:
 *
 *   verified        a registered release whose slot length AND slot bytes are in
 *                   the end-to-end verified set -> write silently
 *   unverified      stock-looking but not yet proven (new version, new slot size,
 *                   reworded slot) -> write, but say exactly what is new
 *   incompatible    the patch would be unsafe or meaningless -> refuse
 *
 * Why the slot bytes are checked separately from the version: "this is
 * 0.2.2-rc.4" proves nothing about the bytes in the slot. A release that
 * reworded the tray comment block keeps every anchor, so `classifyAsar` still
 * says `stock` — and the patch would still fit, because the length is measured
 * rather than assumed. Whether the *result* is a usable tray is a question only
 * a run on a real shell answers, which is why the digest set is a hand-written
 * list (`FAMILIAR_SLOT_SHA256S`) and not "everything we have ever seen".
 *
 * Why the dependency list exists at all: the patch body runs at the top level of
 * `lib/main.js` and may not import anything of its own. It can therefore only
 * use names the official file already has in scope — `createRequire`, `resolve`,
 * `process`, `process.resourcesPath`, `Tray`, `Menu`, `nativeImage`, `app`,
 * `import.meta.url`. If a future build drops one of them (a bundler inlining
 * `process.resourcesPath` into a constant, say), the injected body compiles to a
 * ReferenceError at startup and the desktop app dies before it draws a window.
 * Checking the text costs one pass over ~830 KB and turns that crash into a
 * refusal with a readable reason.
 *
 * Every entry point is total: any input shape produces an answer instead of a
 * throw, because the caller is a GUI action handler and the user must see why
 * nothing happened.
 */

import { FAMILIAR_SLOT_LENGTHS, FAMILIAR_SLOT_SHA256S, shellFacts } from '../wire/shells.js';

/**
 * Names the injected patch body references from the enclosing scope of
 * `lib/main.js`.
 *
 * This is the contract with `lib/asar/patch-body.js` and is deliberately NOT
 * derived from it: the body is a string, and a string cannot be introspected
 * reliably enough to prove "these nine names, no new ones". Every change to the
 * body that adds a name must therefore be mirrored here — and a name that
 * disappears here while the body still uses it is exactly the startup crash this
 * list exists to catch.
 *
 * `import.meta.url` is listed with the dot: that is the whole expression the
 * body hands to `createRequire`, and a build that replaced it with a literal path
 * would break the body even though `import.meta` survived.
 */
export const PATCH_DEPENDENCIES = Object.freeze([
  'createRequire',
  'resolve',
  'process',
  'process.resourcesPath',
  'Tray',
  'Menu',
  'nativeImage',
  'app',
  'import.meta.url',
]);

/** Warning used when `lib/main.js` cannot be read at all (rule 1). */
const UNREADABLE_MAIN_WARNING = '读不到 lib/main.js 的内容，无法确认补丁需要的名字还在（拒绝写入）';

/** Warning used when an unrecognizable asar names no reason of its own (rule 3). */
const UNIDENTIFIED_ASAR_WARNING = '无法识别这个 asar 的版本或结构，拒绝写入';

/**
 * @typedef {{
 *   allowed: boolean,
 *   level: 'verified'|'unverified'|'incompatible',
 *   version: string|null,
 *   knownVersion: boolean,
 *   slotLengthFamiliar: boolean,
 *   slotShaFamiliar: boolean,
 *   missingDependencies: string[],
 *   warnings: string[],
 *   summary: string,
 * }} SupportAssessment
 */

/**
 * Which patch dependencies are absent from `lib/main.js`.
 *
 * Total by design: `null`, `undefined`, a number or an empty string all mean
 * "there is no readable text", which is reported as *every* dependency missing —
 * a caller must never be able to fall through to "nothing is missing, so let us
 * write".
 *
 * The result keeps {@link PATCH_DEPENDENCIES} order, so the refusal message
 * reads the same way every time regardless of where in the file a name went
 * missing.
 *
 * @param {string|null|undefined} mainText official `lib/main.js` contents
 * @returns {string[]} the missing subset, in PATCH_DEPENDENCIES order
 */
export function missingPatchDependencies(mainText) {
  if (typeof mainText !== 'string' || mainText.length === 0) return [...PATCH_DEPENDENCIES];
  return PATCH_DEPENDENCIES.filter((name) => !mainText.includes(name));
}

/**
 * The version as it should appear in prose: the string itself, or `未知`.
 *
 * @param {unknown} version
 * @returns {string}
 */
function labelOf(version) {
  return typeof version === 'string' && version.length > 0 ? version : '未知';
}

/**
 * How a slot digest is named in a warning: first eight hex digits + ellipsis,
 * or `未知` when the caller could not compute one.
 *
 * @param {unknown} sha256
 * @returns {string}
 */
function shortDigest(sha256) {
  if (typeof sha256 !== 'string' || sha256.length === 0) return '未知';
  return `${sha256.slice(0, 8)}…`;
}

/**
 * The normalised shape of the argument, extracted once so every rule reads the
 * same values. An array or a primitive is "no input", never an error.
 *
 * @param {unknown} input
 * @returns {{ version: string|null, classification: object|null, mainText: unknown }}
 */
function normalizeInput(input) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const version = typeof source.version === 'string' && source.version.length > 0 ? source.version : null;
  const classification = source.classification !== null
    && typeof source.classification === 'object'
    && !Array.isArray(source.classification)
    ? source.classification
    : null;
  return { version, classification, mainText: source.mainText };
}

/**
 * Decide whether the installer may write to this archive, and what to warn about.
 *
 * Rules, in order — the first one that fires wins, so a refusal never hides
 * behind a warning:
 *
 *  1. `mainText` is not a non-empty string  -> incompatible, all nine missing
 *  2. any patch dependency is missing       -> incompatible
 *  3. the slot is foreign / unknown / not classified at all -> incompatible
 *  4. otherwise                             -> verified, or unverified + warnings
 *
 * Rule 3 is not redundant with rule 2: a slot carrying another tool's markers
 * means somebody already wrote there, which a text search over `lib/main.js`
 * cannot reveal on its own.
 *
 * Never throws. Anything unexpected is treated as "not identified", never as
 * permission.
 *
 * @param {{
 *   version?: unknown,
 *   classification?: { state?: unknown, reason?: unknown, length?: unknown, sha256?: unknown }|null,
 *   mainText?: unknown,
 * }} input
 * @returns {SupportAssessment} plain, JSON-serializable
 */
export function assessSupport(input) {
  const { version, classification, mainText } = normalizeInput(input);
  const knownVersion = shellFacts(version) !== null;

  try {
    // The verdict always names the layout it looked at, including the refusals —
    // a caller must be able to print "which layout was on disk" without
    // reconstructing it from `level`.
    const layout = classification !== null && typeof classification.layout === 'string'
      ? classification.layout
      : 'pristine';

    // Rule 1: without the official text there is no way to prove the body will
    // compile, and the body is the one thing that must not fail at startup.
    if (typeof mainText !== 'string' || mainText.length === 0) {
      return {
        allowed: false,
        level: 'incompatible',
        version,
        knownVersion,
        slotLengthFamiliar: false,
        slotShaFamiliar: false,
        layout,
        missingDependencies: [...PATCH_DEPENDENCIES],
        warnings: [UNREADABLE_MAIN_WARNING],
        summary: '读不到官方 main.js，拒绝写入',
      };
    }

    // Rule 2: a name the body needs is gone from the official file.
    const missingDependencies = missingPatchDependencies(mainText);
    if (missingDependencies.length > 0) {
      return {
        allowed: false,
        level: 'incompatible',
        version,
        knownVersion,
        slotLengthFamiliar: false,
        slotShaFamiliar: false,
        layout,
        missingDependencies,
        warnings: [`官方 main.js 里已经没有补丁需要的名字：${missingDependencies.join('、')}（补丁会在启动时崩，拒绝写入）`],
        summary: '官方 main.js 缺少补丁需要的名字，拒绝写入',
      };
    }

    // Rule 3: the slot is in neither state this package understands. A missing
    // classification counts as "not identified" — reading never becomes writing.
    const state = classification === null ? undefined : classification.state;
    if (state !== 'stock' && state !== 'patched-by-us') {
      const reason = classification !== null && typeof classification.reason === 'string' && classification.reason.length > 0
        ? classification.reason
        : UNIDENTIFIED_ASAR_WARNING;
      // A double install (0.1.x patch inside the slot AND our 0.2.0 region after
      // it) is also reported as `foreign`, but its reason is about OUR TWO
      // layouts, not about another tool — say which, or the human goes looking for
      // a tool that does not exist.
      const doubleInstall = classification !== null && classification.doubleInstall === true;
      return {
        allowed: false,
        level: 'incompatible',
        version,
        knownVersion,
        slotLengthFamiliar: false,
        slotShaFamiliar: false,
        layout: classification !== null && typeof classification.layout === 'string' ? classification.layout : 'pristine',
        missingDependencies: [],
        warnings: [reason],
        // The summary names the level, not the detail: a foreign slot and an
        // unreadable one are both "we must not write", and the warning above
        // carries the specific reason.
        summary: doubleInstall
          ? '槽位内补丁与槽位后的自有区域同时存在（重复安装），请先还原成官方原样'
          : state === 'foreign' ? '托盘槽位被其他工具改过，拒绝写入' : UNIDENTIFIED_ASAR_WARNING,
      };
    }

    // Rule 4: writable. The remaining question is only how loudly to warn.
    //
    // The `layout` dimension (added for the 0.2.0 split layout) decides WHAT has
    // to be verified:
    //   - 'pristine'  the official slot is still stock, so the slot digest proves it;
    //   - 'in-slot'   our 0.1.x patch replaced the slot, so the slot digest is OURS
    //                 and `matchesExpectedPatch` is the proof;
    //   - 'split'     the official slot is PRISTINE and our region sits after it,
    //                 so slot length AND digest stay the stock ones — the layout
    //                 itself means "we are here", and `matchesExpectedPatch` proves
    //                 the REGION's bytes are what this build produces.
    const slotLength = typeof classification.length === 'number' ? classification.length : null;
    const slotSha = typeof classification.sha256 === 'string' && classification.sha256.length > 0
      ? classification.sha256
      : null;
    // A slot we patched ourselves carries OUR digest, not the stock one, so a
    // digest-only test would call every healthy installed machine "unverified"
    // forever. `matchesExpectedPatch` (from the classifier) is the honest answer
    // for that state: the bytes are exactly what this build produces for this
    // measured length, which is a stronger fact than "matches a stock digest".
    //
    // For the split layout the same reasoning applies to the REGION rather than
    // the slot: the slot really is stock (and is checked as stock below), while
    // "the bytes we inserted are exactly the bytes this build produces" is what
    // `matchesExpectedPatch` answers.
    const slotLengthFamiliar = slotLength === null ? false : FAMILIAR_SLOT_LENGTHS.includes(slotLength);
    const slotShaFamiliar = state === 'patched-by-us'
      ? classification.matchesExpectedPatch === true
      : slotSha === null ? false : FAMILIAR_SLOT_SHA256S.includes(slotSha);

    if (knownVersion && slotLengthFamiliar && slotShaFamiliar) {
      return {
        allowed: true,
        level: 'verified',
        version,
        knownVersion: true,
        slotLengthFamiliar: true,
        slotShaFamiliar: true,
        layout,
        missingDependencies: [],
        warnings: [],
        summary: '这个版本已经验证过',
      };
    }

    // Unverified: install anyway, but name every fact that is new. Each warning
    // stands on its own so a release that only bumped the version is not buried
    // under "unknown slot" lines it does not deserve.
    const warnings = [];
    if (!knownVersion) {
      warnings.push(`这个 DSH 版本（${labelOf(version)}）没有登记过；托盘槽位结构看起来一致，可以安装，但装完请确认托盘菜单正常`);
    }
    if (!slotLengthFamiliar) {
      warnings.push(
        `托盘槽位长度是 ${slotLength === null ? '未知' : slotLength} 字节，本插件只端到端验证过 ${FAMILIAR_SLOT_LENGTHS.join('、')} 字节；可以安装，但装完请确认托盘菜单正常`,
      );
    }
    if (!slotShaFamiliar) {
      // The shape of the fact differs per layout, and saying the wrong one would
      // send the reader looking at the wrong bytes.
      if (layout === 'split') {
        warnings.push(
          '槽位之后的自有区域内容与本次构建产出的不一致（可能是旧版补丁或被手工改过）；可以安装，'
          + '装完请确认托盘菜单正常',
        );
      } else {
        warnings.push(
          `托盘槽位内容与登记过的官方版本不同（${shortDigest(slotSha)}），可能官方改过这段代码；可以安装，但装完请确认托盘菜单正常`,
        );
      }
    }

    return {
      allowed: true,
      level: 'unverified',
      version,
      knownVersion,
      slotLengthFamiliar,
      slotShaFamiliar,
      layout,
      missingDependencies: [],
      warnings,
      summary: '这个版本没有验证过，可以安装但需要装后确认',
    };
  } catch {
    // Defensive: the contract says "never throw", and a caller cannot tell a
    // thrown TypeError from a real failure. Refuse, and say so.
    return {
      allowed: false,
      level: 'incompatible',
      version,
      knownVersion,
      slotLengthFamiliar: false,
      slotShaFamiliar: false,
      layout: 'unknown',
      missingDependencies: [...PATCH_DEPENDENCIES],
      warnings: [UNIDENTIFIED_ASAR_WARNING],
      summary: UNIDENTIFIED_ASAR_WARNING,
    };
  }
}
