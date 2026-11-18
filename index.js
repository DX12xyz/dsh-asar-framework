/**
 * Host entry (`@dx12xyz/dsh-asar-framework`).
 *
 * Responsibilities, in order:
 *  1. build the setup state (read-only inspection of the install directory);
 *  2. expose the framework service through authenticated API routes;
 *  3. provide the `asarShell` Cordis service for other plugins;
 *  4. keep an in-memory "install page suppressed" flag for this run.
 *
 * The Host never writes an asar on its own: writes only happen when the user
 * presses Install or Uninstall, and they go through `scripts/install.mjs`.
 */
import { packageRootFrom } from './lib/host/package-root.js';

import { PLUGIN_VERSION, FILES, STATE_DIR_NAME, BRIDGE_RELATIVE_PATH, PACKAGE_NAME } from './lib/wire/constants.js';
import { createSetupState, stateDirOf } from './lib/host/state.js';
import { createFrameworkService } from './lib/host/service.js';
import { registerRoutes } from './lib/host/routes.js';
import { windowSurface } from './lib/host/window-registry.js';

export const name = PACKAGE_NAME;
export const version = PLUGIN_VERSION;

/** Default configuration; every field has a safe value. */
export const DEFAULT_CONFIG = {
  /** Force a specific install root instead of discovering it. */
  installRoot: null,
  /** Check for the bridge on startup (read-only). */
  checkOnStartup: true,
};

/**
 * Package root, resolved by searching upward for this package's own
 * package.json (a fixed `..` count would point at `node_modules\@dx12xyz`).
 */
const PACKAGE_ROOT = packageRootFrom(import.meta.url);

/**
 * Probe whether the quick-restart plugin is mounted in THIS Host process.
 *
 * An HTTP probe cannot work: the Host's own `fetch` carries no browser
 * credential, so `/api/dsh-restart/status` answers 401 and every snapshot
 * wrongly reported "no restart plugin" even with dsh-power enabled. The
 * in-process registry is the honest signal instead — dsh-power registers the
 * `restart_dsh_status` tool, and nothing else in the tree does.
 *
 * The client half additionally asks the route directly (it runs in the
 * browser, so its request is authenticated), which stays correct even if the
 * tool registry is restricted for a preset.
 *
 * @param {any} ctx
 * @returns {boolean}
 */
function probePower(ctx) {
  try {
    const tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined;
    if (tools && typeof tools.get === 'function') {
      if (tools.get('restart_dsh_status') !== undefined) return true;
      if (tools.get('restart_dsh_blocking_wait_safe') !== undefined) return true;
    }
    // dsh-power also provides this service; either signal is enough.
    return ctx.get('resumableToolCalls') !== undefined;
  } catch {
    return false;
  }
}

/**
 * Plugin entry.
 *
 * @param {any} ctx Cordis context
 * @param {Partial<typeof DEFAULT_CONFIG>} [config]
 */
export function apply(ctx, config = {}) {
  const resolved = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  const stateDir = stateDirOf(process.env);
  const state = createSetupState({ stateDir });

  // Remember the root this run discovered, so the service does not have to scan
  // again on every snapshot.
  let discoveredRoot = resolved.installRoot ?? undefined;

  ctx.effect(() => {
    if (resolved.checkOnStartup !== true) return () => {};
    // Read-only detection; never blocks startup and never throws.
    void (async () => {
      try {
        const initial = await state.refresh({ root: discoveredRoot });
        if (initial.installRoot !== null) return;
        // No record and no configured root: find the DSH desktop installation so
        // the install page is already filled in. Discovery is read-only; nothing
        // is written until the user presses Install.
        const { scanInstallRoots } = await import('./lib/scan/scan.js');
        const scan = scanInstallRoots({});
        const usable = (scan.candidates ?? []).filter((candidate) => candidate.ok === true);
        if (usable.length === 1) {
          discoveredRoot = usable[0].root;
          await state.refresh({ root: discoveredRoot });
        } else if (usable.length > 1) {
          // Ambiguous: leave it to the page's own scan button.
          discoveredRoot = undefined;
        }
      } catch {
        /* a failed check must not stop the Host */
      }
    })();
    return () => {};
  }, 'dsh-asar-framework startup check');

  const service = createFrameworkService({
    ctx,
    state,
    stateDir,
    packageRoot: PACKAGE_ROOT,
    get installRoot() { return discoveredRoot; },
    powerProbe: async () => probePower(ctx),
  });

  ctx.effect(() => registerRoutes(ctx, service), 'dsh-asar-framework routes');

  // Cordis service for other plugins. This release exposes the install pipeline
  // plus the tray-contribution writer (menu.json / events.jsonl).
  ctx.provide('asarShell', {
    version: PLUGIN_VERSION,
    stateDir,
    paths: service.paths(),
    snapshot: () => service.snapshot(),
    scan: (request) => service.scan(request ?? {}),
    probe: (request) => service.probe(request ?? {}),
    install: (request) => service.install(request ?? {}),
    uninstall: (request) => service.uninstall(request ?? {}),
    suppress: () => service.suppress(),
    unsuppress: () => service.unsuppress(),
    pickFolder: () => service.pickFolder(),
    // 托盘贡献（写半身）：contribute 登记/替换、withdraw 撤走、contributions 只读
    // 快照、events 从游标读回点击/勾选。四者都是 fail-soft 的，不抛异常。
    contribute: (request) => service.contribute(request ?? {}),
    withdraw: (owner) => service.contribute({ owner, remove: true }),
    contributions: () => service.contributions(),
    events: (cursor) => service.events({ cursor }),
    // 通知（写半身）：notify 入队一条、notifications 只读快照、withdrawNotification
    // 撤走某个 owner 的未消化队列。与托盘一样 fail-soft，不抛异常。
    notify: (request) => service.notify(request ?? {}),
    notifications: () => service.notifications(),
    withdrawNotification: (request) => service.withdrawNotification(request ?? {}),
    // 动态补丁（写半身，能力路线图第 3 步）：patch 登记/替换、unpatch 撤走、
    // patches 只读快照。同样 fail-soft，不抛异常。
    //
    // ⚠️ 安全边界：`items[i].source` 是一段会在 **Electron 主进程**里求值的
    // JavaScript 文本，所以「能调 `patch`」等价于「能在主进程里运行任意代码」。
    // 这不是缺陷而是这条能力的定义本身；`lib/bridge/src/patch.js` 与
    // `lib/host/patch-registry.js` 的头注释、`TECHDOC.md` §19.10 与 `README.md`
    // 都写明了。`patches()` 只读、不碰磁盘。
    patch: (request) => service.patch(request ?? {}),
    unpatch: (owner) => service.patch({ owner, remove: true }),
    patches: () => service.patches(),
    // 目录编辑（能力路线图第 1、2 步，`lib/asar/edit.js`）：往 asar 目录里加一条
    // （`appendFile`）、删一条（`removeEntry`）、把某条指向新字节（`repointEntry`），
    // 都不重新打包。三者都走同一次 `--apply`，都写进 `edits.json` 这份撤回日志，
    // 所以 `--restore` / `uninstall` 仍然是一次动作。
    //
    // 前置条件写在返回值里，不写在校验里也能看见：删除（`removeEntry`）需要一份
    // **校验过的官方原样备份**（`EBASELINE_REQUIRED`），因为删掉的字节之后不存在
    // 于任何地方；追加与重指向不需要，因为它们不动已有字节，撤回是算术可证的。
    //
    // 这条能力只在**自有 split 布局**上可用（或者官方原样，此时同一次调用先把
    // 布局装好）—— 只读入口 `editBudget` / `edits` / `verifyEdits` 也一样 fail-soft。
    edit: (request) => service.edit(request ?? {}),
    appendFile: (request) => service.edit({ ops: [{ op: 'append', path: request?.path, content: request?.content, base64: request?.base64, contentFile: request?.contentFile }], root: request?.root }),
    removeEntry: (request) => service.edit({ ops: [{ op: 'remove', path: request?.path }], root: request?.root }),
    repointEntry: (request) => service.edit({ ops: [{ op: 'repoint', path: request?.path, content: request?.content, base64: request?.base64, contentFile: request?.contentFile }], root: request?.root }),
    edits: () => service.edits(),
    editBudget: (request) => service.editBudget(request ?? {}),
    verifyEdits: (request) => service.verifyEdits(request ?? {}),
    // IPC 快路径（§19.8）：把一条 `dsh-asar-bridge` 消息交给主进程里的区域，
    // `notify` 与 `window` 因此**当场**弹窗 / 开窗口，不等 700 ms 轮询。答复仍然走
    // 文件（`channel.out.jsonl`），因为区域那个包装函数回不了 IPC。
    channelSend: (request) => service.channelSend(request ?? {}),
    ...windowSurface({ stateDir, send: (message) => service.channelSend(message) }),
  });

  // 插件被禁用 / 卸载时**不要**清空注册表：它由所有 `asarShell` 消费者共享，
  // 本插件自己并不登记任何条目（`contribute` 只代表调用方）。能做的、也该做的
  // 只是把内存里的表与磁盘对齐一次（比如 menu.json 被外部删掉），让下一轮桥轮询
  // 看到的还是「谁还在贡献」的真相。真正撤走某个 owner 永远是 owner 自己的事。
  //
  // 通知队列同理：`flushNotifications` 只把内存里的队列重新落盘，不清空 ——
  // 一条尚未被桥显示的通知在插件被禁用后仍有价值（它已经是一次用户可见事件，
  // 静默丢掉比显示出来更坏）。
  ctx.effect(() => () => { void service.flushContributions(); }, 'dsh-asar-framework contribution flush');
  ctx.effect(() => () => { void service.flushNotifications(); }, 'dsh-asar-framework notification flush');
  // 补丁表同理：只把内存里的表与磁盘对齐，**不回滚**任何别人的条目 —— 插件被禁用
  // 之后它的补丁仍然生效是**它的责任**（它该在 disable 时调 `unpatch`）。本插件自己
  // 从不登记条目，所以这里也从不主动删别人的条目。
  ctx.effect(() => () => { void service.flushPatches(); }, 'dsh-asar-framework patch flush');

  // Diagnostics file so a support report can tell what the Host saw.
  ctx.effect(() => {
    const timer = setInterval(() => {
      void service.snapshot();
    }, 10_000);
    try { timer.unref(); } catch { /* older runtimes */ }
    return () => clearInterval(timer);
  }, 'dsh-asar-framework status refresh');
}

export { FILES, STATE_DIR_NAME, BRIDGE_RELATIVE_PATH };