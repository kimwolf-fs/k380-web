import test from 'node:test';
import assert from 'node:assert/strict';
import {saveSource, resolveSource, clearSourceSlot} from './macro-source-store.mjs';
import {compileMacro, prepareMacroDraft} from './macro-compiler.mjs';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import * as uiModel from './ui-model.mjs';
import * as keymap from './keymap.mjs';

const appSource = await readFile(new URL('./app.mjs', import.meta.url), 'utf8');

function application(readMacro, overrides = {}) {
  const elements = new Map();
  const editors = [];
  function element() {
    return {
      value: '0', textContent: '', children: [], listeners: {}, dataset: {},
      classList: {toggle() {}, add() {}, remove() {}},
      style: {setProperty() {}},
      setAttribute() {}, querySelectorAll() { return []; },
      addEventListener(type, handler) { this.listeners[type] = handler; },
      replaceChildren() { this.children = []; },
      append(...children) { this.children.push(...children); }
    };
  }
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    querySelectorAll() { return []; }, createElement: element, addEventListener() {}
  };
  const summary = {activePreset: 0, presets: Array.from({length: 4}, (_, id) => ({id, name: ''}))};
  const context = {
    ...uiModel, ...keymap, compileMacro, prepareMacroDraft, resolveSource,
    saveSource: overrides.saveSource ?? saveSource, clearSourceSlot, readMacro,
    saveMacro: overrides.saveMacro, saveBindings: overrides.saveBindings,
    savePresetName: overrides.savePresetName,
    uploadTestMacro: overrides.uploadTestMacro,
    describeError: error => error.message,
    document, navigator: {serial: {requestPort: async () => ({getInfo: () => ({usbVendorId: 0x1d50, usbProductId: 0x615e})})}},
    isSecureContext: true, localStorage: storage(),
    setTimeout: () => 1, clearTimeout() {},
    K380Connection: class {
      async open() {} async close() {} async exchange() { return new Uint8Array(); }
    },
    decodeInfo: () => ({protocolVersion: 2, presetCount: 4, layerCount: 2, keyCount: 80}),
    decodePresets: () => summary,
    decodeBindings: () => ({layers: Array.from({length: 2}, () => Array.from({length: 80}, () => ({type: 0, keyUsage: 0})))}),
    window: {
      confirm: overrides.confirm ?? (() => true), addEventListener() {},
      K380MacroSourceEditor: {create(host, options) {
        const editor = {
          value: options.value, destroyed: false,
          cm: {setOption() {}, lineCount: () => editor.value.split('\n').length},
          getValue() { assert.equal(this.destroyed, false); return this.value; },
          clearLineResults() {}, setLineResult() {},
          clear() { this.value = ''; options.onChange(); },
          focus() {},
          destroy() { this.destroyed = true; host.textContent = ''; }
        };
        editors.push(editor);
        return editor;
      }}
    }
  };
  runInNewContext(appSource.replace(/import\s+[\s\S]*?;\r?\n/g, '') + `
    globalThis.app = {loadMacro, clearPresets, invalidateMacroSelection, readMacroEditorSource, clearMacroDraft,
      selection: () => selectedMacroSlot,
      clickSlot: slot => document.querySelector('#macro-slots-list').children[slot].listeners.click(),
      setPresetDraft: binding => { draft[0][10] = binding; },
      setPresetDraftAt: (layer, keyIndex, binding) => { draft[layer][keyIndex] = binding; renderEditor(); },
      discardPresetDraft: () => { draft = cloneLayers(original); },
      setMacroBinding: () => {
        document.querySelector('#macro-target').value = '0:25';
        applyMacroTarget();
      },
      setMacroSource: source => { macroEditor.value = source; macroSourceChanged(); },
      bindingChanges: () => countBindingChanges(draft, original),
      bindingAt: (layer, keyIndex) => ({draft: {...draft[layer][keyIndex]}, original: {...original[layer][keyIndex]}}),
      setStatus,
      setBusy: value => { busy = value; setControls(); },
      selectSlot: slot => { clearMacroDetails(); selectedMacroSlot = slot; return loadMacro(slot); }};`, context);
  return {app: context.app, elements, editors, local: context.localStorage};
}

const emptySlot = () => ({name: '', trigger: 0, repeatCount: 1, packageCrc32: 0, package: new Uint8Array()});

test('name save writes only the preset name and leaves key drafts untouched', async () => {
  const calls = [];
  const page = application(async () => emptySlot(), {
    savePresetName: async (_connection, preset, name) => {
      calls.push(['name', preset, name]);
      return {activePreset: 0, presets: Array.from({length: 4}, (_, id) => ({id, name: id ? '' : name}))};
    },
    saveBindings: async () => { calls.push(['bindings']); throw new Error('unexpected binding save'); }
  });
  await page.elements.get('#connect').listeners.click();
  page.app.setPresetDraftAt(0, 20, {type: 1, keyUsage: 74});
  page.elements.get('#preset-name').value = '办公';
  page.elements.get('#preset-name').listeners.input();

  await page.elements.get('#save-name').listeners.click();

  assert.deepEqual(calls, [['name', 0, '办公']]);
  assert.equal(page.app.bindingChanges(), 1);
});

test('key save writes key drafts without saving a dirty unrelated macro', async () => {
  const calls = [];
  const page = application(async () => emptySlot(), {
    saveMacro: async () => { calls.push(['macro']); throw new Error('unexpected macro save'); },
    saveBindings: async (_connection, preset, layers) => {
      calls.push(['bindings', layers[0][20]]);
      return {preset, layers};
    }
  });
  await page.elements.get('#connect').listeners.click();
  await page.app.clickSlot(3);
  page.app.setMacroSource('点击 A');
  page.app.setPresetDraftAt(0, 20, {type: 1, keyUsage: 74});

  await page.elements.get('#save-bindings').listeners.click();

  assert.deepEqual(calls, [['bindings', {type: 1, keyUsage: 74}]]);
  assert.equal(page.elements.get('#save-macro').disabled, false);
  assert.equal(page.app.bindingChanges(), 0);
});

test('macro save submits only its target and preserves unrelated key drafts', async () => {
  const calls = [];
  const page = application(async () => emptySlot(), {
    saveMacro: async (_connection, _preset, _slot, compiled) => {
      calls.push(['macro']);
      return compiled;
    },
    saveBindings: async (_connection, preset, layers) => {
      calls.push(['bindings', layers[0][20], layers[0][25]]);
      return {preset, layers};
    }
  });
  await page.elements.get('#connect').listeners.click();
  await page.app.clickSlot(3);
  page.app.setPresetDraftAt(0, 20, {type: 1, keyUsage: 74});
  page.app.setMacroBinding();
  page.app.setMacroSource('点击 A');

  await page.elements.get('#save-macro').listeners.click();

  assert.deepEqual(calls, [
    ['macro'],
    ['bindings', {type: 0, keyUsage: 0}, {type: 2, macroIndex: 3}]
  ]);
  const binding = page.app.bindingAt(0, 20);
  assert.equal(binding.draft.type, 1);
  assert.equal(binding.draft.keyUsage, 74);
  assert.equal(binding.original.type, 0);
  assert.equal(binding.original.keyUsage, 0);
  assert.equal(page.app.bindingChanges(), 1);
});

test('key save rejects a binding to the currently dirty macro', async () => {
  const calls = [];
  const page = application(async () => emptySlot(), {
    saveBindings: async () => { calls.push('bindings'); }
  });
  await page.elements.get('#connect').listeners.click();
  await page.app.clickSlot(3);
  page.app.setMacroSource('点击 A');
  page.app.setPresetDraftAt(0, 20, {type: 2, macroIndex: 3});

  await page.elements.get('#save-bindings').listeners.click();

  assert.deepEqual(calls, []);
  assert.match(page.elements.get('#status').textContent, /先保存宏 4/);
});

test('macro save rejects a target occupied by an ordinary key draft', async () => {
  const calls = [];
  const page = application(async () => emptySlot(), {
    saveMacro: async () => { calls.push('macro'); }
  });
  await page.elements.get('#connect').listeners.click();
  await page.app.clickSlot(3);
  page.app.setPresetDraftAt(0, 25, {type: 1, keyUsage: 74});
  page.app.setMacroBinding();
  page.app.setMacroSource('点击 A');

  await page.elements.get('#save-macro').listeners.click();

  assert.deepEqual(calls, []);
  assert.match(page.elements.get('#macro-run-status').textContent, /冲突/);
});

test('selected macro slot can be read again from the device', async () => {
  let reads = 0;
  const {app, elements} = application(async () => { reads++; return emptySlot(); });
  await elements.get('#connect').listeners.click();
  await app.clickSlot(0);
  await app.clickSlot(0);
  assert.equal(reads, 2);
});

test('confirmed preset edits do not prevent macro loading and discard allows another read', async () => {
  let reads = 0;
  let confirmations = 0;
  const {app, elements} = application(async () => { reads++; return emptySlot(); }, {
    confirm: () => { confirmations++; return true; }
  });
  await elements.get('#connect').listeners.click();
  app.setPresetDraft({type: 1, keyUsage: 74});
  await app.clickSlot(0);
  assert.equal(confirmations, 1);
  assert.equal(reads, 1);
  app.discardPresetDraft();
  await app.clickSlot(0);
  assert.equal(confirmations, 1);
  assert.equal(reads, 2);
});

function storage() {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key), key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; }};
}

test('clearing an empty slot removes every old CRC source only for that preset and slot', () => {
  const local = storage();
  for (const crc of [123, 456]) saveSource(local, 2, 4, crc, '点击 A');
  saveSource(local, 2, 5, 123, '点击 B');
  saveSource(local, 1, 4, 123, '点击 C');
  clearSourceSlot(local, 2, 4);
  assert.equal(local.length, 2);
  assert.equal(local.getItem('k380-macro-source-v1:2:4:123'), null);
  assert.equal(local.getItem('k380-macro-source-v1:2:4:456'), null);
  assert.ok(local.getItem('k380-macro-source-v1:2:5:123'));
  assert.ok(local.getItem('k380-macro-source-v1:1:4:123'));
});

test('restores exact editable source only for matching preset slot and bytes', () => {
  const local = storage();
  const source = '# note\n点击 A\n';
  const compiled = compileMacro(source);
  saveSource(local, 2, 4, compiled.packageCrc32, source);
  assert.equal(resolveSource(local, 2, 4, compiled.packageCrc32, compiled.package), source);
  assert.equal(resolveSource(local, 2, 5, compiled.packageCrc32, compiled.package), null);
  assert.equal(resolveSource(local, 2, 4, compiled.packageCrc32 + 1, compiled.package), null);
  const changed = compiled.package.slice();
  changed[17] ^= 1;
  assert.equal(resolveSource(local, 2, 4, compiled.packageCrc32, changed), null);
});

test('corrupted or unavailable local storage does not invent source', () => {
  const compiled = compileMacro('点击 B');
  assert.equal(resolveSource({getItem() { throw new Error('blocked'); }}, 0, 0, compiled.packageCrc32, compiled.package), null);
  assert.equal(resolveSource({getItem() { return '{bad'; }}, 0, 0, compiled.packageCrc32, compiled.package), null);
});

test('does not restore source for an empty device slot', () => {
  const local = storage();
  assert.equal(resolveSource(local, 1, 2, 0, new Uint8Array()), null);
});

test('does not restore source when the local source cannot compile to the device package', () => {
  const local = storage();
  local.setItem('k380-macro-source-v1:1:2:123', JSON.stringify({version: 1, source: '坏源码'}));
  assert.equal(resolveSource(local, 1, 2, 123, Uint8Array.of(1)), null);
});

test('connect and preset selection do not read macros; clicking reads only its slot', async () => {
  const reads = [];
  const page = application(async (_connection, preset, slot) => { reads.push([preset, slot]); return emptySlot(); });
  assert.equal(page.app.selection(), null);
  await page.elements.get('#connect').listeners.click();
  assert.equal(page.elements.get('#status').textContent, '已连接');
  assert.equal(page.app.selection(), null);
  assert.deepEqual(reads, []);
  assert.equal(page.elements.get('#macro-slots-list').children.length, 16);
  assert.ok(page.elements.get('#macro-slots-list').children.every(button => button.textContent.includes('点击读取')));
  await page.elements.get('#macro-slots-list').children[2].listeners.click();
  assert.deepEqual(reads, [[0, 2]]);
  assert.equal(page.app.readMacroEditorSource(), '');
  const oldEditor = page.editors[0];
  await page.elements.get('#presets').children[1].listeners.click();
  assert.equal(oldEditor.destroyed, true);
  assert.equal(page.app.selection(), null);
  assert.deepEqual(reads, [[0, 2]]);
  await page.elements.get('#macro-slots-list').children[4].listeners.click();
  assert.deepEqual(reads, [[0, 2], [1, 4]]);
  await page.elements.get('#disconnect').listeners.click();
  assert.equal(page.editors[1].destroyed, true);
  assert.equal(page.app.selection(), null);
});

test('macro slot labels always keep their slot number', async () => {
  const page = application(async (_connection, _preset, slot) => ({
    ...emptySlot(),
    name: slot === 1 ? '测试' : ''
  }));
  await page.elements.get('#connect').listeners.click();
  assert.equal(page.elements.get('#macro-slots-list').children[0].textContent, '宏 1 · 点击读取');

  await page.elements.get('#macro-slots-list').children[0].listeners.click();
  assert.equal(page.elements.get('#macro-slots-list').children[0].textContent, '宏 1 · ');

  await page.elements.get('#macro-slots-list').children[1].listeners.click();
  assert.equal(page.elements.get('#macro-slots-list').children[1].textContent, '宏 2 · 测试');
});

test('switching slots destroys the editor before readback and ignores stale same-slot replies', async () => {
  const pending = [];
  const page = application(() => new Promise((resolve, reject) => pending.push({resolve, reject})));
  await page.elements.get('#connect').listeners.click();
  const first = page.elements.get('#macro-slots-list').children[1].listeners.click();
  pending[0].resolve(emptySlot());
  await first;
  const previous = page.editors[0];
  const stale = page.app.selectSlot(1);
  assert.equal(previous.destroyed, true);
  page.app.invalidateMacroSelection();
  const fresh = page.app.selectSlot(1);
  pending[2].resolve({...emptySlot(), name: 'new'});
  await fresh;
  pending[1].resolve({...emptySlot(), name: 'old'});
  await stale;
  assert.equal(page.elements.get('#macro-name').value, 'new');
  assert.equal(page.editors.length, 2);
});

test('stale failures cannot clear a newer slot editor', async () => {
  const pending = [];
  const page = application(() => new Promise((resolve, reject) => pending.push({resolve, reject})));
  await page.elements.get('#connect').listeners.click();
  const stale = page.app.selectSlot(2);
  page.app.clearPresets();
  const fresh = page.app.selectSlot(2);
  pending[1].resolve(emptySlot());
  await fresh;
  pending[0].reject(new Error('old failure'));
  await assert.doesNotReject(stale);
  assert.equal(page.editors.length, 1);
  assert.equal(page.editors[0].destroyed, false);
});

test('stale slot-click success does not finish or relabel a newer context', async () => {
  const pending = [];
  const page = application(() => new Promise((resolve, reject) => pending.push({resolve, reject})));
  await page.elements.get('#connect').listeners.click();
  const click = page.elements.get('#macro-slots-list').children[5].listeners.click();
  page.app.invalidateMacroSelection();
  page.app.setStatus('新上下文正在处理');
  page.app.setBusy(true);
  pending[0].resolve(emptySlot());
  await click;
  assert.equal(page.elements.get('#status').textContent, '新上下文正在处理');
  assert.equal(page.elements.get('#macro-slots-list').children[0].disabled, true);
});

test('stale slot-click failure does not finish or relabel a newer context', async () => {
  const pending = [];
  const page = application(() => new Promise((resolve, reject) => pending.push({resolve, reject})));
  await page.elements.get('#connect').listeners.click();
  const click = page.elements.get('#macro-slots-list').children[6].listeners.click();
  page.app.invalidateMacroSelection();
  page.app.setStatus('新上下文正在处理');
  page.app.setBusy(true);
  pending[0].reject(new Error('stale read failed'));
  await click;
  assert.equal(page.elements.get('#status').textContent, '新上下文正在处理');
  assert.equal(page.elements.get('#macro-slots-list').children[0].disabled, true);
});

test('device programs stay blank without exact local source and restore only verified source', async () => {
  const source = '# local comment\n点击 A\n';
  const compiled = compileMacro(source);
  const page = application(async () => ({...emptySlot(), package: compiled.package, packageCrc32: compiled.packageCrc32}));
  await page.elements.get('#connect').listeners.click();
  await page.elements.get('#macro-slots-list').children[3].listeners.click();
  assert.equal(page.app.readMacroEditorSource(), '');
  assert.match(page.elements.get('#macro-source-status').textContent, /本机没有匹配/);
  assert.equal(page.elements.get('#macro-source-notice').hidden, false);
  assert.match(page.elements.get('#macro-source-notice').textContent, /设备已有宏/);
  assert.match(page.elements.get('#macro-source-notice').textContent, /程序包.*字节/);
  saveSource(page.local, 0, 3, compiled.packageCrc32, source);
  page.app.invalidateMacroSelection();
  await page.elements.get('#macro-slots-list').children[3].listeners.click();
  assert.equal(page.app.readMacroEditorSource(), source);
  assert.equal(page.elements.get('#macro-source-notice').hidden, true);
});

for (const change of ['name', 'binding']) {
  test(`unavailable source cannot overwrite a nonempty device macro after changing only ${change}`, async () => {
    const stored = compileMacro('点击 A');
    const calls = [];
    const page = application(async () => ({...emptySlot(), ...stored}), {
      saveMacro: async () => { calls.push('macro write'); return emptySlot(); },
      saveBindings: async () => { calls.push('binding write'); }
    });
    await page.elements.get('#connect').listeners.click();
    await page.elements.get('#macro-slots-list').children[3].listeners.click();
    assert.equal(page.app.readMacroEditorSource(), '');
    assert.match(page.elements.get('#macro-source-status').textContent, /本机没有匹配/);
    if (change === 'name') {
      page.elements.get('#macro-name').value = '新名称';
      page.elements.get('#macro-name').listeners.input();
    } else {
      page.app.setMacroBinding();
    }
    await page.elements.get('#save-macro').listeners.click();
    assert.deepEqual(calls, []);
    assert.match(page.elements.get('#macro-run-status').textContent, /重新编辑|显式清空/);
    assert.equal(page.app.readMacroEditorSource(), '');
  });
}

test('explicit clear permits saving zero bytes over a source-unavailable device macro', async () => {
  const stored = compileMacro('点击 A');
  const uploads = [];
  const page = application(async () => ({...emptySlot(), ...stored}), {
    saveMacro: async (_connection, _preset, _slot, compiled) => {
      uploads.push(compiled.package.length);
      return emptySlot();
    }
  });
  await page.elements.get('#connect').listeners.click();
  await page.elements.get('#macro-slots-list').children[3].listeners.click();
  saveSource(page.local, 0, 3, 123, '点击 B');
  page.app.clearMacroDraft();
  assert.equal(page.elements.get('#save-macro').disabled, false);
  await page.elements.get('#save-macro').listeners.click();
  assert.deepEqual(uploads, [0]);
  assert.equal(page.local.length, 0);
  assert.match(page.elements.get('#macro-run-status').textContent, /已保存.*校验/);
});

test('a newly entered valid source replaces a source-unavailable macro normally', async () => {
  const stored = compileMacro('点击 A');
  const uploads = [];
  const page = application(async () => ({...emptySlot(), ...stored}), {
    saveMacro: async (_connection, _preset, _slot, compiled) => {
      uploads.push(compiled.package.length);
      return compiled;
    }
  });
  await page.elements.get('#connect').listeners.click();
  await page.elements.get('#macro-slots-list').children[3].listeners.click();
  page.editors[0].value = '点击 B';
  await page.elements.get('#save-macro').listeners.click();
  assert.deepEqual(uploads, [compileMacro('点击 B').package.length]);
  assert.equal(resolveSource(page.local, 0, 3, compileMacro('点击 B').packageCrc32,
    compileMacro('点击 B').package), '点击 B');
});

test('explicit clear intent does not carry to another source-unavailable slot', async () => {
  const stored = compileMacro('点击 A');
  const uploads = [];
  const page = application(async () => ({...emptySlot(), ...stored}), {
    saveMacro: async () => { uploads.push('macro write'); return emptySlot(); }
  });
  await page.elements.get('#connect').listeners.click();
  await page.elements.get('#macro-slots-list').children[3].listeners.click();
  page.app.clearMacroDraft();
  await page.app.selectSlot(4);
  page.elements.get('#macro-name').value = '新名称';
  page.elements.get('#macro-name').listeners.input();
  await page.elements.get('#save-macro').listeners.click();
  assert.deepEqual(uploads, []);
  assert.match(page.elements.get('#macro-run-status').textContent, /重新编辑|显式清空/);
});

test('macro readback followed by binding failure retains draft and does not save local source', async () => {
  const steps = [];
  const source = '点击 A';
  const compiled = compileMacro(source);
  const page = application(async () => emptySlot(), {
    saveMacro: async () => { steps.push('macro readback'); return compiled; },
    saveBindings: async () => { steps.push('binding readback failed'); throw new Error('绑定读回失败'); }
  });
  await page.elements.get('#connect').listeners.click();
  await page.elements.get('#macro-slots-list').children[3].listeners.click();
  saveSource(page.local, 0, 3, 123, '点击 B');
  page.editors[0].value = source;
  page.app.setMacroBinding();
  await page.elements.get('#save-macro').listeners.click();
  assert.deepEqual(steps, ['macro readback', 'binding readback failed']);
  assert.match(page.elements.get('#macro-run-status').textContent, /宏已保存.*绑定.*失败/);
  assert.equal(page.local.length, 1);
  assert.ok(page.local.getItem('k380-macro-source-v1:0:3:123'));
  assert.equal(page.app.readMacroEditorSource(), source);
  assert.equal(page.elements.get('#save-macro').disabled, false);
});

test('binding readback precedes local source write after macro readback', async () => {
  const steps = [];
  const source = '点击 A';
  const compiled = compileMacro(source);
  const page = application(async () => emptySlot(), {
    saveMacro: async () => { steps.push('macro readback'); return compiled; },
    saveBindings: async (_connection, preset, layers) => {
      steps.push('binding readback');
      return {preset, layers};
    },
    saveSource: (...args) => { steps.push('local source'); saveSource(...args); }
  });
  await page.elements.get('#connect').listeners.click();
  await page.elements.get('#macro-slots-list').children[3].listeners.click();
  page.editors[0].value = source;
  page.app.setMacroBinding();
  await page.elements.get('#save-macro').listeners.click();
  assert.deepEqual(steps, ['macro readback', 'binding readback', 'local source']);
  assert.equal(page.elements.get('#save-macro').disabled, true);
  assert.equal(page.app.readMacroEditorSource(), source);
});

test('empty page test displays no executable action without touching device', async () => {
  const steps = [];
  const page = application(async () => emptySlot(), {
    uploadTestMacro: async () => { steps.push('upload'); }
  });
  await page.elements.get('#connect').listeners.click();
  await page.elements.get('#macro-slots-list').children[3].listeners.click();
  await page.elements.get('#test-macro').listeners.click();
  assert.deepEqual(steps, []);
  assert.match(page.elements.get('#macro-run-status').textContent, /空宏没有可执行动作/);
});

test('empty page save is enabled and clears all old local CRC sources after readback', async () => {
  const steps = [];
  const page = application(async () => emptySlot(), {
    saveMacro: async (_connection, _preset, _slot, compiled) => {
      steps.push('macro readback');
      assert.equal(compiled.package.length, 0);
      return emptySlot();
    },
    saveBindings: async () => { throw new Error('no binding changes'); }
  });
  await page.elements.get('#connect').listeners.click();
  await page.elements.get('#macro-slots-list').children[3].listeners.click();
  saveSource(page.local, 0, 3, 123, '点击 A');
  saveSource(page.local, 0, 3, 456, '点击 B');
  saveSource(page.local, 0, 4, 123, '点击 C');
  page.elements.get('#macro-name').value = '清空';
  page.elements.get('#macro-name').listeners.input();
  assert.equal(page.elements.get('#save-macro').disabled, false);
  await page.elements.get('#save-macro').listeners.click();
  assert.deepEqual(steps, ['macro readback']);
  assert.equal(page.local.length, 1);
  assert.equal(page.local.getItem('k380-macro-source-v1:0:3:123'), null);
  assert.equal(page.local.getItem('k380-macro-source-v1:0:3:456'), null);
  assert.match(page.elements.get('#macro-run-status').textContent, /已保存.*校验/);
});
