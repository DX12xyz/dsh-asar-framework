/**
 * Menu composition: turn a protocol-2 contribution document into an Electron
 * menu template, always on top of the three official entries.
 *
 * The composition rules are deliberately total: every input shape maps to a
 * template, and anything unusable degrades to the official three rather than
 * throwing. A user must never lose the tray because a plugin wrote a bad file.
 */

import { MAX_MENU_DEPTH, PROTOCOL, messageOf } from './paths.js';

/** `{messages.key}` placeholder, resolved against the shell's message table. */
const PLACEHOLDER = /\{messages\.([A-Za-z0-9_]+)\}/g;

/** Labels used when the shell passes no usable message table. */
const EMPTY_MESSAGES = { aboutProduct: '', openApplication: '', quitApplication: '' };

/**
 * @param {unknown} value
 * @returns {boolean} true for a plain (non-array, non-null) object
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
 * Replace `{messages.key}` placeholders. A key the shell does not provide stays
 * verbatim: better a visible `{messages.foo}` than a silently empty label.
 *
 * @param {unknown} value
 * @param {Record<string, unknown>} messages
 * @returns {string | null} resolved text, or null when the input is not a string
 */
function resolveText(value, messages) {
  if (typeof value !== 'string') return null;
  if (value.indexOf('{messages.') < 0) return value;
  return value.replace(PLACEHOLDER, (match, key) => {
    const resolved = messages[key];
    return typeof resolved === 'string' ? resolved : match;
  });
}

/**
 * Resolve the label of a contribution item.
 *
 * Order: `labelKey` against the message table, then a `{messages.key}` template
 * in `label`, then the literal `label`. Items that resolve to nothing are
 * dropped — a blank row in a native menu is worse than no row.
 *
 * @param {Record<string, any>} item
 * @param {Record<string, unknown>} messages
 * @returns {string | null}
 */
function labelOf(item, messages) {
  if (typeof item.labelKey === 'string' && item.labelKey !== '') {
    const byKey = textOf(messages[item.labelKey]);
    if (byKey !== '') return byKey;
    const templated = resolveText(item.label, messages);
    if (templated !== null && templated !== '') return templated;
    return typeof item.label === 'string' ? item.labelKey : item.labelKey;
  }
  const resolved = resolveText(item.label, messages);
  if (resolved !== null) return resolved === '' ? null : resolved;
  return null;
}

/**
 * Copy the identity of a contribution onto the Electron option, so events can
 * be traced back to the owner that contributed the item.
 *
 * @param {Record<string, any>} option
 * @param {Record<string, any>} item
 */
function attachId(option, item) {
  if (typeof item.id === 'string' && item.id !== '') option.id = item.id;
}

/**
 * Apply the shared display flags.
 *
 * `enabled` and `visible` are only copied when explicitly false: Electron
 * already defaults both to true, and emitting every default would make the
 * template noisy and hard to diff against the stock one.
 *
 * @param {Record<string, any>} option
 * @param {Record<string, any>} item
 * @param {Record<string, unknown>} messages
 */
function applyDisplayFlags(option, item, messages) {
  if (item.enabled === false) option.enabled = false;
  if (item.visible === false) option.visible = false;
  const tooltip = resolveText(item.tooltip, messages);
  if (tooltip !== null && tooltip !== '') option.tooltip = tooltip;
}

/**
 * Build the click callback that reports the interaction on the event channel.
 *
 * The callback is intentionally inert with respect to failures: whatever the
 * emitter does, a native click must not become an exception inside Electron's
 * dispatch loop. Checkbox clicks report the *flipped* state, read from the live
 * native menu item when Electron passes one.
 *
 * @param {{ messages: Record<string, unknown>, emit: (record: object) => void }} context
 * @param {Record<string, any>} item contribution node
 * @param {number[]} path rendered tree path of this item
 * @param {boolean} isCheckbox
 * @param {boolean} initialChecked
 * @returns {(menuItem?: unknown) => void}
 */
function makeClick(context, item, path, isCheckbox, initialChecked) {
  const itemId = itemIdOf(item);
  return function onClick(menuItem) {
    let checked;
    if (isCheckbox) {
      const live = isObject(menuItem) ? menuItem.checked : undefined;
      checked = typeof live === 'boolean' ? live : !initialChecked;
    }
    try {
      context.emit({
        type: isCheckbox ? 'toggle' : 'click',
        id: itemId,
        path: path.slice(),
        checked,
      });
    } catch (_error) {
      // The event channel is diagnostic; a failure there must not break clicks.
    }
  };
}

/**
 * Build the three official entries exactly as the stock shell builds them
 * (`{label, click}`, `{type:'separator'}`, `{label, click}`) so a user cannot
 * tell a bridged tray from a stock one.
 *
 * @param {Record<string, unknown>} messages
 * @param {{ open: () => void, quit: () => void }} actions
 * @returns {object[]} Electron menu template
 */
export function officialTemplate(messages, actions) {
  return [
    {
      label: textOf(messages.openApplication),
      click: () => {
        actions.open();
      },
    },
    { type: 'separator' },
    {
      label: textOf(messages.quitApplication),
      click: () => {
        actions.quit();
      },
    },
  ];
}

/**
 * Render one contribution node (top level or submenu child).
 *
 * @param {unknown} item
 * @param {number[]} path rendered tree path
 * @param {number} depth 1 for top-level items
 * @param {{ messages: Record<string, unknown>, emit: (record: object) => void }} context
 * @returns {{ kind: string, option: object } | null} null when the node is not renderable
 */
function buildNode(item, path, depth, context) {
  if (!isObject(item)) return null;
  const declaredType = item.type;
  const type =
    declaredType === 'checkbox' || declaredType === 'submenu' || declaredType === 'separator'
      ? declaredType
      : 'normal';

  if (type === 'separator') {
    const option = { type: 'separator' };
    attachId(option, item);
    return { kind: 'separator', option };
  }

  const label = labelOf(item, context.messages);
  if (label === null) return null;

  const option = { label };
  attachId(option, item);

  if (type === 'submenu') {
    if (depth >= MAX_MENU_DEPTH) return null;
    // Submenu children keep their declaration order; only top-level items are
    // reordered by `order` (design/PHASE1-SPEC.md §4.3, reference §3.2).
    const children = renderItems(item.items, path, depth + 1, context, true);
    if (children.length === 0) return null;
    option.submenu = children.map((child) => child.option);
    applyDisplayFlags(option, item, context.messages);
    return { kind: 'submenu', option };
  }

  if (type === 'checkbox') {
    option.type = 'checkbox';
    const initialChecked = item.checked === true;
    if (initialChecked) option.checked = true;
    option.click = makeClick(context, item, path, true, initialChecked);
  } else {
    option.click = makeClick(context, item, path, false, false);
  }

  applyDisplayFlags(option, item, context.messages);
  return { kind: type, option };
}

/**
 * @param {Record<string, any>} item
 * @returns {string | null} the contribution identity, for event records
 */
function itemIdOf(item) {
  return typeof item.id === 'string' && item.id !== '' ? item.id : null;
}

/**
 * @param {Record<string, any>} item
 * @returns {number | null} the declared numeric `order`, or null when absent
 */
function orderKey(item) {
  const order = item.order;
  return typeof order === 'number' && Number.isFinite(order) ? order : null;
}

/**
 * Render an `items` level: sort top-level entries by `order`, then emit one
 * option per renderable node. Paths index the *rendered* level (separators
 * included, official entries excluded), which is the contract the Host uses to
 * resolve events.
 *
 * Ordering is total and documented: entries with a numeric `order` come first,
 * ascending, ties broken by declaration position; entries without `order`
 * follow in declaration order. Mixing the two groups by array position instead
 * would let a stray index outrank an explicit `order`, which is exactly the
 * kind of surprise a contribution author cannot debug.
 *
 * @param {unknown} items
 * @param {number[]} parentPath
 * @param {number} depth
 * @param {{ messages: Record<string, unknown>, emit: (record: object) => void }} context
 * @param {boolean} [preserveOrder] keep declaration order (submenu children)
 * @returns {{ kind: string, option: object }[]}
 */
function renderItems(items, parentPath, depth, context, preserveOrder = false) {
  if (!Array.isArray(items)) return [];
  const ordered = [];
  const unordered = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!isObject(item)) continue;
    const key = orderKey(item);
    const entry = { item, index, key };
    if (key === null) unordered.push(entry);
    else ordered.push(entry);
  }
  if (preserveOrder) ordered.length = 0;
  const sequence = preserveOrder
    ? unordered
    : ordered.sort((left, right) => left.key - right.key || left.index - right.index).concat(unordered);

  const rendered = [];
  for (const entry of sequence) {
    const path = parentPath.concat([rendered.length]);
    let node = null;
    try {
      node = buildNode(entry.item, path, depth, context);
    } catch (_error) {
      node = null; // One bad item must not cost the whole menu.
    }
    if (node !== null) rendered.push(node);
  }
  return rendered;
}

/**
 * Compose the full template for one poll tick.
 *
 * @param {{
 *   source: import('./paths.js').MenuSource,
 *   messages: Record<string, unknown>,
 *   emit: (record: object) => void,
 *   open: () => void,
 *   quit: () => void,
 * }} input
 * @returns {{ template: object[], tooltip: string, reason: 'empty' | 'ok' | 'error',
 *             rev: number, itemCount: number, lastError: string | null }}
 */
export function renderMenu(input) {
  const messages = isObject(input.messages) ? input.messages : EMPTY_MESSAGES;
  const actions = { open: input.open, quit: input.quit };
  const official = officialTemplate(messages, actions);
  const officialResult = {
    template: official,
    tooltip: textOf(messages.aboutProduct),
    reason: 'empty',
    rev: 0,
    itemCount: 0,
    lastError: null,
  };

  const source = input.source;
  if (source === null || source === undefined) return officialResult;
  if (source.kind === 'missing') return officialResult;
  if (source.kind !== 'text') {
    return failureResult(officialResult, source.error === null ? 'menu.json is unavailable' : source.error);
  }

  let document;
  try {
    document = JSON.parse(source.text);
  } catch (error) {
    return failureResult(officialResult, 'menu.json is not valid JSON: ' + messageOf(error));
  }
  if (!isObject(document)) return failureResult(officialResult, 'menu.json is not a JSON object');
  if (document.protocol !== PROTOCOL) {
    return failureResult(officialResult, 'menu.json protocol is not ' + PROTOCOL);
  }

  const items = document.items;
  if (items === null || items === undefined) return officialResult;
  if (!Array.isArray(items)) return failureResult(officialResult, 'menu.json items is not an array');
  if (items.length === 0) return officialResult;

  const rendered = renderItems(items, [], 1, { messages, emit: input.emit });
  if (rendered.length === 0) return officialResult;

  const trayDocument = document.tray;
  const tooltipOverride = isObject(trayDocument) ? resolveText(trayDocument.tooltip, messages) : null;
  const rev = typeof document.rev === 'number' && Number.isFinite(document.rev) ? document.rev : 0;

  return {
    template: official.slice(0, 2).concat(rendered.map((node) => node.option), official.slice(2)),
    tooltip: tooltipOverride !== null && tooltipOverride !== '' ? tooltipOverride : textOf(messages.aboutProduct),
    reason: 'ok',
    rev,
    itemCount: rendered.length,
    lastError: null,
  };
}

/**
 * @param {object} officialResult
 * @param {string | null} error
 * @returns {object} the official three plus a recorded failure
 */
function failureResult(officialResult, error) {
  return {
    template: officialResult.template,
    tooltip: officialResult.tooltip,
    reason: 'error',
    rev: 0,
    itemCount: 0,
    lastError: error === null ? 'unknown error' : error,
  };
}
