import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  bindingEqual,
  buildMacroBindings,
  cloneLayers,
  countBindingChanges,
  createGenerationGate,
  filterUsageOptions,
  bindingVisualState,
  macroBindingConflicts,
  matchesKeyQuery,
  mergeConfirmedBindingsPreservingDraft,
  presetSavePlan,
  restoreKeyScope,
  restoreDraftKey,
  saveMacroStages
} from './ui-model.mjs';

test('macro stage result records confirmed macro and unconfirmed bindings', async () => {
  const steps = [];
  const result = await saveMacroStages(
    async () => { steps.push('macro readback'); return {packageCrc32: 42}; },
    async () => { steps.push('binding write/readback'); throw new Error('绑定读回失败'); }
  );
  assert.deepEqual(steps, ['macro readback', 'binding write/readback']);
  assert.equal(result.macroSaved, true);
  assert.equal(result.bindingsSaved, false);
  assert.match(result.error.message, /绑定读回失败/);
});

const blankLayers = () => Array.from(
  {length: 2},
  () => Array.from({length: 80}, () => ({type: 0, keyUsage: 0}))
);

test('binding equality compares the value selected by each binding type', () => {
  assert.equal(bindingEqual({type: 0, keyUsage: 0}, {type: 0, keyUsage: 0}), true);
  assert.equal(bindingEqual({type: 1, keyUsage: 74}, {type: 1, keyUsage: 75}), false);
  assert.equal(bindingEqual({type: 2, macroIndex: 3}, {type: 2, macroIndex: 3}), true);
  assert.equal(bindingEqual({type: 1, keyUsage: 3}, {type: 2, macroIndex: 3}), false);
});

test('layer cloning copies every binding without retaining mutable aliases', () => {
  const layers = blankLayers();
  layers[0][16] = {type: 1, keyUsage: 74};

  const cloned = cloneLayers(layers);

  assert.deepEqual(cloned, layers);
  assert.notEqual(cloned, layers);
  assert.notEqual(cloned[0], layers[0]);
  assert.notEqual(cloned[0][16], layers[0][16]);
});

test('binding change count includes key, macro and type changes', () => {
  const saved = blankLayers();
  const current = cloneLayers(saved);
  current[0][16] = {type: 1, keyUsage: 74};
  current[1][20] = {type: 2, macroIndex: 3};

  assert.equal(countBindingChanges(current, saved), 2);
  assert.equal(countBindingChanges(saved, saved), 0);
});

test('confirmed macro binding readback preserves unrelated ordinary key drafts', () => {
  const original = blankLayers();
  original[0][10] = {type: 2, macroIndex: 3};
  const draft = cloneLayers(original);
  draft[0][20] = {type: 1, keyUsage: 74};
  const verified = buildMacroBindings(original, 3, {layer: 0, keyIndex: 25});

  const result = mergeConfirmedBindingsPreservingDraft(original, draft, verified);

  assert.deepEqual(result.original, verified);
  assert.deepEqual(result.draft[0][10], {type: 0, keyUsage: 0});
  assert.deepEqual(result.draft[0][25], {type: 2, macroIndex: 3});
  assert.deepEqual(result.draft[0][20], {type: 1, keyUsage: 74});
  assert.equal(countBindingChanges(result.draft, result.original), 1);
});

test('macro target conflicts include only dirty keys changed by that macro save', () => {
  const original = blankLayers();
  original[0][10] = {type: 2, macroIndex: 3};
  const draft = cloneLayers(original);
  draft[0][10] = {type: 1, keyUsage: 74};
  draft[0][20] = {type: 1, keyUsage: 75};

  assert.deepEqual(macroBindingConflicts(original, draft, 3, {layer: 0, keyIndex: 25}), [
    {layer: 0, keyIndex: 10}
  ]);
  assert.deepEqual(macroBindingConflicts(original, draft, 3, {layer: 0, keyIndex: 20}), [
    {layer: 0, keyIndex: 10}, {layer: 0, keyIndex: 20}
  ]);
});

test('binding visual state keeps saved type separate from unsaved border', () => {
  assert.deepEqual(bindingVisualState(
    {type: 1, keyUsage: 74}, {type: 1, keyUsage: 75}
  ), {savedType: 'key', dirty: true});
  assert.deepEqual(bindingVisualState(
    {type: 2, macroIndex: 3}, {type: 2, macroIndex: 4}
  ), {savedType: 'macro', dirty: true});
  assert.deepEqual(bindingVisualState(
    {type: 0, keyUsage: 0}, {type: 2, macroIndex: 3}
  ), {savedType: 'default', dirty: true});
  assert.deepEqual(bindingVisualState(
    {type: 2, macroIndex: 3}, {type: 2, macroIndex: 3}
  ), {savedType: 'macro', dirty: false});
});

test('preset save plan independently detects name and binding changes', () => {
  const original = blankLayers();
  const changed = cloneLayers(original);
  changed[0][16] = {type: 1, keyUsage: 74};

  assert.deepEqual(presetSavePlan('预设 1', '预设 1', original, changed),
    {saveName: false, saveBindings: true});
  assert.deepEqual(presetSavePlan('预设 1', '', original, original),
    {saveName: true, saveBindings: false});
  assert.deepEqual(presetSavePlan('预设 1', '工作', original, changed),
    {saveName: true, saveBindings: true});
  assert.deepEqual(presetSavePlan('预设 1', '预设 1', original, original),
    {saveName: false, saveBindings: false});
});

test('single-key restore creates a default draft without changing saved bindings', () => {
  const draft = blankLayers();
  draft[0][10] = {type: 2, macroIndex: 3};
  draft[0][11] = {type: 1, keyUsage: 75};

  const result = restoreDraftKey(draft, {layer: 0, keyIndex: 10});

  assert.deepEqual(result[0][10], {type: 0, keyUsage: 0});
  assert.deepEqual(result[0][11], {type: 1, keyUsage: 75});
  assert.deepEqual(draft[0][10], {type: 2, macroIndex: 3});
  assert.notEqual(result, draft);
});

test('single-key restore assigns unsaved macro previews to the macro save scope', () => {
  assert.equal(restoreKeyScope('', '0:17', '0:17'), 'macro');
  assert.equal(restoreKeyScope('0:16', '0:17', '0:17'), 'macro');
  assert.equal(restoreKeyScope('0:17', '0:17', '0:17'), 'bindings');
  assert.equal(restoreKeyScope('', '0:18', '0:17'), 'bindings');
});

test('generation gate rejects replies captured before a context switch', () => {
  const gate = createGenerationGate();
  const first = gate.capture({presetId: 0, slot: 1});
  gate.invalidate();
  assert.equal(gate.isCurrent(first, {presetId: 0, slot: 1}), false);
});

test('generation gate freezes captures and checks current context values', () => {
  const gate = createGenerationGate();
  const captured = gate.capture({presetId: 0, slot: 1});

  assert.equal(Object.isFrozen(captured), true);
  assert.equal(gate.isCurrent(captured, {presetId: 0, slot: 1}), true);
  assert.equal(gate.isCurrent(captured, {presetId: 1, slot: 1}), false);
});

test('key search matches physical, default and current output', () => {
  assert.equal(matchesKeyQuery({physical: 'Left Ctrl', defaultOutput: 'A', currentOutput: 'Home'}, 'ctrl'), true);
  assert.equal(matchesKeyQuery({physical: 'A', defaultOutput: 'Page Up', currentOutput: 'Home'}, 'page up'), true);
  assert.equal(matchesKeyQuery({physical: '1', defaultOutput: '1', currentOutput: 'Home'}, 'home'), true);
  assert.equal(matchesKeyQuery({physical: 'A', defaultOutput: 'A', currentOutput: '宏 2'}, '宏 2'), true);
  assert.equal(matchesKeyQuery({physical: 'Left Ctrl', defaultOutput: 'Left Ctrl', currentOutput: 'Left Ctrl'}, ' shift '), false);
});

test('usage search accepts labels and decimal HID usage', () => {
  const options = [{value: 74, label: 'Home'}, {value: 75, label: 'Page Up'}];
  assert.deepEqual(filterUsageOptions(options, 'home'), [{value: 74, label: 'Home'}]);
  assert.deepEqual(filterUsageOptions(options, '74'), [{value: 74, label: 'Home'}]);
});

test('macro binding replacement clears old targets and leaves input unchanged', () => {
  const layers = blankLayers();
  layers[0][10] = {type: 2, macroIndex: 3};
  layers[1][20] = {type: 2, macroIndex: 3};
  layers[1][30] = {type: 2, macroIndex: 4};

  const next = buildMacroBindings(layers, 3, {layer: 0, keyIndex: 25});

  assert.deepEqual(next[0][10], {type: 0, keyUsage: 0});
  assert.deepEqual(next[1][20], {type: 0, keyUsage: 0});
  assert.deepEqual(next[0][25], {type: 2, macroIndex: 3});
  assert.deepEqual(next[1][30], {type: 2, macroIndex: 4});
  assert.deepEqual(layers[0][10], {type: 2, macroIndex: 3});
  assert.notEqual(next, layers);
});

test('macro binding replacement accepts no target to unbind the slot', () => {
  const layers = blankLayers();
  layers[0][10] = {type: 2, macroIndex: 3};
  layers[1][20] = {type: 2, macroIndex: 4};

  const next = buildMacroBindings(layers, 3, null);

  assert.deepEqual(next[0][10], {type: 0, keyUsage: 0});
  assert.deepEqual(next[1][20], {type: 2, macroIndex: 4});
});

test('macro binding replacement rejects reserved key targets', () => {
  assert.throws(
    () => buildMacroBindings(blankLayers(), 3, {layer: 0, keyIndex: 70}),
    /保留/
  );
});

const invalidMacroBindingTargets = [
  ['non-integer macro slot', 1.5, {layer: 0, keyIndex: 25}, /宏槽位/],
  ['negative macro slot', -1, {layer: 0, keyIndex: 25}, /宏槽位/],
  ['macro slot above 15', 16, {layer: 0, keyIndex: 25}, /宏槽位/],
  ['non-integer layer', 3, {layer: 0.5, keyIndex: 25}, /层/],
  ['negative layer', 3, {layer: -1, keyIndex: 25}, /层/],
  ['layer above 1', 3, {layer: 2, keyIndex: 25}, /层/],
  ['non-integer key index', 3, {layer: 0, keyIndex: 1.5}, /键索引/],
  ['negative key index', 3, {layer: 0, keyIndex: -1}, /键索引/],
  ['key index above 79', 3, {layer: 0, keyIndex: 80}, /键索引/]
];

for (const [name, slot, target, message] of invalidMacroBindingTargets) {
  test(`macro binding replacement rejects ${name}`, () => {
    assert.throws(
      () => buildMacroBindings(blankLayers(), slot, target),
      {name: 'RangeError', message}
    );
  });
}
