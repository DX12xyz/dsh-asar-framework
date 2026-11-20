/**
 * What name is this plugin registered under, in the profile of this machine?
 *
 * WHY THIS FILE EXISTS
 *
 * The DSH Plugins page decides whether to render a bundle's settings card
 * (app.asar → @deepseek-ai/dsh-client-ui-plugin-manager, config-ledger.ts):
 *
 *   configured = ledger.bundles.has(openPkg.name)
 *   ledger.bundles = entries('plugins.bundle.config') with a `key` option
 *
 * The name on the left is what the Host reports for the bundle; the key on the
 * right is whatever the plugin wrote into `ctx.slots.register({ key: … })`.
 * When the two disagree — exactly what a package RENAME leaves behind (profile
 * still says `@local/dsh-asar-framework`, the bundle is now
 * `@dx12xyz/dsh-asar-framework`) — `configured` is false and the whole settings
 * card silently disappears. There is no error to read: the page just renders
 * without its configuration section.
 *
 * So the key must not be a constant. This module answers, from the profile
 * itself, which names the Host will report for this package:
 *
 *  (a) dependency keys whose value points at this package — `file:` and `link:`
 *      specs, path-normalized, because that is the rename trail: the KEY is the
 *      old name while the path is ours;
 *  (b) `dsh.profile.bundles` entries whose `node_modules/<entry>/package.json`
 *      carries OUR package name — this covers "the profile names us somewhere
 *      else and the installed copy is ours".
 *
 * Fail-soft by contract: any unreadable / absent / malformed input degrades to
 * `ok: false` with `registeredNames: [packageName]`, never an exception. The
 * caller (the Client half) therefore always has one usable key, so a failed
 * probe can only leave the card exactly as good as it was — never worse.
 *
 * Nothing here reads a hard-coded path: every input is derived from
 * `packageRoot`, which `package-root.js` already resolves.
 */
import { existsSync, readFileSync } from '../fs-safe.js';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** How far up from the package root the profile search may walk. */
const MAX_LEVELS = 6;

/**
 * One package name, scoped or plain.
 *
 * Mirrors `isUsableSlotKey` in `client.js` (the Client half is a separate
 * browser bundle and cannot import this file), and is applied here so an
 * implausible value from disk never becomes a slot key downstream.
 */
const SCOPED_NAME = /^(@[a-z0-9-_.]+)\/[\w.-]+$/;
const PLAIN_NAME = /^[\w.-]+$/;

/**
 * Is `value` a shape this package is willing to use as a slot key?
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUsablePackageName(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 200) return false;
  return SCOPED_NAME.test(value) || PLAIN_NAME.test(value);
}

/** Read a small JSON file; null on any problem (missing, EACCES, bad JSON). */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Strip one `file:` / `link:` prefix.
 *
 * Both spellings reach us: pnpm writes `file:…` for a copied directory and
 * `link:…` for a symlinked workspace package. A registry range (`^1.2.3`,
 * `git+https:…`) is NOT a path, so it returns null and can never be compared
 * against a directory.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function stripProtocol(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = /^(?:file|link):/i.exec(trimmed);
  const rest = match === null ? trimmed : trimmed.slice(match[0].length);
  if (rest.length === 0) return null;
  if (/^(?:\^|~|>|<|=|git\+|https?:|npm:)/i.test(rest)) return null;
  return rest;
}

/**
 * Normalized form used for path comparison.
 *
 * Rules, all deliberate:
 *  - one `file:` / `link:` prefix removed (see above);
 *  - a Windows drive letter counts as absolute even when this module happens to
 *    run on POSIX (resolving `Z:/…` against a POSIX base would drop the letter
 *    and never match);
 *  - relative specs are resolved against the profile directory;
 *  - `/` and `\` fold together, trailing separators are dropped and case is
 *    folded, because the profile may be written on one platform and read on
 *    another, and Windows paths are case-insensitive by definition.
 *
 * @param {unknown} value
 * @param {string} baseDir
 * @returns {string|null}
 */
export function normalizePathForCompare(value, baseDir) {
  const stripped = stripProtocol(value);
  if (stripped === null) return null;
  let full;
  try {
    full = /^[A-Za-z]:[\\/]/.test(stripped) || isAbsolute(stripped)
      ? stripped
      : resolve(baseDir, stripped);
  } catch {
    return null;
  }
  return full.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase();
}

/**
 * A candidate profile directory, verified by shape.
 *
 * The test is `package.json` + `dsh.profile.bundles` being an ARRAY. The second
 * half matters: plenty of directories on the way up carry a `package.json`,
 * but only a DSH profile carries the bundle list the Plugins page reads.
 *
 * @param {string} dir
 * @returns {{ dir: string, pkg: object, bundles: unknown[] }|null}
 */
function profileAt(dir) {
  const pkg = readJson(join(dir, 'package.json'));
  if (pkg === null || typeof pkg !== 'object') return null;
  const dsh = pkg.dsh;
  const profile = dsh !== null && typeof dsh === 'object' ? dsh.profile : undefined;
  const bundles = profile !== null && typeof profile === 'object' ? profile.bundles : undefined;
  if (!Array.isArray(bundles)) return null;
  return { dir, pkg, bundles };
}

/**
 * Walk up from `startDir` looking for the profile that declares bundles.
 * @param {string} startDir
 * @returns {{ dir: string, pkg: object, bundles: unknown[] }|null}
 */
function findProfile(startDir) {
  let cursor = startDir;
  for (let level = 0; level <= MAX_LEVELS; level += 1) {
    const found = profileAt(cursor);
    if (found !== null) return found;
    const parent = dirname(cursor);
    if (parent === cursor || parent.length === 0) return null;
    cursor = parent;
  }
  return null;
}

/** The failure shape: honest `ok: false`, but always a usable key. */
function fallback(packageName, reason, profileDir = null) {
  return {
    ok: false,
    packageName,
    registeredNames: packageName.length > 0 ? [packageName] : [],
    profileDir,
    reason,
  };
}

/**
 * Does a `file:` / `link:` dependency value name THIS package?
 *
 * Two independent proofs, either is enough:
 *  - the value's normalized path is the package root itself (a copied install
 *    where the dependency points at the same directory we run from), or
 *  - the directory it points at holds a `package.json` with our package name
 *    (a workspace install, where the profile points at the SOURCE package
 *    while `node_modules` holds a copy).
 *
 * @param {string} value
 * @param {string} profileDir
 * @param {string|null} packageRootPath
 * @param {string} packageName
 * @returns {boolean}
 */
function dependencyNamesUs(value, profileDir, packageRootPath, packageName) {
  if (packageRootPath !== null && normalizePathForCompare(value, profileDir) === packageRootPath) return true;
  const stripped = stripProtocol(value);
  if (stripped === null || packageRootPath === null) return false;
  const dir = /^[A-Za-z]:[\\/]/.test(stripped) || isAbsolute(stripped) ? stripped : resolve(profileDir, stripped);
  const pkg = readJson(join(dir, 'package.json'));
  return pkg !== null && typeof pkg === 'object' && pkg.name === packageName;
}

/**
 * Detect every name this package is registered under in the machine's profile.
 *
 * Never throws.
 *
 * @param {{ packageRoot?: string|null, packageName?: string|null }} [input]
 * @returns {{
 *   ok: boolean,
 *   packageName: string,
 *   registeredNames: string[],
 *   profileDir: string|null,
 *   reason: string,
 * }}
 */
export function detectRegisteredNames(input = {}) {
  const packageName = typeof input.packageName === 'string' ? input.packageName : '';
  if (!isUsablePackageName(packageName)) return fallback(packageName, '包名缺失或不合法，无法探测登记名');
  if (typeof input.packageRoot !== 'string' || input.packageRoot.length === 0) {
    return fallback(packageName, '没有给出包目录，无法探测登记名');
  }

  try {
    if (!existsSync(join(input.packageRoot, 'package.json'))) {
      return fallback(packageName, `包目录 ${input.packageRoot} 里没有 package.json`);
    }
    const profile = findProfile(input.packageRoot);
    if (profile === null) {
      return fallback(
        packageName,
        `从 ${input.packageRoot} 往上 ${MAX_LEVELS} 层都没有带 dsh.profile.bundles 的 package.json`,
      );
    }

    // The package's own name is ALWAYS in the set, added before anything else,
    // so even a partial probe leaves the caller one usable key.
    const names = new Set([packageName]);
    const packageRootPath = normalizePathForCompare(input.packageRoot, profile.dir);

    // (a) dependency keys whose value names this package.
    const dependencies = profile.pkg.dependencies;
    if (dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
      for (const [key, value] of Object.entries(dependencies)) {
        if (!isUsablePackageName(key)) continue;
        if (dependencyNamesUs(value, profile.dir, packageRootPath, packageName)) names.add(key);
      }
    }

    // (b) bundle entries whose installed package.json carries our name. Covers
    //     a profile that names us differently from the installed copy.
    for (const entry of profile.bundles) {
      if (!isUsablePackageName(entry)) continue;
      const installed = readJson(join(profile.dir, 'node_modules', ...entry.split('/'), 'package.json'));
      if (installed !== null && typeof installed === 'object' && installed.name === packageName) names.add(entry);
    }

    // Sorted, so two runs on the same machine produce the same list: the client
    // registers in this order and a support report stays comparable.
    return {
      ok: true,
      packageName,
      registeredNames: Array.from(names).sort(),
      profileDir: profile.dir,
      reason: '',
    };
  } catch (error) {
    return fallback(packageName, `探测登记名时出错：${error instanceof Error ? error.message : String(error)}`);
  }
}
