/**
 * 动态补丁注册表 —— 声明式补丁协议（`patches.json`）的「写半身」。
 *
 * 桥（`bridge/dist/tray-bridge.js`，由 `lib/bridge/src/` 构建）是「读半身」：
 * 每 `PATCH_POLL_EVERY` 个菜单轮询周期读一次 `<stateDir>/patches.json`，把每个
 * `enabled` 的条目应用到**已经在主进程里**的 CommonJS 模块的导出对象上（加载时
 * 挂钩 `Module._load`，开机时用 `Module._cache` 重放）。
 *
 * ⚠️ **安全边界（必须写在这里，不许含糊）**
 * 条目里的 `source` 是一段**JavaScript 文本**，由桥在主进程里用 `Function` 求值。
 * 因此：
 *
 *     任何能写 `<stateDir>/patches.json` 的进程，都能在 Electron 主进程里运行
 *     任意代码，权限等于应用本身（读写文件、起进程……）。
 *
 * Host 半身本来就是主进程 spawn 出来的 `ELECTRON_RUN_AS_NODE=1` 子进程、本来就能
 * 写状态目录，所以这条能力没有把任何**原本不可达**的东西变得可达；但它把路径变成
 * 了**显式的**一份文件。`patches.json` 必须按「和应用源码同等信任」对待；不再需要
 * 时删掉它（`unpatch` 会把最后一个 owner 的条目清掉，文件随之消失）。
 *
 * 为什么是**独立模块**而不是塞进 `lib/host/contribution.js`：
 * 菜单通道的核心不变量是「同样输入 ⇒ 同样字节 ⇒ 不重渲染」，通知通道是「同一个
 * rev 只出现一次」，补丁通道的核心不变量是「**同一份字节 ⇒ 同一套已应用的补丁**，
 * 且撤走时必须能**回滚**」。三条规则彼此不能污染：菜单的 `rev` 是渲染序号，补丁的
 * `rev` 是「我这份代码的第几个版本」；菜单的「空表 = 删文件」表示没人贡献，补丁的
 * 「空表 = 删文件」表示**把已应用的补丁全部撤回**——同一个动作，在后两个通道里
 * 后果完全不同，所以它们必须是不同的模块。
 *
 * 本模块负责的约定：
 *  - **owner 命名空间**：条目 id 是 `owner + '#' + 局部 id`，两个插件互不覆盖；
 *  - **rev 单调递增**：每次真正改动 +1，桥把它当「这份补丁的第几个版本」记进
 *    `bridge.json` 的 `patches.rev`，供人排障；
 *  - **同样的条目表 ⇒ 逐字节相同**：文档里绝不写时间戳；
 *  - **空表 ⇒ 删除文件**：桥把「文件不存在」当成空 spec，因此**回滚**所有已应用
 *    的补丁——这是「插件被禁用后它的补丁不该继续生效」的唯一诚实表达；
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
import { PATCH_LIMITS } from '../bridge/src/patch.js';

/**
 * 文档的字节上限 —— **从桥的读取上限导出**，不是另写一个数字。
 *
 * 这一条不能各写各的：写半身若允许一份比桥的读取上限还大的文档落盘，桥会把整个
 * 文档判为 `EPATCH_OVERSIZE` 并**一条都不应用**，而写方却回报「写成功」。两边的
 * 日志都干净，补丁却静默消失。桥的 `PATCH_LIMITS.documentBytes` 是唯一事实来源。
 */
export const PATCH_MAX_BYTES = PATCH_LIMITS.documentBytes;

/** 一份文档最多几个条目 —— 同样从桥的上限导出。 */
export const PATCH_ITEM_LIMIT = PATCH_LIMITS.items;

/** 单条 `source` 的字节上限（导出，方便调用方在生成代码前自查）。 */
export const PATCH_SOURCE_MAX_BYTES = PATCH_LIMITS.sourceBytes;

/** 条目 id（含 owner 前缀）的长度上限，与桥的 `PATCH_LIMITS.idLength` 一致。 */
export const PATCH_ID_LENGTH = PATCH_LIMITS.idLength;

/** 本模块的失败码；全部是稳定字符串，供调用方与文档引用。 */
export const PATCH_CODES = {
  /** owner 不合法（复用菜单注册表的同一条规则）。 */
  EINVALID_OWNER: 'EPATCH_EINVALID_OWNER',
  /** items 不是非空数组 / 条目不是对象 / 带 `__proto__`。 */
  EINVALID_ITEM: 'EPATCH_EINVALID_ITEM',
  /** `source` 缺失、非字符串、为空，或超过 `PATCH_SOURCE_MAX_BYTES`。 */
  EINVALID_SOURCE: 'EPATCH_INVALID_SOURCE',
  /** 单条 source 超过字节上限（单独一个码，因为它是**安全闸**、不是形状错）。 */
  ESOURCE_TOO_LARGE: 'EPATCH_SOURCE_TOO_LARGE',
  /** 条目数超过 `PATCH_ITEM_LIMIT`。 */
  EITEM_LIMIT: 'EPATCH_ITEM_LIMIT',
  /** 合并后的文档超过 `PATCH_MAX_BYTES`。 */
  EPATCH_TOO_LARGE: 'EPATCH_PATCHES_TOO_LARGE',
  /**
   * `target` 指向桥产物本身。桥自己也拒绝（`EPATCH_SELF_TARGET`，自指递归的
   * 结构风险），写半身在落盘前先拒是为了给出版本 BEFORE 现场：一份永远应用不上的
   * 补丁不该先躺在文件里。
   */
  ESELF_TARGET: 'EPATCH_SELF_TARGET',
  /** 写 / 删 `patches.json` 失败。 */
  EWRITE_FAILED: 'EPATCH_EWRITE_FAILED',
};

/** 桥认识的两种 kind；其他值桥会在 `bridge.json` 里记成形状错。 */
const VALID_KINDS = new Set(['replace', 'wrap']);

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
 * 桥产物的文件名 —— 写半身的自指守卫用它做一次**廉价**的早期拒绝。
 *
 * 与桥侧的 `EPATCH_SELF_TARGET` 是同一条规则的两次表达：桥用绝对路径（它知道
 * 自己在哪），写半身只有这个名字可用（它跑在 Host 子进程里，不依赖注入区域告诉
 * 它桥在哪）。同一条规则写两遍是**有意的冗余**：任何一边单独失守，另一边仍然拦着。
 */
const SELF_ARTEFACT_NAME = 'tray-bridge.js';

/**
 * 规范化路径分隔符，供「target 是否指向桥产物」的判断使用。
 *
 * @param {string} value
 * @returns {string}
 */
function normaliseTarget(value) {
  return value.replace(/\\/g, '/');
}

/**
 * 校验并规范化一个 owner 的一条条目。
 *
 * 接受的调用方形状（`localId` 与 `id` 都可以给，`id` 优先）：
 *
 *   `{ id | localId, target, symbol?, kind, source, enabled? }`
 *
 * 输出是**文档里的那一条**：`{ id: owner#localId, owner, target, symbol, kind, source, enabled }`，
 * 键序写死，所以同样的请求 ⇒ 同样的字节。
 *
 * @param {string} owner
 * @param {unknown} raw
 * @param {number} index
 * @returns {{ ok: true, item: object } | { ok: false, code: string, message: string }}
 */
function normalizeItem(owner, raw, index) {
  if (!isObject(raw)) {
    return fail(PATCH_CODES.EINVALID_ITEM, `条目 ${index} 必须是对象`);
  }
  if (Object.prototype.hasOwnProperty.call(raw, '__proto__')) {
    return fail(PATCH_CODES.EINVALID_ITEM, `条目 ${index} 不能带 __proto__ 键`);
  }
  const rawId = typeof raw.id === 'string' && raw.id !== ''
    ? raw.id
    : (typeof raw.localId === 'string' && raw.localId !== '' ? raw.localId : null);
  if (rawId === null) {
    return fail(PATCH_CODES.EINVALID_ITEM, `条目 ${index} 需要非空的字符串 id（或 localId）`);
  }
  if (rawId.indexOf(OWNER_SEPARATOR) >= 0) {
    return fail(
      PATCH_CODES.EINVALID_ITEM,
      `条目 ${index} 的 id 不能包含 "${OWNER_SEPARATOR}"：它是 owner 与局部 id 的分隔符`,
    );
  }
  // id 是「owner + '#' + 局部 id」。上限按**合并后**的长度算，因为那个字符串才是
  // 桥认识的 id —— 否则一个 128 字符的 owner 加一个 90 字符的 localId 会写出桥
  // 判为超限的文档，而这里回报成功。
  const id = owner + OWNER_SEPARATOR + rawId;
  if (id.length > PATCH_ID_LENGTH) {
    return fail(
      PATCH_CODES.EINVALID_ITEM,
      `条目 ${index} 合并后的 id 有 ${id.length} 个字符（owner + "#" + id），上限是 ${PATCH_ID_LENGTH}`,
      { idLength: id.length, limit: PATCH_ID_LENGTH },
    );
  }
  if (typeof raw.target !== 'string' || raw.target === '') {
    return fail(PATCH_CODES.EINVALID_ITEM, `条目 ${id} 需要非空的字符串 target`);
  }
  if (normaliseTarget(raw.target).endsWith('/' + SELF_ARTEFACT_NAME)
    || normaliseTarget(raw.target) === SELF_ARTEFACT_NAME) {
    return fail(
      PATCH_CODES.ESELF_TARGET,
      `条目 ${id} 的 target 指向桥产物本身（${SELF_ARTEFACT_NAME}）：桥绝不能补丁自己（自指递归）`,
    );
  }
  if (typeof raw.symbol !== 'string' || raw.symbol === '') {
    return fail(PATCH_CODES.EINVALID_ITEM, `条目 ${id} 需要非空的字符串 symbol`);
  }
  if (typeof raw.kind !== 'string' || VALID_KINDS.has(raw.kind) !== true) {
    return fail(PATCH_CODES.EINVALID_ITEM, `条目 ${id} 的 kind 只支持 replace / wrap`);
  }
  if (typeof raw.source !== 'string' || raw.source.trim() === '') {
    return fail(PATCH_CODES.EINVALID_SOURCE, `条目 ${id} 需要非空的 source 文本`);
  }
  const sourceBytes = utf8Bytes(raw.source);
  if (sourceBytes > PATCH_SOURCE_MAX_BYTES) {
    return fail(
      PATCH_CODES.ESOURCE_TOO_LARGE,
      `条目 ${id} 的 source 有 ${sourceBytes} 字节，超过 ${PATCH_SOURCE_MAX_BYTES} 字节的安全上限`,
      { bytes: sourceBytes, limit: PATCH_SOURCE_MAX_BYTES },
    );
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    return fail(PATCH_CODES.EINVALID_ITEM, `条目 ${id} 的 enabled 必须是布尔值`);
  }
  return {
    ok: true,
    item: {
      id,
      owner,
      target: raw.target,
      symbol: raw.symbol,
      kind: raw.kind,
      source: raw.source,
      enabled: raw.enabled !== false,
    },
  };
}

/**
 * 校验一份条目数组（一个 owner 的全部条目）。
 *
 * 空数组是拒绝的：不再贡献补丁的 owner 应当调用 `unpatch`（或
 * `patch({owner, remove:true})`）。这和菜单注册表同一条规则、同一个理由——「用空
 * 数组表达删除」会让「忘了带 items」变成「悄悄删掉自己的补丁」。
 *
 * @param {string} owner
 * @param {unknown} raw
 * @returns {{ ok: true, items: object[] } | { ok: false, code: string, message: string }}
 */
function normalizeItems(owner, raw) {
  if (!Array.isArray(raw)) return fail(PATCH_CODES.EINVALID_ITEM, 'items 必须是数组');
  if (raw.length === 0) {
    return fail(
      PATCH_CODES.EINVALID_ITEM,
      'items 不能为空：不再贡献补丁的 owner 应当调用 unpatch（或 patch({owner, remove:true})）',
    );
  }
  if (raw.length > PATCH_ITEM_LIMIT) {
    return fail(
      PATCH_CODES.EITEM_LIMIT,
      `一个 owner 最多 ${PATCH_ITEM_LIMIT} 个条目，收到 ${raw.length} 个`,
      { count: raw.length, limit: PATCH_ITEM_LIMIT },
    );
  }
  const items = [];
  const seen = new Set();
  for (let index = 0; index < raw.length; index++) {
    const checked = normalizeItem(owner, raw[index], index);
    if (checked.ok !== true) return checked;
    if (seen.has(checked.item.id)) {
      return fail(PATCH_CODES.EINVALID_ITEM, `条目 id ${checked.item.id} 重复`);
    }
    seen.add(checked.item.id);
    items.push(checked.item);
  }
  return { ok: true, items };
}

/**
 * 建一个动态补丁注册表。
 *
 * @param {{ stateDir: string }} options
 * @returns {{
 *   patch: (owner: string, items: unknown) => object,
 *   unpatch: (owner: string) => object,
 *   clear: () => object,
 *   snapshot: () => object,
 *   flush: () => object,
 *   read: () => { ok: true, text: string | null },
 * }}
 */
export function createPatchRegistry(options) {
  const settings = isObject(options) ? options : {};
  const stateDir = typeof settings.stateDir === 'string' && settings.stateDir.length > 0 ? settings.stateDir : null;
  const patchesPath = stateDir === null ? null : join(stateDir, FILES.patches);

  /** @type {Map<string, { items: object[] }>} owner 表，插入顺序 = 文档里的顺序 */
  let entries = new Map();
  /** 单调递增的**补丁版本号**（不是渲染序号，见头注释）。 */
  let rev = 0;
  /** 上一次合成的结果（文档 / 文本）。 */
  let merged = compose(entries, rev);
  /** 上一次真正落盘的文本；内容没变就不重写。 */
  let lastWrittenText = null;
  let tmpSerial = 0;

  /**
   * 合成一份 protocol 1 文档。
   *
   * 键序写死：顶层 `protocol, rev, items`；条目 `id, owner, target, symbol, kind,
   * source, enabled`。`enabled` **总是写出来**（`true` 或 `false`），这样桥那边
   * 「缺字段 = 默认 true」的规则永远用不上——一份被读到的文档里，每个条目的意图都
   * 是**写明的**，不是靠默认推出来的。
   *
   * `rev` 是「这份补丁文档的第几个版本」。条目顺序 = owner 注册顺序、owner 内部
   * 声明顺序，所以同样的表 ⇒ 同样的字节。
   *
   * @param {Map<string, { items: object[] }>} owners
   * @param {number} currentRev
   * @returns {{ document: object, text: string, bytes: number, itemCount: number,
   *             owners: { owner: string, itemCount: number }[] }}
   */
  function compose(owners, currentRev) {
    const items = [];
    const rows = [];
    for (const [owner, entry] of owners) {
      rows.push({ owner, itemCount: entry.items.length });
      for (const item of entry.items) items.push(item);
    }
    const document = {
      protocol: PROTOCOLS.patches,
      rev: currentRev,
      items,
    };
    const text = `${JSON.stringify(document, null, 2)}\n`;
    return { document, text, bytes: utf8Bytes(text), itemCount: items.length, owners: rows };
  }

  /**
   * 落盘：非空 → 原子写；空 → 删文件。
   *
   * 「空 ⇒ 删文件」在这里的含义比菜单通道更重：桥把「文件不存在」当成空 spec，
   * 因此删掉这份文件就是**回滚所有已应用的补丁**的唯一手段。所以宁可删文件，也
   * 不写一份 `items: []` 的文档——后者同样会被桥当成空 spec，但前者让「没有补丁」
   * 在磁盘上有一个**不可误解的**表达（与 menu.json / notify.json 一致）。
   *
   * @param {ReturnType<typeof compose>} target
   * @returns {{ ok: true, written: boolean, deleted: boolean } | { ok: false, code: string, message: string }}
   */
  function persist(target) {
    if (patchesPath === null) return fail(PATCH_CODES.EWRITE_FAILED, '没有可用的状态目录，无法写 patches.json');
    let temporary = null;
    try {
      if (target.itemCount === 0) {
        const existed = existsSync(patchesPath);
        rmSync(patchesPath, { force: true });
        lastWrittenText = null;
        return { ok: true, written: false, deleted: existed };
      }
      if (lastWrittenText === target.text && fileLooksCurrent()) {
        return { ok: true, written: false, deleted: false };
      }
      mkdirSync(stateDir, { recursive: true });
      temporary = `${patchesPath}.tmp-${process.pid}-${++tmpSerial}`;
      writeFileSync(temporary, target.text, 'utf8');
      renameSync(temporary, patchesPath);
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
      return fail(PATCH_CODES.EWRITE_FAILED, `写入 ${String(patchesPath)} 失败：${errorMessage(error)}`);
    }
  }

  /**
   * 磁盘上的文件是否仍是「我们上一次写下的那一份」。
   *
   * 只看文本缓存会漏掉外部改动：别人把 patches.json 删了或改坏了，缓存里的文本仍然
   * 相等，于是我们再也不写回去，桥就一直看不到补丁（或在桥侧看到一份被改过的代码
   * 文档）。所以再看一眼内容。
   *
   * @returns {boolean}
   */
  function fileLooksCurrent() {
    if (patchesPath === null || lastWrittenText === null) return false;
    try {
      const stats = statSync(patchesPath);
      if (stats.isFile() !== true) return false;
      return readFileSync(patchesPath, 'utf8') === lastWrittenText;
    } catch (_error) {
      return false;
    }
  }

  /**
   * 「改副本 → 合并 → 判大小 → 写盘 → 提交」。写盘失败时内存不动。
   *
   * @param {(next: Map<string, { items: object[] }>) => ({ ok: true } | { ok: false, code: string, message: string })} mutate
   * @returns {object}
   */
  function change(mutate) {
    const nextEntries = new Map(entries);
    const mutated = mutate(nextEntries);
    if (mutated.ok !== true) return mutated;

    const nextRev = rev + 1;
    const nextMerged = compose(nextEntries, nextRev);
    if (nextMerged.bytes > PATCH_MAX_BYTES) {
      return fail(
        PATCH_CODES.EPATCH_TOO_LARGE,
        `合并后的 patches.json 有 ${nextMerged.bytes} 字节，超过 ${PATCH_MAX_BYTES} 字节上限`,
        { bytes: nextMerged.bytes, limit: PATCH_MAX_BYTES },
      );
    }

    const written = persist(nextMerged);
    if (written.ok !== true) return written;

    entries = nextEntries;
    merged = nextMerged;
    rev = nextRev;
    return { ok: true, rev, itemCount: merged.itemCount, written: written.written, deleted: written.deleted };
  }

  return {
    /**
     * 登记 / 替换一个 owner 的补丁条目。
     *
     * 重复调用同一个 owner 是「更新」并保持它原来的位置（不会跳到队尾）。登记**完全
     * 相同**的条目是空操作：rev 不变、盘上字节不变——桥按文本指纹决定要不要同步，
     * 所以「重放同一份声明」在整条链路上都是零成本的。
     *
     * @param {string} owner 例如 `'@local/dsh-power'`
     * @param {unknown} items 条目数组
     * @returns {{ ok: true, rev: number, itemCount: number, unchanged?: boolean }
     *         | { ok: false, code: string, message: string }}
     */
    patch(owner, items) {
      const ownerCheck = validateOwnerString(owner, MAX_OWNER_LENGTH, OWNER_SEPARATOR);
      if (ownerCheck.ok !== true) return fail(PATCH_CODES.EINVALID_OWNER, ownerCheck.message);
      const validated = normalizeItems(owner, items);
      if (validated.ok !== true) return validated;

      const existing = entries.get(owner);
      if (existing !== undefined && JSON.stringify(existing.items) === JSON.stringify(validated.items)) {
        // 同一份声明再来一次：rev 不动、不回写；但如果文件被外部删掉 / 改坏，这次
        // 调用就顺手修回来（rev 仍不动，所以桥那边的指纹也不变）。
        const repaired = persist(merged);
        if (repaired.ok !== true) return repaired;
        return { ok: true, rev, itemCount: merged.itemCount, unchanged: true, written: repaired.written, deleted: repaired.deleted };
      }

      const result = change((next) => {
        next.set(owner, { items: validated.items });
        return { ok: true };
      });
      if (result.ok !== true) return result;
      return { ok: true, rev: result.rev, itemCount: result.itemCount, written: result.written, deleted: result.deleted };
    },

    /**
     * 撤走一个 owner 的全部补丁（它的条目从文档里消失，桥在下一个轮询里回滚它们）。
     *
     * 没登记过的 owner 是**成功空操作**（rev 不变、不重写文件），这样插件的清理路径
     * 可以无脑调用。
     *
     * @param {string} owner
     * @returns {{ ok: true, rev: number, itemCount: number, removed: boolean }
     *         | { ok: false, code: string, message: string }}
     */
    unpatch(owner) {
      const ownerCheck = validateOwnerString(owner, MAX_OWNER_LENGTH, OWNER_SEPARATOR);
      if (ownerCheck.ok !== true) return fail(PATCH_CODES.EINVALID_OWNER, ownerCheck.message);
      if (entries.has(owner) !== true) {
        return { ok: true, rev, itemCount: merged.itemCount, removed: false };
      }
      const result = change((next) => {
        next.delete(owner);
        return { ok: true };
      });
      if (result.ok !== true) return result;
      return { ok: true, rev: result.rev, itemCount: result.itemCount, removed: true };
    },

    /**
     * 清空整张表（所有 owner）——即**回滚全部补丁**。
     *
     * @returns {{ ok: true, rev: number, itemCount: number, cleared: boolean }
     *         | { ok: false, code: string, message: string }}
     */
    clear() {
      if (entries.size === 0) return { ok: true, rev, itemCount: 0, cleared: false };
      const result = change((next) => {
        next.clear();
        return { ok: true };
      });
      if (result.ok !== true) return result;
      return { ok: true, rev: result.rev, itemCount: result.itemCount, cleared: true };
    },

    /**
     * 只读快照（诊断用）：不碰磁盘，也不重算。
     *
     * `document` 是内部对象，调用方按只读对待。
     *
     * @returns {{ rev: number, itemCount: number,
     *             owners: { owner: string, itemCount: number }[],
     *             document: object | null }}
     */
    snapshot() {
      return {
        rev,
        itemCount: merged.itemCount,
        owners: merged.owners.map((row) => ({ owner: row.owner, itemCount: row.itemCount })),
        document: merged.itemCount === 0 ? null : merged.document,
      };
    },

    /**
     * 把内存里的表重新落盘（patches.json 被外部删掉 / 改坏时用）。空表 → 删文件。
     *
     * @returns {{ ok: true, rev: number, written: boolean, deleted: boolean }
     *         | { ok: false, code: string, message: string }}
     */
    flush() {
      const written = persist(merged);
      if (written.ok !== true) return written;
      return { ok: true, rev, written: written.written, deleted: written.deleted };
    },

    /**
     * 读回当前文档的文本（给测试与诊断用；正常路径不需要）。
     *
     * @returns {{ ok: true, text: string | null } | { ok: false, code: string, message: string }}
     */
    read() {
      if (patchesPath === null) return { ok: true, text: null };
      try {
        return { ok: true, text: existsSync(patchesPath) ? readFileSync(patchesPath, 'utf8') : null };
      } catch (error) {
        return fail(PATCH_CODES.EWRITE_FAILED, `读取 ${patchesPath} 失败：${errorMessage(error)}`);
      }
    },
  };
}
