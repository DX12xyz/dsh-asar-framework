/**
 * The IPC channel's file link (`lib/bridge/src/channel.js`) — tested as a SOURCE
 * MODULE plus its two wire copies.
 *
 * WHY A SOURCE MODULE AND NOT THE ARTEFACT: this file deliberately separates
 * "does the reader half behave" (here, with a scratch state directory) from "is
 * the half wired into the bridge at all" (`test/bridge-build.test.mjs` pins
 * `MODULE_ORDER`, and `test/channel-roundtrip` below proves the artefact really
 * carries it). A failure in the decision table and a failure in the wiring must
 * not be able to hide each other.
 *
 * WHAT IS PINNED HERE:
 *   - the two `FILES` copies (wire + bridge) name the same four channel files;
 *   - the byte caps on both halves are the same numbers;
 *   - `send()` writes the envelope the region reads, `drain()` consumes it with
 *     a byte cursor, complete records only, rotation-tolerant;
 *   - everything is fail-soft: missing / unwritable directory, oversize file,
 *     hostile payload, no partial file observable.
 *
 * `node --test --test-isolation=none test/channel.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CHANNEL_VOCABULARY,
  createChannelLink,
} from '../lib/bridge/src/channel.js';
import {
  CHANNEL_ENVELOPE_MAX_BYTES,
  CHANNEL_MAX_BYTES,
  CHANNEL_NAME_PATTERN,
  CHANNEL_NAMES,
  CHANNEL_PAYLOAD_MAX_BYTES,
  PROTOCOL_CHANNEL,
  FILES as BRIDGE_FILES,
} from '../lib/bridge/src/paths.js';
import {
  CHANNEL_HANDLER_BYTES,
  CHANNEL_OUT_FILE as REGION_OUT_FILE,
  IPC_BODY,
} from '../lib/asar/patch-body.js';
import {
  CHANNEL_ENVELOPE_MAX_BYTES as WIRE_ENVELOPE_MAX_BYTES,
  CHANNEL_MAX_BYTES as WIRE_MAX_BYTES,
  CHANNEL_NAME_PATTERN as WIRE_NAME_PATTERN,
  CHANNEL_NAMES as WIRE_NAMES,
  CHANNEL_NOTIFY_BODY_MAX as WIRE_BODY_MAX,
  CHANNEL_NOTIFY_TITLE_MAX as WIRE_TITLE_MAX,
  CHANNEL_PAYLOAD_MAX_BYTES as WIRE_PAYLOAD_MAX_BYTES,
  FILES as WIRE_FILES,
  PROTOCOLS,
  REGION_RESERVE_BYTES,
} from '../lib/wire/constants.js';
import { MAX_WINDOW_SPECS } from '../lib/bridge/src/windows.js';
import { createFrameworkService } from '../lib/host/service.js';
import { createSetupState } from '../lib/host/state.js';
import { RESERVED_HOST_EVENT_TYPE } from '../lib/wire/constants.js';

/** A throwaway `DSH_HOME`-shaped directory with the state dir already created. */
function scratch() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-channel-'));
  const stateDir = path.join(home, 'dsh-asar-framework');
  mkdirSync(stateDir, { recursive: true });
  return {
    home,
    stateDir,
    path: (name) => path.join(stateDir, name),
    read(name) {
      try {
        return readFileSync(path.join(stateDir, name), 'utf8');
      } catch {
        return null;
      }
    },
    cleanup() {
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {
        // A leaked temp directory must not fail a test run.
      }
    },
  };
}

/** One envelope line, exactly the shape the region writes. */
function envelope(channel, received, at = '2026-11-15T00:00:00.000Z') {
  return `${JSON.stringify({ protocol: PROTOCOL_CHANNEL, channel, at, received })}\n`;
}

/**
 * A stand-in `options.state` that answers `refresh()` with a FIXED snapshot.
 *
 * The stale-region guard reads exactly one thing from the snapshot — the region's
 * identity — and the classifier that produces it is proven in `host-state.test.mjs`
 * and `classify.test.mjs` (which build real archives). Here the subject is the
 * GUARD, so its input is injected: a snapshot describing "a split install whose
 * region is an older build's" vs "the region this build writes".
 *
 * @param {object} snapshot the fields the guard and `snapshot()` touch
 * @returns {object} a minimal `options.state`
 */
function fixedState(snapshot) {
  return {
    refresh: async () => snapshot,
    snapshot: () => snapshot,
    resolveRoot: () => null,
    suppress: () => snapshot,
    unsuppress: () => snapshot,
    markRestored: () => snapshot,
    get suppressed() { return false; },
  };
}

/** The reserve an older build shipped; `REGION_RESERVE_BYTES` is 16,384 today. */
const STALE_RESERVE = 8192;

// ----------------------------------------------------------- the wire copies --
// `lib/bridge/src/paths.js` mirrors `lib/wire/constants.js` because the bridge
// ships as one standalone CommonJS file. Four new names appeared on both sides
// for this channel; a drift means "the region writes a file nothing reads".

test('the two FILES copies name the same channel files', () => {
  // TWO files, not four: the request direction has no file (see the ack-fold note
  // in `lib/bridge/src/channel.js`). The pair that remains must still agree
  // across the two wire copies, or the region would write a file nobody drains.
  for (const [bridgeKey, wireKey] of [
    ['channelOut', 'channelOut'],
    ['channelOutRotated', 'channelOutRotated'],
  ]) {
    assert.equal(BRIDGE_FILES[bridgeKey], WIRE_FILES[wireKey],
      `FILES.${bridgeKey} must agree across the two wire copies`);
  }
  assert.equal(WIRE_FILES.channelIn, undefined, 'the request file is gone from the wire table');
  assert.equal(WIRE_FILES.channelInRotated, undefined);
  assert.equal(BRIDGE_FILES.channelIn, undefined, 'and from the bridge table');
  assert.equal(WIRE_FILES.channelOut, 'channel.out.jsonl');
  // The region's own spelling of the ack file comes from the same table.
  assert.equal(REGION_OUT_FILE, WIRE_FILES.channelOut,
    'the region must name the SAME ack file the bridge drains');
  assert.equal(PROTOCOL_CHANNEL, PROTOCOLS.channel,
    'the bridge protocol number must be the wire number');
});

test('the payload cap, the envelope cap and the rotation threshold agree', () => {
  assert.equal(CHANNEL_PAYLOAD_MAX_BYTES, 4096);
  // EVERY cap is written once on the wire side and mirrored on the bridge side,
  // because the region can import neither: a change in one place that misses the
  // other would silently change what "bounded" means for half the channel.
  assert.equal(CHANNEL_PAYLOAD_MAX_BYTES, WIRE_PAYLOAD_MAX_BYTES, 'the payload cap must agree');
  assert.equal(CHANNEL_ENVELOPE_MAX_BYTES, WIRE_ENVELOPE_MAX_BYTES, 'the envelope cap must agree');
  assert.equal(CHANNEL_MAX_BYTES, WIRE_MAX_BYTES, 'the rotation threshold must agree');
  assert.equal(CHANNEL_NAME_PATTERN, WIRE_NAME_PATTERN, 'the channel-name pattern must agree');
  assert.equal(CHANNEL_NAMES.state, WIRE_NAMES.state);
  assert.equal(CHANNEL_NAMES.ping, WIRE_NAMES.ping);
  assert.equal(CHANNEL_NAMES.pong, WIRE_NAMES.pong);
  assert.equal(CHANNEL_NAMES.notify, WIRE_NAMES.notify);
  assert.equal(CHANNEL_NAMES.window, WIRE_NAMES.window);
  assert.equal(CHANNEL_NAMES.declined, WIRE_NAMES.declined);
  // One envelope may be bigger than one payload (it carries the fields around it),
  // and the file may hold two envelopes before it rotates. Both are DERIVED from
  // the payload cap on the wire side, so a change there must reach both halves.
  assert.equal(CHANNEL_ENVELOPE_MAX_BYTES > CHANNEL_PAYLOAD_MAX_BYTES, true,
    'the envelope cap must leave room for the envelope fields');
  assert.equal(CHANNEL_ENVELOPE_MAX_BYTES <= CHANNEL_PAYLOAD_MAX_BYTES + 512, true,
    'the envelope cap must stay near the payload cap, not drift into the megabytes');
  assert.equal(CHANNEL_MAX_BYTES >= CHANNEL_ENVELOPE_MAX_BYTES, true,
    'the file must be able to hold at least one maximal envelope');
  assert.equal(CHANNEL_MAX_BYTES <= 2 * CHANNEL_ENVELOPE_MAX_BYTES, true,
    'the file must rotate rather than accumulate');

  // The REGION carries the same three numbers as literals (it cannot import), and
  // the handler block is big enough to hold them: if that ever stops being true,
  // the region could not ship the guard at all.
  assert.equal(CHANNEL_HANDLER_BYTES > 0, true);
  assert.equal(IPC_BODY.includes(String(CHANNEL_PAYLOAD_MAX_BYTES)), true,
    'the shipped handler must carry the payload cap as a literal');
  assert.equal(IPC_BODY.includes(String(CHANNEL_ENVELOPE_MAX_BYTES)), true,
    'the shipped handler must carry the envelope cap as a literal');
  assert.equal(IPC_BODY.includes(String(CHANNEL_MAX_BYTES)), true,
    'the shipped handler must carry the rotation threshold as a literal');
  // The TWO new capabilities' bounds are in the region too, derived from the same
  // wire numbers the Host-side writer enforces.
  assert.equal(IPC_BODY.includes(String(WIRE_TITLE_MAX)), true,
    'the region must carry the toast title cap as a literal');
  assert.equal(IPC_BODY.includes(String(WIRE_BODY_MAX)), true,
    'the region must carry the toast body cap as a literal');
  assert.equal(IPC_BODY.includes('"maxWidth":8000'), true,
    'the region must carry the window ranges as a literal object');
  assert.equal(IPC_BODY.includes(String(MAX_WINDOW_SPECS)), true,
    'the region must carry the window cap as a literal');
});

// -------------------------------------------------------------- the decisions --

test('createChannelLink is fail-soft and reports the same shape everywhere', () => {
  const dir = scratch();
  try {
    const link = createChannelLink({ stateDir: dir.stateDir });
    const status = link.status();
    assert.equal(status.available, true);
    assert.equal(status.cursor, 0);
    assert.equal(status.lastError, null);
    assert.deepEqual(Object.keys(status).sort(), [
      'acks', 'available', 'cursor', 'declined', 'disposed', 'lastAck', 'lastError',
      'received', 'rotated', 'skipped',
    ]);
    link.dispose();
    assert.equal(link.status().disposed, true);
    assert.equal(typeof link.send, 'undefined',
      'there is no file request direction any more: the Host sends over real IPC');
  } finally {
    dir.cleanup();
  }
});

test('a unusable state directory degrades to available:false and never throws', () => {
  // A path whose PARENT does not exist cannot be created recursively by this side
  // either… except `ensureDir` does create parents. So the honest unavailable case
  // is a path that collides with a FILE.
  const dir = scratch();
  const blocker = dir.path('not-a-dir');
  writeFileSync(blocker, 'x', 'utf8');
  const link = createChannelLink({ stateDir: blocker });
  try {
    const status = link.status();
    assert.equal(status.available, false, 'a directory that is really a file is unavailable');
    assert.equal(typeof status.lastError, 'string');
    const drained = link.drain();
    assert.equal(drained.ok, true, 'drain is total, not a throw');
    assert.deepEqual(drained.records, []);
  } finally {
    dir.cleanup();
  }

  // stateDir === null is the same story, without touching the disk at all.
  const bare = createChannelLink({});
  assert.equal(bare.status().available, false);
  assert.equal(bare.status().lastError, 'state directory unavailable');
  assert.equal(bare.drain().ok, true);
  assert.equal(createChannelLink(null).status().available, false);
});

test('the ack file is the ONLY channel document: no request queue exists', () => {
  // The deleted direction is asserted GONE, not just unreferenced: `channel.in.jsonl`
  // had a writer (`send()`) that production never called and a reader that never
  // existed (audit 2026-11-16, item 8). A future re-introduction has to fail here.
  const dir = scratch();
  const link = createChannelLink({ stateDir: dir.stateDir });
  try {
    assert.equal(Object.prototype.hasOwnProperty.call(BRIDGE_FILES, 'channelIn'), false,
      'the bridge FILES table must not name a request file');
    assert.equal(Object.prototype.hasOwnProperty.call(BRIDGE_FILES, 'channelInRotated'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(WIRE_FILES, 'channelIn'), false,
      'the wire FILES table must not name a request file either');
    assert.equal(Object.prototype.hasOwnProperty.call(WIRE_FILES, 'channelInRotated'), false);
    const created = readdirSync(dir.stateDir).filter((name) => name.startsWith('channel.in'));
    assert.deepEqual(created, [], 'nothing may create a request file any more');
  } finally {
    dir.cleanup();
  }
});

// -------------------------------------------------------------- the reader --

test('drain() consumes complete records only and advances the cursor', () => {
  const dir = scratch();
  const link = createChannelLink({ stateDir: dir.stateDir });
  try {
    // Two complete lines, then a HALF line: the half line must not be consumed.
    const half = '{"protocol":1,"channel":"pin';
    writeFileSync(dir.path(BRIDGE_FILES.channelOut), envelope('ping', 'pong') + envelope('state', { a: 1 }) + half, 'utf8');

    const first = link.drain();
    assert.equal(first.ok, true);
    assert.equal(first.records.length, 2, 'both complete lines must be read');
    assert.equal(first.records[0].channel, 'ping');
    assert.equal(first.records[0].received, 'pong');
    assert.equal(first.records[1].channel, 'state');
    assert.equal(first.rotated, false);
    // The cursor stops at the START of the incomplete line, so the next read can
    // pick it up once the writer finishes it.
    assert.equal(first.cursor, Buffer.byteLength(envelope('ping', 'pong') + envelope('state', { a: 1 })), 'cursor is a byte offset after the last newline');

    // Nothing new: the same cursor, no records.
    const idle = link.drain();
    assert.equal(idle.records.length, 0);
    assert.equal(idle.cursor, first.cursor);

    // The writer finishes the half line: now it is consumed, with the rest.
    writeFileSync(dir.path(BRIDGE_FILES.channelOut), envelope('ping', 'pong') + envelope('state', { a: 1 }) + '{"protocol":1,"channel":"ping","at":"","received":"pong"}\n', 'utf8');
    const third = link.drain();
    assert.equal(third.records.length, 1, 'only the newly completed line is new');
    assert.equal(third.records[0].channel, 'ping');
    assert.equal(third.cursor > first.cursor, true);
    assert.equal(link.status().received, 3);
  } finally {
    dir.cleanup();
  }
});

test('drain() tolerates rotation: the cursor restarts and the rotated slot is not replayed', () => {
  const dir = scratch();
  const link = createChannelLink({ stateDir: dir.stateDir });
  try {
    writeFileSync(dir.path(BRIDGE_FILES.channelOut), envelope('ping', 'pong') + envelope('state', { a: 1 }), 'utf8');
    const first = link.drain();
    assert.equal(first.records.length, 2);
    const cursorBefore = first.cursor;

    // Rotation: the live file moves to the single rotated slot and the writer
    // starts a fresh one. The cursor points past the END of the new file, which
    // is the measured "it shrank" evidence.
    renameSync(dir.path(BRIDGE_FILES.channelOut), dir.path(BRIDGE_FILES.channelOutRotated));
    writeFileSync(dir.path(BRIDGE_FILES.channelOut), envelope('ping', 'pong'), 'utf8');

    const second = link.drain();
    assert.equal(second.rotated, true, 'a shrink below the cursor must be reported as rotation');
    assert.equal(second.records.length, 1, 'the NEW record is read from the start');
    assert.equal(second.records[0].received, 'pong');
    assert.equal(cursorBefore > 0, true);
    // The rotated slot is NOT replayed: only one record came back.
    assert.equal(link.status().rotated, 1);

    // The file disappearing entirely is the same fact, reported the same way.
    rmSync(dir.path(BRIDGE_FILES.channelOut));
    const third = link.drain();
    assert.equal(third.rotated, true, 'a deleted file with a live cursor is a rotation');
    assert.deepEqual(third.records, []);
    assert.equal(third.cursor, 0, 'the cursor goes back to zero');
  } finally {
    dir.cleanup();
  }
});

test('drain() skips lines it cannot trust instead of stalling the channel', () => {
  const dir = scratch();
  const link = createChannelLink({ stateDir: dir.stateDir });
  try {
    writeFileSync(dir.path(BRIDGE_FILES.channelOut), [
      'not json at all',
      JSON.stringify({ protocol: 99, channel: 'ping', at: '', received: 'pong' }),
      JSON.stringify({ protocol: PROTOCOL_CHANNEL, channel: 'NOT-VALID', at: '', received: 'pong' }),
      JSON.stringify({ protocol: PROTOCOL_CHANNEL, channel: 'ping', at: '', received: 'pong' }),
      '',
    ].join('\n') + '\n', 'utf8');
    const drained = link.drain();
    assert.equal(drained.ok, true);
    assert.equal(drained.records.length, 1, 'only the one well-formed envelope is a record');
    assert.equal(drained.skipped, 3, 'the three bad lines are counted, not thrown');
    assert.equal(drained.records[0].received, 'pong');
    assert.equal(link.status().skipped, 3);
  } finally {
    dir.cleanup();
  }
});

test('an oversize ack file is reported, not parsed', () => {
  const dir = scratch();
  const link = createChannelLink({ stateDir: dir.stateDir });
  try {
    // Somebody else wrote this file: it is past the cap, so the channel refuses to
    // trust it rather than spending the tick parsing a document it did not bound.
    writeFileSync(dir.path(BRIDGE_FILES.channelOut), 'x'.repeat(CHANNEL_MAX_BYTES + 1), 'utf8');
    const drained = link.drain();
    assert.deepEqual(drained.records, []);
    assert.equal(link.status().lastError.includes('cap'), true, link.status().lastError);
  } finally {
    dir.cleanup();
  }
});

// ---------------------------------------------------- the ack fold (Fix 2a-1) --

test('drain() counts acks, declined lines and the last ack for bridge.json', () => {
  const dir = scratch();
  const link = createChannelLink({ stateDir: dir.stateDir });
  try {
    writeFileSync(dir.path(BRIDGE_FILES.channelOut), [
      envelope('ping', 'pong'),
      envelope('notify', 'shown'),
      JSON.stringify({ protocol: PROTOCOL_CHANNEL, channel: 'declined', at: '2026-11-16T00:00:00.000Z', received: { requested: 'window', reason: 'E_TOAST' } }) + '\n',
    ].join(''), 'utf8');

    const drained = link.drain();
    assert.equal(drained.records.length, 3);
    const status = link.status();
    assert.equal(status.acks, 3, 'every consumed envelope is an ack');
    assert.equal(status.declined, 1, 'the declined line is counted separately');
    assert.equal(status.lastAck.channel, 'declined', 'the last ack is the most recent line');
    assert.equal(status.lastAck.received.includes('E_TOAST'), true, 'the reason survives as text');
    assert.equal(typeof status.lastAck.at, 'string');

    // An idle drain changes nothing: the counters are evidence, not a rate.
    link.drain();
    assert.equal(link.status().acks, 3);
  } finally {
    dir.cleanup();
  }
});

test('a caller-controlled ack body is clipped, so bridge.json cannot grow with it', () => {
  const dir = scratch();
  const link = createChannelLink({ stateDir: dir.stateDir });
  try {
    // `state` is an ECHO: whatever the Host sent comes back. The persisted copy
    // must not be able to carry 4 KiB of caller data into a diagnostics file.
    const huge = 'z'.repeat(CHANNEL_PAYLOAD_MAX_BYTES);
    writeFileSync(dir.path(BRIDGE_FILES.channelOut), envelope('state', huge), 'utf8');
    link.drain();
    const lastAck = link.status().lastAck;
    assert.equal(typeof lastAck.received, 'string');
    assert.equal(lastAck.received.length <= 160, true, `clipped, got ${lastAck.received.length}`);
  } finally {
    dir.cleanup();
  }
});

// --------------------------------------------------------------- the wire --

test('the channel vocabulary is exactly the four names the region handles', () => {
  assert.deepEqual(CHANNEL_VOCABULARY, [
    CHANNEL_NAMES.state,
    CHANNEL_NAMES.ping,
    CHANNEL_NAMES.notify,
    CHANNEL_NAMES.window,
  ]);
  // `pong` and `declined` are ANSWER values, part of the vocabulary but never
  // sendable: one is what `ping` is answered with, the other is the envelope name
  // a refused-but-accepted message is recorded under.
  assert.equal(CHANNEL_VOCABULARY.includes(CHANNEL_NAMES.pong), false);
  assert.equal(CHANNEL_VOCABULARY.includes(CHANNEL_NAMES.declined), false);
  // The region's own copy lists all six, and both halves must agree about them.
  assert.deepEqual(Object.keys(WIRE_NAMES).sort(), [
    'declined', 'notify', 'ping', 'pong', 'state', 'window',
  ]);
  assert.equal(typeof CHANNEL_NAME_PATTERN, 'string');
  assert.equal(new RegExp(CHANNEL_NAME_PATTERN).test('a'.repeat(32)), true);
  assert.equal(new RegExp(CHANNEL_NAME_PATTERN).test('a'.repeat(33)), false);
});

test('the wire vocabulary still names the two real channels the region serves', () => {
  // The REQUEST direction has no file writer any more (Fix 2b), so this case no
  // longer exercises a `send()`. What must still hold is the contract the region
  // and the Host-side sender share: the region handles exactly these four names,
  // and the two that do REAL work are named by both halves.
  assert.equal(CHANNEL_VOCABULARY.includes(CHANNEL_NAMES.notify), true);
  assert.equal(CHANNEL_VOCABULARY.includes(CHANNEL_NAMES.window), true);
  assert.equal(WIRE_NAMES.notify, CHANNEL_NAMES.notify);
  assert.equal(WIRE_NAMES.window, CHANNEL_NAMES.window);
  // `pong` / `declined` are answers: the region produces them, nobody requests them.
  assert.equal(CHANNEL_VOCABULARY.includes(CHANNEL_NAMES.pong), false);
  assert.equal(CHANNEL_VOCABULARY.includes(CHANNEL_NAMES.declined), false);
});

test('channelSend REFUSES on a stale region and never calls the sender', async () => {
  // The hole this closes: a Host running the new code next to an archive still
  // holding an OLD region. The official `isDesktopHostEvent` answers `false` for
  // our reserved type, and main then kills the Host child — the user's session.
  // So the sender must never be reached, and it must never be reached CHEAPLY:
  // the fact comes from the snapshot the Host already computes
  // (`regionMatchesBuild`, folded from `classifyAsar`'s digest compare), so the
  // send path hashes nothing.
  const sent = [];
  const scratchState = createSetupState({ stateDir: mkdtempSync(path.join(os.tmpdir(), 'dsh-stale-')) });
  const healthyDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-healthy-'));
  const oddDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-odd-'));
  const stale = createFrameworkService({
    state: fixedState({
      installRoot: '<test>\\DSH',
      asarPath: '<test>\\DSH\\resources\\app.asar',
      state: 'patched-by-us',
      layout: 'split',
      splitRegion: { length: STALE_RESERVE, sha256: 'a'.repeat(64) },
      regionMatchesBuild: false,
      dshVersion: '0.2.2-rc.3',
      backup: null,
      bridge: { present: true, size: 1 },
      powerAvailable: false,
      installRecord: null,
      installState: 'installed',
      upgraded: false,
      compat: null,
      lastError: null,
      required: false,
      suppressed: false,
      suppressReason: null,
    }),
    stateDir: scratchState.stateDir,
    channelSender: (message) => { sent.push(message); return Promise.resolve(); },
  });
  try {
    const refused = await stale.channelSend({ channel: 'notify', payload: { title: 'Hi' } });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'EREGION_STALE', 'the guard must name the reason');
    assert.match(refused.message, /安装/, 'the message must name the fix: press Install');
    assert.equal(sent.length, 0, 'THE POINT: the sender must never be called');
    // It refuses EVERY sendable channel, not just one of them.
    for (const channel of ['state', 'ping', 'window']) {
      assert.equal((await stale.channelSend({ channel })).code, 'EREGION_STALE', `channel ${channel}`);
    }
    assert.equal(sent.length, 0, 'still nothing sent');
  } finally {
    rmSync(scratchState.stateDir, { recursive: true, force: true });
  }

  // A HEALTHY current region is allowed through: the guard is not a blanket
  // refusal, and the length check is `REGION_RESERVE_BYTES`, not "any length".
  const healthy = createFrameworkService({
    state: fixedState({
      installRoot: '<test>\\DSH',
      asarPath: '<test>\\DSH\\resources\\app.asar',
      state: 'patched-by-us',
      layout: 'split',
      splitRegion: { length: REGION_RESERVE_BYTES, sha256: 'b'.repeat(64) },
      regionMatchesBuild: true,
      dshVersion: '0.2.2-rc.3',
      backup: null,
      bridge: { present: true, size: 1 },
      powerAvailable: false,
      installRecord: null,
      installState: 'installed',
      upgraded: false,
      compat: null,
      lastError: null,
      required: false,
      suppressed: false,
      suppressReason: null,
    }),
    stateDir: healthyDir,
    channelSender: (message) => { sent.push(message); return Promise.resolve(); },
  });
  try {
    const allowed = await healthy.channelSend({ channel: 'notify', payload: { title: 'Hi' } });
    assert.equal(allowed.ok, true, allowed.message ?? '');
    assert.equal(sent.length, 1, 'a current region lets the message through');
    assert.equal(sent[0].type, RESERVED_HOST_EVENT_TYPE);
  } finally {
    rmSync(healthyDir, { recursive: true, force: true });
  }

  // ...but a region of this build's LENGTH whose BYTES are stale is still refused:
  // length alone is not the claim, `regionMatchesBuild` is.
  const sameLengthStale = createFrameworkService({
    state: fixedState({
      installRoot: '<test>\\DSH',
      layout: 'split',
      splitRegion: { length: REGION_RESERVE_BYTES, sha256: 'c'.repeat(64) },
      regionMatchesBuild: false,
      state: 'patched-by-us',
      required: false,
      suppressed: false,
    }),
    stateDir: oddDir,
    channelSender: (message) => { sent.push(message); return Promise.resolve(); },
  });
  try {
    assert.equal((await sameLengthStale.channelSend({ channel: 'ping' })).code, 'EREGION_STALE');
    assert.equal(sent.length, 1, 'and it still sent nothing');
  } finally {
    rmSync(oddDir, { recursive: true, force: true });
  }
  rmSync(scratchState.stateDir, { recursive: true, force: true });
});

test('the Host can SEND: channelSend `process.send`s our type and refuses the rest', async () => {  // The REQUEST direction really is a live IPC message: the Host process is the
  // `stdio: [..., "ipc"]` child, so `process.send` is its own capability even
  // though the injected wrapper (which answers) has no `this` and cannot reply.
  // The sender is injected here for the same reason every other capability is:
  // a test must be able to observe the message without being Electron's child.
  const dir = scratch();
  const sent = [];
  const service = createFrameworkService({
    state: createSetupState({ stateDir: dir.stateDir }),
    stateDir: dir.stateDir,
    channelSender: (message) => { sent.push(message); return Promise.resolve(); },
  });
  try {
    const toast = await service.channelSend({ channel: 'notify', payload: { title: 'Hi', body: 'There' } });
    assert.equal(toast.ok, true, toast.message ?? '');
    assert.equal(toast.channel, 'notify');
    assert.equal(typeof toast.sentAt, 'string');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, RESERVED_HOST_EVENT_TYPE, 'the wire type is the one the region claims');
    assert.equal(sent[0].channel, 'notify');
    assert.deepEqual(sent[0].payload, { title: 'Hi', body: 'There' });

    const opened = await service.channelSend({ channel: 'window', payload: { id: 'w1', route: '/settings' } });
    assert.equal(opened.ok, true);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].channel, 'window');

    // `state` and `ping` are sendable too (they are diagnostics, not answers).
    assert.equal((await service.channelSend({ channel: 'ping' })).ok, true);
    assert.equal(sent[2].payload, undefined, 'a ping carries no payload');

    // Refusals are SHAPES, never throws.
    assert.equal((await service.channelSend({ channel: 'sttate' })).code, 'EINVALID_CHANNEL');
    assert.equal((await service.channelSend({ channel: 'pong' })).code, 'EINVALID_CHANNEL');
    assert.equal((await service.channelSend({})).code, 'EINVALID_CHANNEL');
    assert.equal(sent.length, 3, 'a refused request sends nothing');

    const cyclic = {};
    cyclic.self = cyclic;
    assert.equal((await service.channelSend({ channel: 'state', payload: cyclic })).code, 'EINVALID_PAYLOAD');
    assert.equal(
      (await service.channelSend({ channel: 'state', payload: 'x'.repeat(CHANNEL_PAYLOAD_MAX_BYTES + 1) })).code,
      'EPAYLOAD_TOO_LARGE',
    );
    assert.equal(sent.length, 3, 'an oversize payload is refused BEFORE the send');

    // A sender that throws (a disconnected channel) degrades to a failure shape.
    const broken = createFrameworkService({
      state: createSetupState({ stateDir: dir.stateDir }),
      stateDir: dir.stateDir,
      channelSender: () => { throw new Error('channel closed'); },
    });
    const failed = await broken.channelSend({ channel: 'notify', payload: { title: 'x' } });
    assert.equal(failed.ok, false);
    assert.equal(typeof failed.code, 'string');
  } finally {
    dir.cleanup();
  }
});

test('the artefact carries the reader half, wired into the kernel', async () => {
  // The link is only worth having if the SHIPPED bridge constructs it. That is
  // what this case proves, through the built artefact rather than the sources.
  const { ARTEFACT_PATH, loadArtefact, makeBridge, withHome, MESSAGES, lastTemplate } = await import('./bridge-harness.mjs');
  const text = readFileSync(ARTEFACT_PATH, 'utf8');
  assert.equal(text.includes('channel.out.jsonl'), true,
    'the artefact must name the ack file it drains');
  assert.equal(text.includes('createChannelLink'), true, 'the artefact must bundle the channel module');

  withHome((home) => {
    const { bridge, menu } = makeBridge({ home });
    try {
      const status = bridge.status();
      assert.equal(status.channel.available, true, 'a usable state dir makes the link available');
      assert.equal(status.channel.cursor, 0);
      assert.equal(status.channel.lastError, null);
      assert.equal(bridge.relabel(MESSAGES).ok, true, 'the tray is unaffected by the channel');
      assert.equal(lastTemplate(menu).length, 3, 'the official three entries still render');

      // The region's answer, dropped into the state directory, is consumed on the
      // shell-driven refresh path — the same catch-up contract `notify` has.
      writeFileSync(home.path('channel.out.jsonl'), envelope('ping', 'pong'), 'utf8');
      bridge.relabel(MESSAGES);
      const after = bridge.status().channel;
      assert.equal(after.received, 1, 'relabel() must drain the channel');
      assert.equal(after.cursor > 0, true);
    } finally {
      bridge.dispose();
    }
    assert.equal(bridge.status().channel.disposed, true);
  });
});
