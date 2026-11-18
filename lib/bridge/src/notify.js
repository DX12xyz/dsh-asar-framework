/**
 * Notification capability: the bridge's second channel, and the first one that
 * is not the tray.
 *
 * Same spirit as `menu.js`: the module turns a protocol-1 contribution document
 * into OS toasts, and every input shape maps to a defined outcome instead of a
 * throw. A malformed `notify.json` must cost the user his toasts — never his
 * tray, and never an exception inside the shell's `relabel()`.
 *
 * The channel is deliberately DIFFERENT from the menu channel in three ways,
 * because a toast is not a menu entry:
 *
 *  1. ONE-SHOT, so it needs a dedupe rule. Every item carries its own monotonic
 *     `rev`; the bridge remembers the highest rev it has shown (persisted in
 *     `notify.state.json`) and shows only strictly newer items whose id it has
 *     never shown. No ack channel is needed, and a restart cannot re-spam.
 *  2. RATE LIMITED. A plugin must not be able to fill the OS Action Center by
 *     calling `notify()` in a loop; the cap is global, not per owner (see
 *     `NOTIFY_RATE_LIMIT` in `paths.js` for why).
 *  3. FAIL-SOFT IN ONE EXTRA SENSE: no injected `Notification` class at all is a
 *     legal environment. The channel then reports `available:false` and the rest
 *     of the bridge behaves exactly as before.
 *
 * RED LINES (same as the rest of the bridge): no `require('electron')` (the
 * class is injected), no creating windows, no network, no reading inside the
 * asar. The module never owns anything: it hands `show()` to an instance and
 * keeps a bounded reference list so a toast is not garbage-collected before it
 * is clicked. It never destroys, closes or mutates anything the shell owns.
 */

import {
  FILES,
  NOTIFY_MAX_BYTES,
  NOTIFY_RATE_LIMIT,
  NOTIFY_RATE_WINDOW_MS,
  PROTOCOL_NOTIFY,
  messageOf,
  readContributionSource,
  readJsonState,
  writeTextAtomic,
} from './paths.js';

/** `urgency` values Electron accepts; anything else is dropped, not forwarded. */
const URGENCIES = new Set(['normal', 'critical', 'low']);

/** Upper bound on how many shown notifications we keep a live reference to. */
const LIVE_LIMIT = 32;

/** Upper bound on the recently-shown id ring persisted in `notify.state.json`. */
const RECENT_ID_LIMIT = 32;

/** Upper bound on the in-process shown-id set, so a long session cannot grow forever. */
const SEEN_ID_LIMIT = 512;

/** Hard cap on items one document may carry; the Host writer caps at 64 too. */
const MAX_DOCUMENT_ITEMS = 64;

/**
 * @param {unknown} value
 * @returns {boolean} true for a non-null, non-array object
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string} the value when it is a string, otherwise ''
 */
function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 * @returns {number | null} a non-negative integer, or null when the value is not one
 */
function countOf(value) {
  if (typeof value !== 'number' || Number.isFinite(value) !== true || value < 0) return null;
  return Math.floor(value);
}

/**
 * Is the injected value usable as a notification provider?
 *
 * `Notification` arrives as a class (a function in JavaScript) in the real
 * shell. A plain object is accepted too, because that is how a wrapper or a test
 * double will present it. Anything else is "not injected" — a legal state, not
 * an error.
 *
 * @param {unknown} candidate
 * @returns {boolean}
 */
function isNotifyProvider(candidate) {
  if (typeof candidate === 'function') return true;
  if (!isObject(candidate)) return false;
  try {
    return typeof candidate.isSupported === 'function';
  } catch (_error) {
    return false; // A throwing getter on a hostile object is still a No.
  }
}

/**
 * Normalise one raw item into the shape the channel needs, or null.
 *
 * A toast without a title would be an empty rectangle in the Action Center, so
 * `title` is required and an item that fails it is dropped. `body` is optional
 * (Electron renders a title-only notification fine).
 *
 * `rev` comes from the item when the writer supplied one, and falls back to the
 * document's `rev`. Both are legal: the Host writer stamps a per-item rev (that
 * is what makes "the new one shows, the old ones do not" possible when several
 * owners are merged into one document), while a hand-written single-shot
 * document may carry only a document-level rev.
 *
 * @param {unknown} raw
 * @param {string} documentOwner document-level `owner`, '' when absent
 * @param {number} documentRev document-level `rev`
 * @returns {{ id: string, owner: string, title: string, body: string, silent: boolean,
 *             urgency: string | null, rev: number } | null}
 */
function normalizeItem(raw, documentOwner, documentRev) {
  if (!isObject(raw)) return null;
  const id = textOf(raw.id);
  if (id === '') return null;
  const title = textOf(raw.title);
  if (title === '') return null;
  const itemOwner = textOf(raw.owner);
  // `owner` 的三种来源，按优先级：条目自己声明的 → 文档头声明的 → **id 的前缀**。
  //
  // 第三条是写半身真实产出的形状：`lib/host/notify-registry.js` 把 id 写成
  // `owner#序号`（和菜单同一个命名空间），但并不会在每条里再抄一遍 owner（那是
  // 纯冗余，且会随 owner 名变长而膨胀文档）。所以桥必须能从这个 id 里读出 owner，
  // 否则一次 toast 点击就无从归属 —— 而「点击能归位到插件」正是这个通道存在的
  // 理由。`#` 是保留分隔符，owner 名里不允许出现它（Host 侧同一套校验），所以按
  // **第一个** `#` 切分是可靠的。
  const owner = itemOwner !== '' ? itemOwner : textOf(documentOwner) !== '' ? textOf(documentOwner) : ownerOfId(id);
  const urgency = textOf(raw.urgency);
  return {
    id,
    owner,
    title,
    body: textOf(raw.body),
    silent: raw.silent === true,
    urgency: URGENCIES.has(urgency) ? urgency : null,
    rev: countOf(raw.rev) === null ? documentRev : countOf(raw.rev),
  };
}

/**
 * `owner#localserial` → `owner`, or '' when the id carries no separator.
 *
 * @param {string} id
 * @returns {string}
 */
function ownerOfId(id) {
  const at = id.indexOf('#');
  return at > 0 ? id.slice(0, at) : '';
}

/**
 * Parse the contribution document into a normalised queue.
 *
 * Total by design: every failure comes back as `{ok:false, reason}`, which the
 * caller records in `status()` and otherwise ignores.
 *
 * @param {{ kind: string, text: string | null, error: string | null }} source
 * @returns {{ ok: true, rev: number, items: object[] } | { ok: false, reason: string }}
 */
function parseDocument(source) {
  if (source.kind === 'missing') return { ok: true, rev: 0, items: [] };
  if (source.kind !== 'text') {
    return { ok: false, reason: source.error === null ? 'notify.json is unavailable' : source.error };
  }
  let document;
  try {
    document = JSON.parse(source.text);
  } catch (error) {
    return { ok: false, reason: 'notify.json is not valid JSON: ' + messageOf(error) };
  }
  if (!isObject(document)) return { ok: false, reason: 'notify.json is not a JSON object' };
  if (document.protocol !== PROTOCOL_NOTIFY) {
    return { ok: false, reason: 'notify.json protocol is not ' + PROTOCOL_NOTIFY };
  }
  const rawItems = document.items;
  if (rawItems === null || rawItems === undefined) return { ok: true, rev: 0, items: [] };
  if (!Array.isArray(rawItems)) return { ok: false, reason: 'notify.json items is not an array' };

  const documentRev = countOf(document.rev) === null ? 0 : countOf(document.rev);
  const documentOwner = textOf(document.owner);

  const items = [];
  let highest = 0;
  for (let index = 0; index < rawItems.length && items.length < MAX_DOCUMENT_ITEMS; index++) {
    const normalised = normalizeItem(rawItems[index], documentOwner, documentRev);
    if (normalised === null) continue;
    items.push(normalised);
    if (normalised.rev > highest) highest = normalised.rev;
  }
  // The document's own `rev` is never trusted to be HIGHER than what it carries:
  // a writer that stamps a document number its items never reference would
  // otherwise mute the channel with a number nothing compares against.
  return { ok: true, rev: Math.max(documentRev, highest), items };
}

/**
 * Create the notification channel.
 *
 * @param {{
 *   stateDir: string | null,
 *   notification?: unknown,
 *   emit: (record: object) => void,
 *   now?: () => number,
 * }} input
 * @returns {{
 *   poll: () => { shown: number, skipped: number, reason: string | null },
 *   status: () => object,
 *   dispose: () => void,
 * }}
 */
export function createNotifyChannel(input) {
  const settings = isObject(input) ? input : {};
  const stateDir = typeof settings.stateDir === 'string' && settings.stateDir !== '' ? settings.stateDir : null;
  const provider = settings.notification;
  const emit = typeof settings.emit === 'function' ? settings.emit : () => {};
  const now = typeof settings.now === 'function' ? settings.now : () => Date.now();

  const state = {
    available: isNotifyProvider(provider),
    shown: 0,
    lastError: stateDir === null ? 'state directory unavailable' : null,
    rev: 0,
    rateLimited: 0,
    invalid: 0,
    duplicates: 0,
    stateRestored: false,
    disposed: false,
  };

  let supportedChecked = false;

  /** Timestamps of the shows inside the current sliding window. */
  const shownAt = [];

  /** Ids shown in this process (seeded from the persisted ring at load). */
  const shownIds = new Set();

  /** Ring of recently shown ids, persisted so a restart cannot re-spam. */
  let recentIds = [];

  /** Live instances, so Electron does not collect a toast before it is clicked. */
  const live = [];

  /**
   * `Notification.isSupported()` is asked once, lazily, on the first item that
   * would be shown — the shell does the same before its own update toast
   * (`lib/main.js` line ~17,155: `if (!Notification.isSupported()) return;`).
   * Asking lazily keeps a bridge that only renders a menu from paying for it, and
   * asking here rather than at construction keeps "no Notification injected"
   * distinguishable from "this OS cannot toast" in `status()`.
   *
   * @returns {boolean}
   */
  function supported() {
    if (supportedChecked) return state.available;
    supportedChecked = true;
    if (state.available !== true) return false;
    try {
      // A class without `isSupported` counts as capable: the real Electron
      // Notification always has it, so its absence means a stub, not an OS that
      // cannot show toasts.
      if (typeof provider.isSupported === 'function') state.available = provider.isSupported() === true;
      if (state.available !== true) state.lastError = 'this platform does not support notifications';
    } catch (error) {
      state.available = false;
      state.lastError = 'notification capability probe failed: ' + messageOf(error);
    }
    return state.available;
  }

  /**
   * Restore the dedupe memory from `notify.state.json`.
   *
   * WHY PERSIST AT ALL when an in-process set would do for one run: the desktop
   * app restarts (the user quits, DSH updates, the Host reloads a plugin) and
   * `notify.json` survives on disk. Without a persisted watermark the first poll
   * after every restart would replay whatever is left in the file — the exact
   * opposite of what a one-shot notification means.
   *
   * Two persisted facts, because they answer two different failure modes:
   *  - `rev` is monotonic only inside one Host process (the writer keeps its
   *    counter in memory), so a Host restart can produce a LOWER document rev
   *    than the persisted watermark. That is detected in `poll()` (the
   *    "new writer epoch" reset) — otherwise the channel would stay muted until
   *    the writer had issued as many notifications as the old watermark.
   *  - the id ring is what keeps the recent handful from replaying when that
   *    reset happens over a file a crashed writer left behind.
   */
  function loadState() {
    if (stateDir === null) return;
    const stored = readJsonState(stateDir + '/' + FILES.notifyState);
    if (!isObject(stored)) return;
    const storedRev = countOf(stored.rev);
    state.rev = storedRev === null ? 0 : storedRev;
    if (Array.isArray(stored.ids)) {
      recentIds = stored.ids
        .filter((entry) => typeof entry === 'string' && entry !== '')
        .slice(-RECENT_ID_LIMIT);
      for (const id of recentIds) shownIds.add(id);
    }
    state.stateRestored = true;
  }

  /** Persist the watermark. A failure is survivable (worst case: a replay). */
  function saveState() {
    if (stateDir === null) return;
    const text = JSON.stringify({ protocol: PROTOCOL_NOTIFY, rev: state.rev, ids: recentIds }) + '\n';
    const written = writeTextAtomic(stateDir + '/' + FILES.notifyState, text);
    if (written.ok !== true) state.lastError = 'notify.state.json write failed: ' + written.error;
  }

  /** Keep the id ring de-duplicated, ordered oldest→newest, and bounded. */
  function rememberId(id) {
    recentIds = recentIds.filter((entry) => entry !== id).concat([id]).slice(-RECENT_ID_LIMIT);
    shownIds.add(id);
    if (shownIds.size > SEEN_ID_LIMIT) {
      // Bounded memory on a long session: the ring above is what survives, and
      // the rev watermark is the primary rule anyway.
      const keep = new Set(recentIds);
      for (const entry of shownIds) {
        if (keep.has(entry) !== true) shownIds.delete(entry);
      }
    }
  }

  /**
   * Sliding-window rate limiter. True when this show may proceed.
   *
   * The window is measured from the OLDEST show still inside it, so exactly N
   * shows are allowed per `NOTIFY_RATE_WINDOW_MS` and the (N+1)th waits; a
   * fixed-bucket counter would let 2N through around a bucket boundary.
   *
   * @returns {boolean}
   */
  function allowShow() {
    let clock;
    try {
      clock = now();
    } catch (_error) {
      clock = 0; // An unreadable clock must not block a legitimate notification.
    }
    if (typeof clock !== 'number' || Number.isFinite(clock) !== true) clock = 0;
    while (shownAt.length > 0 && clock - shownAt[0] >= NOTIFY_RATE_WINDOW_MS) shownAt.shift();
    if (shownAt.length >= NOTIFY_RATE_LIMIT) return false;
    shownAt.push(clock);
    return true;
  }

  /** Drop the oldest live reference; also stop listening to it. */
  function evictLive() {
    while (live.length > LIVE_LIMIT) {
      const oldest = live.shift();
      try {
        if (isObject(oldest) && typeof oldest.removeAllListeners === 'function') oldest.removeAllListeners();
      } catch (_error) {
        // A native object that refuses to drop its listeners is not fatal.
      }
    }
  }

  /**
   * Show one normalised item. Every failure is recorded and none is thrown: this
   * runs inside the poll tick, where a throw would only reach the timer's own
   * catch and disappear.
   *
   * The options object is exactly `{ title, body, silent }`: those three are the
   * fields the document is allowed to set, so a hostile document cannot smuggle
   * a path or a callback into the native constructor.
   *
   * @param {object} item normalised item
   * @returns {boolean} true when `show()` was reached without throwing
   */
  function show(item) {
    let instance;
    try {
      instance = new provider({
        title: item.title,
        body: item.body,
        silent: item.silent,
      });
    } catch (error) {
      state.lastError = 'notification construction failed: ' + messageOf(error);
      return false;
    }
    if (isObject(instance) !== true || typeof instance.show !== 'function') {
      state.lastError = 'the injected notification constructor returned no show() method';
      return false;
    }

    if (item.urgency !== null) {
      // `urgency` is Linux-only in Electron; forwarding it where it is ignored
      // is harmless, forwarding an unvalidated value is not — hence the set test
      // in `normalizeItem`.
      try {
        instance.urgency = item.urgency;
      } catch (_error) {
        // A read-only native property: the toast still works without it.
      }
    }

    try {
      if (typeof instance.on === 'function') {
        instance.on('failed', (_event, error) => {
          try {
            state.lastError = 'notification failed: ' + messageOf(error);
          } catch (_ignored) {
            // Diagnostics only.
          }
        });
      }
      if (typeof instance.once === 'function') {
        instance.once('click', () => {
          try {
            emit({ type: 'notify-click', id: item.id, owner: item.owner });
          } catch (_error) {
            // A lost click is a lost diagnostic line, never a lost menu.
          }
        });
      }
      instance.show();
    } catch (error) {
      state.lastError = 'notification.show failed: ' + messageOf(error);
      return false;
    }

    live.push(instance);
    evictLive();
    return true;
  }

  /**
   * Consume one item without showing it (rate limit, failed show).
   *
   * The watermark advances anyway: the toast was for "now", and showing it a
   * minute later would be a worse lie than dropping it.
   *
   * @param {object} item
   */
  function consume(item) {
    if (item.rev > state.rev) state.rev = item.rev;
    rememberId(item.id);
  }

  /**
   * Poll the document once. Never throws.
   *
   * Decision order per item, and why it is that order:
   *  1. id already shown → duplicate, skip (the strongest statement: an id is
   *     unique per notification, so seeing it again is a replay no matter what
   *     its rev says);
   *  2. rev not newer than the watermark → already shown before this process
   *     started, or older than something shown then;
   *  3. no usable `Notification` → skip WITHOUT consuming: nothing was
   *     attempted, so the item stays pending instead of being silently lost;
   *  4. rate limited → consume + count;
   *  5. show failed → consume + record the reason.
   *
   * @returns {{ shown: number, skipped: number, reason: string | null }}
   */
  function poll() {
    const result = { shown: 0, skipped: 0, reason: null };
    if (state.disposed) return result;

    let source;
    try {
      source = stateDir === null
        ? { kind: 'missing', text: null, error: null }
        : readContributionSource(stateDir + '/' + FILES.notify, {
          maxBytes: NOTIFY_MAX_BYTES,
          label: 'notify.json',
        });
    } catch (error) {
      state.lastError = 'reading notify.json failed: ' + messageOf(error);
      result.reason = state.lastError;
      return result;
    }

    const parsed = parseDocument(source);
    if (parsed.ok !== true) {
      // A bad document is reported and NOTHING else happens: the tray keeps the
      // menu it already has, and no toast pretends the file was fine.
      state.invalid += 1;
      state.lastError = parsed.reason;
      result.reason = parsed.reason;
      return result;
    }
    if (parsed.items.length === 0) return result;

    // A writer restart resets its own counter, so a document rev BELOW the
    // persisted watermark means "this is a new writer epoch", not "these items
    // are older". Reset the watermark and let the id ring absorb replays.
    if (parsed.rev < state.rev) state.rev = 0;

    let consumed = 0;
    for (const item of parsed.items) {
      if (shownIds.has(item.id)) {
        state.duplicates += 1;
        result.skipped += 1;
        continue;
      }
      if (item.rev <= state.rev) {
        result.skipped += 1;
        continue;
      }
      if (supported() !== true) {
        result.skipped += 1;
        continue;
      }
      if (allowShow() !== true) {
        state.rateLimited += 1;
        consume(item);
        consumed += 1;
        result.skipped += 1;
        continue;
      }
      if (show(item) !== true) {
        consume(item);
        consumed += 1;
        result.skipped += 1;
        continue;
      }
      if (item.rev > state.rev) state.rev = item.rev;
      rememberId(item.id);
      consumed += 1;
      state.shown += 1;
      result.shown += 1;
    }

    if (consumed > 0) saveState();
    return result;
  }

  loadState();

  return {
    poll,

    /** @returns {object} the `status().notify` document */
    status() {
      return {
        available: state.available,
        shown: state.shown,
        lastError: state.lastError,
        rev: state.rev,
        rateLimited: state.rateLimited,
        invalid: state.invalid,
        duplicates: state.duplicates,
        stateRestored: state.stateRestored,
        disposed: state.disposed,
      };
    },

    /** Stop polling and drop every live reference. The toasts are not destroyed. */
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      try {
        for (const instance of live) {
          if (isObject(instance) && typeof instance.removeAllListeners === 'function') {
            instance.removeAllListeners();
          }
        }
      } catch (_error) {
        // Nothing useful to do at teardown.
      }
      live.length = 0;
      shownAt.length = 0;
      shownIds.clear();
    },
  };
}

/**
 * The item ceiling the Host writer and the bridge agree on.
 *
 * Exported so `lib/host/notify-registry.js` caps its queue by the same number
 * instead of typing 64 a second time.
 */
export const NOTIFY_ITEM_LIMIT = MAX_DOCUMENT_ITEMS;
