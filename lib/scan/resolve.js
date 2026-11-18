/**
 * One canonical install root, however the human picked it.
 *
 * The only file this framework ever patches is
 *
 *   <installRoot>\resources\app.asar
 *
 * and the only file it ever writes beside it is
 *
 *   <installRoot>\resources\app.asar.unpacked\dsh\tray-bridge.js
 *
 * A human, though, picks a *directory*, and the directory they pick can be any
 * of these:
 *
 *   <DSH root>\                                        the install root
 *   <DSH root>\resources                               the resources directory
 *   <DSH root>\resources\app.asar                      the archive itself
 *   <DSH root>\resources\whatever                      a folder inside resources
 *
 * Every one of them normalizes back to the same install root, so the rest of
 * the framework only ever deals with the canonical shape. A directory whose
 * `app.asar` does not sit inside a directory literally named `resources` is
 * NOT accepted, because the bridge path would then point somewhere else and
 * the shell would silently stop loading the bridge.
 *
 * Identity is separate from shape: an `app.asar` is only a DSH desktop archive
 * when its root `package.json` says `name === "@deepseek-ai/dsh-desktop"`.
 * Many Electron apps ship a `resources\app.asar`; matching on the path alone
 * would happily offer to patch somebody else's application.
 */
import { statSync } from '../fs-safe.js';
import { basename, dirname, join } from 'node:path';

import { DSH_DESKTOP_PACKAGE } from '../wire/constants.js';
import { ERROR_CODES } from '../wire/errors.js';
import { closeAsar, openAsar, readEntryText } from '../asar/reader.js';

/** The directory an asar must live in for this framework to accept it. */
export const RESOURCES_DIR_NAME = 'resources';

/** The archive file name. */
export const ASAR_FILE_NAME = 'app.asar';

/** Maximum depth walked when a picked path sits below the install root. */
const MAX_DERIVED_LEVELS = 2;

/**
 * Normalize a user-supplied path: trim, forward slashes to backslashes, drop
 * trailing separators. Never resolves to an absolute path on its own (the
 * caller's path is used as given, so relative input stays visible in errors).
 *
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeInputPath(input) {
  if (typeof input !== 'string') return '';
  let value = input.trim();
  if (value.length === 0) return '';
  value = value.replace(/\//g, '\\');
  while (value.length > 3 && value.endsWith('\\')) value = value.slice(0, -1);
  return value;
}

/**
 * Every `app.asar` path worth testing for one picked path, most canonical first.
 *
 * @param {string} picked
 * @returns {string[]}
 */
export function candidateAsarPaths(picked) {
  const input = normalizeInputPath(picked);
  if (input.length === 0) return [];

  const tail = basename(input).toLowerCase();
  const parent = dirname(input);
  const candidates = [];
  const push = (value) => {
    if (typeof value !== 'string' || value.length === 0) return;
    if (candidates.some((existing) => existing.toLowerCase() === value.toLowerCase())) return;
    candidates.push(value);
  };

  if (tail === ASAR_FILE_NAME) push(input);
  // The install root itself.
  push(join(input, RESOURCES_DIR_NAME, ASAR_FILE_NAME));
  // The resources directory itself.
  push(join(input, ASAR_FILE_NAME));
  // A directory inside / beside resources: its parent may hold the archive.
  push(join(parent, ASAR_FILE_NAME));
  push(join(parent, RESOURCES_DIR_NAME, ASAR_FILE_NAME));

  // Anything deeper: climb at most MAX_DERIVED_LEVELS levels looking for
  // `resources\app.asar`.
  let cursor = parent;
  for (let level = 0; level < MAX_DERIVED_LEVELS; level += 1) {
    cursor = dirname(cursor);
    if (cursor.length <= 2) break;
    push(join(cursor, RESOURCES_DIR_NAME, ASAR_FILE_NAME));
  }
  return candidates;
}

/**
 * Does `asarPath` sit directly inside a directory named `resources`, and does a
 * regular non-empty file exist there?
 *
 * @param {string} asarPath
 * @returns {boolean}
 */
function looksLikeResourcesArchive(asarPath) {
  if (basename(dirname(asarPath)).toLowerCase() !== RESOURCES_DIR_NAME) return false;
  try {
    const info = statSync(asarPath);
    if (info.isFile() !== true) return false;
    // An asar is at least the 16-byte pickle preamble plus a directory header.
    return info.size > 32;
  } catch {
    return false;
  }
}

/**
 * Locate the archive under a picked path, without checking its identity.
 *
 * @param {unknown} input
 * @returns {{ ok: true, installRoot: string, asarPath: string, shape: string, tried: string[] }
 *   | { ok: false, code: string, message: string, tried: string[] }}
 */
export function locateAsarUnder(input) {
  const tried = candidateAsarPaths(input);
  if (tried.length === 0) {
    return { ok: false, code: ERROR_CODES.EINVALID_INPUT, message: '请先填写安装目录', tried };
  }
  const picked = normalizeInputPath(input);
  for (const asarPath of tried) {
    if (!looksLikeResourcesArchive(asarPath)) continue;
    const resourcesDir = dirname(asarPath);
    const installRoot = dirname(resourcesDir);
    let shape = 'derived';
    if (picked.toLowerCase() === asarPath.toLowerCase()) shape = 'archive';
    else if (picked.toLowerCase() === installRoot.toLowerCase()) shape = 'install-root';
    else if (picked.toLowerCase() === resourcesDir.toLowerCase()) shape = 'resources-directory';
    return { ok: true, installRoot, asarPath, shape, tried };
  }
  return {
    ok: false,
    code: ERROR_CODES.EINSTALL_ROOT,
    message: `这个目录里没有 resources\\${ASAR_FILE_NAME}：${picked}`,
    tried,
  };
}

/**
 * Locate the install root AND prove the archive belongs to DSH desktop.
 *
 * Never throws: every failure is a plain object the client can render.
 *
 * @param {unknown} input
 * @returns {{
 *   ok: boolean,
 *   installRoot: string|null,
 *   asarPath: string|null,
 *   dshVersion: string|null,
 *   dshName: string|null,
 *   shape: string|null,
 *   code?: string,
 *   reason?: string,
 *   tried?: string[],
 * }}
 */
export function probeInstallPath(input) {
  const located = locateAsarUnder(input);
  if (located.ok !== true) {
    return {
      ok: false,
      installRoot: null,
      asarPath: null,
      dshVersion: null,
      dshName: null,
      shape: null,
      code: located.code,
      reason: located.message,
      tried: located.tried,
    };
  }

  const base = {
    installRoot: located.installRoot,
    asarPath: located.asarPath,
    shape: located.shape,
    tried: located.tried,
    dshVersion: null,
    dshName: null,
  };

  // A patched archive legitimately fails the stock integrity gate, and a
  // patched install must still be recognizable (status, restore, re-install
  // refreshing the bridge all need this).
  const asar = openAsar(located.asarPath, { allowStaleMainIntegrity: true });
  if (asar.ok !== true) {
    return {
      ...base,
      ok: false,
      code: asar.code ?? ERROR_CODES.EASAR_HEADER,
      reason: asar.message,
    };
  }

  try {
    const pkgText = readEntryText(asar, 'package.json');
    if (pkgText === null) {
      return { ...base, ok: false, code: ERROR_CODES.EASAR_HEADER, reason: 'asar 里没有 package.json' };
    }
    let pkg;
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      return { ...base, ok: false, code: ERROR_CODES.EASAR_HEADER, reason: 'asar 里的 package.json 不是合法 JSON' };
    }
    const version = typeof pkg.version === 'string' ? pkg.version : null;
    const name = typeof pkg.name === 'string' ? pkg.name : null;
    if (name !== DSH_DESKTOP_PACKAGE) {
      return {
        ...base,
        ok: false,
        dshVersion: version,
        dshName: name,
        code: ERROR_CODES.ENOT_DSH_DESKTOP,
        reason: `包名是 ${name ?? '(空)'}，不是 ${DSH_DESKTOP_PACKAGE}`,
      };
    }
    return { ...base, ok: true, dshVersion: version, dshName: name };
  } finally {
    closeAsar(asar);
  }
}

/**
 * The canonical install root for a picked path, or the input unchanged when it
 * cannot be resolved (so a later step can report the real problem with the
 * path the user actually typed).
 *
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeInstallRoot(input) {
  const located = locateAsarUnder(input);
  return located.ok === true ? located.installRoot : normalizeInputPath(input);
}
