/**
 * Auto scan: find DSH desktop install roots on every drive's first level.
 *
 * Matching is intentionally loose on the *name* and strict on the *identity*:
 * a directory whose name looks like DSH is only accepted when its
 * `resources/app.asar` contains a `package.json` with
 * `name === "@deepseek-ai/dsh-desktop"`.
 */
import { existsSync, readdirSync, statSync } from '../fs-safe.js';
import { dirname, join } from 'node:path';

import { SCAN_NAME_PATTERNS } from '../wire/constants.js';
import { ERROR_CODES } from '../wire/errors.js';
import { probeInstallPath, RESOURCES_DIR_NAME, ASAR_FILE_NAME } from './resolve.js';

/** Directory names that are never worth scanning. */
const SKIP_NAMES = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'windows.old',
  'node_modules',
]);

/** Upper bound on sub-entries inspected per matched directory. */
const MAX_CHILD_DIRS = 40;

/**
 * Does a directory name look like a DSH desktop install directory?
 * All comparisons are lowercase; `-` and `_` variants are accepted.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function looksLikeDshName(name) {
  const lower = name.toLowerCase();
  if (SKIP_NAMES.has(lower)) return false;
  return SCAN_NAME_PATTERNS.some((pattern) => {
    if (lower === pattern) return true;
    // The pattern may be followed by a variant separator plus a suffix,
    // e.g. "dsh-harness", "dsh_d", "deepseekharness-desktop".
    if (lower.startsWith(`${pattern}-`) || lower.startsWith(`${pattern}_`)) return true;
    // And the reverse: "...-deepseekharness-desktop" style compounds.
    if (lower.endsWith(`-${pattern}`) || lower.endsWith(`_${pattern}`)) return true;
    return false;
  });
}

/**
 * Probe one candidate install root.
 *
 * A candidate may be the install root itself (`…\DeepSeekHarness-Desktop`) or
 * anything inside it, including the `resources` directory, so the actual
 * normalization is delegated to {@link probeInstallPath}. The returned `root`
 * is always the canonical install root, never the picked path.
 *
 * @param {string} root
 * @returns {{ root: string, asarPath: string|null, ok: boolean, dshVersion: string|null, reason?: string, code?: string }}
 */
export function probeRoot(root) {
  const probed = probeInstallPath(root);
  if (probed.ok === true) {
    return {
      root: probed.installRoot,
      asarPath: probed.asarPath,
      ok: true,
      dshVersion: probed.dshVersion,
      shape: probed.shape,
    };
  }
  return {
    root: probed.installRoot ?? root,
    asarPath: probed.asarPath,
    ok: false,
    dshVersion: probed.dshVersion,
    reason: probed.reason,
    code: probed.code,
  };
}

/**
 * Candidate directories for one drive root.
 *
 * @param {string} driveRoot e.g. `<盘符>:\`
 * @returns {string[]}
 */
function candidatesOnDrive(driveRoot) {
  const found = [];
  let names;
  try {
    names = readdirSync(driveRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const dirent of names) {
    if (!dirent.isDirectory()) continue;
    if (SKIP_NAMES.has(dirent.name.toLowerCase())) continue;
    const top = join(driveRoot, dirent.name);
    if (looksLikeDshName(dirent.name)) found.push(top);

    // One level down: "<盘符>:\SomeFolder\DeepSeekHarness-Desktop" style layouts.
    // Also catch a matched directory that IS a resources folder, whose parent
    // is the install root.
    if (dirent.name.toLowerCase() === RESOURCES_DIR_NAME) {
      const parent = dirname(top);
      if (existsSync(join(top, ASAR_FILE_NAME))) found.push(parent);
      continue;
    }
    let children;
    try {
      children = readdirSync(top, { withFileTypes: true });
    } catch {
      continue;
    }
    let inspected = 0;
    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (inspected >= MAX_CHILD_DIRS) break;
      inspected += 1;
      if (!looksLikeDshName(child.name)) continue;
      found.push(join(top, child.name));
    }
  }
  return found;
}

/**
 * Every readable drive root (`<盘符>:\`, one per letter).
 * @returns {string[]}
 */
export function listDrives() {
  const roots = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try {
      if (existsSync(root)) {
        // existsSync on a disconnected network drive can be slow; a stat is enough.
        statSync(root);
        roots.push(root);
      }
    } catch {
      /* not a readable drive */
    }
  }
  return roots;
}

/**
 * Derive the install root from the running executable path.
 *
 * Three shapes are worth trying, cheapest first:
 *  1. Electron's own `process.resourcesPath` — exactly the resources directory;
 *  2. the executable's own directory, when `resources\app.asar` sits beside it;
 *  3. a path segment literally named `resources` (the Host checkout shape
 *     `…\resources\app.asar\dsh\…`).
 *
 * @param {{ execPath?: string, resourcesPath?: string }} [input]
 * @returns {string|null}
 */
export function deriveInstallRootFromProcess(input = {}) {
  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    if (existsSync(join(resourcesPath, 'app.asar'))) return dirname(resourcesPath);
  }

  const execPath = input.execPath ?? process.execPath;
  if (typeof execPath !== 'string' || execPath.length === 0) return null;

  // The desktop executable normally sits directly in the install root.
  const exeDir = dirname(execPath);
  if (existsSync(join(exeDir, 'resources', 'app.asar'))) return exeDir;

  const parts = execPath.split(/[\\/]/);
  // ...\resources\app.asar\dsh\... is the Host's checkout; walk up until a
  // `resources` segment is found and take everything above it.
  for (let index = parts.length - 1; index >= 2; index -= 1) {
    if (parts[index].toLowerCase() === 'resources') {
      return parts.slice(0, index).join('\\');
    }
  }
  return null;
}

/**
 * Scan every drive for DSH desktop install roots.
 *
 * @param {{ drives?: string[], extraRoots?: string[], onCandidate?: (c: object) => void }} [options]
 * @returns {{ ok: true, candidates: object[], scannedCount: number, scanErrors: string[] }}
 */
export function scanInstallRoots(options = {}) {
  const drives = Array.isArray(options.drives) && options.drives.length > 0 ? options.drives : listDrives();
  const extraRoots = Array.isArray(options.extraRoots) ? options.extraRoots : [];
  const candidates = [];
  const scanErrors = [];
  let scannedCount = 0;

  const seen = new Set();
  const consider = (root) => {
    const normalized = root.replace(/[\\/]+$/, '');
    if (seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());
    scannedCount += 1;
    const candidate = probeRoot(normalized);
    // Deduplicate by the canonical install root: two candidate names can point
    // at the same installation ("…\DeepSeekHarness-Desktop" and a second name
    // for the same directory), and offering it twice would be confusing.
    const key = String(candidate.root ?? normalized).toLowerCase();
    if (seen.has(`#${key}`)) return;
    seen.add(`#${key}`);
    candidates.push(candidate);
    if (typeof options.onCandidate === 'function') options.onCandidate(candidate);
  };

  for (const root of extraRoots) {
    if (typeof root === 'string' && root.length > 0) consider(root);
  }
  const fromProcess = deriveInstallRootFromProcess();
  if (fromProcess !== null && fromProcess.length > 0) consider(fromProcess);

  for (const drive of drives) {
    try {
      for (const candidate of candidatesOnDrive(drive)) consider(candidate);
    } catch (error) {
      scanErrors.push(`${drive}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ok: true,
    candidates,
    scannedCount,
    scanErrors,
    code: candidates.some((candidate) => candidate.ok === true) ? undefined : ERROR_CODES.ESCAN_EMPTY,
  };
}
