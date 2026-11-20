/**
 * Wire constants — the single definition of every protocol value this package
 * relies on. Changing anything here changes the asar contract, so treat it as an
 * ABI: bump PLUGIN_VERSION and re-run the whole verification suite.
 */

/** Package version; must equal package.json "version". */
export const PLUGIN_VERSION = '0.7.3';

/** Package name; also the identity check used to locate this package on disk. */
export const PACKAGE_NAME = '@dx12xyz/dsh-asar-framework';

/** State directory name under <DSH_HOME>. Never collide with other projects. */
export const STATE_DIR_NAME = 'dsh-asar-framework';

/** Product identity inside resources/app.asar "package.json". */
export const DSH_DESKTOP_PACKAGE = '@deepseek-ai/dsh-desktop';
export const ASAR_RELATIVE_PATH = 'resources/app.asar';
export const MAIN_RELATIVE_PATH = 'lib/main.js';

/** Equal-length slot inside lib/main.js that carries the DesktopTray class. */
export const REGION_START_MARKER = '//#region lib/types/tray.js';
export const REGION_END_MARKER = '//#endregion';
/**
 * Stock region length, measured on rc.2 and still identical on rc.3.
 *
 * This is NOT a gate any more: locateRegion MEASURES the slot and builds the
 * body to whatever length it finds, so a release that grows or shrinks the tray
 * region still installs. The constant survives as (a) the length this package
 * has actually verified end to end, reported as `lengthIsFamiliar`, and (b)
 * the fixture size the synthetic tests use.
 */
export const REGION_LENGTH = 1253;

/** Marker that identifies a bridge-slot patched region as ours. */
export const PATCH_MARKER = '/* dsh-asar-bridge-slot v0.1.0 */';

/** Externally loaded bridge module, relative to the install root. */
export const BRIDGE_RELATIVE_PATH = 'resources/app.asar.unpacked/dsh/tray-bridge.js';
export const BRIDGE_ABS_PATH_MESSAGE = 'resources/app.asar.unpacked/dsh/tray-bridge.js';

/**
 * An anchor token that must exist in a stock asar of the supported version.
 * A missing anchor means "unknown layout" — never patch on a guess.
 */
export const STOCK_ANCHORS = [
  '//#region lib/types/tray.js',
  'var DesktopTray = class',
  'new Tray(nativeImage.createFromPath(options.iconPath))',
  'tray.on("click", () => {',
  'setContextMenu(Menu.buildFromTemplate([',
  'tray?.destroy();',
  '//#endregion',
];

/**
 * Markers left behind by other asar injectors. Seeing any of them inside the
 * region means the slot is foreign; this package refuses to overwrite.
 */
export const FOREIGN_MARKERS = [
  'dsh-tray-restart',
  'dsh-desktop-tray:',
  'dsh-desktop-tray-patched',
  'dsh-tray-launcher',
  'dsh-retry',
  'dsh-restart-button',
  'ExitOnClose',
];

/** Directories matched by the install-path auto scan (all comparisons are lower-cased). */
export const SCAN_NAME_PATTERNS = [
  'dsh',
  'ds',
  'deepseek',
  'deepseekharness',
  'dshd',
  'deepseekharnessdesktop',
];

/** Suffix variants appended to each scan name, e.g. "dsh-harness", "dsh_d". */
export const SCAN_VARIANT_SEPARATORS = ['-', '_', ''];

/** File channel protocol versions written by the bridge / Host. */
export const PROTOCOLS = {
  menu: 2,
  events: 2,
  notify: 1,
  window: 1,
  // 动态补丁（`patches.json`）：条目里的 `source` 是**代码**，所以它有独立的协议
  // 号（和菜单的持久树、通知的一次性队列都不同，不能共享一次 bump）。
  // 桥读这一份，Host 写这一份；桥的镜像常量在 `lib/bridge/src/paths.js`
  // `PROTOCOL_PATCH`，由 `test/patch-hook.test.mjs` 钉住两边。
  patches: 1,
  // IPC 通道（`dsh-asar-bridge`）信封里的协议号。注入区域里那个 handler 把它写进
  // 自己产出的每一行；区域不能 import 本文件，所以区域那份字面量由
  // `test/split-surgery.test.mjs` 从区域字节里抽出来比对。
  channel: 1,
};

/**
 * File names under <stateDir>. Host and bridge must agree exactly; a mismatch
 * means "Host writes A, bridge reads B".
 */
export const FILES = {
  install: 'install.json',
  audit: 'audit.jsonl',
  bridge: 'bridge.json',
  bridgeLoad: 'bridge.load.json',
  menu: 'menu.json',
  events: 'events.jsonl',
  // 通知贡献（`PROTOCOLS.notify`），由桥侧 `lib/bridge/src/notify.js` 轮询读取。
  // 桥的镜像常量 `lib/bridge/src/paths.js` 里有同名同值的副本；两边必须一致。
  notify: 'notify.json',
  uninstallFlow: 'uninstall-flow.json',
  status: 'status.json',
  // IPC 通道（`dsh-asar-bridge`）的两个方向靠**不同的东西**说话：
  //
  // 请求 = 真 IPC：Host 进程本身就是被主进程 `stdio: [..., "ipc"]` spawn 出来的
  //        子进程，所以它有自己的 `process.send`（`asarShell.channelSend`）。
  // 答复 = 文件：主进程里接受这条消息的是注入区域的包装函数，它是模块顶层的普通
  //        函数、**没有 `this`**，够不到 `child.send`（见 patch-body.js 的 IPC 段）。
  //
  // 所以这里只有 ACK 方向（out）。曾经还有一个 `channel.in.jsonl`（由
  // `channel.js` 的 `send()` 写），但**生产上两侧都没人用**：Host 走真 IPC，桥的
  // `send()` 在 `kernel.js` 里 0 次调用，那个文件既没有写者也没有读者，到了
  // 2026-11-16 的审计（第 8 项）就被删掉了——留一个没人写、没人读的队列比没有更糟。
  //
  // 信封形状 `{protocol, channel, at, received}`；`*.1` 是唯一轮转槽（和
  // events.jsonl 同一套纪律）。桥的镜像常量在 `lib/bridge/src/paths.js`，
  // 由 `test/channel.test.mjs` 钉住。
  channelOut: 'channel.out.jsonl',
  channelOutRotated: 'channel.out.jsonl.1',
  // 动态补丁（`PROTOCOLS.patches`）：Host 写、桥读的一份**代码**文档，见
  // `lib/host/patch-registry.js`（写半身）与 `lib/bridge/src/patch.js`（读半身 +
  // `Module._load` 钩子 + 开机重放）。桥的镜像常量 `lib/bridge/src/paths.js`
  // `FILES.patches` 有同名同值的副本，由 `test/patch-hook.test.mjs` 钉住两边。
  //
  // 安全边界：`source` 是在主进程里求值的 JavaScript 文本，所以「能写这个文件」
  // 等价于「能在主进程里运行任意代码」。文档里写明了，不许含糊。
  patches: 'patches.json',
  /**
   * L'edit journal* (`FILES.edits`): the inverse record of every append /
   * remove / repoint this package performed on an asar, kept as ONE document so
   * `--restore` can undo them before it shrinks the split region.
   *
   * WHY THE STATE DIR AND NOT THE ARCHIVE: the archive's directory must keep its
   * exact byte length for an edit to be reversible, so there is no room to store
   * a receipt inside it — and a marker inside the archived bytes would change the
   * very length the technique depends on. The journal therefore lives beside the
   * install record, and classification treats "journal + matching path" as the
   * proof that the appended entry is OURS (see `lib/asar/classify.js`).
   */
  edits: 'edits.json',
};

/** Upper bound for a contribution document, in bytes. */
export const MENU_MAX_BYTES = 256 * 1024;

/**
 * How many `app.asar.*.bak` copies may sit beside the archive. Older ones are
 * pruned (`lib/install/retention.js`).
 *
 * Why 5: one copy is a full stream copy of `app.asar` — 209,021,953 bytes, about
 * 209 MB, measured on the rc.3 install — so an unbounded pile quietly turns the
 * install directory into a disk hog. Five keeps a few restore points (roughly
 * one per version installed) while staying under about a gigabyte.
 *
 * Two invariants hold whatever the number is: pruning never deletes the *only*
 * copy that could still restore this machine (the digest the install recorded is
 * always exempt), and a limit below 1 is clamped to 1, because "keep none" would
 * delete the baseline itself.
 */
export const BACKUP_KEEP_LIMIT = 5;

/** Installed / not-installed detection window used by the client overlay. */
export const SETUP_POLL_MS = 5000;

/* ------------------------------------------------------------------------- *
 * Split-region layout (v0.2.0)
 *
 * A SECOND way to carry our DesktopTray implementation: leave the official
 * 1,253-byte tray slot byte-for-byte pristine and insert a region of our own
 * immediately after it, shifting everything that follows in `lib/main.js`.
 *
 * Measured on the shipped rc.3 archive (see evidence/split-region-proto.mjs):
 * the official slot ends at in-file byte 780,642, directly followed by
 * `\n//#region lib/types/background-notice.js`; 29 entries (993,917 B) plus the
 * 67,863 B tail of `lib/main.js` have to move, i.e. 1,061,780 B.
 *
 * Everything below is additive: the 0.1.x in-slot values further up are
 * untouched, because 0.1.x installs still have to be detected and restored.
 * ------------------------------------------------------------------------- */

/**
 * Bytes reserved for the injected region that sits AFTER the pristine official
 * tray slot.
 *
 * Raised from 8,192 to 16,384 when the channel stopped being a file-only detour
 * and grew two real channels (`notify`, `window`): the region now carries a
 * notification constructor, a window-spec validator and a bounded window
 * registry. Measured: the body needs `SPLIT_MINIMUM_REGION_LENGTH` bytes, so the
 * spare is what `test/split-surgery.test.mjs` asserts stays above 1,000 B.
 *
 * This is still a PACKAGING decision, not a promise about the header: the hard
 * ceiling is {@link REGION_RESERVE_LIMIT}, and `planSplit` re-measures the
 * boundary from the archive in front of it.
 */
export const REGION_RESERVE_BYTES = 16384;

/**
 * Start marker of OUR split region.
 *
 * Deliberately different from {@link REGION_START_MARKER}: `locateRegion` must
 * keep resolving the official slot first, and state detection must be able to
 * tell "official slot" from "our inserted region" by markers alone.
 */
export const SPLIT_START_MARKER = '//#region lib/dsh-asar-bridge.js';

/**
 * Marker that identifies our split region (never the official slot).
 *
 * The version in the text is part of the contract: a `v0.1.0` marker inside a
 * region means the old in-slot patch, which is detected and restored by the
 * 0.1.x code paths, not by this one.
 */
export const SPLIT_PATCH_MARKER = '/* dsh-asar-bridge-slot v0.2.0 */';

/**
 * Largest reserve that still keeps the directory header at its original byte
 * length (measured).
 *
 * The reverse surgery reproduces the stock archive byte-for-byte only while the
 * serialised header keeps its exact length. Rewriting `lib/main.js`.`size` from
 * 848,505 to 1,000,000 adds a seventh digit, and `integrity.blocks` would then
 * have to be dropped to pay the byte back — which is exactly what would make
 * "uninstall == stock archive" false. 848,505 + 151,494 = 999,999; one byte
 * more rolls the digit count over, so 151,494 is the boundary.
 *
 * This is a MEASURED number, not a promise about future builds: `planSplit`
 * re-measures the boundary from the archive in front of it and refuses by the
 * measurement, not by this constant.
 */
export const REGION_RESERVE_LIMIT = 151494;

/**
 * Hard ceiling on the `payload` of one `dsh-asar-bridge` message, in SERIALISED
 * bytes (4,096).
 *
 * The region refuses anything bigger, so a hostile writer cannot park megabytes
 * in main's IPC queue: Electron has already copied the object across the process
 * boundary by the time the guard sees it, which is exactly why the cap has to be
 * a refusal and not a truncation. Both halves of the channel (`patch-body.js` and
 * `lib/bridge/src/channel.js`) carry this number; `test/channel.test.mjs` pins
 * them together.
 */
export const CHANNEL_PAYLOAD_MAX_BYTES = 4096;

/**
 * The ONE extra IPC message type this package claims.
 *
 * It has to live HERE, next to the channel vocabulary, because two very different
 * processes need it: the injected region (which is the thing main validates) and
 * the Host process (which is the thing that SENDS it — `process.send` is the
 * request direction; see `lib/host/service.js` `channelSend`). A literal typed
 * twice would eventually disagree, and a disagreement means "the Host sends a
 * type the region does not claim", i.e. main kills the child.
 */
export const RESERVED_HOST_EVENT_TYPE = 'dsh-asar-bridge';

/**
 * Ceiling on ONE channel envelope line, and the rotation threshold of the
 * channel file (8,192 B).
 *
 * Both derive from {@link CHANNEL_PAYLOAD_MAX_BYTES} instead of being typed
 * again: a maximal payload plus the envelope's own fields must still fit
 * ({@link CHANNEL_ENVELOPE_MAX_BYTES} = payload cap + 256 B of fixed fields), and
 * the file keeps at most TWO envelopes before rotating to its single `.1` slot.
 * So the whole disk cost of this channel is 16,384 B, no matter what a hostile
 * writer sends: one 8 KiB live file plus one 8 KiB rotated file.
 */
export const CHANNEL_ENVELOPE_MAX_BYTES = CHANNEL_PAYLOAD_MAX_BYTES + 256;
export const CHANNEL_MAX_BYTES = 2 * CHANNEL_PAYLOAD_MAX_BYTES;

/**
 * Caps on the ONE-TOAST payload of `channel: "notify"`, in CHARACTERS.
 *
 * Same numbers the Host-side queue already enforces
 * (`lib/host/notify-registry.js` `NOTIFY_TITLE_LIMIT` / `NOTIFY_BODY_LIMIT`):
 * the region is the fast path of the same capability, so "how long a toast may
 * be" must not depend on which half delivered it. They are duplicated here — and
 * not imported from the Host — because the region ships literals and a Host
 * module must not become a build-time dependency of the region's body.
 * `test/split-surgery.test.mjs` asserts the two pairs are equal, so a change to
 * one without the other fails.
 */
export const CHANNEL_NOTIFY_TITLE_MAX = 200;
export const CHANNEL_NOTIFY_BODY_MAX = 2048;

/**
 * The only `channel` names the shipped region handles, and the shape every
 * message's `channel` field must match before the region looks at the name at
 * all.
 *
 * `state`  echo the bounded payload back (diagnostic).
 * `ping`   answered with `pong` (diagnostic).
 * `notify` construct a REAL Electron notification, immediately (v0.2.0).
 * `window` construct a REAL BrowserWindow from a bounded window spec (v0.2.0).
 *
 * `pong` and `declined` are ANSWER values, never channel names a caller may send
 * or that the region would route on: `pong` is what `ping` is answered with, and
 * `declined` is the envelope name every refused-but-accepted message is recorded
 * under (see `PROTOCOLS.channel` and `patch-body.js`).
 *
 * WHY THE VOCABULARY CANNOT BE "ANY STRING THAT PASSED THE REGEX" ANY MORE:
 * it used to be, and a misspelled name was answered `false` — which main
 * interprets as "the official validator rejected this message" and responds to
 * by killing the Host child. That outcome is now impossible: unknown names are
 * RECORDED as declined and answered `true`. The vocabulary is what decides
 * whether a message does something, not whether the user keeps his session.
 */
export const CHANNEL_NAMES = Object.freeze({
  state: 'state',
  ping: 'ping',
  pong: 'pong',
  notify: 'notify',
  window: 'window',
  declined: 'declined',
});

/** The `channel` field shape every channel message must satisfy (body only). */
export const CHANNEL_NAME_PATTERN = '^[a-z][a-z0-9-]{0,31}$';

