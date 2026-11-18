/**
 * Host-side service: the only callable surface a Client half (or another plugin)
 * touches. Every method returns a JSON-serializable object shaped
 * `{ ok: true, ... }` or `{ ok: false, code, message }`.
 *
 * Writes are serialized: installing and restoring an asar are exclusive
 * operations, because two interleaved writers would corrupt the region.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FILES, PLUGIN_VERSION, BRIDGE_RELATIVE_PATH, ASAR_RELATIVE_PATH } from '../wire/constants.js';
import {
  CHANNEL_NAMES,
  CHANNEL_PAYLOAD_MAX_BYTES,
  REGION_RESERVE_BYTES,
  RESERVED_HOST_EVENT_TYPE,
} from '../wire/constants.js';

/**
 * The channels a Host-side sender may ask for, owned by ONE set.
 *
 * `pong` and `declined` are answer values, never requests. The set is declared at
 * module scope (not inside the service) so the refusal message and the check read
 * the same list.
 */
const CHANNEL_SENDABLE = new Set([
  CHANNEL_NAMES.state,
  CHANNEL_NAMES.ping,
  CHANNEL_NAMES.notify,
  CHANNEL_NAMES.window,
]);
import { ERROR_CODES, FrameworkError, toFailure } from '../wire/errors.js';
import { packageRootFrom } from './package-root.js';
import { createContributionRegistry } from './contribution.js';
import { createNotifyRegistry } from './notify-registry.js';
import { createPatchRegistry } from './patch-registry.js';
import { probeInstallPath, normalizeInputPath, normalizeInstallRoot } from '../scan/resolve.js';

/**
 * Normalise the `ops` array an `edit` request carries, or `null` when it is not
 * an array of shapes this layer understands.
 *
 * Deliberately shallow: content validation belongs to `lib/asar/edit.js`
 * (`normalizeEditRequest`), which is the ONE place that decides what a valid op
 * is. A second, stricter copy here would eventually disagree with it, and the
 * disagreement would show up as "the GUI refuses what the CLI accepts".
 *
 * @param {unknown} ops
 * @returns {Array<{ op: string, path: string, content?: unknown }>|null}
 */
function normalizeEditOps(ops) {
  if (!Array.isArray(ops)) return null;
  const out = [];
  for (const item of ops) {
    if (item === null || typeof item !== 'object') return null;
    const input = /** @type {Record<string, unknown>} */ (item);
    if (typeof input.op !== 'string' || typeof input.path !== 'string') return null;
    const normalized = { op: input.op, path: input.path };
    if (input.content !== undefined) normalized.content = input.content;
    if (input.base64 !== undefined) normalized.base64 = input.base64;
    if (input.contentFile !== undefined) normalized.contentFile = input.contentFile;
    out.push(normalized);
  }
  return out;
}

/**
 * Read the edit journal from the state directory, tolerating a broken file.
 *
 * @param {string} stateDir
 * @returns {object|null}
 */
function readEditJournalCompat(stateDir) {
  try {
    const text = readFileSync(join(stateDir, FILES.edits), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.records) || parsed.records.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve the package root from this module's location (`lib/host/service.js`).
 *
 * @returns {string}
 */
function packageRootOfSelf() {
  return packageRootFrom(import.meta.url);
}

/**
 * Spawn the installer CLI and parse its JSON result.
 *
 * `ops`, when present, rides along as ONE `--edit` argument: the CLI already knows
 * how to resolve `content` / `base64` / `contentFile`, refuses an unusable list
 * before writing anything, and journals what it does. Passing it through instead
 * of re-implementing it here is what keeps the GUI and the command line from
 * drifting apart.
 *
 * @param {{ packageRoot: string, installRoot: string, mode: 'apply'|'restore'|'status'|'dry-run'|'scan'|'verify-edits', ops?: Array<object>|null, timeoutMs?: number }} request
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, result?: unknown, stdout?: string }>}
 */
function runInstaller({ packageRoot, installRoot, mode, ops = null, timeoutMs = 120_000 }) {
  return new Promise((resolve) => {
    const script = join(packageRoot, 'scripts', 'install.mjs');
    if (!existsSync(script)) {
      resolve({ ok: false, code: ERROR_CODES.EPACKAGE_ROOT, message: `安装器不存在：${script}` });
      return;
    }
    const modeFlag = mode === 'status' ? '--status'
      : mode === 'dry-run' ? '--dry-run'
        : mode === 'scan' ? '--scan'
          : mode === 'restore' ? '--restore'
            : mode === 'verify-edits' ? '--verify-edits'
              : '--apply';
    const argv = [script, modeFlag, '--json'];
    if (installRoot) argv.push('--root', installRoot);
    if (Array.isArray(ops) && ops.length > 0) {
      const wireOps = ops.map((op) => ({
        op: op.op,
        path: op.path,
        ...(op.content === undefined ? {} : { content: op.content }),
        ...(op.base64 === undefined ? {} : { base64: op.base64 }),
        ...(op.contentFile === undefined ? {} : { contentFile: op.contentFile }),
      }));
      argv.push('--edit', JSON.stringify(wireOps));
    }
    let child;
    try {
      // The installer must run as PLAIN Node. Inside the Host, process.execPath
      // is the DSH desktop executable, and that Electron-patched fs turns
      // app.asar into a directory (size 0, ENOENT on open). Forcing
      // ELECTRON_RUN_AS_NODE=1 makes it too a plain node, and clearing the
      // variable for any non-Electron runtime keeps both paths honest.
      const childEnv = { ...process.env };
      if (typeof process.versions.electron === 'string') {
        childEnv.ELECTRON_RUN_AS_NODE = '1';
      } else {
        delete childEnv.ELECTRON_RUN_AS_NODE;
      }
      child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv });
    } catch (error) {
      resolve({ ok: false, code: ERROR_CODES.EWRITE_FAILED, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve({ ok: false, code: ERROR_CODES.ERUNNING_LOCKED, message: '安装器超时（可能被运行中的 DSH 锁住文件）' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: ERROR_CODES.EWRITE_FAILED, message: error.message });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      let parsed = null;
      const trimmed = stdout.trim();
      if (trimmed.length > 0) {
        const start = trimmed.indexOf('{');
        if (start >= 0) {
          try { parsed = JSON.parse(trimmed.slice(start)); } catch { parsed = null; }
        }
      }
      if (parsed && typeof parsed === 'object' && parsed.ok === true) {
        resolve({ ok: true, result: parsed, stdout });
        return;
      }
      const code = parsed && typeof parsed.code === 'string' ? parsed.code : exitCode === 2 ? ERROR_CODES.EFOREIGN_PATCH : ERROR_CODES.EWRITE_FAILED;
      const message = parsed && typeof parsed.message === 'string' ? parsed.message : stderr.trim() || `安装器退出码 ${exitCode}`;
      resolve({ ok: false, code, message, result: parsed, stdout });
    });
  });
}

/**
 * Build the framework service.
 *
 * @param {{
 *   ctx?: any,
 *   state: ReturnType<typeof import('./state.js').createSetupState>,
 *   stateDir: string,
 *   packageRoot?: string,
 *   powerProbe?: () => Promise<boolean>,
 *   channelSender?: (message: object) => Promise<unknown> | unknown,
 * }} options
 */
export function createFrameworkService(options) {
  const stateDir = options.stateDir;
  const packageRoot = options.packageRoot ?? packageRootOfSelf();
  // A configured install root outranks discovery; without one the state holder
  // falls back to the install record.
  /**
   * Resolve the configured install root at call time.
   *
   * The Host may fill this in later (startup discovery happens asynchronously),
   * so it must be read on every use rather than captured once. Both plain
   * strings and a getter property are accepted.
   */
  function defaultRootOf() {
    const value = options.installRoot;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  let busy = null;
  let cache = null;

  // 托盘贡献注册表：整张 `menu.json` 的写半身。它是**共享**的 —— 所有通过
  // `asarShell` 贡献菜单的插件都登记在同一个表里，合并成一份文档由桥轮询。
  const contributions = createContributionRegistry({ stateDir });
  // 通知注册表：`notify.json` 的写半身。同样共享，但它是一张**单调队列**而不是
  // 一棵持久树，所以它是独立模块（理由见 `lib/host/notify-registry.js` 头注释）。
  const notifications = createNotifyRegistry({ stateDir });
  // 动态补丁注册表：`patches.json` 的写半身。它同样共享，但它的核心不变量与另两个
  // 通道都不同（「同一份字节 ⇒ 同一套已应用的补丁」，撤走时必须**回滚**），所以
  // 它是第三个独立模块（理由见 `lib/host/patch-registry.js` 头注释，含安全边界）。
  const patches = createPatchRegistry({ stateDir });

  /** Append one audit line; never throws. */
  function audit(action, data) {
    try {
      mkdirSync(stateDir, { recursive: true });
      appendFileSync(join(stateDir, FILES.audit), `${JSON.stringify({ at: new Date().toISOString(), action, ...data })}\n`, 'utf8');
    } catch { /* auditing must never break a user action */ }
  }

  /**
   * Run one exclusive operation.
   * @template T
   * @param {string} name
   * @param {() => Promise<T>} operation
   */
  async function exclusive(name, operation) {
    if (busy !== null) {
      throw new FrameworkError(ERROR_CODES.EBUSY, `已有操作在进行中：${busy}`);
    }
    busy = name;
    try {
      return await operation();
    } finally {
      busy = null;
    }
  }

  /**
   * Is the INSTALLED region the one this build writes? The guard behind
   * `channelSend`, and the reason it can be free.
   *
   * The fact is already computed by `snapshot()`: `lib/host/state.js` folds
   * `classifyAsar`'s `matchesExpectedPatch` (a digest compare against
   * `buildSplitRegion(installed length)`) into `regionMatchesBuild`, together with
   * the region's `length` and the archive's `layout`. So this reads the cached
   * snapshot — `snapshot()` is in memory until something invalidates it — and
   * hashes nothing of its own.
   *
   * THREE answers, and each is deliberate:
   *   - `layout: 'split'` + `regionMatchesBuild: true` + the CURRENT reserve
   *     length => ok, the region claims our type and will route the message;
   *   - any other region state (an older/smaller reserve, stale bytes, an in-slot
   *     0.1.x patch, a foreign archive) => `EREGION_STALE`, because sending would
   *     reach a region that does not know `dsh-asar-bridge` and main would kill us;
   *   - no install root at all (`installRoot === null`, which is what a fresh
   *     profile sees before the install page knows where DSH is) => ALLOW, because
   *     there is no evidence of a stale region and refusing would break every
   *     existing caller that injects a sender without a configured root (the tests
   *     included). The caller's `process.send` then simply fails in main's
   *     official branch, which is the pre-existing behaviour for "no install".
   *
   * RESIDUAL GAP (precise, because it matters): this trusts `snapshot`, and a
   * snapshot is refreshed lazily. If somebody rewrites the archive behind a
   * running Host, the flag can be one refresh stale — the refresh happens on every
   * install/uninstall (both clear the cache) and on every `snapshot()` call.
   *
   * BOTH GAPS ARE DELIBERATE DECISIONS, NOT OVERSIGHTS, and they are named here so
   * a later reader does not "fix" one of them into a regression:
   *   (a) one-refresh-stale is accepted: the alternative is hashing the archive on
   *       every send, which costs hundreds of milliseconds on a 209 MB file — a
   *       guard that expensive gets removed, and then the fatal window is back for
   *       every send instead of only for a mis-timed one;
   *   (b) `installRoot === null` => ALLOWED is a decision, not a hole: without a
   *       root there is no archive to look at, so the guard would be guessing, and
   *       refusing every send from a Host that has not been pointed at an install
   *       (a plain `node` launch, a fresh profile, every unit test with an injected
   *       sender) would break callers that never had a region problem.
   *
   * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string, region: object|null }>}
   */
  async function regionVerdict() {
    let snap;
    try {
      snap = await snapshot();
    } catch (error) {
      // A snapshot that cannot be read is not evidence of a stale region; the
      // send path is allowed to proceed and fail in main, as it did before this
      // guard existed.
      return { ok: true };
    }
    if (snap === null || typeof snap !== 'object') return { ok: true };
    if (snap.installRoot === null || snap.installRoot === undefined) return { ok: true };
    const region = snap.splitRegion ?? null;
    const matches = snap.regionMatchesBuild === true;
    const currentLength = region !== null && region.length === REGION_RESERVE_BYTES;
    if (snap.layout === 'split' && region !== null && matches && currentLength) return { ok: true };
    return {
      ok: false,
      code: ERROR_CODES.EREGION_STALE,
      message: 'asar 里装着的桥区域不是本次构建写的那一份（旧版本留下的或字节已过期），'
        + '现在发这条 IPC 会被壳的官方校验判成未知消息类型，进而把 Host 子进程杀掉；'
        + '请先在安装页按「安装 / 刷新」把区域升级到本版本（一次操作即可完成），再发消息',
      region: region === null ? null : { length: region.length, sha256: region.sha256 },
      layout: snap.layout ?? null,
    };
  }

  /** Refresh and cache the snapshot; also expose it as `<stateDir>/status.json`. */
  async function snapshot(force = false) {
    if (!force && cache !== null) return cache;
    let powerAvailable = false;
    if (typeof options.powerProbe === 'function') {
      try { powerAvailable = (await options.powerProbe()) === true; } catch { powerAvailable = false; }
    }
    cache = await options.state.refresh({ powerAvailable, root: defaultRootOf() });
    try {
      mkdirSync(stateDir, { recursive: true });
      const payload = { ...cache, pluginVersion: PLUGIN_VERSION, at: new Date().toISOString() };
      const tmp = join(stateDir, `${FILES.status}.tmp-${process.pid}`);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      const { renameSync } = await import('node:fs');
      renameSync(tmp, join(stateDir, FILES.status));
    } catch { /* diagnostics only */ }
    return cache;
  }

  return {
    /** @returns {Promise<object>} */
    async snapshot() {
      try { return { ok: true, ...(await snapshot()) }; } catch (error) { return toFailure(error); }
    },

    /** Scan every drive's first level for DSH desktop install roots. */
    async scan(request = {}) {
      try {
        const scanModule = await import('../scan/scan.js');
        const result = scanModule.scanInstallRoots({ drives: request.drives, extraRoots: request.extraRoots });
        audit('scan', { scannedCount: result.scannedCount ?? 0, candidates: Array.isArray(result.candidates) ? result.candidates.length : 0 });
        return result;
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * Validate one explicit path.
     *
     * The path may be the install root, the `resources` directory, the archive
     * itself, or a folder inside `resources`; every shape normalizes to the same
     * canonical install root, and the archive is then checked for DSH identity.
     */
    async probe(request = {}) {
      try {
        const input = normalizeInputPath(request.root);
        if (input.length === 0) throw new FrameworkError(ERROR_CODES.EINVALID_INPUT, '请先填写安装目录');
        const probed = probeInstallPath(input);
        if (probed.ok !== true) {
          audit('probe', { input, ok: false, code: probed.code ?? null });
          return {
            ok: false,
            code: probed.code ?? ERROR_CODES.EINSTALL_ROOT,
            message: probed.reason ?? '这个目录不是 DSH 桌面安装目录',
            input,
            root: probed.installRoot,
            asarPath: probed.asarPath,
            dshVersion: probed.dshVersion,
            dshName: probed.dshName,
            tried: probed.tried,
          };
        }
        const root = probed.installRoot;
        const probeState = await options.state.refresh({ root });
        audit('probe', {
          input,
          root,
          shape: probed.shape,
          state: probeState.state,
          layout: probeState.layout,
          version: probeState.dshVersion,
        });
        return {
          ok: true,
          input,
          root,
          asarPath: probed.asarPath,
          shape: probed.shape,
          state: probeState.state,
          // Which of our two layouts is on disk. `state` describes the OFFICIAL
          // tray slot, which stays `stock` for a healthy 0.2.0 split install, so
          // it cannot answer "is anything installed" on its own.
          layout: probeState.layout ?? 'unknown',
          dshVersion: probeState.dshVersion ?? probed.dshVersion,
          backup: probeState.backup,
          bridge: probeState.bridge,
          installState: probeState.installState,
          compat: probeState.compat ?? null,
        };
      } catch (error) {
        return toFailure(error);
      }
    },

    /** Backup, patch the region, install the bridge. Exclusive. */
    async install(request = {}) {
      try {
        const input = normalizeInputPath(request.root);
        if (input.length === 0) throw new FrameworkError(ERROR_CODES.EINVALID_INPUT, '请先填写安装目录');
        return await exclusive('install', async () => {
          const probe = await this.probe({ root: input });
          if (probe.ok !== true) return probe;
          if (probe.state === 'foreign' || probe.state === 'unknown') {
            // `layout: 'split'` with `state: 'foreign'` is exactly the signature
            // `classifyAsar` produces for a DOUBLE INSTALL: our own 0.1.x patch
            // inside the official slot AND our 0.2.0 region after it. Both were
            // written by this package, so the message must say "two layouts", not
            // "some other tool".
            const doubleInstall = probe.layout === 'split' && probe.state === 'foreign';
            return {
              ok: false,
              code: probe.state === 'foreign' ? ERROR_CODES.EFOREIGN_PATCH : ERROR_CODES.EUNKNOWN_LAYOUT,
              message: probe.state === 'foreign'
                ? (doubleInstall
                  ? '这个 asar 里同时有 0.1.x 的槽位内补丁和 0.2.0 的自有区域（重复安装），'
                    + '两种布局不能叠加；请按 docs/RESTORE-STOCK.md 先还原成官方原样，再只装一种布局'
                  : '检测到其他工具修改过这个 asar，拒绝覆盖')
                : '无法识别这个 asar 的版本或结构，拒绝写入',
              layout: probe.layout ?? null,
              doubleInstall,
            };
          }
          if (probe.state === 'missing') {
            return { ok: false, code: ERROR_CODES.EASAR_MISSING, message: '安装目录里没有 resources\\app.asar' };
          }
          // Both of OUR layouts are a normal refresh/migration, not a refusal:
          // `layout: 'split'` means the 0.2.0 region is already installed (the
          // official slot still classifies as `stock`), and `layout: 'in-slot'`
          // means a 0.1.x install the CLI migrates. Neither may be turned down
          // here, or an installed machine could never be repaired from the GUI.
          const root = probe.root;
          const ran = await runInstaller({ packageRoot, installRoot: root, mode: 'apply' });
          audit('install', {
            root,
            input,
            layoutBefore: probe.layout ?? null,
            ok: ran.ok,
            code: ran.code ?? null,
          });
          if (ran.ok !== true) {
            return {
              ok: false,
              code: ran.code,
              message: ran.message,
              layout: probe.layout ?? null,
              layoutBefore: probe.layout ?? null,
            };
          }
          cache = null;
          const after = await snapshot(true);
          return {
            ok: true,
            root,
            asarSha: ran.result?.asarSha ?? null,
            bridgeSha: ran.result?.bridgeSha ?? (ran.result?.bridge?.sha256 ?? null),
            backup: ran.result?.backup ?? after.backup,
            dshVersion: after.dshVersion,
            state: after.state,
            // The layout the CLI actually installed, plus what it was before
            // (`in-slot` on a migration) and the two facts only a split install
            // has: the region and how many bytes had to move.
            layout: ran.result?.layout ?? after.layout ?? null,
            layoutBefore: ran.result?.layoutBefore ?? probe.layout ?? null,
            migrated: ran.result?.migrated === true,
            refreshed: ran.result?.refreshed === true,
            splitRegion: ran.result?.splitRegion ?? null,
            movedBytes: ran.result?.movedBytes ?? null,
            powerAvailable: after.powerAvailable,
          };
        });
      } catch (error) {
        return toFailure(error);
      }
    },

    /** Restore the asar from the backup. Refuses until dependents are closed. */
    async uninstall(request = {}) {
      try {
        if (request.dependentsClosed !== true) {
          return {
            ok: false,
            code: 'EDEPENDENTS_ACTIVE',
            message: '请先在插件页禁用依赖 dsh-asar-framework 的插件，再回来执行还原',
          };
        }
        const resolvedRoot = options.state.resolveRoot(request.root);
        if (!resolvedRoot) return { ok: false, code: ERROR_CODES.EINSTALL_ROOT, message: '还不知道 DSH 桌面装在哪里，请先运行一次安装页' };
        // The recorded or configured path may itself be a `resources` directory.
        const root = normalizeInstallRoot(resolvedRoot);
        return await exclusive('uninstall', async () => {
          const ran = await runInstaller({ packageRoot, installRoot: root, mode: 'restore' });
          audit('uninstall', {
            root,
            layoutBefore: ran.result?.layoutBefore ?? null,
            ok: ran.ok,
            code: ran.code ?? null,
          });
          if (ran.ok !== true) return { ok: false, code: ran.code, message: ran.message };
          options.state.markRestored('restored');
          cache = null;
          const after = await snapshot(true);
          return {
            ok: true,
            root,
            restoredSha: ran.result?.asarSha ?? null,
            bridgeRemoved: ran.result?.bridgeRemoved !== false,
            // Which layout was undone, and whether any bytes had to be moved for
            // it (`shrink` for the 0.2.0 region, a backup restore for 0.1.x,
            // nothing at all for a pristine archive).
            layout: after.layout ?? null,
            layoutBefore: ran.result?.layoutBefore ?? null,
            writeMode: ran.result?.writeMode ?? null,
            backupUsed: ran.result?.backupUsed === true,
            noop: ran.result?.noop === true,
            state: after.state,
            suppressed: true,
          };
        });
      } catch (error) {
        return toFailure(error);
      }
    },

    /** Dismiss the install page for this run. */
    async suppress() {
      try {
        options.state.suppress('dismissed');
        cache = null;
        return { ok: true, ...(await snapshot(true)) };
      } catch (error) {
        return toFailure(error);
      }
    },

    /** Bring the install page back (Settings page entry point). */
    async unsuppress() {
      try {
        options.state.unsuppress();
        cache = null;
        return { ok: true, ...(await snapshot(true)) };
      } catch (error) {
        return toFailure(error);
      }
    },

    /** Open the OS folder picker; returns `{ ok: true, path: string|null }`. */
    async pickFolder() {
      try {
        // Preferred: DSH's own directory picker service (works in Desktop and Web).
        const controller = typeof options.ctx?.get === 'function' ? options.ctx.get('directoryPickerController') : undefined;
        if (controller && typeof controller.pick === 'function') {
          const picked = await controller.pick(new AbortController().signal);
          return { ok: true, path: typeof picked === 'string' ? picked : null };
        }
        const pickerScript = join(packageRoot, 'lib', 'scan', 'picker.ps1');
        if (!existsSync(pickerScript)) return { ok: false, code: ERROR_CODES.EPICKER_FAILED, message: '缺少 folder picker 脚本' };
        const picked = await new Promise((resolve) => {
          const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', pickerScript], { windowsHide: true });
          let out = '';
          child.stdout.on('data', (chunk) => { out += chunk; });
          child.on('error', () => resolve({ ok: false }));
          child.on('close', (code) => resolve({ ok: code === 0, path: out.trim() }));
        });
        if (picked.ok !== true) return { ok: false, code: ERROR_CODES.EPICKER_FAILED, message: '打开目录选择对话框失败' };
        return { ok: true, path: picked.path.length > 0 ? picked.path : null };
      } catch (error) {
        return toFailure(error);
      }
    },

    /** Whether a quick-restart plugin is available when the user asks for it. */
    async restartHint() {
      try {
        const snap = await snapshot();
        return { ok: true, powerAvailable: snap.powerAvailable === true, endpoint: '/api/dsh-restart/request' };
      } catch (error) {
        return toFailure(error);
      }
    },

    /** Absolute paths the client may show (never secrets). */
    paths() {
      return {
        stateDir,
        packageRoot,
        bridgeRelative: BRIDGE_RELATIVE_PATH,
        asarRelative: ASAR_RELATIVE_PATH,
      };
    },

    /**
     * 托盘贡献的唯一写入口（`asarShell.contribute` / `withdraw` 都走这里）。
     *
     * 接受的请求形状（按顺序判定）：
     *  - `{ clear: true }`              → 清空整张表
     *  - `{ owner, remove: true }`      → 撤走该 owner
     *  - `{ owner, items?, tray? }`     → 登记 / 替换该 owner 的贡献
     *
     * 返回 `{ ok:true, rev, itemCount, action:'add'|'remove'|'clear' }`；
     * 校验不过返回 `{ ok:false, code, message }`，不抛异常。
     *
     * @param {{ owner?: string, items?: unknown, tray?: object, remove?: boolean, clear?: boolean }} request
     */
    async contribute(request = {}) {
      try {
        const input = request !== null && typeof request === 'object' ? request : {};
        if (input.clear === true) {
          const cleared = contributions.clear();
          if (cleared.ok !== true) return cleared;
          audit('contribute', { action: 'clear', rev: cleared.rev, cleared: cleared.cleared });
          return { ok: true, rev: cleared.rev, itemCount: cleared.itemCount, action: 'clear' };
        }
        if (input.remove === true) {
          const removed = contributions.remove(input.owner);
          if (removed.ok !== true) return removed;
          audit('contribute', { action: 'remove', owner: input.owner, rev: removed.rev, removed: removed.removed });
          return { ok: true, rev: removed.rev, itemCount: removed.itemCount, action: 'remove' };
        }
        // 文档形状就交给注册表校验：`{items, tray?}` 与裸 items 数组它都认。
        const document = { items: input.items, tray: input.tray === undefined ? undefined : input.tray };
        const added = contributions.add(input.owner, document);
        if (added.ok !== true) return added;
        audit('contribute', { action: 'add', owner: input.owner, rev: added.rev, itemCount: added.itemCount });
        return { ok: true, rev: added.rev, itemCount: added.itemCount, action: 'add' };
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * 注册表的只读快照：`{ rev, owners[], itemCount, document|null }`。
     * 不碰磁盘 —— 调用它不会产生任何写入。
     */
    async contributions() {
      try {
        return { ok: true, ...contributions.snapshot() };
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * 从字节游标读托盘事件（点击 / 勾选）。
     *
     * @param {{ cursor?: number }} request
     * @returns {Promise<{ ok: true, events: object[], cursor: number, rotated: boolean, skipped: number }>}
     */
    async events(request = {}) {
      try {
        const cursor = request !== null && typeof request === 'object' ? request.cursor : undefined;
        return contributions.readEvents(cursor);
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * 把注册表当前状态重新落盘（插件被禁用时用来对齐磁盘）。
     *
     * 注册表是**共享**的：这里只写「现在还有谁在贡献」，不主动清空；
     * 清空某个 owner 是 `contribute({owner, remove:true})` 的事。
     */
    async flushContributions() {
      try {
        return contributions.flush();
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * 通知的唯一写入口（`asarShell.notify` 走这里）。
     *
     * 一次调用 = 一条通知。请求里不认识 `remove` / `clear`：通知是一次性的，撤走
     * 单独的条目不属于这个方法的职责（要撤走就调 `withdrawNotification`）。
     *
     * @param {{ owner?: string, title?: string, body?: string, silent?: boolean, urgency?: string }} request
     * @returns {Promise<{ ok: true, rev: number, id: string, itemCount: number, dropped: number }
     *         | { ok: false, code: string, message: string }>}
     */
    async notify(request = {}) {
      try {
        const input = request !== null && typeof request === 'object' ? request : {};
        const queued = notifications.notify(input.owner, {
          title: input.title,
          body: input.body,
          silent: input.silent,
          urgency: input.urgency,
        });
        if (queued.ok !== true) {
          audit('notify', { action: 'reject', owner: input.owner ?? null, code: queued.code });
          return queued;
        }
        audit('notify', { action: 'enqueue', owner: input.owner, rev: queued.rev, dropped: queued.dropped });
        return queued;
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * 通知队列的只读快照（诊断用）：不碰磁盘 —— 调用它不会写任何文件。
     *
     * @returns {Promise<{ ok: true, rev: number, itemCount: number, owners: object[],
     *                     document: object | null }>}
     */
    async notifications() {
      try {
        return { ok: true, ...notifications.snapshot() };
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * 撤走某个 owner 的未消化通知（插件停止 / 禁用时的清理入口）。
     *
     * @param {{ owner?: string, id?: string }} request
     */
    async withdrawNotification(request = {}) {
      try {
        const input = request !== null && typeof request === 'object' ? request : {};
        const removed = notifications.withdraw(input.owner, { id: input.id });
        if (removed.ok !== true) return removed;
        audit('notify', { action: 'withdraw', owner: input.owner, removed: removed.removed });
        return removed;
      } catch (error) {
        return toFailure(error);
      }
    },

    /** 把通知队列与磁盘对齐一次（`notify.json` 被外部删掉 / 改坏时）。 */
    async flushNotifications() {
      try {
        return notifications.flush();
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * 动态补丁的唯一写入口（`asarShell.patch` / `unpatch` 都走这里）。
     *
     * 接受的请求形状（按顺序判定，和 `contribute` 同一套约定）：
     *  - `{ clear: true }`               → 清空整张表（= 回滚所有补丁）
     *  - `{ owner, remove: true }`       → 撤走该 owner（= 回滚它的补丁）
     *  - `{ owner, items: [...] }`       → 登记 / 替换该 owner 的条目
     *
     * 返回 `{ ok:true, rev, itemCount, action:'patch'|'unpatch'|'clear' }`；
     * 校验不过返回 `{ ok:false, code, message }`，不抛异常。
     *
     * ⚠️ 安全边界：`items[i].source` 是一段会在 Electron 主进程里求值的 JavaScript
     * 文本，所以**能调用这个方法**等价于**能在主进程里运行任意代码**。这条能力是
     * 有意暴露的（没有别的办法把行为注入运行中的进程），文档里写明了。
     *
     * @param {{ owner?: string, items?: unknown, remove?: boolean, clear?: boolean }} request
     */
    async patch(request = {}) {
      try {
        const input = request !== null && typeof request === 'object' ? request : {};
        if (input.clear === true) {
          const cleared = patches.clear();
          if (cleared.ok !== true) return cleared;
          audit('patch', { action: 'clear', rev: cleared.rev, cleared: cleared.cleared });
          return { ok: true, rev: cleared.rev, itemCount: cleared.itemCount, action: 'clear' };
        }
        if (input.remove === true) {
          const removed = patches.unpatch(input.owner);
          if (removed.ok !== true) return removed;
          audit('patch', { action: 'unpatch', owner: input.owner, rev: removed.rev, removed: removed.removed });
          return { ok: true, rev: removed.rev, itemCount: removed.itemCount, action: 'unpatch' };
        }
        const added = patches.patch(input.owner, input.items);
        if (added.ok !== true) {
          audit('patch', { action: 'reject', owner: input.owner, code: added.code });
          return added;
        }
        audit('patch', { action: 'patch', owner: input.owner, rev: added.rev, itemCount: added.itemCount });
        return { ok: true, rev: added.rev, itemCount: added.itemCount, action: 'patch' };
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * 补丁表的只读快照：`{ rev, owners[], itemCount, document|null }`。
     * 不碰磁盘 —— 调用它不会产生任何写入。
     */
    async patches() {
      try {
        return { ok: true, ...patches.snapshot() };
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * 把补丁表与磁盘对齐一次（`patches.json` 被外部删掉 / 改坏时）。
     *
     * 注意：这里**不清空**别人的条目。真正回滚某个 owner 永远是 owner 自己的事
     * （`patch({owner, remove:true})`）；本插件自己从不登记条目。
     */
    async flushPatches() {
      try {
        return patches.flush();
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * Directory edits on an INSTALLED archive: add a file, delete a file, or point
     * an existing file at new bytes — without repacking.
     *
     * One request shape for all three, because the CLI already has one (`--edit`):
     *   { ops: [{ op: 'append'|'remove'|'repoint', path, content? }], root? }
     *
     * WHERE THE WORK HAPPENS: this method does not write the archive itself. It
     * refuses the shapes that can never work, then runs ONE `--apply` through the
     * installer CLI with the edit list attached — the same single action a user
     * takes from the command line. That keeps "one action" true from both ends and
     * lets the CLI's journal / record / audit rules apply unchanged.
     *
     * THE TWO PRECONDITIONS, reported as refusals rather than thrown exceptions:
     *   - the archive must be one of OUR split installs, or official stock (which
     *     the same call installs first) — `EEDIT_LAYOUT` otherwise;
     *   - a `remove` needs a VERIFIED official baseline (`EBASELINE_REQUIRED`);
     *     append and repoint never do, because they preserve every existing byte.
     *
     * @param {{ ops?: unknown, root?: string }} request
     * @returns {Promise<object>} `{ ok: true, editsApplied, … }` or `{ ok: false, code, message }`
     */
    async edit(request = {}) {
      try {
        const input = request !== null && typeof request === 'object' ? request : {};
        const ops = normalizeEditOps(input.ops);
        if (ops === null) {
          return {
            ok: false,
            code: ERROR_CODES.EINVALID_INPUT,
            message: 'edit 需要 ops：一个数组，每项形如 { op: "append"|"remove"|"repoint", path, content }',
          };
        }
        if (ops.length === 0) {
          return { ok: false, code: ERROR_CODES.EINVALID_INPUT, message: 'ops 是空的，没有要做的编辑' };
        }
        const resolvedRoot = options.state.resolveRoot(input.root);
        if (resolvedRoot === null || resolvedRoot === undefined) {
          return {
            ok: false,
            code: ERROR_CODES.EINSTALL_ROOT,
            message: '还不知道 DSH 桌面装在哪里，请先在安装页指定安装目录',
          };
        }
        const root = normalizeInstallRoot(resolvedRoot);
        return await exclusive('edit', async () => {
          const probed = await this.probe({ root });
          if (probed.ok !== true) return probed;
          // Refuse the one precondition that needs a HUMAN action before
          // spawning anything: a missing verified baseline cannot be worked
          // around, and saying "failed" without saying what to do is worse than
          // saying why.
          if (ops.some((op) => op.op === 'remove') && probed.backup === null) {
            return {
              ok: false,
              code: ERROR_CODES.EBASELINE_REQUIRED,
              message: '删除一个文件会把它的字节从 asar 里彻底拿掉，之后只能靠一份校验过的官方原样备份才回得去；'
                + '这台机器现在没有可用且校验通过的官方备份，所以拒绝删除（没有写入任何字节）',
              layout: probed.layout ?? null,
              requiresBaseline: true,
              asarPath: probed.asarPath ?? null,
            };
          }
          const ran = await runInstaller({ packageRoot, installRoot: root, mode: 'apply', ops });
          audit('edit', {
            root,
            layoutBefore: probed.layout ?? null,
            ops: ops.map((op) => ({ op: op.op, path: op.path })),
            ok: ran.ok,
            code: ran.code ?? null,
          });
          if (ran.ok !== true) {
            return {
              ok: false,
              code: ran.code,
              message: ran.message,
              layout: ran.result?.layout ?? probed.layout ?? null,
              layoutApplied: ran.result?.layoutApplied === true,
              editsApplied: 0,
              requiresBaseline: ran.result?.requiresBaseline === true,
              asarPath: probed.asarPath ?? null,
              planDetail: ran.result?.planDetail ?? null,
            };
          }
          cache = null;
          const after = await snapshot(true);
          return {
            ok: true,
            root,
            asarPath: ran.result?.asarPath ?? probed.asarPath ?? null,
            asarSha: ran.result?.asarSha ?? null,
            layout: ran.result?.layout ?? after.layout ?? null,
            state: ran.result?.state ?? after.state ?? null,
            edited: true,
            editsApplied: ran.result?.editsApplied ?? [],
            editsSkipped: ran.result?.editsSkipped ?? [],
            editJournal: ran.result?.editJournal ?? null,
            archiveSizeAfter: ran.result?.archiveSizeAfter ?? null,
            layoutAsarSha: ran.result?.layoutAsarSha ?? null,
            powerAvailable: after.powerAvailable,
          };
        });
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * Read-only proof that the edit journal can be reversed — the same check
     * `--verify-edits` performs: rebuild every header the edits displaced, prove
     * each against the digest recorded before that edit, hash the whole archive
     * the undo WOULD produce, and write nothing.
     *
     * @param {{ root?: string }} request
     * @returns {Promise<object>}
     */
    async verifyEdits(request = {}) {
      try {
        const input = request !== null && typeof request === 'object' ? request : {};
        const resolvedRoot = options.state.resolveRoot(input.root);
        if (resolvedRoot === null || resolvedRoot === undefined) {
          return { ok: false, code: ERROR_CODES.EINSTALL_ROOT, message: '还不知道 DSH 桌面装在哪里' };
        }
        const root = normalizeInstallRoot(resolvedRoot);
        const ran = await runInstaller({ packageRoot, installRoot: root, mode: 'verify-edits' });
        audit('verify-edits', { root, ok: ran.ok, code: ran.code ?? null });
        return ran.ok === true
          ? { ok: true, ...ran.result }
          : { ok: false, code: ran.code, message: ran.message, detail: ran.result ?? null };
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * The edit journal as a document, or a zero-record answer when there is none.
     * Read-only; never creates the file and never touches the archive.
     *
     * @returns {object}
     */
    edits() {
      try {
        const journal = readEditJournalCompat(stateDir);
        if (journal === null) return { ok: true, records: 0, ops: [], base: null };
        return {
          ok: true,
          records: Array.isArray(journal.records) ? journal.records.length : 0,
          ops: journal.records
            .filter((record) => record !== null && typeof record === 'object')
            .map((record) => ({
              kind: record.kind ?? null,
              path: record.path ?? null,
              entryOffset: record.entryOffset ?? null,
              entrySize: record.entrySize ?? null,
              requiresBaseline: record.requiresBaseline === true,
            })),
          base: journal.base ?? null,
          asarPath: journal.asarPath ?? null,
          installRoot: journal.installRoot ?? null,
        };
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * What ONE edit may cost on THIS archive, measured read-only: the header's
     * spare padding, how many bytes `integrity.blocks` can be dropped for, and
     * therefore the byte budget of a single added entry.
     *
     * @param {{ root?: string }} request
     * @returns {Promise<object>}
     */
    async editBudget(request = {}) {
      try {
        const input = request !== null && typeof request === 'object' ? request : {};
        const resolvedRoot = options.state.resolveRoot(input.root);
        if (resolvedRoot === null || resolvedRoot === undefined) {
          return { ok: false, code: ERROR_CODES.EINSTALL_ROOT, message: '还不知道 DSH 桌面装在哪里' };
        }
        const root = normalizeInstallRoot(resolvedRoot);
        const asarPath = join(root, ...ASAR_RELATIVE_PATH.split('/'));
        if (!existsSync(asarPath)) {
          return { ok: false, code: ERROR_CODES.EASAR_MISSING, message: `安装目录里没有 ${ASAR_RELATIVE_PATH}` };
        }
        const editModule = await import('../asar/edit.js');
        const measured = await editModule.measureBudget(asarPath);
        if (measured.ok !== true) return measured;
        audit('edit-budget', { root, entryBudgetBytes: measured.entryBudgetBytes });
        return { ok: true, root, asarPath, ...measured };
      } catch (error) {
        return toFailure(error);
      }
    },

    /**
     * THE IPC FAST PATH, from the Host side: hand ONE message to the region.
     *
     * WHY THIS CAN EXIST AT ALL
     * The channel's design says the injected wrapper has no `this` and therefore
     * cannot `child.send`. That is true for the WRAPPER — but the Host process is
     * the `child`: it has `process.send` (a `stdio: [..., "ipc"]` child, spawned
     * by `lib/main.js`). So the REQUEST direction can be a real IPC message, and
     * the region's dispatcher picks it up on the other end. What stays file-only
     * is the ANSWER (`channel.out.jsonl`), because the wrapper still cannot reply.
     *
     * That is the whole point: `notify` here shows a toast and `window` here opens
     * a window BEFORE this promise resolves — the file channel would need a
     * ~700 ms poll tick first.
     *
     * EVERY FAILURE IS A REFUSAL SHAPE, NEVER A THROW:
     * `{ok:false, code, message}` for a non-sendable name, an unserialisable
     * payload, an oversize payload, a Host process with no IPC channel (a plain
     * `node` launch), or a `process.send` that throws. Nothing here can cost the
     * user his tray.
     *
     * THE SENDER IS INJECTABLE (`options.channelSender`) for exactly the same
     * reason every other capability here is: the test has to observe the message
     * without being an IPC child of Electron. Production passes nothing, so the
     * default sender is `process.send` — the real thing.
     *
     * @param {{ channel?: string, payload?: unknown }} request
     * @returns {{ ok: true, channel: string, sentAt: string }
     *         | { ok: false, code: string, message: string }}
     */
    async channelSend(request = {}) {
      try {
        const input = request !== null && typeof request === 'object' ? request : {};
        const channel = input.channel;
        if (typeof channel !== 'string' || channel.length === 0) {
          return { ok: false, code: 'EINVALID_CHANNEL', message: 'channel 必须是非空字符串' };
        }
        // The region accepts anything of our type now, but a name outside what it
        // SERVES would only produce a declined line — refuse locally with a reason.
        if (!CHANNEL_SENDABLE.has(channel)) {
          return { ok: false, code: 'EINVALID_CHANNEL', message: `本版本不处理 channel ${channel}（可用：${[...CHANNEL_SENDABLE].join(' / ')}）` };
        }
        // THE STALE-REGION GUARD — before the sender, never after.
        //
        // `process.send` with the reserved type into an OLD region is not a lost
        // message: the official `isDesktopHostEvent` answers `false`, and main
        // reacts with `this.fail()` + `child.kill("SIGTERM")`. The guard therefore
        // runs on the SENDER's side and costs one cached boolean (see
        // `regionVerdict()`), not a hash.
        const verdict = await regionVerdict();
        if (verdict.ok !== true) return verdict;
        const injected = options.channelSender;
        const sender = typeof injected === 'function' ? injected : process.send
          ? (message, callback) => process.send(message, callback)
          : null;
        if (sender === null) {
          return {
            ok: false,
            code: 'ENO_IPC',
            message: 'Host 进程没有 IPC 通道（不是被桌面壳 spawn 出来的），这条快路径不可用；请用文件通道',
          };
        }
        const payload = input.payload;
        let serialised;
        try {
          serialised = payload === undefined ? null : JSON.stringify(payload);
        } catch (error) {
          return { ok: false, code: 'EINVALID_PAYLOAD', message: `payload 无法序列化：${error instanceof Error ? error.message : String(error)}` };
        }
        if (serialised !== null && (typeof serialised !== 'string' || Buffer.byteLength(serialised, 'utf8') > CHANNEL_PAYLOAD_MAX_BYTES)) {
          return { ok: false, code: 'EPAYLOAD_TOO_LARGE', message: `payload 超过 ${CHANNEL_PAYLOAD_MAX_BYTES} 字节（区域会 decline，不截断）` };
        }
        const message = { type: RESERVED_HOST_EVENT_TYPE, channel };
        if (payload !== undefined) message.payload = payload;
        await sender(message);
        const sentAt = new Date().toISOString();
        audit('channel', { action: 'send', channel, bytes: serialised === null ? 0 : serialised.length });
        return { ok: true, channel, sentAt };
      } catch (error) {
        return toFailure(error);
      }
    },
  };
}

/** Read the persisted install record, or null. */
export function readInstallRecordAt(stateDir) {
  try {
    return JSON.parse(readFileSync(join(stateDir, FILES.install), 'utf8'));
  } catch {
    return null;
  }
}
