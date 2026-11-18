/**
 * Bridge hot reload, the SHIPPED design: the artefact reloads ITSELF.
 *
 * WHY THIS FILE NO LONGER TESTS THE REGION
 * The previous attempt proved, by measurement, that the in-region version cannot
 * ship: the correct block costs 510 B against an allowance of 53 B
 * (`REGION_RESERVE_BYTES` 16,384 − `SPLIT_MINIMUM_REGION_LENGTH` 15,331 − the
 * suite's 1,000 B floor). That verdict is kept as a GUARD here (see "the region
 * stays byte-identical" below), but the mechanism moved to the one place that
 * costs zero region bytes: `lib/bridge/src/main.js` is a facade that watches
 * `__filename` and re-requires the artefact, and `lib/bridge/src/kernel.js` is
 * the implementation it swaps. The injected region keeps calling exactly the
 * same `createBridge(...)` / `relabel(...)` it always called, unchanged.
 *
 * So the design under test is:
 *
 *   fake artefact (scratch dir, no archive)
 *     -> createBridge({ ...env, artefactPath, reloadMs, reloadEvery })   facade
 *          -> watches `artefactPath`, one `statSync` per `reloadEvery` ticks
 *          -> on a changed `size:mtime` tag: delete require.cache, re-require,
 *             build the NEW module's implementation, dispose the old one
 *          -> on failure: keep the old one, remember the failed tag, record why
 *
 * Everything below runs against fake artefacts in `scratch/test-copies/`, never
 * against `<DSH安装目录>\resources\app.asar`.
 *
 * Run: node --test --test-isolation=none test/bridge-hot-reload.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARTEFACT_PATH, MESSAGES, fakeOptions, fakeTray, loadArtefact, makeBridge, withHome,
} from './bridge-harness.mjs';
import { buildSplitRegion, SPLIT_BODY, SPLIT_BODY_BYTES, SPLIT_MINIMUM_REGION_LENGTH } from '../lib/asar/patch-body.js';
import { REGION_RESERVE_BYTES } from '../lib/wire/constants.js';
import {
  RELOAD_MAX_ATTEMPTS, RELOAD_POLL_EVERY, artefactTag, bridgeArtefactChanged,
} from '../lib/bridge/src/paths.js';

/** The scratch root the other write-path tests share. */
const SCRATCH = fileURLToPath(new URL('../../scratch/test-copies/', import.meta.url));

/** This file's own working directory: every fake artefact lives here. */
const WORK_DIR = join(SCRATCH, `hot-bridge-${process.pid}`);

/** The floor `test/split-surgery.test.mjs` asserts the reserve keeps. */
const SPARE_FLOOR = 1000;

/** The sha256 the shipped region MUST keep producing (0.2.0 geometry). */
const REGION_SHA = '36eaf6b4e5e3e39e83044195101d8830275426212a899ff4bca3653e02cb6925';

/** The require the test uses to look at `require.cache` from the outside. */
const require_ = createRequire(import.meta.url);

after(() => {
  rmSync(WORK_DIR, { recursive: true, force: true });
});

/**
 * A fake unpacked install: `<root>/app.asar.unpacked/dsh/tray-bridge.js`, CJS.
 *
 * The real tree is CommonJS (the app's `package.json` lives inside the asar, so
 * nothing beside the artefact declares a module type), hence the `package.json`
 * pin: a reload that resolved the file as ESM would be testing a design that
 * cannot happen.
 *
 * @param {string} name
 * @returns {{ root: string, file: string, stateDir: string }}
 */
function fakeInstall(name) {
  const root = join(WORK_DIR, name);
  const unpacked = join(root, 'app.asar.unpacked', 'dsh');
  const stateDir = join(root, 'state');
  mkdirSync(unpacked, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(unpacked, 'package.json'), '{"type":"commonjs"}', 'utf8');
  return { root, file: join(unpacked, 'tray-bridge.js'), stateDir };
}

/**
 * A minimal but SHAPE-FAITHFUL fake artefact.
 *
 * It has to look like the real kernel enough for the facade's delegation and
 * diagnostics to be meaningful: `relabel()` returns the marker (so "which
 * implementation is serving" is observable from outside), `status()` carries the
 * fields `writeRenderRecord` reads (so a reload record really reaches
 * `bridge.json`), and `dispose()` increments a counter (so disposal is observable).
 *
 * @param {string} marker the implementation's identity
 * @returns {string} module text
 */
function minimalArtefact(marker) {
  const id = JSON.stringify(marker);
  return [
    'function createImplementation(input) {',
    '  const env = input === null || typeof input !== "object" ? {} : input;',
    '  globalThis.__hotConstructed = (globalThis.__hotConstructed || 0) + 1;',
    '  return {',
    '    marker: ' + id + ',',
    '    relabel() { return { ok: true, marker: ' + id + ' }; },',
    '    dispose() { globalThis.__hotDispose = (globalThis.__hotDispose || 0) + 1; },',
    '    status() {',
    '      return { marker: ' + id + ', stateDir: env.stateDir || null, rev: 7,',
    '        itemCount: 1, reason: "ok", lastError: null, channel: null, notify: null };',
    '    }',
    '  };',
    '}',
    'module.exports = { createImplementation };',
  ].join('\n');
}

/**
 * Write an artefact and give it a DISTINCT mtime, so the `size:mtime` identity
 * is deterministic instead of depending on how fast the test writes.
 *
 * @param {string} file
 * @param {string} marker
 * @param {number} [offsetMs] forward offset from now, to force a change
 */
function writeArtefact(file, marker, offsetMs = 3000) {
  writeFileSync(file, minimalArtefact(marker), 'utf8');
  const stamp = new Date(Date.now() + offsetMs);
  utimesSync(file, stamp, stamp);
}

/**
 * Write arbitrary (possibly broken) artefact text with a forced-future mtime.
 *
 * @param {string} file
 * @param {string} text
 * @param {number} offsetMs
 */
function writeBroken(file, text, offsetMs) {
  writeFileSync(file, text, 'utf8');
  const stamp = new Date(Date.now() + offsetMs);
  utimesSync(file, stamp, stamp);
}

/**
 * Run a test body with the facade's watcher pointed at one fresh fake artefact.
 *
 * `reloadMs: 10` + `reloadEvery: 2` means a full decision every 20 ms, small
 * enough that each case can await the effect instead of sleeping a fixed time.
 * These are TEST-ONLY injection arguments (like `pollMs`); the shipped cadence is
 * `RELOAD_POLL_EVERY` × `POLL_MS`, asserted further down.
 *
 * @template T
 * @param {string} name
 * @param {{ prepare?: null | ((install: object) => void), extra?: object }} config
 * @param {(install: object, bridge: any) => T} body
 * @returns {Promise<T>}
 */
async function withWatcher(name, config, body) {
  const install = fakeInstall(name);
  const prepare = config.prepare === undefined ? null : config.prepare;
  if (prepare !== null) prepare(install);
  globalThis.__hotDispose = 0;
  globalThis.__hotConstructed = 0;
  const bridge = loadArtefact().createBridge({
    Menu: { buildFromTemplate: (template) => ({ template }) },
    tray: fakeTray(),
    options: fakeOptions(),
    stateDir: install.stateDir,
    pollMs: 60_000,
    reloadMs: 10,
    reloadEvery: 2,
    artefactPath: install.file,
    ...(config.extra === undefined ? {} : config.extra),
  });
  try {
    return await body(install, bridge);
  } finally {
    bridge.dispose();
    delete globalThis.__hotDispose;
    delete globalThis.__hotConstructed;
  }
}

/**
 * Wait until `predicate()` is true, or fail with the last observed value.
 *
 * Reloads happen on a TIMER, so a case cannot assert "it reloaded" synchronously.
 * Polling a bounded predicate is the honest way to await a timer: a slow machine
 * costs latency, not a flaky result.
 *
 * @param {() => boolean} predicate
 * @param {string} message
 * @param {number} [timeoutMs]
 */
async function until(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, message);
}

/**
 * Arm the watcher, then make a FAKE artefact the serving implementation.
 *
 * WHY THIS IS A TWO-STEP DANCE. The facade builds its FIRST implementation from
 * the module it was required from — the real kernel in this process. That is the
 * production fast path (the artefact was required microseconds earlier, so
 * re-requiring it would be pure waste) and it is not weakened for a test. So:
 *
 *   1. the fixture starts with NO file: the first decision tick sees the empty tag
 *      and only RECORDS it (the `remembered === undefined` row of the table, which
 *      is also what makes a freshly installed artefact impossible to reload into a
 *      loop);
 *   2. the file then appears — a real identity change — so reload #1 replaces the
 *      in-process implementation with the fake. From here every replacement disposes
 *      a FAKE, and `globalThis.__hotDispose` counts exactly those.
 *
 * @param {{ file: string }} install
 * @param {any} bridge
 */
async function prime(install, bridge) {
  await new Promise((resolve) => setTimeout(resolve, 80));
  writeArtefact(install.file, 'base');
  await until(() => bridge.status().reload.succeeded === 1, 'the priming artefact must reload');
  assert.equal(bridge.status().marker, 'base', 'the fake implementation serves after priming');
  assert.equal(globalThis.__hotDispose, 0,
    'replacing the in-process implementation is not a fake dispose: the counter is still 0');
}

// ---------------------------------------------------------------------------
// 1. The decision rule, table-driven, against the SHIPPED function.
// ---------------------------------------------------------------------------

test('the shipped decision rule answers every case of the table', () => {
  // The previous attempt's decision-table test, pointed at the SHIPPED function
  // instead of a generated copy: `bridgeArtefactChanged` is exported by
  // `lib/bridge/src/paths.js`, bundled into the artefact and called by the tick.
  // Nothing generates it any more, so the table cannot drift from the code.
  assert.equal(typeof bridgeArtefactChanged, 'function', 'the rule must be shipped, not generated by a test');
  const table = [
    ['100:200', undefined, false, 'nothing remembered yet → record only, no reload'],
    ['', '100:200', false, 'empty tag (file unreadable) → no reload, keep what works'],
    ['', undefined, false, 'empty tag before anything is remembered → record only'],
    ['100:200', '100:200', false, 'identical size+mtime → no reload (the hot path)'],
    ['100:201', '100:200', true, 'mtime moved → reload'],
    ['101:200', '100:200', true, 'size moved → reload'],
    ['0:0', '100:200', true, 'a zeroed identity is still a change'],
    ['100:200', '', true, 'an empty remembered tag is stale, so a real tag reloads'],
  ];
  for (const [tag, remembered, expected, why] of table) {
    assert.equal(bridgeArtefactChanged(tag, remembered), expected, why);
  }

  // The rule is TOTAL: no input throws, including non-string values.
  for (const tag of [undefined, null, 0, {}, []]) {
    assert.doesNotThrow(() => bridgeArtefactChanged(tag, '100:200'), 'the rule must never throw');
  }

  // And the tag really is `size + ':' + mtimeMs`, computed from a real stat — not
  // a value the test can fabricate its way past.
  const probe = join(WORK_DIR, 'tag-probe.js');
  mkdirSync(WORK_DIR, { recursive: true });
  writeFileSync(probe, minimalArtefact('tag'), 'utf8');
  const tag = artefactTag(probe);
  assert.equal(tag.split(':').length >= 2, true, 'the tag is size:mtimeMs, got ' + tag);
  assert.equal(tag.startsWith('0:'), false, 'a non-empty file has a non-zero size');
  assert.equal(artefactTag(join(WORK_DIR, 'no-such-file.js')), '', 'a missing file yields the empty tag');
});

// ---------------------------------------------------------------------------
// 2. The region is byte-identical: this design spends zero region bytes.
// ---------------------------------------------------------------------------

test('the shipped region is byte-identical to before: hot reload costs 0 region bytes', () => {
  // THE whole point of this design. If a future edit reintroduces the in-region
  // version — a `statSync`, a cache delete, a dispose-and-replace — the region
  // bytes change and this digest stops matching. It is the digest of
  // `buildSplitRegion(16384)`, i.e. exactly what the installer splices today.
  const region = buildSplitRegion(REGION_RESERVE_BYTES);
  assert.equal(createHash('sha256').update(region).digest('hex'), REGION_SHA,
    'the shipped region changed; hot reload must not touch it');

  // The arithmetic the previous attempt established still holds, so the REASON
  // this design exists is still true: 1,053 B spare, 1,000 B floor, 53 B to spend.
  assert.equal(SPLIT_BODY_BYTES, 15284, 'the shipped split body, measured');
  assert.equal(SPLIT_MINIMUM_REGION_LENGTH, 15331, 'marker + body + end marker + padding floor');
  assert.equal(REGION_RESERVE_BYTES, 16384, 'a packaging decision, not a byte of the body');
  assert.equal(REGION_RESERVE_BYTES - SPLIT_MINIMUM_REGION_LENGTH, 1053, 'the spare the audit cites');
  assert.equal(REGION_RESERVE_BYTES - SPLIT_MINIMUM_REGION_LENGTH >= SPARE_FLOOR, true,
    'the floor must hold WITHOUT a reload block, which is why the block is not in there');

  // And the region really does not carry the mechanism: every spelling of it is
  // absent from the bytes the installer writes.
  const text = region.toString('utf8');
  for (const needle of ['statSync', 'require.cache', 'mtimeMs', 'artefactTag', 'reloadEvery']) {
    assert.equal(text.includes(needle), false, 'the region must not contain ' + needle);
  }
  assert.equal(/delete\s+\w+\s*\.cache/.test(text), false, 'no cache invalidation of any spelling');
  assert.equal(SPLIT_BODY.includes('createImplementation'), false,
    'the region still calls the same public createBridge it always called');
});

// ---------------------------------------------------------------------------
// 3. The watcher: unchanged file, changed file, dispose-once, new code serving.
// ---------------------------------------------------------------------------

test('an unchanged artefact is never re-required: the SAME implementation keeps serving', async () => {
  // The file exists BEFORE the bridge is built, so the identity is stable from
  // the first tick: this is the ordinary production state, not the priming state.
  await withWatcher('unchanged', { prepare: (install) => writeArtefact(install.file, 'a') }, async (install, bridge) => {
    assert.equal(bridge.relabel(MESSAGES).ok, true, 'the initial implementation renders');

    // Ten decision intervals with the file untouched.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(bridge.status().reload.attempts, 0, 'an unchanged artefact is never an attempt');
    assert.equal(bridge.status().reload.succeeded, 0, 'and never a success');
    assert.equal(globalThis.__hotDispose, 0, 'nothing was disposed');
    assert.equal(globalThis.__hotConstructed, 0, 'nothing was rebuilt: the same object serves');
    // Proof it is the SAME implementation: a re-require would have replaced this
    // kernel-shaped status document with the fake's, which carries `marker`.
    assert.equal(typeof bridge.status().reason, 'string', 'the in-process implementation still serves');
    assert.equal(Object.hasOwn(bridge.status(), 'marker'), false, 'no fake was ever built');
  });
});

test('a changed artefact is re-required: dispose called once, the NEW implementation serves the menu', async () => {
  await withWatcher('changed', {}, async (install, bridge) => {
    await prime(install, bridge);

    // First identity change after priming: replace the fake with a new fake.
    writeArtefact(install.file, 'second', 6000);
    await until(() => bridge.status().reload.succeeded === 2, 'the changed artefact must reload');

    assert.equal(globalThis.__hotDispose, 1, 'the replaced implementation is disposed exactly once');
    assert.deepEqual(bridge.status().reload.succeeded, 2);
    assert.equal(bridge.status().reload.lastError, null, 'a successful reload records no error');
    assert.equal(typeof bridge.status().reload.lastAt, 'string', 'and it is timestamped for a support report');

    // THE POINT: the NEW file's code serves the MENU, not a flag. `relabel()` goes
    // through the facade into the reloaded implementation, whose marker is `second`.
    const rendered = bridge.relabel(MESSAGES);
    assert.equal(rendered.marker, 'second', 'the reloaded implementation is what renders');
    assert.equal(bridge.status().marker, 'second', 'and it is what status() reports');

    // A second change reloads again, disposing exactly once more.
    writeArtefact(install.file, 'third', 12000);
    await until(() => bridge.status().reload.succeeded === 3, 'a second change reloads again');
    assert.equal(globalThis.__hotDispose, 2, 'one dispose per replacement, never two for one');
    assert.equal(bridge.status().marker, 'third');
  });
});

test('require.cache really is refreshed: the observable behaviour changes, not just a counter', async () => {
  await withWatcher('cache', {}, async (install, bridge) => {
    await prime(install, bridge);
    const moduleBefore = require_(install.file);
    assert.equal(moduleBefore.createImplementation({}).marker, 'base');

    // Without the targeted delete, Node would hand back THIS module object forever
    // — the exact bug the reload exists to prevent. So the assertion is on the
    // module object identity, not on the facade's own bookkeeping.
    writeArtefact(install.file, 'refreshed', 6000);
    await until(() => bridge.status().marker === 'refreshed', 'the reload happened');

    const moduleAfter = require_(install.file);
    assert.equal(moduleAfter === moduleBefore, false, 'require.cache handed back a NEW module object');
    assert.equal(moduleAfter.createImplementation({}).marker, 'refreshed', 'and it is the new file');
    assert.equal(bridge.status().marker, 'refreshed', 'the serving implementation is the new one');
    assert.equal(globalThis.__hotDispose, 1, 'the old implementation was released exactly once');
  });
});

// ---------------------------------------------------------------------------
// 4. Failure degrades: keep the old implementation, record it, do not spin.
// ---------------------------------------------------------------------------

test('a throwing artefact keeps the old implementation: lastError recorded, no crash, no spin', async () => {
  await withWatcher('throwing', {}, async (install, bridge) => {
    await prime(install, bridge);

    // A syntax error is the case that matters: `require` itself throws.
    writeBroken(install.file, 'module.exports = {{{ broken', 6000);

    await until(() => bridge.status().reload.attempts >= 2, 'the broken file is attempted');
    const failed = bridge.status().reload;
    assert.equal(failed.succeeded, 1, 'a failed reload never counts as a success (only the priming one did)');
    assert.equal(typeof failed.lastError, 'string', 'the failure is visible');
    assert.equal(failed.lastError.length > 0, true, 'and it carries the reason, got: ' + failed.lastError);
    assert.equal(bridge.status().marker, 'base', 'the OLD implementation is still serving');
    assert.equal(bridge.relabel(MESSAGES).marker, 'base', 'and the menu still renders from it');
    assert.equal(globalThis.__hotDispose, 0, 'a failed reload must not dispose what still works');

    // THE RETRY SEMANTICS CHOSEN: the FAILED tag is remembered, so the same broken
    // bytes are not retried. A retry every 12 s would re-parse the file and rewrite
    // `bridge.json` forever for an artefact a human must fix anyway. A FURTHER edit
    // produces a new tag and does retry (the next case proves that).
    const attempts = bridge.status().reload.attempts;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(bridge.status().reload.attempts, attempts, 'the same broken tag must not spin');
  });
});

test('a failure is recoverable: a further change retries, and a success clears lastError', async () => {
  await withWatcher('recover', {}, async (install, bridge) => {
    await prime(install, bridge);

    writeBroken(install.file, 'module.exports.createImplementation = () => { throw new Error("nope"); };', 6000);
    await until(() => bridge.status().reload.attempts >= 2, 'the throwing constructor is attempted');
    assert.equal(bridge.status().reload.lastError === null, false, 'the failure is on record');
    assert.equal(bridge.status().marker, 'base', 'the constructor that threw did not replace anything');

    // A module without the export at all walks the same failure path.
    writeBroken(install.file, 'module.exports = {};', 12000);
    await until(() => bridge.status().reload.attempts >= 3, 'a further change retries');
    assert.equal(bridge.status().reload.lastError.includes('createBridge'), true,
      'a module without createBridge is refused with a readable reason: ' + bridge.status().reload.lastError);

    // And the fix lands: new tag, real implementation, old one released, error cleared.
    writeArtefact(install.file, 'fixed', 15000);
    await until(() => bridge.status().marker === 'fixed', 'the fixed artefact reloads');
    assert.equal(bridge.status().reload.lastError, null, 'a success clears the stored failure');
    assert.equal(globalThis.__hotDispose, 1, 'the old fake was released exactly once');
  });
});test('a missing artefact keeps the implementation, and its return is picked up again', async () => {
  await withWatcher('missing', {}, async (install, bridge) => {
    await prime(install, bridge);
    const attempts = bridge.status().reload.attempts;

    rmSync(install.file, { force: true });
    // The unstatable-file row of the table: no attempt, nothing disposed.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(bridge.status().reload.attempts, attempts, 'a missing file is not a reload attempt');
    assert.equal(bridge.status().reload.lastError, null, 'and it is not recorded as a failure');
    assert.equal(globalThis.__hotDispose, 0, 'a missing file must not release what works');
    assert.equal(bridge.status().marker, 'base', 'the working implementation still serves');
    assert.equal(bridge.relabel(MESSAGES).marker, 'base', 'and still renders');

    // The file coming back is a change from the empty tag: it reloads normally.
    writeArtefact(install.file, 'back', 9000);
    await until(() => bridge.status().reload.succeeded === 2, 'the restored artefact reloads');
    assert.equal(bridge.status().marker, 'back', 'and the restored file serves');
  });
});

test('the REAL artefact reloads itself: __filename and the CommonJS require work in the bundle', async () => {
  // The cases above point the watcher at a fake path, which proves the decision
  // and the swap but NOT that `__filename` / `__builtinRequire` are reachable from
  // inside the bundled artefact. This case closes that gap: it copies the built
  // artefact into scratch, requires THAT as a CommonJS module (so its own
  // `__filename` is the copy), lets it watch itself, and changes the copy.
  const dir = join(WORK_DIR, 'self');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}', 'utf8');
  const copy = join(dir, 'tray-bridge.js');
  const original = readFileSync(ARTEFACT_PATH, 'utf8');
  writeFileSync(copy, original, 'utf8');

  const bridge = require_(copy).createBridge({
    Menu: { buildFromTemplate: (template) => ({ template }) },
    tray: fakeTray(),
    options: fakeOptions(),
    stateDir: join(dir, 'state'),
    pollMs: 60_000,
    reloadMs: 10,
    reloadEvery: 2,
  });
  try {
    // No `artefactPath`: the facade must fall back to its own `__filename`.
    assert.equal(bridge.status().reload.attempts, 0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(bridge.status().reload.attempts, 0, 'a freshly required artefact does not reload itself');

    // A manual edit of the copy — the exact thing a human does after copying a
    // fixed build in. Size and mtime both change.
    writeFileSync(copy, original + '\n/* hot-reload probe */\n', 'utf8');
    const stamp = new Date(Date.now() + 9000);
    utimesSync(copy, stamp, stamp);
    await until(() => bridge.status().reload.attempts >= 1, 'the artefact must notice itself changing');

    const reload = bridge.status().reload;
    assert.equal(reload.succeeded, 1, 'the self-reload succeeded — the bundle can re-require itself');
    assert.equal(reload.lastError, null, 'no error was recorded');
  } finally {
    bridge.dispose();
  }
});

// ---------------------------------------------------------------------------
// 5. Bounded record: the `reload` block in bridge.json and in status().
// ---------------------------------------------------------------------------

test('the failure lands in bridge.json as a bounded `reload` block, after the old keys', async () => {
  await withWatcher('record', {}, async (install, bridge) => {
    await prime(install, bridge);
    writeBroken(install.file, 'module.exports = {{{ broken', 6000);
    await until(() => bridge.status().reload.lastError !== null, 'the failure is recorded');

    // A human opens `bridge.json`; this is the file the operator actually reads.
    //
    // THE ONE EDIT THIS FILE NEEDED, twice over: `patches` (dynamic-patch hook) and
    // `windows` (window close observer) are new TOP-LEVEL keys, so they are filtered
    // out here alongside `reload` — the assertion stays a STRICT order pin on the keys
    // 0.4.0 shipped (same list, same order, nothing loosened). The complete key order,
    // including every additive block, is pinned against `RENDER_RECORD_KEYS` in
    // `test/patch-hook.test.mjs`, which is where the blocks themselves are tested;
    // `Object.keys(persisted.reload)` below is still asserted to have exactly its four
    // keys.
    const persisted = JSON.parse(readFileSync(join(install.stateDir, 'bridge.json'), 'utf8'));
    assert.deepEqual(
      Object.keys(persisted).filter((key) => key !== 'reload' && key !== 'patches' && key !== 'windows'),
      ['version', 'rev', 'itemCount', 'reason', 'lastError', 'channel', 'notify', 'renderedAt'],
      'reload is appended AFTER every existing key, so an older file stays diffable',
    );
    // The new block is BOUNDED: two counters, one timestamp, one clipped string.
    assert.deepEqual(Object.keys(persisted.reload), ['attempts', 'succeeded', 'lastAt', 'lastError']);
    assert.equal(persisted.reload.succeeded, 1, 'the priming success is counted');
    assert.equal(persisted.reload.attempts >= 2, true, 'the failure attempt is counted');
    assert.equal(typeof persisted.reload.lastAt, 'string', 'the failure is timestamped');
    assert.equal(persisted.reload.lastError.length > 0, true,
      'a support report must be able to read WHY without a debugger');
    assert.equal(persisted.reload.lastError.length <= 160, true,
      'the text comes from a third-party artefact, so it is clipped');
    assert.equal(persisted.reason, 'ok', 'the render fields still describe the serving implementation');
  });
});

test('status() keeps every field it had, and the reload block is purely additive', () =>
  withHome((home) => {
    const { bridge } = makeBridge({ home });
    const status = bridge.status();
    for (const key of [
      'version', 'reason', 'lastError', 'renderCount', 'rev', 'itemCount', 'disposed',
      'hasContribution', 'stateDir', 'loadWritten', 'polling', 'notify', 'channel',
    ]) {
      assert.equal(Object.hasOwn(status, key), true, 'status() lost the ' + key + ' field');
    }
    assert.deepEqual(Object.keys(status.reload), ['attempts', 'succeeded', 'lastAt', 'lastError']);
    assert.equal(status.reload.attempts, 0, 'a bridge that never reloaded reports zero');
    assert.equal(status.reload.succeeded, 0);
    assert.equal(status.reload.lastAt, null);
    assert.equal(status.reload.lastError, null);
    // `reload` describing a watcher must not be confused with "a reload happened":
    // the shipped artefact watches ITSELF, so an ordinary bridge really is armed.
    assert.equal(status.polling, true, 'the ordinary menu poll is still running');
    bridge.dispose();
  }));

test('the artefact carries the watcher, and the default cadence is the documented one', () => {
  const text = readFileSync(ARTEFACT_PATH, 'utf8');
  for (const needle of ['artefactTag', 'bridgeArtefactChanged', 'createImplementation']) {
    assert.equal(text.includes(needle), true, 'the artefact must bundle ' + needle);
  }
  // The arithmetic behind RELOAD_POLL_EVERY, asserted rather than trusted:
  // 17 × 700 ms ≈ 11.9 s per `stat`, and 17 is NOT a multiple of the 3-tick
  // notification cadence (sharing a tick would double that one tick's work).
  assert.equal(RELOAD_POLL_EVERY, 17, 'RELOAD_POLL_EVERY is a shipped decision, not a test knob');
  assert.equal(RELOAD_POLL_EVERY % 3 !== 0, true, 'the check must not collide with NOTIFY_POLL_EVERY');
  assert.equal((RELOAD_POLL_EVERY * 700) / 1000 > 10, true, 'at least ten seconds between checks');
  assert.equal((RELOAD_POLL_EVERY * 700) / 1000 <= 15, true, 'and well under a claimed quarter minute');
  assert.equal(RELOAD_MAX_ATTEMPTS > 0, true, 'the counters saturate at a finite ceiling');
});

// ---------------------------------------------------------------------------
// 6. No timer leak: after dispose() the watcher is silent.
// ---------------------------------------------------------------------------

test('dispose() stops the watcher: no further ticks, no reloads, no state writes', async () => {
  // Deliberately NOT primed: the real kernel serves, so `status().disposed` and
  // `status().polling` describe the thing that owns the timers.
  await withWatcher('disposed', {}, async (install, bridge) => {
    assert.equal(bridge.relabel(MESSAGES).ok, true, 'render once, so bridge.json exists');
    assert.equal(bridge.status().disposed, false);
    const statusFile = join(install.stateDir, 'bridge.json');
    const before = readFileSync(statusFile, 'utf8');

    bridge.dispose();
    assert.equal(bridge.status().disposed, true, 'the implementation is disposed too');
    assert.equal(bridge.status().polling, false, 'and its own poll timer is gone');

    // A change AFTER dispose must be invisible: the timer is cleared, so nothing
    // may be re-required and nothing may be written.
    writeArtefact(install.file, 'after-dispose', 9000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(bridge.status().reload.attempts, 0, 'a disposed facade forces no reload');
    assert.equal(globalThis.__hotConstructed, 0, 'no artefact was ever built after dispose');
    assert.equal(readFileSync(statusFile, 'utf8'), before,
      'the disposed watcher must not write diagnostics either');

    // Calling dispose() again is a no-op, never a second teardown.
    assert.doesNotThrow(() => bridge.dispose());
  });
});
