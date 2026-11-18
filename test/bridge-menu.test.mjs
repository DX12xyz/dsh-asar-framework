/**
 * Menu rendering tests: the official three entries, contribution merging and
 * the red line that a user must never be able to tell a bridged tray from a
 * stock one when there is nothing to contribute.
 *
 * `node --test test/bridge-menu.test.mjs`
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MESSAGES, lastTemplate, makeBridge, outline, withHome } from './bridge-harness.mjs';

/** The stock shell's own template, transcribed from the 1,253-byte region. */
function stockOutline(messages) {
  return [
    { label: messages.openApplication, type: undefined, clickable: true },
    { label: undefined, type: 'separator' },
    { label: messages.quitApplication, type: undefined, clickable: true },
  ];
}

test('no menu.json renders exactly the official three entries', () =>
  withHome((home) => {
    const { bridge, tray, menu } = makeBridge({ home });
    const result = bridge.relabel(MESSAGES);
    assert.deepEqual(result, { ok: true });

    assert.equal(tray.tooltips.length, 1, 'the tooltip must be set once');
    assert.equal(tray.tooltips[0], MESSAGES.aboutProduct);
    assert.equal(tray.contextMenus.length, 1, 'the context menu must be set once');

    const template = lastTemplate(menu);
    assert.equal(template.length, 3);
    assert.deepEqual(outline(template), stockOutline(MESSAGES));
    // The fallback must be *structurally* identical to the stock menu: same
    // key set per entry, no extra ids, no extra flags.
    assert.deepEqual(Object.keys(template[0]).sort(), ['click', 'label']);
    assert.deepEqual(Object.keys(template[1]).sort(), ['type']);
    assert.deepEqual(Object.keys(template[2]).sort(), ['click', 'label']);

    bridge.dispose();
  }));

test('official entries use the messages passed to relabel, not a cached copy', () =>
  withHome((home) => {
    const { bridge, menu } = makeBridge({ home });
    bridge.relabel({ aboutProduct: 'Produit', openApplication: 'Ouvrir', quitApplication: 'Quitter' });
    const template = lastTemplate(menu);
    assert.equal(template[0].label, 'Ouvrir');
    assert.equal(template[2].label, 'Quitter');
    bridge.relabel({ aboutProduct: 'A', openApplication: 'B', quitApplication: 'C' });
    const second = lastTemplate(menu);
    assert.equal(second[0].label, 'B');
    assert.equal(second[2].label, 'C');
    bridge.dispose();
  }));

test('official click handlers call the shell open/quit actions', () =>
  withHome((home) => {
    const { bridge, menu, options } = makeBridge({ home });
    bridge.relabel(MESSAGES);
    const template = lastTemplate(menu);
    template[0].click();
    template[2].click();
    assert.equal(options.calls.open, 1);
    assert.equal(options.calls.quit, 1);
    // The official entries never write events: opening and quitting are local.
    assert.equal(home.exists('events.jsonl'), false);
    bridge.dispose();
  }));

test('contributions are inserted between the official entries in order', () =>
  withHome((home) => {
    const { bridge, menu } = makeBridge({ home });
    home.write(
      'menu.json',
      JSON.stringify({
        protocol: 2,
        rev: 4,
        items: [
          { id: 'x/late', label: 'Late', order: 30 },
          { id: 'x/early', label: 'Early', order: 10 },
          { id: 'x/mid', label: 'Mid', order: 20 },
        ],
      }),
    );
    bridge.relabel(MESSAGES);
    const template = lastTemplate(menu);
    assert.deepEqual(outline(template), [
      { label: MESSAGES.openApplication, type: undefined, clickable: true },
      { label: undefined, type: 'separator' },
      { label: 'Early', type: undefined, id: 'x/early', clickable: true },
      { label: 'Mid', type: undefined, id: 'x/mid', clickable: true },
      { label: 'Late', type: undefined, id: 'x/late', clickable: true },
      { label: MESSAGES.quitApplication, type: undefined, clickable: true },
    ]);
    bridge.dispose();
  }));

test('items without order keep their array order, after ordered ones', () =>
  withHome((home) => {
    const { bridge, menu } = makeBridge({ home });
    home.write(
      'menu.json',
      JSON.stringify({
        protocol: 2,
        rev: 1,
        items: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B', order: 5 },
          { id: 'c', label: 'C' },
        ],
      }),
    );
    bridge.relabel(MESSAGES);
    const template = lastTemplate(menu);
    assert.deepEqual(template.slice(2, 5).map((option) => option.label), ['B', 'A', 'C']);
    bridge.dispose();
  }));

test('checkbox, submenu and separator contributions render with the right shape', () =>
  withHome((home) => {
    const { bridge, menu } = makeBridge({ home });
    home.write(
      'menu.json',
      JSON.stringify({
        protocol: 2,
        rev: 9,
        items: [
          {
            id: 'demo/submenu',
            type: 'submenu',
            label: 'Submenu',
            items: [
              { id: 'demo/child-a', label: 'Child A' },
              { id: 'demo/child-b', type: 'checkbox', label: 'Child B', checked: true },
            ],
          },
          { id: 'demo/checkbox', type: 'checkbox', label: 'Checkbox', checked: false },
          { id: 'demo/separator', type: 'separator' },
          { id: 'demo/disabled', label: 'Disabled', enabled: false },
          { id: 'demo/hidden', label: 'Hidden', visible: false },
        ],
      }),
    );
    bridge.relabel(MESSAGES);
    const template = lastTemplate(menu);
    const submenu = template[2];
    assert.equal(submenu.type, undefined);
    assert.equal(submenu.label, 'Submenu');
    assert.equal(submenu.id, 'demo/submenu');
    assert.equal(submenu.submenu.length, 2);
    assert.equal(submenu.submenu[0].label, 'Child A');
    assert.equal(submenu.submenu[1].type, 'checkbox');
    assert.equal(submenu.submenu[1].checked, true);

    const checkbox = template[3];
    assert.equal(checkbox.type, 'checkbox');
    assert.equal(checkbox.label, 'Checkbox');
    assert.equal(checkbox.checked, undefined, 'an unchecked box must not emit checked:false');

    const separator = template[4];
    assert.deepEqual(Object.keys(separator).sort(), ['id', 'type']);
    assert.equal(separator.type, 'separator');

    assert.equal(template[5].enabled, false);
    assert.equal(template[6].visible, false);
    bridge.dispose();
  }));

test('labels resolve {messages.key} placeholders and labelKey lookups', () =>
  withHome((home) => {
    const { bridge, menu } = makeBridge({ home });
    home.write(
      'menu.json',
      JSON.stringify({
        protocol: 2,
        rev: 2,
        items: [
          { id: 'p1', label: 'Open: {messages.openApplication}' },
          { id: 'p2', labelKey: 'quitApplication' },
          { id: 'p3', label: 'Unknown: {messages.nope}' },
        ],
      }),
    );
    bridge.relabel(MESSAGES);
    const template = lastTemplate(menu);
    assert.equal(template[2].label, 'Open: ' + MESSAGES.openApplication);
    assert.equal(template[3].label, MESSAGES.quitApplication);
    assert.equal(template[4].label, 'Unknown: {messages.nope}', 'an unknown key stays visible verbatim');
    assert.equal(template[4].id, 'p3');
    bridge.dispose();
  }));

test('tray.tooltip from the contribution document overrides the product name', () =>
  withHome((home) => {
    const { bridge, tray } = makeBridge({ home });
    home.write(
      'menu.json',
      JSON.stringify({ protocol: 2, rev: 1, items: [{ id: 'i', label: 'Item' }], tray: { tooltip: 'Custom' } }),
    );
    bridge.relabel(MESSAGES);
    assert.equal(tray.tooltips[tray.tooltips.length - 1], 'Custom');
    bridge.dispose();
  }));

test('an empty contribution list still renders the official three', () =>
  withHome((home) => {
    const { bridge, tray, menu } = makeBridge({ home });
    home.write('menu.json', JSON.stringify({ protocol: 2, rev: 3, items: [] }));
    bridge.relabel(MESSAGES);
    assert.deepEqual(outline(lastTemplate(menu)), stockOutline(MESSAGES));
    assert.equal(tray.tooltips[0], MESSAGES.aboutProduct);
    bridge.dispose();
  }));

test('a contribution whose items are all unrenderable falls back to the official three', () =>
  withHome((home) => {
    const { bridge, menu } = makeBridge({ home });
    home.write(
      'menu.json',
      JSON.stringify({
        protocol: 2,
        rev: 1,
        items: [null, 42, { id: 'no-label' }, { id: 'empty-submenu', type: 'submenu', label: 'Empty', items: [] }],
      }),
    );
    bridge.relabel(MESSAGES);
    assert.deepEqual(outline(lastTemplate(menu)), stockOutline(MESSAGES));
    bridge.dispose();
  }));

test('an over-deep submenu is dropped instead of rendered forever', () =>
  withHome((home) => {
    const { bridge, menu } = makeBridge({ home });
    // MAX_MENU_DEPTH is 3: the top-level entry, one submenu level and its
    // children render; a submenu nested one level deeper is refused, which
    // empties its parent, which empties the top entry — so the contribution
    // collapses and the tray falls back to the official three.
    home.write(
      'menu.json',
      JSON.stringify({
        protocol: 2,
        rev: 1,
        items: [
          {
            id: 'd1',
            type: 'submenu',
            label: 'One',
            items: [
              {
                id: 'd2',
                type: 'submenu',
                label: 'Two',
                items: [
                  { id: 'd3', type: 'submenu', label: 'Three', items: [{ id: 'd4', label: 'Four' }] },
                ],
              },
            ],
          },
        ],
      }),
    );
    bridge.relabel(MESSAGES);
    assert.deepEqual(outline(lastTemplate(menu)), stockOutline(MESSAGES));
    bridge.dispose();
  }));

test('a two-level submenu renders its children', () =>
  withHome((home) => {
    const { bridge, menu } = makeBridge({ home });
    home.write(
      'menu.json',
      JSON.stringify({
        protocol: 2,
        rev: 1,
        items: [
          {
            id: 'd1',
            type: 'submenu',
            label: 'One',
            items: [{ id: 'd2', type: 'submenu', label: 'Two', items: [{ id: 'd3', label: 'Three' }] }],
          },
        ],
      }),
    );
    bridge.relabel(MESSAGES);
    const template = lastTemplate(menu);
    assert.equal(template.length, 4, 'two official entries + one top-level contribution + quit');
    assert.equal(template[2].label, 'One');
    assert.equal(template[2].submenu[0].label, 'Two');
    assert.equal(template[2].submenu[0].submenu[0].label, 'Three');
    bridge.dispose();
  }));
