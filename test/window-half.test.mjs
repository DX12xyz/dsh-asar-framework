/**
 * The window capability's TWO MISSING HALVES — the Host write half and the close
 * push — plus the pins that keep them from becoming a second copy of the contract.
 *
 * WHAT THIS FILE HAS TO PROVE, in the order the capability is built:
 *   1. the injected region is still BYTE-IDENTICAL (the sha the installer splices),
 *      and the only honest answer to "can the region carry a `closed` handler?"
 *      is MEASURED here rather than argued;
 *   2. the region ships the validator's OWN SOURCE (byte-identical to
 *      `lib/bridge/src/windows.js`, extended from the existing pin) and answers
 *      the same corpus the module answers — so the write half's rules cannot
 *      drift from the region's;
 *   3. `asarShell.openWindow` validates with that same validator (no second
 *      copy), sends ONE `channel:'window'` message over the existing `channelSend`,
 *      and states the caps as real codes;
 *   4. `asarShell.windows()` is a snapshot derived from ACKs and close events,
 *      never a live Electron query;
 *   5. the close push reports exactly one record per close and degrades to
 *      `available:false` without touching the tray;
 *   6. `bridge.json` always carries a bounded `windows` block, in the ONE key-order
 *      constant (`RENDER_RECORD_KEYS`).
 *
 * `node --test test/window-half.test.mjs`
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  MAX_WINDOW_SPECS,
  WINDOW_ACKS,
  WINDOW_CLOSED_EVENT,
  WINDOW_POLL_EVERY,
  WINDOW_SPEC_CODES,
  WINDOW_SPEC_INTERNALS,
  WINDOW_SPEC_LIMITS,
  createWindowTracker,
  describeWindowChannel,
  describeWindowSpec,
  validateWindowSpec,
} from '../lib/bridge/src/windows.js';
import {
  CHANNEL_DECLINE_CODES,
  IPC_BODY,
  SPLIT_BODY_BYTES,
  SPLIT_MINIMUM_REGION_LENGTH,
  anonymousFunctionSource,
  buildSplitRegion,
  inlineChannelConstants,
  WINDOW_SPEC_CODES_SOURCE,
  WINDOW_SPEC_LIMITS_SOURCE,
} from '../lib/asar/patch-body.js';
import { REGION_RESERVE_BYTES } from '../lib/wire/constants.js';
import { FILES } from '../lib/bridge/src/paths.js';
import { RENDER_RECORD_KEYS, writeRenderRecord } from '../lib/bridge/src/diagnostics.js';
import {
  WINDOW_HOST_CODES,
  WINDOW_REGION_CODES,
  WINDOW_SPEC_FIELDS,
  createWindowRegistry,
} from '../lib/host/window-registry.js';
import { ARTEFACT_PATH, MESSAGES, isAscii, loadArtefact, stripComments } from './bridge-harness.mjs';

/** The sha256 the shipped region MUST keep producing (0.2.0 geometry). */
const REGION_SHA = '36eaf6b4e5e3e39e83044195101d8830275426212a899ff4bca3653e02cb6925';

/** The headroom the reserve keeps above the floor `split-surgery.test.mjs` asserts. */
const SPARE_FLOOR = 1000;

/** This file's scratch root: probes only, never a shipped path. */
const PROBE_DIR = path.join(os.tmpdir(), `dsh-window-half-${process.pid}`);

after(() => {
  rmSync(PROBE_DIR, { recursive: true, force: true });
});

/**
 * A throwaway state directory.
 *
 * @returns {{ root: string, stateDir: string, path: (name: string) => string,
 *             write: (name: string, text: string) => string, cleanup: () => void }}
 */
function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-window-home-'));
  const stateDir = path.join(root, 'dsh-asar-framework');
  mkdirSync(stateDir, { recursive: true });
  return {
    root,
    stateDir,
    path: (name) => path.join(stateDir, name),
    write(name, text) {
      writeFileSync(path.join(stateDir, name), text, 'utf8');
      return path.join(stateDir, name);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A stand-in for the shell's window class, shaped exactly like what the region
 * injects (`electron.window`): callable, with a static `getAllWindows()`.
 *
 * It answers plain `{id}` objects and NOTHING else — the tracker must not need
 * a method on a window it does not call.
 *
 * @param {number[]} live the numeric ids currently "open"; mutated by the test
 * @returns {Function & { getAllWindows: () => { id: number }[] }}
 */
function fakeWindowClass(live) {
  const provider = function WindowStub() {};
  provider.getAllWindows = () => live.map((id) => ({ id }));
  return provider;
}

/** Append the `events.jsonl` line the way `kernel.js` `emit` does. */
function eventLine(record) {
  const parts = ['{"protocol":2'];
  parts.push(',"at":' + JSON.stringify(record.at ?? '2026-11-16T00:00:00.000Z'));
  parts.push(',"type":' + JSON.stringify(record.type));
  parts.push(',"id":' + JSON.stringify(record.id));
  parts.push(',"path":[]');
  if (typeof record.owner === 'string' && record.owner !== '') parts.push(',"owner":' + JSON.stringify(record.owner));
  parts.push('}');
  return parts.join('') + '\n';
}

// ---------------------------------------------------------------------------
// 1. The region is byte-identical, and the close handler CANNOT fit: measured.
// ---------------------------------------------------------------------------

test('the shipped region is byte-identical, so the close push costs 0 region bytes', () => {
  const region = buildSplitRegion(REGION_RESERVE_BYTES);
  assert.equal(createHash('sha256').update(region).digest('hex'), REGION_SHA,
    'the shipped region changed; the close push must not touch it');
  // The arithmetic the design rests on, asserted rather than quoted from prose.
  assert.equal(SPLIT_BODY_BYTES, 15284, 'the shipped split body, measured');
  assert.equal(SPLIT_MINIMUM_REGION_LENGTH, 15331, 'marker + body + end marker + padding floor');
  assert.equal(REGION_RESERVE_BYTES, 16384, 'the reserve is a packaging decision, not a byte of the body');
  const spare = REGION_RESERVE_BYTES - SPLIT_MINIMUM_REGION_LENGTH;
  assert.equal(spare, 1053, 'the spare the audit cites');
  const headroom = spare - SPARE_FLOOR;
  assert.equal(headroom >= 0, true, 'the 1,000 B floor must still hold');
  assert.equal(headroom, 53, 'the budget a region-side handler would have to spend');
});

test('the region can NOT carry a `closed` handler: the measured need exceeds the headroom 6x', () => {
  // THE DECISION, arithmetic instead of preference. A handler that appends one
  // `events.jsonl` line has to (a) be a function in the region, (b) be called from
  // the listener `handleWindowMessage` already registers, (c) be added to the
  // substitution table. Each part is measured here against the region's real
  // compaction (`compactJsSource` + the block's own renamed helpers), so the
  // number is what the builder would actually spend.
  const region = buildSplitRegion(REGION_RESERVE_BYTES);
  const text = region.toString('utf8');
  const spare = REGION_RESERVE_BYTES - SPLIT_MINIMUM_REGION_LENGTH;

  // (a) The function body, compacted exactly as a shipped function is: the source
  //     text below is the MINIMAL correct one (no comments, no prose, ASCII only).
  const body = 'function (id) {' +
    'const dir = __channelStateDir();' +
    'if (dir === null) return;' +
    '__channelWrite(dir + "/' + FILES.events + '", dir + "/' + FILES.eventsRotated + '",' +
    ' "{\\"protocol\\":2,\\"at\\":\\"" + new Date().toISOString() + ' +
    '"\\",\\"type\\":\\"' + WINDOW_CLOSED_EVENT + '\\",\\"id\\":" + JSON.stringify(id) + "}\\n",' +
    ' 524288);' +
    '}';
  const declaration = 'const __windowClosed = ' + body + ';';
  // (b) The listener as it must be WIDENED. The shipped one is this exact string:
  const shippedListener = "created.once('closed', () => void windows.delete(spec.id));";
  assert.equal(text.includes(shippedListener), true,
    'the shipped listener must still be the one this measurement widens');
  const widenedListener = "created.once('closed', () => { windows.delete(spec.id); __windowClosed(spec.id); });";
  const listenerDelta = widenedListener.length - shippedListener.length;
  // (c) The block separator (`\n\t\t`) the handler block puts before every entry.
  const separators = 2;
  const needed = declaration.length + listenerDelta + separators;

  assert.equal(text.includes('__windowClosed'), false, 'the region must NOT already carry the handler');
  // The RAW spare is 1,053 B, but the POLICY budget is what is above the floor:
  // `split-surgery.test.mjs` refuses a build that dips below 1,000 B, so the
  // region can only grow by 53 B. The handler needs 322 B — six times that.
  assert.equal(needed > spare - SPARE_FLOOR, true,
    `it needs ${needed} B against ${spare - SPARE_FLOOR} B of budget above the floor — `
    + 'so the region CANNOT fit it, and the bridge carries the push instead');
  assert.equal(needed, 322,
    'the measured need is 322 B: declaration ' + declaration.length
    + ' B + listener delta ' + listenerDelta + ' B + two separators');
  assert.equal(needed >= 6 * (spare - SPARE_FLOOR), true,
    `322 B is at least six times the ${spare - SPARE_FLOOR} B headroom, which is why the number decides `
    + 'instead of a preference');
});

// ---------------------------------------------------------------------------
// 2. The region ships the validator's OWN SOURCE: the existing pin, extended.
// ---------------------------------------------------------------------------

/**
 * Extract one shipped `const NAME = function (...) { ... };` from the region text,
 * including the semicolon, by brace matching.
 *
 * @param {string} text the region's UTF-8 text
 * @param {string} name the `const` binding
 * @returns {string} `const NAME = …;`, or throws when absent
 */
function extractShippedConst(text, name) {
  const start = text.indexOf('const ' + name + ' = ');
  if (start < 0) throw new Error('missing shipped const: ' + name);
  let depth = 0;
  let seen = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') {
      depth += 1;
      seen = true;
    } else if (character === '}') {
      depth -= 1;
      if (seen === true && depth === 0) {
        const end = text.indexOf(';', index);
        return text.slice(start, end + 1);
      }
    }
  }
  throw new Error('unbalanced braces while extracting ' + name);
}

test('the region carries the validator SOURCE byte-identically (the existing pin, extended)', async () => {
  const text = buildSplitRegion(REGION_RESERVE_BYTES).toString('utf8');

  // THE BYTE-LEVEL PIN, extended from `IPC_BODY.includes('"maxWidth":8000')` in
  // `test/channel.test.mjs`: not "the number is somewhere in there", but "the
  // function inside the archive is THIS function, compacted and renamed, to the
  // byte". If anybody types a second copy of the ranges or the messages into the
  // region template, this stops matching.
  for (const [shippedName, fn] of [
    ['__isObject', WINDOW_SPEC_INTERNALS.isObject],
    ['__fail', WINDOW_SPEC_INTERNALS.fail],
    ['__bounded', WINDOW_SPEC_INTERNALS.bounded],
    ['__validateWindowSpec', validateWindowSpec],
  ]) {
    const extracted = extractShippedConst(text, shippedName);
    const expected = 'const ' + shippedName + ' = '
      + anonymousFunctionSource(inlineChannelConstants(fn.toString())) + ';';
    assert.equal(extracted, expected,
      shippedName + ' in the region must be the module\'s OWN source, compacted and renamed');
  }
  // The predicate the validator delegates to is shared the same way, and it is
  // stated SEPARATELY because it is the one security rule of this capability.
  const { isSameOriginRoute } = await import('../lib/bridge/src/windows.js');
  assert.equal(
    extractShippedConst(text, '__isSameOriginRoute'),
    'const __isSameOriginRoute = ' + anonymousFunctionSource(inlineChannelConstants(isSameOriginRoute.toString())) + ';',
    'the same-origin predicate must be shipped as its own function, byte-identically',
  );
  // The bounds and the codes are DERIVED literals, not retyped ones.
  assert.equal(IPC_BODY.includes(WINDOW_SPEC_LIMITS_SOURCE), true,
    'the region must carry the limits object exactly as the contract serialises it');
  assert.equal(IPC_BODY.includes(WINDOW_SPEC_CODES_SOURCE), true,
    'the region must carry the refusal codes exactly as the contract serialises them');

  // AND THE TWO AGREE ON A CORPUS: the shipped bytes are EXECUTED and compared with
  // the exported function, so "same source" is a behavioural claim too.
  mkdirSync(PROBE_DIR, { recursive: true });
  const probe = path.join(PROBE_DIR, 'shipped-window-validator.mjs');
  writeFileSync(probe, [
    'const __winLimits = ' + WINDOW_SPEC_LIMITS_SOURCE + ';',
    'const __winCodes = ' + WINDOW_SPEC_CODES_SOURCE + ';',
    extractShippedConst(text, '__isObject'),
    extractShippedConst(text, '__fail'),
    extractShippedConst(text, '__bounded'),
    extractShippedConst(text, '__isSameOriginRoute'),
    extractShippedConst(text, '__validateWindowSpec'),
    'export { __validateWindowSpec, __isSameOriginRoute };',
  ].join('\n'), 'utf8');
  const shipped = await import(pathToFileURL(probe).href);

  const corpus = [
    undefined, null, 42, 'nope', [], {},
    { id: '' }, { id: 'ok' }, { title: 'no id' },
    { id: 'w', route: '/settings' },
    { id: 'w', route: 'https://evil.example/x' },
    { id: 'w', route: '//evil.example' },
    { id: 'w', route: 'file:///<test>/x' },
    { id: 'w', route: 'x/y' },
    { id: 'w', route: '\\\\server\\share' },
    { id: 'w', url: 'https://example.com' },
    { id: 'w'.repeat(WINDOW_SPEC_LIMITS.maxIdLength + 1) },
    { id: 'w', title: 'T'.repeat(WINDOW_SPEC_LIMITS.maxTitleLength + 1) },
    { id: 'w', route: '/' + 'a'.repeat(WINDOW_SPEC_LIMITS.maxRouteLength) },
    { id: 'w', width: WINDOW_SPEC_LIMITS.minWidth - 1 },
    { id: 'w', width: WINDOW_SPEC_LIMITS.maxWidth + 1 },
    { id: 'w', height: WINDOW_SPEC_LIMITS.minHeight - 1 },
    { id: 'w', x: WINDOW_SPEC_LIMITS.coordLimit + 1 },
    { id: 'w', y: -WINDOW_SPEC_LIMITS.coordLimit - 1 },
    { id: 'w', resizable: 'yes' },
    { id: 'w', frameless: 1 },
    { id: 'w', modal: null },
    { id: 'w', width: 900.4, height: 600.6, x: -100.6 },
    { id: 'w', title: 'T', route: '/x', width: 900, height: 600, x: 10, y: 20, resizable: true, frameless: false, modal: false },
  ];
  for (const input of corpus) {
    const fromBytes = shipped.__validateWindowSpec(input, 'spec');
    const fromModule = validateWindowSpec(input, 'spec');
    assert.equal(fromBytes.ok, fromModule.ok, 'verdict differs for ' + JSON.stringify(input));
    if (fromModule.ok !== true) {
      assert.equal(fromBytes.code, fromModule.code, 'code differs for ' + JSON.stringify(input));
      assert.equal(fromBytes.where, fromModule.where, 'where differs for ' + JSON.stringify(input));
      assert.equal(fromBytes.message, fromModule.message, 'message differs for ' + JSON.stringify(input));
    } else {
      assert.deepEqual(fromBytes.spec, fromModule.spec, 'accepted spec differs for ' + JSON.stringify(input));
    }
  }
  // The security rule itself, on both copies: an absolute URL is never a route.
  for (const route of ['https://evil.example/x', '//evil.example', 'file:///<test>/x', '\\\\server\\share']) {
    assert.equal(shipped.__isSameOriginRoute(route), false, 'shipped predicate accepted ' + route);
  }
});

// ---------------------------------------------------------------------------
// 3. The Host write half: same source of truth, one message, real codes.
// ---------------------------------------------------------------------------

test('openWindow validates with the ONE contract and quotes its codes, never a copy', async () => {
  const dir = scratch();
  try {
    const registry = createWindowRegistry({ stateDir: dir.stateDir });
    const sent = [];
    const send = async (message) => {
      sent.push(message);
      return { ok: true, channel: message.channel, sentAt: '2026-11-16T00:00:00.000Z' };
    };

    // The codes the Host answers with ARE the contract's codes (identity, not a
    // string that happens to be equal): retyping one here would be the second copy
    // this task forbids.
    assert.equal(WINDOW_HOST_CODES.EINVALID_SPEC, WINDOW_SPEC_CODES.EINVALID_SPEC);
    assert.equal(WINDOW_HOST_CODES.ERANGE, WINDOW_SPEC_CODES.ERANGE);
    assert.equal(WINDOW_HOST_CODES.EUNSAFE_ROUTE, WINDOW_SPEC_CODES.EUNSAFE_ROUTE);
    // And the field set the write half documents is the contract's field list.
    assert.deepEqual(WINDOW_SPEC_FIELDS, describeWindowChannel().fields);

    // Every refusal the validator would produce comes back, with ITS message and
    // its `where` — and NOTHING is sent, because a refused spec must not reach the
    // main process at all.
    for (const [spec, code] of [
      [{ id: '', route: '/x' }, WINDOW_SPEC_CODES.EINVALID_SPEC],
      [{ title: 'no id' }, WINDOW_SPEC_CODES.EINVALID_SPEC],
      [{ id: 'w', route: 'https://evil.example/x' }, WINDOW_SPEC_CODES.EUNSAFE_ROUTE],
      [{ id: 'w', url: 'https://example.com' }, WINDOW_SPEC_CODES.EUNSAFE_ROUTE],
      [{ id: 'w', width: WINDOW_SPEC_LIMITS.minWidth - 1 }, WINDOW_SPEC_CODES.ERANGE],
      [{ id: 'w', height: WINDOW_SPEC_LIMITS.maxHeight + 1 }, WINDOW_SPEC_CODES.ERANGE],
      [{ id: 'w', x: WINDOW_SPEC_LIMITS.coordLimit + 1 }, WINDOW_SPEC_CODES.ERANGE],
      [{ id: 'w'.repeat(WINDOW_SPEC_LIMITS.maxIdLength + 1) }, WINDOW_SPEC_CODES.ERANGE],
      [{ id: 'w', title: 'T'.repeat(WINDOW_SPEC_LIMITS.maxTitleLength + 1) }, WINDOW_SPEC_CODES.ERANGE],
    ]) {
      const refused = await registry.openWindow({ owner: '@local/demo', spec }, send);
      assert.equal(refused.ok, false, 'spec ' + JSON.stringify(spec) + ' must be refused');
      assert.equal(refused.code, code, 'wrong code for ' + JSON.stringify(spec));
      // The message is the contract's own message, byte for byte.
      assert.equal(refused.message, validateWindowSpec(spec, 'spec').message,
        'the refusal text must be the validator\'s, not a reworded copy');
      assert.equal(typeof refused.where, 'string', 'the refusal names the field');
    }
    assert.equal(sent.length, 0, 'a refused spec must never be sent: nothing reached the main process');

    // A legal spec travels as ONE message, on the existing channel, carrying ONLY
    // the allow-listed fields — the validator's copy is what crosses the boundary.
    const opened = await registry.openWindow(
      {
        owner: '@local/demo',
        spec: { id: 'settings', title: 'Demo', route: '/settings', width: 900, height: 600, x: 10, resizable: true, id2: 'ignored', webPreferences: { preload: '/evil' } },
      },
      send,
    );
    assert.equal(opened.ok, true, opened.message ?? '');
    assert.equal(opened.channel, 'window');
    assert.equal(opened.id, 'settings');
    assert.equal(opened.state, 'sent', 'the answer says "sent", never "opened": the ACK is a file away');
    assert.equal(sent.length, 1, 'exactly one message per openWindow call');
    assert.deepEqual(sent[0], {
      channel: 'window',
      payload: { id: 'settings', title: 'Demo', route: '/settings', width: 900, height: 600, x: 10, resizable: true },
    }, 'the payload is the validator\'s allow-listed copy — unknown keys never cross the boundary');
  } finally {
    dir.cleanup();
  }
});

test('openWindow states the caps as codes: one per owner-id, MAX_WINDOW_SPECS per owner', async () => {
  const dir = scratch();
  try {
    const registry = createWindowRegistry({ stateDir: dir.stateDir });
    const sent = [];
    const send = async (message) => {
      sent.push(message);
      return { ok: true, channel: message.channel, sentAt: '2026-11-16T00:00:00.000Z' };
    };

    assert.equal(await registry.openWindow({ owner: '@local/demo', spec: { id: 'a', route: '/x' } }, send).then((r) => r.ok), true);
    // A DUPLICATE id is refused with a code of its own — not the region's `E_DUP`
    // after a round trip, which would leave the caller with silence for a moment.
    const duplicate = await registry.openWindow({ owner: '@local/demo', spec: { id: 'a', route: '/x' } }, send);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, WINDOW_HOST_CODES.EWINDOW_DUPLICATE);
    assert.equal(sent.length, 1, 'the duplicate was refused BEFORE sending');

    // The per-owner cap: 8 windows, the same `MAX_WINDOW_SPECS` the region enforces
    // GLOBALLY. The Host's reason says which cap it is, so a caller is never told
    // "no" without a reason.
    for (let index = 1; index < MAX_WINDOW_SPECS; index += 1) {
      const each = await registry.openWindow({ owner: '@local/demo', spec: { id: 'w' + index, route: '/x' } }, send);
      assert.equal(each.ok, true, 'window ' + index + ' must be accepted');
    }
    assert.equal(sent.length, MAX_WINDOW_SPECS);
    const over = await registry.openWindow({ owner: '@local/demo', spec: { id: 'one-too-many', route: '/x' } }, send);
    assert.equal(over.ok, false);
    assert.equal(over.code, WINDOW_HOST_CODES.EWINDOW_LIMIT);
    assert.match(over.message, new RegExp(String(MAX_WINDOW_SPECS)), 'the refusal names the cap');
    assert.equal(sent.length, MAX_WINDOW_SPECS, 'nothing was sent past the cap');

    // The cap is PER OWNER, not global: another owner has its own budget.
    const other = await registry.openWindow({ owner: '@local/other', spec: { id: 'mine', route: '/x' } }, send);
    assert.equal(other.ok, true, 'a second owner is not blocked by the first one\'s windows');

    // `owner` is the one non-spec field, and an illegal one is refused before
    // anything else happens (it shares the tray's owner namespace).
    for (const owner of [undefined, '', 'a#b', ' padded ', 7]) {
      const refused = await registry.openWindow({ owner, spec: { id: 'x' } }, send);
      assert.equal(refused.ok, false, 'owner ' + JSON.stringify(owner) + ' must be refused');
      assert.equal(refused.code, WINDOW_HOST_CODES.EINVALID_OWNER);
    }
  } finally {
    dir.cleanup();
  }
});

test('a channelSend refusal is passed through UNCHANGED: the write half does not invent a reason', async () => {
  const dir = scratch();
  try {
    const registry = createWindowRegistry({ stateDir: dir.stateDir });
    // The three shapes `lib/host/service.js` `channelSend` really returns for "no
    // message was sent": a Host with no IPC channel, a stale region, and a throw
    // from the sender itself. The write half must forward each one verbatim, because
    // only channelSend knows which of them happened.
    for (const refusal of [
      { ok: false, code: 'ENO_IPC', message: 'Host 进程没有 IPC 通道' },
      { ok: false, code: 'EREGION_STALE', message: '装着的区域不是本次构建写的那一份', region: { length: 8192, sha256: 'x' } },
    ]) {
      const result = await registry.openWindow({ owner: '@local/demo', spec: { id: 'x' } }, async () => refusal);
      assert.equal(result.ok, false);
      assert.equal(result.code, refusal.code, 'the code must be channelSend\'s own');
      assert.equal(result.message, refusal.message, 'and so must the message');
    }
    // A sender that throws is a refusal, not a crash.
    const thrown = await registry.openWindow({ owner: '@local/demo', spec: { id: 'x' } }, async () => {
      throw new Error('channel closed');
    });
    assert.equal(thrown.ok, false);
    assert.equal(thrown.code, WINDOW_HOST_CODES.ENO_IPC);
    assert.match(thrown.message, /channel closed/);
    // A missing sender is the same refusal: the window capability cannot exist
    // without the IPC fast path, and it says so instead of pretending.
    const missing = await registry.openWindow({ owner: '@local/demo', spec: { id: 'x' } }, undefined);
    assert.equal(missing.ok, false);
    assert.equal(missing.code, WINDOW_HOST_CODES.ENO_IPC);
    // A refused send must not be recorded as a window.
    assert.equal(registry.windows().count, 0, 'a refusal leaves the registry empty');
  } finally {
    dir.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. `windows()`: a snapshot from ACKs and close events, NOT a live query.
// ---------------------------------------------------------------------------

test('windows() reads the region ACKs back: opened, rejected, and never a live query', async () => {
  const dir = scratch();
  try {
    const registry = createWindowRegistry({ stateDir: dir.stateDir });
    let calls = 0;
    const send = async (message) => {
      calls += 1;
      return { ok: true, channel: message.channel, sentAt: 'send-' + calls };
    };
    // Two requests: ONE the region will accept, ONE it will refuse. Both are
    // recorded here only as "sent" until the ack file says otherwise.
    await Promise.all([
      registry.openWindow({ owner: '@local/demo', spec: { id: 'settings', route: '/settings' } }, send),
      registry.openWindow({ owner: '@local/demo', spec: { id: 'second', route: '/other' } }, send),
    ]);
    let snapshot = registry.windows();
    assert.equal(snapshot.count, 2, 'both requests are known as "sent" before any ack');
    assert.deepEqual(snapshot.open.map((entry) => entry.state), ['sent', 'sent']);

    // The region answers BOTH, exactly as it ships them: an object `received`.
    dir.write(FILES.channelOut, [
      JSON.stringify({ protocol: 1, channel: 'window', at: 'ack-1', received: { received: 'opened', windowId: 'settings' } }),
      JSON.stringify({ protocol: 1, channel: 'window', at: 'ack-2', received: { received: 'rejected', windowId: 'second', reason: 'E_NOT_REAL' } }),
      // An unrelated ack must not be mistaken for a window answer.
      JSON.stringify({ protocol: 1, channel: 'notify', at: 'ack-3', received: 'shown' }),
    ].join('\n') + '\n');

    snapshot = registry.windows();
    assert.equal(snapshot.count, 2, 'a rejected window is not "open"… it is still a known entry');
    const opened = snapshot.open.find((entry) => entry.id === 'settings');
    const rejected = snapshot.open.find((entry) => entry.id === 'second');
    assert.equal(opened.state, WINDOW_ACKS.opened, 'the ack file is what turns "sent" into "opened"');
    assert.equal(opened.openedAt, 'ack-1', 'the ack timestamp is kept');
    assert.equal(rejected.state, WINDOW_ACKS.rejected);
    assert.equal(rejected.reason, 'E_NOT_REAL', 'the region\'s reason is quoted, not translated');
    // The source names the files, so a caller can tell where the answer came from.
    assert.deepEqual(snapshot.source, {
      acks: FILES.channelOut,
      closes: FILES.events,
      bridge: 'bridge.json',
    });
    // "Not a live Electron query" is a FACT, not a promise: nothing in this
    // module can reach a window class, and the snapshot says so by carrying the
    // file cursors it actually advanced.
    assert.equal(snapshot.cursor.channel > 0, true, 'the snapshot advanced a byte cursor, i.e. it read a FILE');
    // A re-read consumes nothing twice: the cursor is a byte offset.
    const again = registry.windows();
    assert.equal(again.observed.acks, 0, 'a second read must not re-absorb the same ack lines');
    assert.equal(again.count, 2);

    // And a REJECTED entry stops counting toward the per-owner cap.
    const refill = await registry.openWindow({ owner: '@local/demo', spec: { id: 'third', route: '/x' } }, send);
    assert.equal(refill.ok, true, 'a refused window frees its slot');
  } finally {
    dir.cleanup();
  }
});

test('windows() folds close events in, and reports the owner only when it is unambiguous', async () => {
  const dir = scratch();
  try {
    const registry = createWindowRegistry({ stateDir: dir.stateDir });
    const send = async (message) => ({ ok: true, channel: message.channel, sentAt: 'send' });
    await Promise.all([
      registry.openWindow({ owner: '@local/one', spec: { id: 'shared', route: '/x' } }, send),
      registry.openWindow({ owner: '@local/two', spec: { id: 'shared', route: '/x' } }, send),
    ]);
    let snapshot = registry.windows();
    // Two owners used the SAME id: both are legal windows in the region, so the
    // snapshot must say the close attribution is ambiguous instead of guessing.
    assert.equal(snapshot.count, 2);
    assert.equal(snapshot.ambiguous, 2, 'a shared id makes the close attribution ambiguous');

    // The bridge reports a close for that id with NO owner (the region cannot
    // know one). BOTH entries close — that is the only truthful reading — and
    // the ambiguity was already counted above.
    dir.write(FILES.events, eventLine({ type: WINDOW_CLOSED_EVENT, id: 'shared' }));
    snapshot = registry.windows();
    assert.equal(snapshot.count, 0, 'the close event removed both entries from "open"');
    assert.equal(snapshot.closed.length, 2);
    assert.equal(snapshot.observed.closes, 1, 'one line, two folds: the ambiguity is real and reported');
    for (const entry of snapshot.closed) assert.equal(entry.state, 'closed');

    // An event with an OWNER closes only that owner's entry — the precise case.
    const fresh = createWindowRegistry({ stateDir: dir.stateDir });
    await Promise.all([
      fresh.openWindow({ owner: '@local/a', spec: { id: 'x', route: '/x' } }, send),
      fresh.openWindow({ owner: '@local/b', spec: { id: 'x', route: '/x' } }, send),
    ]);
    dir.write(FILES.events, eventLine({ type: WINDOW_CLOSED_EVENT, id: 'x', owner: '@local/a' }) + '\n');
    const one = fresh.windows();
    assert.equal(one.count, 1, 'only the named owner\'s window closed');
    assert.equal(one.open[0].owner, '@local/b');
    // Unrelated event types are ignored entirely.
    assert.equal(fresh.windows().observed.closes, 0, 'a second read consumes nothing twice');
  } finally {
    dir.cleanup();
  }
});

test('windows() is fail-soft: a missing or unwritable state directory is a STATE, not a throw', () => {
  const noDir = createWindowRegistry({ stateDir: null });
  const snapshot = noDir.windows();
  assert.equal(snapshot.ok, true, 'a snapshot is total');
  assert.equal(snapshot.available, false, 'no state directory means no observable windows');
  assert.deepEqual(snapshot.open, []);
  assert.equal(snapshot.count, 0);

  // A directory that is really a FILE cannot be read by either file channel.
  const dir = scratch();
  try {
    const blocker = dir.path('blocked');
    writeFileSync(blocker, 'x', 'utf8');
    const blocked = createWindowRegistry({ stateDir: blocker });
    const result = blocked.windows();
    assert.equal(result.ok, true, 'a broken state directory must not throw at the caller');
    assert.equal(result.count, 0);
    assert.equal(typeof result.lastError, 'string', 'and it must say why instead of silently reporting nothing');

    // An oversize ack file is refused, not parsed — same discipline as the bridge.
    const big = createWindowRegistry({ stateDir: dir.stateDir });
    dir.write(FILES.channelOut, 'x'.repeat(128 * 1024));
    const oversize = big.windows();
    assert.equal(oversize.ok, true);
    assert.match(oversize.lastError, /cap/, 'the refusal names the cap: ' + oversize.lastError);
  } finally {
    dir.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. The close push: one record per close, no duplicates, fail-soft.
// ---------------------------------------------------------------------------

test('the tracker reports EXACTLY ONE record per close, even across many samples', () => {
  // The baseline is the shell's OWN windows: they exist before this bridge does and
  // are never candidates for pairing, which is what keeps the first ack from stealing
  // one of them.
  const live = [1, 2];
  const records = [];
  const tracker = createWindowTracker({
    electron: { window: fakeWindowClass(live) },
    append: (record) => records.push(record),
  });
  // The region's own ack shape, as `channel.js` `drain()` hands it over. At this
  // instant the window does not exist natively yet (the ack file lags the array),
  // so it is recorded as unpaired — not guessed at.
  assert.equal(tracker.observe([
    { protocol: 1, channel: 'window', at: 'ack-1', received: { received: 'opened', windowId: 'settings' } },
  ]).opened.length, 1, 'the ack registers one known window');
  assert.equal(tracker.status().known, 1);
  assert.equal(tracker.status().available, true);

  // The window appears: the first sample pairs it (one unpaired entry, one candidate).
  live.push(3);
  const paired = tracker.tick();
  assert.equal(paired.closed, 0, 'the window is alive, so nothing closed');
  assert.equal(tracker.known()[0].nativeId, '3', 'the single candidate is paired with the single unpaired entry');

  // The user closes it: the next sample sees it disappear.
  live.length = 0;
  const first = tracker.tick();
  assert.equal(first.closed, 1, 'the close is reported on the FIRST sample after it');
  assert.equal(records.length, 1, 'one record, not one per tick');
  assert.equal(records[0].type, WINDOW_CLOSED_EVENT);
  assert.equal(records[0].id, 'settings', 'the record carries the spec id the ACK named');
  assert.equal(records[0].owner, null, 'the region cannot know an owner, so the bridge does not invent one');
  assert.equal(records[0].nativeId, '3', 'and the numeric id it was paired with');
  assert.equal(typeof records[0].at, 'string', 'the close is timestamped once, by the observer');
  assert.equal(tracker.status().known, 0, 'a reported close leaves the known set');
  assert.equal(tracker.status().closed, 1);
  assert.equal(typeof tracker.status().lastAt, 'string', 'the close is timestamped for bridge.json');

  // Ten more samples: the SAME close must never be reported twice.
  live.push(4, 5);
  for (let index = 0; index < 10; index += 1) tracker.tick();
  assert.equal(records.length, 1, 'a closed id is removed as it is reported, so it cannot repeat');
  assert.equal(tracker.status().closed, 1);
  assert.equal(tracker.status().sampled >= 11, true, 'the samples really ran: ' + tracker.status().sampled);
});

test('the tracker only reports windows it saw an ACK for: a foreign close is not its news', () => {
  const live = [1];
  const records = [];
  const tracker = createWindowTracker({
    electron: { window: fakeWindowClass(live) },
    append: (record) => records.push(record),
  });
  // Somebody else's window closes (a shell window, another plugin's window).
  live.length = 0;
  assert.equal(tracker.tick().closed, 0, 'a window this bridge never ACKed is not reported');
  assert.equal(records.length, 0);

  // A `rejected` ack is not a known window either: nothing to close later.
  tracker.observe([{ protocol: 1, channel: 'window', at: 'a', received: { received: 'rejected', windowId: 'nope', reason: 'E_LIMIT' } }]);
  assert.equal(tracker.status().known, 0, 'a rejected request is never "known open"');
  assert.equal(tracker.tick().closed, 0);

  // A second `opened` for an id already known is a REPLAY, not a new window: the
  // region refuses duplicates, so keeping the first correlation is the right answer
  // and it is what makes "one record per close" hold.
  tracker.observe([{ protocol: 1, channel: 'window', at: 'a', received: { received: 'opened', windowId: 'fresh' } }]);
  const before = tracker.status().known;
  tracker.observe([{ protocol: 1, channel: 'window', at: 'b', received: { received: 'opened', windowId: 'fresh' } }]);
  assert.equal(tracker.status().known, before, 'a replayed opened ack must not add a second entry');
});

test('the tracker degrades to available:false when the window class is not injected', () => {
  for (const electron of [undefined, {}, { window: null }, { window: 42 }, { window: {} }]) {
    const records = [];
    const tracker = createWindowTracker({ electron, append: (record) => records.push(record) });
    const status = tracker.status();
    assert.equal(status.available, false, 'no window class means no observer: ' + JSON.stringify(electron));
    assert.equal(typeof status.lastError, 'string');
    assert.equal(status.known, 0);
    // Nothing it does may throw: the tray polls it.
    assert.doesNotThrow(() => tracker.observe([{ channel: 'window', received: { received: 'opened', windowId: 'x' } }]));
    assert.doesNotThrow(() => tracker.tick());
    assert.equal(tracker.tick().closed, 0);
    assert.equal(records.length, 0, 'no window can be reported closed by a tracker that cannot see any');
  }
  // A provider whose `getAllWindows` THROWS is the same degradation, not a crash.
  const throwing = function WindowStub() {};
  throwing.getAllWindows = () => { throw new Error('native handle is gone'); };
  const tracker = createWindowTracker({ electron: { window: throwing }, append: () => {} });
  assert.equal(tracker.status().available, false);
  assert.match(tracker.status().lastError, /native handle is gone/);
  assert.equal(tracker.tick().closed, 0);
  // A provider that answers a non-array is refused rather than iterated.
  const wrong = function WindowStub() {};
  wrong.getAllWindows = () => ({ not: 'an array' });
  const wrongTracker = createWindowTracker({ electron: { window: wrong }, append: () => {} });
  assert.equal(wrongTracker.status().available, false);
  assert.equal(wrongTracker.tick().closed, 0);
});

test('an uncorrelated window still closes truthfully: named by the ACK, paired only when possible', () => {
  const live = [];
  const records = [];
  const tracker = createWindowTracker({
    electron: { window: fakeWindowClass(live) },
    append: (record) => records.push(record),
  });
  // The ACK arrives BEFORE the sample sees the window (the ack file is a poll behind,
  // the native array is instant): no fresh numeric id exists to pair with.
  tracker.observe([{ protocol: 1, channel: 'window', at: 'ack', received: { received: 'opened', windowId: 'late' } }]);
  assert.equal(tracker.status().known, 1);
  assert.equal(tracker.known()[0].nativeId, null, 'an unpairable ack is recorded as unpairable, not guessed');
  // Still nothing open anywhere: the honest reading is that it cannot be open.
  assert.equal(tracker.tick().closed, 1, 'an uncorrelated window is still reported once');
  assert.equal(records[0].id, 'late', 'and it is named by the ACK, which IS known');
  assert.equal(records[0].nativeId, null, 'the unknown half is null rather than a fabricated number');
  // A window appearing afterwards is not retroactively its owner.
  live.push(9);
  assert.equal(tracker.tick().closed, 0);
});

test('the close cadence is a shipped decision, and the channel describes its own latency', () => {
  assert.equal(WINDOW_POLL_EVERY, 4, 'WINDOW_POLL_EVERY is a shipped number, not a test knob');
  assert.notEqual(WINDOW_POLL_EVERY % 3, 0, 'the sample must not sit on the 3-tick notification read');
  assert.notEqual(WINDOW_POLL_EVERY, 5, 'and it must not sit on the 5-tick patch read either');
  const milliseconds = WINDOW_POLL_EVERY * 700;
  assert.equal(milliseconds >= 2000, true, 'at least one menu poll of latency is expected: ' + milliseconds);
  assert.equal(milliseconds <= 4000, true, 'and it stays under a few seconds: ' + milliseconds);

  // The published answer is DERIVED from the constant, so a slower sample cannot
  // keep claiming the old latency in a document.
  const channel = describeWindowChannel();
  assert.equal(channel.close.event, WINDOW_CLOSED_EVENT);
  assert.equal(channel.close.file, FILES.events);
  assert.equal(channel.close.pollEvery, WINDOW_POLL_EVERY);
  assert.equal(channel.close.latencyMs, WINDOW_POLL_EVERY * 700, 'the latency quoted is the cadence, not a wish');
  assert.equal(channel.close.observed, true);
  // The three absences are still NAMED (an absent field reads as "unlimited").
  for (const missing of ['session', 'protocol', 'declarativeWriter']) {
    assert.equal(channel.notImplemented.includes(missing), true,
      missing + ' must be reported as NOT implemented, not left to be discovered');
  }
  assert.equal(channel.notImplemented.includes('closeEvent'), false,
    'the close push EXISTS now: keeping it in `notImplemented` would be a lie');
  // The region's own decline codes are the ones a caller explains a rejection with,
  // and the write half quotes them as data.
  assert.equal(WINDOW_REGION_CODES.EDUPLICATE_ID, CHANNEL_DECLINE_CODES.EDUPLICATE_ID);
  assert.equal(WINDOW_REGION_CODES.ELIMIT, CHANNEL_DECLINE_CODES.ELIMIT);
  assert.equal(WINDOW_REGION_CODES.EPROVIDER_ABSENT, CHANNEL_DECLINE_CODES.EPROVIDER_ABSENT);
  assert.equal(WINDOW_REGION_CODES.ECONSTRUCT_FAILED, CHANNEL_DECLINE_CODES.ECONSTRUCT_FAILED);
  assert.equal(WINDOW_REGION_CODES.ELOAD_FAILED, CHANNEL_DECLINE_CODES.ELOAD_FAILED);
  assert.equal(WINDOW_REGION_CODES.EREGISTRY, CHANNEL_DECLINE_CODES.EREGISTRY);
  assert.equal(WINDOW_REGION_CODES.EDECLINED, CHANNEL_DECLINE_CODES.EINVALID_CHANNEL);
});

// ---------------------------------------------------------------------------
// 6. bridge.json: the bounded `windows` block, in the ONE key-order constant.
// ---------------------------------------------------------------------------

test('bridge.json ALWAYS carries the windows block, and its key order is the shared constant', () => {
  const dir = scratch();
  try {
    // The constant is the ONE definition of the order: this test never restates it.
    assert.equal(RENDER_RECORD_KEYS.includes('windows'), true,
      'the block must be added in RENDER_RECORD_KEYS, which is the single source of order');
    assert.equal(RENDER_RECORD_KEYS[RENDER_RECORD_KEYS.length - 1], 'windows',
      'a new block is APPENDED, so every shipped key keeps its position');
    assert.deepEqual(RENDER_RECORD_KEYS.slice(0, 9), [
      'version', 'rev', 'itemCount', 'reason', 'lastError', 'channel', 'notify', 'reload', 'renderedAt',
    ], 'the 0.4.0 order is untouched');

    // ALWAYS PRESENT, even with nothing observed: a support report must be able to
    // tell "no window observer" from "this build predates it".
    writeRenderRecord({
      stateDir: dir.stateDir,
      rev: 0,
      itemCount: 0,
      reason: 'empty',
      lastError: null,
      channel: null,
      notify: null,
      reload: null,
      patches: null,
      renderedAt: '2026-11-16T00:00:00.000Z',
    });
    const persisted = JSON.parse(readFileSync(dir.path(FILES.status), 'utf8'));
    assert.deepEqual(Object.keys(persisted), [...RENDER_RECORD_KEYS],
      'the writer walks the constant, so the file cannot disagree with it');
    assert.deepEqual(Object.keys(persisted.windows), [
      'available', 'known', 'max', 'closed', 'sampled', 'lastAt', 'lastError',
    ], 'the block shape is fixed, in this order');
    assert.equal(persisted.windows.available, false, 'no observer was handed in: the honest answer is false');
    assert.equal(persisted.windows.known, 0);
    assert.equal(persisted.windows.closed, 0);
    assert.equal(persisted.windows.lastAt, null);

    // The block is BOUNDED: a hostile extra long string is clipped, not copied.
    writeRenderRecord({
      stateDir: dir.stateDir,
      rev: 0,
      itemCount: 0,
      reason: 'ok',
      lastError: null,
      windows: { available: true, known: 2, max: 8, closed: 1, sampled: 5, lastAt: 'x'.repeat(400), lastError: 'y'.repeat(400) },
      renderedAt: '2026-11-16T00:00:01.000Z',
    });
    const bounded = JSON.parse(readFileSync(dir.path(FILES.status), 'utf8'));
    assert.equal(bounded.windows.known, 2);
    assert.equal(bounded.windows.max, 8);
    assert.equal(bounded.windows.closed, 1);
    assert.equal(bounded.windows.lastAt.length <= 40, true, 'the timestamp is clipped');
    assert.equal(bounded.windows.lastError.length <= 160, true, 'the failure text is clipped');
    // The live LIST is NOT persisted: a diagnostics file must not grow with windows.
    assert.equal('windows' in bounded.windows ? Array.isArray(bounded.windows.windows) : false, false,
      'bridge.json carries the counters only; the list lives in status()');
  } finally {
    dir.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. End to end through the REAL artefact, and the artefact's own composition.
// ---------------------------------------------------------------------------

test('the artefact reports the windows block and drains a close into events.jsonl', async () => {
  const dir = scratch();
  const live = [1];
  const artefact = loadArtefact();
  const tray = { setContextMenu() {}, setToolTip() {} };
  const bridge = artefact.createBridge({
    app: {},
    Tray: function TrayStub() {},
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: {},
    tray,
    options: { open() {}, quit() {}, locale: () => ({ messages: MESSAGES }) },
    stateDir: dir.stateDir,
    pollMs: 60_000,
    electron: { window: fakeWindowClass(live) },
  });
  try {
    // A window the region opened: its ACK is the only record of it in the Host's
    // world, and the native window exists BEFORE the ack is written (the region
    // constructs first, then appends the line), so the sample can pair them.
    live.push(2);
    dir.write(FILES.channelOut, JSON.stringify({
      protocol: 1,
      channel: 'window',
      at: 'ack-1',
      received: { received: 'opened', windowId: 'settings' },
    }) + '\n');
    bridge.relabel(MESSAGES);
    let status = bridge.status();
    assert.equal(Array.isArray(status.windows.windows), true, 'status() carries the LIVE list');
    assert.equal(status.windows.known, 1, 'the ack made the window known');
    assert.equal(status.windows.windows[0].id, 'settings');
    assert.equal(status.windows.max, MAX_WINDOW_SPECS, 'the block quotes the region\'s cap');
    assert.equal(status.windows.available, true);

    // The user closes it; the shell's own window array no longer has it.
    live.length = 0;
    bridge.relabel(MESSAGES);    status = bridge.status();
    assert.equal(status.windows.known, 0, 'the close removed it');
    assert.equal(status.windows.closed, 1, 'and it was counted');
    const events = readFileSync(dir.path(FILES.events), 'utf8').trim().split('\n');
    assert.equal(events.length, 1, 'exactly one record per close');
    assert.deepEqual(JSON.parse(events[0]), {
      protocol: 2,
      at: status.windows.lastAt,
      type: WINDOW_CLOSED_EVENT,
      id: 'settings',
      path: [],
    }, 'the record is the events.jsonl shape the Host already reads');

    // A further relabel must not repeat it.
    bridge.relabel(MESSAGES);
    assert.equal(readFileSync(dir.path(FILES.events), 'utf8').trim().split('\n').length, 1, 'no duplicate record');
    assert.equal(bridge.status().windows.closed, 1);

    // And the file a support report reads carries the counters.
    const persisted = JSON.parse(readFileSync(dir.path(FILES.status), 'utf8'));
    assert.equal(persisted.windows.closed, 1);
    assert.equal(persisted.windows.available, true);
    assert.equal('windows' in persisted.windows === false || persisted.windows.windows === undefined, true,
      'bridge.json keeps the counters, not the list');
  } finally {
    bridge.dispose();
    dir.cleanup();
  }
});

test('the artefact bundles windows.js and never names an Electron UI class', () => {
  const text = readFileSync(ARTEFACT_PATH, 'utf8');
  assert.equal(isAscii(text), true, 'the artefact stays pure ASCII');
  // The module really rides along now: it is the artefact that observes the close,
  // and `bridge-build.test.mjs` asserted the opposite while nothing consumed it.
  for (const needle of ['createWindowTracker', 'sampleWindows', 'window-closed', 'WINDOW_POLL_EVERY']) {
    assert.equal(text.includes(needle), true, 'the artefact must bundle ' + needle);
  }
  // The red lines hold: no class is named, so "the bridge does not own a window"
  // stays checkable by grep. The tracker receives the class, it never spells it.
  const code = stripComments(text);
  for (const forbidden of ['new Tray(', 'app.quit(', 'BrowserWindow', 'Notification', 'require("electron")']) {
    assert.equal(code.includes(forbidden), false, 'the artefact must not contain: ' + forbidden);
  }
  // And the live document describes the capability, with the close push counted.
  const artefact = loadArtefact();
  assert.equal(typeof artefact.createBridge, 'function');
});

test('describeWindowSpec and the write half agree about a whole document', () => {
  // The document validator is the file channel's half (`window.json`), which this
  // build does NOT ship a writer for. It must still agree with the ONE spec validator
  // the write half uses, or the next implementer inherits two answers.
  assert.equal(describeWindowSpec({ protocol: 1, owner: '@local/demo', windows: [{ id: 'a', route: '/x' }] }).ok, true);
  const refused = describeWindowSpec({ protocol: 1, windows: [{ id: 'a' }, { id: 'a' }] });
  assert.equal(refused.code, WINDOW_SPEC_CODES.EDUPLICATE_ID);
  // Per-spec, the document validator's answer IS validateWindowSpec's answer.
  for (const spec of [{ id: '' }, { id: 'w', width: 199 }, { id: 'w', route: 'https://x' }]) {
    const perDocument = describeWindowSpec({ protocol: 1, windows: [spec] });
    const perSpec = validateWindowSpec(spec, 'spec');
    assert.equal(perDocument.ok, perSpec.ok, JSON.stringify(spec));
    assert.equal(perDocument.code, perSpec.code, JSON.stringify(spec));
  }
});

// ---------------------------------------------------------------------------
// 8. The wiring surface: the object `ctx.provide('asarShell', {...})` spreads in,
//    driven against the REAL host service (`channelSend` and its stale-region guard
//    included) with only `channelSender` injected.
// ---------------------------------------------------------------------------

test('windowSurface wires into the REAL service: one message, a snapshot, a withdraw', async () => {
  const { createFrameworkService } = await import('../lib/host/service.js');
  const { createSetupState } = await import('../lib/host/state.js');
  const { windowSurface } = await import('../lib/host/window-registry.js');
  const dir = scratch();
  try {
    const sent = [];
    // The production shape: no install root configured, so `channelSend`'s stale-region
    // guard has no archive to judge and lets the message through (the documented
    // `installRoot === null => ALLOW` branch). Only the SENDER is injected — that is
    // the one thing a test cannot be (an IPC child of Electron).
    const service = createFrameworkService({
      state: createSetupState({ stateDir: dir.stateDir }),
      stateDir: dir.stateDir,
      channelSender: (message) => { sent.push(message); return Promise.resolve(); },
    });
    // THE SURFACE: exactly what `asarShell` spreads. Three methods, one send.
    const surface = windowSurface({
      stateDir: dir.stateDir,
      send: (message) => service.channelSend(message),
    });

    const opened = await surface.openWindow({ owner: '@local/demo', spec: { id: 'settings', route: '/settings', width: 900 } });
    assert.equal(opened.ok, true, opened.message ?? '');
    assert.equal(opened.state, 'sent');
    // The message a REAL `channelSend` produced: the reserved type, the channel name,
    // and the validator's allow-listed payload.
    assert.deepEqual(sent, [
      { type: 'dsh-asar-bridge', channel: 'window', payload: { id: 'settings', route: '/settings', width: 900 } },
    ], 'the Host speaks the one wire shape the region claims');

    // The refusal codes a real service can produce still travel unchanged.
    const refused = await surface.openWindow({ owner: '@local/demo', spec: { id: 'bad', width: 20 } });
    assert.equal(refused.code, WINDOW_SPEC_CODES.ERANGE);
    assert.equal(sent.length, 1, 'a refused spec never reaches `process.send`');

    // The snapshot sees the pending request, then the region's ack.
    let snapshot = surface.windows();
    assert.equal(snapshot.count, 1);
    assert.equal(snapshot.open[0].state, 'sent');
    dir.write(FILES.channelOut, JSON.stringify({
      protocol: 1,
      channel: 'window',
      at: 'ack-1',
      received: { received: 'opened', windowId: 'settings' },
    }) + '\n');
    snapshot = surface.windows();
    assert.equal(snapshot.open[0].state, WINDOW_ACKS.opened, 'the ack turns the entry into opened');
    assert.equal(snapshot.bridge, null, 'no bridge.json yet: the bridge block is null, not a guess');

    // And the withdraw takes it out of the Host's table without sending anything.
    const withdraw = surface.windowWithdraw({ owner: '@local/demo' });
    assert.equal(withdraw.ok, true);
    assert.equal(withdraw.removed, 1);
    assert.equal(surface.windows().count, 0);
    assert.equal(sent.length, 1, 'withdraw sends nothing: the window belongs to the main process');
  } finally {
    dir.cleanup();
  }
});

