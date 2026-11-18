/**
 * Public entry point of the tray bridge artefact: the STABLE FACADE.
 *
 * The patched DesktopTray calls exactly this module, and it must keep calling
 * exactly this shape:
 *
 *   require(<resources>/app.asar.unpacked/dsh/tray-bridge.js)
 *     .createBridge({ app, Tray, Menu, nativeImage, tray, options })
 *
 * Everything the module needs is injected by the shell; the file itself only
 * loads `node:*` built-ins, never `electron`, never the asar.
 *
 * WHY THIS IS A FACADE AND NOT THE KERNEL ANY MORE (hot reload, 0.4.0)
 * The bridge artefact lives in `app.asar.unpacked`, i.e. OUTSIDE the archive, so
 * nothing stops a human (or the installer's existing split-refresh path, which
 * re-copies it with `regionRewritten:false`) from replacing the file while DSH
 * runs. Making that take effect needs a watcher, and the watcher cannot live in
 * the injected region: the region has 1,053 B of spare and the correct block
 * costs 510 B, which is why the in-region design was measured and rejected
 * (`TECHDOC.md` §19.9).
 *
 * So the split is:
 *
 *   createBridge(input)            THIS module. Public, stable, and the only
 *                                  thing in the process that watches the file.
 *     -> createImplementation()    `kernel.js`: the existing state machine
 *                                  (menu poll, notify, channel, diagnostics).
 *
 * The facade owns the artefact watcher and the swap; the implementation owns
 * everything that renders. `createBridge` still returns
 * `{relabel, dispose, status}` and behaves exactly as before — the change is
 * invisible to the caller, which is the whole point: ZERO region bytes move.
 *
 * RECURSION IS STRUCTURALLY IMPOSSIBLE, in two independent strands:
 *   - only `createBridge` (the facade) ever starts a watcher, and a reloaded
 *     module is asked for `createImplementation` (the internal export) directly,
 *     so the code it re-loads never registers one;
 *   - `createBridge(input, true)` is the same guarantee expressed on the PUBLIC
 *     entry point: a caller passing the internal flag gets the implementation
 *     back, never a facade. So even a reloaded artefact that predates
 *     `createImplementation` (or one whose internal export gets renamed later) is
 *     safe: strand B already covers it.
 *
 * `__filename` / `__builtinRequire` are the names that make self-reload possible
 * at all. They only exist in the bundled CommonJS artefact (this file is ESM in
 * the sources and is compiled into one CJS file by `scripts/build-bridge.mjs`);
 * when the sources are imported directly, both resolve to `null`/`''`, the
 * watcher is still armed, and any attempt reports "reload needs the CommonJS
 * artefact build" in `status().reload.lastError` instead of pretending.
 */

import { createImplementation, startRepeatingTimer, stopTimer } from './kernel.js';
import {
  BRIDGE_VERSION,
  POLL_MS,
  PROTOCOL,
  PROTOCOL_NOTIFY,
  PROTOCOL_PATCH,
  RELOAD_POLL_EVERY,
  artefactTag,
  bridgeArtefactChanged,
  isoNow,
  messageOf,
} from './paths.js';
import { writeRenderRecord } from './diagnostics.js';

export { createImplementation, BRIDGE_VERSION, PROTOCOL };

/**
 * The artefact's own `require`, captured from the CommonJS wrapper.
 *
 * The artefact is the only CommonJS thing here (the sources are ESM and are
 * bundled into one file by `scripts/build-bridge.mjs`), so this is `null` when
 * the sources are imported directly by a test: self-reload is then simply
 * unavailable and `status().reload.lastError` says so, instead of pretending.
 */
const SELF_REQUIRE = typeof __builtinRequire === 'function' ? __builtinRequire : null;

/** Absolute path of the running artefact; `''` when it cannot be known. */
const SELF_FILE = typeof __filename === 'string' ? __filename : '';

/**
 * @param {unknown} value
 * @returns {boolean} true for a non-null object
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The builder for one reloaded module.
 *
 * Preference order matters and is the recursion guard:
 *   1. `createImplementation(input)` — the INTERNAL export, i.e. the shipped
 *      shape. A module built this way never creates a facade, so no second
 *      watcher can exist and no reload chain can form.
 *   2. `createBridge(input, true)` — `internal === true` makes `createBridge`
 *      return the implementation directly (no facade, no watcher, same guarantee).
 *      Strand B of the guard, and what a future artefact that renames the
 *      internal export would still honour.
 *   3. neither -> throw, and the facade keeps the implementation it has. An
 *      artefact old enough to predate both is left alone, so the PREVIOUS
 *      artefact's implementation keeps serving the tray.
 *
 * @param {unknown} module the module returned by `require(artefactPath)`
 * @param {object} input the exact input the facade was constructed with
 * @param {() => object|null} reloadSource the facade's counters, so the reloaded
 *        implementation keeps writing them into `bridge.json` on its own renders
 * @returns {() => object} a builder that may throw
 */
function builderFor(module, input, reloadSource) {
  if (isObject(module)) {
    if (typeof module.createImplementation === 'function') {
      return () => module.createImplementation(input, reloadSource);
    }
    if (typeof module.createBridge === 'function') {
      // `true` is the internal flag, NOT the reload source: passing only two
      // arguments here would silently build a second FACADE, i.e. exactly the
      // extra watcher this guard exists to prevent.
      return () => module.createBridge(input, true, reloadSource);
    }
  }
  throw new Error('reloaded artefact exports neither createImplementation nor createBridge');
}

/**
 * Create the bridge — the facade the patched tray class sees.
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
 *   reloadMs?: number,
 *   reloadEvery?: number,
 *   artefactPath?: string,
 * }} input
 * @param {boolean} [internal] `true` means "give me the implementation, not a
 *        facade". It is the second, independent strand of the recursion guard: a
 *        reloaded artefact may be built through the PUBLIC entry point and still
 *        cannot register a watcher.
 * @param {() => object|null} [reloadSource] the facing facade's reload counters,
 *        forwarded so a reloaded implementation keeps writing them to `bridge.json`
 * @returns {{
 *   relabel: (messages?: Record<string, unknown>) => { ok: boolean },
 *   dispose: () => void,
 *   status: () => object,
 * }}
 */
export function createBridge(input, internal, reloadSource) {
  const env = isObject(input) ? input : {};

  // THE GUARD, STRAND B: an inner build is the implementation itself, with no
  // watcher and no facade on top.
  if (internal === true) {
    return createImplementation(env, typeof reloadSource === 'function' ? reloadSource : null);
  }

  /**
   * The WATCHED file. In production this is `__filename`: the artefact is
   * watching itself, which is what makes this cost zero region bytes. `artefactPath`
   * is a test/override hook (same role `pollMs` plays for the poll cadence): it
   * lets a test point the watcher at a fake artefact in a scratch directory, with
   * no archive anywhere near it.
   */
  const file = typeof env.artefactPath === 'string' && env.artefactPath !== '' ? env.artefactPath : SELF_FILE;

  /**
   * The watcher's cadence. The tick counts {@link everyTicks} of these before it
   * stats the file (see {@link RELOAD_POLL_EVERY} for the arithmetic); `reloadMs`
   * and `reloadEvery` shorten both halves for tests, exactly like `pollMs` does
   * for the menu — an injection argument, never a shipped knob.
   */
  const tickMs = typeof env.reloadMs === 'number' && env.reloadMs > 0 ? env.reloadMs : POLL_MS;
  const everyTicks =
    typeof env.reloadEvery === 'number' && env.reloadEvery >= 1
      ? Math.floor(env.reloadEvery)
      : RELOAD_POLL_EVERY;

  /** The bounded `reload` block; also the single source for `bridge.json`. */
  const reload = { attempts: 0, succeeded: 0, lastAt: null, lastError: null };

  const facade = { disposed: false, timer: null, ticks: 0, remembered: undefined, current: null };

  /**
   * @returns {{ attempts: number, succeeded: number, lastAt: string | null,
   *             lastError: string | null }} the block as `status()` and
   *             `bridge.json` both report it
   */
  function reloadBlock() {
    return {
      attempts: reload.attempts,
      succeeded: reload.succeeded,
      lastAt: reload.lastAt,
      lastError: reload.lastError,
    };
  }

  // The initial implementation comes from THIS module instance: the artefact was
  // required a moment ago, so re-requiring it here would be pure waste. The
  // reload source is how the implementation's own `bridge.json` writes carry the
  // reload counters, so a later menu render cannot erase the failure record.
  facade.current = createImplementation(env, reloadBlock);

  /**
   * @param {object|null} implementation
   */
  function disposeQuietly(implementation) {
    if (implementation === null || typeof implementation !== 'object') return;
    try {
      implementation.dispose();
    } catch (_error) {
      // Teardown must not become the last failure the bridge reports.
    }
  }

  /**
   * Persist the reload outcome immediately.
   *
   * WHY RIGHT HERE and not only on the next render: a reload is the one event a
   * human is actively waiting on (they just copied a file), and the next render
   * may be a locale change away. It uses the CURRENT implementation's own status
   * for the render fields, so the file keeps the exact shape `writeRenderRecord`
   * always produced — only the `reload` block is new.
   */
  function recordAttempt() {
    try {
      const status = facade.current === null ? null : facade.current.status();
      if (status === null || isObject(status) !== true) return;
      writeRenderRecord({
        stateDir: status.stateDir === undefined ? null : status.stateDir,
        rev: status.rev,
        itemCount: status.itemCount,
        reason: status.reason,
        lastError: status.lastError,
        channel: status.channel,
        notify: status.notify,
        reload: reloadBlock(),
        // The window observer's counters, read live from the implementation that is
        // serving. Without this line a reload attempt would rewrite `bridge.json`
        // with the DEFAULT blocks (`available:false`) and erase the fact that the
        // observer is running — the same "a later render must not erase an earlier
        // record" rule `channel` / `notify` / `patches` follow. `patches` is
        // forwarded for exactly the same reason (it was missed when the hook landed).
        patches: status.patches,
        windows: status.windows,
        renderedAt: isoNow(),
      });
    } catch (_error) {
      // Diagnostics are optional; the tray is not.
    }
  }

  /**
   * Replace the implementation with the artefact as it is on disk NOW.
   *
   * Order is deliberate:
   *   1. drop the cache entry, re-require, build the new implementation — all of
   *      it inside the `try`, so a syntax error, a missing export and a throwing
   *      constructor are the SAME failure path;
   *   2. only then dispose the old implementation (a failed build must not have
   *      touched a working one);
   *   3. on failure keep the old implementation and remember the FAILED tag, so
   *      the next tick with the same bytes does not spin (a permanently broken
   *      artefact would otherwise re-parse ~100 KB and rewrite `bridge.json`
   *      every 12 s, forever). A further edit produces a new tag and retries.
   *
   * @param {string} tag the identity that triggered this attempt
   */
  function attemptReload(tag) {
    reload.attempts += 1;
    try {
      if (SELF_REQUIRE === null) throw new Error('reload needs the CommonJS artefact build');
      delete SELF_REQUIRE.cache[file];
      const next = builderFor(SELF_REQUIRE(file), env, reloadBlock)();
      if (isObject(next) !== true || typeof next.relabel !== 'function') {
        throw new Error('reloaded artefact did not produce a bridge');
      }
      const previous = facade.current;
      disposeQuietly(previous);
      facade.current = next;
      facade.remembered = tag;
      reload.succeeded += 1;
      reload.lastAt = isoNow();
      reload.lastError = null;
    } catch (error) {
      // Keep what works, remember the failed identity (no spin), say why.
      facade.remembered = tag;
      reload.lastAt = isoNow();
      reload.lastError = messageOf(error).slice(0, 400);
    }
    recordAttempt();
  }

  /**
   * The watcher tick. Every {@link everyTicks} ticks, ONE `stat` decides.
   *
   * Total by construction (`artefactTag` and `bridgeArtefactChanged` are total,
   * `attemptReload` contains its own failure) and wrapped again by the shared
   * timer helper, so no throw can escape it.
   */
  function tick() {
    if (facade.disposed) return;
    facade.ticks += 1;
    if (facade.ticks < everyTicks) return;
    facade.ticks = 0;
    const tag = artefactTag(file);
    if (facade.remembered === undefined) {
      // Nothing judged yet: record the identity, reload nothing. This is the
      // first tick after construction, i.e. the state the region-version and the
      // shipped artefact both start in.
      facade.remembered = tag;
      return;
    }
    if (bridgeArtefactChanged(tag, facade.remembered) !== true) return;
    attemptReload(tag);
  }

  facade.timer = startRepeatingTimer(tick, tickMs);

  return {
    /**
     * Render the tray for the shell's current messages. Delegates; the facade
     * adds only the guard, so a reloaded implementation cannot lose the tray.
     *
     * @param {Record<string, unknown>} [messages] `options.locale().messages`
     * @returns {{ ok: boolean }}
     */
    relabel(messages) {
      if (facade.disposed) return { ok: false };
      try {
        return facade.current.relabel(messages);
      } catch (_error) {
        return { ok: false };
      }
    },

    /** Stop everything: the watcher, the implementation's own poll, its queues. */
    dispose() {
      if (facade.disposed) return;
      facade.disposed = true;
      stopTimer(facade.timer);
      facade.timer = null;
      disposeQuietly(facade.current);
    },

    /** @returns {object} the implementation's snapshot plus the `reload` block */
    status() {
      let base;
      try {
        base = facade.current.status();
      } catch (error) {
        base = {
          version: BRIDGE_VERSION,
          reason: 'inert',
          lastError: messageOf(error),
          disposed: facade.disposed,
        };
      }
      const document = isObject(base) ? { ...base } : {};
      document.reload = reloadBlock();
      return document;
    },
  };
}

/**
 * Diagnostics snapshot for operators: what the artefact is and which wire
 * versions it speaks. Cheap enough to call from a status page.
 *
 * `notify` is a separate entry because it has its own protocol number: the
 * notification channel is a one-shot queue while the menu channel is a
 * persistent tree, so the two documents evolve independently. `patches` is separate
 * for the same reason (the patch document is a CODE contract, §19.10), and it is
 * reported here so a support report can tell which patch protocol this artefact
 * speaks WITHOUT loading `patch.js` and inspecting it.
 *
 * @returns {{ name: string, version: string, protocols: { menu: number, events: number,
 *             notify: number, patches: number } }}
 */
export function describe() {
  return {
    name: 'dsh-asar-framework tray bridge',
    version: BRIDGE_VERSION,
    protocols: {
      menu: PROTOCOL,
      events: PROTOCOL,
      notify: PROTOCOL_NOTIFY,
      patches: PROTOCOL_PATCH,
    },
  };
}
