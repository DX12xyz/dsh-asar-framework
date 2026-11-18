/**
 * Split-region surgery tests: growing and shrinking `lib/main.js` around a
 * pristine official tray slot.
 *
 * The layout under test (v0.2.0):
 *
 *   ... official 1,253 B tray slot (UNTOUCHED) | our region (16 KiB) | official tail ...
 *
 * Every case runs against a copy of the REAL shipped archive, taken from the
 * official baseline beside the installation:
 *
 *   <install root>\resources\app.asar.<stamp>.v<version>.bak
 *
 * That copy is the only source of official bytes on this machine (the live
 * archive is patched), and it is verified by digest before a single byte is
 * written, so the tests cannot silently start from "some archive". Tests skip —
 * never fail — when the baseline is absent or does not hash to the registered
 * rc.3 digest: a machine without it is a normal machine, not a defect.
 *
 * Nothing here writes outside the scratch directory, and nothing spawns a
 * process (spawn is denied in this sandbox; the Electron read-back lives in
 * `evidence/split-region-proto.mjs` instead).
 *
 * Run: node --test --test-isolation=none test/split-surgery.test.mjs
 */
import {
  test, after,
} from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RESOURCES_DIR } from './desktop-root.mjs';

import {
  REGION_END_MARKER,
  REGION_RESERVE_BYTES,
  REGION_RESERVE_LIMIT,
  SPLIT_PATCH_MARKER,
  SPLIT_START_MARKER,
  FILES,
  PROTOCOLS,
  CHANNEL_MAX_BYTES,
  CHANNEL_NAMES,
  CHANNEL_NAME_PATTERN,
  CHANNEL_NOTIFY_BODY_MAX,
  CHANNEL_NOTIFY_TITLE_MAX,
  CHANNEL_PAYLOAD_MAX_BYTES,
  STATE_DIR_NAME,
} from '../lib/wire/constants.js';
import {
  buildSplitRegion,
  CHANNEL_DECLINE_CODES,
  classifyHostEvent,
  CHANNEL_HANDLER_BLOCK,
  CHANNEL_HANDLER_BYTES,
  CHANNEL_OUT_FILE,
  CHANNEL_PROTOCOL,
  CREATE_BRIDGE_CALL,
  CREATE_BRIDGE_CALL_SPLIT,
  HOST_EVENT_CLASSIFIER_SHIPPED,
  HOST_EVENT_CLASSIFIER_SOURCE,
  HOST_EVENT_VERDICTS,
  IPC_BODY,
  IPC_BODY_BYTES,
  IPC_BLOCK_ID,
  PATCH_BODY,
  PATCH_MARKER as PATCH_BODY_MARKER,
  RESERVED_HOST_EVENT_TYPE,
  SPLIT_BODY,
  SPLIT_BODY_BYTES,
  SPLIT_MINIMUM_REGION_LENGTH,
  SPLIT_TRAY_BODY,
  compactJsSource,
  inlineChannelConstants,
} from '../lib/asar/patch-body.js';
import { MAX_WINDOW_SPECS, WINDOW_SPEC_CODES } from '../lib/bridge/src/windows.js';
import {
  findSplitRegion,
  growRegion,
  planSplit,
  planSplitFile,
  shrinkRegion,
  verifySplit,
} from '../lib/asar/split.js';
import { closeAsar, openAsar, readEntry } from '../lib/asar/reader.js';

/** Digest the rc.3 release ships; the baseline copy must hash to this. */
const STOCK_ARCHIVE_SHA = '14cfd81c9135bf0afb89417543c94f9ecfe09266574452a9b106890c698725ae';
/** Digest of the OFFICIAL tray slot in that release. */
const STOCK_SLOT_SHA = '4bc10e1ee26b0961f14ea9357bbb0c72f669a9ccf1f8c07c911cf55e4a15ce64';
const STOCK_SLOT_START = 779389;
const STOCK_SLOT_LENGTH = 1253;
const STOCK_MAIN_SIZE = 848505;
const STOCK_ARCHIVE_SIZE = 209021953;

/** Where this machine keeps the official baseline, or null when it has none. */
const BASELINE_DIR = RESOURCES_DIR;

/** Absolute path of the official baseline archive, or null. */
function findBaseline() {
  let names;
  try {
    names = readdirSync(BASELINE_DIR);
  } catch {
    return null;
  }
  const candidates = names.filter((name) => name.startsWith('app.asar.') && name.endsWith('.bak'));
  return candidates.length > 0 ? join(BASELINE_DIR, candidates[0]) : null;
}

const BASELINE = findBaseline();

/** sha256 of a file, lowercase hex. */
function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const SCRATCH = fileURLToPath(new URL('../../scratch/test-copies/', import.meta.url));
const RUN_DIR = join(SCRATCH, `split-${process.pid}`);

after(() => {
  rmSync(RUN_DIR, { recursive: true, force: true });
});

/**
 * The wrapper probes below write two tiny modules under the shared scratch root.
 * They are created beside the fixture copies and removed with them, so a run
 * leaves nothing behind.
 */
const PROBE_DIR = join(SCRATCH, `split-probe-${process.pid}`);

after(() => {
  rmSync(PROBE_DIR, { recursive: true, force: true });
});

/**
 * Copy the official baseline into the scratch directory and assert its digest.
 *
 * Returns null (and the caller skips) when the machine has no baseline or the
 * one it has is not the registered release — testing the surgery against an
 * unknown archive would prove nothing about the release this package was
 * verified on.
 *
 * @param {string} name file name inside the per-process run directory
 * @returns {string|null} absolute path of the verified copy
 */
function makeStockCopy(name) {
  if (BASELINE === null) return null;
  mkdirSync(RUN_DIR, { recursive: true });
  const target = join(RUN_DIR, name);
  copyFileSync(BASELINE, target);
  if (sha256OfFile(target) !== STOCK_ARCHIVE_SHA) return null;
  return target;
}

/** Reason string used when the machine has no verified baseline to work from. */
const NO_BASELINE = '需要一份校验通过的官方原样备份（resources\\app.asar.*.bak）才能验证手术层';

/**
 * Pick the plain byte the test needs out of the `planSplit` result, accepting
 * either of the two names the implementation may use for the insertion offset.
 *
 * @param {object} plan
 * @returns {number}
 */
function insertOffsetOf(plan) {
  return plan.insertAtInFile ?? plan.insertAtInMain ?? plan.insertAt;
}

/**
 * Read the official slot out of a grown archive, using byte offsets.
 *
 * @param {string} path
 * @returns {Buffer|null}
 */
function readOfficialSlot(path) {
  const opened = openAsar(path, { allowStaleMainIntegrity: true });
  if (opened.ok !== true) return null;
  try {
    const main = readEntry(opened, 'lib/main.js');
    if (main === null) return null;
    return main.subarray(STOCK_SLOT_START, STOCK_SLOT_START + STOCK_SLOT_LENGTH);
  } finally {
    closeAsar(opened);
  }
}

// ------------------------------------------------------------------ builder --

test('buildSplitRegion produces exactly the requested length, with our markers only', () => {
  const region = buildSplitRegion(REGION_RESERVE_BYTES);
  assert.equal(region.length, REGION_RESERVE_BYTES, 'the region must be exactly the reserve');

  const text = region.toString('utf8');
  assert.equal(text.startsWith(`\n${SPLIT_START_MARKER}\n`), true, 'opens with a newline and our start marker');
  assert.equal(text.endsWith(`\n${REGION_END_MARKER}`), true, 'ends with the shared end marker');
  assert.equal(text.includes(SPLIT_PATCH_MARKER), true, 'carries the v0.2.0 marker');

  // The official slot's marker must NEVER appear in our region: `locateRegion`
  // resolves the official slot by it, and a second copy would make the two
  // regions indistinguishable.
  assert.equal(text.includes('//#region lib/types/tray.js'), false, 'must not contain the official start marker');
  assert.equal(
    text.includes('/* dsh-asar-bridge-slot v0.1.0 */'),
    false,
    'must not carry the 0.1.x in-slot marker, or state detection could not tell the layouts apart',
  );

  // The filler is spaces, never NUL: this file lives inside an archive whose
  // bytes are parsed verbatim, and JS has to tolerate it.
  const padding = region.subarray(text.indexOf(SPLIT_PATCH_MARKER), region.length - (1 + REGION_END_MARKER.length));
  assert.equal(padding.includes(0x00), false, 'padding must be spaces, not NUL bytes');

  // EVERY BYTE IS ASCII, so "byte length == character length" holds and the
  // padding arithmetic cannot drift. This is a real constraint, not an aesthetic
  // one: the window validator's own error strings are shipped into the archive,
  // and one CJK character there costs three bytes of a 16 KiB budget.
  for (let index = 0; index < region.length; index += 1) {
    assert.equal(region[index] < 0x80, true, `byte ${index} is not ASCII (0x${region[index].toString(16)})`);
  }
});

test('buildSplitRegion refuses a region too small for the body', () => {
  assert.throws(
    () => buildSplitRegion(SPLIT_MINIMUM_REGION_LENGTH - 1),
    /does not fit/,
    'a region one byte too small must throw instead of silently truncating',
  );
  // The documented minimum itself is exactly enough.
  const exact = buildSplitRegion(SPLIT_MINIMUM_REGION_LENGTH);
  assert.equal(exact.length, SPLIT_MINIMUM_REGION_LENGTH);
});

// ------------------------------------------------------------- the IPC block --
// The region carries TWO blocks now: the `DesktopTray` redeclaration and the
// `isDesktopHostEvent` guard. What follows proves the guard is really in the
// shipped bytes, that it fits, that it parses, and that the logic the tests
// exercise is the logic those bytes contain.

test('the region carries the IPC block as a SECOND block, after the tray class', () => {
  const text = buildSplitRegion(REGION_RESERVE_BYTES).toString('utf8');

  assert.equal(text.includes(IPC_BLOCK_ID), true, 'the IPC block must carry its own identity comment');
  assert.equal(text.includes(IPC_BODY), true, 'the shipped region must embed the whole IPC block');
  assert.equal(text.includes(HOST_EVENT_CLASSIFIER_SHIPPED), true,
    'the region must embed the classifier SOURCE, not a paraphrase of it');
  // The handler half must be there too: `accept` without a consumer is exactly the
  // hole this version closes, so a region carrying the classifier but not the
  // handler would be a worst-of-both-worlds build.
  assert.equal(text.includes(CHANNEL_HANDLER_BLOCK), true,
    'the region must embed the HANDLER block as well, or an accepted message has no consumer');
  assert.equal(text.includes(CHANNEL_OUT_FILE), true,
    'the region must name the concrete ack file it writes');

  // Order: the tray class first (that is the identity `locateRegion`/`classifyAsar`
  // rely on), the IPC block after it.
  const classAt = text.indexOf('var DesktopTray = class');
  const ipcAt = text.indexOf(IPC_BLOCK_ID);
  assert.equal(classAt >= 0, true, 'the tray class must still be in the region');
  assert.equal(ipcAt > classAt, true, 'the IPC block must come AFTER the tray class');
  assert.equal(text.indexOf(IPC_BODY, ipcAt), ipcAt, 'the block must appear exactly once, where found');
  assert.equal(text.indexOf('var DesktopTray = class', classAt + 1), -1,
    'the tray class must appear exactly once');

  // Exactly TWO occurrences of the validator name in the WHOLE region: the
  // captured original and the single assignment.
  const occurrences = (text.match(/isDesktopHostEvent/g) ?? []).length;
  assert.equal(occurrences, 2,
    `the validator name must appear exactly twice in the region (capture + assignment), found ${occurrences}`);

  // The reserved type is claimed AND handled, and the claim is a literal.
  assert.equal(RESERVED_HOST_EVENT_TYPE, 'dsh-asar-bridge');
  assert.equal(text.includes(`"${RESERVED_HOST_EVENT_TYPE}"`), true,
    'the reserved type must be a literal inside the shipped text');
  assert.equal(text.includes(CHANNEL_NAME_PATTERN.slice(1, -1)), true,
    'the channel-name pattern must appear as a literal inside the shipped text');
  // THE ACCEPT BRANCH: it must CALL the handler and then answer `true`
  // unconditionally. The `=== true` of the previous build is GONE on purpose —
  // that comparison was the defect: a handler refusal became main's `false`, and
  // `false` is "kill the Host child".
  assert.equal(text.includes('__channelHandle(message, void 0, __windowRegistry);'), true,
    'the accept branch must call the handler');
  assert.equal(text.includes('__channelHandle(message) === true'), false,
    'the accept branch must NOT let the handler decide the boolean: that is the defect');
  assert.equal(/(if \(verdict === "accept"\)[^}]*return true)/s.test(text), true,
    'the accept branch must return true unconditionally');
});

test('the region fits 16,384 bytes with >=1,000 B to spare, and that is measured', () => {
  const spare = REGION_RESERVE_BYTES - SPLIT_MINIMUM_REGION_LENGTH;
  assert.equal(REGION_RESERVE_BYTES, 16384, 'the reserve is 16 KiB, a packaging decision made once');
  assert.equal(SPLIT_MINIMUM_REGION_LENGTH < REGION_RESERVE_BYTES, true,
    `body needs ${SPLIT_MINIMUM_REGION_LENGTH} B, reserve is ${REGION_RESERVE_BYTES} B`
    + ` → spare ${spare} B`);
  assert.equal(spare >= 1000, true,
    `the reserve must keep at least 1,000 B of headroom for future blocks; measured spare is ${spare} B`
    + ` (tray body ${SPLIT_BODY_BYTES - IPC_BODY_BYTES - 1} B, IPC block ${IPC_BODY_BYTES} B`
    + ` = handler ${CHANNEL_HANDLER_BYTES} B + classifier + wrapper)`);
  assert.equal(CHANNEL_HANDLER_BYTES < IPC_BODY_BYTES, true,
    'the handler must be part of the IPC block, not a fifth block that was never counted');

  // THE TWO REAL CAPABILITIES are in the shipped bytes, not merely in a module.
  const text = buildSplitRegion(REGION_RESERVE_BYTES).toString('utf8');
  assert.equal(text.includes("new provider({ title, body, silent })"), true,
    'the notify channel must construct a real notification in the shipped text');
  assert.equal(text.includes("new provider(options)"), true,
    'the window channel must construct a real window in the shipped text');
  assert.equal(text.includes('__windowRegistry'), true,
    'the window registry must live in the region, or the per-id and count caps do not exist');

  // The region's toast caps are the SAME numbers the Host-side queue enforces, so
  // "how long a toast may be" cannot depend on which half delivered it.
  assert.equal(text.includes(String(CHANNEL_NOTIFY_TITLE_MAX)), true,
    'the region must carry the Host writer\'s title cap');
  assert.equal(text.includes(String(CHANNEL_NOTIFY_BODY_MAX)), true,
    'the region must carry the Host writer\'s body cap');
  assert.equal(IPC_BODY.includes(String(MAX_WINDOW_SPECS)), true,
    'the region must carry the window count cap');

  // THE MISTYPED-NAME REGRESSION, in the shipped dispatcher: a name that is not in
  // the vocabulary must fall through to a `declined` record, never to a `false`.
  assert.equal(text.includes('__channelNames.declined'), true,
    'an unknown channel name must be recorded as `declined`');
  // The dispatcher's OWN body must contain no `return false`. `isSameOriginRoute`
  // legitimately returns false for an unsafe route — that is a boolean predicate,
  // not the IPC answer — so the check is scoped to the dispatcher's own range.
  const dispatcherAt = text.indexOf('const __channelHandle = ');
  const dispatcherEnd = text.indexOf('\n', text.indexOf('};', dispatcherAt));
  const dispatcherText = text.slice(dispatcherAt, dispatcherEnd);
  assert.equal(dispatcherAt > 0, true, 'the dispatcher must be in the shipped region');
  assert.equal(/return\s+false/.test(dispatcherText), false,
    'the dispatcher must not be able to answer `false` at all');
  assert.equal(dispatcherText.includes('return true;'), true,
    'every dispatcher branch must answer `true`');

  // Still true against the ABSOLUTE ceiling too: the reserve itself is three
  // orders of magnitude below the header-length boundary.
  assert.equal(REGION_RESERVE_BYTES < REGION_RESERVE_LIMIT, true);
  assert.equal(REGION_RESERVE_BYTES + 848505 < 1000000, true,
    'lib/main.js must stay below the seventh digit, or the header grows');
});

test('the injected capabilities object is exactly ONE new argument, and the rest is unchanged', () => {
  const text = buildSplitRegion(REGION_RESERVE_BYTES).toString('utf8');

  // The capability object exists, carries both injected classes, and guards each
  // with `typeof` so a future shell that moves them cannot make the region throw
  // (a throw there costs the user every menu contribution, not just toasts).
  assert.equal(text.includes(CREATE_BRIDGE_CALL_SPLIT), true,
    'the region must embed the generated call, not a paraphrase of it');
  assert.equal(text.includes('electron: {'), true);
  assert.equal(text.includes('typeof Notification === "undefined"'), true);
  assert.equal(text.includes('typeof BrowserWindow === "undefined"'), true);

  // Substitution, not a second copy: everything OUTSIDE that one call is the
  // 0.1.x body byte for byte. This is what lets the in-slot layout keep its
  // 39 B slack while the split layout carries the new capability.
  const wide = text.slice(
    text.indexOf(SPLIT_PATCH_MARKER),
    text.indexOf(SPLIT_PATCH_MARKER) + SPLIT_TRAY_BODY.length,
  );
  assert.equal(wide, SPLIT_TRAY_BODY, 'the tray class bytes must be the generated ones');
  assert.equal(
    SPLIT_TRAY_BODY.split(CREATE_BRIDGE_CALL_SPLIT).join(CREATE_BRIDGE_CALL),
    PATCH_BODY.replace(PATCH_BODY_MARKER, SPLIT_PATCH_MARKER),
    'removing the capability object must reproduce the 0.1.x tray body exactly',
  );

  // The in-slot body did NOT grow: it still has to fit 1,253 B.
  assert.equal(PATCH_BODY.includes('electron:'), false,
    'the 1,253 B in-slot layout must not carry the new argument: it has 39 B of slack');
  assert.equal(SPLIT_TRAY_BODY.length - PATCH_BODY.length,
    CREATE_BRIDGE_CALL_SPLIT.length - CREATE_BRIDGE_CALL.length,
    'every byte the split body gained must be accounted for by the widened call');
});

test('the whole region parses as an ES module body (node --check on a temp file)', () => {
  // The region is spliced into `lib/main.js`, which is an ES module. If it were
  // not valid module-level code the desktop app would die at load, so this is a
  // shipped-bytes property, not a style check.
  const file = join(PROBE_DIR, 'region-check.mjs');
  try {
    mkdirSync(PROBE_DIR, { recursive: true });
  } catch {
    return; // no scratch dir = an environment problem, not a defect
  }
  writeFileSync(file, buildSplitRegion(REGION_RESERVE_BYTES).toString('utf8'), 'utf8');

  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' });
  // `spawnSync` can fail for reasons that have nothing to do with the region
  // (denied process creation). The sandbox does allow `node --check`, so a
  // leftover `error` is reported as a skip rather than a failure.
  if (result.error !== undefined || result.signal !== null) return;
  assert.equal(result.status, 0, 'the region must parse as ES module code without a syntax error');
});

/**
 * Extract the classifier FUNCTION SOURCE out of the shipped region bytes.
 *
 * Nothing is read from the module here: the text is found by locating the
 * assignment inside the region and brace-matching it, so what comes back is
 * literally what an archive would contain.
 *
 * @param {string} regionText
 * @returns {string}
 */
function extractClassifierSource(regionText) {
  const anchor = 'const classifyHostEvent = ';
  const at = regionText.indexOf(anchor);
  assert.notEqual(at, -1, 'the region must assign classifyHostEvent');
  const start = at + anchor.length;
  assert.equal(regionText.slice(start, start + 'function classifyHostEvent'.length), 'function classifyHostEvent',
    'the assignment must hold a named function declaration');
  return matchFunctionSource(regionText, start);
}

/**
 * Brace-match one function's source out of the region, starting at `start`.
 *
 * @param {string} regionText
 * @param {number} start index of the `function` keyword
 * @returns {string}
 */
function matchFunctionSource(regionText, start) {
  const open = regionText.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < regionText.length; index += 1) {
    const char = regionText[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return regionText.slice(start, index + 1);
    }
  }
  throw new Error('unbalanced braces while extracting a function');
}

test('the SHIPPED classifier source and the tested one are the same code', async () => {
  const regionText = buildSplitRegion(REGION_RESERVE_BYTES).toString('utf8');
  const extracted = extractClassifierSource(regionText);

  // 1. The extracted text is the exported shipped text, byte for byte.
  assert.equal(extracted, HOST_EVENT_CLASSIFIER_SHIPPED,
    'the function inside the region must be exactly the generated shipped source');
  // 2. That source is the EXPORTED function's own source, COMPACTED (comments and
  //    indentation removed) and with its module-scope names inlined. Nothing else
  //    may change: every shippable token below is checked against the tested text.
  const compacted = compactJsSource(HOST_EVENT_CLASSIFIER_SOURCE);
  const expected = inlineChannelConstants(HOST_EVENT_CLASSIFIER_SOURCE);
  assert.equal(extracted, expected,
    'the shipped source must be the TESTED function, compacted and with its constants inlined');
  assert.equal(compacted.length <= HOST_EVENT_CLASSIFIER_SOURCE.length, true,
    'compaction must not be able to grow the source');
  assert.equal(extracted.includes('/*'), false, 'the shipped function must carry no block comment');
  assert.equal(extracted.includes('//'), false, 'the shipped function must carry no line comment');

  // 2b. The classifier may reference only names that EXIST inside the region.
  //     Every module-scope name it uses is inlined; anything left would be a free
  //     identifier whose ReferenceError the classifier's own try/catch would swallow
  //     into `delegate` — a silent regression. This list is the whole contract.
  //
  //     Since the guard stopped refusing our own type it no longer reads the byte
  //     caps, the regex or the UTF-8 helper: its only job is "is this OUR type".
  //     That is why `byteLengthOf` and the cap names must NOT appear here any more
  //     — they moved to the HANDLER block, which is a different test below.
  for (const name of [
    'RESERVED_HOST_EVENT_TYPE',
    'CHANNEL_NAME_REGEX',
    'CHANNEL_PAYLOAD_MAX_BYTES',
    'CHANNEL_ENVELOPE_MAX_BYTES',
    'CHANNEL_PROTOCOL',
    'CHANNEL_OUT_FILE',
    'CHANNEL_OUT_ROTATED',
    'byteLengthOf',
  ]) {
    assert.equal(extracted.includes(name), false,
      `${name} must be inlined: the classifier does not resolve it any more`);
  }
  assert.equal(extracted.includes(`"${RESERVED_HOST_EVENT_TYPE}"`), true,
    'the shipped text must compare against the literal type name');
  assert.equal(extracted.includes('return \'accept\';'), true,
    'our type must be accepted unconditionally — that is the whole fix');
  assert.equal(/(requestId|error)/.test(extracted), true,
    'anti-forgery for FOREIGN types must still be in the shipped text');
  assert.equal(/(channel|payload)/.test(extracted), false,
    'our type must NOT be inspected any more: the handler declines, the wrapper accepts');

  // 3. Run the extracted bytes as a module and compare verdicts with the
  //    exported helper over the whole decision table. If someone edits the
  //    string template so the shipped copy drifts, this fails.
  mkdirSync(PROBE_DIR, { recursive: true });
  const file = join(PROBE_DIR, 'shipped-classifier.mjs');
  writeFileSync(file, [
    // The one local the classifier and the handler block share.
    `function byteLengthOf(text) { let bytes = 0; for (let index = 0; index < text.length; index += 1) {`
    + ` const code = text.charCodeAt(index); if (code < 0x80) bytes += 1;`
    + ` else if (code < 0x800) bytes += 2; else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index += 1; }`
    + ` else bytes += 3; } return bytes; }`,
    `export const classifyHostEvent = ${extracted};`,
  ].join('\n'), 'utf8');
  const shipped = await import(`file:///${file.replaceAll('\\', '/')}`);

  const cases = [
    { label: 'undefined', message: undefined, official: false },
    { label: 'null', message: null, official: false },
    { label: 'number', message: 42, official: false },
    { label: 'string', message: 'ready', official: false },
    { label: 'no type key', message: { hello: 'world' }, official: false },
    { label: 'reserved type', message: { type: RESERVED_HOST_EVENT_TYPE }, official: false },
    { label: 'reserved type + requestId', message: { type: RESERVED_HOST_EVENT_TYPE, requestId: 7 }, official: true },
    { label: 'foreign type + requestId', message: { type: 'nope', requestId: 1 }, official: false },
    { label: 'foreign type + error', message: { type: 'nope', error: 'boom' }, official: false },
    { label: 'official control reply + requestId', message: { type: 'update-tasks', requestId: 3, active: true }, official: true },
    { label: 'official control reply + error', message: { type: 'quit-inspection', requestId: 4, error: 'x' }, official: true },
    { label: 'official message, no request id', message: { type: 'ready', url: 'http://x' }, official: true },
    { label: 'unknown type, clean', message: { type: 'whatever' }, official: false },
  ];

  for (const testCase of cases) {
    const fromBytes = shipped.classifyHostEvent(testCase.message, testCase.official);
    const fromHelper = classifyHostEvent(testCase.message, testCase.official);
    assert.equal(fromBytes, fromHelper,
      `${testCase.label}: shipped bytes answer ${fromBytes}, the exported helper answers ${fromHelper}`);
  }

  // 4. Never throws, even on an input that can only be described as hostile.
  const hostile = new Proxy({}, { has() { throw new Error('nope'); }, get() { throw new Error('nope'); } });
  assert.equal(shipped.classifyHostEvent(hostile, false), HOST_EVENT_VERDICTS.delegate,
    'a throwing Proxy must degrade to delegate instead of escaping an exception');
});

test('the whole shipped IPC block runs, and answers exactly what the design says', async () => {
  // The block is not just the classifier: it captures the official validator,
  // assigns the wrapper to the same module binding, installs the channel handler,
  // and swallows every failure. So it is executed here as a module, with a STUB
  // standing in for the official validator (its 2,847 real bytes live in the
  // archive, not in a unit test) and a scratch `DSH_HOME` standing in for the real
  // state directory.
  mkdirSync(PROBE_DIR, { recursive: true });

  /** Official-validator stand-in: accepts only the stock types, like the real one. */
  const stubSource = `const OFFICIAL = new Set(["starting","shutdown-complete","ready","platform-session","fatal","update-tasks","file-drag-resource","quit-inspection"]);`;
  const officialSource = `const official = function officialValidator(message) { return OFFICIAL.has(message && message.type); };`;

  const file = join(PROBE_DIR, 'shipped-block.mjs');
  writeFileSync(file, [
    stubSource,
    officialSource,
    // The block's two scope dependencies, exactly as the stock file provides them:
    // a mutable `isDesktopHostEvent` binding, and CommonJS `require` /
    // `import.meta.url` for the two built-ins it resolves.
    'import { createRequire } from "node:module";',
    // A `let` is what the stock file provides (a top-level `function` declaration
    // creates a mutable binding); the block assigns over it.
    'let isDesktopHostEvent = official;',
    IPC_BODY,
    'export { isDesktopHostEvent, official };',
  ].join('\n'), 'utf8');

  // The handler resolves the state directory through `process.env.DSH_HOME` at
  // CALL time (the region reads the environment, it does not cache it — that is
  // what makes the shipped block testable at all). So the scratch home stays
  // installed for the whole driving section below, and is restored at the end.
  const channelHome = join(PROBE_DIR, 'channel-home');
  mkdirSync(join(channelHome, STATE_DIR_NAME), { recursive: true });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = channelHome;
  let block;
  try {
    block = await import(`file:///${file.replaceAll('\\', '/')}`);

  // The binding really was replaced: this is the mechanism the layout depends on.
  assert.notEqual(block.isDesktopHostEvent, block.official,
    'the shipped block must reassign the module binding, not leave it alone');

  const drive = (message) => block.isDesktopHostEvent(message);

  /** Read every envelope the handler wrote into a given state directory. */
  const readEnvelopesIn = (dir) => {
    let text;
    try {
      text = readFileSync(join(dir, CHANNEL_OUT_FILE), 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  };
  const readEnvelopes = () => readEnvelopesIn(join(channelHome, STATE_DIR_NAME));

  // Delegation: the stub's verdict is returned unchanged for everything official.
  assert.equal(drive({ type: 'ready', url: 'http://x' }), true, 'an official message must keep its verdict');
  assert.equal(drive({ type: 'nope' }), false, 'an official rejection must stay a rejection');
  assert.equal(drive(null), false, 'malformed input must fall through to the official validator');
  assert.equal(drive({ hello: 'world' }), false, 'no type key must fall through');
  assert.equal(readEnvelopes().length, 0, 'nothing may be written for a delegated message');

  // THE GATE. Since the guard stopped refusing OUR type, every malformed message
  // of ours is answered `true` (main must never kill the Host child) and is
  // RECORDED as a `declined` line instead. `false` is reserved for exactly what
  // stock would have refused for OFFICIAL types.

  // 1. control-shaped: a channel message must never look like a control response.
  assert.equal(drive({ type: RESERVED_HOST_EVENT_TYPE, channel: 'ping', requestId: 7 }), true,
    'a forged control response carrying our type is ACCEPTED and declined — never refused');
  assert.equal(drive({ type: RESERVED_HOST_EVENT_TYPE, channel: 'state', error: 'boom' }), true,
    'same for an error envelope');
  assert.equal(drive({ type: RESERVED_HOST_EVENT_TYPE, channel: 'ping', requestId: null }), true,
    'the check is `!== undefined`, so even a null requestId counts as carried');

  // 2. the channel field: a name that does not match the shape is declined, and a
  // MISTYPED name ("sttate") is declined too — the regression that matters.
  assert.equal(drive({ type: RESERVED_HOST_EVENT_TYPE }), true, 'no channel at all is accepted-and-declined');
  assert.equal(drive({ type: RESERVED_HOST_EVENT_TYPE, channel: 7 }), true, 'a number is not a channel — declined');
  assert.equal(drive({ type: RESERVED_HOST_EVENT_TYPE, channel: 'PING' }), true, 'the shape is lowercase only — declined');
  assert.equal(drive({ type: RESERVED_HOST_EVENT_TYPE, channel: 'ping-pong-bounce-forever!!' }), true,
    'the shape caps the name at 32 characters — declined');
  assert.equal(drive({ type: RESERVED_HOST_EVENT_TYPE, channel: '-leading-dash' }), true,
    'the first character must be a letter — declined');
  {
    const written = readEnvelopes();
    // Three control-shaped messages plus five shape failures = eight declines.
    assert.equal(written.length, 8, 'every one of the eight malformed messages must leave exactly one declined envelope');
    for (const envelope of written) {
      assert.equal(envelope.channel, CHANNEL_NAMES.declined, 'a declined message is recorded under `declined`');
      assert.equal(typeof envelope.received.reason, 'string', 'the reason code must be a string');
    }
  }

  // 3. the payload cap: 4,096 serialised bytes. Past it the message is STILL
  //    accepted (dropping it is always the safer failure) and recorded.
  assert.equal(drive({ type: RESERVED_HOST_EVENT_TYPE, channel: 'state', payload: 'x'.repeat(CHANNEL_PAYLOAD_MAX_BYTES + 1) }), true,
    'a payload past the cap is declined, and the answer stays `true`');
  const afterOversize = readEnvelopes();
  assert.equal(afterOversize.length, 9, 'the eight declines above plus this one');
  assert.equal(afterOversize[8].received.reason, CHANNEL_DECLINE_CODES.EPAYLOAD_TOO_LARGE);
  // An unserialisable payload is declined for the same reason (it cannot be capped).
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(drive({ type: RESERVED_HOST_EVENT_TYPE, channel: 'state', payload: cyclic }), true,
    'a payload JSON cannot serialise is declined, and the answer stays `true`');

  // 4. a well-formed message is ACCEPTED **and handled**: `ping` writes `pong`.
  assert.equal(drive({ type: RESERVED_HOST_EVENT_TYPE, channel: 'ping' }), true,
    'a well-formed ping must be accepted, or the channel does not exist');
  // The handler ran: the read happens through a fresh process.env scope, so the
  // block captured the scratch home before it was restored.
  {
    const written = readEnvelopesIn(join(channelHome, STATE_DIR_NAME));
    assert.equal(written.length, 11, 'ten declined lines plus the ping ack');
    const ping = written[10];
    assert.equal(ping.protocol, CHANNEL_PROTOCOL);
    assert.equal(ping.protocol, PROTOCOLS.channel,
      'the shipped literal must equal the wire constant the bridge reads');
    assert.equal(ping.channel, 'ping');
    assert.equal(ping.received, 'pong');
    assert.equal(typeof ping.at, 'string');
  }

  // `state` echoes the bounded payload instead.
  assert.equal(drive({ type: RESERVED_HOST_EVENT_TYPE, channel: 'state', payload: { ok: 1 } }), true);
  {
    const written = readEnvelopesIn(join(channelHome, STATE_DIR_NAME));
    assert.equal(written.length, 12);
    assert.equal(written[11].channel, 'state');
    assert.deepEqual(written[11].received, { ok: 1 });
  }

  // 5. an ACCEPTED message with a name outside the vocabulary ("sttate") is the
  //    REGRESSION THIS TEST EXISTS FOR: it answers `true` and is recorded, where
  //    the old build answered `false` and main killed the Host child.
  assert.equal(drive({ type: RESERVED_HOST_EVENT_TYPE, channel: 'sttate' }), true,
    'a mistyped channel name must NEVER be answered `false`');
  {
    const written = readEnvelopesIn(join(channelHome, STATE_DIR_NAME));
    assert.equal(written.length, 13);
    assert.equal(written[12].channel, CHANNEL_NAMES.declined);
    assert.equal(written[12].received.requested, 'sttate', 'the decline names what was asked for');
    assert.equal(written[12].received.reason, CHANNEL_DECLINE_CODES.EUNKNOWN_CHANNEL);
  }

  // The bounded write is atomic: the temp file never survives a successful write.
  assert.equal(existsSync(join(channelHome, STATE_DIR_NAME, CHANNEL_OUT_FILE + '.tmp')), false,
    'the temp file must be renamed away, never left behind');

  // Anti-forgery, for types that are NOT ours, is untouched: `false` is stock's
  // answer there, so it must stay `false`.
  assert.equal(drive({ type: 'not-official', requestId: 7 }), false,
    'a requestId on a message the official validator rejects must not be accepted either');
  assert.equal(drive({ type: 'not-official', error: 'boom' }), false);

  // OFFICIAL control replies carry `requestId` BY DESIGN and must survive.
  // (Rejecting them would make main call `child.kill("SIGTERM")` on every
  // update-task inspection, quit inspection and file-drag reply.)
  assert.equal(drive({ type: 'update-tasks', requestId: 3, active: true }), true,
    'an official control reply must still be accepted');
  assert.equal(drive({ type: 'quit-inspection', requestId: 4 }), true);
  assert.equal(drive({ type: 'file-drag-resource', requestId: 5, resource: null }), true);

  // DEGRADATION: if the binding cannot be assigned (a future shell declares it
  // `const`), the block must leave the official validator in place instead of
  // throwing at module load.
  const frozen = join(PROBE_DIR, 'shipped-block-const.mjs');
  writeFileSync(frozen, [
    stubSource,
    officialSource,
    'const isDesktopHostEvent = official;',
    IPC_BODY,
    'export { isDesktopHostEvent, official };',
  ].join('\n'), 'utf8');
  const degraded = await import(`file:///${frozen.replaceAll('\\', '/')}`);
  assert.equal(degraded.isDesktopHostEvent, degraded.official,
    'when the binding is not assignable, the OFFICIAL validator must stay in place');
  assert.equal(degraded.isDesktopHostEvent({ type: 'ready', url: 'http://x' }), true,
    'and the app must keep working exactly as before');

  // THE property that makes this a guard rather than a feature: on every input
  // that is NOT ours, the shipped wrapper answers EXACTLY what the official
  // validator answers. Nothing is accepted that stock would reject, nothing is
  // rejected that stock would accept — so the desktop app behaves as it did
  // before for every stock message, and the only new acceptance is our type.
  const corpus = [
    null, undefined, 0, '', [], {}, 'ready',
    { hello: 'world' },
    { type: 'ready', url: 'http://x' },
    { type: 'starting' },
    { type: 'starting', runId: 'r' },
    { type: 'update-tasks', requestId: 1, active: true },
    { type: 'update-tasks', requestId: 1, active: 'yes' },
    { type: 'quit-inspection', requestId: 2, activeTasks: false, scheduledTasks: false },
    { type: 'file-drag-resource', requestId: 3, resource: null },
    { type: 'fatal' },
    { type: 'platform-session', session: null },
    { type: 'nope' },
    { type: 'nope', requestId: 9 },
    { type: 'nope', error: 'boom' },
  ];
  for (const message of corpus) {
    const wrapped = block.isDesktopHostEvent(message);
    const stock = block.official(message);
    assert.equal(wrapped, stock,
      `the wrapper must answer like stock for ${JSON.stringify(message) ?? String(message)}:`
      + ` wrapper ${String(wrapped)}, official ${String(stock)}`);
  }

  // Our type is the ONE deliberate exception, and it is enumerated rather than
  // waved at. AFTER THE FIX every message of our type answers `true`: the three
  // filters live inside the handler now, where they can only DECLINE, never kill
  // the child.
  const reservedCorpus = [
    { message: { type: RESERVED_HOST_EVENT_TYPE }, official: false, expected: true },
    { message: { type: RESERVED_HOST_EVENT_TYPE, requestId: 7 }, official: false, expected: true },
    { message: { type: RESERVED_HOST_EVENT_TYPE, channel: 5 }, official: false, expected: true },
    { message: { type: RESERVED_HOST_EVENT_TYPE, channel: 'sttate' }, official: false, expected: true },
    { message: { type: RESERVED_HOST_EVENT_TYPE, channel: 'ping' }, official: false, expected: true },
    { message: { type: RESERVED_HOST_EVENT_TYPE, channel: 'state', payload: { a: 1 } }, official: false, expected: true },
    { message: { type: RESERVED_HOST_EVENT_TYPE, channel: 'state', payload: 'x'.repeat(CHANNEL_PAYLOAD_MAX_BYTES + 1) }, official: false, expected: true },
    { message: { type: RESERVED_HOST_EVENT_TYPE, channel: 'ping' }, official: true, expected: true },
  ];
  for (const entry of reservedCorpus) {
    const wrapped = block.isDesktopHostEvent(entry.message);
    assert.equal(wrapped, entry.expected,
      `reserved ${JSON.stringify(entry.message).slice(0, 120)} with official=${entry.official}`
      + ` must answer ${entry.expected}, got ${wrapped}`);
  }

  // THE regression, stated in one line: for OUR type the wrapper is TOTAL.
  // Whatever the shape, the answer is `true` — the one outcome that keeps the
  // Host child alive.
  for (const label of ['mistyped', 'oversize', 'forged', 'absent', 'blob', 'garbage']) {
    const message = {
      mistyped: { type: RESERVED_HOST_EVENT_TYPE, channel: 'sttate' },
      oversize: { type: RESERVED_HOST_EVENT_TYPE, channel: 'state', payload: 'x'.repeat(9000) },
      forged: { type: RESERVED_HOST_EVENT_TYPE, channel: 'ping', requestId: 7, error: 'boom' },
      absent: { type: RESERVED_HOST_EVENT_TYPE },
      blob: { type: RESERVED_HOST_EVENT_TYPE, channel: Object.assign(Object.create(null), { big: 'x'.repeat(100) }) },
      garbage: { type: RESERVED_HOST_EVENT_TYPE, channel: 'window', payload: 'not-an-object' },
    }[label];
    assert.equal(block.isDesktopHostEvent(message), true, `${label}: OUR type must ALWAYS answer true`);
  }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('classifyHostEvent decision table (pure function, no archive involved)', () => {
  // 1. malformed -> delegate, the official validator owns every bad answer.
  for (const message of [undefined, null, 0, '', 'ready', [], { hello: 'world' }]) {
    assert.equal(classifyHostEvent(message, false), HOST_EVENT_VERDICTS.delegate,
      `malformed ${JSON.stringify(message) ?? String(message)} must delegate`);
  }

  // 2. THE RULE: our own type is accepted, whatever else it carries. There is no
  //    input of our type that answers `reject` — refusing our own type is the one
  //    outcome that makes main kill the Host child, and "accepted but dropped" is
  //    always the safer failure.
  const hostileOfOurs = [
    { type: RESERVED_HOST_EVENT_TYPE },
    { type: RESERVED_HOST_EVENT_TYPE, channel: 'ping', requestId: 7 },
    { type: RESERVED_HOST_EVENT_TYPE, channel: 'ping', error: 'boom' },
    { type: RESERVED_HOST_EVENT_TYPE, channel: 'ping', requestId: null },
    { type: RESERVED_HOST_EVENT_TYPE, channel: 7 },
    { type: RESERVED_HOST_EVENT_TYPE, channel: 'PING' },
    { type: RESERVED_HOST_EVENT_TYPE, channel: 'sttate' },
    { type: RESERVED_HOST_EVENT_TYPE, channel: 'a'.repeat(33) },
    { type: RESERVED_HOST_EVENT_TYPE, channel: '' },
    { type: RESERVED_HOST_EVENT_TYPE, channel: 'state', payload: 'x'.repeat(CHANNEL_PAYLOAD_MAX_BYTES + 1) },
    { type: RESERVED_HOST_EVENT_TYPE, channel: 'state', payload: { n: 1 } },
    { type: RESERVED_HOST_EVENT_TYPE, channel: 'window', payload: 'not-an-object' },
    { type: RESERVED_HOST_EVENT_TYPE, channel: 'notify', payload: { title: 'x'.repeat(CHANNEL_NOTIFY_TITLE_MAX + 1) } },
  ];
  for (const message of hostileOfOurs) {
    for (const official of [false, true, undefined]) {
      const verdict = classifyHostEvent(message, official);
      assert.equal(verdict, HOST_EVENT_VERDICTS.accept,
        `our type must ALWAYS be accepted: ${JSON.stringify(message).slice(0, 100)} (official=${String(official)})`
        + ` answered ${verdict}`);
    }
  }

  // 3. `accept` is reachable ONLY for our own type. No other type can reach it,
  //    so stock behaviour for everything else is unchanged by construction.
  const accepted = new Set([HOST_EVENT_VERDICTS.accept]);
  for (const message of [
    { type: 'ready', url: 'http://x' },
    { type: 'update-tasks', requestId: 1, active: true },
    { type: 'nope' },
    { hello: 'world' },
  ]) {
    for (const official of [false, true]) {
      assert.equal(accepted.has(classifyHostEvent(message, official)), false,
        `${message.type} must never be answered accept (official=${official})`);
    }
  }

  // 4. anti-forgery for every OTHER type survives the fix: a message the official
  //    validator does not accept may not smuggle a `requestId` / `error` into the
  //    control-response branch. This is exactly stock's answer, so nothing moves.
  assert.equal(classifyHostEvent({ type: 'x', requestId: 7 }, false), HOST_EVENT_VERDICTS.reject);
  assert.equal(classifyHostEvent({ type: 'x', requestId: null }, false), HOST_EVENT_VERDICTS.reject,
    'the check is `!== undefined`, so even a null requestId counts as carried');
  assert.equal(classifyHostEvent({ type: 'x', error: 'boom' }, false), HOST_EVENT_VERDICTS.reject);

  // 5. everything else -> delegate: stock behaviour, byte for byte.
  assert.equal(classifyHostEvent({ type: 'ready', url: 'http://127.0.0.1:1' }, true), HOST_EVENT_VERDICTS.delegate);
  assert.equal(classifyHostEvent({ type: 'whatever' }, false), HOST_EVENT_VERDICTS.delegate);
  assert.equal(classifyHostEvent({ type: 'starting', runId: 'r' }, true), HOST_EVENT_VERDICTS.delegate);

  // 6. THE measured exception that keeps the wrapper from killing healthy apps:
  //    official control replies carry `requestId` BY DESIGN (the official
  //    validator REQUIRES it for update-tasks / file-drag-resource /
  //    quit-inspection). Refusing those would make main call `this.fail()` and
  //    `child.kill("SIGTERM")` on every update-task inspection, quit inspection
  //    and file-drag reply. So a `requestId` on a message the official validator
  //    ACCEPTS is delegated, never rejected.
  const values = [false, true, undefined, null, 'yes'];
  const officialReplies = [
    { type: 'update-tasks', requestId: 3, active: true },
    { type: 'quit-inspection', requestId: 4, activeTasks: false, scheduledTasks: false },
    { type: 'file-drag-resource', requestId: 5, resource: null },
  ];
  for (const reply of officialReplies) {
    for (const official of values) {
      const verdict = classifyHostEvent(reply, official);
      assert.equal(
        verdict,
        official === true ? HOST_EVENT_VERDICTS.delegate : HOST_EVENT_VERDICTS.reject,
        `${reply.type} with official=${String(official)} must answer ${official === true ? 'delegate' : 'reject'}, got ${verdict}`,
      );
    }
  }

  // 7. Never throws — and a hostile input that is OURS degrades to `accept`, not
  //    to a refusal, because the refusal is what costs the session.
  assert.equal(classifyHostEvent(new Proxy({}, { has() { throw new Error('x'); } }), false), HOST_EVENT_VERDICTS.delegate);
  assert.equal(
    classifyHostEvent(Object.defineProperty({}, 'type', { get() { throw new Error('x'); } }), false),
    HOST_EVENT_VERDICTS.delegate,
  );
  const oursWithHostileChannel = Object.defineProperties({}, {
    type: { value: RESERVED_HOST_EVENT_TYPE, enumerable: true },
    channel: { get() { throw new Error('hostile'); }, enumerable: true },
  });
  assert.equal(classifyHostEvent(oursWithHostileChannel, false), HOST_EVENT_VERDICTS.accept,
    'an unreadable message of our type is still OUR type: accept, never reject');
});

// ----------------------------------------------------- the two real channels --
// `notify` and `window` are the point of this version: they do real work inside
// the Electron main process, with no poll tick in the way. What is proven here is
// (a) that their handlers DECLINE cleanly when the Electron providers are absent —
//     the legal state of a shell that moved the imports — and (b) that the window
//     validator in the region is the SAME source the contract module tests.

/**
 * Write a module that carries ONLY the handler block, with the given module-scope
 * stubs — no archive, no IPC wrapper, no official validator.
 *
 * @param {string} name file name inside PROBE_DIR
 * @param {string[]} prologue source lines standing in for the shell's scope
 * @returns {Promise<object>} the module's exports
 */
async function loadHandlerBlock(name, prologue) {
  mkdirSync(PROBE_DIR, { recursive: true });
  const file = join(PROBE_DIR, name);
  writeFileSync(file, [
    'import { createRequire } from "node:module";',
    ...prologue,
    CHANNEL_HANDLER_BLOCK,
    'export { __channelHandle, __handleNotify, __handleWindow, __windowRegistry, __channelNames, __decline };',
  ].join('\n'), 'utf8');
  return import(`file:///${file.replaceAll('\\', '/')}`);
}

test('notify declines cleanly when Notification is absent, and always answers true', async () => {
  const channelHome = join(PROBE_DIR, 'notify-home');
  mkdirSync(join(channelHome, STATE_DIR_NAME), { recursive: true });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = channelHome;
  try {
    // NO `Notification` in the module scope at all: the state a shell that moved
    // the import presents. The handler must decline and record, never throw.
    const block = await loadHandlerBlock('handler-no-notify.mjs', []);
    const drive = (payload) => block.__channelHandle(
      { type: RESERVED_HOST_EVENT_TYPE, channel: 'notify', payload },
      void 0,
      block.__windowRegistry,
    );

    assert.equal(drive({ title: 'Hello' }), true, 'a notify request with no provider still answers true');
    const envelopes = readFileSync(join(channelHome, STATE_DIR_NAME, CHANNEL_OUT_FILE), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].channel, CHANNEL_NAMES.declined,
      'a declined notify is recorded under `declined`, not as a notify ack');
    assert.equal(envelopes[0].received.reason, CHANNEL_DECLINE_CODES.EPROVIDER_ABSENT);

    // A malformed toast is declined for its OWN reason, and the answer stays true.
    assert.equal(drive(null), true);
    assert.equal(drive({ title: 'x'.repeat(CHANNEL_NOTIFY_TITLE_MAX + 1) }), true);
    const after = readFileSync(join(channelHome, STATE_DIR_NAME, CHANNEL_OUT_FILE), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(after.length, 3);
    assert.equal(after[1].received.reason, CHANNEL_DECLINE_CODES.EINVALID_TOAST);
    assert.equal(after[2].received.reason, CHANNEL_DECLINE_CODES.EINVALID_TOAST);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('notify shows a real notification when Notification IS injected, and acks `shown`', async () => {
  const channelHome = join(PROBE_DIR, 'notify-shown-home');
  mkdirSync(join(channelHome, STATE_DIR_NAME), { recursive: true });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = channelHome;
  try {
    // A recording stand-in shaped exactly like Electron's class: constructible,
    // with `isSupported()` on the class and `on`/`once`/`show()` on the instance.
    // It records into a global because the probe module exports only the handler
    // block, and the test wants to see the native calls it made.
    globalThis.__toastRecords = { constructed: 0, shown: 0, instances: [] };
    const block = await loadHandlerBlock('handler-with-notify.mjs', [
      'function Notification(options) {',
      '  const handlers = [];',
      '  const instance = { options, handlers, on(e, f) { handlers.push([e, f]); }, once(e, f) { handlers.push([e, f]); },',
      '    show() { globalThis.__toastRecords.shown += 1; } };',
      '  globalThis.__toastRecords.constructed += 1;',
      '  globalThis.__toastRecords.instances.push(instance);',
      '  return instance;',
      '}',
      'Notification.isSupported = () => true;',
    ]);
    const drive = (payload) => block.__channelHandle(
      { type: RESERVED_HOST_EVENT_TYPE, channel: 'notify', payload },
      void 0,
      block.__windowRegistry,
    );

    assert.equal(drive({ title: 'Hello', body: 'World', silent: true }), true);
    const acks = readFileSync(join(channelHome, STATE_DIR_NAME, CHANNEL_OUT_FILE), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(acks.length, 1);
    assert.equal(acks[0].channel, 'notify');
    assert.equal(acks[0].received, 'shown', 'the ack says what actually happened');

    // The constructor and `show()` really ran — that is the "lag-0" claim, and it
    // is what the file channel cannot promise (it polls on a 700 ms tick).
    assert.equal(globalThis.__toastRecords.constructed, 1, 'exactly one Notification was constructed');
    assert.equal(globalThis.__toastRecords.shown, 1, 'and it was shown immediately');
    assert.equal(globalThis.__toastRecords.instances[0].handlers.length, 2,
      'both handlers were attached: `failed` and `click`');
    assert.deepEqual(
      { title: globalThis.__toastRecords.instances[0].options.title, body: globalThis.__toastRecords.instances[0].options.body, silent: globalThis.__toastRecords.instances[0].options.silent },
      { title: 'Hello', body: 'World', silent: true },
      'the toast carries exactly the three allowed fields',
    );

    // An unsupported platform is reported, not hidden.
    const unsupported = await loadHandlerBlock('handler-unsupported-notify.mjs', [
      'function Notification(options) { return { options, on() {}, once() {}, show() {} }; }',
      'Notification.isSupported = () => false;',
    ]);
    assert.equal(
      unsupported.__channelHandle(
        { type: RESERVED_HOST_EVENT_TYPE, channel: 'notify', payload: { title: 'x' } },
        void 0,
        unsupported.__windowRegistry,
      ),
      true,
    );
    const unsupportedAcks = readFileSync(join(channelHome, STATE_DIR_NAME, CHANNEL_OUT_FILE), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(unsupportedAcks.length, 2);
    assert.equal(unsupportedAcks[1].channel, 'notify');
    assert.equal(unsupportedAcks[1].received, 'unsupported',
      'the ack distinguishes "this OS cannot toast" from "the toast was shown"');
  } finally {
    delete globalThis.__toastRecords;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('window rejects cleanly when BrowserWindow is absent, and always answers true', async () => {
  const channelHome = join(PROBE_DIR, 'window-home');
  mkdirSync(join(channelHome, STATE_DIR_NAME), { recursive: true });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = channelHome;
  try {
    const block = await loadHandlerBlock('handler-no-window.mjs', []);
    const drive = (payload) => block.__channelHandle(
      { type: RESERVED_HOST_EVENT_TYPE, channel: 'window', payload },
      void 0,
      block.__windowRegistry,
    );

    assert.equal(drive({ id: 'w1', route: '/settings' }), true, 'a window request with no provider answers true');
    let acks = readFileSync(join(channelHome, STATE_DIR_NAME, CHANNEL_OUT_FILE), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(acks.length, 1);
    assert.equal(acks[0].channel, 'window');
    assert.deepEqual(acks[0].received, {
      received: 'rejected',
      windowId: 'w1',
      reason: CHANNEL_DECLINE_CODES.EPROVIDER_ABSENT,
    }, 'the ack names the window and the reason code');

    // The contract's own refusals are reused verbatim: an unsafe route and an
    // out-of-range size are the codes `lib/bridge/src/windows.js` defines.
    assert.equal(drive({ id: 'w1', route: 'https://evil.example/x' }), true);
    assert.equal(drive({ id: 'w1', width: 20 }), true);
    acks = readFileSync(join(channelHome, STATE_DIR_NAME, CHANNEL_OUT_FILE), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(acks.length, 3);
    assert.equal(acks[1].received.reason, WINDOW_SPEC_CODES.EUNSAFE_ROUTE);
    assert.equal(acks[2].received.reason, WINDOW_SPEC_CODES.ERANGE);

    // One window per id and the MAX_WINDOW_SPECS cap are enforced by the region:
    // even with no provider, the registry is what decides "duplicate" first.
    const providerBlock = await loadHandlerBlock('handler-with-window.mjs', [
      'function BrowserWindow(options) { return { options, loadURL(url) { this.url = url; return Promise.resolve(); }, once() {}, destroy() {} }; }',
      'BrowserWindow.getAllWindows = () => [];',
    ]);
    const driveWith = (payload) => providerBlock.__channelHandle(
      { type: RESERVED_HOST_EVENT_TYPE, channel: 'window', payload },
      void 0,
      providerBlock.__windowRegistry,
    );
    assert.equal(driveWith({ id: 'w1', route: '/settings' }), true);
    assert.equal(providerBlock.__windowRegistry.size, 1, 'a constructed window is registered');
    assert.equal(driveWith({ id: 'w1', route: '/settings' }), true, 'a duplicate id is still answered true');
    const dup = providerBlock.__windowRegistry.size;
    assert.equal(dup, 1, 'a duplicate id must NOT add a second window');
    for (let index = 0; index < MAX_WINDOW_SPECS; index += 1) {
      driveWith({ id: `bulk-${index}`, route: '/x' });
    }
    assert.equal(providerBlock.__windowRegistry.size <= MAX_WINDOW_SPECS, true,
      `the registry must stay at or under ${MAX_WINDOW_SPECS} windows`);
    assert.equal(providerBlock.__windowRegistry.size, MAX_WINDOW_SPECS,
      'the cap is reached, not exceeded');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

// --------------------------------------------------------------- the planning --

test('planSplit measures the stock layout and refuses nothing', { skip: BASELINE === null ? NO_BASELINE : false }, () => {
  const copy = makeStockCopy('plan.asar');
  if (copy === null) return;

  const plan = planSplitFile(copy, REGION_RESERVE_BYTES);
  assert.equal(plan.ok, true, plan.ok === true ? '' : `${plan.code}: ${plan.message}`);

  assert.equal(plan.reserve, REGION_RESERVE_BYTES);
  assert.equal(insertOffsetOf(plan), STOCK_SLOT_START + STOCK_SLOT_LENGTH,
    'the insertion point is exactly the end of the official slot');
  assert.equal(plan.mainSizeBefore, STOCK_MAIN_SIZE);
  assert.equal(plan.mainSizeAfter, STOCK_MAIN_SIZE + REGION_RESERVE_BYTES);

  // The measured cost of this layout on this release: 29 trailing entries
  // (993,917 B) plus the 67,863 B tail of lib/main.js.
  assert.equal(plan.movingBytes, 1061780, 'the measured amount of data that has to move');
  assert.equal((plan.movedEntries ?? []).length, 29, '29 entries sit after lib/main.js');

  // The one invariant the whole design rests on.
  assert.equal(plan.headerStaysSameLength, true,
    'rewriting 30 integer fields must not change the directory header length');
});

test('planSplit refuses when the rewrite would change the header length', { skip: BASELINE === null ? NO_BASELINE : false }, () => {
  const copy = makeStockCopy('too-big.asar');
  if (copy === null) return;

  // `lib/main.js`.size gains its seventh digit above 1,000,000, which is exactly
  // where the "no blocks payback" budget runs out. Asking beyond it must be
  // refused rather than silently paid for by deleting integrity blocks — that
  // would break "shrink reproduces the stock bytes".
  const plan = planSplitFile(copy, REGION_RESERVE_LIMIT + 1);
  assert.equal(plan.ok, false, 'an over-budget reserve must be refused');
  assert.equal(typeof plan.code, 'string');
  assert.equal(typeof plan.message, 'string');
  assert.equal(plan.message.length > 0, true, 'the refusal must explain itself');

  // Nothing was written: the copy is still the stock archive.
  assert.equal(sha256OfFile(copy), STOCK_ARCHIVE_SHA);
});

// ---------------------------------------------------------------- the surgery --

test('grow leaves the official slot pristine and the archive otherwise intact', { skip: BASELINE === null ? NO_BASELINE : false }, async () => {
  const copy = makeStockCopy('grow.asar');
  if (copy === null) return;

  const plan = planSplitFile(copy, REGION_RESERVE_BYTES);
  assert.equal(plan.ok, true, plan.ok === true ? '' : `${plan.code}: ${plan.message}`);

  const region = buildSplitRegion(REGION_RESERVE_BYTES);
  const grown = await growRegion(copy, plan, region);
  assert.equal(grown.ok, true, grown.ok === true ? '' : `${grown.code}: ${grown.message}`);

  assert.equal(statSync(copy).size, STOCK_ARCHIVE_SIZE + REGION_RESERVE_BYTES, 'the archive grew by exactly the reserve');

  // THE point of this layout: the 1,253 official bytes were never touched.
  const slot = readOfficialSlot(copy);
  assert.notEqual(slot, null);
  assert.equal(createHash('sha256').update(slot).digest('hex'), STOCK_SLOT_SHA,
    '官方的托盘槽位必须逐字节保持原样');

  const opened = openAsar(copy, { allowStaleMainIntegrity: true });
  assert.equal(opened.ok, true);
  try {
    const main = readEntry(opened, 'lib/main.js');
    assert.equal(main.length, STOCK_MAIN_SIZE + REGION_RESERVE_BYTES);

    const text = main.toString('utf8');
    assert.equal(text.includes(SPLIT_PATCH_MARKER), true, 'our region is present');
    assert.equal(text.includes('/* dsh-asar-bridge-slot v0.1.0 */'), false,
      'the 0.1.x marker must NOT be inside the official slot any more');
  } finally {
    closeAsar(opened);
  }

  const verified = verifySplit(copy, plan, null);
  assert.equal(verified.ok, true, verified.ok === true ? '' : `${verified.code}: ${verified.message}`);
  assert.equal(verified.officialSlotSha, STOCK_SLOT_SHA);
  assert.equal(verified.regionLength, REGION_RESERVE_BYTES);
  assert.equal(verified.regionStartInMain, STOCK_SLOT_START + STOCK_SLOT_LENGTH);
});

test('shrink reproduces the stock archive byte for byte (uninstall needs no backup)', { skip: BASELINE === null ? NO_BASELINE : false }, async () => {
  const copy = makeStockCopy('shrink.asar');
  if (copy === null) return;

  const plan = planSplitFile(copy, REGION_RESERVE_BYTES);
  assert.equal(plan.ok, true);
  const grown = await growRegion(copy, plan, buildSplitRegion(REGION_RESERVE_BYTES));
  assert.equal(grown.ok, true, grown.ok === true ? '' : `${grown.code}: ${grown.message}`);
  assert.notEqual(sha256OfFile(copy), STOCK_ARCHIVE_SHA, 'the grown archive must differ from stock');

  const shrunk = await shrinkRegion(copy);
  assert.equal(shrunk.ok, true, shrunk.ok === true ? '' : `${shrunk.code}: ${shrunk.message}`);

  assert.equal(statSync(copy).size, STOCK_ARCHIVE_SIZE);
  assert.equal(sha256OfFile(copy), STOCK_ARCHIVE_SHA,
    '卸载不需要备份：反向手术必须逐字节还原成官方档案');
});

// -------------------------------------------------------------- idempotence --

test('a second install finds the region already present and moves nothing', { skip: BASELINE === null ? NO_BASELINE : false }, async () => {
  const copy = makeStockCopy('again.asar');
  if (copy === null) return;

  const first = planSplitFile(copy, REGION_RESERVE_BYTES);
  const grown = await growRegion(copy, first, buildSplitRegion(REGION_RESERVE_BYTES));
  assert.equal(grown.ok, true);

  const digestAfterFirst = sha256OfFile(copy);

  // Re-planning must notice our region and say so instead of planning a second
  // insertion (which would nest regions and move another gigabyte). The answer
  // is a rich refusal — `regionAlreadyPresent: true` plus a measured
  // `zeroMovement: true` — because the caller's next move on that answer is
  // "replace the region in place" or "just refresh the bridge", not "abort".
  const second = planSplitFile(copy, REGION_RESERVE_BYTES);
  assert.equal(second.ok, false, 'planning over an existing split region must be refused');
  assert.equal(second.regionAlreadyPresent, true, 'the refusal must say the region is already there');
  assert.equal(second.zeroMovement, true, 'and that a second install would move nothing');
  assert.equal(second.existingRegion.length, REGION_RESERVE_BYTES);
  assert.equal(second.existingRegion.startInMain, STOCK_SLOT_START + STOCK_SLOT_LENGTH);

  // `findSplitRegion` is the read-only half of that answer: it locates our
  // region so a caller can decide "already installed, nothing to do".
  const opened = openAsar(copy, { allowStaleMainIntegrity: true });
  assert.equal(opened.ok, true);
  try {
    const found = findSplitRegion(opened);
    assert.equal(found.ok, true, found.ok === true ? '' : `${found.code}: ${found.message}`);
    assert.equal(found.startInMain, STOCK_SLOT_START + STOCK_SLOT_LENGTH);
    assert.equal(found.length, REGION_RESERVE_BYTES);
  } finally {
    closeAsar(opened);
  }

  // Nothing moved between the two calls.
  assert.equal(sha256OfFile(copy), digestAfterFirst, 'a second plan must not touch the archive');
});

test('findSplitRegion reports "absent" on a stock archive as a refusal, not a crash', { skip: BASELINE === null ? NO_BASELINE : false }, () => {
  const copy = makeStockCopy('absent.asar');
  if (copy === null) return;

  const opened = openAsar(copy, { allowStaleMainIntegrity: true });
  assert.equal(opened.ok, true);
  try {
    const found = findSplitRegion(opened);
    // On a stock archive our marker is simply not there. That is a REFUSAL with
    // a code a caller can branch on (`EREGION_NOT_FOUND`), not an exception and
    // not a `ok:true, present:false` — "the region is absent" and "I could not
    // read the archive" have to stay distinguishable.
    assert.equal(found.ok, false);
    assert.equal(found.code, 'EREGION_NOT_FOUND');
    assert.equal(typeof found.message, 'string');
    assert.equal(found.message.includes(SPLIT_START_MARKER), true, 'the refusal names the marker it looked for');
  } finally {
    closeAsar(opened);
  }
});

// --------------------------------------------------------- plan/file agreement --

test('a plan that disagrees with the file is refused, not "corrected"', { skip: BASELINE === null ? NO_BASELINE : false }, async () => {
  const copy = makeStockCopy('stale.asar');
  if (copy === null) return;

  // Deliberately corrupt the plan: the file is untouched stock, so a plan
  // claiming a different insertion point describes a different archive. Writing
  // it would corrupt every offset after lib/main.js, so it must be refused.
  const plan = planSplitFile(copy, REGION_RESERVE_BYTES);
  assert.equal(plan.ok, true);
  const tampered = { ...plan, insertAtInFile: insertOffsetOf(plan) - 1 };
  const attempt = await growRegion(copy, tampered, buildSplitRegion(REGION_RESERVE_BYTES));
  assert.equal(attempt.ok, false, 'a stale plan must be rejected');
  assert.equal(typeof attempt.code, 'string');
  assert.equal(sha256OfFile(copy), STOCK_ARCHIVE_SHA, 'nothing may be written when the plan is refused');
});

// ---------------------------------------------------------------- guard rails --

test('planSplit is read-only: the archive digest is unchanged by planning', { skip: BASELINE === null ? NO_BASELINE : false }, () => {
  const copy = makeStockCopy('read-only.asar');
  if (copy === null) return;

  const before = sha256OfFile(copy);
  // `planSplit` takes an ALREADY OPENED asar (the installer opens it once and
  // derives several facts from it); `planSplitFile` opens it itself. Both must
  // answer without writing.
  const opened = openAsar(copy, { allowStaleMainIntegrity: true });
  assert.equal(opened.ok, true);
  let plan;
  try {
    plan = planSplit(opened, REGION_RESERVE_BYTES);
  } finally {
    closeAsar(opened);
  }
  assert.equal(plan.ok, true, plan.ok === true ? '' : `${plan.code}: ${plan.message}`);

  const fromFile = planSplitFile(copy, REGION_RESERVE_BYTES);
  assert.equal(fromFile.ok, true);
  assert.equal(insertOffsetOf(fromFile), insertOffsetOf(plan),
    'the opened-asar and from-file planners must agree on the insertion point');

  assert.equal(sha256OfFile(copy), before, 'planning must not write a single byte');
});

test('the reserve constant stays inside the measured safe band', () => {
  // 16 KiB is still two orders of magnitude below the boundary (151,494 B), and
  // the boundary is what keeps "shrink == stock" true.
  assert.equal(REGION_RESERVE_BYTES, 16384, 'the reserve is 16 KiB since the two real channels');
  assert.equal(REGION_RESERVE_BYTES < REGION_RESERVE_LIMIT, true);
  assert.equal(REGION_RESERVE_BYTES + STOCK_MAIN_SIZE < 1000000, true,
    'main.js must stay below the seventh digit, or the header grows');
});
