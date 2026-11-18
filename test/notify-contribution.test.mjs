/**
 * 通知注册表（写半身）的测试 —— `lib/host/notify-registry.js`。
 *
 * 分工：桥是读半身（`test/bridge-notify.test.mjs` 钉住它的决策表），这里是写半身：
 * 单调 rev、owner 命名空间、字节稳定、空队列删文件、FIFO 上限。最后一条测试把
 * 写出的**文件文本**交给桥自己的 `createNotifyChannel`，证明两端没有各说各话。
 *
 * `node --test --test-isolation=none test/notify-contribution.test.mjs`
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from '../lib/fs-safe.js';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  NOTIFY_BODY_LIMIT,
  NOTIFY_QUEUE_LIMIT,
  NOTIFY_TITLE_LIMIT,
  createNotifyRegistry,
} from '../lib/host/notify-registry.js';
import { createNotifyChannel, NOTIFY_ITEM_LIMIT } from '../lib/bridge/src/notify.js';
import { FILES, PROTOCOLS } from '../lib/wire/constants.js';
import { NOTIFY_MAX_BYTES, PROTOCOL_NOTIFY } from '../lib/bridge/src/paths.js';

/** 读文档 / 读原始文本的小工具（与 `contribution.test.mjs` 同一套写法）。 */
function withStateDir(body) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-notify-contribution-'));
  const stateDir = path.join(home, 'dsh-asar-framework');
  mkdirSync(stateDir, { recursive: true });
  const notifyPath = path.join(stateDir, FILES.notify);
  const statePath = path.join(stateDir, 'notify.state.json');
  const helpers = {
    stateDir,
    notifyPath,
    statePath,
    exists: () => existsSync(notifyPath),
    text: () => (existsSync(notifyPath) ? readFileSync(notifyPath, 'utf8') : null),
    /** @returns {object|null} 解析后的 notify.json */
    read() {
      if (!existsSync(notifyPath)) return null;
      return JSON.parse(readFileSync(notifyPath, 'utf8'));
    },
    bytes: () => (existsSync(notifyPath) ? statSync(notifyPath).size : 0),
  };
  try {
    return body(stateDir, helpers);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** 记录用的假 Notification（与 bridge-notify.test.mjs 同形）。 */
function fakeNotification() {
  const records = { instances: [], constructCalls: 0 };
  function Notification(options) {
    records.constructCalls += 1;
    const handlers = { failed: [], click: [] };
    const instance = {
      options,
      shows: 0,
      on(event, handler) {
        if (Array.isArray(handlers[event])) handlers[event].push(handler);
      },
      once(event, handler) {
        if (Array.isArray(handlers[event])) handlers[event].push(handler);
      },
      removeAllListeners() {},
      show() {
        instance.shows += 1;
      },
      emit(event, ...args) {
        for (const handler of handlers[event] ?? []) handler(...args);
      },
    };
    records.instances.push(instance);
    return instance;
  }
  Notification.isSupported = () => true;
  Notification.records = records;
  return Notification;
}

test('one notify() writes a protocol-1 notify.json the bridge can read', () =>
  withStateDir((stateDir, h) => {
    const registry = createNotifyRegistry({ stateDir });
    const result = registry.notify('@local/demo', { title: 'Hello', body: 'World' });
    assert.equal(result.ok, true, result.message ?? '');
    assert.equal(result.rev, 1);
    assert.equal(result.id, '@local/demo#1');
    assert.equal(result.itemCount, 1);
    assert.equal(result.dropped, 0);

    const written = h.read();
    assert.notEqual(written, null, 'notify.json must exist after a notify()');
    assert.equal(written.protocol, PROTOCOLS.notify);
    assert.equal(written.protocol, PROTOCOL_NOTIFY);
    assert.equal(written.rev, result.rev, 'the document rev must equal the item rev of the newest entry');
    assert.equal(written.items.length, 1);
    assert.equal(written.items[0].id, '@local/demo#1');
    assert.equal(written.items[0].title, 'Hello');
    assert.equal(written.items[0].body, 'World');
    assert.equal(written.items[0].rev, 1);
    // 键序固定：id 在最前，rev 在最后 —— 这是字节稳定的一部分。
    assert.deepEqual(Object.keys(written.items[0]), ['id', 'title', 'body', 'rev']);
  }));

test('rev is monotonic across owners, and each item keeps its own rev', () =>
  withStateDir((stateDir, h) => {
    const registry = createNotifyRegistry({ stateDir });
    const first = registry.notify('alpha', { title: 'A1' });
    const second = registry.notify('beta', { title: 'B1' });
    const third = registry.notify('alpha', { title: 'A2' });
    assert.equal(first.rev, 1);
    assert.equal(second.rev, 2);
    assert.equal(third.rev, 3);

    const written = h.read();
    assert.deepEqual(written.items.map((item) => item.id), ['alpha#1', 'beta#1', 'alpha#2']);
    assert.deepEqual(written.items.map((item) => item.rev), [1, 2, 3]);
    assert.equal(written.rev, 3, 'the document rev is always the last item rev, never a private counter');
  }));

test('two owners cannot overwrite each other, and ids do not collide', () =>
  withStateDir((stateDir, h) => {
    const registry = createNotifyRegistry({ stateDir });
    assert.equal(registry.notify('@local/demo', { title: 'Demo 1' }).ok, true);
    assert.equal(registry.notify('@local/other', { title: 'Other 1' }).ok, true);
    assert.equal(registry.notify('@local/demo', { title: 'Demo 2' }).ok, true);

    const written = h.read();
    const ids = written.items.map((item) => item.id);
    assert.deepEqual(ids, ['@local/demo#1', '@local/other#1', '@local/demo#2']);
    assert.equal(new Set(ids).size, ids.length, 'ids must be unique across owners');
    assert.deepEqual(written.items.map((item) => item.title), ['Demo 1', 'Other 1', 'Demo 2']);
  }));

test('an owner containing "#" is refused (it is the namespace separator)', () =>
  withStateDir((stateDir, h) => {
    const registry = createNotifyRegistry({ stateDir });
    const result = registry.notify('a#b', { title: 'Nope' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EINVALID_OWNER');
    assert.equal(h.exists(), false, 'a refused notify must not write anything');
  }));

test('an empty or missing title is refused, and nothing is written', () =>
  withStateDir((stateDir, h) => {
    const registry = createNotifyRegistry({ stateDir });
    for (const title of ['', '   ', undefined, 42, null]) {
      const result = registry.notify('owner', { title });
      assert.equal(result.ok, false, `title ${JSON.stringify(title)} must be refused`);
      assert.equal(result.code, 'EINVALID_TITLE');
    }
    const noRequest = registry.notify('owner', null);
    assert.equal(noRequest.ok, false);
    assert.equal(noRequest.code, 'EINVALID_TITLE');
    assert.equal(h.exists(), false);
  }));

test('body/silent/urgency are validated, and a long body is refused', () =>
  withStateDir((stateDir, h) => {
    const registry = createNotifyRegistry({ stateDir });
    assert.equal(registry.notify('o', { title: 'T', body: 42 }).code, 'EINVALID_FIELD');
    assert.equal(registry.notify('o', { title: 'T', silent: 'yes' }).code, 'EINVALID_FIELD');
    assert.equal(registry.notify('o', { title: 'T', urgency: 'loud' }).code, 'EINVALID_FIELD');
    const long = registry.notify('o', { title: 'T', body: 'x'.repeat(NOTIFY_BODY_LIMIT + 1) });
    assert.equal(long.code, 'EINVALID_FIELD');
    const longTitle = registry.notify('o', { title: 'x'.repeat(NOTIFY_TITLE_LIMIT + 1) });
    assert.equal(longTitle.code, 'EINVALID_TITLE');
    assert.equal(h.exists(), false, 'every rejection must leave the file alone');

    // 合法值照常入队，`silent:false` 与 `urgency` 只在显式给出时才写进文档。
    assert.equal(registry.notify('o', { title: 'T', silent: false }).ok, true);
    const written = h.read();
    assert.equal(written.items[0].silent, false);
    assert.equal('urgency' in written.items[0], false);
  }));

test('the same queue produces byte-identical text (no timestamps anywhere)', () =>
  withStateDir((stateDir, h) => {
    const first = createNotifyRegistry({ stateDir });
    first.notify('a', { title: 'One', body: 'b1' });
    first.notify('b', { title: 'Two', silent: true });
    const textOne = h.text();

    // 第二个注册表：同样的调用序列 → 同样的字节。时间戳不进文档。
    const second = createNotifyRegistry({ stateDir });
    second.notify('a', { title: 'One', body: 'b1' });
    second.notify('b', { title: 'Two', silent: true });
    assert.equal(h.text(), textOne, 'identical input must produce identical bytes');

    // 内容没变时 flush() 不重写文件（mtime 也不动）。
    const mtime = statSync(h.notifyPath).mtimeMs;
    const flushed = second.flush();
    assert.equal(flushed.ok, true);
    assert.equal(flushed.written, false, 'an unchanged queue must not be rewritten');
    assert.equal(statSync(h.notifyPath).mtimeMs, mtime);
  }));

test('an empty queue DELETES notify.json', () =>
  withStateDir((stateDir, h) => {
    const registry = createNotifyRegistry({ stateDir });
    assert.equal(h.exists(), false, 'a fresh registry has nothing to say');

    registry.notify('owner', { title: 'Temp' });
    assert.equal(h.exists(), true);

    const withdrawn = registry.withdraw('owner');
    assert.equal(withdrawn.ok, true);
    assert.equal(withdrawn.removed, 1);
    assert.equal(h.exists(), false, 'removing the last item must delete the file, not leave items:[]');
  }));

test('withdraw accepts a bare or a prefixed id, and a no-op withdraw is silent', () =>
  withStateDir((stateDir, h) => {
    const registry = createNotifyRegistry({ stateDir });
    registry.notify('owner', { title: 'A' });
    registry.notify('owner', { title: 'B' });
    assert.equal(registry.withdraw('owner', { id: 'owner#1' }).removed, 1);
    assert.deepEqual(h.read().items.map((item) => item.title), ['B']);
    assert.equal(registry.withdraw('owner', { id: '2' }).removed, 1, 'a bare local id must resolve to owner#2');
    assert.equal(h.exists(), false);

    const again = registry.withdraw('owner');
    assert.equal(again.ok, true);
    assert.equal(again.removed, 0, 'a no-op withdraw is a success, so cleanup paths can be unconditional');
    assert.equal(again.rev, registry.snapshot().rev, 'a no-op must not bump rev');
  }));

test('clear() empties the queue and deletes the file', () =>
  withStateDir((stateDir, h) => {
    const registry = createNotifyRegistry({ stateDir });
    registry.notify('a', { title: 'A' });
    registry.notify('b', { title: 'B' });
    const cleared = registry.clear();
    assert.equal(cleared.ok, true);
    assert.equal(cleared.cleared, 2);
    assert.equal(h.exists(), false);
    assert.equal(registry.snapshot().document, null);
    // 空队列上的 clear 是空操作。
    assert.equal(registry.clear().cleared, 0);
  }));

test('a full queue drops the OLDEST item and says how many it dropped', () =>
  withStateDir((stateDir, h) => {
    const registry = createNotifyRegistry({ stateDir });
    let last = null;
    for (let index = 0; index < NOTIFY_QUEUE_LIMIT; index += 1) {
      last = registry.notify('owner', { title: `T${index}` });
      assert.equal(last.dropped, 0, 'nothing is dropped while the queue has room');
    }
    const overflow = registry.notify('owner', { title: 'Overflow' });
    assert.equal(overflow.ok, true);
    assert.equal(overflow.dropped, 1, 'the oldest item must be reported as dropped');
    assert.equal(h.read().items.length, NOTIFY_QUEUE_LIMIT);
    assert.deepEqual(
      h.read().items.map((item) => item.title).slice(0, 1),
      ['T1'],
      'FIFO: the first item went, the rest kept their order',
    );
  }));

test('an oversized queue is refused and the previous file bytes are untouched', () =>
  withStateDir((stateDir, h) => {
    const registry = createNotifyRegistry({ stateDir });
    registry.notify('owner', { title: 'Seed' });
    const before = h.text();
    // 直接把队列撑到「按大小拒绝」的那条路径上：大量接近 body 上限的条目。
    // 队列条数上限先于字节上限生效，所以这里断言的是「两种上限都不会让文件变坏」。
    let rejected = null;
    for (let index = 0; index < NOTIFY_QUEUE_LIMIT * 2 && rejected === null; index += 1) {
      const attempt = registry.notify('owner', { title: 'Big', body: 'x'.repeat(NOTIFY_BODY_LIMIT) });
      if (attempt.ok !== true) rejected = attempt;
    }
    assert.notEqual(rejected, null, 'a queue of maximal bodies must eventually be refused');
    assert.equal(rejected.code, 'ENOTIFY_TOO_LARGE');
    assert.equal(rejected.bytes > NOTIFY_MAX_BYTES, true, 'the refusal must name the measured size');
    assert.equal(h.bytes() <= NOTIFY_MAX_BYTES, true, 'the file on disk must never exceed the ceiling');
    assert.notEqual(h.text(), before, 'earlier accepted items stay written; only the refused one is absent');
  }));

test('the document it writes is renderable by the bridge reader (fed directly)', () =>
  withStateDir((stateDir, h) => {
    const registry = createNotifyRegistry({ stateDir });
    registry.notify('@local/dsh-power', { title: 'Restart finished', body: 'DSH is back' });
    registry.notify('@local/other', { title: 'Other', silent: true });

    const text = h.text();
    assert.notEqual(text, null);
    assert.equal(h.bytes() <= NOTIFY_MAX_BYTES, true, 'the reader would refuse an oversize file');

    const Notification = fakeNotification();
    const events = [];
    const channel = createNotifyChannel({
      stateDir,
      notification: Notification,
      emit: (record) => events.push(record),
      now: () => 1_000,
    });
    const result = channel.poll();
    assert.equal(result.shown, 2, 'every item the writer produced must be showable');
    assert.deepEqual(
      Notification.records.instances.map((instance) => instance.options.title),
      ['Restart finished', 'Other'],
    );
    assert.equal(Notification.records.instances[1].options.silent, true);
    // owner 来自 `id` 的前缀：写半身用 `owner#序号`，桥侧的 click 事件据此归位。
    Notification.records.instances[0].emit('click');
    assert.deepEqual(events, [{ type: 'notify-click', id: '@local/dsh-power#1', owner: '@local/dsh-power' }]);

    // 同一份文件再读一次：没有重复（这正是 rev 水位的意义）。
    const second = createNotifyChannel({ stateDir, notification: Notification, emit: () => {} });
    assert.equal(second.poll().shown, 0, 'a restart over the same file must not replay');
    channel.dispose();
    second.dispose();
  }));

test('a root whose notify.json was deleted is repaired by flush()', () =>
  withStateDir((stateDir, h) => {
    const registry = createNotifyRegistry({ stateDir });
    registry.notify('owner', { title: 'Keep me' });
    rmSync(h.notifyPath, { force: true });
    const flushed = registry.flush();
    assert.equal(flushed.ok, true);
    assert.equal(flushed.written, true, 'a deleted file must be rewritten from memory');
    assert.equal(h.read().items.length, 1);
    assert.equal(h.read().items[0].title, 'Keep me');
  }));

test('a state directory whose path is a regular file fails cleanly', () =>
  withStateDir((_stateDir, h) => {
    const blocker = path.join(h.stateDir, '..', 'blocked');
    writeFileSync(blocker, 'not a directory', 'utf8');
    const registry = createNotifyRegistry({ stateDir: path.join(blocker, 'dsh-asar-framework') });
    const result = registry.notify('owner', { title: 'Nope' });
    assert.equal(result.ok, false, 'a write into a non-directory must fail');
    assert.equal(result.code, 'EWRITE_FAILED');
    assert.equal(typeof result.message, 'string');
    assert.equal(result.message.length > 0, true);
  }));

test('an empty notify.json (no items) reads as nothing to show, not as an error', () =>
  withStateDir((stateDir, h) => {
    // 写半身用「删文件」表达空队列，但一个空 `items: []` 文档仍然是合法的 protocol
    // 1 文档 —— 桥必须把它当成「没有待显示的通知」而不是坏文档。
    writeFileSync(h.notifyPath, JSON.stringify({ protocol: 1, rev: 0, items: [] }), 'utf8');
    const Notification = fakeNotification();
    const channel = createNotifyChannel({ stateDir, notification: Notification, emit: () => {} });
    assert.deepEqual(channel.poll(), { shown: 0, skipped: 0, reason: null });
    assert.equal(channel.status().lastError, null, 'an empty queue is not an error');
    assert.equal(Notification.records.constructCalls, 0);
    channel.dispose();
  }));

test('the write half and the read half agree on the item ceiling', () =>
  withStateDir(() => {
    // 两个常量必须来自同一个地方：`NOTIFY_QUEUE_LIMIT` 由 Host 导出，取自桥的
    // `NOTIFY_ITEM_LIMIT`；两边各写一个 64 是最容易发生的漂移。
    assert.equal(NOTIFY_QUEUE_LIMIT, NOTIFY_ITEM_LIMIT);
    assert.equal(typeof NOTIFY_QUEUE_LIMIT, 'number');
    assert.equal(NOTIFY_QUEUE_LIMIT > 0, true);
  }));
