/**
 * Installer CLI for the asar bridge.
 *
 * Run from the package root (`pkg/`):
 *
 *   node scripts/install.mjs --status  [--root <installRoot>] [--json]
 *   node scripts/install.mjs --dry-run [--root <installRoot>] [--json]
 *   node scripts/install.mjs --apply   [--root <installRoot>] [--json]
 *   node scripts/install.mjs --restore [--root <installRoot>] [--json]
 *   node scripts/install.mjs --scan    [--json]
 *
 * Modes are mutually exclusive and read-only unless stated:
 *   --status   what is on disk right now (ascii sha, region offset/length/hash,
 *              layout, classification, backup presence, bridge presence)
 *   --dry-run  the same read-only facts plus the exact write plan
 *   --apply    layout-driven: on a stock archive it inserts our own 0.2.0 region
 *              after the pristine official tray slot (baseline first), on a 0.1.x
 *              in-slot install it restores the official bytes and then does the
 *              same, and on an existing split install it refreshes without moving
 *              a single byte; then the bridge copy and the record
 *   --restore  undo WHICHEVER layout is on disk: the split region is reversed by
 *              arithmetic (no backup needed), the 0.1.x slot patch by restoring
 *              the baseline; then bridge removal + flow marker
 *   --scan     find DSH desktop install roots on every drive
 *
 * The `layout` dimension ('pristine' | 'in-slot' | 'split') is what selects the
 * branch. `state` describes the OFFICIAL tray slot, and a healthy 0.2.0 install
 * leaves that slot pristine — so `state` alone would call an installed machine
 * "stock" and pick the wrong path.
 *
 * Exit codes: 0 = success, 2 = refused (state does not allow the action),
 * 1 = usage or internal error. With `--json` stdout carries exactly one JSON
 * object and nothing else, because the Host spawns this script and parses it.
 *
 * Plain Node only (no `original-fs`): this CLI may run under the Electron
 * runtime when the Host spawns it, and it must keep working there.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from '../lib/fs-safe.js';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLUGIN_VERSION,
  ASAR_RELATIVE_PATH,
  BRIDGE_RELATIVE_PATH,
  REGION_LENGTH,
  REGION_RESERVE_BYTES,
  MAIN_RELATIVE_PATH,
  BACKUP_KEEP_LIMIT,
} from '../lib/wire/constants.js';
import { ERROR_CODES, FrameworkError, toFailure } from '../lib/wire/errors.js';
import { sha256Buffer, sha256File } from '../lib/asar/hash.js';
import { absoluteOffsetOf, closeAsar, entryInfo, openAsar, readEntryText } from '../lib/asar/reader.js';
import { classifyAsar } from '../lib/asar/classify.js';
import { locateRegion, verifyRegion } from '../lib/asar/region.js';
import {
  findSplitRegion,
  growRegion,
  planSplitFile,
  shrinkRegion,
  verifySplit,
} from '../lib/asar/split.js';
import { canRestoreInPlace, findBackup, restoreFromBackup } from '../lib/install/backup.js';
import { ensureBaselineBackup } from '../lib/install/baseline.js';
import { pruneBackups } from '../lib/install/retention.js';
import { assessSupport } from '../lib/host/compat.js';
import {
  appendAudit,
  appendEditJournal,
  ensureStateDir,
  readEditJournal,
  readInstallRecord,
  stateDirOf,
  writeEditJournal,
  writeInstallRecord,
  writeUninstallFlow,
} from '../lib/install/record.js';
import { scanInstallRoots } from '../lib/scan/scan.js';
import { normalizeInputPath, normalizeInstallRoot } from '../lib/scan/resolve.js';
import { buildSplitRegion, PATCH_MARKER } from '../lib/asar/patch-body.js';
import {
  applyAppend,
  applyRemove,
  planEditFile,
  proveReversal,
  undoEdits,
  undoRemove,
  verifyRecord,
} from '../lib/asar/edit.js';
import { classifyInstall, countBackups } from '../lib/host/state.js';

/** Package root: `pkg/` — this file lives in `pkg/scripts/`. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Derive the package root by searching upward instead, so a differently nested
 * copy still finds its own `bridge/dist/tray-bridge.js`.
 *
 * @returns {string}
 */
function bridgePathForPackage() {
  return join(PACKAGE_ROOT, 'bridge', 'dist', 'tray-bridge.js');
}

/** Exit codes understood by the Host and by humans. */
const EXIT = { OK: 0, USAGE: 1, REFUSED: 2 };

/**
 * Message for the one `foreign` case that is OUR OWN doing: a 0.1.x in-slot
 * patch inside the official slot AND a 0.2.0 region right after it.
 *
 * The classifier already refuses to write, and its `reason` explains the state;
 * this string exists because that refusal has to end with an ACTION for a human
 * ("open docs/RESTORE-STOCK.md and get the official bytes back"), and a machine
 * consumer reads `doubleInstall` to tell this apart from a third-party tool.
 */
const DOUBLE_INSTALL_MESSAGE = '这个 asar 里同时有 0.1.x 的槽位内补丁和 0.2.0 的自有区域（重复安装），'
  + '两种布局不能叠加（哪一份 DesktopTray 生效取决于源码顺序），拒绝再次写入；'
  + '请按 docs/RESTORE-STOCK.md 先把 asar 还原成官方原样，再只装一种布局';

/**
 * Human label for a layout, used by `--status` and by every human rendering.
 *
 * The four labels are deliberately short: they answer "which of our layouts is on
 * disk" without making a human parse `state`, which cannot answer it on its own
 * (a healthy split install reports `stock` for the OFFICIAL slot).
 *
 * @param {string|null|undefined} layout
 * @param {boolean} [doubleInstall]
 * @returns {string}
 */
export function layoutLabel(layout, doubleInstall = false) {
  if (doubleInstall === true) return '重复安装（需还原）';
  if (layout === 'split') return '官方槽位 + 自有区域 0.2.0';
  if (layout === 'in-slot') return '槽位内补丁 0.1.x';
  if (layout === 'pristine') return '官方原样';
  return '无法识别（拒绝写入）';
}

/** Every argv flag this CLI accepts. */
const FLAG_MODES = {
  '--status': 'status',
  '--dry-run': 'dry-run',
  '--apply': 'apply',
  '--restore': 'restore',
  '--scan': 'scan',
  /**
   * Read-only proof that the edit journal can be reversed.
   *
   * A MODE rather than a flag on `--status` on purpose: the proof hashes the
   * whole 209 MB archive (twice, in the worst case), and a status snapshot that
   * suddenly cost a second would be the kind of guard that gets removed.
   */
  '--verify-edits': 'verify-edits',
};

/**
 * Parse argv into `{ mode, root, json, edit, content, contentFile }`.
 *
 * The edit flags (`--append` / `--remove` / `--repoint` / `--edit`) are NOT modes:
 * they decorate `--apply`, so "one action from the user's side" stays literally
 * one action — the archive is edited and the bridge/record are refreshed in the
 * same call, and `--restore` is still the single undo.
 *
 * @param {string[]} argv arguments after the script name
 * @returns {{ ok: true, mode: string, root: string|null, json: boolean,
 *   edit: unknown, content: string|null, contentFile: string|null }
 *   | { ok: false, code: string, message: string }}
 */
export function parseArgv(argv) {
  let mode = null;
  let root = null;
  let json = false;
  let edit = null;
  let content = null;
  let contentFile = null;
  /** @type {{ op: string, path: string }|null} */
  let single = null;
  const EDIT_FLAGS = { '--append': 'append', '--remove': 'remove', '--repoint': 'repoint' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    const declared = FLAG_MODES[arg];
    if (declared !== undefined) {
      if (mode !== null) {
        return { ok: false, code: 'EINSTALL_USAGE', message: `一次只能指定一个模式（已经给了 ${mode}）` };
      }
      mode = declared;
      continue;
    }
    if (EDIT_FLAGS[arg] !== undefined) {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        return { ok: false, code: 'EINSTALL_USAGE', message: `${arg} 后面需要跟一个 asar 内的条目路径` };
      }
      if (single !== null || edit !== null) {
        return { ok: false, code: 'EINSTALL_USAGE', message: '一次只能给一个编辑操作（要用多个请用 --edit 的 JSON 数组）' };
      }
      single = { op: EDIT_FLAGS[arg], path: value };
      index += 1;
      continue;
    }
    if (arg === '--edit') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { ok: false, code: 'EINSTALL_USAGE', message: '--edit 后面需要跟一个 JSON（{op,path,content} 或其数组）' };
      }
      if (single !== null || edit !== null) {
        return { ok: false, code: 'EINSTALL_USAGE', message: '一次只能给一个编辑操作/--edit' };
      }
      try {
        edit = JSON.parse(value);
      } catch (error) {
        return {
          ok: false,
          code: 'EINSTALL_USAGE',
          message: `--edit 的 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      index += 1;
      continue;
    }
    if (arg === '--content' || arg === '--content-file') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { ok: false, code: 'EINSTALL_USAGE', message: `${arg} 后面需要跟一段文本/一个文件路径` };
      }
      if (arg === '--content') content = value;
      else contentFile = value;
      index += 1;
      continue;
    }
    if (arg === '--root' || arg === '--install-root') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        return { ok: false, code: 'EINSTALL_USAGE', message: `${arg} 后面需要跟一个安装目录路径` };
      }
      root = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--root=') || arg.startsWith('--install-root=')) {
      const value = arg.slice(arg.indexOf('=') + 1);
      if (value.length === 0) return { ok: false, code: 'EINSTALL_USAGE', message: `${arg} 缺少路径` };
      root = value;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { ok: false, code: 'EINSTALL_USAGE', message: usageText() };
    }
    return { ok: false, code: 'EINSTALL_USAGE', message: `不认识的参数：${arg}\n\n${usageText()}` };
  }
  if (mode === null) {
    return { ok: false, code: 'EINSTALL_USAGE', message: `必须指定一个模式\n\n${usageText()}` };
  }
  if (mode !== 'apply' && mode !== 'dry-run' && (single !== null || edit !== null)) {
    return {
      ok: false,
      code: 'EINSTALL_USAGE',
      message: `编辑操作要跟 --apply（写入）或 --dry-run（只看计划）一起用；--restore 会自动撤回已有编辑，不需要再指定编辑`,
    };
  }
  if (single !== null) {
    const request = { op: single.op, path: single.path };
    if (contentFile !== null) request.contentFile = contentFile;
    else if (content !== null) request.content = content;
    edit = request;
  } else if (content !== null || contentFile !== null) {
    return { ok: false, code: 'EINSTALL_USAGE', message: '--content/--content-file 必须和 --append/--repoint 一起用' };
  }
  return { ok: true, mode, root, json, edit, content, contentFile };
}

/** The help text shown for `--help` and for usage errors. */
export function usageText() {
  return [
    '用法：node scripts/install.mjs --status|--dry-run|--apply|--restore|--verify-edits|--scan [--root <安装目录>] [--json]',
    '  --status        只读：现状（asar 哈希、槽位偏移/长度/哈希、布局、分类、备份、桥、编辑日志）',
    '  --dry-run       只读：现状 + 按布局写出真实写入计划（带编辑时一并给出编辑计划）',
    '  --apply         写：官方原样 → 备份后插入自有区域；0.1.x → 先还原官方字节再插入；已装 split → 零搬移刷新',
    '  --restore       写：先撤回编辑日志里的追加/重指向（算术可证），再按布局还原（split 反向手术，0.1.x 用备份）',
    '  --verify-edits  只读：证明编辑日志能被算术撤回（哈希整档，不写任何字节）',
    '  --scan          只读：扫描所有盘找 DSH 桌面安装根目录',
    '',
    '编辑（只在 --apply / --dry-run 上生效；--restore 自动撤回，无需再指定）：',
    '  --append <asar 内路径> --content <文本> | --content-file <本地文件>',
    '  --repoint <asar 内路径> --content <文本> | --content-file <本地文件>',
    '  --remove <asar 内路径>',
    '  --edit <JSON>   {op,path,content}| {op,path,base64}| 上面这些的数组（多步一次性写入）',
    '',
    '删除的前置条件：必须有一份**校验过的官方原样备份**（--remove 会在删前重新校验它的 sha256）。',
    '追加/重指向不需要备份：它们不改动已有字节，撤回是算术。',
  ].join('\n');
}

/**
 * Resolve the install root: explicit flag, then the install record, then the
 * environment variable. Never guesses.
 *
 * A human may pass the `resources` directory, the archive itself, or any folder
 * inside `resources`; every shape is normalized to the directory that directly
 * contains `resources\app.asar`, because that is the only shape this CLI writes.
 *
 * @param {string|null} explicit
 * @param {string} stateDir
 * @returns {string|null}
 */
export function resolveRoot(explicit, stateDir) {
  let given = null;
  if (typeof explicit === 'string' && explicit.length > 0) {
    given = normalizeInputPath(explicit);
  } else {
    const record = readInstallRecord(stateDir);
    if (record !== null && typeof record.installRoot === 'string' && record.installRoot.length > 0) {
      given = record.installRoot;
    } else {
      const fromEnv = process.env.DSH_DESKTOP_INSTALL_ROOT;
      if (typeof fromEnv === 'string' && fromEnv.length > 0) given = fromEnv;
    }
  }
  if (given === null || given.length === 0) return null;
  return normalizeInstallRoot(given);
}

/**
 * Absolute path of `resources/app.asar` under an install root.
 *
 * @param {string} root
 * @returns {string}
 */
export function asarPathOf(root) {
  return join(root, ...ASAR_RELATIVE_PATH.split('/'));
}

/**
 * Absolute path of the bridge file under an install root.
 *
 * @param {string} root
 * @returns {string}
 */
export function bridgePathOf(root) {
  return join(root, ...BRIDGE_RELATIVE_PATH.split('/'));
}

/**
 * The edit journal as classification wants it: just the paths it says are ours.
 *
 * `null` when there is no journal, so `classifyAsar` falls back to the archive
 * itself (a path under {@link EDIT_OWNED_ROOT} is ours even without a journal —
 * see `describeEdits`).
 *
 * @param {object|null} journal result of `readEditJournal`
 * @returns {{ paths: string[], baseSha: string|null }|null}
 */
export function summarizeEditJournal(journal) {
  if (journal === null || typeof journal !== 'object' || !Array.isArray(journal.records)) return null;
  const paths = [];
  for (const record of journal.records) {
    if (record === null || typeof record !== 'object') continue;
    if (record.kind === 'append' && typeof record.path === 'string') paths.push(record.path);
    if (record.kind === 'repoint' && typeof record.path === 'string') paths.push(record.path);
    if (record.kind === 'remove' && typeof record.path === 'string') paths.push(record.path);
  }
  return {
    paths,
    baseSha: journal.base !== null && typeof journal.base === 'object' && typeof journal.base.sha256 === 'string'
      ? journal.base.sha256
      : null,
  };
}

/**
 * Read-only facts about one install root. Never writes.
 *
 * @param {string} root
 * @param {{ withRegion?: boolean }} [options]
 * @returns {{ ok: true, root: string, asarPath: string, asarSha: string, dshVersion: string|null,
 *   state: string, reason: string, compat: import('../lib/host/compat.js').SupportAssessment,
 *   regionLengthIsFamiliar: boolean|null, region: object|null, backup: object|null,
 *   bridge: object|null, fileSize: number, mainEntry: object|null }
 *   | { ok: false, code: string, message: string }}
 */
export async function inspect(root, options = {}) {
  const asarPath = asarPathOf(root);
  if (!existsSync(asarPath)) {
    return {
      ok: false,
      code: ERROR_CODES.EINSTALL_ROOT,
      message: `这个目录里没有 ${ASAR_RELATIVE_PATH}：${root}`,
    };
  }

  const opened = openAsar(asarPath, { allowStaleMainIntegrity: true });
  if (opened.ok !== true) {
    return { ok: false, code: opened.code ?? ERROR_CODES.EASAR_HEADER, message: opened.message };
  }

  try {
    const stateDir = stateDirOf(process.env);
    const classification = classifyAsar(opened, { edits: summarizeEditJournal(readEditJournal(stateDir)) });
    const pkgText = readEntryText(opened, 'package.json');
    let dshVersion = null;
    let dshName = null;
    if (pkgText !== null) {
      try {
        const pkg = JSON.parse(pkgText);
        if (typeof pkg.version === 'string') dshVersion = pkg.version;
        if (typeof pkg.name === 'string') dshName = pkg.name;
      } catch { /* version stays null */ }
    }

    const asarSha = await sha256File(asarPath);
    const located = options.withRegion === false ? null : locateRegion(opened);
    const region = located !== null && located.ok === true
      ? {
        startInMain: located.startInMain,
        absoluteOffset: located.absoluteOffset,
        length: located.length,
        sha256: located.sha256,
      }
      : null;
    // The OTHER detector: our own 0.2.0 region, which the official slot cannot
    // report because it sits AFTER it. Null for the two layouts that have none.
    const splitLocated = findSplitRegion(opened);
    const splitRegion = splitLocated.ok === true
      ? {
        startInMain: splitLocated.startInMain,
        endInMain: splitLocated.endInMain,
        absoluteOffset: splitLocated.absoluteOffset,
        length: splitLocated.length,
        sha256: splitLocated.sha256,
      }
      : null;
    // The locator already measured the slot and knows whether its length is one
    // this package was built for; never ask it twice.
    const regionLengthIsFamiliar = located !== null && located.ok === true
      ? located.lengthIsFamiliar === true
      : null;

    // Release check: may this installer write here at all, and must it warn?
    // Computed from the same three inputs the Host uses (see lib/host/compat.js)
    // so the CLI and the install page can never disagree.
    const mainText = readEntryText(opened, MAIN_RELATIVE_PATH);
    const compat = assessSupport({ version: dshVersion, classification, mainText });

    const backup = await findBackup(asarPath);
    const bridgePath = bridgePathOf(root);
    let bridge = null;
    if (existsSync(bridgePath)) {
      const info = statSync(bridgePath);
      bridge = { path: bridgePath, size: info.size, sha256: await sha256File(bridgePath) };
    }

    const mainInfo = entryInfo(opened, MAIN_RELATIVE_PATH);

    return {
      ok: true,
      root,
      asarPath,
      asarSha,
      dshVersion,
      dshName,
      state: classification.state,
      // Which of our two layouts is on disk. `state` alone cannot answer "is
      // anything installed" any more: a healthy split archive reports `stock`
      // for the OFFICIAL slot, because that slot really is pristine.
      layout: classification.layout ?? 'unknown',
      // A double install (0.1.x in the slot AND our 0.2.0 region after it) is
      // reported as `foreign`, but it is OUR doing — the flag lets the refusal
      // say "both layouts" instead of "another tool".
      doubleInstall: classification.doubleInstall === true,
      matchesExpectedPatch: classification.matchesExpectedPatch === true,
      reason: classification.reason,
      classification,
      compat,
      regionLengthIsFamiliar,
      region,
      splitRegion,
      locator: located,
      backup: backup.ok === true
        ? { name: backup.backupPath.split(/[\\/]/).pop(), path: backup.backupPath, size: backup.size, sha256: backup.sha256 }
        : null,
      bridge,
      fileSize: opened.fileSize,
      dataStart: opened.dataStart,
      entries: opened.entries.size,
      mainEntry: mainInfo === null ? null : { size: mainInfo.size, offset: mainInfo.offset },
      // Directory edits this package performed (journal), and whether the archive
      // itself carries a path under our namespace. Both are reported because they
      // answer different questions: the journal says WHAT to undo, the archive
      // says what is really inside the file right now.
      edits: classification.edited === true,
      editPaths: Array.isArray(classification.editPaths) ? classification.editPaths : [],
      editSource: classification.editSource ?? null,
      editJournal: readEditJournal(stateDirOf(process.env)),
    };
  } finally {
    closeAsar(opened);
  }
}

/**
 * Copy a file atomically: write to a sibling temp file, then rename over the
 * target. The destination directory is created when missing.
 *
 * @param {string} sourcePath
 * @param {string} targetPath
 * @returns {Promise<{ ok: true, path: string, size: number, sha256: string } | { ok: false, code: string, message: string }>}
 */
export async function copyFileAtomic(sourcePath, targetPath) {
  if (!existsSync(sourcePath)) {
    return { ok: false, code: ERROR_CODES.EBRIDGE_COPY, message: `桥源文件不存在：${sourcePath}` };
  }
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    const sourceSha = await sha256File(sourcePath);
    // Stream the copy with a plain read/write loop; bridge files are ~44 KB but
    // the same helper must survive being pointed at something larger.
    const { createReadStream, createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    await pipeline(createReadStream(sourcePath), createWriteStream(tmp));
    const copiedSha = await sha256File(tmp);
    if (copiedSha !== sourceSha) {
      return { ok: false, code: ERROR_CODES.EBRIDGE_COPY, message: '桥复制后哈希与源不一致' };
    }
    renameSync(tmp, targetPath);
    const finalSha = await sha256File(targetPath);
    if (finalSha !== sourceSha) {
      return { ok: false, code: ERROR_CODES.EBRIDGE_COPY, message: '桥落盘后哈希与源不一致' };
    }
    return { ok: true, path: targetPath, size: statSync(targetPath).size, sha256: finalSha };
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    return {
      ok: false,
      code: ERROR_CODES.EBRIDGE_COPY,
      message: `复制桥失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Remove a file if it exists. Never throws.
 *
 * @param {string} path
 * @returns {{ ok: true, removed: boolean } | { ok: false, code: string, message: string }}
 */
export function removeFile(path) {
  try {
    if (!existsSync(path)) return { ok: true, removed: false };
    rmSync(path, { force: true });
    return { ok: true, removed: true };
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.EWRITE_FAILED,
      message: `删除 ${path} 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Append an audit line, swallowing write failures.
 *
 * Auditing must never change the outcome of an install/restore: the state
 * directory may live somewhere the sandbox refuses to create (see the Host's
 * confinement), and a missing log line is worth less than a correct asar.
 * The returned boolean lets a caller report it when it matters.
 *
 * @param {string} stateDir
 * @param {string} action
 * @param {Record<string, unknown>} [data]
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
export function safeAudit(stateDir, action, data = {}) {
  try {
    appendAudit(stateDir, action, data);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof FrameworkError ? error.code : ERROR_CODES.EWRITE_FAILED,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Install record payload written after a successful apply.
 *
 * Which LAYOUT the record describes is now part of the record, not something a
 * later reader has to infer from the digest: a split install leaves the official
 * tray slot byte-for-byte stock, so `asarSha` alone cannot tell a reader whether
 * the bytes contain our region.
 *
 * The two region coordinates are deliberately separate keys:
 *   `regionOffset`/`regionLength`/`patchedRegionSha`
 *       the OFFICIAL tray slot (the 0.1.x in-slot target; for the split layout it
 *       is the pristine neighbour that the region was inserted after);
 *   `splitRegion`
 *       OUR inserted region (0.2.0 only) — what an uninstall shrinks away and
 *       what a refresh rewrites in place.
 *
 * `stockSha` records the digest of the official bytes this machine was migrated
 * from (or installed over), so `--restore` can prove that the archive it just
 * shrunk is the same official build the record remembers, without needing the
 * 209 MB backup to still exist.
 *
 * @param {object} facts result of {@link inspect}
 * @param {object} extra
 * @returns {object}
 */
export function installRecordOf(facts, extra = {}) {
  const split = extra.splitRegion ?? null;
  return {
    schema: 2,
    pluginVersion: PLUGIN_VERSION,
    installRoot: facts.root,
    asarPath: facts.asarPath,
    // Explicit wins over inferred: a stock archive is `pristine` BEFORE the
    // install and `split` after it, so the caller must say which one the record
    // is about.
    layout: extra.layout ?? (split === null ? (facts.layout ?? null) : 'split'),
    asarSha: extra.asarSha,
    patchedRegionSha: extra.patchedRegionSha ?? null,
    regionOffset: facts.region?.absoluteOffset ?? null,
    regionLength: facts.region?.length ?? null,
    splitRegion: split === null
      ? null
      : {
        length: split.length,
        sha256: split.sha256 ?? null,
        startInMain: split.startInMain ?? null,
        absoluteOffset: split.absoluteOffset ?? null,
      },
    /** Which layout the archive had BEFORE this apply (`in-slot` on a migration). */
    layoutBefore: extra.layoutBefore ?? null,
    migrated: extra.migrated === true,
    /** Official (pre-install / pre-migration) bytes, when the caller knows them. */
    stockSha: extra.stockSha ?? null,
    dshVersion: facts.dshVersion,
    dshName: facts.dshName,
    backup: extra.backup ?? null,
    bridge: extra.bridge ?? null,
    installedAt: new Date().toISOString(),
  };
}

/**
 * Digest of a patchable asar's official bytes, as a record names it.
 *
 * Two keys can hold it and they are not equivalent after a migration: `stockSha`
 * is written by 0.2.0 for exactly this purpose, while `backup.sha256` is the
 * digest of the baseline copy (equal to it whenever a backup was written by this
 * plugin, which is the only way one is created). Neither existing is a normal
 * answer, never an error.
 *
 * @param {object|null} record install record read from the state directory
 * @returns {string|null}
 */
export function recordedStockShaOf(record) {
  if (record === null || typeof record !== 'object') return null;
  if (typeof record.stockSha === 'string' && record.stockSha.length > 0) return record.stockSha.toLowerCase();
  const backup = record.backup;
  if (backup !== null && typeof backup === 'object' && typeof backup.sha256 === 'string' && backup.sha256.length > 0) {
    return backup.sha256.toLowerCase();
  }
  return null;
}

/**
 * `--status` / `--dry-run`: read-only report.
 *
 * @param {object} request parsed argv
 * @returns {Promise<object>}
 */
async function runReadOnly(request) {
  const stateDir = stateDirOf(process.env);
  const root = resolveRoot(request.root, stateDir);
  const selfSha = await sha256File(fileURLToPath(import.meta.url)).catch(() => null);
  if (root === null) {
    return {
      ok: true,
      mode: request.mode,
      root: null,
      asarPath: null,
      asarSha: null,
      dshVersion: null,
      state: 'missing',
      layout: 'unknown',
      reason: '还不知道 DSH 桌面装在哪里（用 --root 指定，或先跑一次 --apply）',
      backup: null,
      bridge: null,
      installState: 'never-installed',
      upgraded: false,
      scannedInstallRoots: null,
      pluginVersion: PLUGIN_VERSION,
      selfSha,
    };
  }

  const facts = await inspect(root);
  if (facts.ok !== true) {
    return { ok: true, mode: request.mode, root, asarPath: asarPathOf(root), asarSha: null, dshVersion: null, state: 'missing', layout: 'unknown', reason: facts.message, backup: null, bridge: null, installState: 'never-installed', upgraded: false, pluginVersion: PLUGIN_VERSION, selfSha };
  }

  // This CLI has no Host state object, so it does the same reconciliation itself
  // from the same inputs the Host uses: the install record, the bridge file, the
  // number of backups and the archive size. The rule is delegated to
  // `lib/host/state.js` so the CLI and the install page can never disagree
  // about whether a vendor upgrade "spent" the previous install.
  const record = readInstallRecord(stateDir);
  const bridgePath = bridgePathOf(root);
  const installState = classifyInstall({
    record,
    bridgePresent: existsSync(bridgePath),
    backupCount: countBackups(asarPathOf(root)),
    archiveSize: facts.fileSize,
  });

  const report = {
    ok: true,
    mode: request.mode,
    root: facts.root,
    asarPath: facts.asarPath,
    asarSha: facts.asarSha,
    dshVersion: facts.dshVersion,
    dshName: facts.dshName,
    state: facts.state,
    // Which of our two layouts is on disk, and the label a human reads. `state`
    // alone cannot answer "is anything installed": a healthy split install
    // reports `stock`, because the OFFICIAL slot really is pristine.
    layout: facts.layout,
    layoutLabel: layoutLabel(facts.layout, facts.doubleInstall === true),
    doubleInstall: facts.doubleInstall === true,
    reason: facts.reason,
    compat: facts.compat,
    // Flattened for the UI: whether the install may proceed at all, and every
    // warning the release check produced, without having to dig into `compat`.
    warnings: Array.isArray(facts.compat?.warnings) ? [...facts.compat.warnings] : [],
    installState,
    upgraded: installState === 'spent',
    region: facts.region,
    splitRegion: facts.splitRegion,
    regionLengthIsFamiliar: facts.regionLengthIsFamiliar,
    backup: facts.backup,
    bridge: facts.bridge,
    fileSize: facts.fileSize,
    entries: facts.entries,
    // Directory edits: what the journal says we appended/removed/repointed, what
    // the archive itself contains under our namespace, and the journal document
    // itself (so a support report can name the exact inverse records).
    edited: facts.edits === true,
    editPaths: facts.editPaths,
    editSource: facts.editSource,
    editJournal: facts.editJournal,
    pluginVersion: PLUGIN_VERSION,
    selfSha,
  };

  if (installState === 'spent') {
    report.lastError = {
      code: ERROR_CODES.ESTATE_UPGRADED,
      message: 'DSH 已升级，原来的壳桥和备份都不见了，需要在新版本上重新安装',
    };
  }

  if (request.mode === 'dry-run') {
    const planned = [];
    // The order below is the SAME order `runApply` uses, and the reason is the
    // same: a double install reports `layout: 'split'` AND `state: 'foreign'`,
    // so a layout-first test would plan a "refresh" for a file that must never
    // be touched. The refusal has to win.
    if (facts.state === 'foreign' || facts.state === 'unknown') {
      report.refused = true;
      report.refusalCode = facts.state === 'foreign' ? ERROR_CODES.EFOREIGN_PATCH : ERROR_CODES.EUNKNOWN_LAYOUT;
      report.refusalMessage = facts.doubleInstall === true ? DOUBLE_INSTALL_MESSAGE : facts.reason;
    } else if (facts.layout === 'pristine' && facts.state === 'stock') {
      // The 0.2.0 install on a stock archive: plan the insertion, hold a baseline,
      // grow, verify. (`createOrReuseBackup` names the reuse rule: a verified
      // baseline already on disk is used instead of copying 209 MB again.)
      planned.push('planSplit');
      planned.push('createOrReuseBackup');
      planned.push('growRegion');
      planned.push('verifySplit');
      planned.push('copyBridge');
      planned.push('writeInstallRecord');
      planned.push(`pruneBackups(limit ${BACKUP_KEEP_LIMIT})`);
    } else if (facts.layout === 'split' && facts.splitRegion !== null && facts.splitRegion.length !== REGION_RESERVE_BYTES) {
      // An OLDER reserve (the 8 KiB region is the real-world case): one action,
      // two moves. Does not need a baseline: the shrink is arithmetic and the
      // archive it produces is the baseline before the re-insert.
      planned.push('shrinkRegion');
      planned.push('planSplit');
      planned.push('createOrReuseBackup');
      planned.push('growRegion');
      planned.push('verifySplit');
      planned.push('copyBridge');
      planned.push('writeInstallRecord');
      planned.push(`pruneBackups(limit ${BACKUP_KEEP_LIMIT})`);
    } else if (facts.layout === 'split') {
      // Already installed: NOTHING moves — no baseline work either, because the
      // archive on disk is the installed one, not the official baseline.
      planned.push('copyBridge(refresh)');
      planned.push('rewriteRegion(only if stale)');
      planned.push('writeInstallRecord(refresh)');
      planned.push('appendAudit');
    } else if (facts.layout === 'in-slot') {
      // 0.1.x -> 0.2.0: the official bytes come back first, then the stock plan
      // above runs verbatim (that is why the tail of this list is the same one).
      planned.push('restoreFromBackup');
      planned.push('planSplit');
      planned.push('createOrReuseBackup');
      planned.push('growRegion');
      planned.push('verifySplit');
      planned.push('copyBridge');
      planned.push('writeInstallRecord');
      planned.push('pruneBackups');
    } else {
      // Only shapes with neither `stock` nor `foreign`/`unknown` reach here: an
      // unsupported (layout, state) pair, which is a guess and therefore a
      // refusal.
      report.refused = true;
      report.refusalCode = ERROR_CODES.EUNKNOWN_LAYOUT;
      report.refusalMessage = `无法识别这个 asar 的布局（layout=${facts.layout}，state=${facts.state}）：${facts.reason ?? ''}`;
    }
    // The release check can refuse a state that classifies fine: a version whose
    // `lib/main.js` lost a name the patch body needs would crash at startup. The
    // foreign/unknown branch above already named a more specific reason, so this
    // only fires for states that would otherwise look writable.
    if (report.refused !== true && facts.compat !== undefined && facts.compat.allowed !== true) {
      report.refused = true;
      report.refusalCode = ERROR_CODES.EUNKNOWN_LAYOUT;
      report.refusalMessage = facts.compat.summary;
    }
    // EDITS, when the caller asked for them: the plan must describe them in the
    // same order `--apply` would run them, and must refuse where `--apply` would.
    // A `dry-run` that silently drops the edit half would be worse than no
    // dry-run at all.
    const ops = resolveEditOps(request);
    if (ops.ok !== true) {
      report.refused = true;
      report.refusalCode = ops.code;
      report.refusalMessage = ops.message;
    } else if (ops.ops.length > 0 && report.refused !== true) {
      planned.push('applyEdits');
      for (const op of ops.ops) planned.push(`${op.op}(${op.path})`);
      report.editPlan = ops.ops.map((op) => ({ op: op.op, path: op.path, bytes: op.content === null ? 0 : op.content.length }));
      if (ops.ops.some((op) => op.op === 'remove')) {
        const baseline = editBaselineOf({ record0: record, facts });
        if (baseline === null) {
          report.refused = true;
          report.refusalCode = ERROR_CODES.EBASELINE_REQUIRED;
          report.refusalMessage = '删除需要一份校验过的官方原样备份；这台机器现在没有，--apply 会拒绝删除';
        } else {
          report.editBaseline = { path: baseline.path, sha256: baseline.sha256, size: baseline.size };
        }
      }
      if (facts.layout !== 'split' && facts.layout !== 'pristine') {
        report.refused = true;
        report.refusalCode = ERROR_CODES.EEDIT_LAYOUT;
        report.refusalMessage = `这个 asar 的布局是 ${facts.layout}，目录编辑只在自有 split 布局上做`;
      }
    }
    report.plan = { write: planned, willWrite: planned.length > 0 };
  }

  return report;
}

/**
 * Write `buffer` over an EXACT byte range of the archive, without changing the
 * file's length.
 *
 * This is the "replace the split region in place" primitive: the region keeps
 * the same offset, the same length and the same neighbours, so no directory
 * field and no trailing entry has to move — the one property the layout is
 * built on. `writeRegion` in `lib/asar/region.js` does the same thing for the
 * OFFICIAL slot, but its bounds/wording are about the slot; the split region is
 * a different object (our own, 8 KiB), so the helper lives here rather than
 * being smuggled into the surgery layer.
 *
 * The caller is responsible for having located the range from the file FIRST;
 * this helper re-checks the bounds against the file's current size, so a range
 * measured on a stale archive is refused instead of writing past EOF.
 *
 * @param {string} asarPath
 * @param {number} absoluteOffset absolute byte offset of the range
 * @param {Buffer} buffer replacement bytes
 * @returns {{ ok: true, bytesWritten: number, sha256: string, sizeBefore: number }
 *   | { ok: false, code: string, message: string }}
 */
export function writeBytesInPlace(asarPath, absoluteOffset, buffer) {
  if (typeof asarPath !== 'string' || asarPath.length === 0) {
    return { ok: false, code: ERROR_CODES.EINVALID_INPUT, message: '没有给出 asar 路径' };
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, code: ERROR_CODES.EINVALID_INPUT, message: '没有给出要写入的区域内容' };
  }
  if (!Number.isInteger(absoluteOffset) || absoluteOffset < 0) {
    return { ok: false, code: ERROR_CODES.EINVALID_INPUT, message: `区域绝对偏移非法：${absoluteOffset}` };
  }

  let sizeBefore;
  try {
    sizeBefore = statSync(asarPath).size;
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.EASAR_MISSING,
      message: `打不开 asar：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (absoluteOffset + buffer.length > sizeBefore) {
    return {
      ok: false,
      code: ERROR_CODES.EWRITE_FAILED,
      message: `区域区间越界：${absoluteOffset}+${buffer.length} 超过文件 ${sizeBefore} 字节`,
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
    try { fsyncSync(fd); } catch { /* durability nicety only */ }
    const afterSize = statSync(asarPath).size;
    if (afterSize !== sizeBefore) {
      return {
        ok: false,
        code: ERROR_CODES.EWRITE_FAILED,
        message: `原位改写后文件长度变了：${afterSize} != ${sizeBefore}（split 区域必须等长替换）`,
      };
    }
    return { ok: true, bytesWritten: written, sha256: sha256Buffer(buffer), sizeBefore };
  } catch (error) {
    return {
      ok: false,
      code: ERROR_CODES.EWRITE_FAILED,
      message: `原位改写区域失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Copy the bridge, write the record, and build the parts every successful apply
 * shares (prune + audit are done by the caller, because the stock and the
 * refresh paths treat them differently).
 *
 * @param {{ stateDir: string, root: string, bridgeSrc: string, facts: object, extra: object }} input
 * @returns {Promise<{ ok: true, copied: object, record: object, asarShaAfter: string } | { ok: false, code: string, message: string, exitCode: number }>}
 */
async function finishApply(input) {
  const copied = await copyFileAtomic(input.bridgeSrc, bridgePathOf(input.root));
  if (copied.ok !== true) {
    return {
      ok: false,
      code: copied.code ?? ERROR_CODES.EBRIDGE_COPY,
      message: input.extra.bridgeFailureSuffix === undefined
        ? copied.message
        : `${copied.message}${input.extra.bridgeFailureSuffix}`,
      exitCode: EXIT.REFUSED,
    };
  }
  const asarShaAfter = await sha256File(input.facts.asarPath);
  const record = installRecordOf(input.facts, {
    ...input.extra.record,
    asarSha: asarShaAfter,
    bridge: { path: copied.path, sha256: copied.sha256, size: copied.size },
  });
  writeInstallRecord(input.stateDir, record);
  return { ok: true, copied, record, asarShaAfter };
}

/**
 * Retention after a stock install: keep at most BACKUP_KEEP_LIMIT copies and
 * never delete the baseline the record now names.
 *
 * Only runs when a NEW full copy was just written (`reused === false`): a reused
 * baseline means nothing grew, and pruning then could delete an older-but-still
 * recorded baseline for no reason at all. A prune failure is reported, never
 * fatal — the archive is already written by this point, so failing the install
 * because an old `.bak` could not be deleted would be exactly backwards.
 *
 * @param {string} asarPath
 * @param {{ reused: boolean, backup: object }} baseline
 * @returns {Promise<object|null>}
 */
async function pruneAfterInstall(asarPath, baseline) {
  if (baseline.reused !== true) {
    try {
      const pruned = await pruneBackups(asarPath, { protectSha256: baseline.backup.sha256 });
      return pruned.ok === true
        ? {
          ok: true,
          limit: pruned.limit,
          total: pruned.total,
          removed: pruned.removed.map((entry) => entry.name),
          kept: pruned.kept.map((entry) => entry.name),
          skipped: pruned.skipped,
        }
        : { ok: false, code: pruned.code, message: pruned.message };
    } catch (error) {
      return {
        ok: false,
        code: ERROR_CODES.EWRITE_FAILED,
        message: `清理旧备份失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return null;
}

/**
 * The v0.2.0 INSTALL: grow `lib/main.js` by exactly `REGION_RESERVE_BYTES` right
 * after the pristine official tray slot, then verify the whole geometry.
 *
 * Order matters and is the reverse of the 0.1.x path:
 *   1. PLAN first — a plan refusal is a real refusal and is never downgraded to
 *      the in-slot layout (the two layouts must not both be reachable from one
 *      state);
 *   2. BACKUP before any surgery — `growRegion` is NOT atomic by construction
 *      (see the note at the top of `lib/asar/split.js`), so a crash between the
 *      data move and the directory rewrite is recovered from the baseline;
 *   3. `buildSplitRegion(plan.reserve)`, `growRegion`, `verifySplit`;
 *   4. only then the bridge, the record and the housekeeping.
 *
 * @param {{ stateDir: string, root: string, facts: object, bridgeSrc: string,
 *   warnings: string[], migration: { backupName: string, layoutBefore: string } | null,
 *   origin?: { layoutBefore: string, reserveBefore: number, removedRegionBytes: number } | null }} input
 * @returns {Promise<{ body: object, exitCode: number }>}
 */
async function installSplit(input) {
  const { stateDir, root, facts, bridgeSrc, warnings } = input;
  const asarPath = facts.asarPath;
  const migrated = input.migration !== null;
  const migrationBackup = input.migration === null ? null : input.migration.backupName;
  // WHERE THIS INSTALL CAME FROM. Two callers reach this function with an
  // earlier layout: `migrateInSlot` (a 0.1.x in-slot patch, with a backup) and
  // `regrowSplit` (an older split reserve, reversed by arithmetic). The record
  // and the audit line have to name it, or a support report cannot tell a first
  // install from an upgrade.
  const origin = input.origin !== undefined && input.origin !== null ? input.origin : null;
  const layoutBefore = origin !== null
    ? origin.layoutBefore
    : (input.migration === null ? null : input.migration.layoutBefore);
  const reserveBefore = origin === null ? null : origin.reserveBefore;

  // 1. Plan (read-only). The reserve is this package's, not the archive's: the
  //    plan measures what the header can afford and refuses if it cannot.
  const plan = planSplitFile(asarPath, REGION_RESERVE_BYTES);
  if (plan.ok !== true) {
    safeAudit(stateDir, 'apply-refused-plan', {
      root,
      code: plan.code,
      message: plan.message,
      layout: facts.layout,
      dshVersion: facts.dshVersion,
    });
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: plan.code ?? ERROR_CODES.EREGION_LENGTH,
        message: plan.message,
        root,
        asarPath,
        state: facts.state,
        layout: facts.layout,
        reserveLimit: plan.reserveLimit ?? null,
      },
    };
  }
  // A stock archive whose plan says "already present" would mean the classifier
  // and the surgery layer disagree; refuse rather than write twice.
  if (plan.regionAlreadyPresent === true) {
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.EREGION_PRESENT,
        message: '检测说这是官方原样，但写入计划说 split 区域已经存在：两者不一致，拒绝写入（请重跑 --status 复核）',
        root,
        asarPath,
        state: facts.state,
        layout: facts.layout,
      },
    };
  }

  // An unfamiliar slot length is not a refusal (it is measured, not assumed) but
  // it is untested, so it joins the release-check warnings on the way out.
  if (plan.slot !== undefined && plan.slot !== null && plan.slot.lengthIsFamiliar !== true) {
    warnings.push(`托盘槽位长度是 ${plan.slot.length} 字节（本插件完整验证过 ${REGION_LENGTH} 字节）`);
  }

  // 2. Baseline BEFORE the surgery. The archive's own bytes are the baseline
  //    here: this state is `stock`, i.e. nothing of ours is in the file yet.
  const ensured = await ensureBaselineBackup(asarPath, facts.dshVersion ?? 'unknown', {
    sha256: facts.asarSha,
    size: facts.fileSize,
  });
  if (ensured.ok !== true) return { exitCode: EXIT.REFUSED, body: ensured };
  const backup = ensured.backup;
  const backupReused = ensured.reused === true;
  const backupChecked = ensured.checked;

  // 3. Region bytes, then the surgery.
  let region;
  try {
    region = buildSplitRegion(plan.reserve);
  } catch (error) {
    return {
      exitCode: EXIT.USAGE,
      body: {
        ok: false,
        code: ERROR_CODES.EREGION_LENGTH,
        message: `split 补丁体放不进 ${plan.reserve} 字节：${error instanceof Error ? error.message : String(error)}`,
        root,
        asarPath,
      },
    };
  }
  const regionSha = sha256Buffer(region);

  const grown = await growRegion(asarPath, plan, region);
  if (grown.ok !== true) {
    safeAudit(stateDir, 'apply-grow-failed', {
      root,
      code: grown.code,
      message: grown.message,
      backupPath: backup.path,
    });
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: grown.code ?? ERROR_CODES.EWRITE_FAILED,
        // The surgery is not atomic, so the one thing a human needs is WHERE the
        // official bytes are.
        message: `${grown.message}（备份在 ${backup.path}，可用 --restore 回退）`,
        root,
        asarPath,
        backup,
        state: facts.state,
        layout: facts.layout,
      },
    };
  }

  // 4. Read-back through the framework reader: region digest, official slot
  //    unchanged, tail unchanged, every moved entry readable.
  const verified = verifySplit(asarPath, plan, regionSha);
  if (verified.ok !== true) {
    safeAudit(stateDir, 'apply-verify-failed', {
      root,
      code: verified.code,
      message: verified.message,
      backupPath: backup.path,
    });
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.EWRITE_VERIFY,
        message: `${verified.message}（备份在 ${backup.path}，可用 --restore 回退）`,
        root,
        asarPath,
        backup,
        expected: regionSha,
        actual: verified.regionSha,
      },
    };
  }

  const sizeAfter = statSync(asarPath).size;
  if (sizeAfter !== plan.archiveSizeAfter) {
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.EWRITE_VERIFY,
        message: `插入后 asar 是 ${sizeAfter} 字节，期望 ${plan.archiveSizeAfter}（这是严重错误，请用 --restore 回退；备份在 ${backup.path}）`,
        root,
        asarPath,
        backup,
      },
    };
  }

  // 5. Bridge + record.
  const finished = await finishApply({
    stateDir,
    root,
    bridgeSrc,
    facts,
    extra: {
      bridgeFailureSuffix: `（asar 已插入 split 区域，可用 --restore 回退；备份在 ${backup.path}）`,
      record: {
        layout: 'split',
        layoutBefore,
        migrated,
        // `patchedRegionSha` stays null on purpose: the official slot was never
        // patched here, so claiming a patched slot digest would be a lie.
        patchedRegionSha: null,
        splitRegion: {
          length: plan.regionLength,
          sha256: regionSha,
          startInMain: plan.insertAtInFile,
          absoluteOffset: plan.insertAtAbsolute,
        },
        // The bytes this machine can always be restored to.
        stockSha: facts.asarSha,
        backup,
      },
    },
  });
  if (finished.ok !== true) {
    return { exitCode: finished.exitCode, body: { ok: false, code: finished.code, message: finished.message } };
  }

  // 6. Housekeeping (after the install is already complete on disk).
  const prune = await pruneAfterInstall(asarPath, { reused: backupReused, backup });

  safeAudit(stateDir, 'apply', {
    root,
    asarShaBefore: facts.asarSha,
    asarShaAfter: finished.asarShaAfter,
    layout: 'split',
    layoutBefore,
    // `regrown` marks the ONE-ACTION upgrade (an older reserve reversed and the
    // region inserted again) and carries the reserve it replaced; a first install
    // and a 0.1.x migration report the same fields as null.
    regrown: origin !== null,
    reserveBefore,
    migrated,
    migrationBackup,
    // The official slot: untouched, and that is the point of this layout. It sits
    // immediately BEFORE the insertion point, so its absolute offset is one
    // slot-length below it.
    regionOffset: plan.insertAtAbsolute - plan.slot.length,
    regionLength: plan.slot.length,
    regionSha: plan.slotShaBefore,
    officialSlotStartInMain: plan.slot.startInMain,
    // Our region: what an uninstall removes.
    splitRegionStartInMain: plan.insertAtInFile,
    splitRegionOffset: plan.insertAtAbsolute,
    splitRegionLength: plan.regionLength,
    splitRegionSha: regionSha,
    movedBytes: plan.movingBytes,
    movedEntries: plan.movedEntryCount,
    reserveLimit: plan.reserveLimit ?? null,
    backupPath: backup.path,
    backupReused,
    backupChecked,
    pruneRemoved: prune?.ok === true ? prune.removed.length : 0,
    pruneKept: prune?.ok === true ? prune.kept.length : 0,
    compatLevel: facts.compat?.level ?? null,
    warnings,
    bridgeSha: finished.copied.sha256,
    stateDir,
  });

  return {
    exitCode: EXIT.OK,
    body: {
      ok: true,
      mode: 'apply',
      root: facts.root,
      asarPath,
      asarSha: finished.asarShaAfter,
      dshVersion: facts.dshVersion,
      // Both dimensions, explicitly: `state` describes the OFFICIAL slot (still
      // stock on a healthy split install), `layout` describes which install is on
      // disk. A consumer that reads only `state` would think nothing is installed.
      state: 'patched-by-us',
      layout: 'split',
      layoutBefore,
      regrown: origin !== null,
      reserveBefore,
      migrated,
      migrationBackup,
      compat: facts.compat,
      warnings,
      region: {
        startInMain: plan.slot.startInMain,
        // The official slot ends exactly where our region starts, so its absolute
        // offset is one slot-length below the insertion point.
        absoluteOffset: plan.insertAtAbsolute - plan.slot.length,
        length: plan.slot.length,
        sha256: plan.slotShaBefore,
      },
      splitRegion: {
        startInMain: plan.insertAtInFile,
        absoluteOffset: plan.insertAtAbsolute,
        length: plan.regionLength,
        sha256: regionSha,
      },
      movedBytes: plan.movingBytes,
      movedEntries: plan.movedEntryCount,
      reserveLimit: plan.reserveLimit ?? null,
      archiveSizeBefore: plan.archiveSizeBefore,
      archiveSizeAfter: plan.archiveSizeAfter,
      backup,
      backupReused,
      backupChecked,
      prune,
      bridge: { path: finished.copied.path, sha256: finished.copied.sha256 },
      stateDir,
    },
  };
}

/**
 * The v0.2.0 REFRESH: the region is already there.
 *
 * TWO cases, and the length is what separates them:
 *
 *   existing.length === REGION_RESERVE_BYTES  the common case. Zero movement: the
 *       region is rewritten in place only when its digest differs from what this
 *       build produces for that length (a same-build second `--apply` therefore
 *       touches no byte at all).
 *   existing.length !== REGION_RESERVE_BYTES  an OLDER build's reserve (the 8 KiB
 *       region is the real-world case). The region cannot "grow in place", so
 *       `regrowSplit` puts the official bytes back and does a fresh split install
 *       — ONE `--apply`, one body, both steps inside it.
 *
 * "Already installed" is answered by `planSplitFile`'s REFUSAL, not by planning:
 * the refusal carries `regionAlreadyPresent: true`, the measured
 * `existingRegion`, and `zeroMovement: true`. That refusal is the normal answer
 * here, so it is read as a go-ahead — but the requested reserve is the length
 * ALREADY on disk, so the re-plan also proves "the region has not been resized
 * behind our back" (`zeroMovement` would be false if it had).
 *
 * @param {{ stateDir: string, root: string, facts: object, bridgeSrc: string,
 *   warnings: string[], record0: object|null }} input
 * @returns {Promise<{ body: object, exitCode: number }>}
 */
async function refreshSplit(input) {
  const { stateDir, root, facts, bridgeSrc, warnings, record0 } = input;
  const asarPath = facts.asarPath;
  const existing = facts.splitRegion;
  if (existing === null || existing === undefined) {
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.EREGION_NOT_FOUND,
        message: '检测说这是 split 布局，但读不到区域坐标：拒绝写入（请重跑 --status 复核）',
        root,
        asarPath,
      },
    };
  }

  // THE ONE-ACTION UPGRADE. A region of another length is not "the file changed
  // under us" — it is an older build's reserve, and it is exactly the state a
  // machine sits in between "new plugin code deployed" and "archive migrated".
  // Before this branch existed the only way out was `--restore` + `--apply`, i.e.
  // two manual actions and an intermediate stock archive the user had to know
  // about. `regrowSplit` does both steps inside this call.
  if (existing.length !== REGION_RESERVE_BYTES) {
    return regrowSplit(input);
  }

  // Re-plan at the EXISTING length: the answer must still be "already present,
  // zero movement". Anything else means the file changed after `inspect`.
  const replan = planSplitFile(asarPath, existing.length);
  if (replan.ok === true || replan.regionAlreadyPresent !== true) {
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.EWRITE_VERIFY,
        message: '检测之后 asar 又变了（重新推导写入计划时找不到那个 split 区域），拒绝写入；请重跑 --status 复核',
        root,
        asarPath,
        layout: facts.layout,
      },
    };
  }
  if (replan.zeroMovement !== true) {
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.EREGION_LENGTH,
        message: `文件里的 split 区域是 ${existing.length} 字节，与重新推导的结果不一致（改大小要移动尾部，不在本路径），拒绝写入`,
        root,
        asarPath,
        layout: facts.layout,
      },
    };
  }

  // Same length, same offsets: build what this build produces for that length and
  // compare digests. `buildSplitRegion` throws when the body cannot fit a length
  // an older build may have used — that is a refusal, never a silent skip.
  let expectedRegion;
  try {
    expectedRegion = buildSplitRegion(existing.length);
  } catch (error) {
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.EREGION_LENGTH,
        message: `文件里的 split 区域只有 ${existing.length} 字节，本次构建的补丁体放不下：${error instanceof Error ? error.message : String(error)}`,
        root,
        asarPath,
        layout: facts.layout,
      },
    };
  }
  const expectedSha = sha256Buffer(expectedRegion);
  const needsRewrite = existing.sha256 !== expectedSha;

  let regionRewritten = false;
  let archiveSize = statSync(asarPath).size;
  if (needsRewrite) {
    const written = writeBytesInPlace(asarPath, existing.absoluteOffset, expectedRegion);
    if (written.ok !== true) {
      return {
        exitCode: EXIT.REFUSED,
        body: {
          ok: false,
          code: written.code ?? ERROR_CODES.EWRITE_FAILED,
          message: `${written.message}（原位改写 split 区域失败，可以再跑一次 --apply，或 --restore 还原）`,
          root,
          asarPath,
          layout: facts.layout,
        },
      };
    }
    const verified = verifyRegion(asarPath, existing.absoluteOffset, expectedSha, existing.length);
    if (verified.ok !== true) {
      return {
        exitCode: EXIT.REFUSED,
        body: {
          ok: false,
          code: ERROR_CODES.EWRITE_VERIFY,
          message: `${verified.message}（原位改写后回读不一致，请用 --restore 回退）`,
          root,
          asarPath,
          layout: facts.layout,
          expected: expectedSha,
          actual: verified.actual,
        },
      };
    }
    // The rewrite is length-preserving BY CONSTRUCTION (writeBytesInPlace refuses
    // a length change); assert it anyway, because "zero movement" is the claim.
    archiveSize = statSync(asarPath).size;
    if (archiveSize !== written.sizeBefore) {
      return {
        exitCode: EXIT.REFUSED,
        body: {
          ok: false,
          code: ERROR_CODES.EWRITE_VERIFY,
          message: `原位改写后 asar 大小变了：${archiveSize} != ${written.sizeBefore}（请用 --restore 回退）`,
          root,
          asarPath,
        },
      };
    }
    regionRewritten = true;
  }

  const finished = await finishApply({
    stateDir,
    root,
    bridgeSrc,
    facts,
    extra: {
      bridgeFailureSuffix: '',
      record: {
        layout: 'split',
        layoutBefore: 'split',
        patchedRegionSha: null,
        splitRegion: {
          length: existing.length,
          // The region on disk after this call: rewritten or untouched.
          sha256: expectedSha,
          startInMain: existing.startInMain,
          absoluteOffset: existing.absoluteOffset,
        },
        // Carry the recorded official digest forward: `--restore` needs it to
        // prove that `shrinkRegion` reproduced the bytes this machine came from.
        stockSha: recordedStockShaOf(record0),
        // No new backup was written, so keep naming whatever one exists.
        backup: facts.backup,
      },
    },
  });
  if (finished.ok !== true) {
    return { exitCode: finished.exitCode, body: { ok: false, code: finished.code, message: finished.message } };
  }

  safeAudit(stateDir, 'apply-refresh', {
    root,
    layout: 'split',
    refreshed: true,
    regionRewritten,
    regionShaBefore: existing.sha256,
    regionShaAfter: expectedSha,
    splitRegionSha: expectedSha,
    splitRegionLength: existing.length,
    movedBytes: 0,
    bridgeSha: finished.copied.sha256,
    archiveSize,
    stateDir,
  });

  return {
    exitCode: EXIT.OK,
    body: {
      ok: true,
      mode: 'apply',
      refreshed: true,
      root: facts.root,
      asarPath,
      asarSha: finished.asarShaAfter,
      dshVersion: facts.dshVersion,
      state: 'patched-by-us',
      layout: 'split',
      compat: facts.compat,
      warnings,
      regionRewritten,
      region: {
        startInMain: facts.region?.startInMain ?? null,
        length: facts.region?.length ?? null,
        sha256: facts.region?.sha256 ?? null,
      },
      splitRegion: {
        startInMain: existing.startInMain,
        absoluteOffset: existing.absoluteOffset,
        length: existing.length,
        sha256: expectedSha,
      },
      movedBytes: 0,
      archiveSizeBefore: archiveSize,
      archiveSizeAfter: archiveSize,
      backup: facts.backup,
      backupReused: null,
      backupChecked: 0,
      prune: null,
      bridge: { path: finished.copied.path, sha256: finished.copied.sha256 },
      stateDir,
    },
  };
}

/**
 * The ONE-ACTION layout upgrade: an installed split machine whose region LENGTH
 * differs from this build's reserve gets re-laid-out by a single `--apply`.
 *
 * WHY A REGION CANNOT "GROW IN PLACE"
 * The region is a byte range in the middle of `lib/main.js`. Making it longer
 * means every entry after `lib/main.js` moves — which is what `growRegion` does
 * when the region is NOT there yet. It cannot do it when the region IS there, so
 * `refreshSplit`'s fast path (equal length, zero movement) has nothing to offer
 * a machine holding an older, smaller reserve.
 *
 * WHAT THIS DOES INSTEAD — and why it is safe to do it in one call
 *   1. `shrinkRegion` reverses the insert by arithmetic: the archived geometry
 *      reproduces the official archive byte for byte (the same proof `--restore`
 *      relies on, asserted against the digest the install record remembers).
 *   2. The archive is now OFFICIAL STOCK — a state `--apply` already knows how
 *      to handle — so a fresh split install runs on it (`installSplit`).
 *
 * The intermediate state is a LEGAL state (a pristine, stock archive), not a
 * half-written one: if the process dies between the two steps, the next
 * `--apply` takes the pristine branch and finishes the job. That is the "one
 * action from the user's point of view" property: one call, one body, no
 * `--restore` in between and no manual procedure to know about.
 *
 * The region is now the CURRENT reserve (`REGION_RESERVE_BYTES`), which is
 * exactly what the following stock install produces, so the end geometry is
 * "stock + this build's reserve" — `verifySplit` proves it before the body is
 * reported.
 *
 * @param {{ stateDir: string, root: string, facts: object, bridgeSrc: string,
 *   warnings: string[], record0: object|null }} input
 * @returns {Promise<{ body: object, exitCode: number }>}
 */
async function regrowSplit(input) {
  const { stateDir, root, bridgeSrc, warnings, record0 } = input;
  const asarPath = input.facts.asarPath;
  const existing = input.facts.splitRegion;
  const reserveBefore = existing.length;
  const archiveSizeBefore = statSync(asarPath).size;
  // The digest the record remembers is the SECOND opinion on the shrink (the
  // first is `shrinkRegion`'s own post-shrink read-back): "the bytes came back"
  // and "the bytes are the ones this machine came from" are different claims.
  const expectedStockSha = recordedStockShaOf(record0);

  safeAudit(stateDir, 'apply-regrow-start', {
    root,
    layoutBefore: 'split',
    reserveBefore,
    reserveAfter: REGION_RESERVE_BYTES,
    regionShaBefore: existing.sha256,
    splitRegionOffset: existing.absoluteOffset,
    archiveSizeBefore,
    stateDir,
  });

  // 1. Reverse the insert. No backup needed: the geometry in the file IS the
  //    receipt. A failure here leaves the archive as it was found (every refusal
  //    inside `shrinkRegion` is decided before the first write), so the refusal
  //    message can honestly say "nothing was changed" unless a write started.
  const shrunk = await shrinkRegion(asarPath);
  if (shrunk.ok !== true) {
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: shrunk.code ?? ERROR_CODES.EWRITE_FAILED,
        message: `把旧区域（${reserveBefore} 字节）退回官方字节失败：${shrunk.message}。`
          + '这一步没有完成，asar 未被改动（可以重跑 --apply，或用 --restore 退回官方原样）',
        root,
        asarPath,
        layout: 'split',
        layoutBefore: 'split',
        reserveBefore,
        movedBytes: 0,
      },
    };
  }
  if (expectedStockSha !== null && shrunk.archiveShaAfter !== expectedStockSha) {
    safeAudit(stateDir, 'apply-regrow-digest-mismatch', {
      root,
      reserveBefore,
      expected: expectedStockSha,
      actual: shrunk.archiveShaAfter,
      archiveSizeAfterShrink: shrunk.archiveSizeAfter,
    });
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.EBASELINE_HASH,
        message: `退回后的 asar 摘要是 ${shrunk.archiveShaAfter}，与安装记录里的官方摘要 ${expectedStockSha} 不一致：`
          + '撤回的结果不是这台机器原本的官方字节，拒绝继续（请用 --restore，它会改走备份路线）',
        root,
        asarPath,
        layout: 'pristine',
        layoutBefore: 'split',
        reserveBefore,
        expectedStockSha,
        actualStockSha: shrunk.archiveShaAfter,
        removedRegionBytes: shrunk.removedRegionBytes,
      },
    };
  }

  // 2. Re-inspect: the archive changed (length, layout, digest), so every fact
  //    the stock branch needs has to come from the file, not from `input.facts`.
  const after = await inspect(root);
  if (after.ok !== true) {
    return { exitCode: EXIT.REFUSED, body: { ok: false, code: after.code, message: after.message } };
  }
  if (after.layout !== 'pristine' || after.state !== 'stock') {
    safeAudit(stateDir, 'apply-regrow-not-stock', {
      root,
      layout: after.layout,
      state: after.state,
      reason: after.reason,
      reserveBefore,
    });
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.EBASELINE_HASH,
        message: `撤回旧区域后分类仍不是官方原样（layout=${after.layout}，state=${after.state}，${after.reason}），`
          + '也就是说这个 asar 里的旧区域不是本插件插进去的；请用 --restore 与 docs/RESTORE-STOCK.md 处理',
        root,
        asarPath,
        layout: after.layout,
        state: after.state,
        layoutBefore: 'split',
        reserveBefore,
      },
    };
  }

  // 3. Now it IS the stock branch — the same code path a fresh install uses, so
  //    the end geometry cannot drift from what a first install produces.
  const installed = await installSplit({
    stateDir,
    root,
    facts: after,
    bridgeSrc,
    warnings,
    migration: null,
    origin: { layoutBefore: 'split', reserveBefore, removedRegionBytes: shrunk.removedRegionBytes },
  });
  if (installed.exitCode !== EXIT.OK) return installed;

  return {
    exitCode: EXIT.OK,
    body: {
      ...installed.body,
      // `refreshed` is a STRING here because "how was it refreshed" now has two
      // answers: `true` (equal length, in place, zero movement) and `'regrown'`
      // (old reserve reversed, then inserted again). A consumer that only tested
      // truthiness keeps working; one that needs the distinction has it.
      refreshed: 'regrown',
      regrown: true,
      layoutBefore: 'split',
      reserveBefore,
      reserveAfter: REGION_RESERVE_BYTES,
      removedRegionBytes: shrunk.removedRegionBytes,
      stockShaConfirmed: expectedStockSha !== null,
      // Net effect on the FILE across this call, which is what a human compares
      // with `--status` before and after. The stock size the intermediate step
      // produced stays visible separately.
      archiveSizeBefore,
      archiveSizeAfter: installed.body.archiveSizeAfter,
      stockArchiveSize: shrunk.archiveSizeAfter,
      previousSplitRegion: {
        absoluteOffset: existing.absoluteOffset,
        startInMain: existing.startInMain,
        length: reserveBefore,
        sha256: existing.sha256,
      },
    },
  };
}

/**
 * Migrate a 0.1.x install to the 0.2.0 layout.
 *
 * WHY the restore has to happen first: the split layout's whole premise is "the
 * official slot is byte-for-byte pristine". A 0.1.x archive replaced those bytes,
 * so growing it would stack our region AFTER a slot that is no longer official —
 * exactly the double install the classifier refuses. The official bytes therefore
 * have to come back BEFORE the new region goes in.
 *
 * The user approved this migration explicitly; what has NOT been approved is
 * "write a split region on top of a patched slot", so a missing baseline is a
 * REFUSAL (`ENO_BACKUP`) with the manual procedure named, never a fallback.
 *
 * @param {{ stateDir: string, root: string, facts: object, bridgeSrc: string,
 *   warnings: string[], record0: object|null }} input
 * @returns {Promise<{ body: object, exitCode: number }>}
 */
async function migrateInSlot(input) {
  const { stateDir, root, facts, record0 } = input;
  const asarPath = facts.asarPath;

  // 1. The baseline. The recorded digest outranks "newest wins": after an upgrade
  //    the newest `.bak` may belong to another version.
  const prefer = recordedStockShaOf(record0) ?? undefined;
  const backup = await findBackup(asarPath, prefer === undefined ? {} : { preferSha256: prefer });
  if (backup.ok !== true) {
    safeAudit(stateDir, 'apply-refused-migration', { root, code: backup.code, layout: facts.layout });
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.ENO_BACKUP,
        message: '这是 0.1.x 的槽位内补丁，迁移到 0.2.0 布局必须先用官方字节把槽位还原回来，'
          + `但旁边没有任何可用的 app.asar.*.bak（${backup.message ?? ''}）。`
          + '请按 docs/RESTORE-STOCK.md 用官方安装包手工换回原版 asar，再回来安装；'
          + '本工具不会在已打过补丁的槽位上直接写入 split 区域',
        root,
        asarPath,
        layout: facts.layout,
        layoutBefore: 'in-slot',
        state: facts.state,
      },
    };
  }

  // 2. Restore the official bytes, in place (same size: the 0.1.x patch never
  //    changed the archive's length).
  const inPlace = canRestoreInPlace(asarPath, backup.backupPath);
  const restored = await restoreFromBackup(asarPath, backup.backupPath);
  if (restored.ok !== true) {
    safeAudit(stateDir, 'migration-restore-failed', {
      root,
      code: restored.code,
      mode: inPlace ? 'in-place' : 'size-mismatch',
      backupPath: backup.backupPath,
    });
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: restored.code ?? ERROR_CODES.EWRITE_FAILED,
        message: `迁移前还原官方字节失败：${restored.message}（备份在 ${backup.backupPath}）`,
        root,
        asarPath,
        backup: { name: basename(backup.backupPath), path: backup.backupPath, size: backup.size, sha256: backup.sha256 },
      },
    };
  }

  // The restored bytes must be the official ones. Two proofs, strongest first:
  // the digest the record remembers, then a fresh classification of the file.
  if (prefer !== undefined && restored.restoredSha !== prefer) {
    safeAudit(stateDir, 'migration-digest-mismatch', {
      root,
      expected: prefer,
      actual: restored.restoredSha,
      backupPath: backup.backupPath,
    });
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.EBASELINE_HASH,
        message: `还原出来的 asar 摘要是 ${restored.restoredSha}，与安装记录里的官方摘要 ${prefer} 不一致，拒绝继续（请按 docs/RESTORE-STOCK.md 处理）`,
        root,
        asarPath,
        expectedStockSha: prefer,
        actualStockSha: restored.restoredSha,
      },
    };
  }

  // 3. Re-inspect: the archive changed, so every fact the install branch uses
  //    (digest, size, layout) has to be re-read instead of reused.
  const after = await inspect(root);
  if (after.ok !== true) {
    return { exitCode: EXIT.REFUSED, body: { ok: false, code: after.code, message: after.message } };
  }
  if (after.layout !== 'pristine' || after.state !== 'stock') {
    safeAudit(stateDir, 'migration-not-stock', {
      root,
      layout: after.layout,
      state: after.state,
      backupPath: backup.backupPath,
    });
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.EBASELINE_HASH,
        message: `还原后分类仍不是官方原样（layout=${after.layout}，state=${after.state}，${after.reason}），`
          + `也就是说这份备份不是官方字节；请按 docs/RESTORE-STOCK.md 换回官方 asar（备份在 ${backup.backupPath}）`,
        root,
        asarPath,
        layout: after.layout,
        state: after.state,
      },
    };
  }

  // 4. Now it IS the stock branch, with the migration recorded on the way out.
  return installSplit({
    ...input,
    facts: after,
    warnings: input.warnings,
    migration: { backupName: basename(backup.backupPath), layoutBefore: 'in-slot' },
  });
}

/**
 * The edit-free `--apply`: the four-way layout decision, unchanged.
 *
 * @param {object} request parsed argv
 * @returns {Promise<{ body: object, exitCode: number }>}
 */
async function runApply(request) {
  const ops = resolveEditOps(request ?? {});
  if (ops.ok !== true) {
    return { exitCode: EXIT.USAGE, body: { ok: false, code: ops.code, message: ops.message } };
  }
  return runApplyCore({ ...request, ops: ops.ops, request });
}

/**
 * `--apply` with a NON-EMPTY edit list: every archive edit this package performs
 * goes through here, whether the machine was pristine, in-slot or already split.
 *
 * WHY THE LAYOUT BRANCH RUNS FIRST, THEN THE EDITS:
 * the split surgery moves `lib/main.js` and the trailing entries, and the edit
 * layer's whole premise is "the offsets I recorded stay valid". Running them the
 * other way round would either invalidate the edit's own plan or leave the file
 * in a shape `planSplit` refuses (an appended entry breaks the gapless tail the
 * surgery measures). So: install/refresh first, then edit, all in one `--apply`.
 *
 * @param {{ stateDir: string, root: string, facts: object, bridgeSrc: string,
 *   warnings: string[], record0: object|null, ops: object[] }} input
 * @returns {Promise<{ body: object, exitCode: number }>}
 */
async function applyWithEdits(input) {
  const { stateDir, root, ops, facts } = input;
  const asarPath = facts.asarPath;

  // The layout work is exactly what `runApplyCore` does without edits; it writes
  // the bridge and the record too, so a machine that is not installed yet ends up
  // installed AND edited in this one call.
  const installed = await runApplyCore({ ...input, ops: [], request: {} });
  if (installed.body?.ok !== true) {
    return {
      exitCode: installed.exitCode,
      body: {
        ...installed.body,
        editsRequested: ops.length,
        editsApplied: 0,
        message: `${installed.body?.message ?? ''}（布局这一步没有成功，编辑一个都没有做）`.trim(),
      },
    };
  }

  // The baseline a delete needs: the OFFICIAL bytes this machine came from, as
  // the record (just rewritten by the layout step) names them.
  const record1 = readInstallRecord(stateDir);
  const refreshed = await inspect(root);
  const baseline = editBaselineOf({
    record0: record1,
    facts: refreshed.ok === true ? refreshed : installed.body,
  });

  const journal = readEditJournal(stateDir);
  const skipped = [];
  const scheduled = [];
  for (const op of ops) {
    const known = await alreadyApplied(asarPath, journal, op);
    if (known.already === true) {
      skipped.push({ op: op.op, path: op.path, reason: known.reason ?? '已经做过' });
      continue;
    }
    scheduled.push(op);
  }
  if (scheduled.length === 0) {
    return {
      exitCode: EXIT.OK,
      body: {
        ...installed.body,
        mode: 'apply',
        noopEdits: true,
        editsRequested: ops.length,
        editsApplied: [],
        editsSkipped: skipped,
        message: '编辑已经全部做过，没有写任何字节',
      },
    };
  }

  const edited = await runEdits({ stateDir, root, asarPath, ops: scheduled, baseline });
  if (edited.ok !== true) {
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ...installed.body,
        ok: false,
        code: edited.code,
        message: edited.message,
        layout: installed.body.layout ?? null,
        asarPath,
        editsRequested: ops.length,
        editsApplied: edited.applied.map((item) => ({ op: item.op, path: item.path })),
        editsSkipped: skipped,
        requiresBaseline: edited.requiresBaseline === true,
        planDetail: edited.planDetail ?? null,
        // The layout step DID succeed, so the machine is installed — say so
        // instead of reporting a total failure, or the user would reinstall.
        layoutApplied: true,
        layoutAsarSha: installed.body.asarSha ?? null,
      },
    };
  }

  const after = await inspect(root);
  const asarSha = await sha256File(asarPath);
  // The install record has to name the archive the edits produced, or a later
  // `--restore`'s digest check would compare against a pre-edit file.
  if (record1 !== null && typeof record1 === 'object') {
    writeInstallRecord(stateDir, {
      ...record1,
      asarSha,
      fileSize: statSync(asarPath).size,
      editedAt: new Date().toISOString(),
      editCount: Array.isArray(edited.journal?.records) ? edited.journal.records.length : 0,
    });
  }

  safeAudit(stateDir, 'apply-edit', {
    root,
    asarPath,
    edits: scheduled.map((op) => ({ op: op.op, path: op.path })),
    editsSkipped: skipped.map((item) => ({ op: item.op, path: item.path })),
    archiveSizeAfter: statSync(asarPath).size,
    asarSha,
    journalRecords: Array.isArray(edited.journal?.records) ? edited.journal.records.length : 0,
    baseSha: edited.journal?.base?.sha256 ?? null,
    stateDir,
  });

  return {
    exitCode: EXIT.OK,
    body: {
      ...installed.body,
      ok: true,
      mode: 'apply',
      asarSha,
      asarPath,
      dshVersion: after.ok === true ? after.dshVersion : installed.body.dshVersion,
      // State is unchanged by an edit BY CONSTRUCTION (an appended entry leaves
      // the official slot and lib/main.js alone) — but report it measured, not
      // assumed.
      state: after.ok === true ? after.state : installed.body.state,
      layout: after.ok === true ? after.layout : installed.body.layout,
      edited: true,
      editsRequested: ops.length,
      editsApplied: edited.applied.map((item) => ({
        op: item.op,
        path: item.path,
        entrySize: item.entrySize,
        headerBytes: item.headerBytes,
        headerPaddingBytes: item.headerPaddingBytes,
        blocksDropped: item.blocksDropped,
        movedEntries: item.movedEntries,
        requiresBaseline: item.requiresBaseline,
      })),
      editsSkipped: skipped,
      editJournal: {
        records: Array.isArray(edited.journal?.records) ? edited.journal.records.length : 0,
        base: edited.journal?.base ?? null,
      },
      archiveSizeAfter: statSync(asarPath).size,
      layoutAsarSha: installed.body.asarSha ?? null,
    },
  };
}

/**
 * The layout decision itself: `runApply` minus the edit plumbing.
 *
 * @param {object} input parsed argv plus `ops`
 * @returns {Promise<{ body: object, exitCode: number }>}
 */
async function runApplyCore(input) {
  const stateDir = stateDirOf(process.env);
  const root = resolveRoot(input.root, stateDir);
  if (root === null) {
    return {
      exitCode: EXIT.REFUSED,
      body: { ok: false, code: ERROR_CODES.EINSTALL_ROOT, message: '请用 --root 指定 DSH 桌面安装目录' },
    };
  }

  const facts = await inspect(root);
  if (facts.ok !== true) {
    return { exitCode: EXIT.REFUSED, body: { ok: false, code: facts.code, message: facts.message } };
  }
  const ops = Array.isArray(input.ops) ? input.ops : [];
  // ---- edits that must be refused BEFORE any layout work -------------------
  //
  // Why before: the path a caller wants to edit must be editable ON THIS
  // ARCHIVE. An edit aimed at a stock archive is refused here (with the reason)
  // instead of being attempted after a 209 MB install, and a `remove` without a
  // baseline is refused before the backup work would have to run.
  if (ops.length > 0) {
    const preflight = await preflightEdits({ stateDir, root, facts, ops });
    if (preflight.ok !== true) {
      safeAudit(stateDir, 'apply-refused-edit', {
        root,
        code: preflight.code,
        layout: facts.layout,
        ops: ops.map((op) => ({ op: op.op, path: op.path })),
      });
      return {
        exitCode: EXIT.REFUSED,
        body: {
          ok: false,
          code: preflight.code,
          message: preflight.message,
          root,
          asarPath: facts.asarPath,
          state: facts.state,
          layout: facts.layout,
          editsRequested: ops.length,
          editsApplied: 0,
          requiresBaseline: preflight.requiresBaseline === true,
        },
      };
    };
  }
  return decideLayout({ stateDir, root, facts, ops, input });
}

/**
 * Refuse an edit list before anything is written.
 *
 * The rules, in order — all of them are "the archive cannot carry this edit",
 * decided read-only:
 *   1. an edit on an archive that is NOT one of our split installs is refused
 *      (`EEDIT_LAYOUT`): the add/delete/repoint layer only makes sense on a file
 *      whose uninstall path this package owns;
 *   2. `lib/main.js` and anything under the SPLIT region are refused
 *      (`EENTRY_FORBIDDEN`) — that is the surgery's territory;
 *   3. a `remove` with no verified baseline is refused (`EBASELINE_REQUIRED`);
 *   4. an edit that lands on an `unpacked` entry is refused (`EENTRY_UNPACKED`).
 *
 * @param {{ stateDir: string, root: string, facts: object, ops: object[] }} input
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string, requiresBaseline?: boolean }>}
 */
async function preflightEdits(input) {
  const { facts, ops } = input;
  // `pristine` + `stock` is allowed: the layout step runs first (it installs the
  // split region), and the edits are then applied to the resulting archive — one
  // action from the user's side, which is the whole point of `--apply`.
  // `in-slot` is refused in `decideLayout` with its own message (a migration is
  // already a byte movement), and foreign/unknown never reaches here.
  if (facts.layout !== 'split' && !(facts.layout === 'pristine' && facts.state === 'stock')) {
    return {
      ok: false,
      code: ERROR_CODES.EEDIT_LAYOUT,
      message: `这个 asar 现在既不是本插件的 0.2.0 安装、也不是官方原样（layout=${facts.layout}，state=${facts.state}）：`
        + '目录编辑不做，因为没有一条定义好的回官方字节的路',
    };
  }
  if (facts.edits === true && facts.layout !== 'split') {
    return {
      ok: false,
      code: ERROR_CODES.EEDIT_PRESENT,
      message: '这个 asar 身上已经有目录编辑，但布局不再是 split：拒绝叠加写入，请先 --restore',
    };
  }
  if (ops.some((op) => op.op === 'remove')) {
    const baseline = editBaselineOf({ record0: readInstallRecord(input.stateDir), facts });
    if (baseline === null) {
      return {
        ok: false,
        code: ERROR_CODES.EBASELINE_REQUIRED,
        message: '删除一个文件会把它的字节从 asar 里彻底拿掉，之后只能靠一份**校验过的官方原样备份**才回得去；'
          + '这台机器现在没有可用且校验通过的官方备份，所以拒绝删除（没有写入任何字节）',
        requiresBaseline: true,
      };
    }
  }
  return { ok: true };
}

/**
 * The four-way layout decision plus the edit hand-off.
 *
 * @param {{ stateDir: string, root: string, facts: object, ops: object[], input: object }} input
 * @returns {Promise<{ body: object, exitCode: number }>}
 */
async function decideLayout(input) {
  const { stateDir, root, facts, ops } = input;
  const request = input.input ?? {};
  const record0 = readInstallRecord(stateDir);

  if (facts.state === 'foreign' || facts.state === 'unknown') {
    safeAudit(stateDir, 'apply-refused', {
      root,
      state: facts.state,
      layout: facts.layout,
      doubleInstall: facts.doubleInstall === true,
      reason: facts.reason,
    });
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: facts.state === 'foreign' ? ERROR_CODES.EFOREIGN_PATCH : ERROR_CODES.EUNKNOWN_LAYOUT,
        // The double install is OUR OWN doing (0.1.x patch in the slot AND the
        // 0.2.0 region after it), so the classifier's reason is not enough: a
        // human needs the WAY OUT, and `docs/RESTORE-STOCK.md` is it.
        message: facts.doubleInstall === true ? DOUBLE_INSTALL_MESSAGE : facts.reason,
        doubleInstall: facts.doubleInstall === true,
        layout: facts.layout,
        root,
        asarPath: facts.asarPath,
        state: facts.state,
      },
    };
  }

  // Release check, still before anything is written: a version whose official
  // `lib/main.js` no longer provides a name the patch body references would
  // compile to a startup crash, and a wrong install is worse than no install.
  // The foreign/unknown branch above already reported a more specific reason; a
  // `unverified` verdict (`allowed: true`) proceeds and carries its warnings.
  if (facts.compat !== undefined && facts.compat.allowed !== true) {
    safeAudit(stateDir, 'apply-refused-compat', {
      root,
      state: facts.state,
      layout: facts.layout,
      dshVersion: facts.dshVersion,
      level: facts.compat.level,
      missingDependencies: facts.compat.missingDependencies,
      summary: facts.compat.summary,
    });
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.EUNKNOWN_LAYOUT,
        message: facts.compat.summary,
        missingDependencies: facts.compat.missingDependencies,
        compat: facts.compat,
        layout: facts.layout,
        root,
        asarPath: facts.asarPath,
        state: facts.state,
      },
    };
  }

  // Warnings carried from the release check; the slot-length note is appended
  // below when the archive did not measure the length this package verified.
  const warnings = Array.isArray(facts.compat?.warnings) ? [...facts.compat.warnings] : [];

  const bridgeSrc = bridgePathForPackage();
  if (!existsSync(bridgeSrc)) {
    return {
      exitCode: EXIT.USAGE,
      body: { ok: false, code: ERROR_CODES.EBRIDGE_COPY, message: `桥构建产物不存在：${bridgeSrc}（先跑 node scripts/build-bridge.mjs）` },
    };
  }

  const common = { stateDir, root, facts, bridgeSrc, warnings, record0, ops, request };

  // ---- the four-way decision ------------------------------------------------
  //
  // 1. ALREADY INSTALLED (0.2.0): nothing moves. The bridge and the record are
  //    refreshed; the region is rewritten in place only if its bytes are stale.
  if (facts.layout === 'split') {
    if (ops.length > 0) return applyWithEdits(common);
    // AN EDITED ARCHIVE MUST NOT BE RE-LAID-OUT. A refresh that only rewrites the
    // region in place moves no bytes and is harmless; a refresh that has to RESIZE
    // the reserve shifts `lib/main.js` and every trailing entry — including the
    // entries our edit journal recorded offsets for. Those offsets would then be
    // stale, and `--restore`'s header reconstruction would refuse (safely, but
    // uselessly). The honest answer is "undo the edits first", and one `--restore`
    // does exactly that.
    if (facts.edits === true && facts.splitRegion !== null
      && facts.splitRegion.length !== REGION_RESERVE_BYTES) {
      safeAudit(stateDir, 'apply-refused-edited-regrow', {
        root,
        layout: 'split',
        reserve: facts.splitRegion.length,
        editPaths: facts.editPaths,
      });
      return {
        exitCode: EXIT.REFUSED,
        body: {
          ok: false,
          code: ERROR_CODES.EEDIT_PRESENT,
          message: `这个 asar 上已经有目录编辑（${facts.editPaths.join('、')}），而区域要从 `
            + `${facts.splitRegion.length} 字节改成 ${REGION_RESERVE_BYTES} 字节——那会移动 `
            + '`lib/main.js` 之后的每一条，包括编辑日志里记着偏移的那些。'
            + '请先跑一次 --restore（它会先算术撤回编辑，再逐字节回到官方原样），然后再 --apply',
          root,
          asarPath: facts.asarPath,
          layout: 'split',
          state: facts.state,
          edited: true,
          editPaths: facts.editPaths,
        },
      };
    }
    return refreshSplit(common);
  }

  // 2. 0.1.x INSTALL (in-slot patch): migrate. The slot must become official
  //    again before a region may be inserted after it.
  if (facts.layout === 'in-slot') {
    if (ops.length > 0) {
      // Two layouts in one action would be two byte movements; the migration
      // itself is already one. Say so instead of doing half of each.
      return {
        exitCode: EXIT.REFUSED,
        body: {
          ok: false,
          code: ERROR_CODES.EEDIT_LAYOUT,
          message: '这台机器是 0.1.x 的槽位内补丁，迁移和目录编辑不能一次做（迁移本身要先动字节）；'
            + '请先跑一次不带编辑的 --apply 完成迁移，再带编辑跑一次',
          root,
          asarPath: facts.asarPath,
          layout: 'in-slot',
          state: facts.state,
        },
      };
    }
    return migrateInSlot(common);
  }

  // 3. NOTHING OF OURS (pristine). This is the only state that installs from
  //    scratch, and it always installs the SPLIT layout: the 0.1.x in-slot write
  //    is reachable only through the migration path above, never from `stock`.
  //
  //    EDITS COME AFTER the install, which is exactly what `applyWithEdits`
  //    does: first `installSplit`, then the edit list on the resulting split
  //    archive. The preflight above refused the edit shapes that can never work.
  if (facts.layout === 'pristine' && facts.state === 'stock') {
    if (ops.length > 0) return applyWithEdits(common);
    return installSplit({ stateDir, root, facts, bridgeSrc, warnings, migration: null });
  }

  // 4. Anything else is a shape this package was not taught about. Writing on a
  //    guess is never permission.
  safeAudit(stateDir, 'apply-refused-layout', {
    root,
    state: facts.state,
    layout: facts.layout,
    reason: facts.reason,
  });
  return {
    exitCode: EXIT.REFUSED,
    body: {
      ok: false,
      code: ERROR_CODES.EUNKNOWN_LAYOUT,
      message: `无法识别这个 asar 的布局（layout=${facts.layout}，state=${facts.state}）：${facts.reason ?? ''}`,
      layout: facts.layout,
      root,
      asarPath: facts.asarPath,
      state: facts.state,
    },
  };
}

/**
 * Has this exact edit ALREADY been applied (and journalled)?
 *
 * This is what makes a second `--apply` with the same edit a NO-OP instead of a
 * duplicate-append refusal, which is the behaviour that matters at a user's
 * fingertips: pressing the same button twice must not produce a second entry and
 * must not look like an error either.
 *
 * Three checks, all read-only, and all three must agree:
 *   1. the journal has a record for this path;
 *   2. for append/repoint, that record's entry still sits where it said and its
 *      bytes still hash to what it recorded (`verifyRecord`);
 *   3. for append/repoint, the content being requested is byte-identical to the
 *      recorded content (`entrySha`).
 * A `remove` is already applied when the entry is gone and the journal says so.
 *
 * @param {string} asarPath
 * @param {object|null} journal
 * @param {{ op: string, path: string, content: Buffer|null }} op
 * @returns {Promise<{ already: boolean, record?: object, reason?: string }>}
 */
async function alreadyApplied(asarPath, journal, op) {
  if (journal === null || typeof journal !== 'object' || !Array.isArray(journal.records)) {
    return { already: false };
  }
  const normalized = normalizeEntryPathCompat(op.path);
  if (normalized === null) return { already: false };
  const candidates = journal.records.filter((record) => record !== null && typeof record === 'object'
    && record.path === normalized);
  if (candidates.length === 0) return { already: false };
  if (op.op === 'remove') {
    const record = candidates.filter((item) => item.kind === 'remove').pop();
    if (record === undefined) return { already: false };
    const opened = openAsar(asarPath, { allowStaleMainIntegrity: true });
    if (opened.ok !== true) return { already: false };
    try {
      if (opened.entries.has(normalized)) return { already: false };
    } finally {
      closeAsar(opened);
    }
    return { already: true, record, reason: '这个删除已经做过（日志里有记录，条目已不在 asar 里）' };
  }
  const record = candidates.filter((item) => item.kind === op.op).pop();
  if (record === undefined) return { already: false };
  if (op.content !== null && Buffer.isBuffer(op.content) && sha256Buffer(op.content) !== record.entrySha) {
    return { already: false };
  }
  const verified = await verifyRecord(asarPath, record);
  if (verified.ok !== true) return { already: false };
  return {
    already: true,
    record,
    reason: `这个${op.op}已经做过（日志里的记录与 asar 现状一致：偏移 ${record.entryOffset}，长度 ${record.entrySize}）`,
  };
}

/**
 * Normalise an entry path the same way `lib/asar/reader.js` does, without
 * importing the reader's whole surface into the CLI's hot path.
 *
 * @param {unknown} path
 * @returns {string|null}
 */
function normalizeEntryPathCompat(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  const parts = path.replace(/\\/g, '/').split('/').filter((part) => part.length > 0 && part !== '.');
  return parts.length === 0 ? null : parts.join('/');
}

/**
 * Turn `request.edit` (one object or an array of them) into the list of edits to
 * perform, resolving content from `--content` / `--content-file` / inline
 * `content` / `base64`.
 *
 * Read-only: it only decides WHAT would be written. Every refusal here is
 * a usage error, never a partial write.
 *
 * @param {object} request parsed argv
 * @returns {{ ok: true, ops: Array<{ op: string, path: string, content: Buffer }> }
 *   | { ok: false, code: string, message: string }}
 */
export function resolveEditOps(request) {
  if (request === null || typeof request !== 'object' || request.edit === undefined || request.edit === null) {
    return { ok: true, ops: [] };
  }
  const raw = Array.isArray(request.edit) ? request.edit : [request.edit];
  if (raw.length === 0) return { ok: true, ops: [] };
  if (raw.length > EDIT_OPS_MAX) {
    return {
      ok: false,
      code: 'EINSTALL_USAGE',
      message: `一次 --apply 最多 ${EDIT_OPS_MAX} 个编辑操作（收到 ${raw.length} 个）`,
    };
  }
  const ops = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item === null || typeof item !== 'object') {
      return { ok: false, code: 'EINSTALL_USAGE', message: `第 ${index + 1} 个编辑不是一个对象` };
    }
    const op = typeof item.op === 'string' ? item.op.trim().toLowerCase() : '';
    if (op !== 'append' && op !== 'remove' && op !== 'repoint') {
      return {
        ok: false,
        code: 'EINSTALL_USAGE',
        message: `第 ${index + 1} 个编辑的 op 不认识：${JSON.stringify(item.op)}（可用 append / remove / repoint）`,
      };
    }
    if (typeof item.path !== 'string' || item.path.length === 0) {
      return { ok: false, code: 'EINSTALL_USAGE', message: `第 ${index + 1} 个编辑缺少 path` };
    }
    if (op === 'remove') {
      ops.push({ op, path: item.path, content: null });
      continue;
    }
    let content = null;
    if (typeof item.base64 === 'string') {
      content = Buffer.from(item.base64, 'base64');
    } else if (item.contentFile !== undefined && item.contentFile !== null) {
      if (typeof item.contentFile !== 'string' || item.contentFile.length === 0) {
        return { ok: false, code: 'EINSTALL_USAGE', message: `第 ${index + 1} 个编辑的 contentFile 不合法` };
      }
      if (!existsSync(item.contentFile)) {
        return { ok: false, code: 'EINSTALL_USAGE', message: `第 ${index + 1} 个编辑的内容文件不存在：${item.contentFile}` };
      }
      try {
        content = readFileSync(item.contentFile);
      } catch (error) {
        return {
          ok: false,
          code: 'EINSTALL_USAGE',
          message: `读不到内容文件 ${item.contentFile}：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } else if (typeof item.content === 'string') {
      content = Buffer.from(item.content, 'utf8');
    }
    if (content === null) {
      return {
        ok: false,
        code: 'EINSTALL_USAGE',
        message: `第 ${index + 1} 个编辑（${op} ${item.path}）需要内容：--content、--content-file 或 JSON 里的 content/base64`,
      };
    }
    ops.push({ op, path: item.path, content });
  }
  return { ok: true, ops };
}

/** How many edit operations one `--apply` may carry (one journal entry each). */
const EDIT_OPS_MAX = 16;

/**
 * Apply one list of edits to an installed archive and journal them.
 *
 * ORDER AND WHY: the ops run in the order given, and each one is planned against
 * the file as it is at that moment, so a later op may refer to a path an earlier
 * op created. The journal is appended only after an op succeeded AND was
 * verified by re-reading the archive, so a crash can lose at most the record of
 * an op that did not happen.
 *
 * The BASE digest is the archive the FIRST op started from: the whole reversibility
 * promise is "we can come back to exactly those bytes", and re-basing on every op
 * would weaken that into "we can come back to the previous op".
 *
 * DELETE (rule A) is the one op with a precondition: a VERIFIED stock baseline.
 * The install record's own `stockSha` names it and `facts.backup` points at it.
 * Its digest is re-checked inside `applyRemove` immediately before the write.
 *
 * @param {{ stateDir: string, root: string, asarPath: string, ops: object[],
 *   baseline: { path: string, sha256: string, size: number }|null }} input
 * @returns {Promise<{ ok: true, applied: object[], journal: object }
 *   | { ok: false, code: string, message: string, applied: object[] }>}
 */
async function runEdits(input) {
  const { stateDir, root, asarPath, ops, baseline } = input;
  if (ops.length === 0) return { ok: true, applied: [], journal: null };
  const shaBefore = await sha256File(asarPath);
  const sizeBefore = statSync(asarPath).size;
  const applied = [];
  let journal = null;
  for (const op of ops) {
    if (op.op === 'remove' && baseline === null) {
      return {
        ok: false,
        code: ERROR_CODES.EBASELINE_REQUIRED,
        message: '删除一个文件会把它的字节从 asar 里彻底拿掉，之后只能靠一份**校验过的官方原样备份**才回得去；'
          + '这台机器现在没有可用且校验通过的官方备份，所以拒绝删除（没有写入任何字节）',
        applied,
        requiresBaseline: true,
      };
    }
    const plan = await planEditFile(asarPath, {
      op: op.op,
      path: op.path,
      content: op.op === 'remove' ? undefined : op.content,
      baseline: op.op === 'remove' ? baseline : undefined,
    });
    if (plan.ok !== true) {
      return {
        ok: false,
        code: plan.code ?? ERROR_CODES.EWRITE_FAILED,
        message: `编辑 ${op.op} ${op.path} 被拒绝：${plan.message}`,
        applied,
        planDetail: plan,
      };
    }
    const written = op.op === 'remove'
      ? await applyRemove(asarPath, plan)
      : await applyAppend(asarPath, plan);
    if (written.ok !== true) {
      return {
        ok: false,
        code: written.code ?? ERROR_CODES.EWRITE_FAILED,
        message: `编辑 ${op.op} ${op.path} 写入失败：${written.message}`,
        applied,
      };
    }
    // Journal the record BEFORE the caller can observe success: the archive is
    // already changed, and a lost record is a machine that cannot go back.
    journal = appendEditJournal(stateDir, {
      installRoot: root,
      asarPath,
      baseArchiveSha: applied.length === 0 ? shaBefore : (journal?.base?.sha256 ?? shaBefore),
      baseArchiveSize: sizeBefore,
    }, plan.record);
    applied.push({
      op: op.op,
      path: op.path,
      entrySize: plan.entrySize,
      archiveSizeAfter: written.archiveSize,
      headerBytes: written.headerBytes,
      headerPaddingBytes: written.headerPaddingBytes,
      blocksDropped: written.droppedBlocks ?? 0,
      movedEntries: written.movedEntries ?? 0,
      requiresBaseline: plan.requiresBaseline === true,
      record: plan.record,
    });
  }
  return { ok: true, applied, journal };
}

/**
 * Build the baseline descriptor a delete needs from what the INSTALL knows: the
 * recorded official digest (`stockSha`) plus the backup file the record names
 * (or the newest one found beside the archive).
 *
 * Returns `null` when no such baseline can be named. That is not an error — it is
 * the answer `--remove` refuses on, and the message a human gets names it.
 *
 * @param {{ record0: object|null, facts: object }} input
 * @returns {{ path: string, sha256: string, size: number }|null}
 */
function editBaselineOf(input) {
  const record0 = input.record0 === null || typeof input.record0 !== 'object' ? null : input.record0;
  const sha = recordedStockShaOf(record0);
  if (sha === null) return null;
  const facts = input.facts;
  const backup = facts.backup;
  if (backup !== null && backup !== undefined && typeof backup.path === 'string' && existsSync(backup.path)) {
    return { path: backup.path, sha256: sha, size: Number(backup.size) };
  }
  return null;
}

/**
 * Shared tail of every real restore: remove the bridge, write the flow marker,
 * rewrite the record as `installed:false`.
 *
 * Kept separate from the per-layout restore itself because the three layouts
 * reach this point by completely different routes (a byte-exact shrink, an
 * in-place backup overwrite, or nothing at all) but must leave the install page
 * in exactly the same state afterwards.
 *
 * @param {{ stateDir: string, root: string, asarPath: string, record0: object|null,
 *   restoredSha: string, writeMode: string, layoutBefore: string,
 *   extra: Record<string, unknown> }} input
 * @returns {{ ok: true, body: object } | { ok: false, code: string, message: string, exitCode: number }}
 */
function finishRestore(input) {
  const bridgeRemoved = removeFile(bridgePathOf(input.root));
  if (bridgeRemoved.ok !== true) {
    safeAudit(input.stateDir, 'restore-bridge-remove-failed', { root: input.root, code: bridgeRemoved.code });
    return { ok: false, code: bridgeRemoved.code ?? ERROR_CODES.EWRITE_FAILED, message: bridgeRemoved.message, exitCode: EXIT.USAGE };
  }

  writeUninstallFlow(input.stateDir, { phase: 'restored', reason: 'cli --restore' });

  writeInstallRecord(input.stateDir, {
    schema: 2,
    pluginVersion: PLUGIN_VERSION,
    installRoot: input.root,
    asarPath: input.asarPath,
    asarSha: input.restoredSha,
    layout: 'pristine',
    installed: false,
    restoredAt: new Date().toISOString(),
    previous: input.record0 === null
      ? null
      : {
        asarSha: input.record0.asarSha ?? null,
        layout: input.record0.layout ?? null,
        backup: input.record0.backup ?? null,
      },
  });

  safeAudit(input.stateDir, 'restore', {
    root: input.root,
    layoutBefore: input.layoutBefore,
    restoredSha: input.restoredSha,
    mode: input.writeMode,
    bridgeRemoved: bridgeRemoved.removed,
    ...input.extra,
  });

  return {
    ok: true,
    body: {
      ok: true,
      mode: 'restore',
      root: input.root,
      asarPath: input.asarPath,
      asarSha: input.restoredSha,
      state: 'stock',
      layout: 'pristine',
      layoutBefore: input.layoutBefore,
      bridge: null,
      bridgeRemoved: bridgeRemoved.removed,
      writeMode: input.writeMode,
      flow: 'restored',
      stateDir: input.stateDir,
      ...input.extra,
    },
  };
}

/**
 * The backup-restore route (0.1.x today, and the FALLBACK for a split archive
 * whose reverse surgery failed).
 *
 * @param {{ stateDir: string, root: string, asarPath: string, record0: object|null,
 *   layoutBefore: string, reason: string|null, extra: Record<string, unknown> }} input
 * @returns {Promise<{ body: object, exitCode: number }>}
 */
async function restoreFromBackupRoute(input) {
  const { stateDir, root, asarPath, record0 } = input;
  const prefer = recordedStockShaOf(record0) ?? undefined;
  const backup = await findBackup(asarPath, prefer === undefined ? {} : { preferSha256: prefer });
  if (backup.ok !== true) {
    safeAudit(stateDir, 'restore-refused', {
      root,
      code: backup.code,
      layout: input.layoutBefore,
      reason: input.reason ?? null,
    });
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: ERROR_CODES.ENO_BACKUP,
        message: `没有可用的备份，无法还原：${backup.message ?? ''}`.trim()
          + (input.reason === null ? '' : `（${input.reason}）`),
        root,
        asarPath,
        layoutBefore: input.layoutBefore,
      },
    };
  }

  const inPlace = canRestoreInPlace(asarPath, backup.backupPath);
  const restored = await restoreFromBackup(asarPath, backup.backupPath);
  if (restored.ok !== true) {
    safeAudit(stateDir, 'restore-failed', { root, code: restored.code, mode: inPlace ? 'in-place' : 'size-mismatch' });
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: restored.code ?? ERROR_CODES.EWRITE_FAILED,
        message: restored.message,
        root,
        asarPath,
        backup: { path: backup.backupPath, size: backup.size, sha256: backup.sha256 },
      },
    };
  }

  const finished = finishRestore({
    stateDir,
    root,
    asarPath,
    record0,
    restoredSha: restored.restoredSha,
    writeMode: restored.mode,
    layoutBefore: input.layoutBefore,
    extra: {
      backup: {
        name: backup.backupPath.split(/[\\/]/).pop(),
        path: backup.backupPath,
        size: backup.size,
        sha256: backup.sha256,
      },
      ...input.extra,
    },
  });
  if (finished.ok !== true) {
    return { exitCode: finished.exitCode, body: { ok: false, code: finished.code, message: finished.message } };
  }
  return { exitCode: EXIT.OK, body: finished.body };
}

/**
 * Undo the edit journal before a layout restore touches the archive.
 *
 * TWO ROUTES, and which one applies is decided by the journal itself:
 *
 *   ARITHMETIC (no `remove` record) — `undoEdits` rebuilds every header the edits
 *   displaced, proves each one against the digest it recorded, cuts the appended
 *   tail off, and finally proves the WHOLE file against the journal's base digest.
 *   That lands on the archive the FIRST edit started from, which (because the
 *   layout branch runs before the edits) is the split archive — so the normal
 *   `shrinkRegion` step can follow and still reproduce the official bytes.
 *
 *   BASELINE (any `remove` record) — the removed bytes exist nowhere, so the only
 *   inverse is the verified official baseline the delete was gated on. Overwriting
 *   with it lands on official stock bytes directly, which ALSO removes our split
 *   region (the baseline predates the install). The layout branch must therefore
 *   be skipped, and the result is verified by digest before it is reported.
 *
 * Refusals never write: a journal that does not describe this file, a baseline
 * whose digest changed, or a reconstruction that does not hash back, all leave the
 * archive as it was.
 *
 * @param {{ stateDir: string, root: string, asarPath: string, journal: object }} input
 * @returns {Promise<{ ok: true, mode: 'arithmetic'|'baseline', restoredSha: string,
 *   restoredSize: number, ops: string[], landedOnStock: boolean }
 *   | { ok: false, code: string, message: string }>}
 */
async function undoJournal(input) {
  const { journal, asarPath } = input;
  const records = Array.isArray(journal.records) ? journal.records : [];
  const removeRecords = records.filter((record) => record !== null && typeof record === 'object' && record.kind === 'remove');
  const arithmeticRecords = records.filter((record) => record !== null && typeof record === 'object' && record.kind !== 'remove');

  if (removeRecords.length === 0) {
    const undone = await undoEdits(asarPath, records, { archiveShaBase: journal.base?.sha256 });
    if (undone.ok !== true) return undone;
    return {
      ok: true,
      mode: 'arithmetic',
      restoredSha: undone.restoredSha,
      restoredSize: undone.restoredSize,
      ops: undone.ops,
      // The journal base is the SPLIT archive: the layout step still has work to
      // do, and it will be the normal one.
      landedOnStock: false,
    };
  }

  // Baseline route. Order matters: undo the arithmetic edits that happened AFTER
  // the delete first would be pointless (the baseline overwrite discards them),
  // so this is a single atomic overwrite. What must be true instead is that the
  // baseline the delete recorded is still the bytes it was verified against.
  const record = removeRecords[removeRecords.length - 1];
  const restored = await undoRemove(asarPath, record);
  if (restored.ok !== true) return restored;
  return {
    ok: true,
    mode: 'baseline',
    restoredSha: restored.restoredSha,
    restoredSize: restored.restoredSize,
    ops: [...arithmeticRecords.map((item) => `${item.kind}:${item.path}`), `remove:${record.path}`],
    // The baseline is the OFFICIAL archive: nothing of ours is in it, so the
    // layout branch has nothing left to undo.
    landedOnStock: true,
  };
}

/**
 * `--verify-edits`: prove the journal can be reversed, without writing a byte.
 *
 * @param {object} request parsed argv
 * @returns {Promise<{ body: object, exitCode: number }>}
 */
async function runVerifyEdits(request) {
  const stateDir = stateDirOf(process.env);
  const root = resolveRoot(request.root, stateDir);
  if (root === null) {
    return {
      exitCode: EXIT.REFUSED,
      body: { ok: false, code: ERROR_CODES.EINSTALL_ROOT, message: '请用 --root 指定 DSH 桌面安装目录' },
    };
  }
  const asarPath = asarPathOf(root);
  if (!existsSync(asarPath)) {
    return {
      exitCode: EXIT.REFUSED,
      body: { ok: false, code: ERROR_CODES.EINSTALL_ROOT, message: `这个目录里没有 ${ASAR_RELATIVE_PATH}：${root}` },
    };
  }
  const journal = readEditJournal(stateDir);
  if (journal === null) {
    return {
      exitCode: EXIT.OK,
      body: {
        ok: true,
        mode: 'verify-edits',
        noop: true,
        reason: '编辑日志是空的，没有需要证明的撤回',
        root,
        asarPath,
        stateDir,
        journalRecords: 0,
      },
    };
  }
  const records = Array.isArray(journal.records) ? journal.records : [];
  const hasRemove = records.some((record) => record !== null && typeof record === 'object' && record.kind === 'remove');
  if (hasRemove) {
    // A delete cannot be proven arithmetically; what CAN be proven is that the
    // baseline it was gated on is still on disk with the digest it recorded.
    const record = records.filter((item) => item !== null && typeof item === 'object' && item.kind === 'remove').pop();
    const baseline = record?.baseline;
    if (baseline === null || typeof baseline !== 'object' || typeof baseline.path !== 'string') {
      return {
        exitCode: EXIT.REFUSED,
        body: {
          ok: false,
          code: ERROR_CODES.EBASELINE_REQUIRED,
          message: '日志里的删除记录没有可用基线，无法证明能回到官方字节',
          root,
          asarPath,
        },
      };
    }
    if (!existsSync(baseline.path)) {
      return {
        exitCode: EXIT.REFUSED,
        body: {
          ok: false,
          code: ERROR_CODES.EBASELINE_REQUIRED,
          message: `删除用的官方备份已经不在磁盘上：${baseline.path}（删除已不可逆，需要手工按 docs/RESTORE-STOCK.md 处理）`,
          root,
          asarPath,
        },
      };
    }
    const digest = await sha256File(baseline.path);
    const matches = digest === baseline.sha256;
    return {
      exitCode: matches ? EXIT.OK : EXIT.REFUSED,
      body: {
        ok: matches,
        mode: 'verify-edits',
        reversible: matches,
        route: 'baseline',
        root,
        asarPath,
        baseline: { path: baseline.path, sha256: baseline.sha256, actual: digest, matches },
        journalRecords: records.length,
        code: matches ? undefined : ERROR_CODES.EBASELINE_REQUIRED,
        message: matches
          ? '日志里的删除可以用它的官方备份还原（备份摘要仍与记录一致）'
          : '删除用的官方备份摘要已经变了，删除不可逆',
      },
    };
  }

  const proof = await proveReversal(asarPath, records, { archiveShaBase: journal.base?.sha256 });
  if (proof.ok !== true) {
    return {
      exitCode: EXIT.REFUSED,
      body: {
        ok: false,
        code: proof.code,
        message: proof.message,
        root,
        asarPath,
        journalRecords: records.length,
        detail: proof,
      },
    };
  }
  return {
    exitCode: EXIT.OK,
    body: {
      ok: true,
      mode: 'verify-edits',
      reversible: true,
      route: 'arithmetic',
      root,
      asarPath,
      journalRecords: records.length,
      ops: proof.ops,
      predictedSha: proof.predictedSha,
      predictedSize: proof.predictedSize,
      expectedSha: proof.expectedSha,
      steps: proof.steps,
      base: journal.base ?? null,
    },
  };
}

/**
 * `--restore`: undo whichever layout is on disk, remove the bridge, write the
 * flow marker so the install page stays suppressed after the restart.
 *
 * THE POINT OF THIS FUNCTION: after 0.2.0 there are TWO layouts and they need
 * OPPOSITE undos. The split region is reversed by arithmetic — the archived
 * geometry plus the region length reproduce the official archive byte for byte
 * (`shrinkRegion`), no 209 MB backup needed — while the 0.1.x in-slot patch
 * rewrote the official bytes themselves, so only a backup can bring them back.
 * Doing "restore from backup" unconditionally would tell a split user whose
 * `.bak` was pruned that their perfectly reversible install is unrecoverable.
 *
 * @param {object} request parsed argv
 * @returns {Promise<{ body: object, exitCode: number }>}
 */
async function runRestore(request) {
  const stateDir = stateDirOf(process.env);
  const root = resolveRoot(request.root, stateDir);
  if (root === null) {
    return {
      exitCode: EXIT.REFUSED,
      body: { ok: false, code: ERROR_CODES.EINSTALL_ROOT, message: '请用 --root 指定 DSH 桌面安装目录' },
    };
  }

  const asarPath = asarPathOf(root);
  if (!existsSync(asarPath)) {
    return {
      exitCode: EXIT.REFUSED,
      body: { ok: false, code: ERROR_CODES.EINSTALL_ROOT, message: `这个目录里没有 ${ASAR_RELATIVE_PATH}：${root}` },
    };
  }

  // Read the record BEFORE anything is overwritten: it names the digest of the
  // stock baseline this machine was installed from, which outranks "newest
  // backup wins" — after an upgrade the newest `.bak` may belong to some other
  // version, while the recorded one is the baseline this record remembers.
  const record0 = readInstallRecord(stateDir);

  // Which layout are we undoing? Read-only, and computed from the SAME detector
  // the installer uses, so "what --apply installed" and "what --restore undoes"
  // can never disagree about the layout.
  const facts = await inspect(root);

  // 0. THE EDIT JOURNAL COMES FIRST. Whatever the layout is, any append / repoint
  //    / remove this package performed is undone BEFORE the layout step: the split
  //    surgery re-derives its geometry from the file, and an appended entry (or a
  //    compacted tail) makes the "stock + reserve" arithmetic wrong. Skipping this
  //    step would make `--restore` refuse on a machine whose ONLY problem is that
  //    the user once added a file — which is exactly the state this feature
  //    creates, so this cannot be an afterthought.
  const journal = readEditJournal(stateDir);
  let undoneEdits = null;
  if (journal !== null) {
    const undone = await undoJournal({ stateDir, root, asarPath, journal });
    if (undone.ok !== true) {
      safeAudit(stateDir, 'restore-edits-refused', {
        root,
        code: undone.code,
        message: undone.message,
        journalRecords: journal.records.length,
      });
      return {
        exitCode: EXIT.REFUSED,
        body: {
          ok: false,
          code: undone.code ?? ERROR_CODES.EEDIT_NOT_REVERSIBLE,
          message: `撤回编辑日志失败，所以没有继续还原（asar 未被改动）：${undone.message}`,
          root,
          asarPath,
          layout: facts.ok === true ? facts.layout : 'unknown',
          journalRecords: journal.records.length,
          requiresBaseline: undone.requiresBaseline === true,
        },
      };
    }
    writeEditJournal(stateDir, null);
    undoneEdits = {
      mode: undone.mode,
      ops: undone.ops,
      restoredSha: undone.restoredSha,
      restoredSize: undone.restoredSize,
      landedOnStock: undone.landedOnStock,
      journalRecords: journal.records.length,
    };
    safeAudit(stateDir, 'restore-edits', {
      root,
      mode: undone.mode,
      ops: undone.ops,
      restoredSha: undone.restoredSha,
      journalRecords: journal.records.length,
    });
    // A baseline-overwrite landed on the OFFICIAL bytes directly: there is no
    // layout left to undo, and the digest is checked here so the body can prove it.
    if (undone.landedOnStock === true) {
      const expectedStockSha = recordedStockShaOf(record0);
      const finished = finishRestore({
        stateDir,
        root,
        asarPath,
        record0,
        restoredSha: undone.restoredSha,
        writeMode: 'baseline',
        layoutBefore: facts.ok === true ? facts.layout : 'split',
        extra: {
          backup: null,
          backupUsed: true,
          editsUndone: undoneEdits,
          removedRegionBytes: null,
          stockShaConfirmed: expectedStockSha === null ? false : undone.restoredSha === expectedStockSha,
        },
      });
      if (finished.ok !== true) {
        return { exitCode: finished.exitCode, body: { ok: false, code: finished.code, message: finished.message } };
      }
      return { exitCode: EXIT.OK, body: finished.body };
    }
    // Otherwise the arithmetic undo landed on the SPLIT archive the edits started
    // from — which is a legal state the layout branch below knows exactly how to
    // reverse. Re-read the facts, because they describe a file that has changed.
    const refacts = await inspect(root);
    return restoreLayout({ request, stateDir, root, asarPath, record0, facts: refacts, extraEdits: undoneEdits });
  }

  return restoreLayout({ request, stateDir, root, asarPath, record0, facts, extraEdits: null });
}

/**
 * Undo the LAYOUT (the split region or the 0.1.x slot patch) after any edit-log
 * undo has already happened.
 *
 * @param {{ request: object, stateDir: string, root: string, asarPath: string,
 *   record0: object|null, facts: object, extraEdits: object|null }} input
 * @returns {Promise<{ body: object, exitCode: number }>}
 */
async function restoreLayout(input) {
  const { stateDir, root, asarPath, record0, facts, extraEdits } = input;
  const carried = extraEdits === null ? {} : { editsUndone: extraEdits };

  // 1. NOTHING OF OURS: there is nothing to undo. Report success rather than
  //    refusing — a restore on an already-official archive is a no-op request,
  //    not an error, and refusing would tempt a human into using a backup they
  //    do not need. No write happens on this path.
  if (facts.ok === true && facts.layout === 'pristine' && (facts.state === 'stock' || facts.state === 'unknown' || facts.state === 'foreign')) {
    if (facts.state === 'stock') {
      return {
        exitCode: EXIT.OK,
        body: {
          ok: true,
          mode: 'restore',
          noop: true,
          reason: extraEdits === null ? '官方原样，无需还原' : '编辑已撤回，asar 也已是官方原样',
          root,
          asarPath,
          asarSha: facts.asarSha,
          state: 'stock',
          layout: 'pristine',
          layoutBefore: 'pristine',
          backup: facts.backup,
          bridge: facts.bridge === null ? null : { path: facts.bridge.path, sha256: facts.bridge.sha256 },
          flow: null,
          stateDir,
          ...carried,
        },
      };
    }
    // A pristine slot that is unknown/foreign is not ours to "restore": the
    // official bytes may be damaged and a backup is the only way back.
    return restoreFromBackupRoute({
      stateDir,
      root,
      asarPath,
      record0,
      layoutBefore: facts.layout,
      reason: facts.reason ?? null,
      extra: { ...carried },
    });
  }

  // 2. THE SPLIT LAYOUT: reverse the insertion. No backup needed — the geometry
  //    in the file IS the receipt (`shrinkRegion` reproduces the official bytes
  //    exactly, which `test/split-surgery.test.mjs` proves on the real shell).
  if (facts.ok === true && facts.layout === 'split') {
    const expectedStockSha = recordedStockShaOf(record0);
    const shrunk = await shrinkRegion(asarPath);
    if (shrunk.ok === true) {
      // The digest is the second opinion: `shrinkRegion` proves the geometry, the
      // recorded stock digest proves it is the bytes THIS machine came from.
      if (expectedStockSha === null || shrunk.archiveShaAfter === expectedStockSha) {
        const finished = finishRestore({
          stateDir,
          root,
          asarPath,
          record0,
          restoredSha: shrunk.archiveShaAfter,
          writeMode: 'shrink',
          layoutBefore: 'split',
          extra: {
            backup: null,
            backupUsed: false,
            removedRegionBytes: shrunk.removedRegionBytes,
            regionSha: shrunk.regionSha,
            archiveSizeBefore: shrunk.archiveSizeBefore,
            archiveSizeAfter: shrunk.archiveSizeAfter,
            stockShaConfirmed: expectedStockSha !== null,
            ...carried,
          },
        });
        if (finished.ok !== true) {
          return { exitCode: finished.exitCode, body: { ok: false, code: finished.code, message: finished.message } };
        }
        return { exitCode: EXIT.OK, body: finished.body };
      }
      // Shrunk to the right shape but not the recorded bytes: do NOT claim it
      // worked. The backup is the honest route, and the body says which one was
      // used and why.
      return restoreFromBackupRoute({
        stateDir,
        root,
        asarPath,
        record0,
        layoutBefore: 'split',
        reason: `反向手术还原出来的摘要是 ${shrunk.archiveShaAfter}，与安装记录里的官方摘要 ${expectedStockSha} 不一致，改用备份`,
        extra: {
          backupUsed: true,
          shrinkDigestMismatch: { expected: expectedStockSha, actual: shrunk.archiveShaAfter },
          ...carried,
        },
      });
    }
    return restoreFromBackupRoute({
      stateDir,
      root,
      asarPath,
      record0,
      layoutBefore: 'split',
      reason: `撤回 split 区域失败（${shrunk.code}：${shrunk.message}），回退到用备份还原`,
      extra: { backupUsed: true, shrinkFailure: { code: shrunk.code, message: shrunk.message }, ...carried },
    });
  }

  // 3. THE 0.1.x IN-SLOT LAYOUT (and anything unreadable): only a backup holds
  //    the official bytes, because the patch replaced them.
  return restoreFromBackupRoute({
    stateDir,
    root,
    asarPath,
    record0,
    layoutBefore: facts.ok === true ? facts.layout : 'unknown',
    reason: facts.ok === true ? null : `读不到 asar 的分类（${facts.code}：${facts.message}），按 0.1.x 路径用备份还原`,
    extra: { ...carried },
  });
}


/**
 * `--scan`: find DSH desktop install roots. Read-only.
 *
 * @param {object} request parsed argv
 * @returns {Promise<{ body: object, exitCode: number }>}
 */
async function runScan(request) {
  const result = scanInstallRoots({
    drives: request.drives,
    extraRoots: request.extraRoots,
    namePatterns: request.namePatterns,
    maxDepth: request.maxDepth,
  });
  const hits = result.candidates.filter((candidate) => candidate.ok === true);
  return {
    exitCode: hits.length > 0 ? EXIT.OK : EXIT.REFUSED,
    body: {
      ok: hits.length > 0,
      mode: 'scan',
      root: hits.length > 0 ? hits[0].root : null,
      asarPath: hits.length > 0 ? hits[0].asarPath : null,
      asarSha: null,
      dshVersion: hits.length > 0 ? hits[0].dshVersion : null,
      state: hits.length > 0 ? 'stock' : 'missing',
      candidates: result.candidates,
      scannedCount: result.scannedCount,
      scanErrors: result.scanErrors,
      code: hits.length > 0 ? undefined : (result.code ?? ERROR_CODES.ESCAN_EMPTY),
      message: hits.length > 0 ? undefined : '没有找到 DSH 桌面的安装目录',
    },
  };
}

/**
 * Entry point. Returns the process exit code.
 *
 * @param {string[]} argv raw process arguments (including node + script)
 * @returns {Promise<{ exitCode: number, body: object }>}
 */
export async function main(argv) {
  const parsed = parseArgv(argv.slice(2));
  if (parsed.ok !== true) {
    return { exitCode: EXIT.USAGE, body: { ok: false, code: parsed.code, message: parsed.message } };
  }

  try {
    if (parsed.mode === 'scan') return await runScan(parsed);
    if (parsed.mode === 'apply') return await runApply(parsed);
    if (parsed.mode === 'restore') return await runRestore(parsed);
    if (parsed.mode === 'verify-edits') return await runVerifyEdits(parsed);
    return { body: await runReadOnly(parsed), exitCode: EXIT.OK };
  } catch (error) {
    if (error instanceof FrameworkError) return { exitCode: EXIT.USAGE, body: error.toJSON() };
    return { exitCode: EXIT.USAGE, body: toFailure(error) };
  }
}

/** Whether this module is the process entry point. */
function isEntryPoint() {
  const self = fileURLToPath(import.meta.url);
  const invoked = process.argv[1];
  if (typeof invoked !== 'string') return false;
  return invoked.toLowerCase() === self.toLowerCase();
}

if (isEntryPoint()) {
  const { exitCode, body } = await main(process.argv);
  const wantsJson = process.argv.includes('--json');
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(body)}\n`);
  } else {
    process.stdout.write(`${renderHuman(body)}\n`);
  }
  process.exitCode = exitCode;
}

/**
 * Human-readable rendering used when `--json` is absent.
 *
 * @param {object} body
 * @returns {string}
 */
export function renderHuman(body) {
  const lines = [];
  if (body.ok !== true) {
    lines.push(`✗ ${body.code ?? 'EINSTALL_FAILED'}：${body.message ?? ''}`);
    // A refusal still carries which layout it looked at; naming it keeps a human
    // from having to guess whether the file is ours or somebody else's.
    if (body.layout !== undefined && body.layout !== null) {
      lines.push(`布局：${layoutLabel(body.layout, body.doubleInstall === true)}`);
    }
    return lines.join('\n');
  }
  lines.push(`模式：${body.mode ?? 'status'}`);
  lines.push(`安装根：${body.root ?? '(未指定)'}`);
  if (body.asarPath) lines.push(`asar：${body.asarPath}（${body.fileSize ?? '?'} 字节）`);
  if (body.asarSha) lines.push(`asar sha256：${body.asarSha}`);
  if (body.dshVersion) lines.push(`DSH 版本：${body.dshVersion}`);
  if (body.state) lines.push(`分类：${body.state}${body.reason ? ` — ${body.reason}` : ''}`);
  // The layout line is the one a 0.2.0 user needs: `分类：stock` on a healthy split
  // install does NOT mean "nothing installed".
  if (body.layout !== undefined && body.layout !== null) {
    lines.push(`布局：${body.layoutLabel ?? layoutLabel(body.layout, body.doubleInstall === true)}`);
  }
  if (body.migrated === true) {
    lines.push(`迁移：从 0.1.x 槽位内补丁迁移到 0.2.0 布局（还原自 ${body.migrationBackup ?? '(未知备份)'}）`);
  } else if (body.layoutBefore === 'in-slot' && body.layout === 'split') {
    lines.push('迁移：从 0.1.x 槽位内补丁迁移到 0.2.0 布局');
  }
  if (body.refreshed === 'regrown') {
    // The ONE-ACTION upgrade: two steps, one body. Naming both reserves is what
    // makes the line useful in a support report ("it was 8 KiB, now it is 16").
    lines.push(`刷新：旧区域 ${body.reserveBefore} 字节已退回官方字节，再插入 ${body.reserveAfter} 字节`
      + `${typeof body.removedRegionBytes === 'number' ? `（先撤回 ${body.removedRegionBytes} 字节）` : ''}`);
  } else if (body.refreshed === true) {
    lines.push(`刷新：区域${body.regionRewritten === true ? '已原位改写（等长，零搬移）' : '内容没变，没动字节'}`);
  }
  if (body.noop === true) lines.push(`还原：${body.reason ?? '无需还原'}`);
  if (body.compat && typeof body.compat.summary === 'string') lines.push(`版本检查：${body.compat.summary}`);
  if (Array.isArray(body.warnings)) {
    for (const warning of body.warnings) lines.push(`  ! ${warning}`);
  }
  if (body.installState) {
    lines.push(`安装记录：${body.installState}${body.upgraded === true ? '（升级把壳桥和备份清掉了，需要重新安装）' : ''}`);
  }
  if (body.region) {
    lines.push(`托盘槽位：偏移 ${body.region.absoluteOffset ?? '?'}，长度 ${body.region.length}，sha256 ${body.region.sha256}`);
  }
  if (body.splitRegion) {
    const moved = typeof body.movedBytes === 'number' ? `，搬移 ${body.movedBytes} 字节` : '';
    lines.push(`split 区域：偏移 ${body.splitRegion.absoluteOffset ?? '?'}（main.js 内 ${body.splitRegion.startInMain ?? '?'}），`
      + `长度 ${body.splitRegion.length}，sha256 ${body.splitRegion.sha256}${moved}`);
  }
  if (typeof body.archiveSizeBefore === 'number' && typeof body.archiveSizeAfter === 'number'
    && body.archiveSizeBefore !== body.archiveSizeAfter) {
    lines.push(`asar 大小：${body.archiveSizeBefore} → ${body.archiveSizeAfter} 字节（增加 ${body.archiveSizeAfter - body.archiveSizeBefore}）`);
  }
  if (body.backupReused === true && body.backup) {
    lines.push(`备份：${body.backup.name}（复用）`);
  } else {
    lines.push(`备份：${body.backup ? `${body.backup.name}（${body.backup.size} 字节）` : '没有'}`);
  }
  if (typeof body.backupChecked === 'number' && body.backupChecked > 0) {
    lines.push(`备份校验：检查了 ${body.backupChecked} 个候选`);
  }
  if (body.prune && typeof body.prune === 'object') {
    if (body.prune.ok === true) {
      const removed = Array.isArray(body.prune.removed) ? body.prune.removed.length : 0;
      const skipped = Array.isArray(body.prune.skipped) ? body.prune.skipped.length : 0;
      lines.push(`备份保留：上限 ${body.prune.limit} 个，删掉 ${removed} 个${skipped > 0 ? `，${skipped} 个删不掉（已跳过）` : ''}`);
    } else {
      lines.push(`备份保留：清理失败 ${body.prune.code ?? 'EWRITE_FAILED'}（不影响安装）`);
    }
  }
  lines.push(`桥：${body.bridge ? `${body.bridge.path}（sha256 ${body.bridge.sha256}）` : '没有'}`);
  if (body.edited === true || body.editPaths !== undefined) {
    const applied = Array.isArray(body.editsApplied) ? body.editsApplied : [];
    const skipped = Array.isArray(body.editsSkipped) ? body.editsSkipped : [];
    if (applied.length > 0) {
      lines.push(`目录编辑：写入 ${applied.length} 个`
        + `${skipped.length > 0 ? `，跳过 ${skipped.length} 个（已做过）` : ''}`);
      for (const item of applied) {
        lines.push(`  + ${item.op} ${item.path}（${item.entrySize} 字节，丢 ${item.blocksDropped} 条 integrity.blocks，搬移 ${item.movedEntries} 个条目）`
          .replace('丢 0 条 integrity.blocks，', '')
          .replace('搬移 0 个条目）', ')'));
      }
    } else if (skipped.length > 0) {
      lines.push(`目录编辑：${body.message ?? '全部已做过，没有写字节'}`);
    }
    if (Array.isArray(body.editPaths) && body.editPaths.length > 0 && applied.length === 0) {
      lines.push(`自有条目：${body.editPaths.join('、')}（来源 ${body.editSource ?? '未知'}）`);
    }
    if (body.editJournal) {
      lines.push(`编辑日志：${body.editJournal.records} 条记录（撤回基线 ${body.editJournal.base?.sha256 ?? '未记录'}）`);
    }
  }
  if (body.editsUndone && typeof body.editsUndone === 'object') {
    const undone = Array.isArray(body.editsUndone.ops) ? body.editsUndone.ops : [];
    lines.push(`撤回编辑：${undone.length} 步（${body.editsUndone.mode === 'baseline' ? '用官方备份' : '算术可证'}）`);
    for (const item of undone) lines.push(`  - ${item}`);
  }
  if (body.mode === 'verify-edits') {
    if (body.noop === true) lines.push(`编辑日志：${body.reason ?? '空'}`);
    else if (body.reversible === true) {
      lines.push(`编辑可撤回：${body.journalRecords} 条记录（${body.route === 'baseline' ? '用官方备份' : '算术'}）`);
      if (body.predictedSha) lines.push(`  按日志撤回会得到 ${body.predictedSha}（${body.predictedSize} 字节）`);
    }
  }
  if (body.plan) lines.push(`计划：${body.plan.write.length === 0 ? '不写任何东西' : body.plan.write.join(' → ')}`);
  if (body.refused && body.refusalCode) lines.push(`拒绝：${body.refusalCode} ${body.refusalMessage}`);
  if (Array.isArray(body.candidates)) {
    const hits = body.candidates.filter((candidate) => candidate.ok === true);
    lines.push(`扫描：${body.scannedCount} 个候选，命中 ${hits.length} 个`);
    for (const hit of hits) lines.push(`  ✓ ${hit.root}（${hit.dshVersion ?? '?'}）`);
  }
  return lines.join('\n');
}

// Exported for tests: keep the helpers reachable without running the CLI.
export { EXIT, FLAG_MODES, PACKAGE_ROOT, sha256Buffer, writeFileSync, readFileSync, ensureStateDir, PATCH_MARKER, absoluteOffsetOf };
