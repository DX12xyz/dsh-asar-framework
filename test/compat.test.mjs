/**
 * Compatibility-gate tests: what `assessSupport` must answer for the releases
 * that exist, and for the shapes a future release might take.
 *
 * The gate decides whether the installer writes to a real installed archive, so
 * the tests are split by what they need:
 *
 *  - table-level (always runs): verdicts computed from the registry facts plus
 *    whatever classification shape a future release could produce;
 *  - real-archive (skips when the archive is absent): the same verdicts computed
 *    from an actual `classifyAsar` result and an actual `lib/main.js` text, so
 *    the "verified" answer is proven against the bytes on disk, not against
 *    numbers copied from the registry.
 *
 * Nothing here writes anything: both real archives are opened read-only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from '../lib/fs-safe.js';

import { assessSupport, missingPatchDependencies, PATCH_DEPENDENCIES } from '../lib/host/compat.js';
import { classifyAsar } from '../lib/asar/classify.js';
import { closeAsar, openAsar, readEntryText, readRootPackage } from '../lib/asar/reader.js';
import {
  FAMILIAR_SLOT_LENGTHS,
  FAMILIAR_SLOT_SHA256S,
  KNOWN_SHELLS,
  KNOWN_VERSIONS,
  shellFacts,
} from '../lib/wire/shells.js';
import { LIVE_ASAR, RC2_ASAR, currentBuildRegionSha, missingAsar, readState, shellGate } from './real-asar.mjs';

/** The two releases this suite can describe from the registry alone. */
const RC2 = KNOWN_SHELLS['0.2.2-rc.2'];
const RC3 = KNOWN_SHELLS['0.2.2-rc.3'];

/** Where the two real archives are, or a skip reason when one is absent. */
const realArchives = [
  { version: '0.2.2-rc.2', path: RC2_ASAR, skip: existsSync(RC2_ASAR) ? false : `没有保留 ${RC2_ASAR}` },
  { version: '0.2.2-rc.3', path: LIVE_ASAR, skip: missingAsar ? `没有线上安装 ${LIVE_ASAR}` : false },
];

/**
 * Read what the gate needs from a real archive: the version it reports, the
 * classification of its slot, and the official `lib/main.js` text.
 *
 * Read-only; the descriptor is closed in `finally`.
 *
 * @param {string} path
 * @returns {{ version: string|null, classification: object, mainText: string|null }}
 */
function readArchiveFacts(path) {
  const opened = openAsar(path, { allowStaleMainIntegrity: true });
  assert.equal(opened.ok, true, opened.ok === true ? '' : `${path}: ${opened.code}: ${opened.message}`);
  try {
    const pkg = readRootPackage(opened);
    return {
      version: pkg !== null && typeof pkg.version === 'string' ? pkg.version : null,
      classification: classifyAsar(opened),
      mainText: readEntryText(opened, 'lib/main.js'),
    };
  } finally {
    closeAsar(opened);
  }
}

/**
 * A `stock` classification with the given slot facts — the shape `classifyAsar`
 * produces for a release nobody has looked at yet.
 *
 * @param {{ length: number, sha256: string }} slot
 * @returns {object}
 */
function stockClassification(slot) {
  return { state: 'stock', reason: '托盘槽位是官方原样', length: slot.length, sha256: slot.sha256 };
}

/** The canonical `lib/main.js` of a release, built from the nine names. */
function syntheticMainText() {
  return `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const resolvePath = (...parts) => resolve(process.resourcesPath, ...parts);
const tray = new Tray(nativeImage.createFromPath(iconPath));
tray.setContextMenu(Menu.buildFromTemplate([]));
app.on("quit", () => {});
const where = import.meta.url;
void process;
`;
}

test('rc.2 and rc.3 registry facts are verified, with no warnings', { skip: !shellFacts('0.2.2-rc.2') }, () => {
  // Table-level half: the answer for a registered release whose slot length and
  // slot digest are both in the verified set must be silent permission.
  for (const shell of [RC2, RC3]) {
    const result = assessSupport({
      version: shell.version,
      classification: stockClassification({ length: shell.stock.slotLength, sha256: shell.stock.slotSha }),
      mainText: syntheticMainText(),
    });
    assert.equal(result.level, 'verified', `${shell.version}: ${result.warnings.join(' | ')}`);
    assert.equal(result.allowed, true);
    assert.equal(result.knownVersion, true);
    assert.equal(result.slotLengthFamiliar, true);
    assert.equal(result.slotShaFamiliar, true);
    assert.deepEqual(result.missingDependencies, []);
    assert.deepEqual(result.warnings, [], `${shell.version} must not warn: a verified release writes silently`);
    assert.equal(typeof result.summary, 'string');
    assert.ok(result.summary.length > 0);
    assert.equal(result.version, shell.version);
  }
  // A `patched-by-us` archive is the same release: reloading while patched must
  // not look LESS trustworthy than installing onto stock, and it must reach the
  // same `verified` verdict. The slot then carries OUR digest rather than the
  // stock one, so the gate has to accept "the bytes are exactly what this build
  // produces" as the equivalent proof — otherwise every healthy installed
  // machine would be warned about forever.
  const patched = assessSupport({
    version: RC3.version,
    classification: {
      state: 'patched-by-us',
      reason: '托盘槽位里已是我们写入的补丁标记',
      length: RC3.stock.slotLength,
      sha256: RC3.patched.regionSha,
      matchesExpectedPatch: true,
    },
    mainText: syntheticMainText(),
  });
  assert.equal(patched.allowed, true, 'patched-by-us is writable');
  assert.equal(patched.level, 'verified', `patched-by-us must stay verified: ${patched.warnings.join(' | ')}`);
  assert.equal(patched.slotShaFamiliar, true, 'our own patch digest is familiar by definition');
  assert.deepEqual(patched.warnings, [], 'an installed machine must not be warned about');

  // The other half of that rule: a slot that carries our marker but whose bytes
  // are NOT what this build produces (an older or hand-edited patch) is written
  // to, but must be reported as unverified.
  const stalePatch = assessSupport({
    version: RC3.version,
    classification: {
      state: 'patched-by-us',
      reason: '托盘槽位里已是我们写入的补丁标记',
      length: RC3.stock.slotLength,
      sha256: 'f'.repeat(64),
      matchesExpectedPatch: false,
    },
    mainText: syntheticMainText(),
  });
  assert.equal(stalePatch.allowed, true);
  assert.equal(stalePatch.level, 'unverified');
  assert.equal(stalePatch.warnings.length, 1, 'a stale patch gets exactly one warning');
});

test('on disk: both real archives assess as verified', { skip: realArchives[0].skip && realArchives[1].skip ? '两份真实档案都不在' : false }, async (t) => {
  for (const { version, path, skip } of realArchives) {
    if (skip !== false) {
      t.diagnostic(`${version}: skipped — ${skip}`);
      continue;
    }
    const facts = readArchiveFacts(path);
    // The archive's own package.json must say the version the table claims, else
    // the "verified" verdict would be about a different release than the name.
    if (facts.version !== version) {
      t.diagnostic(`${path} reports ${facts.version}, not ${version}; skipped`);
      continue;
    }
    const result = assessSupport(facts);

    // The point of the layout-aware gate: an INSTALLED machine must never be
    // treated as broken, and for a split install the verdict is decided by
    // whether the REGION is what this build writes.
    //
    // That makes the expectation two-sided, and both sides are pinned exactly —
    // the archive's own state decides which one applies, so this still fails
    // loudly on any drift in `assessSupport`:
    //   region == current build   -> verified, zero warnings (silent install)
    //   region from an older build -> unverified, allowed, exactly one warning
    //                                naming the region
    // The second branch is not a weakening: `assessSupport` documents it (see the
    // table-level test above: "a slot that carries our marker but whose bytes are
    // NOT what this build produces ... must be reported as unverified"), and
    // `buildSplitRegion` is a source that legitimately changes after an install.
    // Anything else — `incompatible`, a missing warning, a warning about the
    // official slot — is a real defect and fails here.
    if (facts.classification.layout === 'split') {
      const current = readState(path);
      const split = KNOWN_SHELLS[version].split;
      assert.equal(current.archiveSize, split.archiveSizeAfter, `${version}: split archive must be stock + ${split.reserveBytes}`);
      assert.equal(current.mainSize, split.mainSizeAfter, `${version}: split lib/main.js must be stock + ${split.reserveBytes}`);
      assert.equal(current.regionSha, split.slotSha, `${version}: the official slot must still be the stock one`);
      assert.equal(current.splitStartInMain, split.insertAtInMain, `${version}: the region must start where the slot ends`);

      const regionIsCurrent = current.splitSha256 === currentBuildRegionSha(current.splitLength);
      if (!regionIsCurrent) {
        t.diagnostic(`${version}: 已安装的区域早于当前构建（region ${String(current.splitSha256).slice(0, 8)}…，`
          + `本构建 ${String(currentBuildRegionSha(current.splitLength)).slice(0, 8)}…），需要重装才能刷新`);
      }
      assert.equal(result.level, regionIsCurrent ? 'verified' : 'unverified',
        `${version}: a ${regionIsCurrent ? 'current-build' : 'stale-but-healthy'} split install must assess as `
        + `${regionIsCurrent ? 'verified' : 'unverified'}, not ${result.level}: ${result.warnings.join(' | ')}`);
      assert.equal(result.allowed, true, `${version}: an installed split machine must stay writable`);
      assert.equal(result.slotLengthFamiliar, true, `${version}: the official slot length is still the verified one`);
      // The official slot is stock in BOTH branches; only the region can differ.
      // `assessSupport` folds the two into `slotShaFamiliar`, so the split layout
      // is familiar exactly when the region is this build's.
      assert.equal(result.slotShaFamiliar, regionIsCurrent,
        `${version}: slotShaFamiliar must follow the region, since the official slot is stock`);
      assert.equal(result.warnings.length, regionIsCurrent ? 0 : 1,
        `${version}: ${regionIsCurrent ? 'no warning for our own current build' : 'exactly one warning for an older region'}`);
      if (!regionIsCurrent) {
        assert.ok(result.warnings[0].includes('区域'), `${version}: the warning must name the region: ${result.warnings[0]}`);
        assert.ok(!result.warnings[0].includes('托盘槽位内容'), `${version}: the warning must not blame the official slot`);
      }
      assert.deepEqual(result.missingDependencies, [], `${version}: every patch dependency must exist in the real main.js`);
      assert.deepEqual(missingPatchDependencies(facts.mainText), []);
      continue;
    }

    assert.equal(result.level, 'verified', `${version}: ${result.warnings.join(' | ')}`);
    assert.equal(result.allowed, true);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.slotLengthFamiliar, true, `${version}: real slot length must be a verified length`);
    assert.equal(result.slotShaFamiliar, true, `${version}: real slot digest must be a verified digest`);
    assert.deepEqual(result.missingDependencies, [], `${version}: every patch dependency must exist in the real main.js`);
    // Sanity: the real file really carries all nine names (the gate reads this).
    assert.deepEqual(missingPatchDependencies(facts.mainText), []);
  }
  assert.equal(FAMILIAR_SLOT_LENGTHS.includes(RC3.stock.slotLength), true);
});

test('an unregistered version with a familiar slot is unverified, allowed, exactly one warning', () => {
  const result = assessSupport({
    version: '0.2.2-rc.9-not-registered',
    classification: stockClassification({ length: RC3.stock.slotLength, sha256: RC3.stock.slotSha }),
    mainText: syntheticMainText(),
  });
  assert.equal(result.level, 'unverified');
  assert.equal(result.allowed, true, 'an unknown version whose slot looks official must still be installable');
  assert.equal(result.knownVersion, false);
  assert.equal(result.slotLengthFamiliar, true);
  assert.equal(result.slotShaFamiliar, true);
  assert.equal(result.warnings.length, 1, 'only the version is new, so only that is warned about');
  assert.ok(result.warnings[0].includes('0.2.2-rc.9-not-registered'), 'the warning must name the version');
  assert.ok(result.warnings[0].includes('没有登记过'));
  assert.equal(typeof result.summary, 'string');
});

test('an unregistered version with no version string at all still warns once', () => {
  const result = assessSupport({
    classification: stockClassification({ length: RC3.stock.slotLength, sha256: RC3.stock.slotSha }),
    mainText: syntheticMainText(),
  });
  assert.equal(result.level, 'unverified');
  assert.equal(result.allowed, true);
  assert.equal(result.version, null);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('未知'), 'a missing version must be named 未知, not "null"');
});

test('an unfamiliar slot length is unverified with a length warning', () => {
  const result = assessSupport({
    version: RC3.version,
    classification: stockClassification({ length: RC3.stock.slotLength + 40, sha256: RC3.stock.slotSha }),
    mainText: syntheticMainText(),
  });
  assert.equal(result.level, 'unverified');
  assert.equal(result.allowed, true);
  assert.equal(result.knownVersion, true);
  assert.equal(result.slotLengthFamiliar, false);
  assert.equal(result.slotShaFamiliar, true);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes(String(RC3.stock.slotLength + 40)), 'the warning must name the measured length');
  assert.ok(result.warnings[0].includes(FAMILIAR_SLOT_LENGTHS.join('、')), 'the warning must name the verified lengths');
});

test('an unfamiliar slot digest is unverified with a digest warning', () => {
  const otherSha = 'abcdef0123456789'.repeat(4);
  const result = assessSupport({
    version: RC3.version,
    classification: stockClassification({ length: RC3.stock.slotLength, sha256: otherSha }),
    mainText: syntheticMainText(),
  });
  assert.equal(result.level, 'unverified');
  assert.equal(result.allowed, true);
  assert.equal(result.knownVersion, true);
  assert.equal(result.slotLengthFamiliar, true);
  assert.equal(result.slotShaFamiliar, false);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes(otherSha.slice(0, 8)), 'the warning must name the digest prefix');
  assert.ok(result.warnings[0].includes('…'), 'the digest must be abbreviated, not pasted whole');
});

test('every unfamiliar fact is warned about, one warning each', () => {
  const result = assessSupport({
    version: '9.9.9',
    classification: stockClassification({ length: 999, sha256: '0'.repeat(64) }),
    mainText: syntheticMainText(),
  });
  assert.equal(result.level, 'unverified');
  assert.equal(result.allowed, true);
  assert.equal(result.knownVersion, false);
  assert.equal(result.slotLengthFamiliar, false);
  assert.equal(result.slotShaFamiliar, false);
  assert.equal(result.warnings.length, 3, 'version + length + digest are three separate facts');
});

test('a stock classification with no slot facts is unverified, not verified', () => {
  // `classifyAsar` can return `stock` without length/sha only if it is lying;
  // the gate must not turn missing evidence into a silent install.
  const result = assessSupport({ version: RC3.version, classification: { state: 'stock' }, mainText: syntheticMainText() });
  assert.equal(result.level, 'unverified');
  assert.equal(result.allowed, true);
  assert.equal(result.slotLengthFamiliar, false);
  assert.equal(result.slotShaFamiliar, false);
  assert.ok(result.warnings.length >= 1);
});

test('a missing patch dependency refuses the write and names the token', () => {
  // Delete exactly one name the injected body references and keep every other.
  // The deletion is total (empty string, not a rename) because the check is a
  // substring search: `nativeImageRenamed` would still contain `nativeImage`.
  const text = syntheticMainText().replaceAll('nativeImage', '');
  const result = assessSupport({
    version: RC3.version,
    classification: stockClassification({ length: RC3.stock.slotLength, sha256: RC3.stock.slotSha }),
    mainText: text,
  });
  assert.equal(result.level, 'incompatible');
  assert.equal(result.allowed, false, 'a body that would throw at startup must never be written');
  assert.deepEqual(result.missingDependencies, ['nativeImage']);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('nativeImage'), `warning must name the missing token: ${result.warnings[0]}`);
  assert.ok(result.warnings[0].includes('拒绝写入'));
  assert.equal(typeof result.summary, 'string');
  assert.ok(result.summary.length > 0);
});

test('every single dependency is checked, not just the first one', () => {
  // One dependency at a time. Overlapping names (`process` inside
  // `process.resourcesPath`, `resolve` inside `resolvePath`) disappear together,
  // which is correct: a substring check cannot see either half of an overlap
  // without seeing both, so the assertion is "this name is reported missing",
  // not "only this name is".
  for (const name of PATCH_DEPENDENCIES) {
    const text = syntheticMainText().replaceAll(name, '');
    const result = assessSupport({
      version: RC3.version,
      classification: stockClassification({ length: RC3.stock.slotLength, sha256: RC3.stock.slotSha }),
      mainText: text,
    });
    assert.equal(result.level, 'incompatible', `dropping ${name} must refuse the write`);
    assert.equal(result.allowed, false);
    assert.ok(result.missingDependencies.includes(name), `missing list must contain ${name}`);
    assert.ok(result.warnings[0].includes(name), `warning must name ${name}`);
  }
});

test('an unreadable main.js refuses the write and reports all nine missing', () => {
  for (const mainText of [null, undefined, 42, '', {}, ['x']]) {
    const result = assessSupport({
      version: RC3.version,
      classification: stockClassification({ length: RC3.stock.slotLength, sha256: RC3.stock.slotSha }),
      mainText,
    });
    assert.equal(result.level, 'incompatible', `mainText=${JSON.stringify(mainText) ?? 'undefined'}`);
    assert.equal(result.allowed, false);
    assert.equal(result.missingDependencies.length, PATCH_DEPENDENCIES.length);
    assert.deepEqual(result.missingDependencies, [...PATCH_DEPENDENCIES]);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('读不到 lib/main.js'));
    assert.ok(result.warnings[0].includes('拒绝写入'));
  }
});

test('foreign and unknown classifications refuse the write with their own reason', () => {
  const foreign = assessSupport({
    version: RC3.version,
    classification: { state: 'foreign', reason: '托盘槽位里有其他工具留下的标记：dsh-tray-restart' },
    mainText: syntheticMainText(),
  });
  assert.equal(foreign.level, 'incompatible');
  assert.equal(foreign.allowed, false);
  assert.equal(foreign.warnings.length, 1);
  assert.ok(foreign.warnings[0].includes('dsh-tray-restart'), 'the foreign markers must be surfaced verbatim');

  const unknown = assessSupport({
    version: RC3.version,
    classification: { state: 'unknown', reason: '托盘槽位缺少 1 个官方锚点，版本不认识，拒绝写入' },
    mainText: syntheticMainText(),
  });
  assert.equal(unknown.level, 'incompatible');
  assert.equal(unknown.allowed, false);
  assert.ok(unknown.warnings[0].includes('锚点'));

  // A classification without a reason falls back to the generic refusal text
  // instead of rendering "undefined".
  const reasonless = assessSupport({ version: RC3.version, classification: { state: 'foreign' }, mainText: syntheticMainText() });
  assert.equal(reasonless.level, 'incompatible');
  assert.equal(reasonless.allowed, false);
  assert.equal(reasonless.warnings[0], '无法识别这个 asar 的版本或结构，拒绝写入');
});

test('a missing classification refuses the write', () => {
  for (const classification of [undefined, null, { state: 'patched' }, { state: 'STOCK' }, 'stock', 42]) {
    const result = assessSupport({ version: RC3.version, classification, mainText: syntheticMainText() });
    assert.equal(result.level, 'incompatible', `classification=${JSON.stringify(classification) ?? 'undefined'}`);
    assert.equal(result.allowed, false);
    assert.equal(result.warnings.length, 1);
  }
});

test('assessSupport never throws on an empty or malformed argument', () => {
  assert.doesNotThrow(() => assessSupport({}));
  assert.doesNotThrow(() => assessSupport({ mainText: null }));
  assert.doesNotThrow(() => assessSupport(null));
  assert.doesNotThrow(() => assessSupport(undefined));
  assert.doesNotThrow(() => assessSupport([]));
  assert.doesNotThrow(() => assessSupport('nonsense'));

  const empty = assessSupport({});
  assert.equal(empty.level, 'incompatible', 'no input must never mean permission');
  assert.equal(empty.allowed, false);
  assert.equal(empty.version, null);
  assert.equal(empty.knownVersion, false);
  assert.equal(empty.missingDependencies.length, PATCH_DEPENDENCIES.length);

  // JSON-serializable: the Host puts this on the wire.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(empty)));
});

test('the result is plain JSON, with every field of the documented shape', () => {
  const samples = [
    assessSupport({ version: RC3.version, classification: stockClassification({ length: 1253, sha256: RC3.stock.slotSha }), mainText: syntheticMainText() }),
    assessSupport({ version: '1.0.0', classification: stockClassification({ length: 99, sha256: 'a'.repeat(64) }), mainText: syntheticMainText() }),
    assessSupport({ mainText: null }),
  ];
  for (const result of samples) {
    assert.deepEqual(
      Object.keys(result).sort(),
      // `layout` joined the shape with the 0.2.0 split layout: the verdict now
      // also names WHICH layout is on disk ('pristine' | 'in-slot' | 'split').
      ['allowed', 'knownVersion', 'layout', 'level', 'missingDependencies', 'slotLengthFamiliar', 'slotShaFamiliar', 'summary', 'version', 'warnings'],
    );
    assert.equal(typeof result.allowed, 'boolean');
    assert.ok(['verified', 'unverified', 'incompatible'].includes(result.level));
    assert.ok(result.version === null || typeof result.version === 'string');
    assert.equal(typeof result.knownVersion, 'boolean');
    assert.equal(typeof result.slotLengthFamiliar, 'boolean');
    assert.equal(typeof result.slotShaFamiliar, 'boolean');
    assert.ok(['pristine', 'in-slot', 'split', 'unknown'].includes(result.layout),
      `layout must be one of the four known names, got ${String(result.layout)}`);
    assert.ok(Array.isArray(result.missingDependencies));
    assert.ok(Array.isArray(result.warnings));
    assert.equal(typeof result.summary, 'string');
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result, 'must survive a JSON round trip unchanged');
    if (result.level === 'verified') assert.equal(result.warnings.length, 0);
    if (result.level !== 'verified') assert.ok(result.warnings.length >= 1, 'unverified and incompatible always warn');
    if (result.level === 'incompatible') assert.equal(result.allowed, false);
  }
});

test('missingPatchDependencies reports the missing subset in declaration order', () => {
  // Drop the last, the middle and the first declared names: the answer must
  // always come back in PATCH_DEPENDENCIES order, not in text order.
  const text = syntheticMainText()
    .replaceAll('createRequire', 'x')
    .replaceAll('nativeImage', 'x')
    .replaceAll('import.meta.url', 'y');
  assert.deepEqual(missingPatchDependencies(text), ['createRequire', 'nativeImage', 'import.meta.url']);
  // Full text: nothing missing.
  assert.deepEqual(missingPatchDependencies(syntheticMainText()), []);
});

test('missingPatchDependencies treats anything unreadable as all nine missing', () => {
  for (const mainText of [null, undefined, 42, '', {}, [], false]) {
    assert.deepEqual(missingPatchDependencies(mainText), [...PATCH_DEPENDENCIES]);
  }
  // Readable text that carries none of the names: same answer, and it must be
  // the full list rather than "nothing missing" (the failure mode that would
  // wave a broken archive through).
  assert.deepEqual(missingPatchDependencies('nothing in here'), [...PATCH_DEPENDENCIES]);
});

test('the nine dependencies are the frozen list the patch body relies on', () => {
  assert.equal(PATCH_DEPENDENCIES.length, 9);
  assert.deepEqual(PATCH_DEPENDENCIES, [
    'createRequire',
    'resolve',
    'process',
    'process.resourcesPath',
    'Tray',
    'Menu',
    'nativeImage',
    'app',
    'import.meta.url',
  ]);
  assert.equal(Object.isFrozen(PATCH_DEPENDENCIES), true, 'a consumer must not be able to edit the contract');
  assert.equal(new Set(PATCH_DEPENDENCIES).size, PATCH_DEPENDENCIES.length, 'no duplicates');
});

test('shellFacts returns the registered record for both known versions', () => {
  for (const version of ['0.2.2-rc.2', '0.2.2-rc.3']) {
    const facts = shellFacts(version);
    assert.notEqual(facts, null, `${version} is registered`);
    assert.equal(facts.version, version);
    assert.equal(facts.stock.slotLength, 1253);
    assert.equal(facts.stock.slotOffsetInMain, 779389);
    assert.equal(facts.stock.slotSha, FAMILIAR_SLOT_SHA256S[0], 'the registered slot must be one we verified');
    assert.equal(typeof facts.stock.slotAbsolute, 'number');
    assert.equal(typeof facts.geometry.dataStart, 'number');
    assert.equal(typeof facts.patched.regionSha, 'string');
  }
  // Both releases must agree on the three facts the patch depends on.
  assert.equal(RC2.stock.slotLength, RC3.stock.slotLength);
  assert.equal(RC2.stock.slotSha, RC3.stock.slotSha);
  assert.equal(RC2.stock.slotOffsetInMain, RC3.stock.slotOffsetInMain);
  // …while the archive moved, so the table was really regenerated.
  assert.notEqual(RC2.stock.slotAbsolute, RC3.stock.slotAbsolute);
});

test('shellFacts returns null for anything it does not know, without throwing', () => {
  for (const version of ['9.9.9', '', null, undefined, 42, {}, ['0.2.2-rc.3'], '0.2.2-RC.3']) {
    assert.equal(shellFacts(version), null, `${JSON.stringify(version) ?? 'undefined'} must not be found`);
  }
  assert.doesNotThrow(() => shellFacts());
});

test('the registry exports are frozen and consistent', () => {
  assert.equal(Object.isFrozen(KNOWN_SHELLS), true);
  assert.equal(Object.isFrozen(KNOWN_VERSIONS), true);
  assert.equal(Object.isFrozen(FAMILIAR_SLOT_LENGTHS), true);
  assert.equal(Object.isFrozen(FAMILIAR_SLOT_SHA256S), true);
  assert.deepEqual([...KNOWN_VERSIONS].sort(), Object.keys(KNOWN_SHELLS).sort());
  for (const version of KNOWN_VERSIONS) {
    const facts = KNOWN_SHELLS[version];
    assert.equal(facts.version, version, 'the key and the record must agree');
    assert.equal(typeof facts.path, 'undefined', 'production must not carry machine paths');
    assert.ok(FAMILIAR_SLOT_LENGTHS.includes(facts.stock.slotLength), `${version}: a registered release must use a verified slot length`);
    assert.ok(FAMILIAR_SLOT_SHA256S.includes(facts.stock.slotSha), `${version}: a registered release must use a verified slot digest`);
    // The `split` record is the third dimension, and it must stay arithmetic: no
    // digest-shaped number may appear in it, or the registry would freeze one
    // build's `buildSplitRegion()` output and call a healthy older install broken.
    assert.equal(typeof facts.split, 'object', `${version}: every release carries its split arithmetic`);
    assert.equal(Object.isFrozen(facts.split), true, `${version}: the split record must be frozen like the rest`);
    for (const [field, value] of Object.entries(facts.split)) {
      const kind = typeof value;
      assert.ok(kind === 'number' || kind === 'string', `${version}: split.${field} must be a number or a string`);
    }
    // `slotSha` is the ONE digest allowed, and only because it is the OFFICIAL
    // slot's (shared with `stock.slotSha`), not a digest of our region.
    assert.equal(facts.split.slotSha, facts.stock.slotSha, `${version}: split.slotSha must be the stock slot digest`);
    const hexDigests = Object.entries(facts.split)
      .filter(([field, value]) => field !== 'slotSha' && typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))
      .map(([field]) => field);
    assert.deepEqual(hexDigests, [], `${version}: split must hold no build-dependent digest, found ${hexDigests.join('、')}`);
  }
});

test('the live archive is the release the registry describes', { skip: shellGate() }, () => {
  // Cheap guard on top of the verdict: if the machine runs a release nobody
  // registered, `shellGate()` says so and this test skips with that reason
  // instead of failing on a mismatch it cannot fix.
  const facts = readArchiveFacts(LIVE_ASAR);
  assert.notEqual(shellFacts(facts.version), null);
  const result = assessSupport(facts);
  // The registry must describe the release that is ACTUALLY on disk: the same
  // layout, the same official slot facts, and an archive size that is what the
  // registry says for that layout (the split layout is the ONE case where the size
  // is stock + reserve). The verdict must be writable either way; which of
  // verified/unverified it lands on is decided by the region's build, so that is
  // asserted in the on-disk test above rather than duplicated here.
  const shell = shellFacts(facts.version);
  const current = readState(LIVE_ASAR);
  assert.equal(current.present, true, `cannot read ${LIVE_ASAR}`);
  assert.equal(facts.classification.layout, current.layout, 'the classifier must agree with the helper about the layout');
  const expectedSize = current.layout === 'split' ? shell.split.archiveSizeAfter : shell.geometry.size;
  assert.equal(current.archiveSize, expectedSize,
    `the live archive must be the size the registry describes for a ${current.layout} install`);
  const expectedMainSize = current.layout === 'split' ? shell.split.mainSizeAfter : shell.geometry.mainSize;
  assert.equal(current.mainSize, expectedMainSize,
    `the live lib/main.js must be the size the registry describes for a ${current.layout} install`);
  // The official slot is at the same in-file place and holds the same bytes in
  // every layout this package supports — that is why the slot facts are shared.
  assert.equal(current.regionStartInMain, shell.stock.slotOffsetInMain);
  assert.equal(facts.classification.length, shell.stock.slotLength,
    'the measured official slot length must be the registered one');
  assert.equal(facts.classification.startInMain, shell.stock.slotOffsetInMain);
  // What `locateRegion` reports for the slot depends on the layout: a split
  // install leaves the official slot pristine, while an in-slot install replaced
  // it with our own bytes.
  const expectedSlotSha = current.layout === 'split'
    ? shell.split.slotSha
    : current.state === 'stock' ? shell.stock.slotSha : shell.patched.regionSha;
  assert.equal(current.regionSha, expectedSlotSha,
    `the official slot digest must be the one a ${current.layout} install leaves behind`);
  assert.equal(result.allowed, true, `the live archive must be writable: ${result.warnings.join(' | ')}`);
  assert.ok(['verified', 'unverified'].includes(result.level), `unexpected level ${result.level}`);
  if (result.level === 'verified') assert.deepEqual(result.warnings, []);
});
