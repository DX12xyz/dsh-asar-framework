/**
 * Diagnostics: the two operator-facing files the bridge owns.
 *
 * `bridge.load.json` proves the patched main process actually reached the
 * bridge (it is written once, before any menu work). `bridge.json` records the
 * last render, including the reason it fell back to the official menu. Both are
 * best-effort: a diagnostic write failure is swallowed, because a diagnostics
 * problem must never take the tray down with it.
 */

import { BRIDGE_VERSION, FILES, RELOAD_MAX_ATTEMPTS, writeTextAtomic } from './paths.js';

/**
 * THE key order of `bridge.json`, in ONE place.
 *
 * Why a constant instead of an object literal: every block added since 0.4.0
 * ("append it after the shipped keys, keep the shipped order") is exactly the kind
 * of change that gets argued about twice — once in the writer and once in a test
 * that restates the same list. There is now one ordered source: the writer walks
 * this array to build the document, and `test/bridge-hot-reload.test.mjs` asserts
 * `Object.keys(bridge.json)` against it. A future block is added HERE and nowhere
 * else.
 *
 * The invariant the order encodes: the 0.4.0 keys keep their positions
 * (`version … notify, reload, renderedAt` — `renderedAt` was that release's last
 * key, so it stays last among the 0.4.0 group), and every later block is APPENDED
 * in the order it arrived (`patches` is the dynamic-patch hook, `windows` is the
 * window close observer). A diagnostics file whose key order moves around is what
 * makes a diff useless.
 *
 * @type {readonly string[]}
 */
export const RENDER_RECORD_KEYS = Object.freeze([
  'version',
  'rev',
  'itemCount',
  'reason',
  'lastError',
  'channel',
  'notify',
  'reload',
  'renderedAt',
  'patches',
  'windows',
]);

/**
 * Stable, order-fixed JSON so two runs on identical input produce identical
 * bytes and the file is easy to eyeball in a bug report.
 *
 * @param {Record<string, unknown>} value
 * @returns {string}
 */
function stableJson(value) {
  return JSON.stringify(value) + '\n';
}

/**
 * Write the "the bridge is loaded" marker.
 *
 * @param {{
 *   stateDir: string | null,
 *   asarSha: string | null,
 *   electron: string | null,
 *   now: string,
 *   pid: number,
 * }} input
 * @returns {{ ok: boolean, error: string | null }}
 */
export function writeLoadMarker(input) {
  if (input.stateDir === null) return { ok: false, error: 'state directory unavailable' };
  const payload = {
    pid: input.pid,
    version: BRIDGE_VERSION,
    loadedAt: input.now,
    electron: input.electron,
    stateDir: input.stateDir,
  };
  if (typeof input.asarSha === 'string' && input.asarSha !== '') payload.asarSha = input.asarSha;
  return writeTextAtomic(joinState(input.stateDir, FILES.load), stableJson(payload));
}

/**
 * Write the last-render record.
 *
 * Shape is fixed by the contract: `{version, rev, itemCount, reason, lastError,
 * channel, notify, reload, renderedAt, patches}` — and the ORDER is defined exactly
 * once, in {@link RENDER_RECORD_KEYS}. A `reason` of `'error'` always carries a
 * `lastError` string. Every key that 0.4.0 shipped keeps its EXACT position,
 * `patches` (the dynamic-patch hook's record) and `windows` (the window close
 * observer's record) are appended after it, so the file stays diffable against an
 * older build.
 *
 * WHY `channel`, `notify` AND `patches` ARE IN THIS FILE AT ALL
 * They used to live only in `status()`, i.e. inside the bridge process, which
 * made them unreadable by anybody: a support report could not answer "did the
 * region answer my message", "why did my toast not appear" or "did my patch land
 * and if not why" without attaching a debugger. All three blocks are BOUNDED (a
 * handful of numbers, one clipped string each) so folding them here costs a few
 * dozen bytes in a file this build writes anyway.
 *
 * They are DIAGNOSTICS, not a control surface: nothing in this plugin reads them
 * back, and the Host (which owns `status.json`) does not either. A human reads
 * `bridge.json`; that is the whole contract.
 *
 * @param {{
 *   stateDir: string | null,
 *   rev: number,
 *   itemCount: number,
 *   reason: 'empty' | 'ok' | 'error',
 *   lastError: string | null,
 *   channel?: object | null,
 *   notify?: object | null,
 *   reload?: object | null,
 *   patches?: object | null,
 *   windows?: object | null,
 *   renderedAt: string,
 * }} input
 * @returns {{ ok: boolean, error: string | null }}
 */
export function writeRenderRecord(input) {
  if (input.stateDir === null) return { ok: false, error: 'state directory unavailable' };
  // Build the document FROM `RENDER_RECORD_KEYS`, never from an object literal:
  // the constant is the one definition of the order, so a writer edit cannot
  // disagree with it, and a test can assert the file against the same list.
  const fields = {
    version: BRIDGE_VERSION,
    rev: normalizeCount(input.rev),
    itemCount: normalizeCount(input.itemCount),
    reason:
      input.reason === 'ok' || input.reason === 'error' || input.reason === 'empty' ? input.reason : 'empty',
    lastError:
      input.lastError === null || input.lastError === undefined
        ? null
        : String(input.lastError).slice(0, 400),
    channel: boundedChannel(input.channel),
    notify: boundedNotify(input.notify),
    reload: boundedReload(input.reload),
    renderedAt: input.renderedAt,
    patches: boundedPatches(input.patches),
    windows: boundedWindows(input.windows),
  };
  const payload = {};
  for (const key of RENDER_RECORD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) payload[key] = fields[key];
  }
  return writeTextAtomic(joinState(input.stateDir, FILES.status), stableJson(payload));
}

/**
 * The `patches` block as it is PERSISTED — the dynamic-patch hook's record.
 *
 * ALWAYS PRESENT, and always the same shape, INCLUDING when nothing is patched
 * (`{available:false, applied:0, replayed:0, missed:0, failed:0, lastError:null,
 * rev:0}`). A conditional key would make "the block is missing because nothing is
 * patched" indistinguishable from "the block is missing because the build is old" — the
 * one question a support report has to answer from a single file.
 *
 * WHY IT LIVES IN `bridge.json`: a patch that failed to apply is the one event a
 * plugin author actively waits on, and the answer to "did it land, and if not why"
 * has to survive a debugger never being attached — the same rule that moved
 * `channel` and `notify` here. The block is BOUNDED on purpose: the counters
 * saturate (`normalizeCount` floors them), and `lastError` is clipped to 160
 * characters, because the text can quote source the patch author wrote and a
 * diagnostics file must never be growable by what it observes.
 *
 * `rev` is the spec's own revision, so a human can tell "no spec was ever seen"
 * (`rev: 0`) from "the spec was read but nothing applied" without opening the file.
 *
 * Still diagnostics, not a control surface: nothing reads these keys back.
 *
 * @param {object|null|undefined} value
 * @returns {{ available: boolean, applied: number, replayed: number, missed: number,
 *   failed: number, lastError: string | null, rev: number }}
 */
function boundedPatches(value) {
  const source = value !== null && typeof value === 'object' ? value : {};
  const lastError = source.lastError;
  return {
    available: source.available === true,
    applied: normalizeCount(source.applied),
    replayed: normalizeCount(source.replayed),
    missed: normalizeCount(source.missed),
    failed: normalizeCount(source.failed),
    lastError: typeof lastError === 'string' && lastError !== '' ? lastError.slice(0, 160) : null,
    rev: normalizeCount(source.rev),
  };
}

/**
 * The `reload` block as it is PERSISTED — the artefact's own hot-reload record.
 *
 * WHY IT LIVES IN `bridge.json`: a reload is the one bridge event a human
 * triggers from outside the process (a file copy), so the answer to "did it
 * land, and if not why" has to survive a debugger being attached — the same rule
 * that moved `channel` and `notify` here. The block is BOUNDED on purpose:
 * `attempts` / `succeeded` saturate instead of growing by one per failure, and
 * `lastError` is clipped to 160 characters, because the failure text comes from
 * a third-party artefact (a syntax error can quote a whole line) and a
 * diagnostics file must never be growable by what it observes.
 *
 * Still diagnostics, not a control surface: nothing reads these keys back.
 *
 * @param {object|null|undefined} value
 * @returns {{ attempts: number, succeeded: number, lastAt: string|null, lastError: string|null } | null}
 */
function boundedReload(value) {
  if (value === null || typeof value !== 'object') return null;
  const lastAt = value.lastAt;
  const lastError = value.lastError;
  return {
    attempts: normalizeCount(value.attempts) > RELOAD_MAX_ATTEMPTS
      ? RELOAD_MAX_ATTEMPTS
      : normalizeCount(value.attempts),
    succeeded: normalizeCount(value.succeeded) > RELOAD_MAX_ATTEMPTS
      ? RELOAD_MAX_ATTEMPTS
      : normalizeCount(value.succeeded),
    lastAt: typeof lastAt === 'string' && lastAt !== '' ? lastAt.slice(0, 40) : null,
    lastError: typeof lastError === 'string' && lastError !== '' ? lastError.slice(0, 160) : null,
  };
}

/**
 * The `channel` block as it is PERSISTED.
 *
 * Deliberately narrower than `status().channel`: the live document can carry a
 * cursor and `sent` (a queue that no longer exists), while this file is what a
 * human reads a week later. `lastAck` is CLIPPED, because `received` is
 * caller-controlled data of up to 4 KiB and a diagnostics file must not be
 * growable by whoever sends messages.
 *
 * @param {object|null|undefined} value
 * @returns {{ available: boolean, acks: number, lastAck: object|null, declined: number,
 *   skipped: number, rotated: number } | null}
 */
function boundedChannel(value) {
  if (value === null || typeof value !== 'object') return null;
  const lastAck = value.lastAck;
  return {
    available: value.available === true,
    acks: normalizeCount(value.acks),
    lastAck: lastAck === null || typeof lastAck !== 'object'
      ? null
      : {
        channel: String(lastAck.channel === undefined ? '' : lastAck.channel).slice(0, 32),
        received: String(lastAck.received === undefined ? '' : lastAck.received).slice(0, 160),
        at: String(lastAck.at === undefined ? '' : lastAck.at).slice(0, 40),
      },
    declined: normalizeCount(value.declined),
    skipped: normalizeCount(value.skipped),
    rotated: normalizeCount(value.rotated),
  };
}

/**
 * The `notify` block as it is PERSISTED — numbers only, no provider objects.
 *
 * @param {object|null|undefined} value
 * @returns {{ available: boolean, shown: number, rateLimited: number, invalid: number,
 *   duplicates: number, rev: number } | null}
 */
function boundedNotify(value) {
  if (value === null || typeof value !== 'object') return null;
  return {
    available: value.available === true,
    shown: normalizeCount(value.shown),
    rateLimited: normalizeCount(value.rateLimited),
    invalid: normalizeCount(value.invalid),
    duplicates: normalizeCount(value.duplicates),
    rev: normalizeCount(value.rev),
  };
}

/**
 * The `windows` block as it is PERSISTED — the window close observer's record.
 *
 * ALWAYS PRESENT, same reason as `patches`: `{available:false, known:0, max:8,
 * closed:0, sampled:0, lastAt:null, lastError:null}` is what a shell that cannot
 * list windows reports, and a MISSING key would make "the observer is unavailable"
 * indistinguishable from "this build predates the observer".
 *
 * `known` is a COUNT, never the list: the windows themselves are named in
 * `status().windows.known.windows` (a live snapshot), because a diagnostics file
 * must not grow with the number of windows somebody opened. `max` is the region's
 * cap, quoted rather than re-derived — the two halves describe the same set.
 *
 * Still diagnostics, not a control surface: nothing reads these keys back.
 *
 * @param {object|null|undefined} value
 * @returns {{ available: boolean, known: number, max: number, closed: number,
 *   sampled: number, lastAt: string|null, lastError: string|null }}
 */
function boundedWindows(value) {
  const source = value !== null && typeof value === 'object' ? value : {};
  const lastAt = source.lastAt;
  const lastError = source.lastError;
  return {
    available: source.available === true,
    known: normalizeCount(source.known),
    max: normalizeCount(source.max),
    closed: normalizeCount(source.closed),
    sampled: normalizeCount(source.sampled),
    lastAt: typeof lastAt === 'string' && lastAt !== '' ? lastAt.slice(0, 40) : null,
    lastError: typeof lastError === 'string' && lastError !== '' ? lastError.slice(0, 160) : null,
  };
}

/**
 * @param {unknown} value
 * @returns {number} a non-negative finite integer, else 0
 */
function normalizeCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * @param {string} stateDir
 * @param {string} name
 * @returns {string} the file's path inside the state directory
 */
function joinState(stateDir, name) {
  return stateDir + '/' + name;
}
