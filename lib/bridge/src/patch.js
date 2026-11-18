/**
 * Declarative dynamic-patch hook — the bridge's installer half.
 *
 * WHAT THIS IS
 * A Host plugin writes `<stateDir>/patches.json` (see `lib/host/patch-registry.js`);
 * this module reads it and turns it into live behaviour inside the Electron main
 * process by hooking Node's CommonJS loader.
 *
 * THE SECURITY BOUNDARY, STATED PLAINLY (and deliberately not hidden)
 * `source` is JAVASCRIPT TEXT evaluated with `Function` inside the main process.
 * That is the whole point — there is no other way to inject behaviour into a
 * running process — and it means:
 *
 *     Any process that can write <stateDir>/patches.json can run ARBITRARY
 *     CODE in the Electron main process, with the application's own
 *     privileges, including reading and writing files and starting processes.
 *
 * The Host plugin runs as an `ELECTRON_RUN_AS_NODE=1` child of that same main
 * process and can already write the state directory, so this capability raises
 * nothing that was not already reachable through it — but it makes the path
 * EXPLICIT: one file instead of a chain of IPC calls. Treat `patches.json` with
 * exactly the trust you give the application's own source, and delete it when
 * you do not need it.
 *
 * ---------------------------------------------------------------------------
 * WHAT ACTUALLY WORKS, MEASURED (not assumed)
 *
 * The facts this design rests on were measured on this machine rather than
 * reasoned about (`scratch/patch-hook-probe.mjs` and `-probe2.mjs`, both kept and
 * both runnable):
 *
 *  1. `Module._load` is the ONE hook point that fires for every CommonJS load:
 *     a plain `require()` from a CJS module, a `createRequire(...)` from an ESM
 *     module (`lib/main.js` line 1 obtains `require` exactly that way), and a
 *     `require()` of an ESM module under Node's require-ESM support.
 *     `Module.prototype.require` also fires, but only because it DELEGATES to
 *     `_load`; hooking `_load` alone covers both, and hooking both would
 *     double-patch. Hence exactly one wrapper.
 *
 *  2. In-place patching of a CommonJS `exports` object WORKS and preserves
 *     identity: every later `require()` of that id receives the same object, so
 *     a replaced symbol is visible to the whole process, and putting the original
 *     value back is a real undo (`test/patch-hook.test.mjs`).
 *
 *  3. An ESM namespace object is SEALED: assignment to a symbol throws
 *     `TypeError`, and a static `import` binding is frozen at link time. So an
 *     ESM module CANNOT be patched in place, and this hook REFUSES with
 *     `EPATCH_FROZEN_EXPORTS` instead of pretending. That is the honest boundary:
 *     only CommonJS modules whose exports are still mutable can be patched.
 *     A `require()`d ESM module could technically be reached by swapping its
 *     cache entry's `exports`, but every already-linked `import` would keep the
 *     old binding — a half-working patch is worse than a clear refusal, so it is
 *     not offered.
 *
 * A dynamic `import()` never reaches `_load` at all (measured: zero requests
 * observed), so ESM-only code paths are out of scope by measurement.
 *
 * ---------------------------------------------------------------------------
 * NON-INVASIVE BY CONSTRUCTION
 * The `_load` wrapper returns the original result after ONE `Map.get` unless a
 * non-empty spec exists, and the hook is not installed AT ALL until such a spec
 * arrives. So a bridge with no `patches.json` behaves exactly as it did before
 * this module existed (`test/patch-hook.test.mjs`: "an unmatched module behaves
 * exactly as before").
 *
 * IDEMPOTENT, TWO INDEPENDENT GUARDS:
 *   - a per-id applied marker (`state.applied`), and
 *   - a `WeakSet` of already-patched exports objects plus a `WeakMap` recording
 *     exactly which item ids were applied to WHICH exports object.
 * The second guard is what makes "the same patch id twice" impossible to
 * double-wrap even when the first marker was dropped — e.g. after a revert whose
 * assignment failed, where the mutation is still live but this module no longer
 * tracks it as applied.
 *
 * FAIL-SOFT: everything that can throw (policy refusal, source evaluation, the
 * wrap factory, the not-a-function rail, the mutability check) runs BEFORE the
 * single assignment. A throwing patch therefore leaves the module provably
 * untouched, records the reason, and the loader returns the module it always
 * would have returned. The wrapper contains its own body as well, so no patch
 * error can escape into Electron's loader.
 *
 * REVERTIBLE: the marker keeps a `restore` closure, so an item that disappears
 * (or flips to `enabled:false`, or changes its source) is undone on the next sync
 * by writing the original value back. Where that is NOT possible it is said out
 * loud: a module that freezes its exports after a successful patch cannot be
 * restored — `EPATCH_REVERT_FAILED` is recorded and the item stops being tracked,
 * so the process keeps the patched behaviour (there is no second channel into a
 * frozen object). A patch whose exports were ALREADY frozen is refused before
 * anything is touched (`EPATCH_FROZEN_EXPORTS`).
 *
 * BOOT REPLAY: modules loaded before the hook existed are reached through
 * `Module._cache` at sync time (matched by exact id or `node_modules/<pkg>/`), and
 * those applications count as `replayed`. An enabled item whose target matches
 * nothing in the cache counts as `missed` — not an error: it waits for the
 * module's own load through the hook. Nothing is guessed.
 *
 * SELF-TARGET: the bridge must never patch itself. Two independent guards — the
 * item is refused when its target names the artefact (`EPATCH_SELF_TARGET`), and
 * the cache scan skips the artefact's own id — because patching the code that
 * does the patching would recurse into the loader from inside itself. Node
 * built-ins are refused for the adjacent reason (`EPATCH_BUILTIN_TARGET`):
 * replacing `node:fs` would change every `require` in the process, this module's
 * own included.
 *
 * RED LINES (unchanged): no `require('electron')`, no windows, no network. The
 * only fs access is the state directory, through `paths.js`.
 */

import * as NodeModule from 'node:module';

import {
  FILES,
  PROTOCOL_PATCH,
  messageOf,
  readContributionSource,
} from './paths.js';

/**
 * The CommonJS loader object this build talks to.
 *
 * WHY THE `.default` DANCE: the shipped artefact is one CommonJS file, so the
 * builder compiles `import * as NodeModule from 'node:module'` into
 * `__require('node:module')`, which IS the loader function. The sources are ESM,
 * so importing them directly (tests, the Host half) yields a namespace whose
 * `.default` is that same function. Both shapes end up at the same object, which
 * matters because a test must be able to install and remove the hook on the real
 * loader.
 */
const DEFAULT_LOADER = typeof NodeModule.default === 'function' ? NodeModule.default : NodeModule;

/** Absolute path of the running artefact; `null` in the ESM sources (no `__filename`). */
const SELF_FILE = typeof __filename === 'string' && __filename !== '' ? __filename : null;

/**
 * The process-global key for the hook state.
 *
 * `Symbol.for` is the symbol registry, which survives the bridge's own hot reload:
 * the reloaded artefact is a NEW module instance with new module-level variables,
 * but `globalThis` and the loader are shared by the process. A reloaded bridge
 * therefore TAKES OVER the existing hook instead of stacking a second wrapper —
 * which is what would otherwise happen every ~12 s that the artefact watcher fires.
 */
export const PATCH_STATE_SYMBOL = Symbol.for('dsh-asar-framework.patch-hook');

/** Hard ceilings on the spec document and on one `source`. */
export const PATCH_LIMITS = Object.freeze({
  /**
   * One `source`, in UTF-8 bytes (8,192).
   *
   * WHY: a patch body is a wrapper — tens of lines, not a library. It is the same
   * order as the notification body budget, and half of {@link documentBytes}, so
   * a single item can never eat the whole document. Two reasons matter: the
   * document is POLLED (it has to stay small enough to re-read for free), and
   * the failure text in `bridge.json` is clipped, so an unbounded source would
   * make the one diagnostic that matters useless exactly when it is needed.
   */
  sourceBytes: 8192,
  /** One document carries at most 32 items (the menu tree's cap is 256; this is far smaller on purpose). */
  items: 32,
  /**
   * The whole `patches.json`, in bytes (16 KiB).
   *
   * 32 items x 8 KiB would be 256 KiB in the worst case; this cap bounds the
   * total, and it is deliberately much smaller than the menu's 256 KiB because
   * this file is read every few seconds rather than when a click happens. A
   * realistic spec is a few hundred bytes per item.
   */
  documentBytes: 16 * 1024,
  /** Item id / owner length caps (same order as the contribution registry's owner cap). */
  idLength: 96,
  ownerLength: 128,
  /** `lastError` is clipped before it reaches `bridge.json`. */
  lastErrorLength: 160,
});

/*
 * The poll cadence ({@link PATCH_POLL_EVERY}) lives in `paths.js`, together with
 * every other cadence, so the artefact has ONE place where "how often does the
 * bridge look at a file" is decided. The kernel imports it from there; this module
 * does not need it (the kernel owns the timer).
 */

/**
 * Every reason this module can refuse or fail, as a stable code.
 *
 * Codes appear in `status().patches.lastError` and in `bridge.json`, because a
 * human reading a support report must be able to tell "the spec named a module
 * that is not loaded yet" (`missed`, harmless) from "the source did not compile"
 * (`failed`, somebody must fix the file).
 */
export const PATCH_CODES = Object.freeze({
  /** `patches.json` is not valid JSON, or not `{protocol: 1, rev, items}`. */
  PROTOCOL: 'EPATCH_PROTOCOL',
  INVALID: 'EPATCH_INVALID',
  /** One item is malformed. */
  ITEM: 'EPATCH_ITEM',
  SOURCE_TOO_LARGE: 'EPATCH_SOURCE_TOO_LARGE',
  ITEMS_LIMIT: 'EPATCH_ITEMS_LIMIT',
  OVERSIZE: 'EPATCH_OVERSIZE',
  /** The item targets the bridge artefact itself. */
  SELF_TARGET: 'EPATCH_SELF_TARGET',
  /** The item targets a Node built-in. */
  BUILTIN_TARGET: 'EPATCH_BUILTIN_TARGET',
  /** The named symbol is not on the module's exports. */
  SYMBOL_MISSING: 'EPATCH_SYMBOL_MISSING',
  /** The exports object is sealed/frozen (an ESM namespace, or a frozen CJS object). */
  FROZEN: 'EPATCH_FROZEN_EXPORTS',
  /** `wrap` produced something that is not a function. */
  NOT_FUNCTION: 'EPATCH_NOT_FUNCTION',
  /** The source text threw while it was being evaluated. */
  SOURCE_THREW: 'EPATCH_SOURCE_THREW',
  /** The mutation itself threw (a throwing setter, a proxy). */
  APPLY_THREW: 'EPATCH_APPLY_THREW',
  /** A previously applied patch could not be put back. */
  REVERT_FAILED: 'EPATCH_REVERT_FAILED',
  /** There is no usable state directory, so no spec and no hook. */
  NO_STATE_DIR: 'EPATCH_NO_STATE_DIR',
  /** The loader object does not expose `_load`, so nothing can be installed. */
  UNAVAILABLE: 'EPATCH_UNAVAILABLE',
});

/**
 * @param {unknown} value
 * @returns {boolean} true for a non-null, non-array object
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * UTF-8 byte length of a JavaScript string.
 *
 * The same algorithm all three wire halves use; each keeps its own copy because
 * neither a bridge module nor a Host module may import the other's private helper
 * (the artefact is one standalone file).
 *
 * @param {string} text
 * @returns {number}
 */
function utf8Bytes(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Node's own module identifiers, refused as patch targets.
 *
 * Built from `isBuiltin` when the runtime has it (Node 18.6+, which every Electron
 * this package supports has) with a set fallback so an older Node cannot silently
 * accept a builtin target.
 */
const BUILTIN_TEST = (() => {
  const isBuiltin = typeof NodeModule.isBuiltin === 'function' ? NodeModule.isBuiltin : null;
  if (isBuiltin !== null) {
    return (request) => {
      try {
        return isBuiltin(request) === true;
      } catch (_error) {
        return false;
      }
    };
  }
  const list = Array.isArray(NodeModule.builtinModules) ? NodeModule.builtinModules : [];
  const names = new Set();
  for (const name of list) {
    names.add(name);
    names.add('node:' + name);
  }
  return (request) => names.has(request);
})();

/**
 * Normalise a path-ish module id so two spellings of the same file compare equal.
 *
 * @param {string} value
 * @returns {string}
 */
function normaliseId(value) {
  return value.replace(/\\/g, '/');
}

/**
 * Does a `Module._cache` key (or a bare specifier) correspond to this spec `target`?
 *
 * TWO RULES, both deliberately narrow, so the `missed` counter is explainable:
 *   1. an EXACT id match after separator normalisation — this is how a target
 *      written as an absolute path replays, and how a hook-time `request` (which
 *      is exactly what the caller typed) is matched without touching the loader;
 *   2. a package path: `<any>/node_modules/<target>/…` (bare name) or an id ending
 *      in `/node_modules/<target>`. This is how a target written as a bare package
 *      name (`'zod'`, `'@scope/pkg'`) finds the file Node actually cached, without
 *      this module having to resolve anything.
 *
 * Everything else is a miss. The consequence is stated on purpose: a target is a
 * SPECIFIER STRING, never a glob, and a `./`-relative specifier is NOT rewritten
 * into an absolute tail — rewriting it would make a relative specifier silently
 * match a different module (`'./a.cjs'` matching `<drive>:/x/a.cjs`), which is exactly
 * the kind of near-hit a patch spec must never produce.
 *
 * @param {string} target
 * @param {string} id
 * @returns {boolean}
 */
export function matchesCachedId(target, id) {
  if (typeof target !== 'string' || target === '' || typeof id !== 'string') return false;
  const normalTarget = normaliseId(target);
  const normalId = normaliseId(id);
  if (normalId === normalTarget) return true;
  // A path-shaped target (`/`, `\\`, or a drive colon) matches a longer id that
  // ends with that EXACT tail. This is what lets a spec name the artefact by tail
  // (`dsh/tray-bridge.js`) and still be refused as a self-target, and what lets a
  // path written relative to a package root find its absolute cache key.
  if (normalTarget.includes('/') || normalTarget.includes(':')) {
    return normalId.endsWith('/' + normalTarget);
  }
  const packagePath = '/node_modules/' + normalTarget;
  return normalId.includes(packagePath + '/') || normalId.endsWith(packagePath);
}

/**
 * Validate one spec item's SHAPE and limits.
 *
 * Policy checks that need process context (self-target, builtins) happen at apply
 * time instead, so every refusal — structural or situational — lands in the same
 * `failed` counter with a code a human can read.
 *
 * @param {unknown} raw
 * @param {number} index
 * @returns {{ ok: true, item: object } | { ok: false, code: string, message: string }}
 */
function normalizeItem(raw, index) {
  if (!isObject(raw)) {
    return { ok: false, code: PATCH_CODES.ITEM, message: 'item ' + index + ' is not an object' };
  }
  if (Object.prototype.hasOwnProperty.call(raw, '__proto__')) {
    return { ok: false, code: PATCH_CODES.ITEM, message: 'item ' + index + ' must not carry a __proto__ key' };
  }
  if (typeof raw.id !== 'string' || raw.id === '') {
    return { ok: false, code: PATCH_CODES.ITEM, message: 'item ' + index + ' needs a non-empty string id' };
  }
  if (raw.id.length > PATCH_LIMITS.idLength) {
    return {
      ok: false,
      code: PATCH_CODES.ITEM,
      message: 'item ' + index + ' id is ' + raw.id.length + ' characters; the limit is ' + PATCH_LIMITS.idLength,
    };
  }
  if (typeof raw.owner !== 'string' || raw.owner === '') {
    return { ok: false, code: PATCH_CODES.ITEM, message: 'item ' + raw.id + ' needs a non-empty string owner' };
  }
  if (raw.owner.length > PATCH_LIMITS.ownerLength) {
    return { ok: false, code: PATCH_CODES.ITEM, message: 'item ' + raw.id + ' owner is longer than ' + PATCH_LIMITS.ownerLength };
  }
  if (typeof raw.target !== 'string' || raw.target === '') {
    return { ok: false, code: PATCH_CODES.ITEM, message: 'item ' + raw.id + ' needs a non-empty string target' };
  }
  // `symbol` is REQUIRED. This module patches a NAMED export and never swaps a
  // module's whole exports object: replacing a module wholesale is a different
  // (larger) power, and not something a caller should do by accident.
  if (typeof raw.symbol !== 'string' || raw.symbol === '') {
    return { ok: false, code: PATCH_CODES.ITEM, message: 'item ' + raw.id + ' needs a non-empty string symbol' };
  }
  if (raw.kind !== 'replace' && raw.kind !== 'wrap') {
    return { ok: false, code: PATCH_CODES.ITEM, message: 'item ' + raw.id + " kind must be 'replace' or 'wrap'" };
  }
  if (typeof raw.source !== 'string' || raw.source.trim() === '') {
    return { ok: false, code: PATCH_CODES.ITEM, message: 'item ' + raw.id + ' needs non-empty source text' };
  }
  const sourceBytes = utf8Bytes(raw.source);
  if (sourceBytes > PATCH_LIMITS.sourceBytes) {
    return {
      ok: false,
      code: PATCH_CODES.SOURCE_TOO_LARGE,
      message: 'item ' + raw.id + ' source is ' + sourceBytes + ' bytes; the limit is ' + PATCH_LIMITS.sourceBytes,
    };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    return { ok: false, code: PATCH_CODES.ITEM, message: 'item ' + raw.id + ' enabled must be a boolean' };
  }
  return {
    ok: true,
    item: Object.freeze({
      id: raw.id,
      owner: raw.owner,
      target: raw.target,
      symbol: raw.symbol,
      kind: raw.kind,
      source: raw.source,
      enabled: raw.enabled !== false,
      index,
    }),
  };
}

/**
 * Parse and validate a `patches.json` document.
 *
 * TOTAL: never throws. A document that is not JSON, not an object, or whose
 * `protocol` is not {@link PROTOCOL_PATCH} is rejected as a WHOLE — an unreadable
 * contract is not half-honoured — while ITEMS that are individually invalid are
 * collected in `rejected` and the rest of the document still applies. One
 * malformed item must not switch off every other patch.
 *
 * @param {string | null | undefined} text
 * @returns {{ ok: boolean, empty: boolean, spec: { protocol: number, rev: number, items: object[] },
 *             rejected: object[], error: string | null, code: string | null }}
 */
export function parsePatchSpec(text) {
  const rejected = [];
  const emptySpec = { protocol: PROTOCOL_PATCH, rev: 0, items: [] };
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: true, empty: true, spec: emptySpec, rejected, error: null, code: null };
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      empty: false,
      spec: emptySpec,
      rejected,
      error: PATCH_CODES.INVALID + ': patches.json is not valid JSON (' + messageOf(error) + ')',
      code: PATCH_CODES.INVALID,
    };
  }
  if (!isObject(document)) {
    return {
      ok: false,
      empty: false,
      spec: emptySpec,
      rejected,
      error: PATCH_CODES.INVALID + ': patches.json must be a JSON object',
      code: PATCH_CODES.INVALID,
    };
  }
  if (document.protocol !== PROTOCOL_PATCH) {
    return {
      ok: false,
      empty: false,
      spec: emptySpec,
      rejected,
      error: PATCH_CODES.PROTOCOL + ': patches.json protocol is ' + String(document.protocol)
        + '; this bridge speaks ' + PROTOCOL_PATCH,
      code: PATCH_CODES.PROTOCOL,
    };
  }
  const rawItems = Array.isArray(document.items) ? document.items : null;
  if (rawItems === null) {
    return {
      ok: false,
      empty: false,
      spec: emptySpec,
      rejected,
      error: PATCH_CODES.INVALID + ': patches.json items must be an array',
      code: PATCH_CODES.INVALID,
    };
  }
  if (rawItems.length > PATCH_LIMITS.items) {
    // Over the cap the document is refused WHOLE, not truncated: silently dropping
    // patches would leave a plugin believing its code is live.
    return {
      ok: false,
      empty: false,
      spec: emptySpec,
      rejected,
      error: PATCH_CODES.ITEMS_LIMIT + ': patches.json carries ' + rawItems.length
        + ' items; the limit is ' + PATCH_LIMITS.items,
      code: PATCH_CODES.ITEMS_LIMIT,
    };
  }
  const items = [];
  const seen = new Set();
  for (let index = 0; index < rawItems.length; index++) {
    const normalized = normalizeItem(rawItems[index], index);
    if (normalized.ok !== true) {
      rejected.push({ index, code: normalized.code, message: normalized.message });
      continue;
    }
    if (seen.has(normalized.item.id)) {
      rejected.push({
        index,
        code: PATCH_CODES.ITEM,
        message: 'item id ' + normalized.item.id + ' appears twice; a second definition would silently win, so it is refused',
      });
      continue;
    }
    seen.add(normalized.item.id);
    items.push(normalized.item);
  }
  const rev = typeof document.rev === 'number' && Number.isFinite(document.rev) && document.rev >= 0
    ? Math.floor(document.rev)
    : 0;
  return {
    ok: true,
    empty: items.length === 0,
    spec: { protocol: PROTOCOL_PATCH, rev, items },
    rejected,
    error: null,
    code: null,
  };
}

/**
 * Turn one `source` string into a value.
 *
 * THE SECURITY BOUNDARY LIVES ON THIS LINE. `Function` is the only way to make
 * text behave, and everything reachable from the main process is reachable from
 * the code it compiles. A valid spec is therefore equivalent to write access to
 * the application's main process — see the file header.
 *
 * `source` is an EXPRESSION, not a statement list: it is wrapped in parentheses,
 * so both a function expression (`function (original) { … }`, `(original) => …`)
 * and a plain value (`(x) => x + 1`) are accepted, and a trailing newline is
 * appended so a final `//` comment cannot swallow the closing bracket. A `source`
 * that is a bare statement (`throw new Error(…)`, `return …`) therefore does not
 * compile — and the message says exactly that instead of leaving the author to
 * guess from "Unexpected token".
 *
 * @param {string} source
 * @returns {unknown} the evaluated value
 */
function evaluateSource(source) {
  const factory = Function('return (' + source + '\n);');
  return factory();
}

/**
 * Is this exports object writable at all?
 *
 * Checked BEFORE the assignment so the failure is NAMED (`EPATCH_FROZEN_EXPORTS`)
 * instead of surfacing as a TypeError from inside it — and so a refused patch
 * leaves the module provably untouched.
 *
 * @param {unknown} exports
 * @param {string} symbol
 * @returns {string | null} a reason, or null when the symbol can be written
 */
function mutationBlockedBy(exports, symbol) {
  if (exports === null || (typeof exports !== 'object' && typeof exports !== 'function')) {
    return 'module exports are ' + (exports === null ? 'null' : typeof exports) + ', not an object';
  }
  if (Object.isFrozen(exports)) return 'module exports are frozen';
  if (Object.isSealed(exports)) return 'module exports are sealed';
  if (Object.isExtensible(exports) !== true) return 'module exports are not extensible';
  let descriptor = null;
  try {
    descriptor = Object.getOwnPropertyDescriptor(exports, symbol);
  } catch (_error) {
    descriptor = null;
  }
  if (descriptor !== null && descriptor.writable === false && descriptor.get === undefined) {
    return 'export ' + JSON.stringify(symbol) + ' is a read-only property';
  }
  if (descriptor !== null && descriptor.get !== undefined && descriptor.set === undefined && descriptor.writable !== true) {
    return 'export ' + JSON.stringify(symbol) + ' is an accessor without a setter';
  }
  return null;
}

/**
 * The per-item signature used for idempotence and for "do not spin on a failure".
 *
 * Byte-for-byte over everything that changes behaviour: an edited `source` is a
 * new signature, so a FIXED patch retries while an unchanged broken one does not
 * (the same no-spin rule the artefact hot reload uses, for the same reason: a
 * permanently broken file must not cost work every tick).
 *
 * @param {object} item
 * @returns {string}
 */
function signatureOf(item) {
  return item.kind + '\u0000' + item.target + '\u0000' + item.symbol + '\u0000' + item.source;
}

/**
 * Read (or create) the process-global hook state.
 *
 * @param {{ loader: any, stateHost: any, stateSymbol: symbol }} input
 * @returns {object}
 */
function hookStateOf(input) {
  const host = input.stateHost;
  const symbol = input.stateSymbol;
  let state = null;
  try {
    state = host[symbol] === undefined ? null : host[symbol];
  } catch (_error) {
    state = null;
  }
  if (isObject(state)) {
    // A reloaded bridge finds what the previous bridge left behind and TAKES IT
    // OVER: the wrapper stays installed exactly once, and the patches already
    // applied inside live modules keep their markers.
    state.loader = input.loader;
    return state;
  }
  state = {
    loader: input.loader,
    symbol,
    host,
    /** Absolute artefact path; the self-target guard. */
    selfFile: SELF_FILE,
    /** The `_load` captured before the wrapper — the ONLY thing an uninstall restores. */
    original: null,
    wrapper: null,
    installed: false,
    /** `request` string -> item[]; `null` means "no spec synced yet". */
    targets: null,
    /** item id -> `{ signature, via, exports, restore }`; the per-id applied marker. */
    applied: new Map(),
    /** GUARD 1: exports objects that carry at least one patch from this hook. */
    patched: null,
    /** GUARD 2: exports object -> Map(item id -> { signature, original }). */
    marks: null,
    /** item id -> `{ signature, code, message }`; bounded by PATCH_LIMITS.items. */
    failures: new Map(),
    /** The controller currently polling, so a reloaded bridge can take over. */
    owner: null,
  };
  try {
    state.patched = new WeakSet();
    state.marks = new WeakMap();
  } catch (_error) {
    // No WeakMap/WeakSet in this realm: the per-id marker alone still prevents a
    // double wrap on the ordinary path.
    state.patched = null;
    state.marks = null;
  }
  try {
    Object.defineProperty(host, symbol, {
      value: state,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch (_error) {
    // A frozen `globalThis` leaves the hook un-installable; `available:false`
    // then says so instead of pretending.
    state.hostBroken = true;
  }
  return state;
}

/**
 * Install the ONE `_load` wrapper for this process.
 *
 * Called only when a non-empty spec exists, so a bridge that has never seen a
 * `patches.json` never touches the loader.
 *
 * @param {object} state
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
function installHook(state) {
  if (state.installed === true) return { ok: true };
  const loader = state.loader;
  if (!isObject(loader) && typeof loader !== 'function') {
    return { ok: false, code: PATCH_CODES.UNAVAILABLE, message: 'the module loader is not an object' };
  }
  if (typeof loader._load !== 'function') {
    return { ok: false, code: PATCH_CODES.UNAVAILABLE, message: 'the module loader does not expose _load' };
  }
  const originalLoad = loader._load;
  /**
   * The wrapper.
   *
   * WHY IT CANNOT CHANGE AN UNMATCHED MODULE: after the original load, the first
   * thing that happens is ONE `Map.get` against `state.targets`, which is null or
   * empty unless a spec with enabled items exists. Nothing else runs, and the
   * value returned is the exact object the original load returned.
   *
   * WHY IT CANNOT THROW INTO ELECTRON: the argument list is forwarded untouched,
   * `originalLoad` runs FIRST (so a genuine module-load error still propagates
   * exactly as before), and the patching half is inside `try`/`catch` whose fallback
   * is the untouched result.
   */
  const wrapper = function (request, parent, isMain) {
    const loaded = originalLoad.apply(this, arguments);
    try {
      const targets = state.targets;
      if (targets === null || targets.size === 0) return loaded;
      const bucket = targets.get(request);
      if (bucket === undefined) return loaded;
      applyBucket(state, bucket, loaded);
      return loaded;
    } catch (_error) {
      // Patching must never cost the application a module.
      return loaded;
    }
  };
  state.original = originalLoad;
  state.wrapper = wrapper;
  try {
    loader._load = wrapper;
  } catch (error) {
    state.original = null;
    state.wrapper = null;
    return {
      ok: false,
      code: PATCH_CODES.UNAVAILABLE,
      message: 'could not replace the module loader (' + messageOf(error) + ')',
    };
  }
  state.installed = true;
  return { ok: true };
}

/**
 * Remove the wrapper and forget the state.
 *
 * Used by tests, and available for a future "stop patching" path. PRODUCTION
 * NEVER CALLS IT: a reloaded bridge takes the hook over, and removing it would
 * strand patches that are already live inside modules the application keeps using
 * (the applied markers are what makes them revertible later).
 *
 * @param {{ loader?: any, stateHost?: any, stateSymbol?: symbol }} [input]
 * @returns {boolean} true when a wrapper was actually removed
 */
export function uninstallPatchHook(input) {
  const settings = isObject(input) ? input : {};
  const host = settings.stateHost === undefined ? globalThis : settings.stateHost;
  const symbol = settings.stateSymbol === undefined ? PATCH_STATE_SYMBOL : settings.stateSymbol;
  let state = null;
  try {
    state = host[symbol] === undefined ? null : host[symbol];
  } catch (_error) {
    return false;
  }
  if (isObject(state) !== true) return false;
  let removed = false;
  try {
    if (state.installed === true && typeof state.wrapper === 'function' && state.loader._load === state.wrapper) {
      // Undo every applied patch first: leaving mutations behind after the marker
      // is gone would make them permanent and unrecorded.
      for (const record of Array.from(state.applied.values())) {
        try {
          record.restore();
        } catch (_error) {
          // Nothing else to try; the state is about to be dropped anyway.
        }
      }
      state.loader._load = state.original;
      removed = true;
    }
  } catch (_error) {
    removed = false;
  }
  state.installed = false;
  state.wrapper = null;
  state.original = null;
  state.targets = null;
  state.applied.clear();
  state.failures.clear();
  state.owner = null;
  try {
    delete host[symbol];
  } catch (_error) {
    // A non-configurable definition keeps the tombstone; harmless.
  }
  return removed;
}

/**
 * Record one failure for an item, keeping only the bounded set a diagnostics
 * document may carry.
 *
 * @param {object} state
 * @param {object} item
 * @param {string} code
 * @param {string} message
 * @returns {string} the one-line reason, code included
 */
function recordFailure(state, item, code, message) {
  const text = code + ': patch ' + item.id + ' (' + item.target + '#' + item.symbol + '): ' + message;
  state.failures.set(item.id, { signature: signatureOf(item), code, message: text });
  return text;
}

/**
 * Mark this item id as applied to THIS exports object (both idempotence guards).
 *
 * @param {object} state
 * @param {string} itemId
 * @param {unknown} exports
 * @param {{ signature: string, original: unknown }} mark
 */
function setMark(state, itemId, exports, mark) {
  if (state.patched !== null) {
    try {
      state.patched.add(exports);
    } catch (_error) {
      // A primitive cannot be stored; the per-id marker still covers it.
    }
  }
  if (state.marks === null) return;
  try {
    let marks = state.marks.get(exports);
    if (marks === undefined) {
      marks = new Map();
      state.marks.set(exports, marks);
    }
    marks.set(itemId, mark);
  } catch (_error) {
    // Same reason as above: guards are best-effort, the marker is not.
  }
}

/**
 * @param {object} state
 * @param {string} itemId
 * @param {unknown} exports
 * @returns {Map<string, { signature: string, original: unknown }> | undefined}
 */
function marksFor(state, exports) {
  if (state.marks === null) return undefined;
  try {
    return state.marks.get(exports);
  } catch (_error) {
    return undefined;
  }
}

/**
 * Forget the per-object mark for one item (after a successful revert).
 *
 * @param {object} state
 * @param {string} itemId
 * @param {unknown} exports
 */
function clearMark(state, itemId, exports) {
  const marks = marksFor(state, exports);
  if (marks === undefined) return;
  try {
    marks.delete(itemId);
  } catch (_error) {
    // Best effort: a WeakMap-less realm already lost these.
  }
}

/**
 * Apply one item to an exports object that is already in memory.
 *
 * ORDER IS THE FAIL-SOFT GUARANTEE: everything that can throw (policy refusal,
 * source evaluation, the wrap factory, the not-a-function rail, the mutability
 * check) runs BEFORE the single assignment. A failed patch therefore leaves the
 * module exactly as it was — there is no half-applied state to undo.
 *
 * @param {object} state
 * @param {object} item
 * @param {unknown} exports
 * @param {'hook'|'cache'} via which path applied it
 * @returns {{ ok: true, reused?: boolean } | { ok: false, code: string, message: string }}
 */
function applyItem(state, item, exports, via) {
  // Policy refusals first: these need process context, not the document.
  if (state.selfFile !== null
    && (item.target === state.selfFile || matchesCachedId(item.target, state.selfFile))) {
    return {
      ok: false,
      code: PATCH_CODES.SELF_TARGET,
      message: 'the bridge must never patch its own artefact (self-target recursion)',
    };
  }
  if (BUILTIN_TEST(item.target) === true) {
    return {
      ok: false,
      code: PATCH_CODES.BUILTIN_TARGET,
      message: 'Node built-ins cannot be patch targets: replacing one would change every require in the process',
    };
  }
  if (exports === null || (typeof exports !== 'object' && typeof exports !== 'function')) {
    return {
      ok: false,
      code: PATCH_CODES.SYMBOL_MISSING,
      message: 'the module exports ' + (exports === null ? 'null' : typeof exports) + ', so there is no symbol to patch',
    };
  }

  // GUARD 2, checked FIRST: this exact item already lives on this exact exports
  // object. Re-registering the marker from the stored original is the honest
  // answer — the patch IS applied, and it is still revertible.
  const marks = marksFor(state, exports);
  const existing = marks === undefined ? undefined : marks.get(item.id);
  if (existing !== undefined && existing.signature === signatureOf(item)) {
    const original = existing.original;
    state.applied.set(item.id, {
      signature: existing.signature,
      via,
      exports,
      restore() {
        try {
          exports[item.symbol] = original;
        } finally {
          clearMark(state, item.id, exports);
        }
      },
    });
    return { ok: true, reused: true };
  }

  let present = false;
  try {
    present = item.symbol in exports;
  } catch (_error) {
    present = false;
  }
  if (present !== true) {
    return {
      ok: false,
      code: PATCH_CODES.SYMBOL_MISSING,
      message: 'the module has no export named ' + JSON.stringify(item.symbol),
    };
  }
  // READING THE ORIGINAL can throw too: a hostile exports object can carry a
  // throwing getter for the symbol. Read ONCE, here, inside the guard — so the
  // value every later step sees is already captured and no read happens after
  // anything was mutated.
  let original;
  try {
    original = exports[item.symbol];
  } catch (error) {
    return {
      ok: false,
      code: PATCH_CODES.APPLY_THREW,
      message: 'reading the original export threw (' + messageOf(error) + ')',
    };
  }

  let replacement;
  try {
    replacement = evaluateSource(item.source);
  } catch (error) {
    return {
      ok: false,
      code: PATCH_CODES.SOURCE_THREW,
      message: 'the source did not evaluate (' + messageOf(error) + ')',
    };
  }
  if (item.kind === 'wrap') {
    if (typeof replacement !== 'function') {
      return {
        ok: false,
        code: PATCH_CODES.NOT_FUNCTION,
        message: 'a wrap source must evaluate to a factory function, got ' + typeof replacement,
      };
    }
    if (typeof original !== 'function') {
      return {
        ok: false,
        code: PATCH_CODES.NOT_FUNCTION,
        message: 'the wrapped export is ' + typeof original + ', not a function',
      };
    }
    let wrapped;
    try {
      wrapped = replacement(original);
    } catch (error) {
      return {
        ok: false,
        code: PATCH_CODES.APPLY_THREW,
        message: 'the wrap factory threw (' + messageOf(error) + ')',
      };
    }
    // THE RAIL: a wrap may only produce a function. Replacing a function with
    // something else would break every caller that invokes it, so the patch is
    // refused instead of applied-and-hoped-for.
    if (typeof wrapped !== 'function') {
      return {
        ok: false,
        code: PATCH_CODES.NOT_FUNCTION,
        message: 'the wrap factory returned ' + typeof wrapped + ', not a function',
      };
    }
    replacement = wrapped;
  }

  const blocked = mutationBlockedBy(exports, item.symbol);
  if (blocked !== null) {
    // THE MEASURED ESM BOUNDARY: a namespace object is sealed and its symbols are
    // frozen at link time, so this is where an ESM target stops. A refusal, never
    // a silent no-op.
    return {
      ok: false,
      code: PATCH_CODES.FROZEN,
      message: blocked + ' (a sealed ESM namespace or a frozen CommonJS exports object cannot be patched in place)',
    };
  }

  try {
    exports[item.symbol] = replacement;
  } catch (error) {
    // Strict-mode assignment to a non-writable slot, or a throwing setter. The
    // value did not change, so there is nothing to roll back.
    return { ok: false, code: PATCH_CODES.APPLY_THREW, message: 'the assignment threw (' + messageOf(error) + ')' };
  }

  const signature = signatureOf(item);
  setMark(state, item.id, exports, { signature, original });
  state.applied.set(item.id, {
    signature,
    via,
    /** The exports object the patch was applied to — identity is what detects a reload. */
    exports,
    /**
     * `restore` is the WHOLE undo: writing the original value back into the same
     * object, and dropping the mark so the id can be applied again later. That is
     * why a patch on a mutable CommonJS export is genuinely revertible, while a
     * patch on a sealed one never existed.
     */
    restore() {
      try {
        exports[item.symbol] = original;
      } finally {
        clearMark(state, item.id, exports);
      }
    },
  });
  return { ok: true };
}

/**
 * Find the module for one item in `Module._cache`, if it is already loaded.
 *
 * ONE pass over the cache keys, only for items that still need work — the sync
 * skips this entirely when the spec has not changed — so the steady-state poll
 * cost is a `stat` of `patches.json`, not a walk of the module cache.
 *
 * @param {any} loader
 * @param {object} item
 * @param {string | null} selfFile
 * @returns {{ id: string, exports: unknown } | null}
 */
function cachedModuleFor(loader, item, selfFile) {
  let cache = null;
  try {
    cache = loader._cache;
  } catch (_error) {
    cache = null;
  }
  if (!isObject(cache)) return null;
  let keys;
  try {
    keys = Object.keys(cache);
  } catch (_error) {
    return null;
  }
  for (const id of keys) {
    if (matchesCachedId(item.target, id) !== true) continue;
    if (selfFile !== null && id === selfFile) continue; // strand two of the self-target guard
    const entry = cache[id];
    if (entry === null || typeof entry !== 'object') continue;
    return { id, exports: entry.exports };
  }
  return null;
}

/**
 * Apply the items for one request to the module the loader just returned.
 *
 * Called from the wrapper only, so it must stay total. The caller's `require()`
 * value is unchanged in IDENTITY because every patch mutates the exports object
 * in place — which is exactly what makes the patch reach code that already holds
 * the object.
 *
 * @param {object} state
 * @param {object[]} bucket items for this request
 * @param {unknown} loaded what the original loader returned
 */
function applyBucket(state, bucket, loaded) {
  for (const item of bucket) {
    const signature = signatureOf(item);
    const applied = state.applied.get(item.id);
    if (applied !== undefined && applied.signature === signature && applied.exports === loaded) continue;
    const failure = state.failures.get(item.id);
    // Same broken bytes for this item: do not re-evaluate the source on every load.
    if (failure !== undefined && failure.signature === signature) continue;
    if (applied !== undefined && applied.exports !== loaded) {
      // A reload produced a NEW exports object: the old marker no longer describes
      // reality. Try to undo the old one (best effort — the old object may be dead).
      try {
        applied.restore();
      } catch (_error) {
        // Nothing else to do with a dead object.
      }
      state.applied.delete(item.id);
    }
    const result = applyItem(state, item, loaded, 'hook');
    if (result.ok !== true) recordFailure(state, item, result.code, result.message);
  }
}

/**
 * How many of the LIVE patches were applied by cache replay at install time.
 *
 * A DECAYING COUNT on purpose: it answers "did boot replay reach this", not
 * "how many replays ever happened". A patch applied through the hook is not a
 * replay, so the number can only shrink as items are reverted.
 *
 * @param {object} state
 * @returns {number}
 */
function replayedCount(state) {
  let count = 0;
  for (const record of state.applied.values()) if (record.via === 'cache') count += 1;
  return count;
}

/**
 * Bring the live process in line with one spec.
 *
 * ORDER IS DELIBERATE: revert first (so a changed item is re-applied on top of
 * the original rather than on top of itself), then forget failures that no longer
 * describe the spec, then refresh the request map, then apply what can be applied
 * now — cache replay first, so a module loaded before the hook existed is not
 * silently skipped.
 *
 * @param {object} state
 * @param {{ protocol: number, rev: number, items: object[] }} spec
 * @param {{ loader: any }} context
 * @returns {{ applied: number, replayed: number, missed: number, failed: number,
 *             lastError: string | null, rev: number, changed: boolean,
 *             hookInstalled: boolean, targetCount: number }}
 */
export function syncSpec(state, spec, context) {
  const items = Array.isArray(spec.items) ? spec.items : [];
  const loader = context.loader;
  let lastError = null;
  let changed = false;

  /** @param {string|null} text */
  const fail = (text) => {
    if (text !== null) lastError = String(text).slice(0, PATCH_LIMITS.lastErrorLength);
  };

  const byId = new Map();
  for (const item of items) byId.set(item.id, item);

  // ---- 1. revert what the spec no longer wants ---------------------------------
  for (const [id, record] of Array.from(state.applied.entries())) {
    const item = byId.get(id);
    if (item !== undefined && item.enabled === true && record.signature === signatureOf(item)) continue; // unchanged: no work
    let reverted = true;
    try {
      record.restore();
    } catch (error) {
      reverted = false;
      // Honest outcome: the patch stays live inside that module, this module stops
      // tracking it (there is no second way into a frozen object), and the failure
      // is STICKY so a later tick cannot pretend it was cleaned up.
      const text = PATCH_CODES.REVERT_FAILED + ': patch ' + id
        + ' stays live in the process, it could not be undone (' + messageOf(error) + ')';
      fail(text);
      state.failures.set(id, { signature: 'sticky-revert-failed', code: PATCH_CODES.REVERT_FAILED, message: text });
    }
    state.applied.delete(id);
    if (reverted === true) changed = true;
  }

  // ---- 2. forget failures that no longer describe the spec --------------------
  for (const [id, failure] of Array.from(state.failures.entries())) {
    if (failure.code === PATCH_CODES.REVERT_FAILED) continue; // sticky by design
    if (id.startsWith('rejected#')) continue; // rebuilt by the controller on each sync
    const item = byId.get(id);
    if (item === undefined || item.enabled !== true) {
      state.failures.delete(id); // removed or disabled: allow a fresh attempt later
      continue;
    }
    if (failure.signature === signatureOf(item)) continue; // same broken bytes: do not spin
    state.failures.delete(id); // edited: retry
    changed = true;
  }

  // ---- 3. refresh the request map BEFORE applying -----------------------------
  const targets = new Map();
  for (const item of items) {
    if (item.enabled !== true) continue;
    const existing = targets.get(item.target);
    if (existing === undefined) targets.set(item.target, [item]);
    else existing.push(item);
  }
  const wasEmpty = state.targets === null || state.targets.size === 0;
  state.targets = targets;

  // ---- 4. install the hook only when something wants to be patched ------------
  const installed = targets.size === 0 ? { ok: true } : installHook(state);
  if (installed.ok !== true) {
    fail(PATCH_CODES.UNAVAILABLE + ': ' + String(installed.message));
    return {
      applied: state.applied.size,
      replayed: replayedCount(state),
      missed: 0,
      failed: state.failures.size,
      lastError,
      rev: spec.rev,
      changed: changed || wasEmpty !== (targets.size === 0),
      hookInstalled: false,
      targetCount: targets.size,
    };
  }
  if (targets.size === 0 && wasEmpty === false) changed = true;

  // ---- 5. apply what is pending ----------------------------------------------
  let missed = 0;
  for (const item of items) {
    if (item.enabled !== true) continue;
    const signature = signatureOf(item);
    // A POLICY REFUSAL is not a "missed" target: the module may load perfectly
    // well and would still be refused, so it is reported now rather than waiting
    // for a load that could never succeed. Both checks are the same ones
    // `applyItem` makes; they are repeated here because a target that is not
    // cached has no exports object to fail on yet.
    if (state.selfFile !== null
      && (item.target === state.selfFile || matchesCachedId(item.target, state.selfFile))) {
      const text = recordFailure(state, item, PATCH_CODES.SELF_TARGET,
        'the bridge must never patch its own artefact (self-target recursion)');
      fail(text);
      changed = true;
      continue;
    }
    if (BUILTIN_TEST(item.target) === true) {
      const text = recordFailure(state, item, PATCH_CODES.BUILTIN_TARGET,
        'Node built-ins cannot be patch targets: replacing one would change every require in the process');
      fail(text);
      changed = true;
      continue;
    }
    const applied = state.applied.get(item.id);
    if (applied !== undefined) {
      if (applied.signature === signature) {
        // Already marked. If the cache now holds a DIFFERENT exports object, the
        // marker is stale (a reload happened without a load through the hook);
        // re-apply so the marker describes reality.
        const cached = cachedModuleFor(loader, item, state.selfFile);
        if (cached === null || cached.exports === applied.exports) continue;
      }
      try {
        applied.restore();
      } catch (_error) {
        // The old object is unreachable from here anyway.
      }
      state.applied.delete(item.id);
    }
    const failure = state.failures.get(item.id);
    if (failure !== undefined && failure.signature === signature) continue; // no spin

    const cached = cachedModuleFor(loader, item, state.selfFile);
    if (cached === null) {
      // Not an error: the module simply has not been loaded yet, so the hook will
      // apply it at load time. Counted as `missed` so a support report can answer
      // "did boot replay find it".
      missed += 1;
      continue;
    }
    const result = applyItem(state, item, cached.exports, 'cache');
    if (result.ok === true) {
      changed = true;
      continue;
    }
    const text = recordFailure(state, item, result.code, result.message);
    fail(text);
    changed = true;
  }

  return {
    applied: state.applied.size,
    replayed: replayedCount(state),
    missed,
    failed: state.failures.size,
    lastError,
    rev: spec.rev,
    changed,
    hookInstalled: state.installed === true,
    targetCount: targets.size,
  };
}

/**
 * Read `patches.json` from the state directory, never throwing.
 *
 * The ladder (missing / not-a-file / oversize / error) is the SAME one the menu
 * and notification channels walk — borrowed, not re-implemented — so a document
 * that is too big for this module is reported in wording a support report already
 * understands.
 *
 * @param {string | null} stateDir
 * @returns {{ kind: string, text: string | null, fingerprint: string, error: string | null }}
 */
function readSpecFile(stateDir) {
  if (stateDir === null) {
    return { kind: 'missing', text: null, fingerprint: 'no-state-dir', error: null };
  }
  try {
    return readContributionSource(stateDir + '/' + FILES.patches, {
      maxBytes: PATCH_LIMITS.documentBytes,
      label: 'patches.json',
    });
  } catch (error) {
    return { kind: 'error', text: null, fingerprint: 'read-error:' + messageOf(error), error: messageOf(error) };
  }
}

/**
 * Create the patch controller: the object the kernel polls and reports.
 *
 * `poll()` is TOTAL (it never throws into the tray tick). `status()` returns the
 * bounded block that `bridge.json` and `status().patches` both carry.
 *
 * @param {{
 *   stateDir?: string | null,
 *   selfFile?: string | null,
 *   loader?: any,
 *   stateHost?: any,
 *   stateSymbol?: symbol,
 *   onChange?: (() => void) | null,
 * }} [input]
 * @returns {{
 *   poll: () => object,
 *   syncNow: (text: string | null, revOverride?: number) => object,
 *   status: () => object,
 *   dispose: () => void,
 * }}
 */
export function createPatchController(input) {
  const settings = isObject(input) ? input : {};
  const stateDir = typeof settings.stateDir === 'string' && settings.stateDir !== '' ? settings.stateDir : null;
  const loader = settings.loader === undefined ? DEFAULT_LOADER : settings.loader;
  const stateHost = settings.stateHost === undefined ? globalThis : settings.stateHost;
  const stateSymbol = settings.stateSymbol === undefined ? PATCH_STATE_SYMBOL : settings.stateSymbol;
  const onChange = typeof settings.onChange === 'function' ? settings.onChange : null;

  const state = hookStateOf({ loader, stateHost, stateSymbol });
  if (typeof settings.selfFile === 'string' && settings.selfFile !== '') state.selfFile = settings.selfFile;
  state.owner = settings;

  const block = {
    /**
     * `available` answers "can this bridge apply patches at all". At construction
     * that is exactly "there is a state directory" — the `_load` wrapper is
     * installed LAZILY, the first time a spec with enabled items is synced, so a
     * bridge with no `patches.json` still has a WORKING patch channel (it will
     * apply one the moment somebody writes the file). Reporting `false` here would
     * make "no spec yet" look like "this build cannot patch", which is the one
     * distinction the block exists to preserve.
     */
    available: stateDir !== null,
    applied: 0,
    replayed: 0,
    missed: 0,
    failed: 0,
    lastError: stateDir === null
      ? PATCH_CODES.NO_STATE_DIR + ': no state directory, so no patches.json and no hook'
      : null,
    rev: 0,
  };

  /** Identity of the last document acted on: identical text is an identical spec. */
  let remembered = undefined;
  /** Last good sync facts, so `available` and refusal paths stay consistent. */
  let lastTargetCount = 0;
  let lastHookInstalled = false;
  let disposed = false;

  /**
   * One sync from raw text. Exposed as `syncNow`, so tests (and a future
   * "apply immediately" path) can drive the state machine without waiting for a
   * poll tick or writing a file first.
   *
   * @param {string | null} text
   * @param {number} [revOverride] used only when the document cannot be parsed
   * @returns {object} the block after the sync
   */
  function syncNow(text, revOverride) {
    const parsed = parsePatchSpec(text);
    if (parsed.ok !== true) {
      // A document that is not the contract is refused WHOLE and the previous
      // spec stays in force: failing to understand a file is not a reason to
      // silently switch off patches that are already live.
      block.lastError = String(parsed.error).slice(0, PATCH_LIMITS.lastErrorLength);
      if (typeof revOverride === 'number' && Number.isFinite(revOverride)) block.rev = Math.floor(revOverride);
      block.available = stateDir !== null && (lastTargetCount === 0 || lastHookInstalled);
      return { ...block };
    }

    const result = syncSpec(state, parsed.spec, { loader });
    lastTargetCount = result.targetCount;
    lastHookInstalled = result.hookInstalled;

    // Structural rejections are recorded WITHOUT evicting anything they do not
    // name: the rest of the document still applies, and the item that could not be
    // parsed is not silently absent from the report.
    for (const rejection of parsed.rejected) {
      const key = 'rejected#' + rejection.index;
      state.failures.set(key, {
        signature: key,
        code: rejection.code,
        message: PATCH_CODES.ITEM + ': ' + rejection.message,
      });
    }

    block.applied = result.applied;
    block.replayed = result.replayed;
    block.missed = result.missed;
    // `failed` counts what is being REMEMBERED, so it is bounded by the item cap
    // instead of growing every tick.
    block.failed = Math.min(PATCH_LIMITS.items, state.failures.size);
    block.rev = result.rev;

    let lastError = result.lastError;
    if (parsed.rejected.length > 0) {
      const first = parsed.rejected[0];
      const more = parsed.rejected.length > 1 ? ' (and ' + (parsed.rejected.length - 1) + ' more)' : '';
      if (lastError === null) lastError = PATCH_CODES.ITEM + ': ' + first.message + more;
    }
    block.lastError = lastError === null ? null : String(lastError).slice(0, PATCH_LIMITS.lastErrorLength);
    // `available` answers "can this bridge apply patches right now": there is a
    // state directory, and either nothing needs the hook or the hook is installed.
    block.available = stateDir !== null && (result.targetCount === 0 || result.hookInstalled === true);
    if (result.changed === true && onChange !== null) onChange();
    return { ...block };
  }

  return {
    /**
     * Poll tick: read the file (one `stat` when it is unchanged) and sync on change.
     *
     * @returns {object} the block
     */
    poll() {
      if (disposed) return { ...block };
      try {
        const source = readSpecFile(stateDir);
        if (source.kind === 'missing') {
          if (remembered !== 'missing') {
            remembered = 'missing';
            // An absent document is the honest "nothing to do": every applied patch
            // is reverted, the hook stays installed (harmless, and a reload would
            // otherwise lose the markers), and nothing is reported as failed.
            syncNow(null);
          }
          return { ...block };
        }
        if (source.kind !== 'text') {
          const text = source.error === null ? 'patches.json is unreadable' : source.error;
          if (remembered !== 'error:' + text) {
            remembered = 'error:' + text;
            block.lastError = String(PATCH_CODES.OVERSIZE + ': ' + text).slice(0, PATCH_LIMITS.lastErrorLength);
            if (onChange !== null) onChange();
          }
          return { ...block };
        }
        if (remembered === source.fingerprint) return { ...block };
        remembered = source.fingerprint;
        return syncNow(source.text);
      } catch (error) {
        // A poll tick may never throw: it runs inside the tray's interval.
        block.lastError = ('patches.json poll failed: ' + messageOf(error)).slice(0, PATCH_LIMITS.lastErrorLength);
        return { ...block };
      }
    },

    syncNow,

    /**
     * @returns {{ available: boolean, applied: number, replayed: number,
     *             missed: number, failed: number, lastError: string|null, rev: number }}
     */
    status() {
      return { ...block };
    },

    /**
     * Stop polling. The HOOK STAYS INSTALLED on purpose: a reloaded bridge takes
     * it over (see {@link PATCH_STATE_SYMBOL}), and tearing it down would strand
     * patches that are already live inside modules the application is using.
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      if (state.owner === settings) state.owner = null;
    },
  };
}

/**
 * The `patches` block of an INERT bridge (no usable environment at all).
 *
 * Same shape-parity rule as `INERT_NOTIFY` / `INERT_CHANNEL` in the kernel: a
 * diagnostics page must not have to branch on "is this bridge inert" before
 * reading `status().patches.applied`.
 */
export const INERT_PATCHES = Object.freeze({
  available: false,
  applied: 0,
  replayed: 0,
  missed: 0,
  failed: 0,
  lastError: 'bridge is inert',
  rev: 0,
});
