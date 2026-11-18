/**
 * 托盘贡献注册表（写半身）的测试。
 *
 * 分工：桥是读半身（`test/bridge-menu.test.mjs` 钉住它的渲染），这里是写半身：
 * 合并文档、原子落盘、空表删文件、事件游标与轮转、id 命名空间往返。最后一条
 * 测试把写出的**文件文本**交给桥自己的 `renderMenu`，证明两端没有各说各话。
 *
 * `node --test --test-isolation=none test/contribution.test.mjs`
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from '../lib/fs-safe.js';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createContributionRegistry, MAX_TOP_LEVEL_ITEMS } from '../lib/host/contribution.js';
import { MAX_MENU_DEPTH, encodeEventLine } from '../lib/bridge/src/paths.js';
import { renderMenu } from '../lib/bridge/src/menu.js';
import { MENU_MAX_BYTES, PROTOCOLS, FILES } from '../lib/wire/constants.js';

/** 桥渲染官方三项时用的消息表（与真实 shell 同形）。 */
const MESSAGES = {
  aboutProduct: 'DeepSeek Harness',
  openApplication: 'Open DeepSeek Harness',
  quitApplication: 'Quit DeepSeek Harness',
};

/**
 * 跑一个测试体，配一个全新的临时状态目录，并保证清理。
 *
 * @param {(stateDir: string, helpers: object) => void} body
 */
function withStateDir(body) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-contribution-'));
  const stateDir = path.join(home, 'dsh-asar-framework');
  mkdirSync(stateDir, { recursive: true });
  const menuPath = path.join(stateDir, FILES.menu);
  const eventsPath = path.join(stateDir, FILES.events);
  const rotatedPath = `${eventsPath}.1`;
  const helpers = {
    stateDir,
    menuPath,
    eventsPath,
    rotatedPath,
    /** @returns {object|null} 解析后的 menu.json（文件不在时返回 null） */
    readMenu() {
      if (!existsSync(menuPath)) return null;
      return JSON.parse(readFileSync(menuPath, 'utf8'));
    },
    /** @returns {string|null} menu.json 的原始文本（文件不在时返回 null） */
    readMenuText() {
      return existsSync(menuPath) ? readFileSync(menuPath, 'utf8') : null;
    },
  };
  try {
    return body(stateDir, helpers);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** 固定时钟，让 updatedAt 可预测（它不进文档，所以不影响字节稳定性）。 */
function fixedClock(iso = '2026-01-01T00:00:00.000Z') {
  return () => new Date(iso);
}

test('add one owner writes a protocol-2 menu.json the bridge can read', () =>
  withStateDir((stateDir, h) => {
    const registry = createContributionRegistry({ stateDir, now: fixedClock() });
    const result = registry.add('@local/demo', {
      items: [
        { id: 'open', label: 'Demo: open' },
        { id: 'sep', type: 'separator' },
        { id: 'sub', type: 'submenu', label: 'Demo: more', items: [{ id: 'child', label: 'Child' }] },
      ],
      tray: { tooltip: 'Demo tray' },
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.itemCount, 3);
    assert.ok(result.rev >= 1, 'rev must start at 1');

    const written = h.readMenu();
    assert.notEqual(written, null, 'menu.json must exist after an add');
    assert.equal(written.protocol, PROTOCOLS.menu);
    assert.equal(written.protocol, 2);
    assert.equal(written.rev, result.rev);
    assert.equal(Array.isArray(written.items), true);
    assert.equal(written.items.length, 3);

    // id 命名空间 + 其余字段原样透传（tray.tooltip 是文档级覆盖）。
    assert.equal(written.items[0].id, '@local/demo#open');
    assert.equal(written.items[0].label, 'Demo: open');
    assert.equal(written.items[1].type, 'separator');
    assert.equal(written.items[2].type, 'submenu');
    assert.equal(written.items[2].items[0].id, '@local/demo#child');
    assert.deepEqual(written.tray, { tooltip: 'Demo tray' });

    // 快照是只读的：不碰磁盘，且能反映出当前状态。
    const snapshot = registry.snapshot();
    assert.equal(snapshot.rev, result.rev);
    assert.equal(snapshot.itemCount, 3);
    assert.deepEqual(snapshot.owners, [
      { owner: '@local/demo', itemCount: 3, updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    assert.equal(snapshot.document.protocol, 2);
    // 交出去的是冻结对象：调用方改不动它，否则内存与磁盘会悄悄分叉。
    assert.equal(Object.isFrozen(snapshot.document), true);
    assert.equal(Object.isFrozen(snapshot.document.items), true);
    assert.equal(Object.isFrozen(snapshot.document.items[2]), true, 'nested submenu entries are frozen too');
    assert.equal(Object.isFrozen(snapshot.document.tray), true);
  }));

test('two owners merge; declaration order inside a group, numeric order across the file', () =>
  withStateDir((stateDir, h) => {
    const registry = createContributionRegistry({ stateDir });
    assert.equal(
      registry.add('one', [
        { id: 'u1', label: 'One U1' },
        { id: 'n1', label: 'One N1', order: 9 },
        { id: 'u2', label: 'One U2' },
      ]).ok,
      true,
    );
    assert.equal(
      registry.add('two', [
        { id: 'm1', label: 'Two M1', order: 1 },
        { id: 'm2', label: 'Two M2' },
        { id: 'm3', label: 'Two M3' },
      ]).ok,
      true,
    );

    const written = h.readMenu();
    // 与桥的 renderItems 同一套总序：有 order 的按 order 升序在前，其余按合并后的
    // 声明顺序在后 —— 于是「组内保持声明顺序」与「顶层按 order 排序」同时成立。
    assert.deepEqual(
      written.items.map((item) => item.id),
      ['two#m1', 'one#n1', 'one#u1', 'one#u2', 'two#m2', 'two#m3'],
    );
    assert.deepEqual(
      written.items.map((item) => item.label),
      ['Two M1', 'One N1', 'One U1', 'One U2', 'Two M2', 'Two M3'],
    );

    const snapshot = registry.snapshot();
    assert.equal(snapshot.itemCount, 6);
    assert.deepEqual(
      snapshot.owners.map((row) => row.owner),
      ['one', 'two'],
      'owner rows follow registration order',
    );
  }));

test('ids are namespaced by owner: two owners may both use id "x"', () =>
  withStateDir((stateDir, h) => {
    const registry = createContributionRegistry({ stateDir });
    registry.add('alpha', [{ id: 'x', label: 'Alpha X' }]);
    registry.add('beta', [{ id: 'x', label: 'Beta X' }]);

    const written = h.readMenu();
    const ids = written.items.map((item) => item.id).sort();
    assert.deepEqual(ids, ['alpha#x', 'beta#x']);

    // 事件 → owner 映射：桥写出的是前缀 id，Host 必须能拆回去。
    writeFileSync(
      h.eventsPath,
      encodeEventLine({ type: 'click', id: 'alpha#x', path: [0], at: '2026-01-01T00:00:00.000Z' }) +
        encodeEventLine({ type: 'toggle', id: 'beta#x', path: [1], checked: true, at: '2026-01-01T00:00:01.000Z' }),
      'utf8',
    );
    const read = registry.readEvents(0);
    assert.equal(read.ok, true);
    assert.equal(read.events.length, 2);
    assert.equal(read.events[0].owner, 'alpha');
    assert.equal(read.events[0].id, 'x');
    assert.equal(read.events[0].prefixedId, 'alpha#x');
    assert.equal(read.events[1].owner, 'beta');
    assert.equal(read.events[1].id, 'x');
    assert.equal(read.events[1].type, 'toggle');
    assert.equal(read.events[1].checked, true);

    // 局部 id 自己可以含 '#'：按**第一个**分隔符切分，仍然回到原样。
    registry.add('gamma', [{ id: 'deep#nested', label: 'Gamma' }]);
    writeFileSync(
      h.eventsPath,
      encodeEventLine({ type: 'click', id: 'gamma#deep#nested', path: [0] }),
      'utf8',
    );
    const nested = registry.readEvents(0);
    assert.equal(nested.events[0].owner, 'gamma');
    assert.equal(nested.events[0].id, 'deep#nested');
  }));

test('a duplicate id inside ONE document is rejected, and nothing is written', () =>
  withStateDir((stateDir, h) => {
    const registry = createContributionRegistry({ stateDir });
    const result = registry.add('dup', [
      { id: 'x', label: 'First' },
      { type: 'submenu', label: 'Sub', items: [{ id: 'x', label: 'Second' }] },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EDUPLICATE_ID');
    assert.equal(h.readMenu(), null, 'a rejected document must not touch menu.json');
    assert.equal(registry.snapshot().rev, 0);

    // 同一个 id 落在不同 owner 里则完全允许（命名空间隔离）。
    assert.equal(registry.add('dup2', [{ id: 'x', label: 'Other owner' }]).ok, true);
    const written = h.readMenu();
    assert.deepEqual(written.items.map((item) => item.id), ['dup2#x']);
  }));

test('item-count cap and the 256 KiB ceiling are both enforced', () =>
  withStateDir((stateDir, h) => {
    const registry = createContributionRegistry({ stateDir });

    const tooMany = Array.from({ length: MAX_TOP_LEVEL_ITEMS + 1 }, (_value, index) => ({
      id: `i${index}`,
      label: `Item ${index}`,
    }));
    const overCount = registry.add('many', tooMany);
    assert.equal(overCount.ok, false);
    assert.equal(overCount.code, 'EITEM_LIMIT');
    assert.equal(overCount.limit, MAX_TOP_LEVEL_ITEMS);
    assert.equal(h.readMenu(), null);

    // 64 个条目、每个 4200 字符：条数在限内，序列化后超过 256 KiB。
    const big = Array.from({ length: MAX_TOP_LEVEL_ITEMS }, (_value, index) => ({
      id: `big${index}`,
      label: 'x'.repeat(4200),
    }));
    const overBytes = registry.add('big', big);
    assert.equal(overBytes.ok, false);
    assert.equal(overBytes.code, 'EMENU_TOO_LARGE');
    assert.ok(overBytes.bytes > MENU_MAX_BYTES, `expected > ${MENU_MAX_BYTES} bytes, got ${overBytes.bytes}`);
    assert.equal(h.readMenu(), null, 'an oversize merge must not be written');

    // 一个刚好过得去的文档仍然能写：上限是 256 KiB，不是 0。
    const fits = Array.from({ length: 3 }, (_value, index) => ({
      id: `ok${index}`,
      label: 'y'.repeat(4000),
    }));
    assert.equal(registry.add('ok', fits).ok, true);
    assert.ok(statSync(h.menuPath).size < MENU_MAX_BYTES);
  }));

test('a submenu deeper than MAX_MENU_DEPTH is rejected instead of silently dropped', () =>
  withStateDir((stateDir) => {
    const registry = createContributionRegistry({ stateDir });
    // depth 1 → 子项 depth 2 → 再一层 depth 3 已被桥拒绝，所以 Children 必须失败。
    const tooDeep = [
      {
        id: 'd1',
        type: 'submenu',
        label: 'One',
        items: [{ id: 'd2', type: 'submenu', label: 'Two', items: [{ id: 'd3', type: 'submenu', label: 'Three', items: [] }] }],
      },
    ];
    const result = registry.add('deep', tooDeep);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EINVALID_ITEM');
    assert.equal(result.limit, MAX_MENU_DEPTH);
  }));

test('remove keeps the other owner; removing the last DELETES menu.json', () =>
  withStateDir((stateDir, h) => {
    const registry = createContributionRegistry({ stateDir });
    registry.add('kept', [{ id: 'k', label: 'Kept' }]);
    registry.add('gone', [{ id: 'g', label: 'Gone', order: 1 }]);
    assert.equal(registry.snapshot().itemCount, 2);

    const removed = registry.remove('gone');
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);
    const after = h.readMenu();
    assert.deepEqual(after.items.map((item) => item.id), ['kept#k'], 'the other owner must survive');

    // 重复撤走是成功的空操作：rev 不动、文件不动。
    const again = registry.remove('gone');
    assert.equal(again.ok, true);
    assert.equal(again.removed, false);
    assert.equal(again.rev, removed.rev);

    const last = registry.remove('kept');
    assert.equal(last.ok, true);
    assert.equal(last.itemCount, 0);
    assert.equal(existsSync(h.menuPath), false, 'menu.json must be DELETED, not emptied');
    assert.equal(h.readMenuText(), null);
    assert.equal(registry.snapshot().document, null);

    // 空表上 flush 也不会把文件写回来（「没有文件」= 官方三项）。
    const flushed = registry.flush();
    assert.equal(flushed.ok, true);
    assert.equal(flushed.written, false);
    assert.equal(existsSync(h.menuPath), false);
  }));

test('clear empties the table and deletes the file; flush restores a missing file', () =>
  withStateDir((stateDir, h) => {
    const registry = createContributionRegistry({ stateDir });
    registry.add('a', [{ id: 'i', label: 'A' }]);
    const before = h.readMenuText();

    // 外部删掉 menu.json：快照不碰磁盘，flush 才对齐。
    rmSync(h.menuPath);
    registry.snapshot();
    assert.equal(existsSync(h.menuPath), false, 'snapshot() must not write');
    const flushed = registry.flush();
    assert.equal(flushed.ok, true);
    assert.equal(flushed.written, true);
    assert.equal(h.readMenuText(), before, 'flush must reproduce byte-identical text');

    const cleared = registry.clear();
    assert.equal(cleared.ok, true);
    assert.equal(cleared.cleared, true);
    assert.equal(existsSync(h.menuPath), false);
    assert.deepEqual(registry.snapshot().owners, []);
    // 空表上再 clear 是空操作。
    const again = registry.clear();
    assert.equal(again.cleared, false);
    assert.equal(again.rev, cleared.rev);
  }));

test('identical documents produce byte-identical menu.json (no churn for the bridge)', () =>
  withStateDir((stateDir, h) => {
    const registry = createContributionRegistry({ stateDir });
    const first = registry.add('same', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', order: 2 }]);
    const text = h.readMenuText();
    assert.ok(text !== null);

    // 完全相同的文档再来一次：rev 不变、盘上字节一个不变。桥的指纹是文本，
    // 于是它不会因为插件重启而重渲染一遍。
    const again = registry.add('same', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', order: 2 }]);
    assert.equal(again.ok, true);
    assert.equal(again.rev, first.rev);
    assert.equal(again.unchanged, true);
    assert.equal(h.readMenuText(), text);

    // 真正的变化才前进：rev 递增、文本变化。
    const changed = registry.add('same', [{ id: 'a', label: 'A2' }]);
    assert.equal(changed.rev, first.rev + 1);
    assert.notEqual(h.readMenuText(), text);

    // 外部把 menu.json 写坏（这里直接覆盖成垃圾）：下一次 add 会把同样的内容写回，
    // 而不是因为「文本缓存相等」就放过一份坏文件。
    writeFileSync(h.menuPath, '{"protocol":2,"rev":1,"items":[]}\n', 'utf8');
    const repaired = registry.add('same', [{ id: 'a', label: 'A2' }]);
    assert.equal(repaired.ok, true);
    assert.equal(repaired.unchanged, true);
    assert.equal(repaired.written, true, 'a damaged file must be repaired even when the merge is unchanged');
    assert.equal(h.readMenu().items.length, 1);

    // 同一个 owner 换两次顺序不同的文档，合并结果仍按 order 归一 —— 也就是说
    // 「内容等价」不会因为声明顺序抖动而产生不同字节。
    registry.add('same', [{ id: 'b', label: 'B', order: 2 }, { id: 'a', label: 'A2' }]);
    const ordered = h.readMenu();
    assert.deepEqual(ordered.items.map((item) => item.id), ['same#b', 'same#a']);
  }));

test('a fresh registry (Host restart) reproduces the same bytes for the same input', () =>
  withStateDir((stateDir, h) => {
    // 第一个注册表：登记两份文档，记下磁盘上的字节。
    const first = createContributionRegistry({ stateDir, now: () => new Date('2026-03-03T10:00:00.000Z') });
    first.add('a', { items: [{ id: 'x', label: 'A', order: 5 }, { id: 'y', type: 'separator' }] });
    first.add('b', [{ id: 'z', label: 'B' }]);
    const text = h.readMenuText();
    const rev = first.snapshot().rev;

    // 第二个注册表（模拟 Host 重启 / 插件重新加载）：同样的登记、不同的时钟。
    rmSync(h.menuPath);
    const second = createContributionRegistry({ stateDir, now: () => new Date('2026-03-03T11:11:11.000Z') });
    second.add('a', { items: [{ id: 'x', label: 'A', order: 5 }, { id: 'y', type: 'separator' }] });
    second.add('b', [{ id: 'z', label: 'B' }]);
    const rebuilt = h.readMenuText();

    assert.equal(rebuilt, text, 'menu.json must be a pure function of (owner table, rev)');
    assert.equal(second.snapshot().rev, rev);
    // updatedAt 会跟着时钟变，但它不在文档里 —— 所以它只影响快照，不影响字节。
    assert.notEqual(
      second.snapshot().owners[0].updatedAt,
      first.snapshot().owners[0].updatedAt,
      'updatedAt must reflect the clock (proving the clock is honest)…',
    );
    assert.equal(rebuilt.includes('2026-03-03'), false, '…while no timestamp may leak into menu.json');
  }));

test('readEvents consumes complete lines only and advances the cursor', () =>
  withStateDir((stateDir, h) => {
    const registry = createContributionRegistry({ stateDir });
    registry.add('plugin', [{ id: 'run', label: 'Run' }, { id: 'stop', label: 'Stop' }]);

    const lineOne = encodeEventLine({ type: 'click', id: 'plugin#run', path: [0], at: '2026-01-01T00:00:00.000Z' });
    const lineTwo = encodeEventLine({ type: 'click', id: 'plugin#stop', path: [1], at: '2026-01-01T00:00:01.000Z' });
    writeFileSync(h.eventsPath, lineOne + lineTwo, 'utf8');

    const first = registry.readEvents(0);
    assert.equal(first.ok, true);
    assert.equal(first.rotated, false);
    assert.deepEqual(first.events.map((event) => event.id), ['run', 'stop']);
    assert.deepEqual(first.events.map((event) => event.owner), ['plugin', 'plugin']);
    assert.equal(first.cursor, (lineOne + lineTwo).length);
    assert.equal(first.skipped, 0);

    // 从返回的游标再读：只有新追加的那一条。
    const lineThree = encodeEventLine({ type: 'toggle', id: 'plugin#run', path: [0], checked: true });
    writeFileSync(h.eventsPath, lineOne + lineTwo + lineThree, 'utf8');
    const second = registry.readEvents(first.cursor);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].type, 'toggle');
    assert.equal(second.events[0].checked, true);
    assert.equal(second.cursor, first.cursor + lineThree.length);

    // 半截行（没有换行）不能被消费：游标停在它的起点。
    const partial = encodeEventLine({ type: 'click', id: 'plugin#run', path: [0] }).trimEnd();
    writeFileSync(h.eventsPath, lineOne + lineTwo + lineThree + partial.slice(0, 40), 'utf8');
    const third = registry.readEvents(second.cursor);
    assert.deepEqual(third.events, []);
    assert.equal(third.cursor, second.cursor, 'cursor must stay before the incomplete line');

    // 补齐之后才读得到。
    writeFileSync(h.eventsPath, lineOne + lineTwo + lineThree + partial + '\n', 'utf8');
    const fourth = registry.readEvents(third.cursor);
    assert.equal(fourth.events.length, 1);
    assert.equal(fourth.events[0].id, 'run');
    assert.equal(fourth.cursor, (lineOne + lineTwo + lineThree + partial + '\n').length);
  }));

test('a missing events.jsonl is an empty read, not a failure', () =>
  withStateDir((stateDir) => {
    const registry = createContributionRegistry({ stateDir });
    const read = registry.readEvents(0);
    assert.equal(read.ok, true);
    assert.deepEqual(read.events, []);
    assert.equal(read.cursor, 0);
    assert.equal(read.rotated, false);
    // 文件不存在而调用方手里有正数游标：和「文件比游标短」是同一种事实
    // （这一段被删掉了），如实报 rotated 让调用方把游标归零。
    const readFromCursor = registry.readEvents(64);
    assert.equal(readFromCursor.ok, true);
    assert.equal(readFromCursor.cursor, 0);
    assert.equal(readFromCursor.rotated, true);
  }));

test('a rotated channel restarts from 0 and says so', () =>
  withStateDir((stateDir, h) => {
    const registry = createContributionRegistry({ stateDir });
    const longLine = encodeEventLine({ type: 'click', id: 'p#x', path: [0], at: '2026-01-01T00:00:00.000Z' });
    const longText = longLine.repeat(3);
    writeFileSync(h.eventsPath, longText, 'utf8');
    const read = registry.readEvents(0);
    assert.equal(read.cursor, longText.length);

    // 轮转：活动文件被换短（内容回到了「新的一轮」），旧的落进 .1。
    writeFileSync(h.rotatedPath, longText, 'utf8');
    const shortLine = encodeEventLine({ type: 'click', id: 'p#y', path: [1], at: '2026-01-01T00:00:02.000Z' });
    writeFileSync(h.eventsPath, shortLine, 'utf8');

    const afterRotation = registry.readEvents(read.cursor);
    assert.equal(afterRotation.ok, true);
    assert.equal(afterRotation.rotated, true, 'a shrunken file means the channel was rotated');
    assert.equal(afterRotation.cursor, shortLine.length, 'the fresh file is read from byte 0');
    assert.equal(afterRotation.events.length, 1);
    assert.equal(afterRotation.events[0].path[0], 1);

    // 从头再读一次是幂等的：同样的一个事件、同样的游标。
    const replay = registry.readEvents(0);
    assert.equal(replay.rotated, false);
    assert.equal(replay.cursor, shortLine.length);
    assert.equal(replay.events.length, 1);
  }));

test('the written document actually renders through the bridge renderMenu', () =>
  withStateDir((stateDir, h) => {
    const registry = createContributionRegistry({ stateDir });
    registry.add('@local/dsh-power', {
      items: [
        { id: 'restart', label: 'Restart DSH' },
        { id: 'sep', type: 'separator' },
        { id: 'sub', type: 'submenu', label: 'Power', items: [{ id: 'safe', type: 'checkbox', label: 'Safe mode', checked: true }] },
        { id: 'disabled', label: 'Disabled', enabled: false },
      ],
      tray: { tooltip: 'DSH (power)' },
    });
    registry.add('@local/other', [
      { id: 'late', label: 'Other late', order: 99 },
      { id: 'first', label: 'Other first', order: -1 },
    ]);

    const text = h.readMenuText();
    assert.ok(text !== null);
    // 文件大小必须留在桥的读取上限之内，否则桥会把整份文档当成「没有贡献」。
    assert.ok(statSync(h.menuPath).size <= MENU_MAX_BYTES);

    const emitted = [];
    const result = renderMenu({
      source: { kind: 'text', text, fingerprint: `text:${text}` },
      messages: MESSAGES,
      emit: (record) => emitted.push(record),
      open: () => {},
      quit: () => {},
    });

    assert.equal(result.reason, 'ok', result.lastError ?? '');
    assert.equal(result.lastError, null);
    assert.equal(result.rev, registry.snapshot().rev);
    assert.equal(result.itemCount, 6, 'four power items + two other items');
    // 桥的顶层排序与文件自身的顺序必须一致（写半身与读半身同一套总序）。
    const fileIds = h.readMenu().items.map((item) => item.id);
    const templateIds = result.template.slice(2, result.template.length - 1).map((option) => option.id);
    assert.deepEqual(templateIds, fileIds);
    assert.equal(result.tooltip, 'DSH (power)');

    // 点击回调发出的 id 正是文件里的前缀 id —— Host 靠它把事件路由回 owner。
    // 注意渲染后的下标不是贡献顺序：`order: -1` 的那项排在最前。
    const custom = result.template.find((option) => option.id === '@local/dsh-power#restart');
    assert.ok(custom !== undefined, 'the restart item must render');
    assert.equal(custom.click === undefined, false);
    custom.click();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].type, 'click');
    assert.equal(emitted[0].id, '@local/dsh-power#restart');

    const submenu = result.template.find((option) => option.id === '@local/dsh-power#sub');
    assert.equal(submenu.submenu[0].type, 'checkbox');
    assert.equal(submenu.submenu[0].checked, true, 'the initial state comes from the document');
    assert.equal(submenu.submenu[0].id, '@local/dsh-power#safe');
    submenu.submenu[0].click();
    assert.equal(emitted[1].type, 'toggle');
    // 勾选事件报的是**翻转后**的状态：初始 true、无实机 menuItem 可读 → false。
    assert.equal(emitted[1].checked, false);
  }));

test('a merged document with no renderable contribution deletes the file instead', () =>
  withStateDir((stateDir, h) => {
    // 空表 = 没有文件 = 桥渲染官方三项。这是写半身唯一的「可观测为空」信号。
    const registry = createContributionRegistry({ stateDir });
    assert.equal(registry.snapshot().document, null);
    assert.equal(existsSync(h.menuPath), false);

    // 有一次贡献然后撤光：文件必须消失，而不是留着 `items: []`。
    registry.add('temp', [{ id: 'i', label: 'Temp' }]);
    assert.equal(existsSync(h.menuPath), true);
    registry.remove('temp');
    assert.equal(existsSync(h.menuPath), false);

    // 此刻桥看到的是「缺失」而非「空文档」——两者都渲染官方三项，但只有前者
    // 才是诚实的信号。
    const result = renderMenu({
      source: { kind: 'missing', text: null, fingerprint: 'missing', error: null },
      messages: MESSAGES,
      emit: () => {},
      open: () => {},
      quit: () => {},
    });
    assert.equal(result.reason, 'empty');
    assert.equal(result.itemCount, 0);
  }));
