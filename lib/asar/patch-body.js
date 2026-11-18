/**
 * The patch body — the bytes that replace the 1,253-byte DesktopTray slot inside
 * `lib/main.js`.
 *
 * Hard constraints (see design/PHASE1-SPEC.md §4.4):
 *  - the produced region MUST be exactly `regionLength` bytes;
 *  - it keeps the two region markers, the `var DesktopTray = class` identity and
 *    the constructor / relabel / dispose contract the shell relies on;
 *  - it may only use tokens that already exist in the stock main.js scope
 *    (`createRequire`, `resolve`, `process`, `Tray`, `Menu`, `nativeImage`,
 *    `import.meta.url`), never a new import;
 *  - any bridge failure falls back to the three official menu entries, so the
 *    user can never lose the tray.
 */

import {
  CHANNEL_ENVELOPE_MAX_BYTES,
  CHANNEL_MAX_BYTES,
  CHANNEL_NAME_PATTERN,
  CHANNEL_NAMES,
  CHANNEL_NOTIFY_BODY_MAX,
  CHANNEL_NOTIFY_TITLE_MAX,
  CHANNEL_PAYLOAD_MAX_BYTES,
  FILES,
  PROTOCOLS,
  SPLIT_PATCH_MARKER,
  SPLIT_START_MARKER,
  STATE_DIR_NAME,
} from '../wire/constants.js';

/**
 * The window capability's contract, imported rather than restated.
 *
 * `lib/bridge/src/windows.js` is a pure module (no `electron`, no fs, no state),
 * and it owns the ONE definition of what a window spec may contain — including
 * the security rule below. The region ships its SOURCE TEXT (see
 * {@link ROUTE_RULE_SHIPPED}) instead of a second hand-typed copy, so the
 * imperative half in `lib/main.js` and the declarative half in the bridge can
 * never disagree about "what is a legal window".
 */
import {
  MAX_WINDOW_SPECS,
  WINDOW_SPEC_CODES,
  WINDOW_SPEC_INTERNALS,
  WINDOW_SPEC_LIMITS,
  isSameOriginRoute,
  validateWindowSpec,
} from '../bridge/src/windows.js';

export const PATCH_MARKER = '/* dsh-asar-bridge-slot v0.1.0 */';

export const REGION_START_MARKER = '//#region lib/types/tray.js';
export const REGION_END_MARKER = '//#endregion';

/**
 * The delegating DesktopTray implementation, without the region markers.
 * Written with tabs to stay a compact, readable string of bytes.
 */
export const PATCH_BODY = `/* dsh-asar-bridge-slot v0.1.0 */
var DesktopTray = class {
	options;
	tray;
	bridge;
	constructor(options) {
		this.options = options;
		const tray = new Tray(nativeImage.createFromPath(options.iconPath));
		this.tray = tray;
		tray.on("click", () => {
			options.open();
		});
		this.relabel();
	}
	relabel() {
		const tray = this.tray;
		if (tray === undefined) return;
		const messages = this.options.locale().messages;
		try {
			if (this.bridge === undefined) {
				const require = createRequire(import.meta.url);
				this.bridge = require(resolve(process.resourcesPath, "app.asar.unpacked", "dsh", "tray-bridge.js")).createBridge({ app, Tray, Menu, nativeImage, tray, options: this.options });
			}
			this.bridge.relabel(messages);
			return;
		} catch (error) {
			this.bridge = undefined;
		}
		tray.setToolTip(messages.aboutProduct);
		tray.setContextMenu(Menu.buildFromTemplate([
			{ label: messages.openApplication, click: () => { this.options.open(); } },
			{ type: "separator" },
			{ label: messages.quitApplication, click: () => { this.options.quit(); } }
		]));
	}
	dispose() {
		const tray = this.tray;
		this.tray = undefined;
		tray?.destroy();
	}
};`;

/**
 * Build the patched region of exactly `regionLength` bytes.
 *
 * Layout: start marker, newline, body, padding spaces, end marker.
 * Padding sits *before* the end marker so the region keeps ending with
 * `//#endregion`, which the installer verifies on read-back.
 *
 * @param {number} regionLength exact byte length the caller needs
 * @returns {Buffer} the region bytes
 */
export function buildPatchedRegion(regionLength) {
  const start = Buffer.from(REGION_START_MARKER + '\n', 'utf8');
  const body = Buffer.from(PATCH_BODY, 'utf8');
  const end = Buffer.from('\n' + REGION_END_MARKER, 'utf8');
  const fixed = start.length + body.length + end.length;
  const padding = regionLength - fixed;
  if (padding < 0) {
    throw new Error(
      `patch body does not fit: needs ${fixed} bytes, region is ${regionLength} (overflow ${-padding})`,
    );
  }
  const pad = Buffer.alloc(padding, 0x20);
  return Buffer.concat([start, body, pad, end]);
}

/** Body bytes alone, excluding markers and padding (for diagnostics/tests). */
export const PATCH_BODY_BYTES = Buffer.from(PATCH_BODY, 'utf8').length;

/** Smallest region this body can fit into. */
export const MINIMUM_REGION_LENGTH = PATCH_BODY_BYTES + 1 + REGION_START_MARKER.length + 1 + REGION_END_MARKER.length;

/* ------------------------------------------------------------------------- *
 * Host-event guard (v0.2.0): the SECOND block inside our own region
 *
 * WHY A GUARD AND NOT A FEATURE
 * `lib/main.js` validates every Host→main IPC message with one closed function,
 * `function isDesktopHostEvent(message)` — in-file byte 410,577 on rc.3, 2,847 B,
 * digest `17f077c0fbe34fcb…` — called from exactly ONE place, the
 * `child.on("message", …)` handler at in-file byte 418,152. Both numbers were
 * measured, not recalled (`evidence/ipc-extend-proto.mjs`, 91/91).
 *
 * That function is a top-level `function` declaration in an ES module, so its
 * binding is MUTABLE: a later assignment to the same name replaces it for that
 * one call site, which cannot run before module evaluation ends (the Host child
 * is spawned from `main()`, registered on `app.whenReady()`). A later `function`
 * DECLARATION would not do — `SyntaxError` in an ES module, retroactive
 * hoisting in sloppy script mode. So: capture, then reassign, inside a `try`
 * that degrades instead of failing.
 *
 * WHAT IT DOES TODAY: ACCEPT EVERYTHING OF OUR TYPE, THEN DECIDE INSIDE.
 * The reserved type is not merely reserved any more: a message of that type is
 * answered `true` — main's ladder moves past the `this.fail() + child.kill(`
 * `"SIGTERM")` branch — NO MATTER what else the message carries. The classifier
 * still runs the official validator first and still refuses exactly what stock
 * would refuse for OFFICIAL types (and what a `requestId` on a foreign type would
 * forge), so stock behaviour is untouched. For OUR type there is no refusal
 * branch left:
 *
 *   - a forged `requestId` / `error`   -> accepted, DECLINED inside, recorded;
 *   - a `channel` that is not a name   -> accepted, DECLINED inside, recorded;
 *   - a payload past {@link CHANNEL_PAYLOAD_MAX_BYTES} -> accepted, DECLINED;
 *   - a channel name the region does not serve -> accepted, a `declined` line.
 *
 * WHY: REFUSING OUR OWN TYPE IS THE ONE OUTCOME THAT MUST NEVER HAPPEN.
 * `false` means "the official validator rejected this message", and main responds
 * by failing the desktop Host process and killing the Host child — i.e. by ending
 * the user's DSH session. Every one of the four inputs above is reachable from a
 * typo in a plugin, not from an attack, and none of them is worth a lost session.
 * "Accepted but dropped" is ALWAYS the safer failure: it costs one bounded disk
 * line, and it keeps the child alive. The three guards survive as FILTERS that
 * make the handler decline — the answer stays `true` either way.
 *
 * WHY ACCEPTING IS SAFE NOW, WHEN IT WAS NOT BEFORE
 * Accepting a message the official ladder does not branch on used to mean it fell
 * into the control-response `else`, where a live `requestId` could resolve an
 * unrelated pending request. That hole is closed by construction: an accepted
 * message of OUR type never reaches the ladder (our handler is the only consumer
 * of it — the ladder has no branch for `dsh-asar-bridge`), and a FOREIGN type
 * carrying `requestId` is still rejected exactly as stock would reject it.
 *
 * THREE LIMITS OF THIS SHAPE (measured; keep them next to the string they
 * constrain, not in a document nobody reads before editing it):
 *   1. `accept` MEANS "run the handler", never "refused". The handler answers
 *      `true` unconditionally, so there is no path from an accepted message to
 *      `false` — the property this whole section exists for.
 *   2. the wrapper is a free function, so it has NO `this`: it cannot reach
 *      `this.runId`, `this.readyResolve`, `this.controlRequests`, `this.stopping`,
 *      and it cannot call `child.send`. It cannot talk back over IPC at all — see
 *      why the handler answers by FILE.
 *   3. it must never let a `requestId` / `error` message through to the official
 *      control-response branch (see {@link classifyHostEvent}).
 * ------------------------------------------------------------------------- */

/**
 * The IPC message type this region accepts.
 *
 * A `dsh-asar-bridge` message is a stateless request/ack envelope: it needs no
 * instance state on either side, which is what makes it the ONE type this shape
 * can carry (limit 2). Nothing in the official `lib/main.js` sends it; the Host
 * process does (`lib/host/service.js` `channelSend`, via `process.send`), and the
 * bridge reaches it through the FILE channel instead. The value is DEFINED in
 * `lib/wire/constants.js` and only re-exported here, so the sender and the
 * validator can never disagree about the spelling.
 */
export {
  RESERVED_HOST_EVENT_TYPE,
  // Re-exported, not redeclared: the same "one definition" rule.
} from '../wire/constants.js';

// The LOCAL binding the functions below close over. A `export { … } from` is a
// re-export only — it creates no binding in this module's scope — so the body
// still needs its own name. `import` + `export` is what keeps ONE definition.
import { RESERVED_HOST_EVENT_TYPE } from '../wire/constants.js';

/**
 * The compiled form of {@link CHANNEL_NAME_PATTERN}.
 *
 * The pattern lives in `lib/wire/constants.js` as a STRING because the region
 * cannot import it; this module compiles it once, and the shipped text gets the
 * same expression (via {@link inlineChannelConstants}) so the tested regex and
 * the shipped regex come from one place.
 */
export const CHANNEL_NAME_REGEX = new RegExp(CHANNEL_NAME_PATTERN);

/**
 * The regex literal the shipped classifier carries.
 *
 * Built from the SAME pattern string the tested regex compiles, so "the shape of
 * a channel name" is defined once (in `lib/wire/constants.js`) and reaches the
 * region as source text rather than as a second hand-typed literal.
 */
export const CHANNEL_NAME_REGEX_SOURCE = '/' + CHANNEL_NAME_PATTERN + '/';

/** Protocol number inside the envelope the handler writes (see `PROTOCOLS.channel`). */
export const CHANNEL_PROTOCOL = PROTOCOLS.channel;

/**
 * The channel's ACK file, re-exported from `lib/wire/constants.js` `FILES` (which
 * `lib/bridge/src/paths.js` mirrors) so the region, the bridge and the Host all
 * name the same file. The region cannot import anything, so its copy is source
 * text spliced in by {@link inlineChannelConstants}.
 *
 * There is no `channel.in` counterpart: the REQUEST direction is real IPC
 * (`asarShell.channelSend` → `process.send`), and the file queue that used to
 * mirror it had no writer and no reader in production (audit 2026-11-16, item 8).
 */
export const CHANNEL_OUT_FILE = FILES.channelOut;
export const CHANNEL_OUT_ROTATED = FILES.channelOutRotated;

/** The frozen channel vocabulary as object-literal SOURCE text (for the region). */
export const CHANNEL_NAMES_SOURCE =
  '{ ' +
  Object.entries(CHANNEL_NAMES)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(', ') +
  ' }';

/**
 * The window contract's bounds as object-literal SOURCE text (for the region).
 *
 * Derived, not typed twice: a range that changed in `lib/bridge/src/windows.js`
 * reaches the shipped validator automatically, so "the region accepts what the
 * contract accepts" is a property of the build rather than of a reviewer.
 */
export const WINDOW_SPEC_LIMITS_SOURCE = JSON.stringify(WINDOW_SPEC_LIMITS);

/** The window contract's refusal codes, as object-literal SOURCE text. */
export const WINDOW_SPEC_CODES_SOURCE = JSON.stringify(WINDOW_SPEC_CODES);

/**
 * The region's own decline codes.
 *
 * Declared HERE, near the top, because the shipped block is built from a template
 * literal at MODULE LOAD time: everything the block interpolates has to be
 * initialised before it. A later `const` would be in its temporal dead zone when
 * `CHANNEL_HANDLER_BLOCK` is evaluated, and importing this module would throw.
 */
export const CHANNEL_DECLINE_CODES = Object.freeze({
  /** The message carried `requestId` / `error`: it looks like a control reply. */
  ECONTROL_LOOKALIKE: 'E_CONTROL',
  /** `channel` is not a string matching {@link CHANNEL_NAME_PATTERN}. */
  EINVALID_CHANNEL: 'E_CHANNEL',
  /** The serialised payload is past {@link CHANNEL_PAYLOAD_MAX_BYTES}. */
  EPAYLOAD_TOO_LARGE: 'E_PAYLOAD',
  /** A well-formed name outside the vocabulary (not state/ping/notify/window). */
  EUNKNOWN_CHANNEL: 'E_UNKNOWN',
  /** The Electron provider this channel needs is not in the region's scope. */
  EPROVIDER_ABSENT: 'E_PROVIDER',
  /** The provider refused to construct (a native callback threw, or no instance). */
  ECONSTRUCT_FAILED: 'E_CONSTRUCT',
  /** `show()` / `loadURL()` threw after the object already existed. */
  ELOAD_FAILED: 'E_LOAD',
  /** A `notify` payload is not `{title, body?, silent?}` within its caps. */
  EINVALID_TOAST: 'E_TOAST',
  /** `window`: this `id` already owns a live window. */
  EDUPLICATE_ID: 'E_DUP',
  /** `window`: {@link MAX_WINDOW_SPECS} live windows already exist. */
  ELIMIT: 'E_LIMIT',
  /** `window`: no registry was supplied — a builder bug, reported not thrown. */
  EREGISTRY: 'E_REGISTRY',
});

/** The region's own decline codes, as object-literal SOURCE text. */
export const CHANNEL_DECLINE_CODES_SOURCE = JSON.stringify(CHANNEL_DECLINE_CODES);

/**
 * UTF-8 byte length of a string, without depending on `Buffer`.
 *
 * The classifier runs inside the split region, where `Buffer` happens to be a
 * global in Electron's main process but is NOT a name the official `lib/main.js`
 * guarantees — and the dependency list is a contract (`lib/host/compat.js`
 * checks it against the real file). Counting the three UTF-8 width classes by
 * hand is the version that needs no name at all.
 *
 * Surrogate pairs count as 4 bytes (a pair is one 4-byte code point); every
 * other character counts by its own class. Lone surrogates are counted as 3,
 * which is what `JSON.stringify` would have produced anyway.
 *
 * @param {string} text
 * @returns {number}
 */
function byteLengthOf(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * The shipped form of {@link byteLengthOf}.
 *
 * Derived from the tested function rather than typed twice: the region counts
 * UTF-8 bytes exactly the way the closed-region test does, and a change to one is
 * a change to both. It is COMPACTED like every other shipped function — the
 * explanatory prose belongs in this file, not in the archived bytes.
 */
export const BYTE_LENGTH_SHIPPED = compactJsSource(byteLengthOf.toString());


/**
 * The wrapper's ENTIRE decision logic, as a pure function.
 *
 * This is the single source of truth: {@link HOST_EVENT_CLASSIFIER_SOURCE} is
 * this function's own source text, and the shipped region embeds exactly that
 * text. The tests run the same decision table against the exported function and
 * against the copy they extract out of the built region bytes, so the shipped
 * bytes and the tested logic cannot drift.
 *
 * THE ONE RULE THAT MATTERS MOST
 * Every malformed or hostile message of OUR type is answered `true`. Refusing our
 * own type is the one outcome that must never happen here: `false` is the value
 * main's `child.on("message")` reads as "the official validator rejected this",
 * and it responds by calling `this.fail()` and `child.kill("SIGTERM")` on the
 * Host child — i.e. it ends the user's whole DSH session. "Accepted but dropped"
 * is always the safer failure, so the region accepts ANY message that claims our
 * type and lets the handler decide what (if anything) it does with it.
 *
 * `false` is therefore reserved for exactly what the OFFICIAL validator would
 * have rejected for OFFICIAL types — nothing about stock behaviour moves (the
 * stock-parity corpus in `test/split-surgery.test.mjs` pins that).
 *
 * Decision table, in order:
 *   1. not an object / no `type` key                        -> `delegate`
 *      (the official validator owns every malformed answer);
 *   2. `type` is NOT ours, `requestId`/`error` present, and the official
 *      validator does NOT accept it                        -> `reject`
 *      (anti-forgery; this is exactly stock behaviour, because stock would
 *      have rejected the message for the same reason);
 *   3. `type` is ours, whatever else the message carries   -> `accept`
 *      THE FIX. A forged `requestId`, a blob of a `channel`, a payload past the
 *      cap: all accepted, all handed to the handler, which DECLINES them and
 *      records the decline. None of them can kill the Host any more.
 *   4. anything else                                        -> `delegate`
 *
 * WHY THE HANDLER AND NOT THIS FUNCTION DECLINES
 * `accept` has to mean "main must not kill the child", which is a different
 * statement from "this message did something". The three filters (no
 * `requestId`/`error`, channel-name shape, payload cap) are therefore applied by
 * the handler as DECLINE conditions — the message is dropped and one bounded
 * `declined` envelope is appended, and the answer is still `true`.
 *
 * WHY BRANCH 2 KEEPS `official !== true`, MEASURED: three official types
 * (`update-tasks`, `file-drag-resource`, `quit-inspection`) carry `requestId` BY
 * DESIGN — the validator REQUIRES it for them — and their replies land in the
 * official control-response `else`. Rejecting every `requestId` outright would
 * make main kill the Host child of a healthy app on every update-task
 * inspection, quit inspection and file-drag reply.
 *
 * Never throws: a hostile input (a throwing Proxy, a getter that throws) that
 * cannot even be inspected degrades to `delegate`, and an input we can tell is
 * ours degrades to `accept` — the answer that keeps the child alive.
 *
 * @param {unknown} message the IPC message main received
 * @param {boolean} official what `isDesktopHostEvent` answered for it
 * @returns {'delegate'|'reject'|'accept'}
 */
export function classifyHostEvent(message, official) {
  try {
    if (typeof message !== 'object' || message === null || !('type' in message)) return 'delegate';
    if (message.type !== RESERVED_HOST_EVENT_TYPE) {
      if ((message.requestId !== void 0 || message.error !== void 0) && official !== true) return 'reject';
      return 'delegate';
    }
    // Our type: accepted unconditionally. Everything else about the message is
    // the handler's business, and none of it may cost the user his session.
    return 'accept';
  } catch (error) {
    // A message we cannot inspect is only treated as ours when that can be said
    // safely; a hostile Proxy else stays with the official validator.
    try {
      return message !== null && typeof message === 'object' && message.type === RESERVED_HOST_EVENT_TYPE
        ? 'accept'
        : 'delegate';
    } catch (_secondFailure) {
      return 'delegate';
    }
  }
}

/**
 * This function's own source text — the bytes the region embeds.
 *
 * Derived with `Function.prototype.toString()` rather than written twice: a
 * reformat of {@link classifyHostEvent} changes the shipped region automatically,
 * so there is no second copy that could disagree with the tested one.
 */
export const HOST_EVENT_CLASSIFIER_SOURCE = classifyHostEvent.toString();

/**
 * Module names the shipped region carries under its OWN private bindings.
 *
 * WHY RENAME AT ALL
 * The shipped functions call each other by their module names
 * (`resolveChannelStateDir`, `validateWindowSpec`, …). Inside the region those
 * bindings do not exist; only `__channelStateDir` / `__validateWindowSpec` do. The
 * rename is a pure identifier substitution over the compacted source, so the
 * shipped function is still the tested function — one identifier away from it,
 * and the shipped-source tests run the extracted text end to end, which is what
 * proves the substitution is complete.
 *
 * WORD BOUNDARIES, NOT `split`/`join`: `fail` is a substring of `'failed'`, and a
 * blind replace would rewrite an Electron event name into a broken identifier.
 * `\b` makes the substitution an identifier substitution.
 */
export const SHIPPED_NAME_SUBSTITUTIONS = Object.freeze([
  ['resolveChannelStateDir', '__channelStateDir'],
  ['writeChannelLineAtomic', '__channelWrite'],
  ['writeChannelAck', '__writeAck'],
  ['channelElectron', '__channelElectron'],
  ['handleNotifyMessage', '__handleNotify'],
  ['handleWindowMessage', '__handleWindow'],
  ['handleChannelMessage', '__channelHandle'],
  ['channelAppOrigin', '__appOrigin'],
  ['isSameOriginRoute', '__isSameOriginRoute'],
  ['validateWindowSpec', '__validateWindowSpec'],
  ['CHANNEL_NAMES', '__channelNames'],
  ['CHANNEL_DECLINE_CODES', '__decline'],
  ['WINDOW_SPEC_CODES', '__winCodes'],
  ['WINDOW_SPEC_LIMITS', '__winLimits'],
  ['isObject', '__isObject'],
  ['bounded', '__bounded'],
  ['fail', '__fail'],
]);

/**
 * Replace one identifier everywhere it appears as an identifier.
 *
 * @param {string} text
 * @param {string} name
 * @param {string} replacement
 * @returns {string}
 */
function renameIdentifier(text, name, replacement) {
  return text.replace(new RegExp(`\\b${name}\\b`, 'g'), replacement);
}

/**
 * Every substitution {@link inlineChannelConstants} applies, as plain text.
 *
 * The value of this table is that the region's literals are DERIVED from the wire
 * constants and from the window contract: a range, a cap or a file name changes
 * in one place and the shipped bytes follow.
 */
export function channelSubstitutions() {
  return [
    ['RESERVED_HOST_EVENT_TYPE', JSON.stringify(RESERVED_HOST_EVENT_TYPE)],
    ['CHANNEL_NAME_REGEX', CHANNEL_NAME_REGEX_SOURCE],
    ['CHANNEL_PAYLOAD_MAX_BYTES', String(CHANNEL_PAYLOAD_MAX_BYTES)],
    ['CHANNEL_ENVELOPE_MAX_BYTES', String(CHANNEL_ENVELOPE_MAX_BYTES)],
    ['CHANNEL_MAX_BYTES', String(CHANNEL_MAX_BYTES)],
    ['CHANNEL_PROTOCOL', String(CHANNEL_PROTOCOL)],
    ['CHANNEL_NOTIFY_TITLE_MAX', String(CHANNEL_NOTIFY_TITLE_MAX)],
    ['CHANNEL_NOTIFY_BODY_MAX', String(CHANNEL_NOTIFY_BODY_MAX)],
    ['MAX_WINDOW_SPECS', String(MAX_WINDOW_SPECS)],
    ['CHANNEL_OUT_FILE', JSON.stringify(CHANNEL_OUT_FILE)],
    ['CHANNEL_OUT_ROTATED', JSON.stringify(CHANNEL_OUT_ROTATED)],
    ['STATE_DIR_NAME', JSON.stringify(STATE_DIR_NAME)],
  ];
}

/**
 * The same source, with every module-scope reference inlined and comments dropped.
 *
 * `Function.prototype.toString()` returns the function body as written, and that
 * body names things that do not exist inside the shipped region: the reserved
 * type, the channel-name regex, the byte caps, the protocol number, the file
 * names, the state-directory name, the window contract's limits, and the sibling
 * functions the block declares under private names. This function replaces those
 * NAMES with shipped source text (or with the block's own binding) and compacts
 * the comments — nothing else — so every remaining byte is the function the tests
 * call, which is what keeps the shipped logic and the tested logic the same code.
 *
 * ORDER: compaction first (so a name inside a comment is not rewritten into
 * shipped text), then the identifier substitutions, then the literal ones (a
 * literal can never collide with an identifier substitution because the literal
 * table only holds names that no substitution produces).
 *
 * @param {string} source function source text
 * @returns {string}
 */
export function inlineChannelConstants(source) {
  let text = compactJsSource(source);
  for (const [name, replacement] of SHIPPED_NAME_SUBSTITUTIONS) {
    text = renameIdentifier(text, name, replacement);
  }
  for (const [name, replacement] of channelSubstitutions()) {
    text = renameIdentifier(text, name, replacement);
  }
  return text;
}

/**
 * Strip comments and dead whitespace from a function's own source.
 *
 * The region has a FINITE budget (16 KiB since the two new channels) and the
 * functions below carry a lot of explanatory JSDoc that belongs in THIS file, not
 * in the shipped bytes. What is removed is comments and per-line indentation only
 * — never a token — so the shipped function is the tested function, and
 * `test/split-surgery.test.mjs` proves it by running the extracted source and
 * comparing results.
 *
 * The scanner mirrors the one in `test/bridge-harness.mjs` (strings are copied
 * verbatim), because the two must agree about what a comment is.
 *
 * @param {string} source function source text
 * @returns {string}
 */
export function compactJsSource(source) {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      output += character;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        output += current;
        index += 1;
        if (current === '\\') {
          output += source[index] === undefined ? '' : source[index];
          index += 1;
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }
    output += character;
    index += 1;
  }
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** The classifier source with every module-scope name inlined — the region's copy. */
export const HOST_EVENT_CLASSIFIER_SHIPPED = inlineChannelConstants(HOST_EVENT_CLASSIFIER_SOURCE);

/**
 * Resolve the state directory the way the bridge does: `DSH_HOME`, then `~/.dsh`,
 * then nothing.
 *
 * `process` IS in scope inside the region (the tray class already uses it), which
 * is why the same precedence is reachable from a free function at all: it needs
 * no `this`, only the environment. `~/.dsh` needs `node:os`, so that branch
 * resolves the module through the region's own `createRequire(import.meta.url)`
 * — a name the official file already has.
 *
 * Returns `null` (not the bare directory name) when neither source is usable: a
 * relative "dsh-asar-framework" directory would land wherever the app was
 * launched from, and creating that is exactly the "directories outside the state
 * dir" this hander must never do.
 *
 * @returns {string|null}
 */
export function resolveChannelStateDir() {
  let base = null;
  try {
    if (typeof process === 'object' && process !== null && process.env !== null) {
      const home = process.env.DSH_HOME;
      if (typeof home === 'string' && home.trim() !== '') base = home.trim();
    }
  } catch (_error) {
    base = null;
  }
  if (base === null) {
    try {
      const os = createRequire(import.meta.url)('node:os');
      const home = os.homedir();
      if (typeof home === 'string' && home !== '') base = home + '/.dsh';
    } catch (_error) {
      base = null;
    }
  }
  if (base === null || base === '') return null;
  return base + '/' + STATE_DIR_NAME;
}

/**
 * Write ONE envelope line into the channel file, atomically and bounded.
 *
 * WHY TEMP + RENAME INSTEAD OF `appendFileSync`
 * An append is not atomic: a reader polling this file (the bridge's `drain()`)
 * could observe a half-written line, and a half-written line is not "a record
 * that has not arrived yet" — it is a record that will never be valid, because
 * the writer considers it written. Read-modify-write into a temp file and a
 * single `renameSync` makes every observable state a COMPLETE file: before the
 * rename the reader sees the old content, after it the new one, never in between.
 *
 * WHY THE FILE IS CAPPED AT 4,096 B
 * A hostile writer must not be able to park megabytes in the state directory. The
 * cap is enforced twice: the envelope itself is refused when its serialised form
 * exceeds {@link CHANNEL_ENVELOPE_MAX_BYTES}, and the file is rotated once it
 * would exceed {@link CHANNEL_MAX_BYTES} — so at most ONE previous file
 * (`channel.out.jsonl.1`) ever exists, the same single-slot discipline
 * `events.jsonl` uses.
 *
 * WHY THE STATE DIRECTORY IS CREATED NON-RECURSIVELY
 * `mkdirSync(dir)` fails when the PARENT is missing, and that failure is the
 * correct answer: the region may create the state directory, never a chain above
 * it. The real app always has its parent (`DSH_HOME` / `~/.dsh`) already.
 *
 * @param {string} file absolute-or-relative path of the live file
 * @param {string} rotated path of the single rotated slot
 * @param {string} line one complete line, newline included
 * @returns {boolean} true when the rename succeeded
 */
export function writeChannelLineAtomic(file, rotated, line) {
  const require_ = createRequire(import.meta.url);
  const fs = require_('node:fs');
  try {
    fs.mkdirSync(rotated.slice(0, rotated.lastIndexOf('/')), { recursive: false });
  } catch (_error) {
    // Already there (EEXIST) or the parent is missing; the write below decides.
  }
  let previous = '';
  try {
    previous = fs.readFileSync(file, 'utf8');
  } catch (_error) {
    previous = '';
  }
  if (typeof previous !== 'string') previous = '';
  let text = previous + line;
  if (byteLengthOf(text) > CHANNEL_MAX_BYTES) {
    // The live file is full: move it to the single rotated slot and start over
    // with just this line. A rotation failure is survivable — then the line is
    // written alone, which still satisfies the cap.
    try {
      fs.renameSync(file, rotated);
    } catch (_error) {
      // Nothing to rotate, or the slot is locked; either way start fresh.
    }
    text = line;
  }
  if (byteLengthOf(text) > CHANNEL_MAX_BYTES) return false;
  const temporary = file + '.tmp';
  try {
    fs.writeFileSync(temporary, text, 'utf8');
  } catch (_error) {
    return false;
  }
  try {
    fs.renameSync(temporary, file);
    return true;
  } catch (_error) {
    try {
      fs.unlinkSync(temporary);
    } catch (_secondError) {
      // The stale temp file is the lesser evil; the answer is already false.
    }
    return false;
  }
}


/**
 * The Electron providers the channel reaches for, guarded by `typeof`.
 *
 * Two reasons for the guard and not a bare reference: `Notification` and
 * `BrowserWindow` are module-scope imports of `lib/main.js` TODAY, but a future
 * shell build could move them, and `typeof <unresolvable name>` is the one
 * reference form that cannot throw. A throw here would land inside main's
 * `child.on("message")` callback — i.e. a crash in the desktop main process —
 * which is the one thing this region must never cause.
 *
 * `providers` exists so the module-level (tested) copies can be driven with stubs
 * without an Electron process: the SHIPPED call passes one argument, so it
 * always resolves the real globals.
 *
 * @param {{ notification?: unknown, window?: unknown, app?: unknown }} [providers]
 * @returns {{ notification?: unknown, window?: unknown, app?: unknown }}
 */
export function channelElectron(providers) {
  if (providers !== undefined) return providers;
  const found = {};
  if (typeof Notification !== 'undefined') found.notification = Notification;
  if (typeof BrowserWindow !== 'undefined') found.window = BrowserWindow;
  if (typeof app !== 'undefined') found.app = app;
  return found;
}

/**
 * Append ONE bounded envelope line to the ack file, or do nothing.
 *
 * This is the ONLY writer of `channel.out.jsonl` in the region, so "what the
 * bridge can read" has exactly one shape and one cap. A write failure is not
 * reported upward: the message has already been ACCEPTED (main must not kill the
 * child over a full disk), and the failure surfaces as `status().channel` staying
 * at zero received.
 *
 * @param {string|null} stateDir
 * @param {string} channel
 * @param {unknown} received
 * @returns {boolean} true when the line was written
 */
export function writeChannelAck(stateDir, channel, received) {
  if (stateDir === null) return false;
  try {
    const envelope = {
      protocol: CHANNEL_PROTOCOL,
      channel,
      at: new Date().toISOString(),
      received,
    };
    const line = JSON.stringify(envelope) + '\n';
    if (typeof line !== 'string' || byteLengthOf(line) > CHANNEL_ENVELOPE_MAX_BYTES) return false;
    return writeChannelLineAtomic(stateDir + '/' + CHANNEL_OUT_FILE, stateDir + '/' + CHANNEL_OUT_ROTATED, line) === true;
  } catch (_error) {
    return false;
  }
}

/**
 * `channel: "notify"` — construct and show ONE real Electron notification, NOW.
 *
 * WHY THIS IS THE POINT OF THE CHANNEL
 * The file channel (`notify.json` → `lib/bridge/src/notify.js`) polls: the Host
 * writes a document, the bridge reads it on a 700 ms tick, and the toast appears
 * up to ~2 s later. This path does the same work in the SAME PROCESS the toast
 * lives in, with no interval, no queue and no file: a message arrives, a
 * notification is constructed and shown before the handler returns. That is the
 * "lag-0" difference the IPC channel exists for; the file channel stays as the
 * fallback for anything that outlives one message (dedupe, rate limit, restart
 * memory).
 *
 * WHAT IT DOES NOT DO (deliberately): no dedupe, no rate limiting, no persisted
 * watermark. Those are the FILE channel's job because they are about MANY
 * messages over time; a single message is answered by exactly one toast. The
 * bounds here are per-message ones: {@link CHANNEL_NOTIFY_TITLE_MAX},
 * {@link CHANNEL_NOTIFY_BODY_MAX}, and the envelope cap.
 *
 * @param {unknown} payload `{ title, body?, silent? }`
 * @param {object} [providers] see {@link channelElectron}
 * @returns {{ received: string } | { declined: string }}
 */
export function handleNotifyMessage(payload, providers) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { declined: CHANNEL_DECLINE_CODES.EINVALID_TOAST };
  }
  const title = payload.title;
  if (typeof title !== 'string' || title === '' || title.length > CHANNEL_NOTIFY_TITLE_MAX) {
    return { declined: CHANNEL_DECLINE_CODES.EINVALID_TOAST };
  }
  let body = '';
  if (payload.body !== void 0) {
    if (typeof payload.body !== 'string' || payload.body.length > CHANNEL_NOTIFY_BODY_MAX) {
      return { declined: CHANNEL_DECLINE_CODES.EINVALID_TOAST };
    }
    body = payload.body;
  }
  const silent = payload.silent === true;
  if (payload.silent !== void 0 && typeof payload.silent !== 'boolean') {
    return { declined: CHANNEL_DECLINE_CODES.EINVALID_TOAST };
  }

  const provider = channelElectron(providers).notification;
  if (provider === void 0 || (typeof provider !== 'function' && typeof provider !== 'object')) {
    return { declined: CHANNEL_DECLINE_CODES.EPROVIDER_ABSENT };
  }
  // `Notification.isSupported()` decides whether this OS can toast at all. A
  // provider without the method counts as capable: the real class always has it,
  // so its absence means a stub, not an OS that cannot show toasts.
  try {
    if (typeof provider.isSupported === 'function' && provider.isSupported() !== true) {
      return { received: 'unsupported' };
    }
  } catch (_error) {
    return { declined: CHANNEL_DECLINE_CODES.EPROVIDER_ABSENT };
  }

  let toast;
  try {
    toast = new provider({ title, body, silent });
  } catch (_error) {
    return { declined: CHANNEL_DECLINE_CODES.ECONSTRUCT_FAILED };
  }
  if (toast === null || typeof toast !== 'object' || typeof toast.show !== 'function') {
    return { declined: CHANNEL_DECLINE_CODES.ECONSTRUCT_FAILED };
  }
  try {
    // Listeners first: a `failed` event is the only signal that the OS refused
    // the toast, and a `click` is the only user response this channel has.
    if (typeof toast.on === 'function') toast.on('failed', () => void 0);
    if (typeof toast.once === 'function') toast.once('click', () => void 0);
    toast.show();
  } catch (_error) {
    return { declined: CHANNEL_DECLINE_CODES.ELOAD_FAILED };
  }
  return { received: 'shown' };
}

/**
 * The application origin a new window's route is resolved against.
 *
 * `SCHEME` is a module-scope `const` of the stock `lib/main.js` (`"dsh-app"`), and
 * `main()` builds exactly `${SCHEME}://app/` from it — so the region reads the
 * shell's OWN spelling instead of hard-coding one, and a release that renamed the
 * scheme needs no change here. `typeof` is the guard, not a bare reference: a
 * future build that moves `SCHEME` out of module scope degrades to the documented
 * literal instead of throwing inside main's IPC callback.
 *
 * `SCHEME` is deliberately NOT added to `lib/host/compat.js`
 * `PATCH_DEPENDENCIES`: the region must not make an install refuse a release it
 * can still run, and the `typeof` fallback is what makes that possible.
 *
 * @returns {string}
 */
export function channelAppOrigin() {
  return typeof SCHEME === 'string' && SCHEME !== '' ? SCHEME + '://app/' : 'dsh-app://app/';
}

/**
 * `channel: "window"` — construct ONE real window from a bounded spec.
 *
 * THE CONTRACT IS NOT REINVENTED HERE
 * The payload is validated by {@link validateWindowSpec}, whose SOURCE TEXT is
 * the one already shipped in `lib/bridge/src/windows.js`: same fields, same
 * ranges, same-origin route rule ({@link isSameOriginRoute}). A window request
 * that the declarative half would refuse is refused here, by the same bytes.
 *
 * THE TWO CAPS THAT LIVE IN THE REGION AND NOWHERE ELSE
 *   1. ONE window per `id` — a second request for the same id is refused rather
 *      than stacking N windows under one name;
 *   2. at most {@link MAX_WINDOW_SPECS} live windows — the registry prunes itself
 *      on `closed`, and a request past the cap is refused, so a loop cannot fill
 *      the screen.
 *
 * A refused request still writes an ACK (`received:'rejected'` + a reason code):
 * the answer is never silence, and the answer to main is never `false`.
 *
 * @param {unknown} payload a window spec (`validateWindowSpec` decides)
 * @param {object} [providers] see {@link channelElectron}
 * @param {Map<string, unknown>} [windows] the registry; the shipped call passes
 *        the block's own map
 * @returns {{ received: 'opened'|'rejected', windowId: string|null, reason?: string }}
 */
export function handleWindowMessage(payload, providers, windows) {
  // No registry means this function was called without the block's own map: a
  // builder mistake, and the answer is a refusal rather than a throw.
  if (windows === void 0 || windows === null || typeof windows.get !== 'function') {
    const checked = validateWindowSpec(payload, 'window');
    return { received: 'rejected', windowId: checked.ok === true ? checked.spec.id : null, reason: CHANNEL_DECLINE_CODES.EREGISTRY };
  }
  const checked = validateWindowSpec(payload, 'window');
  if (checked.ok !== true) return { received: 'rejected', windowId: null, reason: checked.code };
  const spec = checked.spec;
  const reject = (reason) => ({ received: 'rejected', windowId: spec.id, reason });
  if (windows.has(spec.id)) return reject(CHANNEL_DECLINE_CODES.EDUPLICATE_ID);
  if (windows.size >= MAX_WINDOW_SPECS) return reject(CHANNEL_DECLINE_CODES.ELIMIT);

  const electron = channelElectron(providers);
  const provider = electron.window;
  if (typeof provider !== 'function') return reject(CHANNEL_DECLINE_CODES.EPROVIDER_ABSENT);
  const existing = typeof provider.getAllWindows === 'function' ? provider.getAllWindows() : [];

  const preferences = { nodeIntegration: false, contextIsolation: true, sandbox: true };
  // The shell's own preload is what makes a window a DSH window instead of a
  // bare browser view; it is resolved from `app.getAppPath()`, the same call
  // `main()` makes (`join(app.getAppPath(), "lib", "preload-app.cjs")`). When `app`
  // is not in scope the window still opens — it just carries no shell services,
  // which `TECHDOC.md` §21 records as a limitation rather than hides.
  if (electron.app !== void 0 && electron.app !== null && typeof electron.app.getAppPath === 'function') {
    try {
      preferences.preload = electron.app.getAppPath() + '/lib/preload-app.cjs';
    } catch (_error) {
      // No preload: the window still loads the route.
    }
  }
  const options = { show: true, webPreferences: preferences };
  for (const field of ['title', 'width', 'height', 'x', 'y', 'resizable']) {
    if (spec[field] !== void 0) options[field] = spec[field];
  }
  if (spec.frameless === true) options.frame = false;
  if (spec.modal === true && existing.length > 0) {
    options.parent = existing[0];
    options.modal = true;
  }

  let created;
  try {
    created = new provider(options);
  } catch (_error) {
    return reject(CHANNEL_DECLINE_CODES.ECONSTRUCT_FAILED);
  }
  if (created === null || typeof created !== 'object' || typeof created.loadURL !== 'function') {
    return reject(CHANNEL_DECLINE_CODES.ECONSTRUCT_FAILED);
  }
  try {
    const target = new URL(spec.route === void 0 ? '/' : spec.route, channelAppOrigin());
    const loading = created.loadURL(target.href);
    // A rejected load is a page failure, not a channel failure: the window
    // exists, so the request was answered. Swallowing the rejection keeps an
    // unhandled promise from reaching the main process's global handler.
    if (loading !== void 0 && loading !== null && typeof loading.catch === 'function') loading.catch(() => void 0);
  } catch (_error) {
    try {
      if (typeof created.destroy === 'function') created.destroy();
    } catch (_ignored) {
      // Nothing left to clean up.
    }
    return reject(CHANNEL_DECLINE_CODES.ELOAD_FAILED);
  }

  windows.set(spec.id, created);
  try {
    if (typeof created.once === 'function') created.once('closed', () => void windows.delete(spec.id));
  } catch (_error) {
    // A window that refuses the listener is still open: the cap above is what
    // keeps the registry from growing, because `size` is only pruned here.
  }
  return { received: 'opened', windowId: spec.id };
}

/**
 * The channel's dispatcher: the ONLY consumer of an accepted `dsh-asar-bridge`
 * message.
 *
 * THE ONE RULE THIS FUNCTION EXISTS FOR
 * It NEVER returns `false`. Not for a mistyped channel, not for a forged
 * `requestId`, not for an oversized payload, not for a throwing native call. The
 * return value is main's "is this a valid IPC event" answer, and `false` there
 * runs `this.fail()` + `child.kill("SIGTERM")` on the Host child — the user's
 * session. Every malformed message of OUR type is therefore ACCEPTED and,
 * optionally, RECORDED: the three filters (no `requestId`/`error`, channel-name
 * shape, payload cap) make this function DECLINE the message — it writes one
 * bounded `declined` line and answers `true`.
 *
 * THREE DISPATCH TARGETS, ONE ACK FILE
 *   state   echo the bounded payload                 -> `channel:"state"` line
 *   ping    answer `pong`                            -> `channel:"ping"` line
 *   notify  show an OS notification, immediately      -> `channel:"notify"` line
 *   window  construct a BrowserWindow from a spec    -> `channel:"window"` line
 * Everything else, and everything the filters catch, becomes one
 * `channel:"declined"` line carrying `{requested, reason}`.
 *
 * WHY IT ANSWERS BY FILE, AND WHY THAT IS THE ONLY HONEST ANSWER
 * A message that reaches this function has already been accepted by the wrapper,
 * which main calls as a free module-scope function — no `this`, therefore no
 * `this.controlRequests`, no `child.send`, and no way to reply over IPC. A
 * "response" is therefore not something this side can perform; a FILE is the one
 * channel both halves can reach without a capability the region does not have.
 * It is slower, it is one-way, and it must be said that way rather than dressed
 * up as a request/response protocol. (The two new channels do their WORK in this
 * process — the toast is shown, the window opens — and only the RECORD of it
 * travels by file.)
 *
 * Never throws: a exception escaping into main's `child.on("message")` callback
 * would be a live crash in the desktop main process, and this region is the last
 * place that may be allowed to break.
 *
 * @param {unknown} message an accepted `dsh-asar-bridge` message
 * @param {object} [providers] see {@link channelElectron}
 * @param {Map<string, unknown>} [windows] the window registry
 * @returns {boolean} ALWAYS true
 */
export function handleChannelMessage(message, providers, windows) {
  try {
    const channel = message.channel;
    const requested = typeof channel === 'string' ? channel.slice(0, 32) : null;
    let decline = null;
    if (message.requestId !== void 0 || message.error !== void 0) {
      // A channel message must never look like a control reply: the official
      // ladder would resolve someone else's pending request with it.
      decline = CHANNEL_DECLINE_CODES.ECONTROL_LOOKALIKE;
    } else if (typeof channel !== 'string' || !CHANNEL_NAME_REGEX.test(channel)) {
      decline = CHANNEL_DECLINE_CODES.EINVALID_CHANNEL;
    } else if (message.payload !== void 0) {
      let serialised;
      try {
        serialised = JSON.stringify(message.payload);
      } catch (_error) {
        serialised = void 0;
      }
      if (typeof serialised !== 'string' || byteLengthOf(serialised) > CHANNEL_PAYLOAD_MAX_BYTES) {
        decline = CHANNEL_DECLINE_CODES.EPAYLOAD_TOO_LARGE;
      }
    }

    const stateDir = resolveChannelStateDir();
    if (decline !== null) {
      writeChannelAck(stateDir, CHANNEL_NAMES.declined, { requested, reason: decline });
      return true;
    }

    if (channel === CHANNEL_NAMES.state || channel === CHANNEL_NAMES.ping) {
      const received = channel === CHANNEL_NAMES.ping
        ? CHANNEL_NAMES.pong
        : message.payload === void 0
          ? null
          : message.payload;
      writeChannelAck(stateDir, channel, received);
      return true;
    }

    if (channel === CHANNEL_NAMES.notify) {
      const answer = handleNotifyMessage(message.payload, providers);
      if (answer.declined === void 0) writeChannelAck(stateDir, channel, answer.received);
      else writeChannelAck(stateDir, CHANNEL_NAMES.declined, { requested, reason: answer.declined });
      return true;
    }

    if (channel === CHANNEL_NAMES.window) {
      const answer = handleWindowMessage(message.payload, providers, windows);
      writeChannelAck(stateDir, channel, answer);
      return true;
    }

    writeChannelAck(stateDir, CHANNEL_NAMES.declined, { requested, reason: CHANNEL_DECLINE_CODES.EUNKNOWN_CHANNEL });
    return true;
  } catch (_error) {
    // THE RULE, one last time: no input and no failure may make this `false`.
    return true;
  }
}

/**
 * The handler block, as it ships: the three functions plus their inlined literals.
 *
 * The handler is a SEPARATE block inside the region (not part of the classifier)
 * because the two have different jobs: the classifier decides `delegate` /
 * `reject` / `accept`, and the handler is what `accept` MEANS. The wrapper ties
 * them together at exactly one line, so "what happens to an accepted message" is
 * answerable by reading one line.
 *
 * Every reference below is either a name the previous line declared or a literal.
 * `process` and `createRequire(import.meta.url)` are the two scope names taken
 * from the official file — both are already used by the tray class above and
 * already listed in `lib/host/compat.js` `PATCH_DEPENDENCIES`, so this block adds
 * no new dependency. `Date` and `JSON` are JS globals; the file names and the
 * protocol number are interpolated from `lib/wire/constants.js` so region,
 * bridge and Host cannot disagree about them.
 */
/**
 * Rewrite a function's own names into the region's private block names.
 *
 * Kept as a thin helper over {@link SHIPPED_NAME_SUBSTITUTIONS} so a caller that
 * wants "just the renames" does not have to re-run the literal table.
 *
 * @param {string} source compacted function source
 * @returns {string}
 */
export function renameChannelHandlerRefs(source) {
  let text = source;
  for (const [name, replacement] of SHIPPED_NAME_SUBSTITUTIONS) {
    text = renameIdentifier(text, name, replacement);
  }
  return text;
}

/**
 * Make a function expression anonymous, for splicing as `const NAME = <expr>`.
 *
 * `Function.prototype.toString()` of a declaration starts with
 * `function <name>(…)`; dropping the name avoids a second binding that would
 * shadow the `const` it is assigned to (harmless, but a shadowed name inside the
 * region is exactly the kind of thing that reads like a bug later).
 *
 * @param {string} source
 * @returns {string} the same function without its own name
 */
export function anonymousFunctionSource(source) {
  return source.replace(/^function\s+[A-Za-z_$][\w$]*\s*\(/, 'function (');
}

/**
 * Splice one module function into the region as `const NAME = <fn>`.
 *
 * One call, one rule: compact, rename identifiers, inline literals, drop the
 * function's own name. Every shipped function comes from here, so "the shipped
 * bytes are the tested bytes" holds by construction instead of by repetition.
 *
 * @param {string} name the region's private binding
 * @param {Function} fn the module-scope function
 * @returns {string} `const <name> = <source>;`
 */
function shippedFunction(name, fn) {
  return `const ${name} = ${anonymousFunctionSource(inlineChannelConstants(compactJsSource(fn.toString())))};`;
}

/** The window contract's validators, shipped verbatim, in dependency order. */
const WINDOW_CONTRACT_BLOCK = [
  shippedFunction('__isObject', WINDOW_SPEC_INTERNALS.isObject),
  shippedFunction('__fail', WINDOW_SPEC_INTERNALS.fail),
  shippedFunction('__bounded', WINDOW_SPEC_INTERNALS.bounded),
  shippedFunction('__isSameOriginRoute', isSameOriginRoute),
  shippedFunction('__validateWindowSpec', validateWindowSpec),
].join('\n\t\t');

/**
 * The handler block, as it ships.
 *
 * WHAT IT DECLARES, and why every one of them is block-scoped
 *   1. five LITERAL VALUES derived from the wire constants and from the window
 *      contract (`__channelNames`, `__decline`, `__winLimits`, `__winCodes`);
 *   2. `byteLengthOf` — one UTF-8 length function, shared by everything below;
 *   3. the window CONTRACT, shipped verbatim from
 *      `lib/bridge/src/windows.js` (`__isObject`, `__fail`, `__dimension`,
 *      `__coordinate`, `__isSameOriginRoute`, `__validateWindowSpec`) — the
 *      declarative half and the imperative half are the same code;
 *   4. the channel machinery: `__channelStateDir`, `__channelWrite`,
 *      `__writeAck`, `__channelElectron`, `__handleNotify`, `__appOrigin`,
 *      `__handleWindow`, `__channelHandle`;
 *   5. `__windowRegistry` — the ONE `Map` the window channel keeps, so "one
 *      window per id" and "at most MAX_WINDOW_SPECS windows" are enforced by
 *      data structure rather than by hope.
 *
 * A future stock build cannot collide with any of these: they all live inside
 * the `{ }` block that the IPC body opens. The only names taken from the
 * official file are `process`, `createRequire(import.meta.url)`, `isDesktopHostEvent`,
 * and — for the two new channels — the module-scope `Notification`, `BrowserWindow`
 * and `app` imports of `lib/main.js`, every one of them reached through
 * `typeof`/`arguments` so a build that moved them degrades instead of throwing.
 */
export const CHANNEL_HANDLER_BLOCK = `const __channelNames = ${CHANNEL_NAMES_SOURCE};
\t\tconst __decline = ${CHANNEL_DECLINE_CODES_SOURCE};
\t\tconst __winLimits = ${WINDOW_SPEC_LIMITS_SOURCE};
\t\tconst __winCodes = ${WINDOW_SPEC_CODES_SOURCE};
\t\tconst __windowRegistry = new Map();
\t\t${BYTE_LENGTH_SHIPPED}
\t\t${WINDOW_CONTRACT_BLOCK}
\t\t${shippedFunction('__channelStateDir', resolveChannelStateDir)}
\t\t${shippedFunction('__channelWrite', writeChannelLineAtomic)}
\t\t${shippedFunction('__writeAck', writeChannelAck)}
\t\t${shippedFunction('__channelElectron', channelElectron)}
\t\t${shippedFunction('__handleNotify', handleNotifyMessage)}
\t\t${shippedFunction('__appOrigin', channelAppOrigin)}
\t\t${shippedFunction('__handleWindow', handleWindowMessage)}
\t\t${shippedFunction('__channelHandle', handleChannelMessage)}`;

/** The handler block alone, in bytes (diagnostics/tests). */
export const CHANNEL_HANDLER_BYTES = Buffer.from(CHANNEL_HANDLER_BLOCK, 'utf8').length;

/**
 * The `reject` / `delegate` decision names the shipped wrapper compares against.
 *
 * Exported so a test can prove the generated text really branches on the values
 * {@link classifyHostEvent} returns, instead of on strings typed a second time.
 */
export const HOST_EVENT_VERDICTS = Object.freeze({ delegate: 'delegate', reject: 'reject', accept: 'accept' });

/** Comment that identifies the IPC block. A comment, NOT a region marker. */
export const IPC_BLOCK_ID = '/* dsh-asar-bridge-ipc v0.2.0 */';

/**
 * The IPC block: the second block of the split region, appended after the
 * `DesktopTray` redeclaration.
 *
 * Shape (proven by `evidence/ipc-extend-proto.mjs`):
 *   capture the official validator into a `const`, build the replacement from
 *   {@link HOST_EVENT_CLASSIFIER_SOURCE}, assign it back to the same module
 *   binding, and keep every failure inside `try`/`catch`.
 *
 * WHAT RUNS INSIDE IT, IN ORDER (one `try`, four `const`, one assignment):
 *   1. `__officialIsDesktopHostEvent` — the captured original;
 *   2. `CHANNEL_HANDLER_BLOCK` — the channel vocabulary, the UTF-8 length helper,
 *      and the state-dir / atomic-write / handler chain. It must exist BEFORE the
 *      classifier's `accept` can be answered, because `accept` MEANS "run this";
 *   3. `classifyHostEvent` — the decision table (delegate / reject / accept);
 *   4. the assignment: `reject` -> `false`, `accept` -> the handler's own verdict
 *      (`false` when it refuses, which is main's "kill the child" answer),
 *      `delegate` -> the official verdict, unchanged.
 *
 * It references only names that already exist in the stock `lib/main.js` scope
 * (`isDesktopHostEvent`, `process`, `createRequire`, `import.meta.url`, and — for
 * the two new channels — the module-scope `Notification` / `BrowserWindow` / `app`
 * imports, each reached through `typeof`), so it adds no import — the one thing
 * that would change the file's dependency surface.
 *
 * THE ACCEPT BRANCH IS THE WHOLE POINT: it calls the handler and IGNORES what the
 * handler thinks (`=== true` is always true — see {@link handleChannelMessage}),
 * so no accepted message of ours can produce `false`. `false` remains reachable
 * only through `reject`, which is exactly stock's answer for a foreign type with
 * a forged `requestId`.
 *
 * The surrounding `{ }` block is deliberate: every name above becomes
 * block-scoped, so a future stock build that happens to declare one of them at
 * module level cannot collide (nor be shadowed BY us). The block still runs at
 * module evaluation time, in source order, which is what the mechanism needs.
 */
export const IPC_BODY = `${IPC_BLOCK_ID}
{
\ttry {
\t\tconst __officialIsDesktopHostEvent = isDesktopHostEvent;
\t\t${CHANNEL_HANDLER_BLOCK}
\t\tconst classifyHostEvent = ${HOST_EVENT_CLASSIFIER_SHIPPED};
\t\tisDesktopHostEvent = function (message) {
\t\t\tconst officialVerdict = __officialIsDesktopHostEvent(message);
\t\t\tconst verdict = classifyHostEvent(message, officialVerdict);
\t\t\tif (verdict === "${HOST_EVENT_VERDICTS.reject}") return false;
\t\t\tif (verdict === "${HOST_EVENT_VERDICTS.accept}") {
\t\t\t\t__channelHandle(message, void 0, __windowRegistry);
\t\t\t\treturn true;
\t\t\t}
\t\t\treturn officialVerdict;
\t\t};
\t} catch (error) {
\t\t/* the official validator stays in place: degradation over cleverness */
\t}
}`;

/** The IPC block alone, in bytes (diagnostics/tests). */
export const IPC_BODY_BYTES = Buffer.from(IPC_BODY, 'utf8').length;

/* ------------------------------------------------------------------------- *
 * Split layout (v0.2.0): a region of OUR OWN, after the pristine official slot
 *
 * `PATCH_BODY` above replaces the official tray slot in place, which is why it
 * must fit 1,253 bytes. This body is the same delegating implementation, but it
 * is inserted AFTER the untouched official slot, so its size is ours to choose.
 *
 * Its first block keeps the same nine-token dependency surface as `PATCH_BODY` —
 * that is the contract the installer pre-checks against the shipped
 * `lib/main.js`, and changing it here would silently invalidate that check. Its
 * second block is {@link IPC_BODY}, which adds exactly one more name that is
 * already in scope (`isDesktopHostEvent`).
 * ------------------------------------------------------------------------- */

/** The `createBridge(...)` call inside {@link PATCH_BODY}, byte for byte. */
export const CREATE_BRIDGE_CALL =
  'createBridge({ app, Tray, Menu, nativeImage, tray, options: this.options })';

/**
 * The split-layout form of that call: the SAME call plus one injected
 * capabilities object.
 *
 * WHY THE SPLIT BODY GETS IT AND `PATCH_BODY` DOES NOT
 * `PATCH_BODY` replaces the official 1,253-byte tray slot in place, so it has no
 * room to grow (it is 1,173 B today, and 1,214 B is the smallest region it fits
 * — by construction, not by accident). The split region is ours and has ~6 KB
 * spare, so every new capability lands there and the 0.1.x in-slot string
 * stays byte-identical, which is what keeps `buildPatchedRegion(1253)` and the
 * migration path honest.
 *
 * WHY ONE OBJECT AND NOT THREE MORE ARGUMENTS
 * `createBridge` already takes six named things; a growing positional list is
 * how a shell-side call site becomes impossible to extend without breaking. One
 * injected object also makes the bridge's dependency on Electron's UI classes
 * explicit and *optional*: `validateEnvironment` never requires it, so a shell
 * that stops shipping a notification stack degrades to `notify.available:false`
 * instead of taking the tray down with a ReferenceError.
 *
 * WHY `typeof` GUARDS INSIDE THE REGION
 * `Notification` and `BrowserWindow` are module-scope imports of `lib/main.js`
 * today (verified at line 2 of the shipped rc.3 bundle). A future build could
 * still move them. `typeof <unresolvable name>` is the one reference form that
 * cannot throw, so the region answers "not injected" and the bridge degrades,
 * rather than the whole `relabel()` throwing into the shell's catch — which would
 * cost the user every menu contribution, not just the toasts.
 *
 * WHY THE PROPERTY NAMES ARE `notification` / `window`
 * The bridge artefact must never name an Electron class (that red line is pinned
 * by `test/bridge-build.test.mjs`), and it does not need to: what it consumes is
 * a capability (a constructor it may instantiate), not a class identity. The
 * mapping lives here, in the region, where the real bindings are.
 */
export const CREATE_BRIDGE_CALL_SPLIT = `createBridge({
\t\t\t\t\tapp, Tray, Menu, nativeImage, tray,
\t\t\t\t\toptions: this.options,
\t\t\t\t\telectron: {
\t\t\t\t\t\tnotification: typeof Notification === "undefined" ? void 0 : Notification,
\t\t\t\t\t\twindow: typeof BrowserWindow === "undefined" ? void 0 : BrowserWindow
\t\t\t\t\t}
\t\t\t\t})`;

/**
 * The split layout's tray class: {@link PATCH_BODY}'s bytes with the
 * `createBridge` call widened by {@link CREATE_BRIDGE_CALL_SPLIT}.
 *
 * Substitution, not a second copy: the class body, the constructor, `relabel`
 * and `dispose` stay exactly the bytes the in-slot layout has always shipped,
 * so the two layouts cannot drift apart in behaviour — only in the one call
 * that receives the extra capability object.
 *
 * `replace` with a function keeps every `$` in the replacement literal (a
 * replacement string would treat `$&`/`$1` as group references).
 */
export const SPLIT_TRAY_BODY = PATCH_BODY.replace(PATCH_MARKER, SPLIT_PATCH_MARKER).replace(
  CREATE_BRIDGE_CALL,
  () => CREATE_BRIDGE_CALL_SPLIT,
);

/**
 * The delegating DesktopTray implementation used by the split layout, followed by
 * the IPC guard block.
 *
 * The tray half is identical in behaviour to {@link PATCH_BODY}; only the comment
 * marker differs, so state detection can tell "0.1.x in-slot patch" from
 * "0.2.x inserted region" without measuring anything. The marker is substituted
 * rather than written twice so the two strings cannot drift apart. The IPC half
 * is appended after the class, because the class must stay the FIRST thing the
 * region defines (that is the identity `locateRegion`/`classifyAsar` look for).
 */
export const SPLIT_BODY = `${SPLIT_TRAY_BODY}
${IPC_BODY}`;

/**
 * Build our own region of exactly `regionLength` bytes.
 *
 * Layout (measured working in `evidence/split-region-proto.mjs` and kept here
 * byte-for-byte):
 *
 *   \n                                    <- puts the start marker on its own line,
 *                                            right after the official `//#endregion`
 *   //#region lib/dsh-asar-bridge.js
 *   /* dsh-asar-bridge-slot v0.2.0 *\/
 *   ...class...
 *   <spaces>
 *   \n//#endregion
 *
 * The padding is SPACES, never NUL: this is a text file inside an archive whose
 * directory is parsed verbatim, and every byte of it has to stay whitespace that
 * JS tolerates.
 *
 * @param {number} regionLength exact byte length wanted
 * @returns {Buffer}
 * @throws {Error} when the body cannot fit the requested length
 */
export function buildSplitRegion(regionLength) {
  if (!Number.isInteger(regionLength) || regionLength < 0) {
    throw new Error(`split region length must be a non-negative integer, got ${String(regionLength)}`);
  }
  const head = Buffer.from('\n' + SPLIT_START_MARKER + '\n' + SPLIT_BODY, 'utf8');
  const tail = Buffer.from('\n' + REGION_END_MARKER, 'utf8');
  const fixed = head.length + tail.length;
  const padding = regionLength - fixed;
  if (padding < 0) {
    throw new Error(
      `split body does not fit: needs ${fixed} bytes, region is ${regionLength} (overflow ${-padding})`,
    );
  }
  return Buffer.concat([head, Buffer.alloc(padding, 0x20), tail]);
}

/** Split body bytes alone, excluding markers and padding. */
export const SPLIT_BODY_BYTES = Buffer.from(SPLIT_BODY, 'utf8').length;

/**
 * Smallest split region this body can fit into.
 *
 * Same arithmetic as {@link MINIMUM_REGION_LENGTH} but with the split start
 * marker and the leading newline the split layout needs.
 */
export const SPLIT_MINIMUM_REGION_LENGTH = SPLIT_BODY_BYTES + 1 + SPLIT_START_MARKER.length + 1 + 1 + REGION_END_MARKER.length;
