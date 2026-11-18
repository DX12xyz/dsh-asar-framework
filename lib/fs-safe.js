/**
 * fs backend that can actually see inside `app.asar`.
 *
 * Electron patches `node:fs` so that a `.asar` path behaves like a DIRECTORY:
 * `statSync('.../app.asar')` reports `size: 0, isFile: false` and
 * `openSync('.../app.asar', 'r')` fails with ENOENT. That is what the renderer
 * wants, but it makes byte-level work on the archive impossible.
 *
 * `original-fs` is Electron's unpatched fs, available only inside Electron. The
 * Host half runs as `ELECTRON_RUN_AS_NODE=1` (so `process.versions.electron`
 * exists) and must use it; a plain `node scripts/install.mjs` run has no
 * Electron at all and must use `node:fs`.
 *
 * Every module that touches the archive imports from here instead of `node:fs`,
 * so the choice is made once, in one place.
 */
import * as nodeFs from 'node:fs';
import * as nodeFsPromises from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** True when the Electron-patched fs is in effect for this process. */
export const IN_ELECTRON = typeof process.versions.electron === 'string';

/** The fs implementation to use for real-file byte access. */
export const fs = IN_ELECTRON
  ? (() => {
    try {
      return require('original-fs');
    } catch {
      // A Electron build without original-fs: better to try node:fs than to fail.
      return nodeFs;
    }
  })()
  : nodeFs;

/** Promise-based view of the same backend. */
export const fsPromises = (() => {
  try {
    if (typeof fs.promises === 'object' && fs.promises !== null && typeof fs.promises.open === 'function') {
      return fs.promises;
    }
  } catch {
    /* fall through */
  }
  return nodeFsPromises;
})();

/** Human-facing name of the backend, for diagnostics. */
export const BACKEND_NAME = fs === nodeFs ? 'node:fs' : 'original-fs';

/**
 * Promise-based `open` that follows the same backend.
 * @param {string} path
 * @param {string} [flags]
 * @returns {Promise<any>}
 */
export function open(path, flags = 'r') {
  return fsPromises.open(path, flags);
}

export const {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  appendFileSync,
} = fs;
