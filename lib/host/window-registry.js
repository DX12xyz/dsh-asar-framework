/**
 * 窗口能力的**写半身**（Host 侧）—— `asarShell.openWindow` / `asarShell.windows`。
 *
 * 三个角色分得清清楚楚，三者都在这一个文件里引用同一份事实：
 *   1. **校验**：`lib/bridge/src/windows.js` 的 `validateWindowSpec` 是唯一真相
 *      （字段白名单、200–8000 尺寸、±100,000 坐标、同源 route、id ≤ 64）。这里**不
 *      复制**任何一条规则 —— 区域里那份也是同一段源码（`lib/asar/patch-body.js`
 *      用 `Function.prototype.toString()` 把它送进归档），所以「这里放行的 spec」
 *      与「区域放行的 spec」不可能不一致。
 *   2. **发送**：一条 `channel:"window"` 的 IPC 消息，走**已有的** `channelSend`
 *      （`lib/host/service.js`，即 `process.send`）。宿主进程本身就是主进程 spawn 的
 *      IPC 子进程，所以这条路径是真实的、当场生效的（不是 700 ms 轮询）。
 *   3. **观察**：`windows()` 的答案来自**回执**（`channel.out.jsonl`）与**关闭事件**
 *      （`events.jsonl` 的 `window-closed`），**不是**一次活的 Electron 查询 ——
 *      宿主进程看不见 Electron，而桥能看见。桥的结论落在 `bridge.json` 的
 *      `windows` 块；这里把它一起带出来，让调用方一次拿到「我们知道的」与「桥统计的」。
 *
 * 为什么是**独立模块**而不是塞进 `lib/host/service.js`
 * 服务对象是「安装 / 卸载 / 托盘 / 通知 / 补丁」的接线层；窗口写半身的核心不变量与它们
 * 完全不同（「一次 open = 一条 IPC 消息 + 一个待回执的条目」，而托盘是「合并成一份文档」、
 * 补丁是「同步一张代码表」）。把它塞进 service 会让那条 3,000 行的接线层再多一种状态机，
 * 而这里的状态机只有三格：sent → opened / rejected，然后 closed。
 *
 * 边界（写下来，不留给下一个人发现）：
 *  - `owner` **不**进 IPC 消息：payload 会被区域按 spec 白名单逐字段校验并**丢弃**未知键，
 *    所以「谁开的」只存在于本层的内存里。`window-closed` 事件里的 `owner` 因此是
 *    「知道就写，不知道就 null」（`events.jsonl` 那份记录由桥写，桥没有 owner 这个事实）。
 *  - `openWindow` 返回的是「已发出」，**不是**「已打开」：区域的答复仍然只能写文件
 *    （区域那个包装函数没有 `this`，回不了 IPC），所以真正的结果在下一个 drain 之后
 *    出现在 `channel.out.jsonl`，并由 `windows()` 读回来（`state: 'opened' | 'rejected'`）。
 *  - 上限：区域强制的是**全局** 8 个活窗口（`__windowRegistry.size >= MAX_WINDOW_SPECS`
 *    就拒绝，答复 `reason:'E_LIMIT'`）；本层再加一道**按 owner** 的 8 个与「同一 owner
 *    下 id 不得重复」，这样调用方在**发送之前**就能拿到可读的错误码，而不是等一行
 *    `rejected` 回执。两道闸的码都在下面 `WINDOW_HOST_CODES` 里，互不冒充。
 *  - 文件读取全部是**只读**的：`channel.out.jsonl` 的游标属于桥，本层只是跟着读
 *    （不复位、不截断、不轮转）；`events.jsonl` 同理。任何读取失败都降级成
 *    `available:false` + `lastError`，绝不抛。
 */

import { readFileSync, statSync } from '../fs-safe.js';
import { join } from 'node:path';

import { FILES } from '../wire/constants.js';
import { MAX_OWNER_LENGTH, OWNER_SEPARATOR, validateOwnerString } from './contribution.js';
import {
  MAX_WINDOW_SPECS,
  SPEC_FIELDS,
  WINDOW_ACKS,
  WINDOW_CLOSED_EVENT,
  WINDOW_SPEC_CODES,
  validateWindowSpec,
} from '../bridge/src/windows.js';

/**
 * 写半身的错误码。**每一个**都对应调用方能做的一件具体事，不是「失败了」的同义词。
 *
 * 前五个是**本层**的拒绝（发送之前就答，不发消息）；后三个是**区域**的拒绝
 * （`channel.out.jsonl` 里那行 `received.reason` 的原文，本层照抄，不翻译成自己的码：
 * 调用方如果同时看到 `E_LIMIT` 和某个本地码，要能分清是谁说的不）。
 */
export const WINDOW_HOST_CODES = Object.freeze({
  /** `owner` 不是字符串 / 空 / 过长 / 含 `#`（复用托盘那条 owner 规则）。 */
  EINVALID_OWNER: 'EINVALID_OWNER',
  /** spec 不是对象，或缺 `id`，或某个字段类型不对（来自 `validateWindowSpec`）。 */
  EINVALID_SPEC: WINDOW_SPEC_CODES.EINVALID_SPEC,
  /** 数值越界（尺寸 200–8000、坐标 ±100,000、id/title/route 过长）。 */
  ERANGE: WINDOW_SPEC_CODES.ERANGE,
  /** `route` 不是同源绝对路径（`https://…`、`//…`、反斜杠都算）。 */
  EUNSAFE_ROUTE: WINDOW_SPEC_CODES.EUNSAFE_ROUTE,
  /** 这个 owner 已经有 `MAX_WINDOW_SPECS` 个**未关闭**的窗口。 */
  EWINDOW_LIMIT: 'EWINDOW_LIMIT',
  /** 这个 owner 已经用这个 `id` 开过窗口，且它还没关。 */
  EWINDOW_DUPLICATE: 'EWINDOW_DUPLICATE',
  /** 没有任何可发送的消息（IPC 通道不在）：照抄 `channelSend` 的形状。 */
  ENO_IPC: 'ENO_IPC',
  /** 装着的区域不是本次构建写的那一份：本层**不**发消息（与 `channelSend` 同一道闸）。 */
  EREGION_STALE: 'EREGION_STALE',
});

/**
 * 区域的拒绝码（`lib/asar/patch-body.js` `CHANNEL_DECLINE_CODES`），作为**数据**重复
 * 在这里 —— 它们是答复行里可能出现、调用方需要分支的值。
 *
 * ⚠️ 这**不是**第二份校验实现：它只影响「怎么解释已经回来的答复」，不参与「是否放行」。
 * `test/window-half.test.mjs` 钉住这七个字符串与区域那份**完全相同**（从区域字节里抽出
 * `__decline` 的 JSON 比对），所以两边的拼写不会漂。
 */
export const WINDOW_REGION_CODES = Object.freeze({
  /** 这个 id 在区域内已经有一个活窗口。 */
  EDUPLICATE_ID: 'E_DUP',
  /** 区域里已经有 `MAX_WINDOW_SPECS` 个活窗口（**全局**，不只是这个 owner）。 */
  ELIMIT: 'E_LIMIT',
  /** 区域拿不到窗口类（壳把它移出了作用域）。 */
  EPROVIDER_ABSENT: 'E_PROVIDER',
  /** 构造抛了 / 构造出的东西不可用。 */
  ECONSTRUCT_FAILED: 'E_CONSTRUCT',
  /** `loadURL` 抛了：窗口对象存在过，但没有页面。 */
  ELOAD_FAILED: 'E_LOAD',
  /** 一份已经打开过的文档（`window.json` 那条文件通道的码，本版不产生）。 */
  EREGISTRY: 'E_REGISTRY',
  /** 消息本身不合法（`channel` 名字 / payload 超限 / 长得像控制回复）。 */
  EDECLINED: 'E_CHANNEL',
});

/**
 * 一条待回执 / 已回执的窗口条目，只保留**有界**的字段。
 *
 * `state`：`'sent'`（消息已发出，答复还没读到）、`'opened'`（区域答复 opened）、
 * `'rejected'`（区域答复 rejected，`reason` 见 {@link WINDOW_REGION_CODES}）、
 * `'closed'`（关闭事件已到达）。
 */
const STATE_SENT = 'sent';
const STATE_OPENED = WINDOW_ACKS.opened;
const STATE_REJECTED = WINDOW_ACKS.rejected;
const STATE_CLOSED = 'closed';

/** 已关闭条目的保留上限：列表是给人看的，不是账本。 */
export const WINDOW_CLOSED_KEEP = 16;

/** `channel.out.jsonl` 的读取上限 —— 与桥同一套纪律（超限不解析）。 */
const CHANNEL_FILE_MAX_BYTES = 64 * 1024;

/** `events.jsonl` 的读取上限。 */
const EVENTS_FILE_MAX_BYTES = 512 * 1024;

/** @param {unknown} value @returns {boolean} 非 null 且非数组的对象 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {string} */
function messageOf(value) {
  if (value === null || value === undefined) return 'unknown error';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.message === 'string' && value.message !== '') return value.message;
  try {
    return String(value);
  } catch (_error) {
    return 'unknown error';
  }
}

/** @param {string} code @param {string} message @returns {{ ok: false, code: string, message: string }} */
function fail(code, message) {
  return { ok: false, code, message };
}

/**
 * 读一个 JSONL 通道文件，只消费**完整行**。
 *
 * 与桥的两条纪律一致：字节游标只在整行边界推进（末尾没有换行的那一行留到下次），
 * 文件比游标短就当作轮转、从头读并如实回报（旧记录不重放）。
 *
 * @param {string} file
 * @param {number} cursor
 * @param {number} maxBytes
 * @returns {{ ok: boolean, records: object[], cursor: number, rotated: boolean, error: string | null }}
 */
function readJsonLines(file, cursor, maxBytes) {
  const result = { ok: true, records: [], cursor: 0, rotated: false, error: null };
  let offset = typeof cursor === 'number' && Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
  let stats;
  try {
    stats = statSync(file);
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      result.cursor = 0;
      result.rotated = offset > 0;
      return result;
    }
    result.ok = false;
    result.error = 'stat failed: ' + messageOf(error);
    result.cursor = offset;
    return result;
  }
  if (stats.isFile() !== true) {
    result.ok = false;
    result.error = 'not a regular file';
    result.cursor = offset;
    return result;
  }
  if (stats.size > maxBytes) {
    result.ok = false;
    result.error = 'is ' + stats.size + ' bytes; the cap is ' + maxBytes;
    result.cursor = offset;
    return result;
  }
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch (error) {
    result.ok = false;
    result.error = 'read failed: ' + messageOf(error);
    result.cursor = offset;
    return result;
  }
  const rotated = offset > 0 && stats.size < offset;
  if (rotated) {
    result.rotated = true;
    offset = 0;
  }
  const slice = buffer.subarray(offset);
  let cut = -1;
  for (let index = slice.length - 1; index >= 0; index -= 1) {
    if (slice[index] === 0x0a) {
      cut = index;
      break;
    }
  }
  if (cut >= 0) {
    for (const line of slice.subarray(0, cut + 1).toString('utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch (_error) {
        continue; // 一行坏 JSON 不该让整条观查停摆
      }
      if (isObject(record) === true) result.records.push(record);
    }
  }
  result.cursor = offset + cut + 1;
  return result;
}

/**
 * 建一个窗口写半身。
 *
 * @param {{
 *   stateDir?: string | null,
 *   now?: () => Date,
 * }} [options]
 * @returns {{
 *   openWindow: (request: object, send: Function) => Promise<object> | object,
 *   windows: () => object,
 *   withdraw: (request: object) => object,
 *   snapshot: () => object,
 * }}
 */
export function createWindowRegistry(options) {
  const settings = isObject(options) ? options : {};
  const stateDir = typeof settings.stateDir === 'string' && settings.stateDir !== '' ? settings.stateDir : null;
  const now = typeof settings.now === 'function' ? settings.now : () => new Date();

  /**
   * The directory is UNUSABLE when it exists but is not a directory: `ensureDir`
   * is not this module's job (the bridge owns creation), so a path that collides
   * with a file is reported rather than created around. `null` means "no path at
   * all", which is the same state for every reader below.
   */
  const usableDir = stateDir === null ? null : stateDir;

  const channelPath = usableDir === null ? null : join(usableDir, FILES.channelOut);
  const eventsPath = usableDir === null ? null : join(usableDir, FILES.events);
  // `FILES.status` IS `bridge.json`: the bridge's own name for it (`FILES.status`
  // in `lib/bridge/src/paths.js`) is the same file, and this module reads it, never
  // writes. Using the bridge's constant keeps one spelling per file.
  const bridgePath = usableDir === null ? null : join(usableDir, FILES.bridge);

  /**
   * 本层知道的窗口，按「打开顺序」排列。key 是**复合键** `owner # id`：
   * 两个插件都可以用 `settings` 这个名字，它们在区域里是不同的窗口。
   *
   * @type {Map<string, { owner: string, id: string, state: string, sentAt: string,
   *                      reason: string|null, openedAt: string|null, closedAt: string|null }>}
   */
  let entries = new Map();

  /** `channel.out.jsonl` 的只读游标（桥自己那个是它的事，这里不复用也不复位）。 */
  let channelCursor = 0;

  /** `events.jsonl` 的只读游标。 */
  let eventsCursor = 0;

  /** 上一次读取失败的原因；`null` 表示两个文件都读得动。 */
  let lastError = null;

  /** @returns {string} ISO-8601 */
  function stamp() {
    try {
      const value = now();
      if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
    } catch (_error) {
      // 时间戳只是元数据。
    }
    return '';
  }

  /** @param {string} owner @param {string} id @returns {string} */
  function keyOf(owner, id) {
    return owner + OWNER_SEPARATOR + id;
  }

  /**
   * 这个 owner 还有几个**未关闭**的窗口（含已发出但还没回执的）。
   *
   * @param {string} owner
   * @returns {number}
   */
  function liveCountOf(owner) {
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.owner !== owner) continue;
      if (entry.state === STATE_CLOSED) continue;
      if (entry.state === STATE_REJECTED) continue;
      count += 1;
    }
    return count;
  }

  /**
   * 把 `channel.out.jsonl` 里新到的**窗口答复**并进表。
   *
   * 答复行是区域写的信封：`{protocol, channel, at, received}`，`received` 要么是
   * `"shown"`-式的字符串（不可能是 window 的），要么是区域 `handleWindowMessage`
   * 返回的那个对象 `{received:'opened'|'rejected', windowId, reason?}`。所以这里只认
   * `channel === 'window'` 且 `received` 是对象、`received.received` 是那两个值的行。
   *
   * 配对规则：`windowId` → 本表里**最新的**、`id` 相同且仍是 `sent` 的条目。
   * 一个 owner 名下的同一 id 开两次会被本层拒绝（`EWINDOW_DUPLICATE`），所以「最新
   * 的 sent」不会错配到别人的窗口上；跨 owner 的那个歧义在 `windows()` 的
   * `ambiguous` 计数里如实写出来。
   *
   * @returns {number} 并进了多少条答复
   */
  function absorbAcks() {
    if (channelPath === null) return 0;
    const read = readJsonLines(channelPath, channelCursor, CHANNEL_FILE_MAX_BYTES);
    channelCursor = read.cursor;
    if (read.ok !== true) {
      lastError = 'channel.out.jsonl ' + read.error;
      return 0;
    }
    let absorbed = 0;
    for (const record of read.records) {
      if (record.channel !== 'window') continue;
      const answered = record.received;
      if (isObject(answered) !== true) continue;
      const windowId = typeof answered.windowId === 'string' && answered.windowId !== '' ? answered.windowId : null;
      if (windowId === null) continue;
      const state = answered.received === WINDOW_ACKS.opened
        ? STATE_OPENED
        : answered.received === WINDOW_ACKS.rejected ? STATE_REJECTED : null;
      if (state === null) continue;
      let target = null;
      for (const entry of entries.values()) {
        if (entry.id !== windowId) continue;
        if (entry.state !== STATE_SENT) continue;
        target = entry; // 最新的一条获胜：Map 按插入顺序遍历
      }
      if (target === null) continue;
      target.state = state;
      target.openedAt = state === STATE_OPENED ? (typeof record.at === 'string' ? record.at : stamp()) : null;
      target.reason = state === STATE_REJECTED && typeof answered.reason === 'string' ? answered.reason : null;
      absorbed += 1;
    }
    return absorbed;
  }

  /**
   * 把 `events.jsonl` 里新到的 `window-closed` 记录并进表。
   *
   * 桥写的那行是 `{protocol, at, type:'window-closed', id, path, owner?}`（见
   * `lib/bridge/src/paths.js` `encodeEventLine`）。`owner` 是桥知道的那个 —— 桥通常
   * 不知道（区域不传），所以这里用**自己的** owner 表来补：只有当这个 id 在本层只对应
   * 一个 owner 时才补，否则留 null 并在 `ambiguous` 里计数。
   *
   * @returns {number} 并进了多少条关闭事件
   */
  function absorbCloses() {
    if (eventsPath === null) return 0;
    const read = readJsonLines(eventsPath, eventsCursor, EVENTS_FILE_MAX_BYTES);
    eventsCursor = read.cursor;
    if (read.ok !== true) {
      lastError = 'events.jsonl ' + read.error;
      return 0;
    }
    let absorbed = 0;
    for (const record of read.records) {
      if (record.type !== WINDOW_CLOSED_EVENT) continue;
      const id = typeof record.id === 'string' && record.id !== '' ? record.id : null;
      if (id === null) continue;
      absorbed += 1;
      const owner = typeof record.owner === 'string' && record.owner !== '' ? record.owner : null;
      for (const entry of entries.values()) {
        if (entry.id !== id) continue;
        if (entry.state === STATE_CLOSED) continue;
        if (owner !== null && entry.owner !== owner) continue;
        entry.state = STATE_CLOSED;
        entry.closedAt = typeof record.at === 'string' ? record.at : stamp();
      }
    }
    return absorbed;
  }

  /** 表里所有**未关闭**的条目，按打开顺序。 */
  function openEntries() {
    const out = [];
    for (const entry of entries.values()) {
      if (entry.state === STATE_CLOSED) continue;
      out.push(entry);
    }
    return out;
  }

  /** 桥的 `windows` 块（`bridge.json`），读不到就是 null —— 诊断，不是证据。 */
  function bridgeBlock() {
    if (bridgePath === null) return null;
    try {
      const text = readFileSync(bridgePath, 'utf8');
      const parsed = JSON.parse(text);
      if (isObject(parsed) !== true) return null;
      return isObject(parsed.windows) ? parsed.windows : null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * **打开一个窗口**：校验（与区域同一份源码）→ 发送（已有的 `channelSend`）→ 记账。
   *
   * 请求形状：
   * ```
   * { owner: '@local/demo', spec: { id, title?, route?, width?, height?, x?, y?, resizable?, frameless?, modal? } }
   * ```
   * 也接受「`spec` 直接躺在请求里」的写法（`{owner, id, route, ...}`），两种都只是
   * 同一个 spec 的搬运方式；`owner` 是唯一**必填**的非 spec 字段。
   *
   * 返回：
   *  - `{ ok:true, id, owner, channel:'window', sentAt, state:'sent', ack:'channel.out.jsonl' }`
   *    —— 消息**已经**交给主进程（`channelSend` 解析完成即代表 `process.send` 已发生），
   *    区域的答复在下一个 drain 之后由 `windows()` 读回；
   *  - `{ ok:false, code, message }` —— 本层或 `channelSend` 的拒绝，**没有发出任何消息**
   *    （`EWINDOW_*` 是本层，`ENO_IPC` / `EREGION_STALE` 原样来自 `channelSend`）。
   *
   * @param {unknown} request
   * @param {(request: object) => Promise<object>} send 注入的 `channelSend`
   * @returns {Promise<object>}
   */
  async function openWindow(request, send) {
    const input = isObject(request) ? request : {};
    const owner = input.owner;
    const checkedOwner = validateOwnerString(owner, MAX_OWNER_LENGTH, OWNER_SEPARATOR);
    if (checkedOwner.ok !== true) return fail(WINDOW_HOST_CODES.EINVALID_OWNER, checkedOwner.message);

    // spec 是「请求里的 spec 字段」：既有 `{owner, spec}` 的写法，也有平铺的写法。
    const raw = isObject(input.spec) ? input.spec : input;
    const checked = validateWindowSpec(raw, 'spec');
    if (checked.ok !== true) {
      // 码与消息**原样**来自契约：本层不翻译、不改写，调用方看到的 reason 与区域
      // 答复行里那个是同一个字符串。
      return { ok: false, code: checked.code, message: checked.message, where: checked.where };
    }
    const spec = checked.spec;

    // 先跟自己的表对一次（表可能落后于区域一个回执，所以这只是**早退**，
    // 不是取代区域那道闸：真的越界时区域仍会答 `E_LIMIT` / `E_DUP`）。
    for (const entry of entries.values()) {
      if (entry.owner !== owner) continue;
      if (entry.id !== spec.id) continue;
      if (entry.state === STATE_CLOSED || entry.state === STATE_REJECTED) continue;
      return fail(
        WINDOW_HOST_CODES.EWINDOW_DUPLICATE,
        'owner ' + owner + ' 已经用 id "' + spec.id + '" 开过一个还没关闭的窗口；先等它关闭，或换一个 id',
      );
    }
    if (liveCountOf(owner) >= MAX_WINDOW_SPECS) {
      return fail(
        WINDOW_HOST_CODES.EWINDOW_LIMIT,
        'owner ' + owner + ' 同时最多 ' + MAX_WINDOW_SPECS + ' 个窗口（已有 ' + liveCountOf(owner) + ' 个还没关）；'
        + '这是区域的硬上限（答复码 E_LIMIT），本层在发送前先答一次，免得你等一行回执',
      );
    }

    if (typeof send !== 'function') {
      return fail(WINDOW_HOST_CODES.ENO_IPC, '这里拿不到 channelSend：窗口写半身必须经由 Host 的 IPC 快路径发送');
    }
    let sent;
    try {
      sent = await send({ channel: 'window', payload: spec });
    } catch (error) {
      return fail(WINDOW_HOST_CODES.ENO_IPC, 'channelSend 抛出：' + messageOf(error));
    }
    if (isObject(sent) !== true || sent.ok !== true) {
      // 形状原样回传：`channelSend` 的拒绝码（`ENO_IPC` / `EREGION_STALE` /
      // `EINVALID_CHANNEL` / `EPAYLOAD_TOO_LARGE`）在这里一字不改，因为「为什么没发出去」
      // 只有它知道，本层再编一个码只会让调用方少一条信息。
      return isObject(sent) ? sent : fail(WINDOW_HOST_CODES.ENO_IPC, 'channelSend 没有返回结果对象');
    }

    entries.set(keyOf(owner, spec.id), {
      owner,
      id: spec.id,
      state: STATE_SENT,
      sentAt: typeof sent.sentAt === 'string' ? sent.sentAt : stamp(),
      reason: null,
      openedAt: null,
      closedAt: null,
    });
    // 表是给人看的：已关闭的条目只留最近 `WINDOW_CLOSED_KEEP` 条。
    prune();
    return {
      ok: true,
      owner,
      id: spec.id,
      channel: 'window',
      sentAt: entries.get(keyOf(owner, spec.id)).sentAt,
      state: STATE_SENT,
      ack: FILES.channelOut,
      // 明确写出「答复不在这个返回值里」：区域回不了 IPC，答复只能写文件。
      note: '消息已交给主进程；区域的 opened/rejected 答复在下一个 drain 后出现在 ' + FILES.channelOut
        + '，由 asarShell.windows() 读回',
    };
  }

  /**
   * 撤走一个**关不掉**的条目：只从本层的表里去掉，**不**发任何消息。
   *
   * 为什么存在：窗口的生命周期归主进程，Host 没有任何办法关掉它（§21 的结论）。
   * 那为什么还要有这个方法 —— 因为调用方可能已经**关掉了自己的 owner**（插件被禁用），
   * 它应该能把表里的条目带走，否则 `windows()` 会一直报一个它已经不管的窗口。
   * 名字叫 `withdraw` 而不是 `close`，正是为了不让它看起来像一条关闭指令。
   *
   * @param {unknown} request `{ owner }` 或 `{ owner, id }`
   * @returns {object}
   */
  function withdraw(request) {
    const input = isObject(request) ? request : {};
    const owner = input.owner;
    const checkedOwner = validateOwnerString(owner, MAX_OWNER_LENGTH, OWNER_SEPARATOR);
    if (checkedOwner.ok !== true) return fail(WINDOW_HOST_CODES.EINVALID_OWNER, checkedOwner.message);
    const id = typeof input.id === 'string' && input.id !== '' ? input.id : null;
    let removed = 0;
    for (const [key, entry] of [...entries]) {
      if (entry.owner !== owner) continue;
      if (id !== null && entry.id !== id) continue;
      entries.delete(key);
      removed += 1;
    }
    return { ok: true, owner, removed };
  }

  /** 已关闭条目最多留 `WINDOW_CLOSED_KEEP` 条，按关闭时间从旧到新删。 */
  function prune() {
    const closed = [];
    for (const [key, entry] of entries) {
      if (entry.state === STATE_CLOSED) closed.push([key, entry]);
    }
    while (closed.length > WINDOW_CLOSED_KEEP) {
      const [key] = closed.shift();
      entries.delete(key);
    }
  }

  /**
   * **本插件知道的窗口快照** —— `asarShell.windows()` 就是它。
   *
   * 「知道」= 本层发出过、或已经从回执/关闭事件里读到的那些。**不是**一次活的
   * Electron 查询（宿主进程看不见 Electron），也**不**假装是：`source` 字段写明
   * 这份数据的两个来源，`bridge` 字段是桥在 `bridge.json` 里统计的那一份 —— 两者
   * 不一致恰恰是「某个半身落后了」的可观测证据。
   *
   * @returns {object}
   */
  function windows() {
    if (usableDir === null) {
      return {
        ok: true,
        available: false,
        source: { acks: null, closes: null, bridge: null },
        open: [],
        closed: [],
        count: 0,
        ambiguous: 0,
        bridge: null,
        observed: { acks: 0, closes: 0 },
        cursor: { channel: channelCursor, events: eventsCursor },
        // No state directory means NO file to read: this is the reason, stated,
        // not an empty snapshot with no explanation.
        lastError: 'state directory unavailable: there is no ack file and no event file to observe',
      };
    }
    // A PATH THAT COLLIDES WITH A FILE is the one "wrong shape" a reader must name:
    // a child path under it stats as ENOENT, which would otherwise be reported as
    // "nothing written yet" — a lie that hides the real problem.
    let dirStats = null;
    try {
      dirStats = statSync(usableDir);
    } catch (error) {
      dirStats = null;
      lastError = 'state directory is unreadable: ' + messageOf(error);
    }
    if (dirStats !== null && dirStats.isDirectory() !== true) {
      return {
        ok: true,
        available: false,
        source: { acks: FILES.channelOut, closes: FILES.events, bridge: FILES.bridge },
        open: [],
        closed: [],
        count: 0,
        ambiguous: 0,
        bridge: null,
        observed: { acks: 0, closes: 0 },
        cursor: { channel: channelCursor, events: eventsCursor },
        lastError: 'state directory is not a directory: ' + usableDir,
      };
    }
    lastError = null;
    const acked = absorbAcks();
    const closedNow = absorbCloses();    const open = openEntries();
    const closedEntries = [];
    for (const entry of entries.values()) {
      if (entry.state === STATE_CLOSED) closedEntries.push(entry);
    }
    // 同一个 id 出现在两个 owner 名下时，`owner` 的归属就有歧义：数出来，别藏。
    let ambiguous = 0;
    const byId = new Map();
    for (const entry of open) byId.set(entry.id, (byId.get(entry.id) ?? 0) + 1);
    for (const count of byId.values()) if (count > 1) ambiguous += count;

    return {
      ok: true,
      available: stateDir !== null,
      source: { acks: FILES.channelOut, closes: FILES.events, bridge: FILES.bridge },
      open: open.map(publicEntry),
      closed: closedEntries.map(publicEntry),
      count: open.length,
      ambiguous,
      // 桥那一份统计（`bridge.json` 的 `windows` 块）：`{available, known, max, closed, sampled, lastAt, lastError}`。
      bridge: bridgeBlock(),
      // 每份快照都会重新读一次两个文件，所以这两个数字是「本次读到了多少」。
      observed: { acks: acked, closes: closedNow },
      cursor: { channel: channelCursor, events: eventsCursor },
      lastError,
    };
  }

  /**
   * @param {{ owner: string, id: string, state: string, sentAt: string, reason: string|null,
   *           openedAt: string|null, closedAt: string|null }} entry
   * @returns {object}
   */
  function publicEntry(entry) {
    const out = {
      owner: entry.owner,
      id: entry.id,
      state: entry.state,
      sentAt: entry.sentAt,
    };
    if (entry.openedAt !== null) out.openedAt = entry.openedAt;
    if (entry.closedAt !== null) out.closedAt = entry.closedAt;
    if (entry.reason !== null) out.reason = entry.reason;
    return out;
  }

  /** 只读快照（`asarShell.windows()` 之外给诊断页用的那一格）。 */
  function snapshot() {
    return windows();
  }

  return { openWindow, windows, withdraw, snapshot };
}

/**
 * 这份写半身**声明**的 spec 字段 —— `asarShell.windows()` 的文档里引用它，测试也钉住
 * 「Host 侧说的字段集就是契约的字段集」，这样两边的白名单不会各自演化。
 */
export const WINDOW_SPEC_FIELDS = SPEC_FIELDS.slice();

/**
 * The THREE-LINE wiring: the object `ctx.provide('asarShell', { ... })` spreads in.
 *
 * WHY A FACTORY AND NOT THREE MORE LINES IN `index.js` / `service.js`: those two are
 * the plugin's public assembly points and are edited by other work in this session;
 * a factory keeps the surface here, in the module that owns it, and makes the patch
 * a spread instead of a hand-written dispatch table. It also means the wiring is
 * TESTED (`test/window-half.test.mjs` drives this exact object against the REAL
 * `createFrameworkService`, with its `channelSender` injected — i.e. the production
 * `process.send` path is the only difference).
 *
 * `send` MUST be the Host's `channelSend` bound into a function (`(message) =>
 * service.channelSend(message)`), not the method reference: `channelSend`'s shape
 * check and its stale-region guard are the two things a caller must not bypass.
 *
 * @param {{ stateDir?: string | null, send: Function, now?: () => Date }} options
 * @returns {{ openWindow: Function, windows: Function, windowWithdraw: Function }}
 */
export function windowSurface(options) {
  const settings = isObject(options) ? options : {};
  const registry = createWindowRegistry({
    stateDir: settings.stateDir === undefined ? null : settings.stateDir,
    now: settings.now,
  });
  const send = typeof settings.send === 'function' ? settings.send : null;
  return {
    /**
     * @param {unknown} request `{ owner, spec }` (or a flat `{ owner, id, route, … }`)
     * @returns {Promise<object>}
     */
    openWindow: (request) => registry.openWindow(request, send),
    /** @returns {object} the Host's own window snapshot */
    windows: () => registry.windows(),
    /** @param {unknown} request `{ owner, id? }` */
    windowWithdraw: (request) => registry.withdraw(request),
  };
}
