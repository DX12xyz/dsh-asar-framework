/**
 * The DSH desktop install this run should look at, taken from the environment.
 *
 * The suite opens real archives (read-only) for the tests that describe a
 * shipped release, so it needs one real path. That path is NOT written into the
 * source; it is resolved here, in this order:
 *
 *   1. `DSH_DESKTOP_ROOT` — point the suite at any install root:
 *        $env:DSH_DESKTOP_ROOT = '<DSH安装目录>'
 *   2. `DSH_NODE_EXECUTABLE` — exported by DSH to its subprocesses and set to
 *      the desktop executable, so its directory is the install root.
 *   3. nothing — the value is `''`, and the real-archive tests skip instead of
 *      guessing at a path that may not exist.
 *
 * Nothing here is production code: `lib/wire/shells.js` carries the per-release
 * facts and stays free of machine paths.
 */
import { dirname, join } from 'node:path';

/** The install root for this run, or `''` when the environment names none. */
export const INSTALL_ROOT = (() => {
  const explicit = process.env.DSH_DESKTOP_ROOT;
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  const exe = process.env.DSH_NODE_EXECUTABLE;
  if (typeof exe === 'string' && exe.trim() !== '') return dirname(exe.trim());
  return '';
})();

/** `.../resources` inside that root, or `''` when the root is unknown. */
export const RESOURCES_DIR = INSTALL_ROOT === '' ? '' : join(INSTALL_ROOT, 'resources');

/** The live archive, or `''` when the install root is unknown. */
export const LIVE_ASAR = RESOURCES_DIR === '' ? '' : join(RESOURCES_DIR, 'app.asar');
