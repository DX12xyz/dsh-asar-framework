/**
 * Recovery tests: whatever the contribution document or Electron does, the tray
 * keeps a usable menu and the failure is recorded, never thrown.
 *
 * `node --test test/bridge-recovery.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  MESSAGES,
  fakeMenu,
  fakeTray,
  lastTemplate,
  loadArtefact,
  makeBridge,
  outline,
  withHome,
} from './bridge-harness.mjs';

/**
 * The bridge identity the artefact must report.
 *
 * Taken from the ARTEFACT's own export rather than typed as a literal: this
 * assertion used to pin `'0.1.0'`, which stayed true for three releases and then
 * reported nothing about which bridge was loaded (audit 2026-11-16, item 9).
 * Reading it from the bundled build keeps the case honest — it asserts "the
 * artefact reports its own version", not "somebody typed a number here".
 */
const { BRIDGE_VERSION } = loadArtefact();

/** The stock menu, transcribed from the 1,253-byte region, for structural compares. */
const STOCK = [
  { label: MESSAGES.openApplication, type: undefined, clickable: true },
  { label: undefined, type: 'separator' },
  { label: MESSAGES.quitApplication, type: undefined, clickable: true },
];

/**
 * @param {ReturnType<typeof import('./bridge-harness.mjs').fakeHome>} home
 * @returns {any | null} the parsed bridge.json, or null when absent
 */
function bridgeStatus(home) {
  const text = home.read('bridge.json');
  return text === null ? null : JSON.parse(text);
}

test('invalid JSON falls back to the official three and records the error', () =>
  withHome((home) => {
    const { bridge, menu } = makeBridge({ home });
    home.write('menu.json', '{ not json at all');
    const result = bridge.relabel(MESSAGES);
    assert.equal(result.ok, true, 'a bad document must not fail the render');
    assert.deepEqual(outline(lastTemplate(menu)), STOCK);

    const status = bridgeStatus(home);
    assert.equal(status.reason, 'error');
    assert.equal(status.itemCount, 0);
    assert.equal(status.rev, 0);
    assert.equal(typeof status.lastError, 'string');
    assert.ok(status.lastError.includes('JSON'), 'lastError must name the cause: ' + status.lastError);
    assert.equal(typeof status.renderedAt, 'string');
    assert.equal(status.version, BRIDGE_VERSION,
      'bridge.json must report the version of the bridge that wrote it');
    bridge.dispose();
  }));

test('a menu.json over the 256 KiB limit counts as no contribution', () =>
  withHome((home) => {
    const padding = 'x'.repeat(256 * 1024 + 1);
    home.write(
      'menu.json',
      JSON.stringify({ protocol: 2, rev: 1, items: [{ id: 'i', label: 'Item' }], pad: padding }),
    );
    const { bridge, menu } = makeBridge({ home });
    assert.equal(bridge.relabel(MESSAGES).ok, true);
    assert.equal(lastTemplate(menu).length, 3);

    const status = bridgeStatus(home);
    assert.equal(status.reason, 'error');
    assert.ok(status.lastError.includes('256'), 'lastError must explain the size limit: ' + status.lastError);
    bridge.dispose();
  }));

test('a document with the wrong protocol version is refused', () =>
  withHome((home) => {
    const { bridge, menu } = makeBridge({ home });
    home.write('menu.json', JSON.stringify({ protocol: 1, rev: 1, items: [{ id: 'i', label: 'Item' }] }));
    bridge.relabel(MESSAGES);
    assert.deepEqual(outline(lastTemplate(menu)), STOCK);
    const status = bridgeStatus(home);
    assert.equal(status.reason, 'error');
    assert.ok(status.lastError.includes('protocol'), status.lastError);
    bridge.dispose();
  }));

test('a contribution document whose items is not an array is recorded as an error', () =>
  withHome((home) => {
    const { bridge, menu } = makeBridge({ home });
    home.write('menu.json', JSON.stringify({ protocol: 2, rev: 1, items: 'nope' }));
    bridge.relabel(MESSAGES);
    assert.deepEqual(outline(lastTemplate(menu)), STOCK);
    const status = bridgeStatus(home);
    assert.equal(status.reason, 'error');
    assert.ok(status.lastError.includes('items'), status.lastError);
    bridge.dispose();
  }));

test('a missing menu.json is a normal empty render, not an error', () =>
  withHome((home) => {
    const { bridge } = makeBridge({ home });
    bridge.relabel(MESSAGES);
    const status = bridgeStatus(home);
    assert.equal(status.reason, 'empty');
    assert.equal(status.lastError, null);
    bridge.dispose();
  }));

test('a throwing Menu never propagates and the official menu is retried', () =>
  withHome((home) => {
    // The realistic Electron failure: a contribution template is malformed, so
    // the first build throws and the official fallback must still land.
    const menu = fakeMenu({ throwOnBuild: (call) => call === 1 });
    const { bridge, tray } = makeBridge({ home, menu });
    assert.doesNotThrow(() => bridge.relabel(MESSAGES));
    assert.equal(menu.buildCalls, 2, 'the bridge must retry with the official menu');
    assert.deepEqual(outline(lastTemplate(menu)), STOCK);
    assert.equal(tray.contextMenus.length, 1, 'the retried menu must still reach the tray');

    const status = bridgeStatus(home);
    assert.equal(status.reason, 'error');
    assert.ok(status.lastError.includes('build'), status.lastError);
    bridge.dispose();
  }));

test('a Menu that always throws leaves the tray untouched and does not throw', () =>
  withHome((home) => {
    const menu = fakeMenu({ throwOnBuild: () => true });
    const { bridge, tray } = makeBridge({ home, menu });
    assert.doesNotThrow(() => bridge.relabel(MESSAGES));
    assert.equal(tray.contextMenus.length, 0, 'no menu is installed when none can be built');
    assert.equal(bridge.status().reason, 'error');
    assert.ok(String(bridge.status().lastError).includes('build'));
    bridge.dispose();
  }));

test('a tray that throws on setContextMenu does not propagate', () =>
  withHome((home) => {
    const tray = fakeTray();
    let calls = 0;
    tray.setContextMenu = () => {
      calls += 1;
      throw new Error('native tray rejected the menu');
    };
    const { bridge } = makeBridge({ home, tray });
    assert.doesNotThrow(() => bridge.relabel(MESSAGES));
    assert.equal(calls, 1);
    assert.equal(bridge.status().reason, 'error');
    assert.ok(String(bridge.status().lastError).includes('setContextMenu'));
    bridge.dispose();
  }));

test('a throwing locale reader degrades to blank messages, not a crash', () =>
  withHome((home) => {
    const { bridge, menu } = makeBridge({
      home,
      options: {
        iconPath: 'x',
        locale: () => {
          throw new Error('locale exploded');
        },
        open() {},
        quit() {},
      },
    });
    assert.doesNotThrow(() => bridge.relabel());
    const template = lastTemplate(menu);
    assert.equal(template.length, 3, 'the official entries still render, with blank labels');
    assert.equal(template[0].label, '');
    bridge.dispose();
  }));

test('createBridge with a missing Menu returns an inert bridge that never throws', () =>
  withHome((home) => {
    const { bridge } = makeBridge({ home, extra: { Menu: undefined } });
    assert.equal(typeof bridge.relabel, 'function');
    assert.equal(typeof bridge.dispose, 'function');
    assert.equal(typeof bridge.status, 'function');
    assert.deepEqual(bridge.relabel(MESSAGES), { ok: false });
    assert.equal(bridge.status().reason, 'inert');
    assert.equal(bridge.status().lastError, 'Menu.buildFromTemplate is unavailable');
    assert.doesNotThrow(() => bridge.dispose());
  }));

test('createBridge with a tray that lacks setContextMenu returns an inert bridge', () =>
  withHome((home) => {
    const { bridge } = makeBridge({ home, extra: { tray: { setToolTip() {} } } });
    assert.deepEqual(bridge.relabel(MESSAGES), { ok: false });
    assert.equal(bridge.status().lastError, 'tray.setContextMenu is unavailable');
  }));

test('createBridge tolerates a completely empty environment', () =>
  withHome(() => {
    const artefact = loadArtefact();
    const bridge = artefact.createBridge(undefined);
    assert.deepEqual(bridge.relabel(MESSAGES), { ok: false });
    assert.equal(bridge.status().reason, 'inert');
    assert.doesNotThrow(() => bridge.dispose());
  }));

test('an unwritable state directory still renders the official three', () =>
  withHome((home) => {
    // A state directory whose own path is a regular file: every mkdir and every
    // diagnostic write fails, and the bridge must survive that silently.
    const blocker = home.path('blocked');
    // The blocker must be a REGULAR FILE, not a directory: makePath() cannot turn
    // a file into a directory, so every ensureDir/write below fails.
    mkdirSync(home.stateDir, { recursive: true });
    writeFileSync(blocker, 'not a directory', 'utf8');
    const menu = fakeMenu();
    const tray = fakeTray();
    const artefact = loadArtefact();
    const bridge = artefact.createBridge({
      Menu: menu,
      tray,
      options: { locale: () => ({ messages: MESSAGES }), open() {}, quit() {} },
      stateDir: blocker,
      pollMs: 60_000,
    });
    assert.doesNotThrow(() => bridge.relabel(MESSAGES));
    assert.equal(menu.templates.length, 1, 'the menu still renders without any writable state');
    assert.equal(tray.contextMenus.length, 1);
    assert.equal(bridge.status().stateDir, null, 'the bridge reports the state directory as unavailable');
    bridge.dispose();
  }));

test('a contribution document that changes shape between renders is re-read each time', () =>
  withHome((home) => {
    const { bridge, menu } = makeBridge({ home });
    home.write('menu.json', JSON.stringify({ protocol: 2, rev: 1, items: [{ id: 'a', label: 'A' }] }));
    bridge.relabel(MESSAGES);
    assert.equal(lastTemplate(menu).length, 4);

    home.write('menu.json', '{ broken');
    bridge.relabel(MESSAGES);
    assert.deepEqual(outline(lastTemplate(menu)), STOCK);

    home.write('menu.json', JSON.stringify({ protocol: 2, rev: 2, items: [{ id: 'b', label: 'B' }] }));
    bridge.relabel(MESSAGES);
    assert.equal(lastTemplate(menu)[2].label, 'B');
    bridge.dispose();
  }));
