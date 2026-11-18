/**
 * Window capability — the contract, the Host-facing write half, and the CLOSE
 * OBSERVER. It still does not create, show, close, focus or place a single window.
 *
 * THE THREE HALVES, in one module because they are one capability:
 *   1. the TOTAL validator for a *declarative window specification*
 *      (`validateWindowSpec` / `describeWindowSpec`) — the ABI, and the source
 *      text the injected region ships into `lib/main.js` (`lib/asar/patch-body.js`);
 *   2. `createWindowTracker` — the CLOSE push. It runs in the main process (where
 *      the tray bridge already lives, next to the shell's windows) and learns
 *      "which acked id is gone" by sampling `getAllWindows()` and diffing it
 *      against the ids the region ACKed on `channel.out.jsonl`;
 *   3. the error-code / cap vocabulary both halves quote (`WINDOW_SPEC_CODES`,
 *      `WINDOW_SPEC_LIMITS`, `MAX_WINDOW_SPECS`).
 *
 * The WRITE half that turns a spec into a `channel: "window"` message lives one
 * directory over, in `lib/host/window-registry.js`: the Host process is what has
 * `process.send`, and the bridge must not gain one (see the red lines below).
 *
 * WHY A SPEC AND NOT AN API (see `TECHDOC.md` §20 for the long form):
 * the tray bridge runs in the Electron MAIN process, while every Cordis plugin
 * runs in the HOST process, which `lib/main.js` spawns as a child and talks to
 * over IPC messages whose shapes it validates one by one (evidence:
 * `process-boundary.mjs` — MAIN owns `BrowserWindow`, the Host owns the plugins;
 * `ipc-extend-proto.mjs` — the message validator is one closed function with
 * exactly one call site). A function cannot cross that boundary, and a plugin
 * cannot hold a handle to an object that lives in another process, so a plugin
 * cannot own a window's lifecycle. What CAN cross is JSON — so the only honest
 * shape is "the plugin writes a spec, the MAIN side validates it and constructs
 * the window, and the outcome comes back as events". This module is the
 * validator half of that contract, written now so the shape is pinned before
 * anybody builds a window on top of a guess.
 *
 * WHY VALIDATE AT ALL WHEN NOTHING CONSUMES IT YET:
 * the spec is the ABI. Fixing the field set, the ranges and the security rule
 * (same-origin routes only) is exactly the work that is cheap now and impossible
 * later: once a Host writer has persisted documents with a field, removing it
 * is a breaking change. The validator is also the only part of this capability
 * whose behaviour is testable without Electron, so it is the part that can
 * actually be trusted today.
 *
 * RED LINES: no `electron` import, no `new` anything, no IPC, no window creation.
 * The validator is a pure function over plain data, which is why it can ship
 * inside the region without making the region more dangerous. The tracker below
 * takes the window CLASS as an argument (the region hands the bridge
 * `electron.window`) and never names it, so the artefact keeps passing
 * `test/bridge-build.test.mjs`'s red-line scan.
 */

import { POLL_MS, isoNow, messageOf } from './paths.js';

/** Wire protocol version of a window specification document. */
export const PROTOCOL_WINDOW = 1;

/** Most windows one document may request. */
export const MAX_WINDOW_SPECS = 8;

/** Bounds a spec may ask for, in device-independent pixels. */
export const WINDOW_SPEC_LIMITS = Object.freeze({
  minWidth: 200,
  maxWidth: 8000,
  minHeight: 200,
  maxHeight: 8000,
  /** Placement is bounded to ±100,000 px so a spec cannot park a window off-earth. */
  coordLimit: 100000,
  maxTitleLength: 200,
  maxRouteLength: 2048,
  /**
   * Upper bound on a spec's `id`.
   *
   * Not a UI concern: the id is echoed back in the region's ACK line, which is
   * bounded like every other channel envelope. An unbounded id would let one
   * accepted message produce an ack the region then has to refuse, i.e. "opened"
   * with no record of it. 64 is far more than a window name needs.
   */
  maxIdLength: 64,
});

/** Rejection codes; stable strings, so a Host writer can branch on them. */
export const WINDOW_SPEC_CODES = Object.freeze({
  /** The document is not `{protocol:1, owner, windows:[]}`. */
  EINVALID_DOCUMENT: 'EINVALID_DOCUMENT',
  /** The protocol version is not the one this build speaks. */
  EPROTOCOL: 'EPROTOCOL',
  /** One spec entry is missing a required field or has a wrong type. */
  EINVALID_SPEC: 'EINVALID_SPEC',
  /** Two specs in one document share an `id`. */
  EDUPLICATE_ID: 'EDUPLICATE_ID',
  /** More than {@link MAX_WINDOW_SPECS} entries. */
  ELIMIT: 'ELIMIT',
  /** A URL/route that is not a same-origin path. */
  EUNSAFE_ROUTE: 'EUNSAFE_ROUTE',
  /** A numeric field outside {@link WINDOW_SPEC_LIMITS}. */
  ERANGE: 'ERANGE',
});

/** Keys a spec may carry. Anything else is dropped, not copied. */
export const SPEC_FIELDS = Object.freeze([
  'id',
  'title',
  'route',
  'width',
  'height',
  'x',
  'y',
  'resizable',
  'frameless',
  'modal',
]);

/**
 * Is `route` a same-origin absolute path this capability will load?
 *
 * THE ONE SECURITY RULE of the window capability, factored out so there cannot be
 * a second version of it: the Host-side validator (`validateWindowSpec`), the
 * document validator ({@link describeWindowSpec}) and the injected region
 * (`lib/asar/patch-body.js`, which ships this function's own source text into
 * `lib/main.js`) all call exactly this predicate. A `route` that is an absolute
 * URL, a protocol-relative URL, a Windows path or a backslash walk is not a route.
 *
 * @param {unknown} route
 * @returns {boolean}
 */
export function isSameOriginRoute(route) {
  if (typeof route !== 'string' || route === '') return false;
  if (route.length > WINDOW_SPEC_LIMITS.maxRouteLength) return false;
  return route.charAt(0) === '/' && route.charAt(1) !== '/' && route.indexOf('\\') < 0;
}

/**
 * @param {unknown} value
 * @returns {boolean} true for a non-null, non-array object
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} code
 * @param {string} message
 * @param {string} [where] path inside the document, e.g. `windows[1].width`
 * @returns {{ ok: false, code: string, message: string, where: string | null }}
 */
function fail(code, message, where) {
  return { ok: false, code, message, where: typeof where === 'string' ? where : null };
}

/**
 * Validate one bounded number: a pixel dimension (min > 0) or a placement
 * coordinate (min < 0, so a negative value is legal).
 *
 * ONE helper for both, because "a finite number inside [min, max]" is the whole
 * rule and two near-identical functions were a byte the shipped region could not
 * afford. The message names the bound that failed, which is what a caller reads.
 *
 * Messages are ASCII on purpose: this function's SOURCE TEXT is spliced into
 * `lib/main.js` by `lib/asar/patch-body.js`, and a Chinese character costs three
 * UTF-8 bytes there — with a 16 KiB region, prose in the shipped bytes is budget
 * the capability needs.
 *
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {string} where
 * @returns {{ ok: true, value: number } | { ok: false, code: string, message: string, where: string }}
 */
function bounded(value, min, max, where) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(WINDOW_SPEC_CODES.EINVALID_SPEC, where + ' must be a finite number', where);
  }
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) {
    return fail(WINDOW_SPEC_CODES.ERANGE, where + ' must be between ' + min + ' and ' + max + ', got ' + String(rounded), where);
  }
  return { ok: true, value: rounded };
}

/**
 * Validate one window specification, returning a fresh copy with ONLY the
 * allowed fields.
 *
 * Copying through an allow-list — rather than spreading the input — is the point:
 * the spec travels to the MAIN process, where it would be handed to
 * `BrowserWindow`, and an unknown key is one more property a future shell might
 * wire up by accident (`webPreferences.preload`, say). Dropping unknown keys here
 * means the answer the shell receives is exactly the answer the schema describes.
 *
 * EXPORTED because it is no longer declarative-only: `lib/asar/patch-body.js`
 * ships this function's own source text into `lib/main.js`, where the
 * `channel: "window"` handler calls it, and the Host-side document validator
 * calls it per entry. One definition, three callers — the region's imperative
 * half cannot accept a spec the contract would refuse.
 *
 * @param {unknown} raw
 * @param {string} [where] path used in the refusal message
 * @returns {{ ok: true, spec: object } | { ok: false, code: string, message: string, where: string }}
 */
export function validateWindowSpec(raw, where = 'window') {
  if (isObject(raw) !== true) return fail(WINDOW_SPEC_CODES.EINVALID_SPEC, where + ' must be an object', where);

  const id = raw.id;
  if (typeof id !== 'string' || id === '') {
    return fail(WINDOW_SPEC_CODES.EINVALID_SPEC, where + '.id must be a non-empty string', where + '.id');
  }
  const limits = WINDOW_SPEC_LIMITS;
  if (id.length > limits.maxIdLength) {
    return fail(WINDOW_SPEC_CODES.ERANGE, where + '.id max ' + limits.maxIdLength + ' chars', where + '.id');
  }
  const spec = { id };

  if (raw.title !== undefined) {
    if (typeof raw.title !== 'string') {
      return fail(WINDOW_SPEC_CODES.EINVALID_SPEC, where + '.title must be a string', where + '.title');
    }
    if (raw.title.length > limits.maxTitleLength) {
      return fail(WINDOW_SPEC_CODES.ERANGE, where + '.title max ' + limits.maxTitleLength + ' chars', where + '.title');
    }
    spec.title = raw.title;
  }

  // THE SECURITY RULE of this capability. A shell-owned window renders trusted
  // chrome around the app's own page; letting a plugin name an arbitrary URL
  // would turn every plugin into a way to open an arbitrary origin inside a
  // window the user believes belongs to DSH. So only a same-origin absolute
  // path is accepted; `url` is not a field of this schema at all.
  //
  // The predicate itself lives in `isSameOriginRoute`, because the shipped region
  // has to apply the SAME rule when it constructs a window: one spelling of the
  // rule, three callers.
  if (raw.route !== undefined) {
    if (typeof raw.route !== 'string' || raw.route === '') {
      return fail(WINDOW_SPEC_CODES.EINVALID_SPEC, where + '.route must be a non-empty string', where + '.route');
    }
    if (raw.route.length > WINDOW_SPEC_LIMITS.maxRouteLength) {
      return fail(WINDOW_SPEC_CODES.ERANGE, where + '.route too long', where + '.route');
    }
    if (isSameOriginRoute(raw.route) !== true) {
      return fail(
        WINDOW_SPEC_CODES.EUNSAFE_ROUTE,
        where + '.route must be an absolute same-origin path like "/settings", got ' + JSON.stringify(raw.route),
        where + '.route',
      );
    }
    spec.route = raw.route;
  }
  if (raw.url !== undefined) {
    return fail(
      WINDOW_SPEC_CODES.EUNSAFE_ROUTE,
      where + '.url is not a field: a window loads a same-origin route only',
      where + '.url',
    );
  }

  for (const [field, min, max] of [
    ['width', limits.minWidth, limits.maxWidth],
    ['height', limits.minHeight, limits.maxHeight],
  ]) {
    if (raw[field] === undefined) continue;
    const checked = bounded(raw[field], min, max, where + '.' + field);
    if (checked.ok !== true) return checked;
    spec[field] = checked.value;
  }

  for (const field of ['x', 'y']) {
    if (raw[field] === undefined) continue;
    const checked = bounded(raw[field], -limits.coordLimit, limits.coordLimit, where + '.' + field);
    if (checked.ok !== true) return checked;
    spec[field] = checked.value;
  }

  for (const field of ['resizable', 'frameless', 'modal']) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== 'boolean') {
      return fail(WINDOW_SPEC_CODES.EINVALID_SPEC, where + '.' + field + ' must be a boolean', where + '.' + field);
    }
    spec[field] = raw[field];
  }

  return { ok: true, spec };
}

/**
 * Validate a whole window specification document.
 *
 * Total: every input shape produces an answer, including `null`, an array and a
 * string. Nothing is constructed, no file is read, nothing is remembered — which
 * is exactly the property that makes it safe to ship before the capability
 * exists.
 *
 * Document shape (`window.json`, protocol 1):
 *
 *   {
 *     "protocol": 1,
 *     "owner": "@local/demo",
 *     "windows": [
 *       { "id": "settings", "title": "Demo", "route": "/settings",
 *         "width": 900, "height": 600, "resizable": true }
 *     ]
 *   }
 *
 * @param {unknown} input a parsed document (or the `windows` array alone)
 * @returns {{ ok: true, owner: string, windows: object[], warnings: string[] }
 *         | { ok: false, code: string, message: string, where: string | null }}
 */
export function describeWindowSpec(input) {
  try {
    return describeWindowSpecOrThrow(input);
  } catch (error) {
    // A hostile input (a throwing Proxy, a getter that refuses) must degrade to
    // a refusal, not escape: this is the same rule every other bridge module
    // follows, and it is the reason the validator can be handed bytes from a
    // file that a plugin wrote.
    return fail(
      WINDOW_SPEC_CODES.EINVALID_DOCUMENT,
      'window.json 无法被读取（文档里有抛异常的属性）',
      null,
    );
  }
}

/**
 * @param {unknown} input
 * @returns {object}
 */
function describeWindowSpecOrThrow(input) {
  let rawWindows;
  let owner = '';

  if (Array.isArray(input)) {
    rawWindows = input;
  } else if (isObject(input)) {
    if (input.protocol !== undefined && input.protocol !== PROTOCOL_WINDOW) {
      return fail(
        WINDOW_SPEC_CODES.EPROTOCOL,
        'window.json protocol 必须是 ' + PROTOCOL_WINDOW + '，收到 ' + JSON.stringify(input.protocol),
        'protocol',
      );
    }
    if (input.owner !== undefined) {
      if (typeof input.owner !== 'string') return fail(WINDOW_SPEC_CODES.EINVALID_DOCUMENT, 'owner 必须是字符串', 'owner');
      owner = input.owner;
    }
    rawWindows = input.windows;
  } else {
    return fail(WINDOW_SPEC_CODES.EINVALID_DOCUMENT, 'window.json 必须是对象或以窗口数组开头', null);
  }

  if (Array.isArray(rawWindows) !== true) {
    return fail(WINDOW_SPEC_CODES.EINVALID_DOCUMENT, 'windows 必须是数组', 'windows');
  }
  if (rawWindows.length > MAX_WINDOW_SPECS) {
    return fail(
      WINDOW_SPEC_CODES.ELIMIT,
      '一份文档最多 ' + MAX_WINDOW_SPECS + ' 个窗口，收到 ' + rawWindows.length + ' 个',
      'windows',
    );
  }

  const windows = [];
  const seen = new Set();
  const warnings = [];
  for (let index = 0; index < rawWindows.length; index += 1) {
    const checked = validateWindowSpec(rawWindows[index], 'windows[' + index + ']');
    if (checked.ok !== true) return checked;
    if (seen.has(checked.spec.id)) {
      return fail(
        WINDOW_SPEC_CODES.EDUPLICATE_ID,
        '同一份文档里窗口 id "' + checked.spec.id + '" 重复了',
        'windows[' + index + '].id',
      );
    }
    seen.add(checked.spec.id);
    if (checked.spec.route === undefined) {
      warnings.push('windows[' + index + '] 没有 route：窗口会打开在 DSH 的默认页面');
    }
    windows.push(checked.spec);
  }

  // Unknown top-level keys are named, not silently ignored: this document is a
  // future ABI, and a typo is exactly what the validator exists to catch.
  if (isObject(input)) {
    for (const key of Object.keys(input)) {
      if (key === 'protocol' || key === 'owner' || key === 'windows') continue;
      warnings.push('window.json 顶层字段 "' + key + '" 不在协议里，会被忽略');
    }
  }

  return { ok: true, owner, windows, warnings };
}

/**
 * The validator's private helpers, exported ONLY so the shipped region can carry
 * the same definitions.
 *
 * `lib/asar/patch-body.js` splices `validateWindowSpec`'s own source text into
 * `lib/main.js`, and that source calls `isObject`, `fail` and `bounded`. Those are
 * module-private here, so they have to be reachable by name to be shipped —
 * shipping them (rather than typing a second copy of the ranges and the messages
 * in the region) is what keeps the two halves of the window capability the same
 * code. Nothing in the bridge calls this object; it is a build-time handle, not an
 * API.
 */
export const WINDOW_SPEC_INTERNALS = Object.freeze({
  isObject,
  fail,
  bounded,
});

/**
 * The `channel: "window"` ACK values, as data.
 *
 * ONE definition, quoted by the tracker below, by `describeWindowChannel()` and by
 * the Host-side write half (`lib/host/window-registry.js`), so "what counts as an
 * opened window" cannot be answered two different ways on the two sides of the
 * same file.
 */
export const WINDOW_ACKS = Object.freeze({
  /** The region constructed the window and registered it. */
  opened: 'opened',
  /** The region refused (see `reason`, one of {@link WINDOW_SPEC_CODES} or the region's own codes). */
  rejected: 'rejected',
});

/**
 * The event type the CLOSE push appends to `events.jsonl`.
 *
 * Its own record type — `window-closed` — and not a `notify-click`-style novelty:
 * the Host reads that file through `asarShell.events(cursor)`, which returns the
 * records verbatim, so one new `type` is a purely additive wire change
 * (`PROTOCOL` is untouched: a new type inside an existing JSONL channel does not
 * need a protocol bump, the same way `notify-click` did not).
 */
export const WINDOW_CLOSED_EVENT = 'window-closed';

/**
 * How many menu poll ticks pass between two window samples (4 → ~2.8 s).
 *
 * WHAT A SAMPLE COSTS: `getAllWindows()` in the SAME process — an array copy of
 * already-materialised native handles. No IPC, no file, no hashing, no
 * serialisation. That is why this can be the *cheapest-to-be-fresh* of the slow
 * channels while the file-reading ones stay slower.
 *
 * WHY 4 AND NOT 5 (the patch cadence) OR 1 (the menu cadence):
 *   - 2.8 s is below the point where a human watching a diagnostics page reads the
 *     `known` count as stale, and it is the whole latency budget of the close push
 *     (`describeWindowChannel().close.latencyMs` is DERIVED from this number, so a
 *     document cannot claim less than the code delivers);
 *   - 4 is coprime with the 3-tick notification read and differs from the 5-tick
 *     patch read, so no tick carries all three slow channels: collisions are
 *     ≤ two channels at a time (tick 12 = notify+window, 15 = notify+patch,
 *     20 = window+patch).
 *   - 1 would spend the menu's own tick on it — and the menu tick is what a click
 *     waits on, which is exactly the budget the file channels already compete for.
 *
 * WHY NOT EVENT-DRIVEN (the region's `closed` listener): see the measured
 * argument in {@link createWindowTracker} — the region has 53 B of headroom and
 * the handler costs ≈319 B, so the listener route does not exist until the
 * reserve is raised.
 *
 * @type {number}
 */
export const WINDOW_POLL_EVERY = 4;

/**
 * @param {unknown} value
 * @returns {string|null} the id when it is a non-empty string, else null
 */
function idOf(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read the ELEMENT ID of one Electron window object.
 *
 * Electron gives every `BrowserWindow` a numeric `id` (`webContents.id` as well,
 * but only `win.id` survives a closed/destroyed object). The tracker keys its map
 * by the string form, because the region's ACK names windows by the spec's own
 * string id; the two namespaces are joined by `knownIdsOf()` below, which is why
 * the numeric id is what gets sampled.
 *
 * @param {unknown} window_ an element of `getAllWindows()`
 * @returns {string|null}
 */
function nativeIdOf(window_) {
  if (window_ === null || typeof window_ !== 'object') return null;
  try {
    const id = window_.id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    if (typeof id === 'string' && id !== '') return id;
  } catch (_error) {
    return null; // A hostile getter is not a window.
  }
  return null;
}

/**
 * Sample the live windows, tolerating every failure shape.
 *
 * Total: a missing class, a non-function `getAllWindows`, a throwing call and an
 * array of hostile objects all produce `{available:false}` or a filtered list —
 * never a throw. That matters because this runs on the tray's poll tick, and a
 * diagnostics-only capability must not be able to cost the user his menu.
 *
 * @param {unknown} provider the window class (the region's `electron.window`)
 * @returns {{ available: boolean, error: string | null, windows: unknown[] }}
 */
export function sampleWindows(provider) {
  if (typeof provider !== 'function' && (provider === null || typeof provider !== 'object')) {
    return { available: false, error: 'window provider is not injected', windows: [] };
  }
  let getter;
  try {
    getter = typeof provider === 'function' ? provider.getAllWindows : provider.getAllWindows;
  } catch (_error) {
    return { available: false, error: 'getAllWindows is not readable', windows: [] };
  }
  if (typeof getter !== 'function') {
    return { available: false, error: 'getAllWindows is unavailable', windows: [] };
  }
  let list;
  try {
    list = getter.call(provider);
  } catch (error) {
    return { available: false, error: 'getAllWindows failed: ' + messageOf(error), windows: [] };
  }
  if (Array.isArray(list) !== true) {
    return { available: false, error: 'getAllWindows did not answer an array', windows: [] };
  }
  return { available: true, error: null, windows: list };
}

/**
 * The ids of every CURRENTLY open window, as a Set of strings.
 *
 * Entries whose id cannot be read are SKIPPED rather than guessed: a window the
 * tracker cannot name is one it must not report as closed, because a false
 * `window-closed` event would tell a plugin its window is gone while it is on
 * screen.
 *
 * @param {unknown} provider see {@link sampleWindows}
 * @returns {{ available: boolean, error: string | null, ids: Set<string> }}
 */
export function knownIdsOf(provider) {
  const sampled = sampleWindows(provider);
  const ids = new Set();
  if (sampled.available !== true) return { available: false, error: sampled.error, ids };
  for (const entry of sampled.windows) {
    const id = nativeIdOf(entry);
    if (id !== null) ids.add(id);
  }
  return { available: true, error: null, ids };
}

/**
 * The CLOSE OBSERVER: one object per bridge, ticking on the menu poll.
 *
 * WHY THE CLOSE PUSH LIVES HERE AND NOT IN THE REGION — the MEASURED reason
 * The injected region keeps 1,053 B of spare above a 1,000 B floor, i.e. **53 B**
 * of budget. A `closed` handler that only appends one line to `events.jsonl`
 * needs a function declaration (~270 B measured with the block's own helpers
 * renamed and compacted), a call site in `handleWindowMessage`'s `once("closed")`
 * listener (+~25 B), the substitution-table entry, and the block's `\n\t\t`
 * separators — ~319 B all told, i.e. **six times the headroom**. So the region
 * CANNOT carry it, and the number (not a preference) is what decides.
 *
 * WHAT THE TRACKER ACTUALLY DOES — and why that is still a PUSH
 * The region already records `windows.set(id, created)` and already prunes on
 * `closed`. What it does NOT have is any way to say so (no `child.send`, no
 * `this`). The bridge, meanwhile, runs in the SAME main process as those windows
 * and is handed the window class by the region's `createBridge({electron})`
 * argument. So the tracker polls `getAllWindows()` — an in-process array copy —
 * diffs its numeric ids against the previous sample, and turns "the id that the
 * region ACKed `opened` is no longer in the array" into a `window-closed` line in
 * `events.jsonl`. Latency is ONE SAMPLE (`WINDOW_POLL_EVERY` × 700 ms ≈ 3.5 s),
 * not one Host poll: the Host already reads that file through
 * `asarShell.events(cursor)`, so no second channel was invented for it.
 *
 * CORRELATION, AND ITS ONE HONEST LIMIT
 * The region's ACK carries the SPEC id (`"settings"`), while `getAllWindows()`
 * carries numeric ids. The two are joined at ACK time, which is exactly when both
 * are visible: `relation: 'ack'` records "the region's `opened` ack arrived while
 * this numeric id was the newest window", i.e. the pairing is positional and only
 * as good as "no other window opens between the request and the ACK". That
 * residual is stated in `TECHDOC.md` §21.4 rather than hidden, and a close
 * observed for an id that was never correlated is reported with `id: null` and
 * `nativeId` set — "something closed, name unknown" is still a truthful event,
 * and silence would be the lie.
 *
 * DEGRADATION: with no window class injected, `available:false` from the first
 * tick, zero lines written, and the tray unaffected.
 *
 * @param {{
 *   electron?: unknown,        // the injected `{notification, window}` object
 *   append?: (record: { type: string, id: string|null, owner: string|null, nativeId?: string }) => void,
 *   now?: () => Date,
 * }} input
 * @returns {{
 *   observe: (acks: object[]) => { closed: number },
 *   tick: () => { closed: number, sampled: number },
 *   status: () => object,
 *   dispose: () => void,
 * }}
 */
export function createWindowTracker(input) {
  const settings = isObject(input) ? input : {};
  const electron = isObject(settings.electron) ? settings.electron : {};
  const provider = electron.window === undefined ? null : electron.window;
  const append = typeof settings.append === 'function' ? settings.append : null;

  const state = {
    available: false,
    /** Why the tracker cannot observe anything (first reason wins). */
    lastError: null,
    /** How many closes this tracker has REPORTED (one line each, no duplicates). */
    closed: 0,
    /** The most recent report instant, ISO-8601, for `bridge.json`. */
    lastAt: null,
    /** Samples taken (a counter, so "is it ticking at all" is answerable). */
    sampled: 0,
    disposed: false,
  };

  /**
   * The ids the region ACKED as open, in ACK order, with the owner the Host
   * claimed. A Map keeps insertion order, which is what makes the positional
   * correlation below deterministic.
   *
   * @type {Map<string, { owner: string|null, nativeId: string|null, at: string }>}
   */
  const known = new Map();

  /**
   * Resolve availability ONCE, on construction: a shell that cannot list windows
   * never will, and the sample doubles as the BASELINE below.
   */
  const first = knownIdsOf(provider);
  state.available = first.available === true;
  state.lastError = first.error;

  /**
   * The ids that were ALREADY open when this bridge was built.
   *
   * They are excluded from pairing forever: they are the shell's own windows (or
   * another plugin's), and a bridge that paired its first ack with one of them
   * would report that window as closed later under the wrong spec id. Electron
   * hands out monotonically increasing ids, so anything NEWER than this baseline
   * is a candidate; anything in it never is.
   *
   * @type {Set<string>}
   */
  const baseline = new Set(first.available === true ? first.ids : []);

  /**
   * Correlate one `opened` ACK with the window that appeared because of it.
   *
   * WHY "NEWEST UNPAIRED ID" AND NOT "freshly appeared id": the ACK travels through
   * a FILE (`channel.out.jsonl`) while the native array is instant, so a poll tick
   * commonly samples the new window BEFORE the ack is drained. A freshness diff
   * would then see nothing and leave the window unfairly unpairable. What is stable
   * is ORDER: Electron hands out monotonically increasing window ids, and the
   * region writes its ack only AFTER the window exists. So the candidate set is
   * "live ids not already paired with another known window", and the newest of
   * them is the answer — deterministic, and independent of when samples fell.
   *
   * The residual (stated in `TECHDOC.md` §21.4, not hidden): if a window this
   * bridge never acked appears at the same moment, it can steal the pairing. The
   * consequence is bounded — a close reported under the wrong spec id — and the
   * unpaired case is reported honestly as `nativeId: null` instead of guessed at.
   *
   * @param {string} id the spec id from the ACK
   * @param {string|null} owner the owner the Host claimed, when it did
   * @param {string} at the ACK's own timestamp
   * @returns {string|null} the numeric id it was paired with, or null
   */
  function correlate(id, owner, at) {
    const sampled = knownIdsOf(provider);
    let fresh = null;
    if (sampled.available === true) {
      state.sampled += 1;
      fresh = newestCandidate(sampled.ids, pairedIds());
    }
    known.set(id, { owner, nativeId: fresh, at });
    return fresh;
  }

  /**
   * The numeric ids already paired with a known window — never a candidate again.
   *
   * @returns {Set<string>}
   */
  function pairedIds() {
    const paired = new Set();
    for (const meta of known.values()) {
      if (meta.nativeId !== null) paired.add(meta.nativeId);
    }
    return paired;
  }

  /**
   * The newest live id that could be the window behind an ack.
   *
   * Candidates exclude (a) ids already paired with another known window and (b)
   * the {@link baseline} — windows that were already open before this bridge
   * existed, i.e. the shell's own. Anything else is eligible, and the NEWEST of
   * them wins because Electron's ids are monotone and the region writes its ack
   * only after the window exists.
   *
   * @param {Set<string>} ids the current live ids
   * @param {Set<string>} paired ids already spoken for
   * @returns {string|null}
   */
  function newestCandidate(ids, paired) {
    let fresh = null;
    for (const nativeId of ids) {
      if (paired.has(nativeId)) continue;
      if (baseline.has(nativeId)) continue;
      if (fresh === null || compareIds(nativeId, fresh) > 0) fresh = nativeId;
    }
    return fresh;
  }

  /**
   * How many live ids belong to windows opened AFTER this bridge was built.
   *
   * Everything else is the shell's own window (or another plugin's window that
   * predates this bridge), and none of it is a candidate for pairing.
   *
   * @param {Set<string>} ids the current live ids
   * @returns {number}
   */
  function postBaselineCount(ids) {
    let count = 0;
    for (const nativeId of ids) {
      if (baseline.has(nativeId)) continue;
      count += 1;
    }
    return count;
  }

  /**
   * Order two native window ids so "newer" is well defined for both id kinds.
   *
   * Electron's `id` is a number today; a future shell could hand out strings, so
   * numeric ids compare numerically and anything else compares lexicographically.
   * `undefined` behaviour must never decide a pairing, hence the explicit branches.
   *
   * @param {string} left
   * @param {string} right
   * @returns {number}
   */
  function compareIds(left, right) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  /**
   * Consume the ACKs a drain just produced.
   *
   * Only `channel === 'window'` records matter, and only their `received` value is
   * read: the region answers `{received:'opened', windowId}` or
   * `{received:'rejected', windowId, reason}`, and the bridge stores that object
   * AS JSON in `channel.out.jsonl` (see `writeChannelAck`), so `received` reaches
   * this function as an object. A string `received` is the `declined` shape and
   * carries no window id, so it is skipped.
   *
   * @param {object[]} acks records as `lib/bridge/src/channel.js` `drain()` returns them
   * @returns {{ closed: number, opened: string[] }}
   */
  function observe(acks) {
    const result = { closed: 0, opened: [] };
    if (state.disposed || Array.isArray(acks) !== true) return result;
    for (const record of acks) {
      if (isObject(record) !== true) continue;
      if (record.channel !== 'window') continue;
      const answered = record.received;
      if (isObject(answered) !== true) continue;
      if (answered.received !== WINDOW_ACKS.opened) continue;
      const id = idOf(answered.windowId);
      if (id === null) continue;
      // A SECOND `opened` for an id that is still known is not a new window: the
      // region refuses duplicates, so this can only be a replayed ACK (an older
      // artefact, a duplicated line). Keeping the FIRST correlation is right, and
      // it is what makes "one record per close" hold.
      if (known.has(id)) continue;
      correlate(id, idOf(record.owner), typeof record.at === 'string' ? record.at : '');
      result.opened.push(id);
    }
    result.closed = state.closed;
    return result;
  }

  /**
   * Take ONE sample and report every known window that disappeared.
   *
   * EXACTLY ONCE: a closed id is REMOVED from `known` as it is reported, so the
   * next tick cannot report it again. A window that never appeared in an ACK is
   * not ours to report: this tracker observes the windows THIS plugin opened,
   * which is also the only set the region keeps.
   *
   * @returns {{ closed: number, sampled: number }}
   */
  function tick() {
    if (state.disposed) return { closed: 0, sampled: state.sampled };
    const sampled = knownIdsOf(provider);
    if (sampled.available !== true) {
      // The provider stopped answering (a shell tearing down): keep the map and
      // say why, instead of reporting every known window as closed.
      state.lastError = sampled.error;
      return { closed: 0, sampled: state.sampled };
    }
    state.sampled += 1;
    // RETRO-PAIRING: an ack drained on the same tick the window is created can
    // arrive BEFORE the native array shows it (the ack file is one poll behind, but
    // the two cross in either order). When exactly ONE entry is unpaired and
    // exactly ONE candidate exists, that candidate IS its window — pairing it here
    // is what lets the "opened, then sampled too early" case still be closed later.
    // With more than one of either, the pairing would be a guess, so it is left
    // unpaired and judged by the coverage rule below.
    let unpaired = 0;
    for (const meta of known.values()) if (meta.nativeId === null) unpaired += 1;
    if (unpaired === 1) {
      const candidate = newestCandidate(sampled.ids, pairedIds());
      if (candidate !== null) {
        for (const meta of known.values()) if (meta.nativeId === null) meta.nativeId = candidate;
      }
    }
    let closed = 0;
    for (const [id, meta] of [...known]) {
      // An entry still unpaired after the rule above is judged by COVERAGE: how many
      // windows exist past the baseline. If none does, the ack's window cannot be
      // open any more; if any does, one of them may be it, and claiming a close
      // would be the lie.
      const stillOpen = meta.nativeId === null
        ? postBaselineCount(sampled.ids) > 0
        : sampled.ids.has(meta.nativeId);
      if (stillOpen) continue;
      known.delete(id);
      state.closed += 1;
      closed += 1;
      state.lastAt = isoNow();
      if (append !== null) {
        try {
          append({
            type: WINDOW_CLOSED_EVENT,
            id,
            owner: meta.owner,
            nativeId: meta.nativeId,
            // The SAME instant `status()` reports: passing it through means the
            // record and the `windows` block cannot disagree by a millisecond, which
            // would make "the event and the counter are one fact" a coincidence.
            at: state.lastAt,
          });
        } catch (_error) {
          // Losing the diagnostic line must not lose the counter: the close
          // happened, and `status()` still says so.
        }
      }
    }
    return { closed, sampled: state.sampled };
  }

  return {
    observe,
    tick,

    /**
     * The windows this bridge KNOWS are open — the snapshot `status().windows`
     * carries and the Host reads through `bridge.json`.
     *
     * NOT a live Electron query: it is the correlation map, i.e. "an `opened` ACK
     * arrived for this spec id and no `window-closed` has been reported since".
     * That is the honest answer from the bridge's position, and it is the answer a
     * caller actually wants (the region's own live count is not reachable without
     * another IPC round trip, and the region cannot answer one).
     *
     * @returns {object[]}
     */
    known() {
      const out = [];
      for (const [id, meta] of known) {
        out.push({ id, owner: meta.owner, nativeId: meta.nativeId, at: meta.at });
      }
      return out;
    },

    /**
     * The block `bridge.json` persists and `status()` reports. BOUNDED by
     * construction: five counters plus two strings. `known` is a COUNT here, not
     * the list — a diagnostics file must not grow with the number of windows, so
     * the list lives in `status()` only (see `known()` above).
     *
     * @returns {{ available: boolean, known: number, max: number, closed: number,
     *             sampled: number, lastAt: string|null, lastError: string|null }}
     */
    status() {
      return {
        available: state.available,
        known: known.size,
        // The cap is the region's, quoted rather than re-derived: this block
        // describes the SAME set of windows the region counts.
        max: MAX_WINDOW_SPECS,
        closed: state.closed,
        sampled: state.sampled,
        lastAt: state.lastAt,
        lastError: state.lastError,
      };
    },

    /** Stop observing. The windows and the files stay where they are. */
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      known.clear();
    },
  };
}

/**
 * What this capability can and cannot do today, for `status()` and for a
 * diagnostics page.
 *
 * `implemented` is `false` and that is still the honest answer HERE: this module
 * is the declarative half, it constructs nothing and it never will (the artefact
 * must not name an Electron UI class — `test/bridge-build.test.mjs`'s red-line
 * scan forbids it, which is what keeps "the bridge does not create windows"
 * checkable). WHAT DOES NOW EXIST is the imperative half, inside the injected
 * region: `channel: "window"` validates a spec with these same functions and
 * constructs a real `BrowserWindow` in the Electron main process. That is
 * reported separately, by `describeWindowChannel()` below, so "the contract is
 * here" and "a window really opens" are two answers instead of one lie.
 *
 * WHICH shell names the imperative half needs is deliberately NOT listed here;
 * `TECHDOC.md` §21 is the place a human reads that list.
 *
 * @returns {{ implemented: boolean, declarative: true, imperative: false, channel: string|null, spec: object }}
 */
export function describeWindowCapability() {
  return {
    implemented: false,
    declarative: true,
    imperative: false,
    channel: null,
    spec: {
      protocol: PROTOCOL_WINDOW,
      maxWindows: MAX_WINDOW_SPECS,
      fields: SPEC_FIELDS.slice(),
      limits: { ...WINDOW_SPEC_LIMITS },
    },
  };
}

/**
 * What the `channel: "window"` half can do, as a fact the bridge can report.
 *
 * No probes: this is a constant because whether the MAIN process can construct a
 * window is a property of the shipped region, not of the bridge's process. The
 * region answers `{received:'opened'|'rejected'}` per request and appends it to
 * `channel.out.jsonl`; the bridge reads that file, so an operator asking "did my
 * window open" gets "check `status().channel.received` and the ack lines" rather
 * than a boolean that would have to be guessed.
 *
 * `notImplemented` IS PART OF THE CONTRACT, not a footnote. Everything a reader of
 * "windows work now" would reasonably assume is either listed as absent here or
 * described as a HARD LIMIT of the half that does exist — because an absent field
 * reads as "unlimited" to the next implementer:
 *
 *   - no isolated `session` and no custom `protocol` (the region cannot reach
 *     either), so a window shares the shell's default session and must render the
 *     shell's own origin;
 *   - no `window.json` DECLARATIVE writer: the write half that DOES exist is
 *     `asarShell.openWindow`, i.e. one spec per IPC message, not a file the bridge
 *     polls;
 *   - the close push is OBSERVED (see `close` below), not instant: it costs one
 *     sample interval, because the region cannot `child.send` and the bridge
 *     cannot see a `closed` event that was never registered (`TECHDOC.md` §21.4).
 *
 * @returns {{ channel: string, implemented: boolean, imperative: true, declarative: true,
 *             fields: string[], limits: object,
 *             ack: { opened: object, rejected: object },
 *             close: object, notImplemented: string[] }}
 */
export function describeWindowChannel() {
  return {
    channel: 'window',
    implemented: true,
    imperative: true,
    declarative: true,
    fields: SPEC_FIELDS.slice(),
    // The LIVE-window cap. It is NOT inside `limits`, because `limits` describes
    // how to read one spec (sizes, coordinates, string lengths) while this one
    // counts windows that already exist — and only the region can count those.
    maxWindows: MAX_WINDOW_SPECS,
    limits: { ...WINDOW_SPEC_LIMITS },
    // The two ack SHAPES, as data. A caller can compare against them instead of
    // parsing a prose description, which is what a string here used to be.
    ack: {
      opened: { received: 'opened', windowId: '<id>' },
      rejected: { received: 'rejected', windowId: '<id>|null', reason: '<code>' },
    },
    // THE CLOSE PUSH, as data instead of prose: which file it lands in, what the
    // record's type is, and what a caller should budget for its latency. `latencyMs`
    // is DERIVED from the shipped cadence, so a slower sample cannot be described
    // as instant by a stale number in a document.
    close: {
      observed: true,
      event: WINDOW_CLOSED_EVENT,
      file: 'events.jsonl',
      readVia: 'asarShell.events(cursor)',
      pollEvery: WINDOW_POLL_EVERY,
      latencyMs: WINDOW_POLL_EVERY * POLL_MS,
    },
    notImplemented: [
      'session',           // the new window shares the default session
      'protocol',          // the route must be on the shell's own origin
      'declarativeWriter', // no window.json write half; openWindow is one message
    ],
  };
}
