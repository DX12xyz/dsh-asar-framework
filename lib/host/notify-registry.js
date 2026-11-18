/**
 * 通知贡献注册表 —— 文件式通知协议的「写半身」。
 *
 * 桥（`bridge/dist/tray-bridge.js`，由 `lib/bridge/src/` 构建）是「读半身」：
 * 每 N 个轮询周期读 `<stateDir>/notify.json`，为每个「新的」条目建一个 OS 通知，
 * 点击时把 `notify-click` 追加到 `<stateDir>/events.jsonl`。
 *
 * 为什么是**独立模块**而不是塞进 `lib/host/contribution.js`：
 * 两个通道的文档形状根本不同 —— 菜单是「一份持久树的合并」，通知是「一次性事件
 * 的单调队列」。菜单注册表的核心不变量是「同样输入 ⇒ 同样字节 ⇒ 不重渲染」，而
 * 通知的核心不变量是「同一个 rev 只出现一次」。把它们塞进同一个模块，会让
 * `menu.json` 的字节稳定性规则和 `notify.json` 的去重规则互相污染（例如删文件
 * 的时机、rev 的语义、owner 撤走时队列是否清空），而这两条规则都是**不能错**的。
 * 共用的部分（owner 校验、原子写、UTF-8 字节数）通过导入取得，不是靠复制。
 *
 * 本模块负责的约定：
 *  - **rev 单调递增**：`rev` 是「第几次通知」的全表计数器，每次真正入队 +1。
 *    条目自带的 `rev` 就是它入队时的值，因此桥只需记住「显示过的最大 rev」就能
 *    做到「新条目显示、旧条目不重放」，不需要任何 ack 通道。
 *  - **一次性**：条目一旦入队就留在文档里，不会因为「已经显示过」而被删掉。
 *    桥用自己的 `notify.state.json` 记住水位；本模块不猜桥看到过什么。
 *  - **owner 命名空间**：条目 id 是 `owner + '#' + 序号`，两个插件互不覆盖。
 *  - **同样的队列 ⇒ 逐字节相同**：文档里绝不写时间戳；`rev` 是唯一的序号来源。
 *  - **空队列 ⇒ 删除文件**：和 `menu.json` 同一条规则，「文件不存在」才是
 *    「没有待显示的通知」的诚实信号。
 *  - 每个写操作都走「同目录临时文件 + rename」，任何失败返回
 *    `{ ok:false, code, message }`，本模块不抛异常。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from '../fs-safe.js';
import { join } from 'node:path';

import { FILES, PROTOCOLS } from '../wire/constants.js';
import {
  MAX_OWNER_LENGTH,
  OWNER_SEPARATOR,
  validateOwnerString,
} from './contribution.js';
import { NOTIFY_MAX_BYTES as NOTIFY_MAX_BYTES_IN_BRIDGE } from '../bridge/src/paths.js';
import { NOTIFY_ITEM_LIMIT } from '../bridge/src/notify.js';

/** 队列上限：一次「尚未被桥消化」的通知最多这么多条，超出按 FIFO 丢弃最旧的。 */
export const NOTIFY_QUEUE_LIMIT = NOTIFY_ITEM_LIMIT;

/** `title` 上限（字符）。OS 通知的标题区本来就只显示一行左右。 */
export const NOTIFY_TITLE_LIMIT = 200;

/** `body` 上限（字符）。正文超过这个长度在 Action Center 里也只是被截断。 */
export const NOTIFY_BODY_LIMIT = 2048;

/**
 * 文档的字节上限 —— **从桥的读取上限导出**，不是另写一个数字。
 *
 * 这一条不能各写各的：写半身若允许一份比桥的读取上限还大的文档落盘，桥会把它
 * 当作「超限 = 没有待显示的通知」，而写方会回报「写成功」。于是通知静默消失，
 * 而且两边的日志都干净。桥的 `NOTIFY_MAX_BYTES` 是唯一的事实来源。
 */
export const NOTIFY_MAX_BYTES = NOTIFY_MAX_BYTES_IN_BRIDGE;

/** 每条通知在文档里的「身份」列 —— 用来把 doc 与 owner 的条目对回去。 */
export const NOTIFY_CODES = {
  /** owner 不合法（复用菜单注册表的同一条规则）。 */
  EINVALID_OWNER: 'EINVALID_OWNER',
  /** title 缺失 / 不是字符串 / 为空 / 过长。 */
  EINVALID_TITLE: 'EINVALID_TITLE',
  /** body / silent / urgency 类型不对。 */
  EINVALID_FIELD: 'EINVALID_FIELD',
  /** 合并后的文档超过 `NOTIFY_MAX_BYTES`。 */
  ENOTIFY_TOO_LARGE: 'ENOTIFY_TOO_LARGE',
  /** 读 / 写 `notify.json` 失败。 */
  EWRITE_FAILED: 'EWRITE_FAILED',
};

/** 桥认识的 urgency 值；与 `lib/bridge/src/notify.js` 的集合一致。 */
const URGENCIES = new Set(['normal', 'critical', 'low']);

/**
 * @param {unknown} value
 * @returns {boolean} 真值表示普通（非数组、非 null）对象
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @returns {string} 任意抛出值的可读消息 */
function errorMessage(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message;
  try {
    return String(error);
  } catch (_stringifyError) {
    return 'unknown error';
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {{ ok: false, code: string, message: string }}
 */
function fail(code, message, details = undefined) {
  const failure = { ok: false, code, message };
  if (isObject(details)) Object.assign(failure, details);
  return failure;
}

/**
 * UTF-8 字节数（不依赖 Buffer 类型标注；算法与桥侧一致）。
 *
 * @param {string} text
 * @returns {number}
 */
function utf8Bytes(text) {
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

/**
 * 校验一条通知请求。
 *
 * 一条通知只有一个「身份」：标题。标题为空的 OS 通知在 Action Center 里就是一个
 * 空矩形，所以它和菜单里「没有 label 的条目」一样，必须在写半身就被拒绝 —— 让
 * 桥静默丢掉它才是更坏的选择。
 *
 * @param {unknown} raw `{ title, body?, silent?, urgency? }`
 * @returns {{ ok: true, item: object } | { ok: false, code: string, message: string }}
 */
function normalizeRequest(raw) {
  if (!isObject(raw)) return fail(NOTIFY_CODES.EINVALID_TITLE, '通知必须是 { title, body?, silent?, urgency? } 对象');
  if (Object.prototype.hasOwnProperty.call(raw, '__proto__')) {
    return fail(NOTIFY_CODES.EINVALID_FIELD, '通知对象不能带 __proto__ 键');
  }
  if (typeof raw.title !== 'string') return fail(NOTIFY_CODES.EINVALID_TITLE, 'title 必须是字符串');
  if (raw.title.trim() === '') return fail(NOTIFY_CODES.EINVALID_TITLE, 'title 不能为空');
  if (raw.title.length > NOTIFY_TITLE_LIMIT) {
    return fail(NOTIFY_CODES.EINVALID_TITLE, `title 最长 ${NOTIFY_TITLE_LIMIT} 个字符，收到 ${raw.title.length} 个`);
  }

  let body = '';
  if (raw.body !== undefined && raw.body !== null) {
    if (typeof raw.body !== 'string') return fail(NOTIFY_CODES.EINVALID_FIELD, 'body 必须是字符串');
    if (raw.body.length > NOTIFY_BODY_LIMIT) {
      return fail(NOTIFY_CODES.EINVALID_FIELD, `body 最长 ${NOTIFY_BODY_LIMIT} 个字符，收到 ${raw.body.length} 个`);
    }
    body = raw.body;
  }

  if (raw.silent !== undefined && typeof raw.silent !== 'boolean') {
    return fail(NOTIFY_CODES.EINVALID_FIELD, 'silent 必须是布尔值');
  }
  if (raw.urgency !== undefined && (typeof raw.urgency !== 'string' || URGENCIES.has(raw.urgency) !== true)) {
    return fail(NOTIFY_CODES.EINVALID_FIELD, 'urgency 只支持 normal/critical/low');
  }

  // 键序写死：同样的请求 ⇒ 同样的字节。`silent:false` 与 `urgency` 只在显式给出
  // 时才写，省略即代表桥侧的默认行为。
  const item = { title: raw.title };
  if (body !== '') item.body = body;
  if (typeof raw.silent === 'boolean') item.silent = raw.silent;
  if (typeof raw.urgency === 'string') item.urgency = raw.urgency;
  return { ok: true, item };
}

/**
 * 建一个通知注册表。
 *
 * @param {{ stateDir: string, now?: () => Date }} options
 * @returns {{
 *   notify: (owner: string, request: unknown) => object,
 *   withdraw: (owner: string, options?: { id?: string }) => object,
 *   clear: () => object,
 *   snapshot: () => object,
 *   flush: () => object,
 *   read: () => object,
 * }}
 */
export function createNotifyRegistry(options) {
  const settings = isObject(options) ? options : {};
  const stateDir = typeof settings.stateDir === 'string' && settings.stateDir.length > 0 ? settings.stateDir : null;
  const notifyPath = stateDir === null ? null : join(stateDir, FILES.notify);

  /**
   * 全表计数器。单调，且只在本进程内保证；桥侧对此有「新的写者 epoch」检测
   * （见 `lib/bridge/src/notify.js` 的 poll），所以重启后从 1 重新数也不会让队列
   * 永远沉默。
   */
  let rev = 0;

  /** 每个 owner 的条目计数，用来生成 `owner#序号` 这样稳定且不会撞的 id。 */
  const serials = new Map();

  /** 队列：声明顺序 = 入队顺序（FIFO），也是文档里 `items` 的顺序。 */
  let queue = [];

  /** 上一次落盘的文本；内容没变就不重写。 */
  let lastWrittenText = null;
  let tmpSerial = 0;

  /**
   * 合成一份 protocol 1 文档。
   *
   * `rev` 是队列里最大的那个条目 rev（不是全表计数器）：桥只比较
   * 「document.rev」和「item.rev」，让文档头等于最后一个条目的 rev，可以避免
   * 「头部 rev 比条目还新」这种让桥沉默的坑。
   *
   * @returns {{ document: object, text: string, bytes: number }}
   */
  function compose() {
    const items = queue.slice();
    const document = {
      protocol: PROTOCOLS.notify,
      rev: items.length === 0 ? 0 : items[items.length - 1].rev,
      items,
    };
    const text = `${JSON.stringify(document, null, 2)}\n`;
    return { document, text, bytes: utf8Bytes(text) };
  }

  /**
   * 落盘：非空 → 原子写；空 → 删文件。
   *
   * @param {{ text: string, bytes: number, document: object }} target
   * @returns {{ ok: true, written: boolean, deleted: boolean } | { ok: false, code: string, message: string }}
   */
  function persist(target) {
    if (notifyPath === null) return fail(NOTIFY_CODES.EWRITE_FAILED, '没有可用的状态目录，无法写 notify.json');
    let temporary = null;
    try {
      if (target.document.items.length === 0) {
        const existed = existsSync(notifyPath);
        rmSync(notifyPath, { force: true });
        lastWrittenText = null;
        return { ok: true, written: false, deleted: existed };
      }
      if (lastWrittenText === target.text && fileLooksCurrent()) {
        return { ok: true, written: false, deleted: false };
      }
      mkdirSync(stateDir, { recursive: true });
      temporary = `${notifyPath}.tmp-${process.pid}-${++tmpSerial}`;
      writeFileSync(temporary, target.text, 'utf8');
      renameSync(temporary, notifyPath);
      lastWrittenText = target.text;
      return { ok: true, written: true, deleted: false };
    } catch (error) {
      if (temporary !== null) {
        try {
          rmSync(temporary, { force: true });
        } catch (_cleanupError) {
          // 已经失败一次了，临时文件残留不值得再抛。
        }
      }
      return fail(NOTIFY_CODES.EWRITE_FAILED, `写入 ${String(notifyPath)} 失败：${errorMessage(error)}`);
    }
  }

  /**
   * 磁盘上的文件是否仍是「我们上一次写下的那一份」。
   *
   * 只看文本缓存会漏掉外部改动：别人把 notify.json 删了或改坏了，缓存里的文本
   * 仍然相等，于是我们再也不写回去，桥就一直看不到通知。所以再看一眼大小。
   *
   * @returns {boolean}
   */
  function fileLooksCurrent() {
    if (notifyPath === null || lastWrittenText === null) return false;
    try {
      const stats = statSync(notifyPath);
      if (stats.isFile() !== true) return false;
      return readFileSync(notifyPath, 'utf8') === lastWrittenText;
    } catch (_error) {
      return false;
    }
  }

  /**
   * 「改副本 → 合并 → 写盘 → 提交」。写盘失败时内存不动。
   *
   * @param {(next: object[]) => { ok: true, next: object[], dropped: number }
   *         | { ok: false, code: string, message: string }} mutate
   * @returns {object}
   */
  function change(mutate) {
    const mutated = mutate(queue.slice());
    if (mutated.ok !== true) return mutated;

    const nextQueue = mutated.next;
    const previous = { queue, rev, serials: new Map(serials), lastWrittenText };
    const nextRev = rev + 1;

    // 先按候选状态合成、判大小，再真正落盘 —— 超限的文档绝不能先写出去。
    queue = nextQueue;
    rev = nextRev;
    const composed = compose();
    if (composed.bytes > NOTIFY_MAX_BYTES) {
      queue = previous.queue;
      rev = previous.rev;
      serials.clear();
      for (const [key, value] of previous.serials) serials.set(key, value);
      return fail(
        NOTIFY_CODES.ENOTIFY_TOO_LARGE,
        `合并后的 notify.json 有 ${composed.bytes} 字节，超过 ${NOTIFY_MAX_BYTES} 字节上限`,
        { bytes: composed.bytes, limit: NOTIFY_MAX_BYTES },
      );
    }

    const written = persist(composed);
    if (written.ok !== true) {
      queue = previous.queue;
      rev = previous.rev;
      serials.clear();
      for (const [key, value] of previous.serials) serials.set(key, value);
      lastWrittenText = previous.lastWrittenText;
      return written;
    }
    return {
      ok: true,
      rev,
      itemCount: queue.length,
      dropped: mutated.dropped,
      written: written.written,
    };
  }

  return {
    /**
     * 入队一条通知。
     *
     * 队列满时按 FIFO 丢掉**最旧的未消化条目**，并把条数报在 `dropped` 里：
     * 一条通知的价值随年龄迅速衰减，保留最新的一定是更好的选择，而「静默失败」
     * 会让插件作者以为自己的通知发出去了。
     *
     * @param {string} owner
     * @param {unknown} request `{ title, body?, silent?, urgency? }`
     * @returns {{ ok: true, rev: number, id: string, itemCount: number, dropped: number }
     *         | { ok: false, code: string, message: string }}
     */
    notify(owner, request) {
      const ownerCheck = validateOwnerString(owner, MAX_OWNER_LENGTH, OWNER_SEPARATOR);
      if (ownerCheck.ok !== true) return fail(NOTIFY_CODES.EINVALID_OWNER, ownerCheck.message);
      const normalized = normalizeRequest(request);
      if (normalized.ok !== true) return normalized;

      // 条目 id 在这里就能定下来（序号只取决于该 owner 已有的条数），所以调用方
      // 拿到的是「准确的那一条」，而不是「大概写了点什么」—— 插件要能撤走自己刚
      // 发的那一条，就必须知道它的 id。
      const id = owner + OWNER_SEPARATOR + String((serials.get(owner) ?? 0) + 1);
      const result = change((next) => {
        const serial = (serials.get(owner) ?? 0) + 1;
        serials.set(owner, serial);
        // 键序固定：`id` 在最前，然后是请求里声明过的字段，最后是 `rev`。
        const ordered = { id };
        for (const key of Object.keys(normalized.item)) ordered[key] = normalized.item[key];
        // 本次调用产生的 rev 就是「计数器 + 1」，而 `change` 提交时正是把它加一，
        // 所以条目里的 rev 与提交后的 `rev` 永远相等。
        ordered.rev = rev + 1;

        next.push(ordered);
        let dropped = 0;
        while (next.length > NOTIFY_QUEUE_LIMIT) {
          next.shift();
          dropped += 1;
        }
        return { ok: true, next, dropped };
      });
      if (result.ok !== true) return result;
      return { ...result, id };
    },

    /**
     * 撤走某个 owner 的通知。
     *
     * 两种用法：
     *  - `withdraw(owner)`              → 撤走该 owner **全部**未消化条目；
     *  - `withdraw(owner, { id })`      → 只撤走指定 id（接受带或不带 owner 前缀）。
     *
     * 没匹配到任何条目是**成功空操作**（rev 不变、不重写文件），这样插件的清理
     * 路径可以无脑调用。
     *
     * @param {string} owner
     * @param {{ id?: string }} [options]
     * @returns {{ ok: true, rev: number, removed: number, itemCount: number }
     *         | { ok: false, code: string, message: string }}
     */
    withdraw(owner, options = {}) {
      const ownerCheck = validateOwnerString(owner, MAX_OWNER_LENGTH, OWNER_SEPARATOR);
      if (ownerCheck.ok !== true) return fail(NOTIFY_CODES.EINVALID_OWNER, ownerCheck.message);
      const wantedId = isObject(options) && typeof options.id === 'string' && options.id !== '' ? options.id : null;
      const localId = wantedId === null
        ? null
        : wantedId.indexOf(OWNER_SEPARATOR) >= 0 ? wantedId : owner + OWNER_SEPARATOR + wantedId;
      const prefix = owner + OWNER_SEPARATOR;

      const current = queue.filter(
        (item) => (localId === null ? item.id.startsWith(prefix) : item.id === localId),
      ).length;
      if (current === 0) return { ok: true, rev, removed: 0, itemCount: queue.length };

      const result = change((next) => {
        const kept = next.filter(
          (item) => (localId === null ? !item.id.startsWith(prefix) : item.id !== localId),
        );
        return { ok: true, next: kept, dropped: 0 };
      });
      if (result.ok !== true) return result;
      return { ok: true, rev: result.rev, removed: current, itemCount: result.itemCount };
    },

    /**
     * 清空整个队列（所有 owner）。
     *
     * @returns {{ ok: true, rev: number, cleared: number, itemCount: number }}
     */
    clear() {
      const count = queue.length;
      if (count === 0) return { ok: true, rev, cleared: 0, itemCount: 0 };
      const result = change(() => ({ ok: true, next: [], dropped: 0 }));
      if (result.ok !== true) return result;
      return { ok: true, rev, cleared: count, itemCount: 0 };
    },

    /**
     * 只读快照（诊断用）：不碰磁盘，也不重算。
     *
     * @returns {{ rev: number, itemCount: number, owners: object[], document: object | null }}
     */
    snapshot() {
      const counts = new Map();
      for (const item of queue) {
        const at = item.id.indexOf(OWNER_SEPARATOR);
        const owner = at > 0 ? item.id.slice(0, at) : '';
        counts.set(owner, (counts.get(owner) ?? 0) + 1);
      }
      return {
        rev,
        itemCount: queue.length,
        owners: [...counts.entries()].map(([owner, itemCount]) => ({ owner, itemCount })),
        document: queue.length === 0 ? null : compose().document,
      };
    },

    /**
     * 把内存里的队列重新落盘（notify.json 被外部删掉 / 改坏时用）。空队列 → 删文件。
     *
     * @returns {{ ok: true, rev: number, written: boolean, deleted: boolean }}
     */
    flush() {
      const composed = compose();
      const written = persist(composed);
      if (written.ok !== true) return written;
      return { ok: true, rev, written: written.written, deleted: written.deleted };
    },

    /**
     * 读回当前队列的文本（给测试与诊断用；正常路径不需要）。
     *
     * @returns {{ ok: true, text: string | null } | { ok: false, code: string, message: string }}
     */
    read() {
      if (notifyPath === null) return { ok: true, text: null };
      try {
        return { ok: true, text: existsSync(notifyPath) ? readFileSync(notifyPath, 'utf8') : null };
      } catch (error) {
        return fail(NOTIFY_CODES.EWRITE_FAILED, `读取 ${notifyPath} 失败：${errorMessage(error)}`);
      }
    },
  };
}
