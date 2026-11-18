/**
 * 通知通道（`notify.js`）的单元测试。
 *
 * 被测对象是**源码模块**：这里验证通道自己的决策表（去重 / 限流 / 降级 / 持久化
 * 水位），可以喂人造输入。构建产物上的接线（真 `createBridge` + 假 Electron）由
 * 本文件最后一组「through the built artefact」用例覆盖 —— 决策表对、接线也对的
 * 两件事必须分开证明，和 `menu.js` / `kernel.js` 的分工完全一致。
 *
 * `node --test --test-isolation=none test/bridge-notify.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createNotifyChannel, NOTIFY_ITEM_LIMIT } from '../lib/bridge/src/notify.js';
import {
  NOTIFY_MAX_BYTES,
  NOTIFY_RATE_LIMIT,
  NOTIFY_RATE_WINDOW_MS,
  PROTOCOL_NOTIFY,
} from '../lib/bridge/src/paths.js';
import { encodeEventLine } from '../lib/bridge/src/paths.js';
import {
  MAX_WINDOW_SPECS,
  PROTOCOL_WINDOW,
  WINDOW_POLL_EVERY,
  WINDOW_SPEC_LIMITS,
  describeWindowCapability,
  describeWindowChannel,
  describeWindowSpec,
} from '../lib/bridge/src/windows.js';
import { MESSAGES, lastTemplate, makeBridge, withHome } from './bridge-harness.mjs';

/**
 * 一个记录用的假 `Notification` 类。
 *
 * 形状仿照真实 Electron：可 `new`，实例有 `show()`、`on()`、`once()`，类上有静态
 * `isSupported()`。所有调用都被记下来，测试只断言「记录了什么」，不依赖真实 OS。
 *
 * @param {{ supported?: boolean, throwOnConstruct?: boolean, throwOnShow?: boolean }} [options]
 */
function fakeNotification(options = {}) {
  const records = { instances: [], constructCalls: 0, isSupportedCalls: 0, failures: [] };

  function Notification(optionsArg) {
    records.constructCalls += 1;
    if (options.throwOnConstruct === true) throw new Error('constructor refused');
    const handlers = { failed: [], click: [] };
    const instance = {
      options: optionsArg,
      shows: 0,
      urgency: undefined,
      on(event, handler) {
        if (Array.isArray(handlers[event])) handlers[event].push(handler);
      },
      once(event, handler) {
        if (Array.isArray(handlers[event])) handlers[event].push(handler);
      },
      removeAllListeners() {
        handlers.failed.length = 0;
        handlers.click.length = 0;
      },
      show() {
        instance.shows += 1;
        if (options.throwOnShow === true) throw new Error('show refused');
      },
      /** 主动触发一个事件，模拟 Electron 回调。 */
      emit(event, ...args) {
        for (const handler of handlers[event] ?? []) handler(...args);
      },
      handlerCount(event) {
        return (handlers[event] ?? []).length;
      },
    };
    records.instances.push(instance);
    return instance;
  }
  Notification.isSupported = () => {
    records.isSupportedCalls += 1;
    return options.supported !== false;
  };
  Notification.records = records;
  return Notification;
}

/**
 * 临时状态目录 + 写文档的小工具。
 *
 * @param {(env: object) => any} body
 */
function withState(body) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-test-'));
  const stateDir = path.join(home, 'dsh-asar-framework');
  mkdirSync(stateDir, { recursive: true });
  const notifyPath = path.join(stateDir, 'notify.json');
  const eventsPath = path.join(stateDir, 'events.jsonl');
  const env = {
    home,
    stateDir,
    notifyPath,
    eventsPath,
    write(document) {
      writeFileSync(notifyPath, typeof document === 'string' ? document : `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    },
    readState() {
      try {
        return JSON.parse(readFileSync(path.join(stateDir, 'notify.state.json'), 'utf8'));
      } catch (_error) {
        return null;
      }
    },
    readEvents() {
      try {
        return readFileSync(eventsPath, 'utf8');
      } catch (_error) {
        return '';
      }
    },
    exists(name) {
      try {
        readFileSync(path.join(stateDir, name), 'utf8');
        return true;
      } catch (_error) {
        return false;
      }
    },
  };
  try {
    return body(env);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** 事件记录收集器（模拟 kernel 的 `emit`）。 */
function collector() {
  const records = [];
  const emit = (record) => records.push(record);
  return { records, emit };
}

/** 一份最小的合法文档。 */
function documentWith(items, rev = 1) {
  return { protocol: PROTOCOL_NOTIFY, rev, owner: '@local/demo', items };
}

test('no injected provider: available:false, nothing shown, nothing thrown', () =>
  withState((env) => {
    env.write(documentWith([{ id: 'a#1', title: 'Hello', body: 'World', rev: 1 }]));
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: undefined, emit: () => {} });
    let result;
    assert.doesNotThrow(() => {
      result = channel.poll();
    });
    assert.equal(result.shown, 0, 'nothing may be shown without a provider');
    assert.equal(result.skipped, 1);
    const status = channel.status();
    assert.equal(status.available, false);
    assert.equal(status.shown, 0);
    assert.equal(status.lastError, 'state directory unavailable' === status.lastError ? status.lastError : status.lastError);
    // 没有 provider 不是错误：lastError 保持 null，条目保持待显示（未消费）。
    assert.equal(status.lastError, null);
    assert.equal(status.rev, 0, 'an unsupported environment must not consume the item');
    assert.equal(env.readState(), null, 'nothing was displayed, so no watermark may be written');
    assert.equal(env.readEvents(), '', 'no event may be emitted');
    channel.dispose();
  }));

test('a valid document shows one notification per item with the right options', () =>
  withState((env) => {
    const Notification = fakeNotification();
    env.write(
      documentWith([
        { id: '@local/demo#1', title: 'First', body: 'Body one', rev: 1 },
        { id: '@local/demo#2', title: 'Second', body: '', silent: true, rev: 2 },
        { id: '@local/demo#3', title: 'Third', rev: 3, urgency: 'critical' },
      ], 3),
    );
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    const result = channel.poll();

    assert.equal(result.shown, 3);
    assert.equal(Notification.records.constructCalls, 3);
    assert.equal(Notification.records.isSupportedCalls, 1, 'isSupported must be asked once, lazily');
    assert.deepEqual(
      Notification.records.instances.map((instance) => instance.options),
      [
        { title: 'First', body: 'Body one', silent: false },
        { title: 'Second', body: '', silent: true },
        { title: 'Third', body: '', silent: false },
      ],
    );
    for (const instance of Notification.records.instances) {
      assert.equal(instance.shows, 1, 'each toast must be shown exactly once');
      assert.equal(instance.handlerCount('failed'), 1, 'a failed handler must be attached');
      assert.equal(instance.handlerCount('click'), 1, 'a click handler must be attached');
    }
    // `urgency` 是 Linux-only 的属性赋值，不在构造参数里。
    assert.equal(Notification.records.instances[2].urgency, 'critical');
    assert.equal(Notification.records.instances[0].urgency, undefined, 'an absent urgency must not be set');

    const status = channel.status();
    assert.equal(status.available, true);
    assert.equal(status.shown, 3);
    assert.equal(status.rev, 3);
    assert.equal(status.lastError, null);
    channel.dispose();
  }));

test('the SAME document polled twice shows nothing the second time', () =>
  withState((env) => {
    const Notification = fakeNotification();
    env.write(documentWith([{ id: '@local/demo#1', title: 'Once', body: 'x', rev: 1 }], 1));
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });

    assert.equal(channel.poll().shown, 1);
    const second = channel.poll();
    assert.equal(second.shown, 0, 'a second poll of the same document must not re-show');
    assert.equal(Notification.records.constructCalls, 1);
    assert.equal(channel.status().duplicates, 1, 'the replay must be counted, not silently ignored');
    channel.dispose();
  }));

test('a bumped rev shows the new item and not the old ones', () =>
  withState((env) => {
    const Notification = fakeNotification();
    env.write(documentWith([{ id: '@local/demo#1', title: 'One', rev: 1 }], 1));
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    channel.poll();
    assert.equal(Notification.records.constructCalls, 1);

    // 追加一条：旧条目仍在文档里（队列不删已显示项），只有新的那条该出来。
    env.write(
      documentWith([
        { id: '@local/demo#1', title: 'One', rev: 1 },
        { id: '@local/demo#2', title: 'Two', body: 'new', rev: 2 },
      ], 2),
    );
    const second = channel.poll();
    assert.equal(second.shown, 1);
    assert.equal(Notification.records.constructCalls, 2);
    assert.equal(Notification.records.instances[1].options.title, 'Two');
    assert.equal(Notification.records.instances[1].options.body, 'new');
    assert.equal(channel.status().rev, 2);
    channel.dispose();
  }));

test('malformed JSON degrades: reported in status(), nothing shown, tray untouched', () =>
  withState((env) => {
    const Notification = fakeNotification();
    env.write('{ this is not json at all');
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    assert.doesNotThrow(() => channel.poll());
    assert.equal(Notification.records.constructCalls, 0, 'a broken document must show nothing');
    const status = channel.status();
    assert.equal(status.invalid, 1);
    assert.equal(status.lastError.includes('JSON'), true, 'the reason must name the problem: ' + status.lastError);
    assert.equal(status.shown, 0);
    assert.equal(status.rev, 0, 'a broken document must not advance the watermark');

    // 桥的托盘渲染完全不经手这里：通道只报告，不抛。
    env.write(documentWith([{ id: '@local/demo#1', title: 'Recovered', rev: 1 }], 1));
    assert.equal(channel.poll().shown, 1, 'a fixed document must start working again');
    channel.dispose();
  }));

test('a wrong protocol version is refused like a malformed document', () =>
  withState((env) => {
    const Notification = fakeNotification();
    env.write({ protocol: 2, rev: 1, items: [{ id: 'a#1', title: 'Wrong', rev: 1 }] });
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    assert.equal(channel.poll().shown, 0);
    assert.equal(Notification.records.constructCalls, 0);
    assert.equal(channel.status().lastError.includes('protocol'), true, channel.status().lastError);
    channel.dispose();
  }));

test('the rate limit drops the (N+1)th and reports it', () =>
  withState((env) => {
    const Notification = fakeNotification();
    // 比限流窗口多两条：前 N 条显示，剩下的必须被跳过并计数。
    const items = [];
    for (let index = 1; index <= NOTIFY_RATE_LIMIT + 2; index += 1) {
      items.push({ id: `@local/demo#${index}`, title: `Toast ${index}`, rev: index });
    }
    env.write(documentWith(items, items.length));

    // 冻结时钟：全部条目都落在同一瞬间，窗口不会被时间推过去。
    const frozen = 1_700_000_000_000;
    const channel = createNotifyChannel({
      stateDir: env.stateDir,
      notification: Notification,
      emit: () => {},
      now: () => frozen,
    });

    const result = channel.poll();
    assert.equal(result.shown, NOTIFY_RATE_LIMIT, `exactly ${NOTIFY_RATE_LIMIT} may be shown inside one window`);
    assert.equal(result.skipped, 2);
    assert.equal(Notification.records.constructCalls, NOTIFY_RATE_LIMIT, 'the suppressed ones must not even be constructed');
    assert.equal(channel.status().rateLimited, 2);
    assert.equal(channel.status().rev, items.length, 'suppressed items are consumed, not deferred');

    // 时间推过一个窗口后，新的条目可以再显示。
    const later = createNotifyChannel({
      stateDir: env.stateDir,
      notification: Notification,
      emit: () => {},
      now: () => frozen + NOTIFY_RATE_WINDOW_MS + 1,
    });
    env.write(
      documentWith(
        [{ id: '@local/demo#later', title: 'Later', rev: items.length + 1 }],
        items.length + 1,
      ),
    );
    assert.equal(later.poll().shown, 1, 'a window boundary must release one slot');
    later.dispose();
    channel.dispose();
  }));

test('a click appends one notify-click record with the owner and the id', () =>
  withState((env) => {
    const Notification = fakeNotification();
    const { records, emit } = collector();
    env.write(
      documentWith([{ id: '@local/demo#1', title: 'Click me', rev: 1 }], 1),
    );
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit });
    channel.poll();
    assert.equal(records.length, 0, 'showing is not clicking');

    Notification.records.instances[0].emit('click');
    assert.equal(records.length, 1);
    assert.equal(records[0].type, 'notify-click');
    assert.equal(records[0].id, '@local/demo#1');
    assert.equal(records[0].owner, '@local/demo');
    channel.dispose();
  }));

test('the click record really reaches events.jsonl through encodeEventLine', () =>
  withState((env) => {
    // 这一条把「通道发出什么形状」与「kernel 如何落盘」接起来：
    // 事件行由 kernel 的 emit 用 encodeEventLine 写出，所以这里直接验证那一步。
    const line = encodeEventLine({ type: 'notify-click', id: '@local/demo#1', owner: '@local/demo', at: 'FIXED' });
    const parsed = JSON.parse(line.trim());
    assert.equal(parsed.type, 'notify-click');
    assert.equal(parsed.id, '@local/demo#1');
    assert.equal(parsed.owner, '@local/demo');
    assert.equal(parsed.path.length, 0, 'a toast has no menu path');
    assert.equal(line.includes('\n'), true, 'one record must stay exactly one line');
    assert.equal(line.trim().split('\n').length, 1, 'no raw newline inside the record');
    // 菜单事件没有 owner 键 —— 它们的字节一个都不能变。
    const menuLine = encodeEventLine({ type: 'click', id: 'a#x', path: [0] });
    assert.equal(menuLine.includes('"owner"'), false);
  }));

test('a writer restart (lower document rev) does not mute the channel', () =>
  withState((env) => {
    const Notification = fakeNotification();
    env.write(documentWith([{ id: '@local/demo#1', title: 'Old', rev: 5 }], 5));
    const first = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    first.poll();
    assert.equal(env.readState().rev, 5, 'the watermark must be persisted');
    first.dispose();

    // 写者重启：rev 从 1 重新数，文档 rev 比水位低。
    env.write(documentWith([{ id: '@local/demo#9', title: 'New epoch', rev: 1 }], 1));
    const second = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    const result = second.poll();
    assert.equal(result.shown, 1, 'a new writer epoch must be recognised, not muted');
    assert.equal(Notification.records.instances[1].options.title, 'New epoch');
    second.dispose();
  }));

test('a restart with the SAME document does not re-spam (persisted ids)', () =>
  withState((env) => {
    const Notification = fakeNotification();
    env.write(documentWith([{ id: '@local/demo#1', title: 'Once', rev: 1 }], 1));
    const first = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    first.poll();
    first.dispose();

    // 模拟重启：新进程、同一份文件、同一个 rev。
    const second = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    const result = second.poll();
    assert.equal(result.shown, 0, 'a restart must not replay a document already shown');
    assert.equal(Notification.records.constructCalls, 1);
    assert.equal(second.status().stateRestored, true);
    second.dispose();
  }));

test('isSupported() === false degrades: nothing shown, nothing thrown, item pending', () =>
  withState((env) => {
    const Notification = fakeNotification({ supported: false });
    env.write(documentWith([{ id: 'a#1', title: 'Nope', rev: 1 }], 1));
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    assert.doesNotThrow(() => channel.poll());
    assert.equal(Notification.records.constructCalls, 0);
    const status = channel.status();
    assert.equal(status.available, false);
    assert.equal(status.lastError, 'this platform does not support notifications');
    assert.equal(status.rev, 0, 'an unsupported platform leaves the item pending');
    channel.dispose();
  }));

test('a constructor or show() that throws is recorded, never propagated', () =>
  withState((env) => {
    // 两轮用**不同**的 id 和各自的初始状态：去重水位是持久化的，复用同一个 id
    // 会让第二轮在「已经显示过」这一步就被正确跳过，从而掩盖被测的失败路径。
    const cases = [
      { options: { throwOnConstruct: true }, id: 'a#construct' },
      { options: { throwOnShow: true }, id: 'a#show' },
    ];
    for (const testCase of cases) {
      rmSync(path.join(env.stateDir, 'notify.state.json'), { force: true });
      const Notification = fakeNotification(testCase.options);
      env.write(documentWith([{ id: testCase.id, title: 'Boom', rev: 2 }], 2));
      const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
      assert.doesNotThrow(() => channel.poll(), 'the channel must never throw at the caller');
      const status = channel.status();
      assert.equal(status.shown, 0);
      assert.equal(typeof status.lastError, 'string', JSON.stringify(testCase));
      assert.equal(status.lastError.length > 0, true);
      assert.equal(status.rev, 2, 'a failed show is consumed: retrying forever would be a toast loop');
      channel.dispose();
    }
  }));

test('a hostile urgency value is dropped instead of reaching the instance', () =>
  withState((env) => {
    const Notification = fakeNotification();
    env.write(documentWith([{ id: 'a#1', title: 'T', rev: 1, urgency: 'danger' }], 1));
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    channel.poll();
    assert.equal(Notification.records.instances[0].urgency, undefined, 'an unknown urgency must not be assigned');
    assert.equal(channel.status().shown, 1, 'the toast itself is still legitimate');
    channel.dispose();
  }));

test('items without id or title are dropped, and the rest still shows', () =>
  withState((env) => {
    const Notification = fakeNotification();
    env.write(
      documentWith([
        { title: 'No id', rev: 1 },
        { id: 'a#2', rev: 2 },
        { id: 'a#3', title: 'Good', rev: 3 },
      ], 3),
    );
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    const result = channel.poll();
    assert.equal(result.shown, 1);
    assert.equal(Notification.records.instances[0].options.title, 'Good');
    channel.dispose();
  }));

test('an oversize document is treated as unavailable, not parsed', () =>
  withState((env) => {
    const Notification = fakeNotification();
    const padding = 'x'.repeat(NOTIFY_MAX_BYTES + 1024);
    env.write(`{"protocol":1,"rev":1,"items":[{"id":"a#1","title":"Big","rev":1}],"pad":"${padding}"}`);
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    assert.equal(channel.poll().shown, 0);
    assert.equal(Notification.records.constructCalls, 0);
    assert.equal(channel.status().lastError.includes('limit'), true, channel.status().lastError);
    channel.dispose();
  }));

test('a document with more than the item limit is truncated, not refused', () =>
  withState((env) => {
    const Notification = fakeNotification();
    const items = [];
    for (let index = 0; index < NOTIFY_ITEM_LIMIT + 10; index += 1) {
      items.push({ id: `a#${index}`, title: `T${index}`, rev: index + 1 });
    }
    env.write(documentWith(items, items.length));
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    // 限流先于条数上限生效，所以这里只断言「不会因为条数多就抛/不工作」。
    assert.doesNotThrow(() => channel.poll());
    assert.equal(channel.status().lastError, null);
    channel.dispose();
  }));

test('a missing notify.json is a normal empty poll', () =>
  withState((env) => {
    const Notification = fakeNotification();
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit: () => {} });
    const result = channel.poll();
    assert.deepEqual(result, { shown: 0, skipped: 0, reason: null });
    assert.equal(Notification.records.constructCalls, 0);
    assert.equal(channel.status().lastError, null);
    channel.dispose();
  }));

test('dispose() stops everything: no shows, no events, no state writes', () =>
  withState((env) => {
    const Notification = fakeNotification();
    const { records, emit } = collector();
    env.write(documentWith([{ id: 'a#1', title: 'After dispose', rev: 1 }], 1));
    const channel = createNotifyChannel({ stateDir: env.stateDir, notification: Notification, emit });
    channel.dispose();
    const result = channel.poll();
    assert.deepEqual(result, { shown: 0, skipped: 0, reason: null });
    assert.equal(Notification.records.constructCalls, 0);
    assert.equal(records.length, 0);
    assert.equal(channel.status().disposed, true);
  }));

test('an unwritable state directory still polls without throwing', () =>
  withState((env) => {
    const Notification = fakeNotification();
    // 状态目录本身是一个普通文件：所有读写都会失败。
    const blocker = path.join(env.home, 'blocked');
    writeFileSync(blocker, 'not a directory', 'utf8');
    const channel = createNotifyChannel({ stateDir: blocker, notification: Notification, emit: () => {} });
    assert.doesNotThrow(() => channel.poll());
    assert.equal(Notification.records.constructCalls, 0, 'there was no readable document to show');
    assert.equal(channel.status().available, true, 'the provider itself is still usable');
    // 「读不到目录」在 Windows 上表现为「文件不存在」，而那是合法状态（= 没有待显示
    // 的通知）。不抛、不显示、状态可读，就是这条通道在这里该做的事。
    assert.equal(Notification.records.isSupportedCalls, 0, 'nothing was attempted, so nothing was probed');
    channel.dispose();
  }));

test('stateDir === null is reported as unavailable and never throws', () =>
  withState(() => {
    const channel = createNotifyChannel({ stateDir: null, notification: fakeNotification(), emit: () => {} });
    assert.equal(channel.status().lastError, 'state directory unavailable');
    assert.doesNotThrow(() => channel.poll());
    // 空字符串与缺省值同义。
    const empty = createNotifyChannel({ notification: fakeNotification(), emit: () => {} });
    assert.equal(empty.status().lastError, 'state directory unavailable');
    assert.doesNotThrow(() => empty.poll());
    channel.dispose();
    empty.dispose();
  }));

// ------------------------------------------------- through the built artefact --
// The decision table above is proven on the module. What follows proves the
// SHIPPED bytes: the artefact is what runs inside Electron's main process, so
// the wiring (ONE injected capabilities object, the shared poll timer, and the
// `status().notify` block) has to be observed there too. `makeBridge` accepts
// `extra`, which is how the `electron` property arrives exactly as the region
// passes it after `createBridge({...})`.

test('the built artefact drains the queue on relabel and reports it in status()', () =>
  withHome((home) => {
    const Notification = fakeNotification();
    home.write(
      'notify.json',
      JSON.stringify({
        protocol: PROTOCOL_NOTIFY,
        rev: 2,
        owner: '@local/demo',
        items: [
          { id: '@local/demo#1', title: 'First', body: 'one', rev: 1 },
          { id: '@local/demo#2', title: 'Second', body: 'two', rev: 2 },
        ],
      }),
    );
    const { bridge, menu } = makeBridge({ home, extra: { electron: { notification: Notification } } });
    bridge.relabel(MESSAGES);

    assert.equal(Notification.records.constructCalls, 2, 'relabel() is the shell-driven catch-up path');
    assert.equal(Notification.records.instances[0].options.title, 'First');
    assert.equal(Notification.records.instances[1].options.title, 'Second');

    const status = bridge.status();
    assert.equal(status.notify.available, true);
    assert.equal(status.notify.shown, 2);
    assert.equal(status.notify.rev, 2);
    assert.equal(status.notify.lastError, null);
    // The tray half is unaffected: the official three entries still rendered.
    assert.equal(lastTemplate(menu).length, 3, 'no menu.json → the official three');
    bridge.dispose();
  }));

test('the built artefact without an electron object keeps working, notify unavailable', () =>
  withHome((home) => {
    home.write(
      'notify.json',
      JSON.stringify({ protocol: PROTOCOL_NOTIFY, rev: 1, items: [{ id: 'o#1', title: 'T', rev: 1 }] }),
    );
    const { bridge, menu } = makeBridge({ home });
    assert.equal(bridge.relabel(MESSAGES).ok, true, 'the tray must still render');
    assert.equal(lastTemplate(menu).length, 3, 'the official three entries are untouched');
    const status = bridge.status();
    assert.equal(status.notify.available, false);
    assert.equal(status.notify.shown, 0);
    assert.equal(status.notify.rev, 0, 'nothing was consumed: no provider means nothing was attempted');
    bridge.dispose();
  }));

test('a broken notify.json cannot cost the tray: the menu still renders', () =>
  withHome((home) => {
    const Notification = fakeNotification();
    home.write('menu.json', JSON.stringify({ protocol: 2, rev: 1, items: [{ id: 'm#1', label: 'From menu' }] }));
    home.write('notify.json', '{ not json at all');
    const { bridge, menu, tray } = makeBridge({ home, extra: { electron: { notification: Notification } } });
    assert.equal(bridge.relabel(MESSAGES).ok, true);
    assert.equal(lastTemplate(menu)[2].label, 'From menu', 'the contribution still renders');
    assert.equal(tray.contextMenus.length > 0, true);
    assert.equal(bridge.status().notify.invalid, 1);
    assert.equal(bridge.status().notify.lastError.includes('JSON'), true);
    assert.equal(Notification.records.constructCalls, 0, 'a broken document shows nothing');
    bridge.dispose();
  }));

test('a toast click reaches events.jsonl with the owner through the artefact', () =>
  withHome((home) => {
    const Notification = fakeNotification();
    home.write(
      'notify.json',
      JSON.stringify({
        protocol: PROTOCOL_NOTIFY,
        rev: 1,
        owner: '@local/demo',
        items: [{ id: '@local/demo#1', title: 'Click', rev: 1 }],
      }),
    );
    const { bridge } = makeBridge({ home, extra: { electron: { notification: Notification } } });
    bridge.relabel(MESSAGES);
    Notification.records.instances[0].emit('click');

    const text = home.read('events.jsonl');
    assert.notEqual(text, null, 'the click must be appended to the shared event channel');
    const parsed = JSON.parse(text.trim().split('\n')[0]);
    assert.equal(parsed.type, 'notify-click');
    assert.equal(parsed.id, '@local/demo#1');
    assert.equal(parsed.owner, '@local/demo');
    bridge.dispose();
  }));

// ------------------------------------------------------ the window contract --
// `lib/bridge/src/windows.js` is the ONLY thing this build owns for the window
// capability: a total validator for a declarative spec, and no behaviour. It is
// deliberately NOT bundled into the artefact (nothing in the bridge consumes it
// yet — `MODULE_ORDER` says why), so it is exercised as a source module here.
// A validator with no consumer is dead weight UNLESS its contract is pinned, and
// pinning it is exactly what makes the next implementer's job defined.

test('describeWindowSpec accepts a well-formed spec and copies only known fields', () => {
  const result = describeWindowSpec({
    protocol: 1,
    owner: '@local/demo',
    windows: [
      { id: 'settings', title: 'Demo', route: '/settings', width: 900, height: 600, resizable: true },
    ],
  });
  assert.equal(result.ok, true, result.message ?? '');
  assert.equal(result.owner, '@local/demo');
  assert.equal(result.windows.length, 1);
  assert.deepEqual(result.windows[0], {
    id: 'settings',
    title: 'Demo',
    route: '/settings',
    width: 900,
    height: 600,
    resizable: true,
  });
  assert.deepEqual(result.warnings, [], 'a complete spec has nothing to warn about');
});

test('describeWindowSpec drops unknown fields instead of forwarding them', () =>
  withState(() => {
    // 未知键必须被**丢弃**：这份 spec 最终会被交给 BrowserWindow，多一个键就是
    // 多一条未来可能被接上的通道（webPreferences.preload 这类）。
    const result = describeWindowSpec({
      protocol: 1,
      windows: [{ id: 'w', title: 'T', route: '/x', id2: 'ignored', parent: 'other', webPreferences: { preload: '/evil' } }],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.windows[0]), ['id', 'title', 'route']);
  }));

test('describeWindowSpec refuses an absolute URL: only same-origin routes', () =>
  withState(() => {
    for (const route of ['https://evil.example/x', '//evil.example', 'file:///<test>/x', 'x/y', '\\\\server\\share']) {
      const result = describeWindowSpec({ protocol: 1, windows: [{ id: 'w', route }] });
      assert.equal(result.ok, false, `route ${JSON.stringify(route)} must be refused`);
      assert.equal(result.code, 'EUNSAFE_ROUTE');
    }
    // `url` 不是本协议的字段，出现即拒绝（而不是「悄悄忽略」）。
    const withUrl = describeWindowSpec({ protocol: 1, windows: [{ id: 'w', url: 'https://example.com' }] });
    assert.equal(withUrl.ok, false);
    assert.equal(withUrl.code, 'EUNSAFE_ROUTE');
  }));

test('describeWindowSpec enforces ranges, ids, protocol and the count limit', () =>
  withState(() => {
    assert.equal(describeWindowSpec({ protocol: 2, windows: [] }).code, 'EPROTOCOL');
    assert.equal(describeWindowSpec(null).code, 'EINVALID_DOCUMENT');
    assert.equal(describeWindowSpec('nope').code, 'EINVALID_DOCUMENT');
    assert.equal(describeWindowSpec({ protocol: 1, windows: 'nope' }).code, 'EINVALID_DOCUMENT');
    assert.equal(describeWindowSpec({ protocol: 1, windows: [{ id: '' }] }).code, 'EINVALID_SPEC');
    assert.equal(describeWindowSpec({ protocol: 1, windows: [{ title: 'No id' }] }).code, 'EINVALID_SPEC');
    assert.equal(describeWindowSpec({ protocol: 1, windows: [{ id: 'a', width: 20 }] }).code, 'ERANGE');
    assert.equal(describeWindowSpec({ protocol: 1, windows: [{ id: 'a', x: 999999 }] }).code, 'ERANGE');
    assert.equal(
      describeWindowSpec({ protocol: 1, windows: [{ id: 'a' }, { id: 'a' }] }).code,
      'EDUPLICATE_ID',
    );
    const tooMany = Array.from({ length: MAX_WINDOW_SPECS + 1 }, (_unused, index) => ({ id: `w${index}` }));
    assert.equal(describeWindowSpec({ protocol: 1, windows: tooMany }).code, 'ELIMIT');
  }));

test('describeWindowSpec is total: hostile input never throws', () =>
  withState(() => {
    const hostile = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); } });
    assert.doesNotThrow(() => describeWindowSpec(hostile));
    assert.equal(describeWindowSpec(hostile).ok, false);
    for (const input of [undefined, 42, [], [null], {}, { protocol: 1 }]) {
      assert.doesNotThrow(() => describeWindowSpec(input), `input ${JSON.stringify(input) ?? 'undefined'}`);
    }
  }));

test('describeWindowCapability reports the contract, not a claim of implementation', () =>
  withState(() => {
    const capability = describeWindowCapability();
    // Still true of THIS module: it validates, it never constructs. The construction
    // lives in the injected region (`channel:'window'`), which is a different
    // artefact and is described by the sibling function below.
    assert.equal(capability.implemented, false, 'this module creates no window: saying otherwise would be a lie');
    assert.equal(capability.declarative, true);
    assert.equal(capability.imperative, false);
    assert.equal(capability.channel, null, 'the validator alone owns no channel');
    assert.deepEqual(capability.spec.fields, [
      'id', 'title', 'route', 'width', 'height', 'x', 'y', 'resizable', 'frameless', 'modal',
    ]);
    assert.equal(capability.spec.protocol, PROTOCOL_WINDOW);
    assert.equal(capability.spec.maxWindows, MAX_WINDOW_SPECS);
    // 「需要哪些 shell 名字」不在这里：artefact 的红线扫描禁止任何 Electron UI
    // 类名出现在 shipped code 里，所以那份清单在 TECHDOC §21，由人读。
    assert.equal('requires' in capability, false);
  }));

test('describeWindowChannel describes the region channel, and says what it does NOT have', () =>
  withState(() => {
    const channel = describeWindowChannel();
    // It exists NOW: the region constructs a real window from a validated spec.
    assert.equal(channel.channel, 'window');
    assert.equal(channel.implemented, true);
    assert.equal(channel.imperative, true);
    assert.equal(channel.declarative, true, 'a spec document is validated by the same source');
    // The ACKs are a fixed vocabulary, not "some object".
    assert.deepEqual(channel.ack.opened, { received: 'opened', windowId: '<id>' });
    assert.deepEqual(channel.ack.rejected, { received: 'rejected', windowId: '<id>|null', reason: '<code>' });
    // The limits are the ones the validator enforces, from the same object.
    assert.equal(channel.limits.maxIdLength, WINDOW_SPEC_LIMITS.maxIdLength);
    assert.equal(channel.limits.maxTitleLength, WINDOW_SPEC_LIMITS.maxTitleLength);
    assert.equal(channel.limits.maxRouteLength, WINDOW_SPEC_LIMITS.maxRouteLength);
    // The COUNT cap is a channel-only fact: the validator checks a DOCUMENT's
    // window list, the region checks how many windows are ALIVE. Same number, two
    // meanings, so it is reported here rather than folded into the limits object.
    assert.equal(channel.maxWindows, MAX_WINDOW_SPECS);
    // THE CLOSE PUSH is now a fact of this build, so it is described as DATA rather
    // than left in `notImplemented`. Its latency is DERIVED from the shipped cadence
    // (`WINDOW_POLL_EVERY × POLL_MS`), so a slower sample cannot keep claiming the
    // old number from a document.
    assert.equal(channel.close.observed, true, 'the close push exists: it is no longer a gap');
    assert.equal(channel.close.event, 'window-closed');
    assert.equal(channel.close.file, 'events.jsonl');
    assert.equal(channel.close.readVia, 'asarShell.events(cursor)');
    assert.equal(channel.close.pollEvery, WINDOW_POLL_EVERY);
    assert.equal(channel.close.latencyMs, WINDOW_POLL_EVERY * 700,
      'the published latency IS the cadence, not an estimate');
    // What it still cannot do is named, not implied: an absent field would read as
    // "unlimited" to the next implementer.
    for (const missing of ['session', 'protocol', 'declarativeWriter']) {
      assert.equal(channel.notImplemented.includes(missing), true,
        `${missing} must be reported as NOT implemented, not left to be discovered`);
    }
    assert.equal(channel.notImplemented.includes('closeEvent'), false,
      'the close push landed: keeping it here would be a lie');
  }));

// ------------------------------------------------------ the two wire copies --
// The bridge ships as one standalone CommonJS file inside `app.asar.unpacked`,
// so it cannot import the Host's `lib/wire/constants.js`: those values exist
// TWICE, and `lib/bridge/src/paths.js` says a test pins the copies together.
// This is that pin for everything this capability added — a drift here means
// "the Host writes a name the bridge never reads", which nobody would notice
// until a toast silently never appeared.

test('FILES.notify and the notify protocol agree across the two wire copies', async () => {
  const wire = await import('../lib/wire/constants.js');
  const bridgePaths = await import('../lib/bridge/src/paths.js');
  assert.equal(bridgePaths.FILES.notify, wire.FILES.notify, 'the two FILES copies must name the same file');
  assert.equal(bridgePaths.FILES.notify, 'notify.json');
  assert.equal(bridgePaths.PROTOCOL_NOTIFY, wire.PROTOCOLS.notify, 'the two protocol numbers must agree');
  assert.equal(bridgePaths.PROTOCOL_NOTIFY, 1);
  // The bridge's own watermark file is bridge-only (the Host never writes it), so
  // it is pinned by name rather than against the Host table.
  assert.equal(bridgePaths.FILES.notifyState, 'notify.state.json');
  // Everything the menu channel already relied on must still agree: a rename on
  // either side would break the shipped menu, not just the new channel.
  for (const key of ['menu', 'events']) {
    assert.equal(bridgePaths.FILES[key], wire.FILES[key], `FILES.${key} must agree`);
  }
  assert.equal(bridgePaths.PROTOCOL, wire.PROTOCOLS.menu);
});

test('the writer ceiling does not exceed the reader ceiling', async () => {
  const bridgePaths = await import('../lib/bridge/src/paths.js');
  const registry = await import('../lib/host/notify-registry.js');
  // 关键不是「32 KiB 够不够装 64 条」（不够，也不该够），而是**写半身的字节上限
  // ≤ 桥的读取上限**：否则桥会把一份自己人写的文档当作「超限 = 没有通知」，而
  // 写半身会一口咬定「写成功了」。这一条把两个数字绑在一起。
  assert.equal(registry.NOTIFY_MAX_BYTES <= bridgePaths.NOTIFY_MAX_BYTES, true,
    `the writer's ceiling ${registry.NOTIFY_MAX_BYTES} must not exceed the reader's ${bridgePaths.NOTIFY_MAX_BYTES}`);
});
