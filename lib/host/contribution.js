/**
 * 托盘贡献注册表 —— 文件式托盘协议的「写半身」。
 *
 * 桥（`bridge/dist/tray-bridge.js`，由 `lib/bridge/src/` 构建）是「读半身」：
 * 每 700 ms 读 `<stateDir>/menu.json`，把贡献项插进官方三项之间渲染，并把点击 /
 * 勾选追加到 `<stateDir>/events.jsonl`。在本模块之前，这个包里没有任何人写那份
 * 文档。
 *
 * 一个注册表由 Host 拥有、被所有通过 `asarShell` 贡献菜单的插件共享：它把每个
 * owner 的文档留在内存里，合并成**一份** protocol 2 文档，并原子地落盘。因此
 * `menu.json` 是派生文件：不手改、可重放、随时能从注册表重建。
 *
 * 本模块负责的约定：
 *  - id 命名空间 `owner + '#' + localId`：两个插件都可以用 `id: 'restart'`；
 *    `readEvents` 会把前缀形式拆回 `{ owner, localId }`。
 *  - `#` 是保留分隔符：owner 名里不允许出现它（见 `validateOwner`）。
 *  - 合并后的顶层顺序与桥的 `renderItems` 同构：有数字 `order` 的按 order 升序在
 *    前（同 order 按合并后的声明位置），没有 order 的按声明顺序在后。子菜单子项
 *    保持声明顺序、从不重排。于是文件本身就是渲染顺序，桥再排一次也是幂等的。
 *  - 同样的 owner 表 + 同样的 rev 产生**逐字节相同**的文本：桥靠文本指纹决定要
 *    不要重渲染，所以时间戳之类的东西绝不进文档。
 *  - 重复登记**完全相同**的文档是空操作：不增 rev、字节不变（仅在磁盘上的
 *    `menu.json` 缺了或被改坏时顺手写回）。
 *  - 空贡献会**删除** `menu.json`：「文件不存在」才是「没人贡献」的诚实信号。
 *  - 每个写操作都走「同目录临时文件 + rename」，崩溃不会留下半截 JSON；
 *    任何失败都返回 `{ ok:false, code, message }`，本模块不抛异常。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from '../fs-safe.js';
import { join } from 'node:path';

import { FILES, MENU_MAX_BYTES, PROTOCOLS } from '../wire/constants.js';
// 轮转槽位名与菜单深度上限只登记在桥的镜像常量里（`lib/wire/constants.js` 是冻结
// 的 ABI，没有这两项），所以从桥的源码常量取，避免两处各写一个字面量。
import { FILES as BRIDGE_FILES, MAX_MENU_DEPTH } from '../bridge/src/paths.js';

/** 顶层条目上限。托盘菜单不是列表视图，64 项已经比任何真实插件需求都宽。 */
export const MAX_TOP_LEVEL_ITEMS = 64;

/** 条目总数（含子菜单子项）上限，防止一份文档靠嵌套把 256 KiB 预算吃满。 */
export const MAX_TOTAL_ITEMS = 256;

/** owner 名长度上限。 */
export const MAX_OWNER_LENGTH = 128;

/** owner 与局部 id 之间的分隔符；owner 名里不允许出现。 */
export const OWNER_SEPARATOR = '#';

/** 本模块的失败码；全部是稳定字符串，供调用方与文档引用。 */
export const CONTRIBUTION_CODES = {
  /** owner 不是可用字符串（空 / 首尾空白 / 含 `#` / 含控制字符 / 过长）。 */
  EINVALID_OWNER: 'EINVALID_OWNER',
  /** 文档本身不是 `items` 数组 / `{items, tray?}` 对象，或不可序列化为 JSON。 */
  EINVALID_DOCUMENT: 'EINVALID_DOCUMENT',
  /** 单个条目形状不对（类型、字段类型、缺 label、过深……）。 */
  EINVALID_ITEM: 'EINVALID_ITEM',
  /** 同一份文档里 id 重复（含子菜单子项）。 */
  EDUPLICATE_ID: 'EDUPLICATE_ID',
  /** 顶层或总条目数超过上限。 */
  EITEM_LIMIT: 'EITEM_LIMIT',
  /** 合并后的文档超过 `MENU_MAX_BYTES`（256 KiB）。 */
  EMENU_TOO_LARGE: 'EMENU_TOO_LARGE',
  /** 读 events.jsonl 失败（不是 ENOENT 的那类错误）。 */
  EREAD_FAILED: 'EREAD_FAILED',
  /** 写 / 删 menu.json 失败。 */
  EWRITE_FAILED: 'EWRITE_FAILED',
};

/** 桥认识的四种条目类型；不认识的 type 会被桥静默当成 normal，这里先报出来。 */
const VALID_TYPES = new Set(['normal', 'separator', 'checkbox', 'submenu']);

/** @returns {boolean} 真值表示普通（非数组、非 null）对象 */
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

/** @returns {boolean} 真值表示「文件不存在」这一类错误 */
function isMissingFile(error) {
  return isObject(error) && error.code === 'ENOENT';
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details] 额外字段（bytes、limit、id……）
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
 * 校验 owner。
 *
 * `#` 是保留分隔符：只有 owner 里不出现它，`owner + '#' + localId` 才能在**任意**
 * localId（localId 自己可以含 `#`）上可逆。
 *
 * @param {unknown} owner
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function validateOwner(owner) {
  const checked = validateOwnerString(owner, MAX_OWNER_LENGTH, OWNER_SEPARATOR);
  if (checked.ok !== true) return { ok: false, code: CONTRIBUTION_CODES.EINVALID_OWNER, message: checked.message };
  return { ok: true };
}

/**
 * owner 校验的**参数化**版本，供同一 owner 命名空间的其他通道复用。
 *
 * 通知通道（`lib/host/notify-registry.js`）用的是同一套命名空间规则：`#` 分隔
 * owner 与条目序号，所以 owner 里不能有 `#`。把规则抄一遍是最容易发生的漂移
 * ——两个通道对「什么是一个合法 owner」给出不同答案时，插件会先在一个通道里
 * 成功、在另一个里失败，而两边的文档都写着「和菜单一样」。所以规则只有一份，
 * 失败码由调用方给（每个通道有自己的 ABI 里的码）。
 *
 * @param {unknown} owner
 * @param {number} maxLength
 * @param {string} separator
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateOwnerString(owner, maxLength, separator) {
  const limit = typeof maxLength === 'number' && maxLength > 0 ? maxLength : MAX_OWNER_LENGTH;
  const gap = typeof separator === 'string' && separator !== '' ? separator : OWNER_SEPARATOR;
  if (typeof owner !== 'string') return { ok: false, message: 'owner 必须是字符串' };
  if (owner.length === 0) return { ok: false, message: 'owner 不能为空' };
  if (owner.length > limit) return { ok: false, message: `owner 最长 ${limit} 个字符，收到 ${owner.length} 个` };
  if (owner.trim() !== owner) return { ok: false, message: 'owner 首尾不能有空白字符' };
  if (owner.indexOf(gap) >= 0) {
    return { ok: false, message: `owner 不能包含 "${gap}"：它是 owner 与局部 id 的分隔符` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(owner)) return { ok: false, message: 'owner 不能包含控制字符' };
  return { ok: true };
}

/**
 * 校验并深拷贝一份贡献文档。
 *
 * 接受两种形状：`{ items: [...], tray?: { tooltip?: string } }` 或裸 items 数组。
 * 校验是逐条、递归的：不认识的 type、缺 label 的普通项、空子菜单、过深的嵌套、
 * 文档内重复的 id、`__proto__` 键都会被拒绝 —— 这些在桥侧大多会变成「静默丢掉
 * 一行」，与其让作者对着一个不出现的菜单猜，不如在这里说清楚。
 *
 * 深拷贝用一次 JSON 往返完成：这份文档最终就是一段 JSON 文本，所以「能序列化」
 * 本身也是一条校验（循环引用 / 抛异常的 getter 会在这里失败）。
 *
 * @param {unknown} input
 * @returns {{ ok: true, items: object[], tooltip: string } | { ok: false, code: string, message: string }}
 */
function validateDocument(input) {
  let rawItems;
  let tooltip = '';

  if (Array.isArray(input)) {
    rawItems = input;
  } else if (isObject(input)) {
    rawItems = input.items;
    if (input.tray !== undefined && input.tray !== null) {
      if (!isObject(input.tray)) return fail(CONTRIBUTION_CODES.EINVALID_DOCUMENT, 'tray 必须是对象');
      if (input.tray.tooltip !== undefined && typeof input.tray.tooltip !== 'string') {
        return fail(CONTRIBUTION_CODES.EINVALID_DOCUMENT, 'tray.tooltip 必须是字符串');
      }
      tooltip = typeof input.tray.tooltip === 'string' ? input.tray.tooltip : '';
    }
  } else {
    return fail(CONTRIBUTION_CODES.EINVALID_DOCUMENT, '贡献文档必须是 items 数组或 { items, tray? } 对象');
  }

  if (!Array.isArray(rawItems)) return fail(CONTRIBUTION_CODES.EINVALID_DOCUMENT, 'items 必须是数组');
  if (rawItems.length === 0) {
    return fail(
      CONTRIBUTION_CODES.EINVALID_DOCUMENT,
      'items 不能为空：不再贡献任何条目的 owner 应当调用 remove（或 contribute({owner, remove:true})）',
    );
  }
  if (rawItems.length > MAX_TOP_LEVEL_ITEMS) {
    return fail(
      CONTRIBUTION_CODES.EITEM_LIMIT,
      `顶层最多 ${MAX_TOP_LEVEL_ITEMS} 个条目，收到 ${rawItems.length} 个`,
      { count: rawItems.length, limit: MAX_TOP_LEVEL_ITEMS },
    );
  }

  const state = { seen: new Set(), count: { value: 0 } };
  const checked = validateLevel(rawItems, 1, state, 'items');
  if (checked.ok !== true) return checked;

  let items;
  try {
    items = JSON.parse(JSON.stringify(rawItems));
  } catch (error) {
    return fail(CONTRIBUTION_CODES.EINVALID_DOCUMENT, `贡献文档必须能序列化为 JSON：${errorMessage(error)}`);
  }
  return { ok: true, items, tooltip };
}

/**
 * @param {unknown} rawItems
 * @param {number} depth 1 表示顶层
 * @param {{ seen: Set<string>, count: { value: number } }} state
 * @param {string} where 面向作者的位置描述
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function validateLevel(rawItems, depth, state, where) {
  if (!Array.isArray(rawItems)) return fail(CONTRIBUTION_CODES.EINVALID_ITEM, `${where} 必须是数组`);
  for (let index = 0; index < rawItems.length; index++) {
    const checked = validateItem(rawItems[index], depth, state, `${where}[${index}]`);
    if (checked.ok !== true) return checked;
  }
  return { ok: true };
}

/**
 * @param {unknown} raw
 * @param {number} depth 1 表示顶层
 * @param {{ seen: Set<string>, count: { value: number } }} state
 * @param {string} where
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function validateItem(raw, depth, state, where) {
  if (!isObject(raw)) return fail(CONTRIBUTION_CODES.EINVALID_ITEM, `${where} 不是对象`);
  // 防原型污染：JSON.parse 可以产出自有键 "__proto__"，而后续按 key 复制会把它
  // 当赋值目标。直接拒绝，比在每个赋值点写 defineProperty 便宜。
  if (Object.prototype.hasOwnProperty.call(raw, '__proto__')) {
    return fail(CONTRIBUTION_CODES.EINVALID_ITEM, `${where} 不能带 __proto__ 键`);
  }

  state.count.value += 1;
  if (state.count.value > MAX_TOTAL_ITEMS) {
    return fail(
      CONTRIBUTION_CODES.EITEM_LIMIT,
      `贡献文档最多 ${MAX_TOTAL_ITEMS} 个条目（含子菜单子项），在 ${where} 处超了`,
      { count: state.count.value, limit: MAX_TOTAL_ITEMS },
    );
  }

  const type = raw.type === undefined ? 'normal' : raw.type;
  if (typeof type !== 'string' || VALID_TYPES.has(type) !== true) {
    return fail(
      CONTRIBUTION_CODES.EINVALID_ITEM,
      `${where}.type 只支持 normal/separator/checkbox/submenu，收到 ${String(raw.type)}`,
    );
  }

  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || raw.id === '') {
      return fail(CONTRIBUTION_CODES.EINVALID_ITEM, `${where}.id 必须是非空字符串`);
    }
    if (state.seen.has(raw.id)) {
      return fail(
        CONTRIBUTION_CODES.EDUPLICATE_ID,
        `同一份贡献文档里 id "${raw.id}" 重复了（id 在本文档内必须唯一，子菜单子项也算）`,
        { id: raw.id },
      );
    }
    state.seen.add(raw.id);
  }

  if (raw.label !== undefined && typeof raw.label !== 'string') {
    return fail(CONTRIBUTION_CODES.EINVALID_ITEM, `${where}.label 必须是字符串`);
  }
  if (raw.labelKey !== undefined && (typeof raw.labelKey !== 'string' || raw.labelKey === '')) {
    return fail(CONTRIBUTION_CODES.EINVALID_ITEM, `${where}.labelKey 必须是非空字符串`);
  }
  if (type !== 'separator') {
    const hasLabel = typeof raw.label === 'string' && raw.label !== '';
    const hasLabelKey = typeof raw.labelKey === 'string' && raw.labelKey !== '';
    if (!hasLabel && !hasLabelKey) {
      return fail(
        CONTRIBUTION_CODES.EINVALID_ITEM,
        `${where} 既没有 label 也没有 labelKey：桥会把它静默丢掉，所以这里先拒绝`,
      );
    }
  }
  if (raw.order !== undefined && !(typeof raw.order === 'number' && Number.isFinite(raw.order))) {
    return fail(CONTRIBUTION_CODES.EINVALID_ITEM, `${where}.order 必须是有限数字`);
  }
  for (const flag of ['checked', 'enabled', 'visible']) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') {
      return fail(CONTRIBUTION_CODES.EINVALID_ITEM, `${where}.${flag} 必须是布尔值`);
    }
  }
  if (raw.tooltip !== undefined && typeof raw.tooltip !== 'string') {
    return fail(CONTRIBUTION_CODES.EINVALID_ITEM, `${where}.tooltip 必须是字符串`);
  }

  if (type === 'submenu') {
    if (depth >= MAX_MENU_DEPTH) {
      return fail(
        CONTRIBUTION_CODES.EINVALID_ITEM,
        `${where} 在第 ${depth} 层：桥最多渲染 ${MAX_MENU_DEPTH} 层，再深一层会被丢掉`,
        { depth, limit: MAX_MENU_DEPTH },
      );
    }
    if (!Array.isArray(raw.items)) return fail(CONTRIBUTION_CODES.EINVALID_ITEM, `${where}.items 必须是数组`);
    if (raw.items.length === 0) {
      return fail(CONTRIBUTION_CODES.EINVALID_ITEM, `${where}.items 不能为空：空子菜单会被桥丢掉`);
    }
    return validateLevel(raw.items, depth + 1, state, `${where}.items`);
  }

  if (raw.items !== undefined) {
    return fail(CONTRIBUTION_CODES.EINVALID_ITEM, `${where}.items 只能用在 type:"submenu" 上`);
  }
  return { ok: true };
}

/**
 * 加前缀并同时记录映射。子菜单子项同样加前缀：事件里带的就是这套 id。
 *
 * 键序写死为「id 在最前，其余键按声明顺序」——同样的输入因此产生同样的字节。
 *
 * @param {Record<string, any>} item 已校验、已深拷贝的条目（带局部 id）
 * @param {string} owner
 * @param {Map<string, { owner: string, localId: string }>} byPrefixed
 * @returns {Record<string, any>} 用于写入文档的条目
 */
function prefixItem(item, owner, byPrefixed) {
  const out = {};
  if (typeof item.id === 'string') {
    const prefixed = owner + OWNER_SEPARATOR + item.id;
    out.id = prefixed;
    byPrefixed.set(prefixed, { owner, localId: item.id });
  }
  for (const key of Object.keys(item)) {
    if (key === 'id') continue;
    if (key === 'items') {
      out.items = item.items.map((child) => prefixItem(child, owner, byPrefixed));
      continue;
    }
    out[key] = item[key];
  }
  return out;
}

/**
 * 按桥 `renderItems` 的同一套总序排好顶层条目：
 *
 *  - 有数字 `order` 的：按 order 升序，同 order 按合并后的声明位置；
 *  - 没有 `order` 的：按合并后的声明位置，排在所有有 order 的后面。
 *
 * 于是 `menu.json` 自身的顺序就是渲染顺序，桥再排一次结果不变（幂等），事件里
 * 的 `path`（渲染后的索引）也能直接对照文件里的下标。
 *
 * @param {object[]} items 声明顺序的顶层条目
 * @returns {object[]}
 */
function renderOrder(items) {
  const ordered = [];
  const unordered = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const order = item.order;
    if (typeof order === 'number' && Number.isFinite(order)) ordered.push({ item, index, order });
    else unordered.push({ item, index });
  }
  ordered.sort((left, right) => left.order - right.order || left.index - right.index);
  return ordered.map((entry) => entry.item).concat(unordered.map((entry) => entry.item));
}

/**
 * 把一份合并结果连同其中的嵌套条目一起冻结。
 *
 * `snapshot()` 是「廉价」的（不碰磁盘、不重算），所以它直接把内部文档交出去；
 * 那就必须保证调用方改不动它 —— 否则一次 `document.items.pop()` 就能让内存里的
 * 合并结果和磁盘上的文件悄悄分叉。冻结在**合并**时做一次，快照本身零成本，
 * 误改会在严格模式下立刻报错，而不是几天后变成一个查不出来的菜单 bug。
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

/**
 * 把 owner 表合成一份 protocol 2 文档。
 *
 * owner 顺序 = 注册顺序（`Map` 插入顺序）；每个 owner 内部保持声明顺序。文档键序
 * 固定为 `protocol, rev, items, tray`，所以同样的 owner 表产生同样的文本。
 * `tray.tooltip` 取**第一个**设置了非空 tooltip 的 owner（注册顺序优先），那个
 * owner 撤走时自动轮到下一个。
 *
 * @param {Map<string, { items: object[], tooltip: string, updatedAt: string }>} owners
 * @param {number} rev
 * @returns {{
 *   document: object,
 *   text: string,
 *   byPrefixed: Map<string, { owner: string, localId: string }>,
 *   owners: { owner: string, itemCount: number, updatedAt: string }[],
 *   itemCount: number,
 * }}
 */
function compose(owners, rev) {
  const byPrefixed = new Map();
  const rows = [];
  const declared = [];
  let tooltip = '';

  for (const [owner, entry] of owners) {
    rows.push({ owner, itemCount: entry.items.length, updatedAt: entry.updatedAt });
    if (tooltip === '' && typeof entry.tooltip === 'string' && entry.tooltip !== '') tooltip = entry.tooltip;
    for (const item of entry.items) declared.push(prefixItem(item, owner, byPrefixed));
  }

  const items = renderOrder(declared);
  const document = deepFreeze({
    protocol: PROTOCOLS.menu,
    rev,
    items,
    tray: { tooltip },
  });
  return {
    document,
    text: `${JSON.stringify(document, null, 2)}\n`,
    byPrefixed,
    owners: rows,
    itemCount: items.length,
  };
}

/**
 * 把前缀 id 拆回 `{ owner, localId }`。
 *
 * 因为 owner 不含 `#`、localId 非空，按**第一个** `#` 切分一定是原样（localId
 * 自己可以含 `#`）。注册表还额外保留了一份活映射（`byPrefixed`），先查它、查不
 * 到再按编码切分 —— 这样 owner 早已撤走时，旧事件也能归位。
 *
 * @param {string} prefixedId
 * @returns {{ owner: string | null, localId: string }}
 */
function splitPrefixed(prefixedId) {
  const at = prefixedId.indexOf(OWNER_SEPARATOR);
  if (at <= 0) return { owner: null, localId: prefixedId };
  return { owner: prefixedId.slice(0, at), localId: prefixedId.slice(at + 1) };
}

/**
 * 把一行桥侧事件记录翻译成 Host 侧形状。
 *
 * @param {Record<string, any>} record
 * @param {Map<string, { owner: string, localId: string }>} byPrefixed
 * @returns {object}
 */
function decodeEvent(record, byPrefixed) {
  const rawId = typeof record.id === 'string' && record.id !== '' ? record.id : null;
  let owner = null;
  let localId = null;
  if (rawId !== null) {
    const known = byPrefixed.get(rawId);
    if (known === undefined) {
      const split = splitPrefixed(rawId);
      owner = split.owner;
      localId = split.localId;
    } else {
      owner = known.owner;
      localId = known.localId;
    }
  }
  const event = {
    protocol: record.protocol,
    at: record.at,
    type: record.type,
    // `id` 是去掉 owner 前缀后的局部 id；`localId` 是同一个东西的显式名字，
    // 让调用方不必猜「这个 id 到底是不是已经拆过前缀」。
    id: localId,
    localId,
    owner,
    path: Array.isArray(record.path) ? record.path.slice() : [],
  };
  if (typeof record.checked === 'boolean') event.checked = record.checked;
  if (rawId !== null) event.prefixedId = rawId;
  return event;
}

/**
 * 建一个贡献注册表。
 *
 * @param {{ stateDir: string, now?: () => Date }} options
 * @returns {{
 *   add: (owner: string, document: unknown) => object,
 *   remove: (owner: string) => object,
 *   clear: () => object,
 *   snapshot: () => { rev: number, owners: object[], itemCount: number, document: object | null },
 *   flush: () => object,
 *   readEvents: (cursor?: number) => object,
 * }}
 */
export function createContributionRegistry(options) {
  const settings = isObject(options) ? options : {};
  const stateDir = typeof settings.stateDir === 'string' && settings.stateDir.length > 0 ? settings.stateDir : null;
  const now = typeof settings.now === 'function' ? settings.now : () => new Date();

  const menuPath = stateDir === null ? null : join(stateDir, FILES.menu);
  const eventsPath = stateDir === null ? null : join(stateDir, FILES.events);
  // 轮转槽固定是「活动文件 + .1」（桥侧 FILES.eventsRotated）——从桥的常量取，
  // 免得两处各写一个字符串而悄悄漂移。
  const rotatedPath = stateDir === null ? null : join(stateDir, BRIDGE_FILES.eventsRotated);

  /** @type {Map<string, { items: object[], tooltip: string, updatedAt: string }>} */
  let entries = new Map();
  /** 单调递增。文档里写着它，纯粹供人排障（桥按文本指纹决定要不要重渲染）。 */
  let rev = 0;
  /** 上一次合并结果（文档 / 文本 / id 映射 / owner 摘要）。 */
  let merged = compose(entries, rev);
  /** 上一次真正落盘的文本；用来避免「内容没变也重写一遍」。 */
  let lastWrittenText = null;
  /** 落盘后那一刻的文件签名（`size:mtimeMs`），用来发现外部改动 / 截断。 */
  let lastWrittenStat = null;
  /** 临时文件名序号，保证同一进程内并发调用不会撞名。 */
  let tmpSerial = 0;

  /** @returns {string} 快照用的时间戳（不进入文档，所以不影响字节稳定性） */
  function timestamp() {
    try {
      const value = now();
      if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
      if (typeof value === 'string' && value !== '') return value;
    } catch (_error) {
      // 时间戳只是快照里的元数据：取不到就留空，不影响菜单。
    }
    return '';
  }

  /**
   * 文件当前是否仍是「上一次写下的那一份」。
   *
   * 只看文本缓存会漏掉外部改动：别人把 menu.json 改坏（长度不同、内容不同）时
   * 缓存里的文本仍然相等，于是我们再也不写回去，桥就一直渲染坏文档。所以再比
   * 一次 `size:mtimeMs` 签名；对不上就重写一次（内容本来相同，字节不变）。
   *
   * @returns {boolean}
   */
  function fileLooksCurrent() {
    if (lastWrittenText === null || lastWrittenStat === null) return false;
    try {
      const stats = statSync(menuPath);
      if (stats.isFile() !== true) return false;
      if (`${stats.size}:${stats.mtimeMs}` !== lastWrittenStat) return false;
      return readFileSync(menuPath, 'utf8') === lastWrittenText;
    } catch (_error) {
      return false;
    }
  }

  /**
   * 落盘当前合并结果：非空 → 原子写；空 → 删文件（「不存在」= 没人贡献）。
   *
   * @param {ReturnType<typeof compose>} target
   * @returns {{ ok: true, written: boolean, deleted: boolean } | { ok: false, code: string, message: string }}
   */
  function persist(target) {
    if (menuPath === null) return fail(CONTRIBUTION_CODES.EWRITE_FAILED, '没有可用的状态目录，无法写 menu.json');
    let temporary = null;
    try {
      if (target.itemCount === 0) {
        const existed = existsSync(menuPath);
        rmSync(menuPath, { force: true });
        lastWrittenText = null;
        lastWrittenStat = null;
        return { ok: true, written: false, deleted: existed };
      }
      // 文本相同且文件确实还是那一份 → 不必重写：桥的指纹就是文本，重写不会改变
      // 渲染结果。文件被外部删掉 / 改坏时这里会发现并写回去。
      if (lastWrittenText === target.text && fileLooksCurrent()) {
        return { ok: true, written: false, deleted: false };
      }
      mkdirSync(stateDir, { recursive: true });
      temporary = `${menuPath}.tmp-${process.pid}-${++tmpSerial}`;
      writeFileSync(temporary, target.text, 'utf8');
      renameSync(temporary, menuPath);
      lastWrittenText = target.text;
      try {
        const stats = statSync(menuPath);
        lastWrittenStat = `${stats.size}:${stats.mtimeMs}`;
      } catch (_error) {
        lastWrittenStat = null;
      }
      return { ok: true, written: true, deleted: false };
    } catch (error) {
      if (temporary !== null) {
        try {
          rmSync(temporary, { force: true });
        } catch (_cleanupError) {
          // 已经失败一次了，临时文件残留不值得再抛。
        }
      }
      return fail(CONTRIBUTION_CODES.EWRITE_FAILED, `写入 ${menuPath} 失败：${errorMessage(error)}`);
    }
  }

  /**
   * 「复制 → 改副本 → 合并 → 写盘 → 提交」。
   *
   * 写盘失败时内存状态不动，磁盘与内存因此不会不一致；成功后才换 rev。
   *
   * @param {(next: Map<string, object>) => { ok: true } | { ok: false, code: string, message: string }} mutate
   * @returns {{ ok: true, rev: number, itemCount: number } | { ok: false, code: string, message: string }}
   */
  function change(mutate) {
    const nextEntries = new Map(entries);
    const mutated = mutate(nextEntries);
    if (mutated.ok !== true) return mutated;

    const nextRev = rev + 1;
    const nextMerged = compose(nextEntries, nextRev);
    const bytes = utf8Bytes(nextMerged.text);
    if (bytes > MENU_MAX_BYTES) {
      return fail(
        CONTRIBUTION_CODES.EMENU_TOO_LARGE,
        `合并后的 menu.json 有 ${bytes} 字节，超过 ${MENU_MAX_BYTES} 字节（256 KiB）上限`,
        { bytes, limit: MENU_MAX_BYTES },
      );
    }

    const written = persist(nextMerged);
    if (written.ok !== true) return written;

    entries = nextEntries;
    merged = nextMerged;
    rev = nextRev;
    return { ok: true, rev, itemCount: merged.itemCount };
  }

  return {
    /**
     * 登记 / 替换一个 owner 的贡献。
     *
     * 重复调用同一个 owner 是「更新」，并保持它原来的合并位置（不会跳到队尾）。
     * 登记**完全相同**的文档是空操作：rev 不变、盘上字节不变。
     *
     * @param {string} owner 例如 `'@local/dsh-power'`
     * @param {unknown} document `{ items, tray? }` 或裸 items 数组
     * @returns {{ ok: true, rev: number, itemCount: number, unchanged?: boolean }
     *         | { ok: false, code: string, message: string }}
     */
    add(owner, document) {
      const ownerCheck = validateOwner(owner);
      if (ownerCheck.ok !== true) return ownerCheck;
      const validated = validateDocument(document);
      if (validated.ok !== true) return validated;

      const existing = entries.get(owner);
      if (
        existing !== undefined &&
        existing.tooltip === validated.tooltip &&
        JSON.stringify(existing.items) === JSON.stringify(validated.items)
      ) {
        // 同样的文档再来一次：不增 rev、不回写，桥那边的文本指纹因此不变。
        // 但如果 menu.json 被外部删掉 / 改坏，这次调用就顺手修回来（rev 仍不动）。
        const repaired = persist(merged);
        if (repaired.ok !== true) return repaired;
        return { ok: true, rev, itemCount: merged.itemCount, unchanged: true, written: repaired.written };
      }

      const updatedAt = timestamp();
      const result = change((next) => {
        next.set(owner, { items: validated.items, tooltip: validated.tooltip, updatedAt });
        return { ok: true };
      });
      if (result.ok !== true) return result;
      return { ok: true, rev: result.rev, itemCount: result.itemCount };
    },

    /**
     * 撤走一个 owner。
     *
     * 没登记过的 owner 是**成功空操作**（rev 不变、不重写文件），这样插件的清理
     * 路径可以无脑调用。
     *
     * @param {string} owner
     * @returns {{ ok: true, rev: number, itemCount: number, removed: boolean }
     *         | { ok: false, code: string, message: string }}
     */
    remove(owner) {
      const ownerCheck = validateOwner(owner);
      if (ownerCheck.ok !== true) return ownerCheck;
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
     * 清空整张表（所有 owner）。表本来就空时是空操作。
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
     * 只读快照：不碰磁盘，也不重算文档。
     *
     * `document` 是内部对象，调用方按只读对待。
     *
     * @returns {{ rev: number, owners: { owner: string, itemCount: number, updatedAt: string }[],
     *             itemCount: number, document: object | null }}
     */
    snapshot() {
      return {
        rev,
        owners: merged.owners.map((row) => ({ owner: row.owner, itemCount: row.itemCount, updatedAt: row.updatedAt })),
        itemCount: merged.itemCount,
        document: merged.itemCount === 0 ? null : merged.document,
      };
    },

    /**
     * 把内存里的当前状态重新落盘（例如 menu.json 被外部删掉，或者插件被禁用时
     * 要把磁盘对齐到「现在还有谁在贡献」）。空表 → 删除 menu.json。
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
     * 从字节游标读出 events.jsonl 的新事件。
     *
     * 只消费**完整行**：末尾没有换行的那一行不消费，游标停在它的起点，下次补齐
     * 后再读。`id` 已从 `owner#localId` 拆回 `{ owner, localId }`。
     *
     * 轮转判定（任一成立就从头重读并回报 `rotated: true`）：
     *  - 文件比游标还短（文件缩了 = 被重写过 / 轮过了）；
     *  - `events.jsonl.1` 存在且比 `events.jsonl` 新（刚轮转完、还没追加）。
     * 轮转槽里的旧事件不重放：游标是字节位置，跨文件没有意义；调用方从
     * `rotated: true` 就知道中间有一段被丢掉了。
     *
     * @param {number} [cursor] 字节偏移；缺省 / 非法值按 0 处理
     * @returns {{ ok: true, events: object[], cursor: number, rotated: boolean, skipped: number }
     *         | { ok: false, code: string, message: string }}
     */
    readEvents(cursor) {
      if (eventsPath === null || rotatedPath === null) {
        return { ok: true, events: [], cursor: 0, rotated: false, skipped: 0 };
      }
      let offset = 0;
      if (typeof cursor === 'number' && Number.isFinite(cursor) && cursor > 0) offset = Math.floor(cursor);

      let live = null;
      try {
        live = statSync(eventsPath);
      } catch (error) {
        if (isMissingFile(error) !== true) {
          return fail(CONTRIBUTION_CODES.EREAD_FAILED, `读取 ${eventsPath} 失败：${errorMessage(error)}`);
        }
      }
      if (live === null || live.isFile() !== true) {
        // 没有事件文件：游标归零。如果调用方原本已经读到一个正数游标，那说明上一份
        // 文件被轮转 / 删掉了 —— 和「文件缩到比游标还短」是同一种事实，如实报 rotated。
        return { ok: true, events: [], cursor: 0, rotated: offset > 0, skipped: 0 };
      }

      let rotatedStats = null;
      try {
        rotatedStats = statSync(rotatedPath);
      } catch (_error) {
        rotatedStats = null;
      }
      // 两条独立的轮转证据；游标为 0 时它们都不成立（本来就没有「丢失的一段」）。
      let rotated = offset > 0 && live.size < offset;
      if (
        rotated !== true &&
        offset > 0 &&
        rotatedStats !== null &&
        rotatedStats.isFile() === true &&
        rotatedStats.mtimeMs > live.mtimeMs
      ) {
        rotated = true;
      }

      const start = rotated === true ? 0 : offset;
      let buffer;
      try {
        // 不带编码 → Buffer，字节偏移才有意义。
        buffer = readFileSync(eventsPath);
      } catch (error) {
        return fail(CONTRIBUTION_CODES.EREAD_FAILED, `读取 ${eventsPath} 失败：${errorMessage(error)}`);
      }
      const slice = buffer.subarray(start);

      // 最后一个换行的位置：它之前的每一行都是完整的，之后的是半截行。
      let cut = -1;
      for (let index = slice.length - 1; index >= 0; index--) {
        if (slice[index] === 0x0a) {
          cut = index;
          break;
        }
      }
      if (cut < 0) {
        return { ok: true, events: [], cursor: start, rotated, skipped: 0 };
      }

      const events = [];
      let skipped = 0;
      for (const line of slice.subarray(0, cut + 1).toString('utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let record;
        try {
          record = JSON.parse(trimmed);
        } catch (_parseError) {
          skipped += 1; // 一行坏 JSON 不该卡住整条通道。
          continue;
        }
        if (isObject(record) !== true) {
          skipped += 1;
          continue;
        }
        events.push(decodeEvent(record, merged.byPrefixed));
      }

      return { ok: true, events, cursor: start + cut + 1, rotated, skipped };
    },
  };
}
