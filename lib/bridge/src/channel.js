/**
 * The IPC channel's reader half: the ACK link between the injected region and
 * the bridge.
 *
 * WHY THIS MODULE EXISTS AT ALL
 * `lib/main.js` now ACCEPTS the reserved Host→main type `dsh-asar-bridge` (see the
 * IPC block in `lib/asar/patch-body.js`), but the function that accepts it is a
 * free module-scope function with no `this` — so it cannot call `child.send()` and
 * cannot reply over IPC. Its answer is therefore a FILE. This module is the half
 * that lives in the bridge (which does have a `stateDir` and a running process),
 * so somebody actually reads what the region wrote.
 *
 * ONE FILE, ONE DIRECTION, ONE WRITER
 *   channel.out.jsonl — the ACK direction: the region's handler appends to it,
 *                       `drain()` reads and consumes it with a byte cursor, and
 *                       the counter it keeps is what `bridge.json` persists.
 *
 * The REQUEST direction has no file. It used to have one (`channel.in.jsonl`,
 * written by a `send()` that nothing in production ever called — the Host sends
 * over real IPC via `asarShell.channelSend`, because the Host process IS the
 * `stdio: [..., "ipc"]` child). A queue nobody writes and nobody drains is worse
 * than no queue: it looks like a capability in the docs while being dead code
 * (audit 2026-11-16, item 8). It was deleted in 0.4.0, together with its two
 * `FILES` entries.
 *
 * EVERY FAILURE IS SOFT. A missing or unwritable state directory degrades to
 * `available: false` with a readable `lastError`; `drain()` answers an empty
 * result. Nothing here may throw into the tray's `relabel()` or into the poll
 * tick — a diagnostic channel must never cost the user his menu.
 *
 * RED LINES (the same as the rest of the bridge): no `require('electron')`, no
 * windows, no network, no reading inside the asar, no writing outside the state
 * directory.
 */

import {
  CHANNEL_MAX_BYTES,
  CHANNEL_NAME_PATTERN,
  CHANNEL_NAMES,
  FILES,
  PROTOCOL_CHANNEL,
  ensureDir,
  messageOf,
} from './paths.js';

import { readFileSync, statSync } from 'node:fs';
/** The channel-name shape, compiled from the one pattern string the wire owns. */
const CHANNEL_NAME_REGEX = new RegExp(CHANNEL_NAME_PATTERN);

/** @param {unknown} value @returns {boolean} true for a non-null, non-array object */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {string} the value when it is a string, otherwise '' */
function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Decode one line into a record, or null when it is not a channel envelope.
 *
 * The protocol number is checked here rather than in the caller: a document
 * written by an older or newer build must be recognised as "not mine" and
 * skipped, instead of being passed on as a half-understood object.
 *
 * @param {string} line
 * @param {number} protocol
 * @returns {{ protocol: number, channel: string, at: string, received: unknown } | null}
 */
function decodeEnvelope(line, protocol) {
  if (textOf(line) === '') return null;
  let value;
  try {
    value = JSON.parse(line);
  } catch (_error) {
    return null;
  }
  if (!isObject(value)) return null;
  if (value.protocol !== protocol) return null;
  const channel = textOf(value.channel);
  if (channel === '' || CHANNEL_NAME_REGEX.test(channel) !== true) return null;
  return { protocol, channel, at: textOf(value.at), received: value.received === undefined ? null : value.received };
}

/**
 * Create the ACK channel link.
 *
 * @param {{ stateDir?: string | null, protocol?: number }} [input]
 * @returns {{ status: () => object, drain: Function, dispose: () => void }}
 */
export function createChannelLink(input) {
  const settings = isObject(input) ? input : {};
  const stateDir = typeof settings.stateDir === 'string' && settings.stateDir !== '' ? settings.stateDir : null;
  const protocol = typeof settings.protocol === 'number' ? settings.protocol : PROTOCOL_CHANNEL;

  const state = {
    available: false,
    received: 0,
    skipped: 0,
    rotated: 0,
    /** Acks the region wrote for OUR message types (see the fold in `drain()`). */
    acks: 0,
    /** Acks whose name was `declined`: a refused-but-accepted message. */
    declined: 0,
    /** The most recent ack, clipped — what `bridge.json` persists. */
    lastAck: null,
    cursor: 0,
    lastError: stateDir === null ? 'state directory unavailable' : null,
    disposed: false,
  };

  /**
   * Last observed identity of the ack file, so an idle poll tick costs one `stat`
   * instead of a full read. The bridge polls this channel every tick, and
   * "nothing new" is the overwhelmingly common answer.
   */
  let lastSize = -1;
  let lastMtimeMs = -1;

  if (stateDir !== null) {
    const created = ensureDir(stateDir);
    if (created.ok !== true) {
      // Unwritable directory = the whole link is unavailable; it must degrade
      // instead of throwing inside `createBridge`.
      state.lastError = 'state directory is not writable: ' + (created.error === null ? 'unknown' : created.error);
    } else state.available = true;
    // No cursor is persisted on purpose: the ack file is consumed-on-read, and a
    // restored cursor would let a restart replay acks that were already handled.
    // Losing the few written during a restart is the lesser lie.
  }

  /**
   * Read and consume whatever the region left in `channel.out.jsonl`.
   *
   * CURSOR DISCIPLINE (identical to `events.jsonl`, for the same reason): only
   * COMPLETE lines are consumed — a trailing line without its newline is left
   * alone and the cursor stays at its start, so the next call picks it up once the
   * writer finishes. Byte offsets, never character offsets.
   *
   * ROTATION: the region rotates the file into `channel.out.jsonl.1` when it is
   * full. Two independent pieces of evidence count as a rotation (the live file
   * shrank below the cursor, or the rotated slot is newer than the live file);
   * either way the read restarts at 0 and the result says `rotated: true`, because
   * a byte cursor across two files means nothing. Records in the rotated slot are
   * NOT replayed.
   *
   * @returns {{ ok: boolean, records: object[], cursor: number, rotated: boolean, skipped: number }}
   */
  function drain() {
    const result = { ok: true, records: [], cursor: state.cursor, rotated: false, skipped: 0 };
    if (state.disposed) return result;
    if (state.available !== true) return result;
    const file = stateDir + '/' + FILES.channelOut;
    const rotatedFile = stateDir + '/' + FILES.channelOutRotated;

    let live;
    try {
      live = statSync(file);
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        // No file: the cursor goes back to zero. A cursor that was positive means
        // a file existed a moment ago and has been rotated or deleted, which the
        // caller learns from `rotated: true` — the records in it are not replayed.
        const wasRotated = state.cursor > 0;
        if (wasRotated) state.rotated += 1;
        state.cursor = 0;
        lastSize = -1;
        lastMtimeMs = -1;
        result.rotated = wasRotated;
        result.cursor = 0;
        return result;
      }
      state.lastError = 'channel.out.jsonl stat failed: ' + messageOf(error);
      return result;
    }
    if (live.isFile() !== true) {
      state.lastError = 'channel.out.jsonl is not a regular file';
      return result;
    }
    if (live.size > CHANNEL_MAX_BYTES) {
      // Somebody else wrote this file: refuse to trust a document past the cap
      // instead of spending the tick parsing it.
      state.lastError = 'channel.out.jsonl is ' + live.size + ' bytes; the cap is ' + CHANNEL_MAX_BYTES;
      return result;
    }
    // Fast path: nothing changed since the last full read and the cursor is at the
    // end of the file, so there cannot be a new complete line.
    if (live.size === lastSize && live.mtimeMs === lastMtimeMs && state.cursor >= live.size) return result;

    let rotatedStats = null;
    try {
      rotatedStats = statSync(rotatedFile);
    } catch (_error) {
      rotatedStats = null;
    }
    let rotated = state.cursor > 0 && live.size < state.cursor;
    if (
      rotated !== true &&
      state.cursor > 0 &&
      rotatedStats !== null &&
      rotatedStats.isFile() === true &&
      rotatedStats.mtimeMs > live.mtimeMs
    ) {
      rotated = true;
    }
    const start = rotated === true ? 0 : state.cursor;

    let buffer;
    try {
      buffer = readFileSync(file);
    } catch (error) {
      state.lastError = 'channel.out.jsonl read failed: ' + messageOf(error);
      return result;
    }
    const slice = buffer.subarray(start);
    let cut = -1;
    for (let index = slice.length - 1; index >= 0; index -= 1) {
      if (slice[index] === 0x0a) {
        cut = index;
        break;
      }
    }
    if (cut >= 0) {
      for (const line of slice.subarray(0, cut + 1).toString('utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        const record = decodeEnvelope(trimmed, protocol);
        if (record === null) {
          result.skipped += 1; // one bad line must not stall the channel
          continue;
        }
        result.records.push(record);
      }
    }
    lastSize = live.size;
    lastMtimeMs = live.mtimeMs;
    if (rotated) state.rotated += 1;
    state.cursor = start + cut + 1;
    state.skipped += result.skipped;
    state.received += result.records.length;
    // WHAT AN ACK IS, and why counting it is the whole point of this channel:
    // the region answers a `dsh-asar-bridge` message by APPENDING one envelope to
    // this file (`received` = what it did, or `channel:'declined'` = why it did
    // nothing). Those envelopes are the only evidence that a message was handled
    // at all — the region cannot reply over IPC. Counting them here is what makes
    // `bridge.json` able to answer "did my message land", which the raw counters
    // in `status()` never could: `status()` lives inside this process.
    for (const record of result.records) {
      state.acks += 1;
      if (record.channel === CHANNEL_NAMES.declined) state.declined += 1;
      state.lastAck = {
        channel: record.channel,
        received: summarizeAck(record.received),
        at: record.at,
      };
    }
    result.cursor = state.cursor;
    result.rotated = rotated;
    return result;
  }

  return {
    drain,

    /** @returns {object} the `status().channel` document */
    status() {
      return {
        available: state.available,
        received: state.received,
        skipped: state.skipped,
        rotated: state.rotated,
        // The three ack counters. Same fields `bridge.json` persists, so a
        // support report and a live status describe the same thing.
        acks: state.acks,
        declined: state.declined,
        lastAck: state.lastAck === null ? null : { ...state.lastAck },
        cursor: state.cursor,
        lastError: state.lastError,
        disposed: state.disposed,
      };
    },

    /** Stop reading. The files stay on disk; they are not ours. */
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
    },
  };
}

/**
 * A bounded one-string summary of an ack's `received` value.
 *
 * `received` is caller-controlled data: a `state` echo carries whatever payload
 * the Host sent, up to 4 KiB. The ack COUNTER is the evidence a support report
 * needs; the body is a convenience that must never let a diagnostics file grow
 * with the sender's payload, so an object is summarised as its JSON up to a
 * fixed length and a long string is clipped.
 *
 * @param {unknown} received
 * @returns {string}
 */
function summarizeAck(received) {
  if (received === null || received === undefined) return '';
  if (typeof received === 'string') return received.slice(0, 160);
  try {
    const text = JSON.stringify(received);
    return typeof text === 'string' ? text.slice(0, 160) : '';
  } catch (_error) {
    return '';
  }
}

/**
 * The channels this build handles, exported so the region's block and the ack
 * reader can be COMPARED instead of assumed to agree.
 */
export const CHANNEL_VOCABULARY = Object.freeze([
  CHANNEL_NAMES.state,
  CHANNEL_NAMES.ping,
  CHANNEL_NAMES.notify,
  CHANNEL_NAMES.window,
]);
