/**
 * Where is this plugin's own package root?
 *
 * The Host loads `index.js`, which then spawns `scripts/install.mjs` and reads
 * `lib/scan/picker.ps1`, `bridge/dist/tray-bridge.js` — all *inside the package*.
 * Deriving the root with a fixed number of `..` steps is fragile: `index.js`
 * sits at the root (0 steps up) while `lib/host/service.js` sits two levels down
 * (2 steps up), and getting the count wrong silently points at the parent
 * directory (`node_modules\@dx12xyz`), where `scripts/install.mjs` does not exist.
 *
 * So the root is *searched for* instead of computed: walk up from the caller's
 * directory until a directory that really is this package is found, verified by
 * its `package.json` name plus the two artefacts the Host needs at runtime.
 * Nothing is cached across package upgrades.
 */
import { existsSync, readFileSync } from '../fs-safe.js';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_NAME } from '../wire/constants.js';
import { ERROR_CODES, FrameworkError } from '../wire/errors.js';

/** How far up the search may walk before giving up. */
const MAX_LEVELS = 6;

/** Files that must exist for a directory to qualify as this package. */
const REQUIRED_FILES = [
  ['index.js'],
  ['scripts', 'install.mjs'],
];

/**
 * Directory of the module that calls this helper.
 *
 * @param {string|URL} moduleUrl `import.meta.url`
 * @returns {string}
 */
export function moduleDirOf(moduleUrl) {
  return dirname(fileURLToPath(moduleUrl));
}

/**
 * Is `dir` this package's root?
 *
 * `package.json` name is the identity check; the two runtime files are the
 * functional check, so a half-copied directory is rejected instead of accepted
 * and then failing on the first click.
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function looksLikePackageRoot(dir) {
  try {
    if (!existsSync(join(dir, 'package.json'))) return false;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pkg === null || typeof pkg !== 'object' || pkg.name !== PACKAGE_NAME) return false;
    return REQUIRED_FILES.every((parts) => existsSync(join(dir, ...parts)));
  } catch {
    return false;
  }
}

/**
 * Walk up from `startDir` looking for this package's root.
 *
 * @param {string} startDir
 * @returns {string|null}
 */
export function findPackageRoot(startDir) {
  let cursor = startDir;
  for (let level = 0; level <= MAX_LEVELS; level += 1) {
    if (looksLikePackageRoot(cursor)) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor || parent.length === 0) return null;
    // A drive root has no parent directory worth climbing into.
    if (parent.endsWith(sep) && parent.length <= 3) return null;
    cursor = parent;
  }
  return null;
}

/**
 * This package's root, resolved from a module URL.
 *
 * @param {string|URL} moduleUrl `import.meta.url` of the calling module
 * @returns {string}
 * @throws {FrameworkError} EPACKAGE_ROOT when it cannot be found
 */
export function packageRootFrom(moduleUrl) {
  const root = findPackageRoot(moduleDirOf(moduleUrl));
  if (root === null) {
    throw new FrameworkError(
      ERROR_CODES.EPACKAGE_ROOT,
      `找不到插件自己的安装目录（从 ${moduleDirOf(moduleUrl)} 往上都没有 ${PACKAGE_NAME}\\package.json）`,
    );
  }
  return root;
}
