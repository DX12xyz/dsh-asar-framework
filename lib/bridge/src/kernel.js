/**
 * Bridge kernel: wiring, the poll loop, event emission and teardown.
 *
 * This is the IMPLEMENTATION half of the artefact. `main.js` owns the public
 * facade (`createBridge`), which watches the artefact file and swaps this
 * implementation when the file changes; `createImplementation` is what the facade
 * builds, on the first call and on every successful reload. The kernel itself
 * never watches anything: that is what makes a reload chain impossible.
 *
 * Contract of the object this returns (design/PHASE1-SPEC.md §4.3):
 *
 *   - it accepts the Electron env plus the tray and the shell's `options`
 *     (`{iconPath, locale, open, quit}`) and never throws: an unusable env
 *     yields an inert implementation instead of wiping out the caller's fallback;
 *   - `relabel(messages)` renders for the given shell messages;
 *   - `dispose()` stops polling and drops callbacks, but never destroys the
 *     tray — the tray belongs to the shell;
 *   - `status()` exposes a read-only snapshot for diagnostics and tests. The
 *     facade adds the `reload` block on top of it.
 *
 * Red lines: no `new Tray`, no `app.quit()`, no `tray.destroy()`, no network,
 * no reading inside the asar.
 */

import {
  BRIDGE_VERSION,
  EVENTS_MAX_BYTES,
  FILES,
  NOTIFY_POLL_EVERY,
  PATCH_POLL_EVERY,
  POLL_MS,
  appendJsonLine,
  encodeEventLine,
  ensureDir,
  isoNow,
  messageOf,
  readMenuSource,
  resolveStateDir,
} from './paths.js';
import { officialTemplate, renderMenu } from './menu.js';
import { createNotifyChannel } from './notify.js';
import { createChannelLink } from './channel.js';
import { INERT_PATCHES, createPatchController } from './patch.js';
import { createWindowTracker, WINDOW_POLL_EVERY } from './windows.js';
import { writeLoadMarker, writeRenderRecord } from './diagnostics.js';

/** Reason recorded while the bridge has rendered nothing yet or is inert. */
const INERT = 'inert';

/**
 * The `notify` block of an inert bridge.
 *
 * Shape parity with a live bridge matters: a diagnostics page must not have to
 * branch on "is this an inert bridge" before reading `status().notify.shown`.
 * `available:false` is the honest answer here — the environment was unusable
 * before the notification channel was ever created.
 */
const INERT_NOTIFY = Object.freeze({
  available: false,
  shown: 0,
  lastError: 'bridge is inert',
  rev: 0,
  rateLimited: 0,
  invalid: 0,
  duplicates: 0,
  stateRestored: false,
  disposed: false,
});

/**
 * The `channel` block of an inert bridge.
 *
 * Same shape parity rule as `INERT_NOTIFY`: a diagnostics page must not have to
 * branch on "is this bridge inert" before reading `status().channel.cursor`.
 */
const INERT_CHANNEL = Object.freeze({
  available: false,
  received: 0,
  skipped: 0,
  rotated: 0,
  acks: 0,
  declined: 0,
  lastAck: null,
  cursor: 0,
  lastError: 'bridge is inert',
  disposed: false,
});

/**
 * The `windows` block of an inert bridge.
 *
 * Same shape parity rule as `INERT_NOTIFY` and `INERT_CHANNEL`, and the same
 * reason: `status().windows.known` must be readable without asking "is this
 * bridge inert". `max` still names the region's cap — that is a property of the
 * shipped region, not of this process. `windows` is the empty LIST, so a
 * diagnostics page never has to branch on `Array.isArray` either.
 */
const INERT_WINDOWS = Object.freeze({
  available: false,
  known: 0,
  max: 8,
  closed: 0,
  sampled: 0,
  lastAt: null,
  lastError: 'bridge is inert',
  windows: Object.freeze([]),
});

/**
 * @param {unknown} value
 * @returns {boolean} true for a non-null object
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `Menu.buildFromTemplate` accepts plain objects, while a real Electron `Menu`
 * arrives as a class (a function in JavaScript). Both shapes are usable when
 * they carry a callable `buildFromTemplate`; anything else is not a menu
 * provider and must not be poked at.
 *
 * @param {unknown} candidate
 * @returns {boolean}
 */
function isMenuProvider(candidate) {
  if (!isObject(candidate) && typeof candidate !== 'function') return false;
  try {
    return typeof candidate.buildFromTemplate === 'function';
  } catch (_error) {
    return false; // A throwing getter on a hostile object is still a no.
  }
}

/**
 * Check the injected environment once, up front. Anything wrong here is
 * reported through `status()` and rendered as the official three entries.
 *
 * @param {unknown} env
 * @returns {string | null} a description of the first missing capability
 */
function validateEnvironment(env) {
  if (!isObject(env)) return 'bridge environment is not an object';
  if (!isMenuProvider(env.Menu)) return 'Menu.buildFromTemplate is unavailable';
  const tray = env.tray;
  if (!isObject(tray) && typeof tray !== 'function') return 'tray is not an object';
  if (typeof tray.setContextMenu !== 'function') return 'tray.setContextMenu is unavailable';
  if (typeof tray.setToolTip !== 'function') return 'tray.setToolTip is unavailable';
  const options = env.options;
  if (!isObject(options)) return 'options is not an object';
  if (typeof options.open !== 'function') return 'options.open is unavailable';
  if (typeof options.quit !== 'function') return 'options.quit is unavailable';
  return null;
}

/**
 * Electron's version, when the injected app object happens to expose it.
 *
 * @param {unknown} appModule
 * @returns {string | null}
 */
function electronVersionOf(appModule) {
  if (!isObject(appModule)) return null;
  const version = appModule.__dshElectronVersion;
  return typeof version === 'string' ? version : null;
}

/**
 * The poll loop must never keep the Electron process alive, so the interval is
 * unref'd whenever the runtime supports it.
 *
 * Exported because the facade in `main.js` needs the exact same discipline for
 * its artefact watcher: two timers in this process means two intervals, and the
 * second one must not keep Electron alive either.
 *
 * @param {() => void} tick
 * @param {number} milliseconds
 * @returns {unknown} the timer handle, or null when timers are unavailable
 */
export function startRepeatingTimer(tick, milliseconds) {
  try {
    const handle = setInterval(() => {
      try {
        tick();
      } catch (_error) {
        // poll() is already contained; this is belt and braces for a hostile timer.
      }
    }, milliseconds);
    if (isObject(handle) && typeof handle.unref === 'function') handle.unref();
    return handle;
  } catch (_error) {
    return null;
  }
}

/**
 * @param {unknown} handle
 */
export function stopTimer(handle) {
  if (handle === null || handle === undefined) return;
  try {
    clearInterval(handle);
  } catch (_error) {
    // A handle from another realm cannot be cleared; the loop is already unref'd.
  }
}

/**
 * Compare two message tables shallowly by key and value.
 *
 * @param {Record<string, unknown> | null} left
 * @param {Record<string, unknown> | null} right
 * @returns {boolean}
 */
function sameMessages(left, right) {
  if (left === null || right === null) return left === right;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/**
 * Install the built menu and the tooltip on the shell's tray.
 *
 * Both calls are individually guarded: Electron's tray is a native object and
 * can reject a menu for reasons the bridge cannot predict, and the shell keeps
 * the previous menu installed in that case.
 *
 * @param {{ setContextMenu: Function, setToolTip: Function }} tray
 * @param {unknown} menu
 * @param {string} tooltip
 * @returns {{ ok: boolean, error: string | null }}
 */
function installMenu(tray, menu, tooltip) {
  let setMenuError = null;
  try {
    tray.setContextMenu(menu);
  } catch (error) {
    setMenuError = 'tray.setContextMenu failed: ' + messageOf(error);
  }
  try {
    tray.setToolTip(tooltip);
  } catch (error) {
    if (setMenuError === null) setMenuError = 'tray.setToolTip failed: ' + messageOf(error);
  }
  return { ok: setMenuError === null, error: setMenuError };
}

/**
 * An inert bridge: the environment was unusable, so every method is a no-op
 * returning a failure. The patch body's own catch then renders the official
 * three entries, which is the only correct outcome there.
 *
 * @param {object} state
 * @returns {object}
 */
function inertBridge(state) {
  state.reason = INERT;
  return {
    relabel() {
      return { ok: false };
    },
    dispose() {
      state.disposed = true;
    },
    status() {
      return snapshot(state, null, INERT_NOTIFY, INERT_CHANNEL, INERT_PATCHES, INERT_WINDOWS);
    },
  };
}

/**
 * @param {object} state
 * @param {unknown} timer
 * @param {object} notify the notification channel's status document
 * @param {object} channel the IPC channel's status document
 * @param {object} patches the dynamic-patch hook's status document
 * @param {object} windows the window close observer's status document
 * @returns {object} the public status document
 */
function snapshot(state, timer, notify, channel, patches, windows) {
  return {
    version: state.version,
    reason: state.reason,
    lastError: state.lastError,
    renderCount: state.renderCount,
    rev: state.rev,
    itemCount: state.itemCount,
    disposed: state.disposed,
    hasContribution: state.hasContribution,
    stateDir: state.stateDir,
    loadWritten: state.loadWritten,
    polling: timer !== null,
    /**
     * The second channel. Same `{available, shown, lastError, rev}` shape the
     * design promised, plus the counters that make a "why did my toast not
     * appear" report answerable without reading any file.
     */
    notify,
    /**
     * The third channel: the file link behind the reserved IPC type. Its `cursor`
     * and `received` counters are what turn "did the region's answer arrive" from
     * a guess into a number.
     */
    channel,
    /**
     * The FOURTH capability: the declarative dynamic-patch hook. Additive last
     * field, same rule as `reload` on the facade: every earlier key keeps its
     * position, so an older snapshot stays diffable against a newer one.
     *
     * `{available, applied, replayed, missed, failed, lastError, rev}` — see
     * `lib/bridge/src/patch.js`. `replayed` counts patches that boot replay
     * reached through `Module._cache`, `missed` counts enabled items whose module
     * is simply not loaded yet (harmless, not an error).
     */
    patches,
    /**
     * The FIFTH capability: the window CLOSE observer
     * (`lib/bridge/src/windows.js` `createWindowTracker`). Additive last field, same
     * rule as `patches`: every earlier key keeps its position.
     *
     * `{available, known, max, closed, sampled, lastAt, lastError, windows}` — `known`
     * is a COUNT and `max` is the region's `MAX_WINDOW_SPECS` (quoted, not re-derived),
     * `closed` counts closes REPORTED (one `window-closed` line each), `sampled` counts
     * samples taken so far. `windows` is the live LIST (`id` / `owner` / `nativeId` /
     * `at`) that `asarShell.windows()` is built from; it is deliberately NOT persisted
     * into `bridge.json` (`diagnostics.js` `boundedWindows` keeps the count only), because
     * a diagnostics file must not grow with the number of windows somebody opened.
     */
    windows,
  };
}

/**
 * Create the bridge IMPLEMENTATION — the state machine the facade delegates to.
 *
 * Not an exported public entry point: the shipped artefact's `createBridge` is
 * the facade in `main.js`, which calls this once at construction and again after
 * every successful reload. A module built by a reload is built with this DIRECTLY
 * (never through `createBridge`), which is why a reloaded instance cannot watch
 * the file and therefore cannot start a reload chain of its own.
 *
 * @param {{
 *   app?: unknown,
 *   Tray?: unknown,
 *   Menu?: unknown,
 *   nativeImage?: unknown,
 *   tray: { setContextMenu: Function, setToolTip: Function },
 *   options: {
 *     iconPath?: string,
 *     locale?: () => { messages?: Record<string, unknown> },
 *     open: () => void,
 *     quit: () => void,
 *   },
 *   electron?: { notification?: unknown, window?: unknown },
 *   stateDir?: string,
 *   pollMs?: number,
 * }} input
 * @param {() => object} [reloadBlock] the facade's reload counters: handed back
 *        to the diagnostics writer so a later render cannot erase the record
 * @returns {{
 *   relabel: (messages?: Record<string, unknown>) => { ok: boolean },
 *   dispose: () => void,
 *   status: () => object,
 * }}
 */
export function createImplementation(input, reloadBlock) {
  const env = isObject(input) ? input : {};
  const reloadOf = typeof reloadBlock === 'function' ? reloadBlock : null;
  const state = {
    version: BRIDGE_VERSION,
    disposed: false,
    reason: INERT,
    lastError: validateEnvironment(env),
    renderCount: 0,
    rev: 0,
    itemCount: 0,
    hasContribution: false,
    fingerprint: null,
    messages: null,
    stateDir: null,
    loadWritten: false,
  };
  if (state.lastError !== null) return inertBridge(state);

  const tray = env.tray;
  const options = env.options;
  const menuProvider = env.Menu;

  state.stateDir =
    typeof env.stateDir === 'string' && env.stateDir !== '' ? env.stateDir : resolveStateDir();
  const created = ensureDir(state.stateDir);
  if (!created.ok) {
    // An unwritable state directory is survivable: the tray still renders, the
    // bridge just cannot publish contributions or diagnostics.
    state.lastError = 'state directory is not writable: ' + (created.error === null ? 'unknown' : created.error);
    state.stateDir = null;
  }
  if (state.stateDir !== null) {
    const load = writeLoadMarker({
      stateDir: state.stateDir,
      asarSha: null,
      electron: electronVersionOf(env.app),
      now: isoNow(),
      pid: process.pid,
    });
    state.loadWritten = load.ok;
  }

  const pollInterval = typeof env.pollMs === 'number' && env.pollMs > 0 ? env.pollMs : POLL_MS;

  /**
   * The notification channel.
   *
   * Created unconditionally, INCLUDING when no `Notification` class was
   * injected: "no capability" is a state the channel reports, not a reason to
   * skip constructing it, and keeping it unconditional means `status().notify`
   * always has the same shape.
   *
   * `electron` is ONE injected capabilities object (see the split region in
   * `lib/asar/patch-body.js`). Reading it defensively here is what makes an old
   * shell — one that still calls `createBridge({app, Tray, Menu, nativeImage,
   * tray, options})` — behave exactly like it did before this capability existed.
   */
  const electron = isObject(env.electron) ? env.electron : {};
  const notify = createNotifyChannel({
    stateDir: state.stateDir,
    notification: electron.notification,
    emit,
  });

  /**
   * The IPC channel's reader half.
   *
   * WHY IT IS CONSTRUCTED UNCONDITIONALLY, like `notify`: "no state directory"
   * and "nothing written yet" are STATES the channel reports (`available:false`,
   * `cursor:0`), not reasons to skip building it — and an unconditional
   * construction is what keeps `status().channel` the same shape everywhere.
   *
   * `createChannelLink` never throws: a hostile or read-only state directory
   * degrades to `available:false`, which is the one property that keeps this
   * channel from being able to cost the user his tray.
   */
  const channel = createChannelLink({ stateDir: state.stateDir });

  /**
   * The dynamic-patch hook (capability roadmap step 3).
   *
   * WHY IT IS CONSTRUCTED UNCONDITIONALLY, like `notify` and `channel`: "no state
   * directory" and "no patches.json yet" are STATES it reports (all-zero counters;
   * `available:false` only when there is no state directory at all), not reasons to
   * skip building it — and one construction site is what keeps `status().patches`
   * the same shape in every bridge.
   *
   * WHAT IT DOES ON CONSTRUCTION: nothing to the loader. The `_load` wrapper is
   * installed only when a spec with enabled items is synced (`patch.js`
   * `installHook`), so a bridge whose `patches.json` is absent behaves EXACTLY as
   * it did before this module existed.
   *
   * `selfFile` is the guard that stops the bridge from patching its own artefact.
   * It comes from the same expression the facade watcher uses (`__filename` in the
   * CommonJS artefact, `null` when the ESM sources are imported directly), passed
   * in so the two can never disagree.
   *
   * `onChange` re-writes `bridge.json` on a state CHANGE only — a patch landing or
   * failing is the one patch event a human waits for, and the next menu render may
   * be a locale change away. A steady poll writes nothing.
   */
  const patches = createPatchController({
    stateDir: state.stateDir,
    selfFile: typeof env.artefactPath === 'string' && env.artefactPath !== ''
      ? env.artefactPath
      : (typeof __filename === 'string' ? __filename : null),
    onChange: () => {
      recordRender({
        rev: state.rev,
        itemCount: state.itemCount,
        reason: state.reason,
        lastError: state.lastError,
      });
    },
  });

  /**
   * The window CLOSE observer (capability step: the write half + the close push).
   *
   * WHY IT IS CONSTRUCTED UNCONDITIONALLY, like the other four: "no window class
   * injected" is a STATE it reports (`available:false`, `known:0`, a readable
   * `lastError`), not a reason to skip building it — one construction site is what
   * keeps `status().windows` the same shape in every bridge.
   *
   * WHAT IT DOES ON CONSTRUCTION: one `getAllWindows()` sample, so the first
   * snapshot already knows the baseline and a window opened BEFORE this bridge was
   * built is not reported as closed on the first tick.
   *
   * THE MEASURED REASON IT IS HERE AND NOT IN THE REGION: the injected region's
   * spare is 1,053 B above a 1,000 B floor, i.e. 53 B, while a shipped `closed`
   * handler that appends one `events.jsonl` line costs ≈319 B (287 B for the compact
   * function + 25 B for the widened listener + separators). That is six times the
   * budget, so the region CANNOT carry it — the number decides, not a preference.
   *
   * `emit` is the SAME function the menu clicks use, so a close lands in the file
   * the Host already reads (`asarShell.events(cursor)`) with no second channel.
   */
  const windows = createWindowTracker({
    electron,
    append: (record) => {
      emit({
        type: record.type,
        id: record.id,
        owner: record.owner,
        // The observer's own instant, passed through so the `events.jsonl` line and
        // `bridge.json`'s `windows.lastAt` are the SAME timestamp. Reading the clock
        // twice would make the event and its counter differ for no reason.
        at: record.at,
        path: [],
      });
    },
  });

  /**
   * Poll tick for the IPC channel: consume whatever the region answered.
   *
   * The answers are not surfaced as toasts, menu entries or anything else a user
   * can see — they are counted in `status().channel` and written where a
   * diagnostics page can read them. That is deliberate: this channel's job today
   * is to be OBSERVABLE and bounded, not to become a second command surface.
   *
   * @returns {{ records: object[], rotated: boolean, skipped: number }}
   */
  function pollChannel() {
    if (state.disposed) return { records: [], rotated: false, skipped: 0 };
    try {
      return channel.drain();
    } catch (error) {
      state.lastError = 'channel drain failed: ' + messageOf(error);
      return { records: [], rotated: false, skipped: 0 };
    }
  }

  /** Read the shell's message table, tolerating a missing or throwing locale. */
  function readMessages() {
    if (typeof options.locale !== 'function') return {};
    try {
      const locale = options.locale();
      if (isObject(locale) && isObject(locale.messages)) return locale.messages;
      if (isObject(locale)) return locale;
      return {};
    } catch (_error) {
      return {};
    }
  }

  /**
   * Append one click/toggle/window-closed record; failures stay silent by design.
   *
   * `record.at` is honoured when the producer already stamped the instant (the
   * window observer does), so a record and the counter it is counted in cannot
   * disagree; everything else is stamped here.
   */
  function emit(record) {
    if (state.stateDir === null) return;
    try {
      const line = encodeEventLine({
        type: record.type,
        id: record.id === undefined ? null : record.id,
        path: record.path,
        checked: record.checked,
        at: typeof record.at === 'string' && record.at !== '' ? record.at : isoNow(),
        owner: record.owner,
      });
      appendJsonLine(
        state.stateDir + '/' + FILES.events,
        state.stateDir + '/' + FILES.eventsRotated,
        line,
        EVENTS_MAX_BYTES,
      );
    } catch (_error) {
      // Losing one diagnostic line must not surface inside a native click handler.
    }
  }

  const actions = {
    open: () => {
      try {
        options.open();
      } catch (_error) {
        // The shell's open action owns its own error handling.
      }
    },
    quit: () => {
      try {
        options.quit();
      } catch (_error) {
        // Quit belongs to the shell; the bridge only forwards the request.
      }
    },
  };

  /** @param {object} record */
  function recordRender(record) {
    if (state.stateDir === null) return;
    try {
      writeRenderRecord({
        stateDir: state.stateDir,
        rev: record.rev,
        itemCount: record.itemCount,
        reason: record.reason,
        lastError: record.lastError,
        // THE ACK EVIDENCE, folded into the file the Host already writes every
        // tick: without this the ack file had NO reader outside the bridge
        // process, so "did the region answer my message" was unanswerable.
        channel: channelStatusOf(),
        notify: notifyStatusOf(),
        // THE PATCH RECORD: the fourth capability's live counters. Folded here
        // for exactly the reason `channel`/`notify` are — the answer to "did my
        // patch land, and if not why" must be readable without a debugger, and a
        // later menu render must not erase it (it is read live on every write).
        patches: patchesStatusOf(),
        // THE WINDOW RECORD: the close observer's counters. Folded here for the
        // same reason again — "is a window still open, and did one close" is a
        // question a support report must answer from one file, and `known`/`closed`
        // must never be erased by a later menu render. `boundedWindows` keeps only
        // the numbers, so this file cannot grow with the number of windows.
        windows: windowsStatusOf(),
        // THE RELOAD RECORD, read live from the facade. It is passed on EVERY
        // write, not only the ones the facade makes itself: a menu render that
        // rewrites bridge.json must not erase "the last reload failed, and why".
        reload: reloadOf === null ? null : reloadOf(),
        renderedAt: isoNow(),
      });
    } catch (_error) {
      // Diagnostics are optional; the menu is not.
    }
  }

  /** The channel block for `bridge.json`, or null when it cannot be read. */
  function channelStatusOf() {
    try {
      return channel.status();
    } catch (_error) {
      return null;
    }
  }

  /** The notify block for `bridge.json`, or null when it cannot be read. */
  function notifyStatusOf() {
    try {
      return notify.status();
    } catch (_error) {
      return null;
    }
  }

  /** The patches block for `bridge.json`, or null when it cannot be read. */
  function patchesStatusOf() {
    try {
      return patches.status();
    } catch (_error) {
      return null;
    }
  }

  /** The windows block for `bridge.json`, or null when it cannot be read. */
  function windowsStatusOf() {
    try {
      return windows.status();
    } catch (_error) {
      return null;
    }
  }

  /** The windows block for `status()`, including the live ID LIST. */
  function windowsStatusLive() {
    try {
      const block = windows.status();
      return { ...block, windows: windows.known() };
    } catch (error) {
      return { ...INERT_WINDOWS, windows: [], lastError: messageOf(error) };
    }
  }

  /**
   * Render one source snapshot into the tray. Never throws.
   *
   * @param {import('./paths.js').MenuSource} source
   * @param {Record<string, unknown> | null} messagesOverride
   * @returns {{ ok: boolean }}
   */
  function applySource(source, messagesOverride) {
    const messages = messagesOverride === null ? readMessages() : messagesOverride;
    state.messages = messages;

    let result;
    try {
      result = renderMenu({
        source,
        messages,
        emit,
        open: actions.open,
        quit: actions.quit,
      });
    } catch (error) {
      result = {
        template: officialTemplate(messages, actions),
        tooltip: typeof messages.aboutProduct === 'string' ? messages.aboutProduct : '',
        reason: 'error',
        rev: 0,
        itemCount: 0,
        lastError: 'render failed: ' + messageOf(error),
      };
    }

    let menu = null;
    let buildError = null;
    let template = result.template;
    try {
      menu = menuProvider.buildFromTemplate(template);
    } catch (error) {
      buildError = 'Menu.buildFromTemplate failed: ' + messageOf(error);
      // The contribution template is the only realistic cause: a malformed
      // item can make Electron throw. Retry with the official three so the
      // tray stays clickable instead of silently keeping a stale menu.
      template = officialTemplate(messages, actions);
      try {
        menu = menuProvider.buildFromTemplate(template);
      } catch (secondError) {
        buildError = buildError + '; official fallback also failed: ' + messageOf(secondError);
      }
    }

    if (menu === null) {
      // Even the official menu could not be built: keep whatever the shell has
      // installed and record why, but never throw back at the main process.
      state.reason = 'error';
      state.lastError = buildError;
      recordRender({ rev: 0, itemCount: 0, reason: 'error', lastError: buildError });
      return { ok: false };
    }

    const fallbackTooltip = typeof messages.aboutProduct === 'string' ? messages.aboutProduct : '';
    const install = installMenu(
      tray,
      menu,
      buildError === null ? result.tooltip : fallbackTooltip,
    );
    state.reason = install.ok ? (buildError === null ? result.reason : 'error') : 'error';
    state.lastError = install.ok
      ? (buildError !== null ? buildError : result.reason === 'error' ? result.lastError : null)
      : install.error;
    if (install.ok) {
      state.rev = result.rev;
      state.itemCount = buildError === null ? result.itemCount : 0;
      state.hasContribution = buildError === null && result.reason === 'ok';
      state.renderCount += 1;
    }
    recordRender({
      rev: state.rev,
      itemCount: state.itemCount,
      reason: state.reason,
      lastError: state.lastError,
    });
    return { ok: install.ok };
  }

  /**
   * Read the contribution document.
   *
   * @returns {import('./paths.js').MenuSource}
   */
  function readSource() {
    try {
      if (state.stateDir === null) {
        return { kind: 'missing', text: null, fingerprint: 'no-state-dir', error: null };
      }
      return readMenuSource(state.stateDir + '/' + FILES.menu);
    } catch (error) {
      const detail = messageOf(error);
      return { kind: 'error', text: null, fingerprint: 'read-error:' + detail, error: detail };
    }
  }

  /**
   * Poll tick for the menu channel: re-render only when the source or the
   * message table changed.
   */
  function poll() {
    if (state.disposed) return;
    const source = readSource();
    const messages = readMessages();
    if (source.fingerprint === state.fingerprint && sameMessages(state.messages, messages)) return;
    state.fingerprint = source.fingerprint;
    applySource(source, messages);
  }

  /**
   * Poll tick for the notification channel.
   *
   * Cadence: every `NOTIFY_POLL_EVERY` menu ticks (~2.1 s at the default 700 ms
   * — see that constant for why slower than the menu), plus an immediate tick
   * whenever the shell calls `relabel()`, which is the user-driven refresh path.
   * Both are contained: the channel itself is total, and the try/catch here is
   * belt and braces so a future edit cannot take the menu poll down with it.
   *
   * @returns {{ shown: number, skipped: number, reason: string | null }}
   */
  function pollNotify() {
    if (state.disposed) return { shown: 0, skipped: 0, reason: null };
    try {
      return notify.poll();
    } catch (error) {
      state.lastError = 'notification poll failed: ' + messageOf(error);
      return { shown: 0, skipped: 0, reason: state.lastError };
    }
  }

  /**
   * Poll tick for the IPC channel. Runs on every menu tick, unlike the
   * notification channel's `NOTIFY_POLL_EVERY` cadence.
   *
   * WHY EVERY TICK: `drain()` costs one `stat` when nothing changed, and the
   * region's handler answers at most one message per IPC delivery — there is no
   * burst to smooth out, so slowing this down would only delay the one thing this
   * channel exists to make observable. `pollChannel` contains its own failures.
   *
   * (No `show`-like return value on purpose: an accepted channel message has no
   * user-visible effect here. Adding one would invite a caller to treat the ack
   * file as a second command surface, which is exactly what it is not.)
   */
  function tickChannel() {
    const drained = pollChannel();
    // THE CORRELATION: an `opened` ack is where the region's SPEC id and the
    // shell's numeric window id are both visible at once — so the close observer
    // is fed here, on the same records, instead of rescanning the ack history.
    // Nothing in this call can throw (the tracker is total); it is contained again
    // for the same reason every other capability here is.
    if (drained !== null && Array.isArray(drained.records) && drained.records.length > 0) {
      try {
        windows.observe(drained.records);
      } catch (_error) {
        // A correlation miss degrades to "a later close is reported unnamed", not
        // to a broken channel.
      }
      // THE FOLD: an ack that was just consumed is persisted into `bridge.json`
      // HERE, because `recordRender` only runs when the MENU changed — without this
      // the counters would be written whenever the tray happened to re-render, and
      // "did my message land" would depend on whether some plugin edited its menu
      // first. Only a tick that actually consumed something pays for a write.
      recordRender({
        rev: state.rev,
        itemCount: state.itemCount,
        reason: state.reason,
        lastError: state.lastError,
      });
    }
  }

  /** @type {number} menu (or relabel) ticks since the last notification poll */
  let notifyTicks = 0;

  /** @type {number} menu (or relabel) ticks since the last patch spec poll */
  let patchTicks = 0;

  /** @type {number} menu (or relabel) ticks since the last window sample */
  let windowTicks = 0;

  /**
   * Poll tick for the window close observer.
   *
   * Cadence: every `WINDOW_POLL_EVERY` menu ticks (~2.8 s at 700 ms), plus an
   * immediate tick on `relabel()`. WHY THAT CADENCE: see `WINDOW_POLL_EVERY` in
   * `windows.js` — the sample is an in-process array copy (no IPC, no file), and
   * what it buys is "a closed window stops being listed within one sample" rather
   * than "within one menu tick". The tracker is total, so this try/catch is belt
   * and braces: a close observer must never be able to cost the user his menu.
   *
   * A tick that actually REPORTED a close re-writes `bridge.json`, exactly like
   * `tickChannel` does for an ack: `closed`/`lastAt` are the evidence a support
   * report reads, and waiting for the next menu render to persist them would make
   * "did the close event land" depend on whether some plugin edited its menu.
   *
   * @returns {{ closed: number }}
   */
  function pollWindows() {
    if (state.disposed) return { closed: 0 };
    try {
      const result = windows.tick();
      if (result.closed > 0) {
        recordRender({
          rev: state.rev,
          itemCount: state.itemCount,
          reason: state.reason,
          lastError: state.lastError,
        });
      }
      return result;
    } catch (error) {
      return { closed: 0 };
    }
  }

  /**
   * Poll tick for the patch hook.
   *
   * Cadence: every `PATCH_POLL_EVERY` menu ticks (~3.5 s at 700 ms), plus an
   * immediate tick on `relabel()`. WHY NOT EVERY TICK: `patches.json` is a CODE
   * spec that only changes when somebody rewrites it, so one `stat` every few
   * seconds is the right budget for "a patch lands while the user is still
   * setting it up". `patches.poll()` contains its own failures — this try/catch is
   * belt and braces so a future edit cannot take the menu poll down with it.
   *
   * @returns {{ applied: number, failed: number, reason: string | null }}
   */
  function pollPatches() {
    if (state.disposed) return { applied: 0, failed: 0, reason: null };
    try {
      const block = patches.poll();
      return { applied: block.applied, failed: block.failed, reason: block.lastError };
    } catch (error) {
      // The controller is total, so this is belt and braces only — and it must
      // never surface as a tray failure, because the patch hook never decides
      // whether the tray works, only what some module does.
      return { applied: 0, failed: 0, reason: 'patch poll failed: ' + messageOf(error) };
    }
  }

  /**
   * The timer-level tick: menu every time, notifications every Nth, channel every
   * time, patches every Mth, windows every Kth.
   *
   * THE THREE SLOW CADENCES NEVER ALL WAKE TOGETHER: 3 (notify), 5 (patches) and
   * 4 (windows) — the lcm is 60 ticks, so the triple collision happens once a
   * minute instead of every 15 ticks, and the common ticks are ≤ two channels
   * (12 = notify+windows, 15 = notify+patches, 20 = patches+windows).
   */
  function tick() {
    poll();
    tickChannel();
    notifyTicks += 1;
    if (notifyTicks >= NOTIFY_POLL_EVERY) {
      notifyTicks = 0;
      pollNotify();
    }
    patchTicks += 1;
    if (patchTicks >= PATCH_POLL_EVERY) {
      patchTicks = 0;
      pollPatches();
    }
    windowTicks += 1;
    if (windowTicks >= WINDOW_POLL_EVERY) {
      windowTicks = 0;
      pollWindows();
    }
  }

  const bridge = {
    /**
     * Render the tray for the shell's current messages.
     *
     * Also drains the notification queue: `relabel()` is called by the shell on
     * startup, on a locale change and from the tray label refresh path, so it is
     * the natural "the shell is awake, catch up" signal. A toast never waits for
     * the slower poll when one of those happens.
     *
     * @param {Record<string, unknown>} [messages] `options.locale().messages`
     * @returns {{ ok: boolean }}
     */
    relabel(messages) {
      if (state.disposed) return { ok: false };
      notifyTicks = 0;
      patchTicks = 0;
      windowTicks = 0;
      const source = readSource();
      state.fingerprint = source.fingerprint;
      let result;
      try {
        result = applySource(source, isObject(messages) ? messages : null);
      } finally {
        // The tray result is unaffected by the notification channel, so a
        // notification problem can never change `{ok}` — which is the contract
        // the shell's fallback branches on. Same for the IPC channel: it is
        // drained here so a shell-driven refresh is also a channel catch-up.
        pollNotify();
        tickChannel();
        // Same rule for the patch hook: a shell-driven refresh is a patch
        // catch-up, and its failure can never change the tray's `{ok}`.
        pollPatches();
        // And the same rule for the window observer: a shell-driven refresh is
        // also a window catch-up, so a `relabel()` right after a close reports it
        // without waiting for the 4-tick cadence.
        pollWindows();
      }
      return result;
    },

    /** Stop polling and drop callbacks. Never touches the tray itself. */
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      stopTimer(state.timer);
      state.timer = null;
      state.messages = null;
      try {
        notify.dispose();
      } catch (_error) {
        // Teardown must not become the last failure the bridge reports.
      }
      try {
        channel.dispose();
      } catch (_error) {
        // Same rule for the IPC channel: dispose is not a failure report.
      }
      try {
        // The patch hook deliberately stays INSTALLED (see `patch.js` `dispose`):
        // a reloaded bridge takes it over, and tearing it down would strand patches
        // that are already live inside modules the application keeps using. Only
        // this controller's poll stops.
        patches.dispose();
      } catch (_error) {
        // Same rule again: a teardown is not a failure report.
      }
      try {
        // The window observer owns no native object: its windows belong to the
        // shell. `dispose` only drops the correlation map, so a closed window can
        // no longer be reported by a dying instance.
        windows.dispose();
      } catch (_error) {
        // Same rule once more: a teardown is not a failure report.
      }
    },

    /** @returns {object} a read-only snapshot of the bridge state */
    status() {
      let notifyStatus;
      try {
        notifyStatus = notify.status();
      } catch (error) {
        notifyStatus = { ...INERT_NOTIFY, lastError: messageOf(error) };
      }
      let channelStatus;
      try {
        channelStatus = channel.status();
      } catch (error) {
        channelStatus = { ...INERT_CHANNEL, lastError: messageOf(error) };
      }
      let patchesStatus;
      try {
        patchesStatus = patches.status();
      } catch (error) {
        patchesStatus = { ...INERT_PATCHES, lastError: messageOf(error) };
      }
      return snapshot(
        state,
        state.timer,
        notifyStatus,
        channelStatus,
        patchesStatus,
        // `status()` is the LIVE document, so it carries the window LIST as well
        // as the counters. `bridge.json` persists the counters only.
        windowsStatusLive(),
      );
    },
  };

  state.timer = startRepeatingTimer(tick, pollInterval);
  return bridge;
}
