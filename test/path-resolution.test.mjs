/**
 * Tests for the two path layers that made the first real-machine install fail:
 *
 *  1. `packageRootFrom` — the plugin must find its OWN root by identity, not by
 *     counting `..` steps (the old code resolved to `node_modules\@local` and
 *     then reported "安装器不存在").
 *  2. `probeInstallPath` / `probeRoot` — a human may pick the install root, the
 *     `resources` directory, or the archive itself, and all three must resolve
 *     to the same canonical install root while still proving DSH identity.
 *
 * Synthetic archives are built here, so no test touches the real DSH install.
 *
 * `node --test --test-isolation=none test/path-resolution.test.mjs`
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from '../lib/fs-safe.js';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { findPackageRoot, looksLikePackageRoot, moduleDirOf } from '../lib/host/package-root.js';
import { candidateAsarPaths, locateAsarUnder, normalizeInputPath, probeInstallPath } from '../lib/scan/resolve.js';
import { probeRoot } from '../lib/scan/scan.js';

/** sha256 of a buffer, lowercase hex. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Build a minimal but structurally valid asar holding one package.json and one
 * lib/main.js whose digest matches the directory.
 *
 * @param {{ name?: string, version?: string }} pkg
 * @returns {Buffer}
 */
function buildAsar(pkg) {
  const pkgBody = Buffer.from(JSON.stringify({
    name: pkg.name ?? '@deepseek-ai/dsh-desktop',
    version: pkg.version ?? '0.2.2-rc.2',
    main: 'lib/main.js',
  }), 'utf8');
  const mainBody = Buffer.from('//#region lib/types/tray.js\nexport const x = 1;\n//#endregion\n', 'utf8');

  const header = Buffer.from(JSON.stringify({
    files: {
      'package.json': {
        size: pkgBody.length,
        offset: 0,
        integrity: { algorithm: 'SHA256', hash: sha256(pkgBody), blockSize: 4194304, blocks: [sha256(pkgBody)] },
      },
      lib: {
        files: {
          'main.js': {
            size: mainBody.length,
            offset: pkgBody.length,
            integrity: { algorithm: 'SHA256', hash: sha256(mainBody), blockSize: 4194304, blocks: [sha256(mainBody)] },
          },
        },
      },
    },
  }), 'utf8');
  const headerPadded = header.length + ((4 - (header.length % 4)) % 4);

  const preamble = Buffer.alloc(16);
  preamble.writeUInt32LE(4, 0);
  preamble.writeUInt32LE(header.length + 4, 4);
  preamble.writeUInt32LE(header.length, 8);
  preamble.writeUInt32LE(header.length, 12);

  const headerBlock = Buffer.concat([header, Buffer.alloc(headerPadded - header.length, 0)]);
  return Buffer.concat([preamble, headerBlock, pkgBody, mainBody]);
}

/** Run a body inside a temp directory that is always removed. */
async function withScratch(body) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-paths-'));
  try {
    return await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write `<dir>/<appName>/resources/app.asar`.
 *
 * @param {string} dir
 * @param {string} appName
 * @param {{ name?: string, version?: string }} [pkg]
 * @returns {{ installRoot: string, resourcesDir: string, asarPath: string }}
 */
function writeApp(dir, appName, pkg) {
  const installRoot = path.join(dir, appName);
  const resourcesDir = path.join(installRoot, 'resources');
  mkdirSync(resourcesDir, { recursive: true });
  const asarPath = path.join(resourcesDir, 'app.asar');
  writeFileSync(asarPath, buildAsar(pkg ?? {}));
  return { installRoot, resourcesDir, asarPath };
}

// ------------------------------------------------------------ package root --

test('this checkout\'s own package root is found by walking up from a module', () => {
  const here = moduleDirOf(new URL(import.meta.url).href);
  const root = findPackageRoot(here);
  assert.notEqual(root, null, 'the test runs from <package>/test/, so the root must be findable');
  assert.equal(looksLikePackageRoot(root), true);
  // The two runtime artefacts the Host needs must both be there.
  //
  // The directory NAME is not asserted on purpose: the same sources run in two
  // checkouts — the development repository, where the package sits in `pkg/`,
  // and the published repository, where the package IS the repository root.
  // Pinning `pkg` here would make the published repo's CI fail on a fact that
  // is not part of the package's identity; the manifest name is.
  assert.equal(typeof JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name, 'string');
});

test('a fixed "two levels up" walk would land on the WRONG directory', () => {
  // This is the bug the real machine hit: `@local/dsh-asar-framework/index.js`
  // walked up twice and produced `…\node_modules\@local`, where no
  // scripts/install.mjs exists. Prove the identity search rejects that path.
  // (The installed name is now `@dx12xyz/dsh-asar-framework`; the shape of the
  // bug — landing on `node_modules\<scope>` instead of the package directory —
  // is the same for any scope and any name, and that is what this case pins.)
  const root = findPackageRoot(moduleDirOf(new URL(import.meta.url).href));
  const parentOfRoot = path.dirname(root);
  assert.equal(looksLikePackageRoot(parentOfRoot), false, 'the parent directory is not this package');
  assert.equal(looksLikePackageRoot(path.dirname(parentOfRoot)), false);
});

test('modules at different depths agree on the same package root', () => {
  // index.js sits AT the root and lib/host/service.js sits two levels down; a
  // fixed number of `..` steps cannot satisfy both, the search does.
  const root = findPackageRoot(moduleDirOf(new URL(import.meta.url).href));
  const fromRootFile = findPackageRoot(root);
  const fromDeepModule = findPackageRoot(path.join(root, 'lib', 'host'));
  const fromTestDir = findPackageRoot(path.join(root, 'test'));
  assert.equal(fromRootFile, root);
  assert.equal(fromDeepModule, root);
  assert.equal(fromTestDir, root);
});

test('a directory without the required files is not accepted as the package root', () =>
  withScratch(async (dir) => {
    const fake = path.join(dir, 'fake-package');
    mkdirSync(fake, { recursive: true });
    writeFileSync(path.join(fake, 'package.json'), JSON.stringify({ name: '@dx12xyz/dsh-asar-framework' }), 'utf8');
    assert.equal(looksLikePackageRoot(fake), false, 'package.json alone is not enough');
    // Half a copy: the marker file exists but the installer does not.
    mkdirSync(path.join(fake, 'scripts'), { recursive: true });
    writeFileSync(path.join(fake, 'index.js'), 'export const x = 1;\n', 'utf8');
    assert.equal(looksLikePackageRoot(fake), false, 'without scripts/install.mjs it is still not usable');
    writeFileSync(path.join(fake, 'scripts', 'install.mjs'), 'export const y = 2;\n', 'utf8');
    assert.equal(looksLikePackageRoot(fake), true, 'a complete copy is accepted');
    // Walking up from anywhere INSIDE it lands on it …
    assert.equal(findPackageRoot(path.join(fake, 'lib', 'host')), fake);
    // … but a sibling directory does not borrow its identity.
    mkdirSync(path.join(dir, 'sibling', 'lib', 'host'), { recursive: true });
    assert.equal(findPackageRoot(path.join(dir, 'sibling', 'lib', 'host')), null, 'an unrelated tree must not resolve');
  }));

// --------------------------------------------------------------- install path --

test('normalizeInputPath accepts slashes, trailing separators and padding', () => {
  assert.equal(normalizeInputPath('  <盘符>:/DSH/  '), '<盘符>:\\DSH');
  assert.equal(normalizeInputPath('<盘符>:\\A\\\\B\\'), '<盘符>:\\A\\\\B');
  assert.equal(normalizeInputPath(''), '');
  assert.equal(normalizeInputPath(null), '');
  // A bare drive root is exactly three characters, so the trailing-separator
  // trim (which keeps the string above three) must leave it alone. Any letter
  // does; the point is the shape, not a machine.
  assert.equal(normalizeInputPath('Q:\\'), 'Q:\\', 'a bare drive root keeps its separator');
});

test('candidateAsarPaths covers root, resources, archive and a folder inside resources', () =>
  withScratch(async (dir) => {
    const { installRoot, resourcesDir, asarPath } = writeApp(dir, 'DeepSeekHarness-Desktop');
    const expected = asarPath.toLowerCase();

    for (const picked of [installRoot, resourcesDir, asarPath, path.join(resourcesDir, 'nested')]) {
      const candidates = candidateAsarPaths(picked).map((value) => value.toLowerCase());
      assert.ok(candidates.includes(expected), `picked ${picked} must offer ${asarPath}`);
    }
    assert.deepEqual(candidateAsarPaths(''), []);
  }));

test('all three picked shapes resolve to the same canonical install root', () =>
  withScratch(async (dir) => {
    const { installRoot, resourcesDir, asarPath } = writeApp(dir, 'DeepSeekHarness-Desktop');

    const fromRoot = locateAsarUnder(installRoot);
    const fromResources = locateAsarUnder(resourcesDir);
    const fromArchive = locateAsarUnder(asarPath);

    assert.equal(fromRoot.ok, true);
    assert.equal(fromResources.ok, true);
    assert.equal(fromArchive.ok, true);
    assert.equal(fromRoot.installRoot.toLowerCase(), installRoot.toLowerCase());
    assert.equal(fromResources.installRoot.toLowerCase(), installRoot.toLowerCase());
    assert.equal(fromArchive.installRoot.toLowerCase(), installRoot.toLowerCase());
    assert.equal(fromResources.shape, 'resources-directory');
    assert.equal(fromArchive.shape, 'archive');
    assert.equal(fromRoot.shape, 'install-root');
  }));

test('the archive must sit directly in a directory named resources', () =>
  withScratch(async (dir) => {
    // A `app.asar` in a folder that is NOT called resources would break the
    // unpacked bridge path, so it is refused even though the file exists.
    const elsewhere = path.join(dir, 'RandomApp');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(path.join(elsewhere, 'app.asar'), buildAsar({}), 'utf8');
    const located = locateAsarUnder(elsewhere);
    assert.equal(located.ok, false);
    assert.equal(located.code, 'EINSTALL_ROOT');
    assert.ok(Array.isArray(located.tried) && located.tried.length > 0);
  }));

test('probeInstallPath accepts the DSH desktop package and reports its version', () =>
  withScratch(async (dir) => {
    const { installRoot, resourcesDir } = writeApp(dir, 'DeepSeekHarness-Desktop', { version: '0.2.2-rc.2' });
    for (const picked of [installRoot, resourcesDir]) {
      const probed = probeInstallPath(picked);
      assert.equal(probed.ok, true, probed.reason ?? '');
      assert.equal(probed.dshName, '@deepseek-ai/dsh-desktop');
      assert.equal(probed.dshVersion, '0.2.2-rc.2');
      assert.equal(probed.installRoot.toLowerCase(), installRoot.toLowerCase());
    }
  }));

test('probeInstallPath rejects another Electron app that also ships resources\\app.asar', () =>
  withScratch(async (dir) => {
    const { installRoot } = writeApp(dir, 'SomeOtherElectronApp', { name: 'com.example.other', version: '9.9.9' });
    const probed = probeInstallPath(installRoot);
    assert.equal(probed.ok, false);
    assert.equal(probed.code, 'ENOT_DSH_DESKTOP');
    assert.equal(probed.dshName, 'com.example.other');
    assert.match(probed.reason, /@deepseek-ai\/dsh-desktop/);
  }));

test('probeInstallPath on a directory with no archive explains what it tried', () =>
  withScratch(async (dir) => {
    const empty = path.join(dir, 'EmptyFolder');
    mkdirSync(empty, { recursive: true });
    const probed = probeInstallPath(empty);
    assert.equal(probed.ok, false);
    assert.equal(probed.code, 'EINSTALL_ROOT');
    assert.ok(probed.tried.length > 0);
    assert.match(probed.reason, /app\.asar/);
  }));

test('probeRoot answers with the canonical root, not the picked path', () =>
  withScratch(async (dir) => {
    const { installRoot, resourcesDir } = writeApp(dir, 'DeepSeekHarness-Desktop');
    const candidate = probeRoot(resourcesDir);
    assert.equal(candidate.ok, true);
    assert.equal(candidate.root.toLowerCase(), installRoot.toLowerCase());
    assert.equal(candidate.dshVersion, '0.2.2-rc.2');
  }));
