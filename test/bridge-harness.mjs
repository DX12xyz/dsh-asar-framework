/**
 * Shared harness for the bridge tests.
 *
 * The tests load the *artefact* (`bridge/dist/tray-bridge.js`), never the ESM
 * sources: that is what runs inside the Electron main process, so the artefact
 * is the thing that must behave. Electron itself is replaced by three recording
 * fakes, which is also the only way to observe what the bridge hands to the
 * native tray.
 */

import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** Package root (`pkg/`), derived from this file's location. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path of the built artefact. */
export const ARTEFACT_PATH = path.join(PACKAGE_ROOT, 'bridge', 'dist', 'tray-bridge.js');

/** The locale messages the stock shell passes to `relabel()`. */
export const MESSAGES = {
  aboutProduct: 'DeepSeek Harness',
  openApplication: 'Open DeepSeek Harness',
  quitApplication: 'Quit DeepSeek Harness',
};

/**
 * Load a fresh copy of the artefact. A fresh copy per test avoids state leaking
 * between cases through module-level variables.
 *
 * @returns {any} the artefact's CommonJS exports
 */
export function loadArtefact() {
  delete require.cache[ARTEFACT_PATH];
  return require(ARTEFACT_PATH);
}

/**
 * A recording stand-in for Electron's `Tray`.
 *
 * @returns {{
 *   contextMenus: unknown[],
 *   tooltips: string[],
 *   destroyed: number,
 *   setContextMenu: (menu: unknown) => void,
 *   setToolTip: (tooltip: string) => void,
 *   destroy: () => void,
 * }} fake tray
 */
export function fakeTray() {
  const tray = {
    contextMenus: [],
    tooltips: [],
    destroyed: 0,
    setContextMenu(menu) {
      tray.contextMenus.push(menu);
    },
    setToolTip(tooltip) {
      tray.tooltips.push(tooltip);
    },
    destroy() {
      tray.destroyed += 1;
    },
  };
  return tray;
}

/**
 * A recording stand-in for Electron's `Menu` class.
 *
 * Electron's real `Menu` arrives as a *class* (a function), not a plain object,
 * so the fake mirrors that shape: the bridge must accept both.
 *
 * @param {{ throwOnBuild?: (call: number, template: unknown[]) => boolean }} [options]
 * @returns {{ templates: unknown[][], buildCalls: number, buildFromTemplate: Function }} fake menu provider
 */
export function fakeMenu(options = {}) {
  const state = { templates: [], buildCalls: 0 };
  const provider = {
    templates: state.templates,
    get buildCalls() {
      return state.buildCalls;
    },
    buildFromTemplate(template) {
      state.buildCalls += 1;
      if (options.throwOnBuild !== undefined && options.throwOnBuild(state.buildCalls, template)) {
        throw new Error('build refused by fake Menu');
      }
      state.templates.push(template);
      return { template, items: template };
    },
  };
  return provider;
}

/**
 * An inert stand-in for the shell's `options` (`{iconPath, locale, open, quit}`).
 *
 * @param {{ messages?: Record<string, string>, onOpen?: Function, onQuit?: Function,
 *           localeThrows?: boolean }} [input]
 * @returns {object} fake options
 */
export function fakeOptions(input = {}) {
  const calls = { open: 0, quit: 0, locale: 0 };
  const messages = input.messages === undefined ? MESSAGES : input.messages;
  const options = {
    iconPath: '<test>\\fake\\tray.ico',
    calls,
    locale() {
      calls.locale += 1;
      if (input.localeThrows === true) throw new Error('locale reader failed');
      return { messages };
    },
    open() {
      calls.open += 1;
      if (input.onOpen !== undefined) input.onOpen();
    },
    quit() {
      calls.quit += 1;
      if (input.onQuit !== undefined) input.onQuit();
    },
  };
  return options;
}

/**
 * A throwaway `DSH_HOME` directory; `createBridge` derives the state directory
 * from `process.env.DSH_HOME` exactly like the real Host does.
 *
 * @returns {{ home: string, stateDir: string, cleanup: () => void, write: (name: string, text: string) => string,
 *             read: (name: string) => string | null, exists: (name: string) => boolean, path: (name: string) => string }}
 */
export function fakeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-test-'));
  const stateDir = path.join(home, 'dsh-asar-framework');
  const handle = {
    home,
    stateDir,
    path: (name) => path.join(stateDir, name),
    write(name, text) {
      mkdirSync(stateDir, { recursive: true });
      const file = handle.path(name);
      writeFileSync(file, text, 'utf8');
      return file;
    },
    read(name) {
      try {
        return readFileSync(handle.path(name), 'utf8');
      } catch (_error) {
        return null;
      }
    },
    exists(name) {
      return handle.read(name) !== null;
    },
    cleanup() {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch (_error) {
        // A leaked temp directory must not fail a test run.
      }
    },
  };
  return handle;
}

/**
 * Run a test body with `DSH_HOME` pointed at a fresh temp directory and always
 * restored afterwards.
 *
 * @template T
 * @param {(home: ReturnType<typeof fakeHome>) => T} body
 * @returns {T}
 */
export function withHome(body) {
  const previous = process.env.DSH_HOME;
  const home = fakeHome();
  process.env.DSH_HOME = home.home;
  try {
    return body(home);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    home.cleanup();
  }
}

/**
 * Build a bridge wired to fakes.
 *
 * @param {{ home: ReturnType<typeof fakeHome>, messages?: Record<string, string>,
 *           menu?: ReturnType<typeof fakeMenu>, tray?: ReturnType<typeof fakeTray>,
 *           options?: object, pollMs?: number, extra?: Record<string, unknown> }} input
 * @returns {{ bridge: object, tray: any, menu: any, options: any, artefact: any }}
 */
export function makeBridge(input) {
  const artefact = loadArtefact();
  const tray = input.tray === undefined ? fakeTray() : input.tray;
  const menu = input.menu === undefined ? fakeMenu() : input.menu;
  const options =
    input.options === undefined
      ? fakeOptions(input.messages === undefined ? {} : { messages: input.messages })
      : input.options;
  const bridge = artefact.createBridge(
    Object.assign(
      {
        app: {},
        Tray: function Tray() {},
        Menu: menu,
        nativeImage: { createFromPath: () => ({}) },
        tray,
        options,
        stateDir: input.home.stateDir,
        pollMs: input.pollMs === undefined ? 60_000 : input.pollMs,
      },
      input.extra === undefined ? {} : input.extra,
    ),
  );
  return { bridge, tray, menu, options, artefact };
}

/**
 * Parse the last template the fake Menu received.
 *
 * @param {any} menu fake menu provider
 * @returns {object[]} the most recent template, or an empty list
 */
export function lastTemplate(menu) {
  if (menu.templates.length === 0) return [];
  return menu.templates[menu.templates.length - 1];
}

/**
 * Reduce a template to a comparable shape: label, type and presence of a click
 * handler. This is what "structurally equal to the stock menu" means here.
 *
 * @param {object[]} template
 * @returns {object[]}
 */
export function outline(template) {
  return template.map((option) => {
    const node = { label: option.label, type: option.type };
    if (option.id !== undefined) node.id = option.id;
    if (option.submenu !== undefined) node.submenu = outline(option.submenu);
    if (option.checked !== undefined) node.checked = option.checked;
    if (option.enabled === false) node.enabled = false;
    if (option.visible === false) node.visible = false;
    if (typeof option.click === 'function') node.clickable = true;
    return node;
  });
}

/**
 * @param {string} text
 * @returns {boolean} true when every code point is ASCII
 */
export function isAscii(text) {
  for (const character of text) {
    if (character.codePointAt(0) > 0x7f) return false;
  }
  return true;
}

/**
 * Remove comments while leaving string literals intact.
 *
 * The red-line checks look for forbidden *code* (`new Tray(`, `app.quit(` …),
 * and the sources legitimately mention those names in prose explaining what the
 * bridge must not do. Stripping comments keeps the check strict without making
 * the documentation lie.
 *
 * @param {string} text JavaScript source
 * @returns {string} source with block and line comments removed
 */
export function stripComments(text) {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (character === '/' && next === '/') {
      const end = text.indexOf('\n', index + 2);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      output += character;
      index += 1;
      while (index < text.length) {
        const current = text[index];
        output += current;
        index += 1;
        if (current === '\\') {
          output += text[index] === undefined ? '' : text[index];
          index += 1;
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}
