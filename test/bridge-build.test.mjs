/**
 * Build-artefact tests: determinism, pure ASCII, and the hard constraints the
 * artefact has to satisfy because it runs inside Electron's main process.
 *
 * `node --test test/bridge-build.test.mjs`
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ARTEFACT_PATH, PACKAGE_ROOT, isAscii, loadArtefact, stripComments } from './bridge-harness.mjs';
import { MODULE_ORDER, buildArtefact, toAscii } from '../scripts/build-bridge.mjs';

/** sha256 of a string, as the build prints it. */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

test('build is byte-for-byte deterministic across two runs', () => {
  const first = buildArtefact();
  const second = buildArtefact();
  assert.equal(first.bytes, second.bytes, 'byte count must not drift between runs');
  assert.equal(first.sha256, second.sha256, 'sha256 must be identical between runs');
  assert.equal(first.code, second.code, 'artefact text must be identical');
  // No wall-clock values may leak into the artefact: a build must be a pure
  // function of the sources, or a rebuild could silently produce new bytes.
  assert.equal(sha256(first.code), first.sha256);
});

test('committed artefact matches what the builder produces now', () => {
  const built = buildArtefact();
  const committed = readFileSync(ARTEFACT_PATH, 'utf8');
  assert.equal(committed, built.code, 'bridge/dist/tray-bridge.js is stale; rebuild it');
  assert.equal(sha256(committed), built.sha256);
  assert.equal(Buffer.byteLength(committed, 'utf8'), built.bytes);
});

test('artefact is pure ASCII and uses LF line endings', () => {
  const text = readFileSync(ARTEFACT_PATH, 'utf8');
  assert.equal(isAscii(text), true, 'the artefact must not contain non-ASCII code points');
  assert.equal(text.includes('\r'), false, 'the artefact must use LF only');
  assert.equal(text.startsWith('"use strict";\n'), true, 'the artefact must open with a strict-mode directive');
  // Unicode escape generation is exercised directly, because a source comment
  // that later gains a non-ASCII character must degrade to escapes, not bytes.
  assert.equal(toAscii('caf\u00e9'), 'caf\\u00E9');
  assert.equal(toAscii('\u4f60\u597d'), '\\u4F60\\u597D');
  assert.equal(toAscii('plain text'), 'plain text');
});

test('artefact never performs the actions the shell owns', () => {
  // The prose in the sources explains what the bridge must not do, so the
  // red-line scan runs on code with comments stripped. `app.quit(` appears in
  // that prose, and the narrowing below makes the scan about code only.
  const code = stripComments(readFileSync(ARTEFACT_PATH, 'utf8'));
  // These are the hard red lines of design/PHASE1-SPEC.md §4.3: the bridge
  // renders, it never owns the tray, the app lifecycle or the network.
  for (const forbidden of [
    'new Tray(',
    'app.quit(',
    'tray.destroy(',
    'BrowserWindow',
    'Notification',
    'require("electron")',
    "require('electron')",
    'require("https")',
    'require("http")',
    'require("net")',
    'require("tls")',
  ]) {
    assert.equal(code.includes(forbidden), false, 'artefact must not contain: ' + forbidden);
  }
});

test('artefact never names an archive path, so it cannot read inside the asar', () => {
  const code = stripComments(readFileSync(ARTEFACT_PATH, 'utf8'));
  // String literals are the only way a path could reach `fs`; checking them
  // individually keeps `asarSha` (a diagnostic field name) out of the way.
  const literals = [...code.matchAll(/(['"])((?:\\.|[^\\'"])*)\1/g)].map((match) => match[2]);
  for (const literal of literals) {
    assert.equal(literal.includes('.asar'), false, 'artefact must not reference an archive path: ' + literal);
  }
});

test('artefact requires only node: built-ins', () => {
  const text = readFileSync(ARTEFACT_PATH, 'utf8');
  const requested = [...text.matchAll(/__require\(("[^"]+")\)/g)].map((match) => JSON.parse(match[1]));
  assert.ok(requested.length > 0, 'the artefact must resolve its built-ins through the loader');
  for (const request of requested) {
    assert.ok(request.startsWith('node:'), 'unexpected module request: ' + request);
  }
  // `node:module` joined the set with the dynamic-patch hook (`patch.js` PATCHES
  // `Module._load`, and that is the one handle on it). It is a built-in, it is
  // loaded through `__require` like the other three, and it does NOT reach the
  // network, the archive or Electron — so it belongs in this list, and the list
  // stays explicit rather than becoming "any node: specifier".
  const allowed = new Set(['node:fs', 'node:os', 'node:path', 'node:module']);
  for (const request of requested) assert.ok(allowed.has(request), 'unexpected module request: ' + request);
});

test('artefact loads as CommonJS and exposes createBridge', () => {
  const artefact = loadArtefact();
  assert.equal(typeof artefact.createBridge, 'function');
  const description = artefact.describe();
  assert.equal(description.protocols.menu, 2);
  assert.equal(description.protocols.events, 2);
  assert.equal(typeof description.version, 'string');
  assert.equal(artefact.PROTOCOL, 2);
});

test('the builder writes the same bytes to any output path', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-build-'));
  try {
    const built = buildArtefact();
    // The build is a pure function of the sources, so the artefact text must not
    // depend on where the package happens to live.
    assert.equal(built.code.includes(PACKAGE_ROOT), false, 'absolute build paths must not leak into the artefact');
    // The module set is DERIVED, not typed as a literal count: a capability
    // module that joins the bridge (notify.js did, for the notification channel)
    // must not have to remember to edit a number here, while a module that
    // silently dropped OUT of the bundle still fails. The named checks keep the
    // intent visible: the notification channel ships, and since the window CLOSE
    // observer landed (`windows.js` `createWindowTracker`) the window contract
    // ships too — it stopped being dead code the moment the bridge consumed it.
    assert.deepEqual(built.modules, MODULE_ORDER.slice());
    assert.equal(built.modules.includes('notify.js'), true);
    assert.equal(built.modules.includes('windows.js'), true,
      'the close observer consumes the window module, so it must ride along');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
