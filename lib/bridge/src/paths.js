/**
 * Paths, wire constants and fail-soft file primitives for the tray bridge.
 *
 * The bridge ships as one standalone CommonJS file inside
 * `app.asar.unpacked`, so it cannot import the Host's `lib/wire/constants.js`.
 * The values below therefore mirror it; the wire-copy assertions in
 * `pkg/test/bridge-notify.test.mjs` pin the two copies together (FILES, the
 * menu/notify protocol numbers and the two notification ceilings), so a change
 * in one place cannot drift silently.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Bridge identity; also written into `bridge.load.json` and `bridge.json`.
 *
 * THIS STRING IS HOW A SUPPORT REPORT ANSWERS "WHICH BRIDGE IS ACTUALLY LOADED".
 * `bridge.load.json` is written by the bridge the patched main process loaded,
 * and `bridge.json` by the same one on every render — so `grep version
 * <stateDir>/bridge.load.json` distinguishes "we are running the artefact
 * deployed with 0.4.0" from "an older build is still on disk" WITHOUT trusting
 * `status.json` (which the Host writes) and without hashing anything.
 *
 * It therefore has to track the package version the artefact was built from:
 * `PLUGIN_VERSION` in `lib/wire/constants.js` and `package.json`'s `version`
 * are the source of truth, and the three are bumped together by the release
 * owner. It stayed at `'0.1.0'` for three releases, which made `bridge.load.json`
 * useless for exactly this question (audit 2026-11-16, item 9).
 */
export const BRIDGE_VERSION = '0.7.3';

/** Wire protocol version of menu.json and events.jsonl. */
export const PROTOCOL = 2;

/**
 * Wire protocol version of `notify.json`.
 *
 * Its own number, not `PROTOCOL`: the notification channel is one-shot data
 * (a queue of toasts) while the menu channel is a persistent tree, so the two
 * documents must be able to evolve independently without a shared bump.
 */
export const PROTOCOL_NOTIFY = 1;

/** State directory name below <DSH_HOME>. */
export const STATE_DIR_NAME = 'dsh-asar-framework';

/** Files the bridge reads or writes inside the state directory. */
export const FILES = {
  load: 'bridge.load.json',
  status: 'bridge.json',
  menu: 'menu.json',
  events: 'events.jsonl',
  eventsRotated: 'events.jsonl.1',
  notify: 'notify.json',
  notifyState: 'notify.state.json',
  // IPC 通道（`dsh-asar-bridge`）只留 ACK 方向；`lib/wire/constants.js` 的
  // `FILES` 里有同名同值的副本（`test/channel.test.mjs` 钉住两边）。
  //
  // 通道为什么落到文件上：主进程里接受这条消息的是注入区域的包装函数，它是模块
  // 顶层的普通函数、**没有 `this`**，因此够不到 `child.send` —— 回不了 IPC。能回的
  // 方向只有「区域写文件、别人读文件」。
  //
  // 请求方向没有文件：Host 进程自己就是 IPC 子进程，走 `process.send`
  // （`asarShell.channelSend`）。曾经有个 `channel.in.jsonl` 镜像它，但 `send()`
  // 在 `kernel.js` 里 0 次被调用，没人写也没人读，0.4.0 已删除（审计第 8 项）。
  channelOut: 'channel.out.jsonl',
  channelOutRotated: 'channel.out.jsonl.1',
  // 声明式动态补丁（`PROTOCOL_PATCH`）：Host 写、桥读的一份**代码**文档，见
  // `lib/bridge/src/patch.js` 与 `lib/host/patch-registry.js`。`lib/wire/constants.js`
  // 的 `FILES` 里有同名同值的副本（`test/patch-hook.test.mjs` 钉住两边）。
  patches: 'patches.json',
};

/**
 * Wire protocol version of the IPC channel envelope.
 *
 * Not `PROTOCOL`: that number is the menu/events JSON contract, which has its own
 * revision history. A `dsh-asar-bridge` message carries `protocol: 1` inside the
 * envelope it writes, and the bridge checks that number before believing a line.
 */
export const PROTOCOL_CHANNEL = 1;

/**
 * Wire protocol version of `patches.json`.
 *
 * Its own number, like `PROTOCOL_NOTIFY` and `PROTOCOL_CHANNEL`: the patch
 * document is a CODE contract (a list of function sources) while the menu is a
 * TREE of plain data, so the two must be able to evolve without a shared bump.
 * A document carrying any other number is refused whole — an unreadable contract
 * is not half-honoured (`lib/bridge/src/patch.js` `parsePatchSpec`).
 */
export const PROTOCOL_PATCH = 1;

/** Hard ceiling on one channel envelope, in bytes (the region enforces the same cap). */
export const CHANNEL_ENVELOPE_MAX_BYTES = 4096 + 256;

/** Rotation threshold for a channel file; one rotated slot is kept (events.jsonl discipline). */
export const CHANNEL_MAX_BYTES = 2 * 4096;

/** Hard ceiling on a channel `payload`, in serialised bytes (the region's cap). */
export const CHANNEL_PAYLOAD_MAX_BYTES = 4096;

/** The `channel` field shape every channel message must satisfy (body only). */
export const CHANNEL_NAME_PATTERN = '^[a-z][a-z0-9-]{0,31}$';

/**
 * The channel vocabulary: the names the region HANDLES.
 *
 * `state` (echo) and `ping` (→ `pong`) are diagnostics; `notify` and `window`
 * are the two REAL capabilities the region gained: a toast shown immediately
 * (`Notification`) and a window constructed from a bounded spec (`BrowserWindow`),
 * both inside the Electron main process, with no poll interval in the way.
 *
 * `pong` is the value `ping` is answered WITH and `declined` is the name a
 * refused-but-accepted message is recorded under: both are part of the
 * vocabulary, neither is a channel a caller may send.
 */
export const CHANNEL_NAMES = Object.freeze({
  state: 'state',
  ping: 'ping',
  pong: 'pong',
  notify: 'notify',
  window: 'window',
  declined: 'declined',
});

/** Contribution document ceiling (256 KiB); anything bigger counts as no contribution. */
export const MENU_MAX_BYTES = 256 * 1024;

/**
 * `notify.json` ceiling (32 KiB).
 *
 * Two orders of magnitude below the menu budget on purpose: a notification
 * document holds short one-shot strings, and the Host writer caps the queue at
 * 64 items of at most 256 + 2,048 bytes, i.e. well under this. Hitting the
 * ceiling therefore means somebody else wrote the file, and that is exactly
 * when reading it must stop being a plan.
 */
export const NOTIFY_MAX_BYTES = 32 * 1024;

/** events.jsonl rotation threshold (512 KiB). */
export const EVENTS_MAX_BYTES = 512 * 1024;

/** menu.json poll interval in milliseconds. */
export const POLL_MS = 700;

/**
 * How many menu poll ticks pass between two artefact-identity checks (17).
 *
 * 17 × 700 ms ≈ 11.9 s. The check is ONE `statSync` of a local file (microseconds
 * — measured, not assumed: a `stat` on the same volume as the process is a single
 * metadata lookup that stays in the OS directory cache, and this artefact is
 * ~100 KB sitting next to the executable, not on a network share). At one check
 * per tick it would still be cheap, but it would be ~1,235 syscalls a minute for
 * a file that changes when a human edits it; the relevant latency is therefore
 * "a bridge update lands while the user is still looking at the tray", not
 * milliseconds. 17 is deliberately NOT a multiple of {@link NOTIFY_POLL_EVERY}
 * (3): sharing a cadence would make the check and the notification read collide
 * on the same tick, doubling the work of one tick and leaving twelve ticks idle.
 *
 * @type {number}
 */
export const RELOAD_POLL_EVERY = 17;

/**
 * How many menu poll ticks pass between two `patches.json` reads (5 → ~3.5 s).
 *
 * WHY NOT EVERY TICK: the document is a CODE spec that only changes when a human
 * or a plugin rewrites it, so the relevant latency is "a patch lands while the
 * user is still setting it up", not milliseconds. 5 × 700 ms keeps the steady
 * cost at one `stat` of a local file every 3.5 s, and — like
 * {@link RELOAD_POLL_EVERY} — the number is deliberately NOT a multiple of
 * {@link NOTIFY_POLL_EVERY} (3), so the three channels never all wake on the same
 * tick.
 *
 * @type {number}
 */
export const PATCH_POLL_EVERY = 5;

/**
 * Steady-state ceiling on the `reload` diagnostics block: `attempts` and
 * `succeeded` are counters that must stay bounded (a counter that grows by one
 * per second would eventually make `bridge.json` unreadable), and one string
 * carries the last failure.
 *
 * @type {number}
 */
export const RELOAD_MAX_ATTEMPTS = 0x7fffffff;

/**
 * How many menu poll ticks pass between two `notify.json` reads (3 → ~2.1 s).
 *
 * The menu is a channel a click is waiting on, so 700 ms is the right budget
 * there. A toast is not: 2.1 s is imperceptible to a human, and the file is
 * almost always ABSENT, so the slower cadence cuts two thirds of the `stat`
 * calls on a channel that has nothing to say most of the time. The poll is
 * also piggy-backed on `relabel()`, which is the user-driven refresh path, so
 * a visible refresh makes the notification channel catch up immediately.
 */
export const NOTIFY_POLL_EVERY = 3;

/**
 * Hard cap on notifications this bridge will SHOW in one sliding window.
 *
 * Four per minute: a user-facing toast steals focus and lands in the OS
 * Action Center, so four is already loud enough to be a real event and rare
 * enough not to be noise. The cap is GLOBAL rather than per owner because the
 * scarce resource (the user's attention, and the OS toast queue) is global: a
 * per-owner budget would let N plugins each pass their own test while the
 * screen still floods. Skipped items are dropped permanently and counted in
 * `status().notify.rateLimited`; the notification is one-shot, so re-showing a
 * suppressed toast later would be a worse lie than losing it.
 */
export const NOTIFY_RATE_LIMIT = 4;

/** Length of the sliding window {@link NOTIFY_RATE_LIMIT} is measured over. */
export const NOTIFY_RATE_WINDOW_MS = 60 * 1000;

/** Deepest contribution nesting the bridge renders (defensive bound). */
export const MAX_MENU_DEPTH = 3;

/**
 * Resolve the state directory.
 *
 * Precedence is exactly the contract: `DSH_HOME` first, then `~/.dsh`, and
 * always with `STATE_DIR_NAME` appended.
 *
 * @returns {string} absolute-or-relative path of the state directory
 */
export function resolveStateDir() {
  let base = null;
  const fromEnvironment = typeof process !== 'undefined' && process.env ? process.env.DSH_HOME : undefined;
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') base = fromEnvironment.trim();
  if (base === null) {
    try {
      base = join(homedir(), '.dsh');
    } catch (_error) {
      base = null;
    }
  }
  if (base === null || base === '') return STATE_DIR_NAME;
  return join(base, STATE_DIR_NAME);
}

/**
 * The artefact's identity on disk: `size + ':' + mtimeMs`, or `''` when it
 * cannot be read.
 *
 * WHY THIS PAIR OF NUMBERS: a `size` alone misses an in-place edit that keeps
 * the length (a version bump inside an otherwise identical file), and an mtime
 * alone misses a copy whose timestamp an installer preserved (`cp -p`, robocopy
 * `/DCOPY:T`). Together they are the cheapest identity that answers the only
 * question the watcher asks: "is this file still the one the running code came
 * from?" A hash would answer it better and cost a full read of ~100 KB every
 * check, which is the one thing this design refuses to put on a timer.
 *
 * @param {string} file
 * @returns {string} the tag, or '' when the file is absent/unreadable/not a file
 */
export function artefactTag(file) {
  try {
    const stats = statSync(file);
    if (!stats.isFile()) return '';
    return stats.size + ':' + stats.mtimeMs;
  } catch (_error) {
    return '';
  }
}

/**
 * The reload decision rule: SHIPPED, pure, total.
 *
 * `remembered === undefined` means nothing has been judged yet (the first tick
 * after construction): record the tag, decide nothing. An empty tag means the
 * file could not be stat'ed: keep what works — a transient lock on a file that
 * is being replaced is not a reason to drop the tray. Otherwise reload exactly
 * when the identity changed.
 *
 * `test/bridge-hot-reload.test.mjs` drives this table directly, so the rule the
 * tests assert and the rule the shipped artefact runs are the same function.
 *
 * @param {string} tag identity of the artefact on disk, `''` when unstatable
 * @param {string|undefined} remembered the tag the watcher has already judged
 * @returns {boolean} true when the artefact must be re-required
 */
export function bridgeArtefactChanged(tag, remembered) {
  if (remembered === undefined) return false; // nothing judged yet
  if (tag === '') return false; // unstatable: keep what works
  return tag !== remembered; // a new identity
}

/**
 * Create the state directory, creating parents as needed.
 *
 * @param {string} dir
 * @returns {{ ok: boolean, error: string | null }}
 */
export function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/**
 * Read the contribution document without ever throwing.
 *
 * The returned fingerprint is the identity used to decide whether a poll tick
 * must re-render: identical text means identical rendering input, which is
 * strictly stronger than comparing `rev` or a hash.
 *
 * @param {string} file absolute path of menu.json
 * @returns {{ kind: 'missing' | 'text' | 'oversize' | 'error', text: string | null,
 *             fingerprint: string, error: string | null }}
 */
export function readMenuSource(file) {
  let stats;
  try {
    stats = statSync(file);
  } catch (error) {
    if (isMissingFile(error)) return { kind: 'missing', text: null, fingerprint: 'missing', error: null };
    return { kind: 'error', text: null, fingerprint: 'stat-error:' + messageOf(error), error: messageOf(error) };
  }
  if (!stats.isFile()) {
    return { kind: 'error', text: null, fingerprint: 'not-a-file', error: 'menu.json is not a regular file' };
  }
  if (stats.size > MENU_MAX_BYTES) {
    return {
      kind: 'oversize',
      text: null,
      fingerprint: 'oversize:' + stats.size,
      error: 'menu.json is ' + stats.size + ' bytes; the limit is ' + MENU_MAX_BYTES + ' bytes (256 KiB)',
    };
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { kind: 'error', text: null, fingerprint: 'read-error:' + messageOf(error), error: messageOf(error) };
  }
  if (typeof text !== 'string') {
    return { kind: 'error', text: null, fingerprint: 'read-empty', error: 'menu.json could not be decoded' };
  }
  if (byteLength(text) > MENU_MAX_BYTES) {
    return {
      kind: 'oversize',
      text: null,
      fingerprint: 'oversize-text:' + text.length,
      error: 'menu.json exceeds the ' + MENU_MAX_BYTES + ' byte limit (256 KiB)',
    };
  }
  return { kind: 'text', text, fingerprint: 'text:' + text, error: null };
}

/**
 * Read a contribution document without ever throwing — the same ladder
 * {@link readMenuSource} walks, with the ceiling, the label and therefore the
 * failure TEXT parameterised.
 *
 * The two are deliberately NOT merged: `readMenuSource`'s wording ("the limit is
 * N bytes (256 KiB)") is pinned by `test/bridge-recovery.test.mjs`, and a shared
 * implementation would silently reword a shipped diagnostic to save thirty lines.
 * What is shared is the DECISION ladder (missing / not-a-file / too big / error),
 * and both copies say so next to each other so a change made in one is visible
 * from the other.
 *
 * @param {string} file absolute path of the document
 * @param {{ maxBytes: number, label: string }} limits
 * @returns {{ kind: 'missing' | 'text' | 'oversize' | 'error', text: string | null,
 *             fingerprint: string, error: string | null }}
 */
export function readContributionSource(file, limits) {
  const maxBytes = limits !== null && typeof limits === 'object' && typeof limits.maxBytes === 'number'
    ? limits.maxBytes
    : MENU_MAX_BYTES;
  const label = limits !== null && typeof limits === 'object' && typeof limits.label === 'string'
    ? limits.label
    : 'contribution document';

  let stats;
  try {
    stats = statSync(file);
  } catch (error) {
    if (isMissingFile(error)) return { kind: 'missing', text: null, fingerprint: 'missing', error: null };
    return { kind: 'error', text: null, fingerprint: 'stat-error:' + messageOf(error), error: messageOf(error) };
  }
  if (!stats.isFile()) {
    return { kind: 'error', text: null, fingerprint: 'not-a-file', error: label + ' is not a regular file' };
  }
  if (stats.size > maxBytes) {
    return {
      kind: 'oversize',
      text: null,
      fingerprint: 'oversize:' + stats.size,
      error: label + ' is ' + stats.size + ' bytes; the limit is ' + maxBytes + ' bytes',
    };
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { kind: 'error', text: null, fingerprint: 'read-error:' + messageOf(error), error: messageOf(error) };
  }
  if (typeof text !== 'string') {
    return { kind: 'error', text: null, fingerprint: 'read-empty', error: label + ' could not be decoded' };
  }
  if (byteLength(text) > maxBytes) {
    return {
      kind: 'oversize',
      text: null,
      fingerprint: 'oversize-text:' + text.length,
      error: label + ' exceeds the ' + maxBytes + ' byte limit',
    };
  }
  return { kind: 'text', text, fingerprint: 'text:' + text, error: null };
}

/**
 * Read a small JSON state document (the bridge's own persisted memory).
 *
 * A missing file is not an error — that is the honest "nothing remembered yet"
 * case — and neither is a corrupt one: the bridge recomputes its state from the
 * live document instead of refusing to run.
 *
 * @param {string} file
 * @returns {unknown} the parsed value, or null when absent/unreadable
 */
export function readJsonState(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (_error) {
    return null;
  }
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

/**
 * Replace a text file atomically (temp file in the same directory, then rename).
 *
 * @param {string} file
 * @param {string} text
 * @returns {{ ok: boolean, error: string | null }}
 */
export function writeTextAtomic(file, text) {
  const temporary = file + '.tmp';
  try {
    writeFileSync(temporary, text, 'utf8');
    renameSync(temporary, file);
    return { ok: true, error: null };
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch (_cleanupError) {
      // Nothing else to do: the caller already gets the original failure.
    }
    return { ok: false, error: messageOf(error) };
  }
}

/**
 * Append one JSON line to an append-only channel, rotating it when it grows
 * past `maxBytes`.
 *
 * @param {string} file the live channel file
 * @param {string} rotatedFile the single retained previous file
 * @param {string} line one complete line, newline included
 * @param {number} maxBytes rotation threshold
 * @returns {{ ok: boolean, error: string | null }}
 */
export function appendJsonLine(file, rotatedFile, line, maxBytes) {
  try {
    const stats = statOrNull(file);
    if (stats !== null && stats.isFile() && stats.size > maxBytes) rotateFile(file, rotatedFile);
    appendFileSync(file, line, 'utf8');
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** Move the live channel file to its single rotated slot, ignoring failures. */
function rotateFile(file, rotatedFile) {
  try {
    rmSync(rotatedFile, { force: true });
  } catch (_error) {
    // A reader holding the rotated file open on Windows is not fatal.
  }
  try {
    renameSync(file, rotatedFile);
  } catch (_error) {
    // Keep appending to the live file: losing the click is worse than growing it.
  }
}

/** @returns {import('node:fs').Stats | null} stats, or null when the file is absent */
function statOrNull(file) {
  try {
    return statSync(file);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

/** @returns {boolean} true for "the file is not there" errors only */
function isMissingFile(error) {
  return error !== null && typeof error === 'object' && error.code === 'ENOENT';
}

/**
 * Serialize one click/toggle record as a single JSONL line.
 *
 * Keys are written in a fixed order and `JSON.stringify` escapes every control
 * character, so the result can never contain a raw newline: one record is
 * always exactly one line.
 *
 * `owner` is appended last and only when supplied, so every record written
 * before the notification channel existed keeps its exact bytes
 * (`test/contribution.test.mjs` pins those lines). A `notify-click` carries it
 * because its `id` is the notification's own id, not an `owner#localId` menu id:
 * the Host decodes menu events by splitting on `#`, and a toast id has no such
 * structure to split. Without `owner` on the line, a toast click would be
 * unattributable.
 *
 * @param {{ type: string, id: string | null, path: number[], checked?: boolean,
 *           at?: string, owner?: string }} record
 * @returns {string} the line, newline included
 */
export function encodeEventLine(record) {
  const parts = [];
  parts.push('{"protocol":' + PROTOCOL);
  parts.push(',"at":' + JSON.stringify(record.at === undefined ? isoNow() : record.at));
  parts.push(',"type":' + JSON.stringify(record.type));
  parts.push(',"id":' + (record.id === null || record.id === undefined ? 'null' : JSON.stringify(record.id)));
  parts.push(',"path":' + JSON.stringify(Array.isArray(record.path) ? record.path : []));
  if (record.type === 'toggle') parts.push(',"checked":' + (record.checked === true ? 'true' : 'false'));
  else if (typeof record.checked === 'boolean') parts.push(',"checked":' + (record.checked ? 'true' : 'false'));
  if (typeof record.owner === 'string' && record.owner !== '') {
    parts.push(',"owner":' + JSON.stringify(record.owner));
  }
  parts.push('}');
  return parts.join('') + '\n';
}

/** UTF-8 byte length of a JavaScript string, without depending on Buffer typing. */
function byteLength(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/** @returns {string} a stable message for any thrown value */
export function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message;
  try {
    return String(error);
  } catch (_stringifyError) {
    return 'unknown error';
  }
}

/** @returns {string} current UTC instant as ISO-8601 */
export function isoNow() {
  try {
    return new Date().toISOString();
  } catch (_error) {
    return '';
  }
}
