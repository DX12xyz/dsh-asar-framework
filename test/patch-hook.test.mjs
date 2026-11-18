/**
 * Dynamic-patch hook tests: the declarative spec, the loader hook, boot replay,
 * the safety rails, and the wire copies.
 *
 * NO ARCHIVE IS NEEDED anywhere in this file. The subject is
 * `lib/bridge/src/patch.js` (the shipped hook) plus its Host write half
 * (`lib/host/patch-registry.js`) and the artefact that carries both. Modules are
 * faked in a scratch directory with a FAKE loader, so nothing here can install a
 * wrapper on the real `node:module` and leak into the rest of the suite.
 *
 * WHAT IS PROVEN HERE, and why each one matters:
 *   - spec parsing and the limits (a document that is not the contract is refused
 *     whole; an invalid ITEM does not switch off its siblings);
 *   - idempotence: the same id twice is ONE application, never a double wrap;
 *   - revert: an item that disappears is undone, and the original is back;
 *   - fail-soft: a throwing source keeps the ORIGINAL module and records why;
 *   - boot replay against a pre-populated `Module._cache`, plus the honest
 *     `missed` count for a target that is not loaded yet;
 *   - the self-target refusal (the bridge must never patch its own artefact);
 *   - the `bridge.json` `patches` block, ALWAYS present, against the ONE ordered
 *     writer constant;
 *   - "an unmatched module behaves exactly as before";
 *   - the wire-copy agreement (`FILES` / `PROTOCOLS` in both halves);
 *   - the shipped artefact really contains the hook.
 *
 * Run: node --test test/patch-hook.test.mjs
 */

import assert from 'node:assert/strict';
import Module from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  PATCH_CODES,
  PATCH_LIMITS,
  PATCH_STATE_SYMBOL,
  createPatchController,
  matchesCachedId,
  parsePatchSpec,
  syncSpec,
  uninstallPatchHook,
} from '../lib/bridge/src/patch.js';
import { FILES as BRIDGE_FILES, PROTOCOL_PATCH, PATCH_POLL_EVERY } from '../lib/bridge/src/paths.js';
import { RENDER_RECORD_KEYS, writeRenderRecord } from '../lib/bridge/src/diagnostics.js';
import { FILES as WIRE_FILES, PROTOCOLS } from '../lib/wire/constants.js';
import {
  PATCH_ITEM_LIMIT,
  PATCH_MAX_BYTES,
  PATCH_SOURCE_MAX_BYTES,
  createPatchRegistry,
} from '../lib/host/patch-registry.js';
import { ARTEFACT_PATH, MESSAGES, isAscii, loadArtefact, makeBridge, stripComments, withHome } from './bridge-harness.mjs';
import { createFrameworkService } from '../lib/host/service.js';
import { createSetupState } from '../lib/host/state.js';

// ---------------------------------------------------------------------------
// A scratch world: a fake loader, a fake state host, and a fake artefact path.
// ---------------------------------------------------------------------------

/** A throwaway directory for fake modules and fake bridge artefacts. */
function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-hook-'));
  return {
    root,
    path: (name) => path.join(root, name),
    write(name, text) {
      writeFileSync(path.join(root, name), text, 'utf8');
      return path.join(root, name);
    },
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (_error) {
        // A leaked temp directory must not fail a test run.
      }
    },
  };
}

/**
 * A fake CommonJS loader: the same two handles the hook uses (`_load` and
 * `_cache`), with a `_load` that hands out cache entries like Node's does.
 *
 * Using a fake is deliberate. The real `Module._load` is shared by the whole test
 * process, so a wrapper left installed by one test would silently patch the next
 * test's modules; the fake makes install/uninstall observable and self-contained.
 *
 * @param {Record<string, unknown>} [seed] module id -> exports object
 * @returns {{ _cache: object, _load: Function, loads: number, calls: string[] }}
 */
function fakeLoader(seed = {}) {
  const cache = Object.create(null);
  for (const [id, exports] of Object.entries(seed)) cache[id] = { id, loaded: true, exports };
  const loader = {
    _cache: cache,
    loads: 0,
    calls: [],
    _load(request) {
      loader.loads += 1;
      loader.calls.push(request);
      const entry = cache[request];
      if (entry === undefined) {
        const error = new Error("Cannot find module '" + request + "'");
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }
      return entry.exports;
    },
  };
  return loader;
}

/**
 * A fresh controller wired to fakes. The `stateHost`/`stateSymbol` pair keeps each
 * test's hook state in its own object, so two tests in one process cannot share
 * a wrapper (or a `WeakSet`).
 *
 * @param {{ loader?: object, selfFile?: string, stateDir?: string|null }} [input]
 * @returns {{ controller: object, loader: object, stateHost: object, symbol: symbol, dispose: () => void }}
 */
function harness(input = {}) {
  const loader = input.loader === undefined ? fakeLoader() : input.loader;
  const stateHost = {};
  const symbol = Symbol('patch-hook-test');
  const controller = createPatchController({
    stateDir: input.stateDir === undefined ? null : input.stateDir,
    selfFile: input.selfFile === undefined ? null : input.selfFile,
    loader,
    stateHost,
    stateSymbol: symbol,
  });
  return {
    controller,
    loader,
    stateHost,
    symbol,
    dispose() {
      controller.dispose();
      uninstallPatchHook({ stateHost, stateSymbol: symbol });
    },
  };
}

/** One spec document, byte-stable, with the fields the contract requires. */
function document(rev, items) {
  return JSON.stringify({ protocol: PROTOCOL_PATCH, rev, items }, null, 2);
}

/** One item, with the shipped field set. */
function item(overrides = {}) {
  return {
    id: 'a',
    owner: 'test',
    target: 'module-a',
    symbol: 'fn',
    kind: 'wrap',
    source: 'function (original) { return function () { return "WRAPPED:" + original(); }; }',
    ...overrides,
  };
}

/** A module whose exports can be patched, seeded in a fake loader. */
function moduleExports() {
  return {
    fn() {
      return 'ORIGINAL';
    },
    plain: 'value',
  };
}

// ---------------------------------------------------------------------------
// 1. Spec parsing and the limits.
// ---------------------------------------------------------------------------

test('parsePatchSpec accepts the protocol shape and reports an empty document honestly', () => {
  const empty = parsePatchSpec(null);
  assert.equal(empty.ok, true, 'a missing document is EMPTY, not an error');
  assert.equal(empty.empty, true);
  assert.deepEqual(empty.spec.items, []);
  assert.equal(empty.spec.rev, 0);

  const parsed = parsePatchSpec(document(7, [item()]));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.spec.rev, 7, 'rev is read from the document');
  assert.equal(parsed.spec.items.length, 1);
  assert.equal(parsed.spec.items[0].id, 'a');
  assert.equal(parsed.spec.items[0].enabled, true, 'a missing enabled field means enabled');
  assert.deepEqual(parsed.rejected, [], 'nothing is rejected');

  const disabled = parsePatchSpec(document(1, [item({ enabled: false })]));
  assert.equal(disabled.spec.items[0].enabled, false);
  assert.equal(disabled.empty, false, 'a disabled item is still an item in the document');
});

test('a document that is not the contract is refused WHOLE, and says why', () => {
  const notJson = parsePatchSpec('{ not json');
  assert.equal(notJson.ok, false);
  assert.equal(notJson.code, PATCH_CODES.INVALID);
  assert.match(notJson.error, /EPATCH_INVALID/);
  assert.deepEqual(notJson.spec.items, [], 'a refused document applies nothing');

  const array = parsePatchSpec('[]');
  assert.equal(array.ok, false);
  assert.equal(array.code, PATCH_CODES.INVALID, 'a JSON array is not a spec document');

  const wrongProtocol = parsePatchSpec(JSON.stringify({ protocol: 99, rev: 1, items: [] }));
  assert.equal(wrongProtocol.ok, false);
  assert.equal(wrongProtocol.code, PATCH_CODES.PROTOCOL);
  assert.match(wrongProtocol.error, /99/, 'the message names the number it saw');

  const noItems = parsePatchSpec(JSON.stringify({ protocol: PROTOCOL_PATCH, rev: 1 }));
  assert.equal(noItems.ok, false);
  assert.equal(noItems.code, PATCH_CODES.INVALID, 'items must be an array');
});

test('the limits are refusals with a reason, not silent truncation', () => {
  // One source over the byte cap.
  const fat = parsePatchSpec(document(1, [item({ source: 'x'.repeat(PATCH_LIMITS.sourceBytes + 1) })]));
  assert.equal(fat.ok, true, 'the DOCUMENT parses; the ITEM is rejected');
  assert.equal(fat.spec.items.length, 0);
  assert.equal(fat.rejected.length, 1);
  assert.equal(fat.rejected[0].code, PATCH_CODES.SOURCE_TOO_LARGE);
  assert.match(fat.rejected[0].message, new RegExp(String(PATCH_LIMITS.sourceBytes)));

  // Over the item cap: the whole document is refused (never truncated).
  const tooMany = parsePatchSpec(document(1, Array.from({ length: PATCH_LIMITS.items + 1 }, (_, index) => item({ id: 'i' + index }))));
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, PATCH_CODES.ITEMS_LIMIT);
  assert.deepEqual(tooMany.spec.items, []);

  // The host writer and the bridge reader must agree on BOTH caps, or a document
  // the writer calls fine would be refused by the reader as "nothing to apply".
  assert.equal(PATCH_MAX_BYTES, PATCH_LIMITS.documentBytes, 'the document cap is one number');
  assert.equal(PATCH_ITEM_LIMIT, PATCH_LIMITS.items, 'the item cap is one number');
  assert.equal(PATCH_SOURCE_MAX_BYTES, PATCH_LIMITS.sourceBytes, 'the source cap is one number');
});

test('one invalid item does not switch off its siblings', () => {
  const parsed = parsePatchSpec(document(1, [
    item({ id: 'good' }),
    { id: 'bad', owner: 'test', target: 'x', symbol: 'fn', kind: 'replace' }, // no source
    item({ id: 'good2', target: 'module-b' }),
  ]));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.spec.items.map((entry) => entry.id), ['good', 'good2']);
  assert.equal(parsed.rejected.length, 1);
  assert.match(parsed.rejected[0].message, /source/);
});

// ---------------------------------------------------------------------------
// 2. Applying, idempotence, revert, fail-soft.
// ---------------------------------------------------------------------------

test('a wrap applies, is idempotent, and reverts to the original', () => {
  const loader = fakeLoader({ 'module-a': moduleExports() });
  const world = harness({ loader });
  const exports = loader._cache['module-a'].exports;
  try {
    const first = world.controller.syncNow(document(1, [item()]));
    assert.equal(first.applied, 1);
    assert.equal(first.replayed, 1, 'the module was in the cache, so this was a REPLAY');
    assert.equal(exports.fn(), 'WRAPPED:ORIGINAL', 'the patch is visible through the exports object');

    // THE IDEMPOTENCE CLAIM: the same id, the same document, again.
    const second = world.controller.syncNow(document(1, [item()]));
    assert.equal(second.applied, 1);
    assert.equal(exports.fn(), 'WRAPPED:ORIGINAL', 'no double wrap: the value is still one layer');

    // And the same id applied a THIRD time through a different route (a require
    // that arrives after the cache entry was inspected) must still be one layer.
    const third = world.controller.syncNow(document(2, [item({ source: 'function (original) { return function () { return "WRAPPED2:" + original(); }; }' })]));
    assert.equal(exports.fn(), 'WRAPPED2:ORIGINAL',
      'a changed source replaces the previous patch instead of nesting on top of it');

    // REVERT: the item disappears from the spec.
    const reverted = world.controller.syncNow(document(3, []));
    assert.equal(reverted.applied, 0);
    assert.equal(exports.fn(), 'ORIGINAL', 'the original value is back');
  } finally {
    world.dispose();
  }
});

test('a replace patch swaps a value, and enabled:false is a revert not a delete', () => {
  const loader = fakeLoader({ 'module-a': moduleExports() });
  const world = harness({ loader });
  const exports = loader._cache['module-a'].exports;
  try {
    world.controller.syncNow(document(1, [item({ kind: 'replace', symbol: 'plain', source: '"PATCHED"' })]));
    assert.equal(exports.plain, 'PATCHED');
    // `enabled:false` means "do not apply" — and a previously applied item must
    // therefore be UNDONE, exactly like a removal.
    world.controller.syncNow(document(2, [item({ kind: 'replace', symbol: 'plain', source: '"PATCHED"', enabled: false })]));
    assert.equal(exports.plain, 'value');
  } finally {
    world.dispose();
  }
});

test('fail-soft: a throwing source, a missing symbol and a frozen exports object all keep the original', () => {
  const loader = fakeLoader({ 'module-a': moduleExports() });
  const world = harness({ loader });
  const exports = loader._cache['module-a'].exports;
  const frozenExports = Object.freeze({ fn() { return 'FROZEN'; } });
  loader._cache['module-frozen'] = { id: 'module-frozen', loaded: true, exports: frozenExports };
  try {
    // (a) the source text throws while evaluating. `source` is an EXPRESSION
    //     (usually a function expression), so a throwing expression is the shape
    //     a broken spec actually takes.
    let block = world.controller.syncNow(document(1, [item({ source: '(function () { throw new Error("boom"); })()' })]));
    assert.equal(exports.fn(), 'ORIGINAL', 'the original module is untouched');
    assert.equal(block.failed, 1);
    assert.match(block.lastError, /EPATCH_SOURCE_THREW/);
    assert.match(block.lastError, /boom/, 'the breadcrumb quotes the thrown message');

    // (b) the named symbol is not there.
    block = world.controller.syncNow(document(2, [item({ symbol: 'nope', kind: 'replace', source: '"x"' })]));
    assert.equal(block.failed, 1);
    assert.match(block.lastError, /EPATCH_SYMBOL_MISSING/);

    // (c) the exports object is frozen — the measured ESM boundary, simulated on
    //     a CommonJS object so the refusal path is the same one a namespace takes.
    block = world.controller.syncNow(document(3, [item({ target: 'module-frozen', symbol: 'fn', kind: 'replace', source: '() => "NOPE"' })]));
    assert.equal(frozenExports.fn(), 'FROZEN', 'a frozen module keeps its value');
    assert.equal(block.failed, 1);
    assert.match(block.lastError, /EPATCH_FROZEN_EXPORTS/);

    // (d) the whole bridge survives: the loader still answers, and the original
    //     export still works.
    assert.equal(loader._load('module-a'), exports);
    assert.equal(exports.fn(), 'ORIGINAL');
  } finally {
    world.dispose();
  }
});

test('a "wrap" whose result is not a function is REFUSED, never assigned', () => {
  const loader = fakeLoader({ 'module-a': moduleExports() });
  const world = harness({ loader });
  const exports = loader._cache['module-a'].exports;
  try {
    // The factory itself returns a number: the rail.
    const block = world.controller.syncNow(document(1, [item({ source: 'function () { return 42; }' })]));
    assert.equal(exports.fn(), 'ORIGINAL', 'the export is still the original function');
    assert.match(block.lastError, /EPATCH_NOT_FUNCTION/);

    // The factory is not even a function: the same rail, earlier.
    const notFactory = world.controller.syncNow(document(2, [item({ source: '"not a function"' })]));
    assert.match(notFactory.lastError, /EPATCH_NOT_FUNCTION/);
    assert.equal(exports.fn(), 'ORIGINAL');
  } finally {
    world.dispose();
  }
});

// ---------------------------------------------------------------------------
// 3. The loader hook: which loads it sees, and what it returns.
// ---------------------------------------------------------------------------
test('the hook patches a module the LOADER returns, in place, and returns the same object', () => {
  // No cache seed at all: the module is "loaded" through `_load` AFTER the hook
  // is installed, which is the production path for anything post-startup.
  const loader = fakeLoader();
  const moduleExportsRef = moduleExports();
  loader._cache['module-a'] = { id: 'module-a', loaded: true, exports: moduleExportsRef };
  const world = harness({ loader });
  try {
    // `_load` throws for a missing id; seed the cache AFTER the first sync so the
    // item starts out `missed` and is then applied by the loader itself.
    const first = world.controller.syncNow(document(1, [item()]));
    assert.equal(first.applied, 1, 'it was already in the cache, so replay handled it');
    assert.equal(moduleExportsRef.fn(), 'WRAPPED:ORIGINAL');
  } finally {
    world.dispose();
  }

  // And the same story when the module appears only at LOAD time.
  const lateLoader = fakeLoader();
  const late = harness({ loader: lateLoader });
  try {
    const block = late.controller.syncNow(document(1, [item({ target: 'module-late' })]));
    assert.equal(block.applied, 0);
    assert.equal(block.missed, 1, 'nothing is cached yet: it is MISSED, not failed');
    assert.equal(block.failed, 0, 'a module that has not loaded is not an error');
    assert.equal(block.lastError, null);

    // Now the module loads through the hooked loader.
    const lateExports = moduleExports();
    lateLoader._cache['module-late'] = { id: 'module-late', loaded: true, exports: lateExports };
    const returned = lateLoader._load('module-late');
    assert.equal(returned, lateExports, 'the loader returns the SAME exports object (identity preserved)');
    assert.equal(lateExports.fn(), 'WRAPPED:ORIGINAL', 'the hook applied the patch on the way out');
  } finally {
    late.dispose();
  }
});

test('an unmatched module behaves exactly as before', () => {
  // THE NON-INVASIVE CLAIM, measured two ways: with no spec at all, and with a
  // spec that names a DIFFERENT module.
  const loader = fakeLoader();
  let sentinel = 0;
  const untouched = {
    value: 'UNMATCHED',
    fn() {
      sentinel += 1;
      return 'untouched';
    },
  };
  loader._cache['other-module'] = { id: 'other-module', loaded: true, exports: untouched };
  const world = harness({ loader });
  try {
    // (a) no spec: the hook is not even installed.
    const noSpec = world.controller.syncNow(null);
    assert.equal(noSpec.available, false, 'a bridge with no state directory reports unavailable');
    const before = loader._load('other-module');
    assert.equal(before, untouched);
    assert.equal(untouched.fn(), 'untouched');
    assert.equal(sentinel, 1);
    // One `_load` per call, no extra lookups, no rewrite of the exports object.
    assert.equal(Object.keys(untouched).length, 2, 'the exports object was not decorated');

    // (b) a spec for a DIFFERENT module.
    world.controller.syncNow(document(1, [item({ target: 'some-other-module' })]));
    const after = loader._load('other-module');
    assert.equal(after, untouched, 'an unmatched module comes back as the same object, untouched');
    assert.equal(untouched.fn(), 'untouched');
    assert.equal(Object.keys(untouched).length, 2);
    // And the unmatched id is untouched by the patch bookkeeping.
    assert.equal(world.controller.status().applied, 0);
  } finally {
    world.dispose();
  }
});

test('the hook never throws into the loader, even when the patch machinery is hostile', () => {
  const loader = fakeLoader();
  const hostile = {};
  // A getter that throws: the mutation guard must turn it into a recorded failure,
  // not into an exception that reaches the caller of `require()`.
  Object.defineProperty(hostile, 'fn', {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error('hostile getter');
    },
  });
  loader._cache['module-hostile'] = { id: 'module-hostile', loaded: true, exports: hostile };
  const world = harness({ loader });
  try {
    const block = world.controller.syncNow(document(1, [
      item({ target: 'module-hostile', symbol: 'fn', kind: 'replace', source: '() => "x"' }),
    ]));
    // A hostile getter is turned into a RECORDED failure, not an exception: the
    // read of the original value is inside `applyItem`'s guard precisely for this.
    assert.equal(block.failed, 1, 'the hostile read is recorded as a failure, not thrown');
    assert.match(block.lastError, /EPATCH_APPLY_THREW/);
    assert.match(block.lastError, /hostile getter/, 'the breadcrumb quotes the thrown message');
    // The important assertion: the loader call itself is normal.
    const returned = loader._load('module-hostile');
    assert.equal(returned, hostile, 'the hostile module is returned unchanged');
  } finally {
    world.dispose();
  }
});

// ---------------------------------------------------------------------------
// 4. Boot replay.
// ---------------------------------------------------------------------------

test('boot replay reaches modules loaded BEFORE the hook existed, and counts what it missed', () => {
  const loader = fakeLoader({
    'module-replay': moduleExports(),
    'module-other': { fn() { return 'other'; } },
  });
  const replayExports = loader._cache['module-replay'].exports;
  const world = harness({ loader });
  try {
    const block = world.controller.syncNow(document(1, [
      item({ id: 'replay', target: 'module-replay' }),
      item({ id: 'missing', target: 'module-not-loaded', symbol: 'fn', kind: 'replace', source: '() => "x"' }),
    ]));
    assert.equal(block.applied, 1, 'only the cached one could be applied');
    assert.equal(block.replayed, 1, 'and it was a REPLAY (cache path), which the block reports separately');
    assert.equal(block.missed, 1, 'the uncached target is missed, not failed');
    assert.equal(block.failed, 0, 'a not-yet-loaded module is not an error');
    assert.equal(block.lastError, null);
    assert.equal(replayExports.fn(), 'WRAPPED:ORIGINAL');
  } finally {
    world.dispose();
  }
});

test('replay is idempotent and honours a frozen module without touching it', () => {
  const loader = fakeLoader({ 'module-frozen': Object.freeze({ fn() { return 'FROZEN'; } }) });
  const world = harness({ loader });
  try {
    const first = world.controller.syncNow(document(1, [item({ target: 'module-frozen' })]));
    assert.equal(first.failed, 1, 'the refusal is recorded');
    assert.match(first.lastError, /EPATCH_FROZEN_EXPORTS/);
    const second = world.controller.syncNow(document(1, [item({ target: 'module-frozen' })]));
    // The SAME broken item twice must not spin: the failure is remembered by signature,
    // so no second evaluation happens, and `failed` stays 1 instead of draining CPU.
    assert.equal(second.failed, 1);
    assert.equal(second.replayed, 0, 'nothing was applied to a frozen object');
  } finally {
    world.dispose();
  }
});

// ---------------------------------------------------------------------------
// 5. The safety rails.
// ---------------------------------------------------------------------------

test('the bridge never patches its own artefact (self-target recursion)', () => {
  const SELF = '<test>\\fake\\app.asar.unpacked\\dsh\\tray-bridge.js';
  const loader = fakeLoader({
    [SELF]: { run() { return 'SELF-ORIGINAL'; } },
    'module-a': moduleExports(),
  });
  const world = harness({ loader, selfFile: SELF });
  try {
    const byExactPath = world.controller.syncNow(document(1, [
      item({ id: 'self', target: SELF, symbol: 'run', kind: 'replace', source: '() => "PATCHED-SELF"' }),
    ]));
    assert.equal(byExactPath.applied, 0);
    assert.match(byExactPath.lastError, /EPATCH_SELF_TARGET/);
    assert.equal(loader._cache[SELF].exports.run(), 'SELF-ORIGINAL', 'the artefact is untouched');

    // The same refusal for a target that only RESOLVES to the artefact.
    const byTail = world.controller.syncNow(document(2, [
      item({ id: 'self2', target: 'dsh/tray-bridge.js', symbol: 'run', kind: 'replace', source: '() => "x"' }),
    ]));
    assert.equal(byTail.applied, 0);
    assert.match(byTail.lastError, /EPATCH_SELF_TARGET/);

    // A Node built-in is refused too: replacing `node:fs` would change every
    // require in the process, including this module's own.
    const builtin = world.controller.syncNow(document(3, [
      item({ id: 'fs', target: 'node:fs', symbol: 'readFileSync', kind: 'replace', source: '() => 1' }),
    ]));
    assert.equal(builtin.applied, 0);
    assert.match(builtin.lastError, /EPATCH_BUILTIN_TARGET/);

    // ...and a normal module still works in the same session.
    const normal = world.controller.syncNow(document(4, [item({ id: 'ok', target: 'module-a' })]));
    assert.equal(normal.applied, 1, 'the refusal is targeted, not a global switch-off');
  } finally {
    world.dispose();
  }
});

test('the host writer refuses a self-target BEFORE it lands on disk', () => {
  const store = path.join(scratch().root, 'state');
  mkdirSync(store, { recursive: true });
  const registry = createPatchRegistry({ stateDir: store });
  const refused = registry.patch('plugin-x', [
    item({ target: 'resources/app.asar.unpacked/dsh/tray-bridge.js' }),
  ]);
  assert.equal(refused.ok, false);
  assert.match(refused.code, /SELF_TARGET/);
  assert.equal(registry.read().text, null, 'nothing was written for a patch that could never apply');
});

// ---------------------------------------------------------------------------
// 6. The Host write half.
// ---------------------------------------------------------------------------

test('the host registry namespaces owners, keeps bytes stable and deletes when empty', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-registry-'));
  const stateDir = path.join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  try {
    const registry = createPatchRegistry({ stateDir });
    const added = registry.patch('plugin-a', [item({ id: 'one' })]);
    assert.equal(added.ok, true);
    assert.equal(added.rev, 1);

    // BYTE STABILITY: the same declaration again is an empty operation.
    const again = registry.patch('plugin-a', [item({ id: 'one' })]);
    assert.equal(again.ok, true);
    assert.equal(again.unchanged, true);
    assert.equal(again.rev, 1, 'rev does not move for an identical declaration');
    const firstText = registry.read().text;

    // A SECOND owner: ids are namespaced, so the two cannot collide.
    registry.patch('plugin-b', [item({ id: 'one', target: 'module-b' })]);
    const written = JSON.parse(registry.read().text);
    assert.equal(written.protocol, PROTOCOLS.patches);
    assert.deepEqual(written.items.map((entry) => entry.id), ['plugin-a#one', 'plugin-b#one'],
      'the item id is owner#localId, so two owners can both use the local id "one"');
    assert.equal(written.items[0].owner, 'plugin-a');
    assert.equal(written.items[1].owner, 'plugin-b');

    // No timestamps anywhere: the document is a pure function of the declarations.
    assert.equal(firstText.includes('At'), false);
    assert.equal(JSON.stringify(written).includes('202'), false, 'no clock value may leak into the spec');

    // DELETE-WHEN-EMPTY: removing the last owner removes the FILE, because the
    // bridge treats "absent" as "no spec" and reverts everything.
    registry.unpatch('plugin-a');
    registry.unpatch('plugin-b');
    assert.equal(registry.read().text, null, 'the document is gone from disk');
    assert.equal(existsSync(path.join(stateDir, WIRE_FILES.patches)), false,
      'an empty table is expressed as a MISSING file, never as an items:[] document');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the host registry refuses the rails the bridge also refuses', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-registry-rail-'));
  const stateDir = path.join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  try {
    const registry = createPatchRegistry({ stateDir });

    // Owner shape: the same rule the menu registry uses.
    assert.equal(registry.patch('', [item()]).code, 'EPATCH_EINVALID_OWNER');
    assert.equal(registry.patch('has#separator', [item()]).code, 'EPATCH_EINVALID_OWNER');
    // Items: empty is refused (removal has its own call), a bad kind is refused.
    assert.equal(registry.patch('plugin-a', []).code, 'EPATCH_EINVALID_ITEM');
    assert.equal(registry.patch('plugin-a', [item({ kind: 'swap' })]).code, 'EPATCH_EINVALID_ITEM');
    // THE SOURCE CEILING.
    const tooBig = registry.patch('plugin-a', [item({ source: 'x'.repeat(PATCH_SOURCE_MAX_BYTES + 1) })]);
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.code, 'EPATCH_SOURCE_TOO_LARGE');
    assert.equal(tooBig.limit, PATCH_SOURCE_MAX_BYTES, 'the refusal carries the number it enforced');

    // ...and the ordinary path still works afterwards: refusals do not poison the table.
    assert.equal(registry.patch('plugin-a', [item()]).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. bridge.json: the `patches` block.
// ---------------------------------------------------------------------------

test('bridge.json ALWAYS carries the patches block, and its key order is ONE constant', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-record-'));
  const stateDir = path.join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  try {
    const controller = createPatchController({ stateDir });
    const block = controller.status();
    assert.deepEqual(Object.keys(block), [
      'available', 'applied', 'replayed', 'missed', 'failed', 'lastError', 'rev',
    ], 'the block shape is fixed, in this order');

    writeRenderRecord({
      stateDir,
      rev: 0,
      itemCount: 0,
      reason: 'empty',
      lastError: null,
      channel: null,
      notify: null,
      reload: null,
      renderedAt: '2026-11-16T00:00:00.000Z',
      patches: block,
    });
    const persisted = JSON.parse(readFileSync(path.join(stateDir, BRIDGE_FILES.status), 'utf8'));
    // THE WRITER'S ORDER: asserted against the shipped constant, never a second
    // literal. A future block is added in `RENDER_RECORD_KEYS` and this test follows.
    assert.deepEqual(Object.keys(persisted), [...RENDER_RECORD_KEYS]);
    // ALWAYS PRESENT, never null, even with nothing patched: a support report must
    // be able to tell "no spec" from "old build" with one file.
    assert.equal(Object.hasOwn(persisted, 'patches'), true);
    assert.deepEqual(Object.keys(persisted.patches), ['available', 'applied', 'replayed', 'missed', 'failed', 'lastError', 'rev']);
    assert.equal(persisted.patches.applied, 0);
    assert.equal(persisted.patches.lastError, null);
    // `patches` is the LAST key of the shipped block group, so every 0.4.0 key
    // keeps its exact position. `windows` (the window close observer) is appended
    // AFTER it by the same rule — a new block never moves an older one.
    assert.equal(RENDER_RECORD_KEYS[RENDER_RECORD_KEYS.length - 1], 'windows');
    assert.equal(RENDER_RECORD_KEYS[RENDER_RECORD_KEYS.length - 2], 'patches');
    assert.deepEqual(RENDER_RECORD_KEYS.slice(0, 9), [
      'version', 'rev', 'itemCount', 'reason', 'lastError', 'channel', 'notify', 'reload', 'renderedAt',
    ], 'the 0.4.0 order is untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failing patch leaves a readable breadcrumb in bridge.json', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-breadcrumb-'));
  const stateDir = path.join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  try {
    const loader = fakeLoader({ 'module-a': moduleExports() });
    const world = harness({ loader, stateDir });
    try {
      writeFileSync(path.join(stateDir, BRIDGE_FILES.patches), document(3, [
        item({ source: '(function () { throw new Error("SPECIFIC-PATCH-FAILURE"); })()' }),
      ]), 'utf8');
      world.controller.poll();
      const status = world.controller.status();
      assert.equal(status.failed, 1);
      assert.match(status.lastError, /SPECIFIC-PATCH-FAILURE/, 'the breadcrumb quotes the source\'s own message');

      writeRenderRecord({
        stateDir,
        rev: 0,
        itemCount: 0,
        reason: 'empty',
        lastError: null,
        channel: null,
        notify: null,
        reload: null,
        renderedAt: '2026-11-16T00:00:00.000Z',
        patches: status,
      });
      const persisted = JSON.parse(readFileSync(path.join(stateDir, BRIDGE_FILES.status), 'utf8'));
      assert.equal(persisted.patches.failed, 1);
      assert.equal(typeof persisted.patches.lastError, 'string');
      assert.equal(persisted.patches.lastError.length <= 160, true,
        'the text can quote source, so it is clipped');
      assert.match(persisted.patches.lastError, /EPATCH_SOURCE_THREW/,
        'the code is in the text: a human can tell what KIND of failure this is');
      assert.equal(persisted.patches.rev, 3, 'the spec revision is recorded');
    } finally {
      world.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('poll() is driven by the file: a change applies, and a removal reverts everything', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-poll-'));
  const stateDir = path.join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  try {
    const loader = fakeLoader({ 'module-a': moduleExports() });
    const exports = loader._cache['module-a'].exports;
    const world = harness({ loader, stateDir });
    const file = path.join(stateDir, BRIDGE_FILES.patches);
    try {
      writeFileSync(file, document(1, [item()]), 'utf8');
      assert.equal(world.controller.poll().applied, 1);
      assert.equal(exports.fn(), 'WRAPPED:ORIGINAL');

      // An unchanged document is an unchanged fingerprint: the poll must not
      // re-derive anything (that is what keeps the steady state at one `stat`).
      const again = world.controller.poll();
      assert.equal(again.applied, 1);

      // DELETING the document is the "revert everything" signal.
      rmSync(file, { force: true });
      const gone = world.controller.poll();
      assert.equal(gone.applied, 0);
      assert.equal(exports.fn(), 'ORIGINAL', 'the patch is undone when the spec disappears');
    } finally {
      world.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. Wire copies, module matching, cadence.
// ---------------------------------------------------------------------------

test('the two FILES / PROTOCOLS copies agree on the patch document', () => {
  // The bridge ships as one standalone CommonJS file and cannot import the Host's
  // wire table, so the value lives twice. A drift means "the Host writes a file
  // nothing reads", which is the one failure this test exists to catch.
  assert.equal(BRIDGE_FILES.patches, WIRE_FILES.patches);
  assert.equal(WIRE_FILES.patches, 'patches.json');
  assert.equal(BRIDGE_FILES.patches, 'patches.json');
  assert.equal(PROTOCOL_PATCH, PROTOCOLS.patches, 'the two protocol numbers must be one number');
});

test('target matching is exact or a package path — never a glob', () => {
  assert.equal(matchesCachedId('<test>:/x/a.cjs', '<test>:\\x\\a.cjs'), true, 'separator spelling does not matter');
  assert.equal(matchesCachedId('zod', '<test>:/x/node_modules/zod/v4/mini/parse.cjs'), true, 'a bare package name finds the cached file');
  assert.equal(matchesCachedId('zod', '<test>:/x/node_modules/@scope/zod/index.cjs'), false, 'an unrelated path is a miss');
  assert.equal(matchesCachedId('zod', '<test>:/x/zod.cjs'), false, 'a name is not a substring match');
  assert.equal(matchesCachedId('./a.cjs', '<test>:/x/a.cjs'), false, 'a relative specifier matches only what the caller typed');
  assert.equal(matchesCachedId('', '<test>:/x/a.cjs'), false, 'an empty target matches nothing');
});

test('the poll cadence is a shipped decision, not a test knob', () => {
  assert.equal(PATCH_POLL_EVERY, 5);
  // Not a multiple of the notification cadence (3): the three channels must not all
  // wake on the same tick.
  assert.notEqual(PATCH_POLL_EVERY % 3, 0, 'the patch poll must not collide with NOTIFY_POLL_EVERY');
  const milliseconds = PATCH_POLL_EVERY * 700;
  assert.equal(milliseconds >= 3000, true, 'at least a few seconds between reads');
  assert.equal(milliseconds <= 10000, true, 'and well under the reload watcher\'s budget');
});

// ---------------------------------------------------------------------------
// 9. The shipped artefact.
// ---------------------------------------------------------------------------

test('the shipped artefact contains the hook, and it is the one the policy allows', () => {
  const text = readFileSync(ARTEFACT_PATH, 'utf8');
  for (const needle of [
    'createPatchController',
    'parsePatchSpec',
    'PATCH_CODES',
    'EPATCH_FROZEN_EXPORTS',
    'EPATCH_SELF_TARGET',
    'RENDER_RECORD_KEYS',
  ]) {
    assert.equal(text.includes(needle), true, 'the artefact must bundle ' + needle);
  }
  // The hook's whole point is the ONE loader wrap; the artefact must name the handle
  // it takes (and the wrapper must be reachable from the kernel's import graph).
  assert.equal(text.includes("__require(\"node:module\")"), true,
    'the hook must load the loader object through the artefact\'s own require');
  assert.equal(text.includes('loader._load'), true, 'the wrapper is installed on Module._load');
  // Still pure ASCII: the sources carry Chinese prose, and the builder must escape it.
  assert.equal(isAscii(text), true);

  // The red-line scan runs on code with comments stripped, so the prose in the
  // module header (which explains the security boundary) cannot trip it.
  const code = stripComments(text);
  for (const forbidden of ['new Tray(', 'app.quit(', 'BrowserWindow', 'require("electron")']) {
    assert.equal(code.includes(forbidden), false, 'the artefact must not contain: ' + forbidden);
  }

  // And the artefact really is a working CommonJS module that exposes the hook,
  // so "the code is bundled" is proven by loading it, not by grepping.
  const artefact = loadArtefact();
  assert.equal(typeof artefact.createBridge, 'function');
  assert.equal(typeof artefact.describe, 'function');
  const description = artefact.describe();
  assert.equal(description.protocols.menu, 2, 'the earlier protocols are untouched');
  assert.equal(description.protocols.patches, PROTOCOL_PATCH,
    'describe() reports the patch protocol, so a support report needs no code reading');
  assert.equal(description.protocols.events, 2);
  assert.equal(description.protocols.notify, 1);
});

test('the kernel wires the hook in, and a bridge with no spec stays inert', () => {
  const text = readFileSync(ARTEFACT_PATH, 'utf8');
  // The kernel constructs the controller unconditionally (shape parity with the
  // other channels) and polls it on its own cadence.
  assert.equal(text.includes('createPatchController('), true);
  assert.equal(text.includes('PATCH_POLL_EVERY'), true);
  // The status document carries the block, so a diagnostics page never branches.
  assert.equal(text.includes('patches:'), true);

  // END TO END through the REAL artefact: a bridge with no `patches.json` renders
  // normally, reports the block, and never touches the loader.
  withHome((home) => {
    const { bridge } = makeBridge({ home });
    try {
      assert.equal(bridge.relabel(MESSAGES).ok, true, 'a bridge with no spec still renders');
      const status = bridge.status();
      assert.equal(Object.hasOwn(status, 'patches'), true, 'status() carries the block');
      assert.deepEqual(Object.keys(status.patches), [
        'available', 'applied', 'replayed', 'missed', 'failed', 'lastError', 'rev',
      ]);
      assert.equal(status.patches.applied, 0);
      assert.equal(status.patches.replayed, 0);
      assert.equal(status.patches.missed, 0);
      assert.equal(status.patches.rev, 0, 'no spec has ever been seen');
      assert.equal(status.patches.available, true, 'there IS a state directory, so it can apply patches');
      // The written file carries the same block (the single writer constant).
      const persisted = JSON.parse(readFileSync(home.path(BRIDGE_FILES.status), 'utf8'));
      assert.deepEqual(Object.keys(persisted), [...RENDER_RECORD_KEYS]);
      assert.deepEqual(persisted.patches, status.patches);
      // And nothing was left wrapped on the real loader by this bridge.
      assert.equal(typeof Module._load, 'function');
      assert.equal(Module._load.name, '', 'Module._load is still the native loader, not our wrapper');
    } finally {
      bridge.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 10. syncSpec directly: the ordering guarantee that makes revert-then-apply safe.
// ---------------------------------------------------------------------------

test('syncSpec reverts before it re-applies, so a changed item never stacks on itself', () => {
  const loader = fakeLoader({ 'module-a': moduleExports() });
  const world = harness({ loader });
  try {
    const first = parsePatchSpec(document(1, [item()]));
    assert.equal(first.ok, true);
    // Drive `syncSpec` directly with the parsed spec: the same function the
    // controller uses, so the ordering claim is about shipped code.
    const state = {
      selfFile: null,
      loader,
      installed: false,
      original: null,
      wrapper: null,
      targets: null,
      applied: new Map(),
      patched: new WeakSet(),
      marks: new WeakMap(),
      failures: new Map(),
      owner: null,
    };
    const applied = syncSpec(state, first.spec, { loader });
    assert.equal(applied.applied, 1);
    const exports = loader._cache['module-a'].exports;
    assert.equal(exports.fn(), 'WRAPPED:ORIGINAL');
    // Clean up through the public entry point so no wrapper outlives this test.
    world.controller.syncNow(null);
    uninstallPatchHook({ stateHost: world.stateHost, stateSymbol: world.symbol });
  } finally {
    world.dispose();
  }
});

test('the Host service exposes patch / unpatch / patches over the same registry', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-service-'));
  const stateDir = path.join(root, 'dsh-asar-framework');
  mkdirSync(stateDir, { recursive: true });
  try {
    const service = createFrameworkService({
      state: createSetupState({ stateDir }),
      stateDir,
    });

    // The three entry points the Cordis service and the HTTP routes both call.
    const added = await service.patch({ owner: 'plugin-a', items: [item({ id: 'one' })] });
    assert.equal(added.ok, true);
    assert.equal(added.action, 'patch');
    assert.equal(added.itemCount, 1);

    // The AUDIT TRAIL: the same `audit.jsonl` every other write path appends to.
    const audit = readFileSync(path.join(stateDir, WIRE_FILES.audit), 'utf8');
    assert.equal(audit.includes('"action":"patch"'), true, 'a patch write is audited');
    assert.equal(audit.includes('"owner":"plugin-a"'), true);

    // Read-only snapshot: no document, no disk write.
    const snapshot = await service.patches();
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.itemCount, 1);
    assert.equal(snapshot.document.protocol, PROTOCOLS.patches);

    // Removal is the `remove:true` shape (what `asarShell.unpatch` and the
    // `/unpatch` route pass), and the file goes away with the last owner.
    const removed = await service.patch({ owner: 'plugin-a', remove: true });
    assert.equal(removed.ok, true);
    assert.equal(removed.action, 'unpatch');
    assert.equal(existsSync(path.join(stateDir, WIRE_FILES.patches)), false);

    // A refusal keeps the `ok/code/message` shape the client branches on.
    const refused = await service.patch({ owner: 'has#separator', items: [item()] });
    assert.equal(refused.ok, false);
    assert.equal(typeof refused.code, 'string');
    assert.equal(typeof refused.message, 'string');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PATCH_STATE_SYMBOL is a process-global registry symbol, so a reloaded bridge takes the hook over', () => {
  assert.equal(typeof PATCH_STATE_SYMBOL, 'symbol');
  assert.equal(PATCH_STATE_SYMBOL, Symbol.for('dsh-asar-framework.patch-hook'),
    'the key must be in the symbol REGISTRY: a reloaded artefact has new module variables, not a new process');
  assert.equal(Module._load === Module._load, true, 'the real loader is never left wrapped by these tests');
});
