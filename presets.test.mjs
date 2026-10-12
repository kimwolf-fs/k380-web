import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  activatePreset,
  encodeBindings,
  encodePresetName,
  readPresetSummary,
  restoreAll,
  restoreKey,
  restorePreset,
  saveBindings,
  savePresetName
} from './presets.mjs';

const blank = () => Array.from({length: 2}, () => Array.from({length: 80}, () => ({type: 0, keyUsage: 0})));

const fixedName = name => {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode(name));
  return [...bytes];
};

const ok = () => Uint8Array.of(0);

const presetsReply = (activePreset, names) => {
  const payload = new Uint8Array(134);
  payload[1] = activePreset;
  names.forEach((name, index) => {
    payload[2 + index * 33] = index;
    payload.set(new TextEncoder().encode(name), 3 + index * 33);
  });
  return payload;
};

const bindingsReply = (activePreset, layers) =>
  Uint8Array.of(0, activePreset, 1, 0, ...encodeBindings(layers));

const layersWithDefault = (layer, keyIndex) => {
  const layers = blank();
  layers[layer][keyIndex] = {type: 0, keyUsage: 0};
  return layers;
};

const transcript = expected => {
  const calls = [];
  return {
    calls,
    async exchange(command, payload = new Uint8Array()) {
      const next = expected.shift();
      assert.ok(next, `unexpected exchange ${command}`);
      assert.equal(command, next[0]);
      assert.deepEqual([...payload], next[1]);
      calls.push([command, [...payload]]);
      return next[2];
    },
    done() {
      assert.equal(expected.length, 0);
    }
  };
};

test('encodes two complete layers preserving default, key and macro bindings', () => {
  const layers = blank();
  layers[0][16] = {type: 1, keyUsage: 74};
  layers[1][60] = {type: 2, macroIndex: 15};
  const bytes = encodeBindings(layers);
  assert.equal(bytes.length, 480);
  assert.deepEqual([...bytes.slice(16 * 3, 16 * 3 + 3)], [1, 74, 0]);
  assert.deepEqual([...bytes.slice((80 + 60) * 3, (80 + 60) * 3 + 3)], [2, 15, 0]);
});

test('rejects invalid layer length, HID value, macro slot and reserved edit', () => {
  const layers = blank();
  assert.throws(() => encodeBindings([layers[0]]), /两层/);
  layers[0][16] = {type: 1, keyUsage: 3};
  assert.throws(() => encodeBindings(layers), /HID/);
  layers[0][16] = {type: 2, macroIndex: 16};
  assert.throws(() => encodeBindings(layers), /宏/);
  layers[0][16] = {type: 0, keyUsage: 0};
  layers[0][70] = {type: 1, keyUsage: 4};
  assert.throws(() => encodeBindings(layers), /保留/);
});

test('save writes full preset once and verifies device readback', async () => {
  const layers = blank();
  layers[0][16] = {type: 1, keyUsage: 74};
  const calls = [];
  const connection = {async exchange(command, payload) {
    calls.push({command, payload});
    if (command === 5) return Uint8Array.of(0);
    return Uint8Array.of(0, 0, 2, 0, ...encodeBindings(layers));
  }};
  const result = await saveBindings(connection, 2, layers);
  assert.equal(result.presetId, 2);
  assert.deepEqual(calls.map(call => call.command), [5, 4]);
  assert.deepEqual([...calls[0].payload.slice(0, 5)], [2, 0, 0, 0, 0]);
});

test('save rejects mismatched readback and does not claim success', async () => {
  const layers = blank();
  const changed = blank();
  changed[0][16] = {type: 1, keyUsage: 4};
  const connection = {async exchange(command) {
    if (command === 5) return Uint8Array.of(0);
    return Uint8Array.of(0, 0, 1, 0, ...encodeBindings(changed));
  }};
  await assert.rejects(saveBindings(connection, 1, layers), /读回.*不一致/);
});

test('encodes preset names as zero-padded UTF-8 bytes and accepts empty names', () => {
  assert.deepEqual([...encodePresetName('工作').slice(0, 6)], [229, 183, 165, 228, 189, 156]);
  assert.equal(encodePresetName('').every(byte => byte === 0), true);
  assert.throws(() => encodePresetName('一'.repeat(11)), /32.*UTF-8/);
});

test('saves a changed UTF-8 preset name and verifies GET_PRESETS', async () => {
  const device = transcript([
    [5, [2, 2, ...fixedName('工作')], ok()],
    [3, [], presetsReply(0, ['', '', '工作', ''])]
  ]);
  const result = await savePresetName(device, 2, '工作');
  assert.equal(result.presets[2].name, '工作');
  device.done();
});

test('rejects a preset name save when GET_PRESETS returns a different name', async () => {
  const device = transcript([
    [5, [2, 2, ...fixedName('工作')], ok()],
    [3, [], presetsReply(0, ['', '', '错误', ''])]
  ]);
  await assert.rejects(savePresetName(device, 2, '工作'), /预设名称保存后读回不一致/);
  device.done();
});

test('activates a preset only when GET_PRESETS confirms it', async () => {
  const device = transcript([
    [6, [3], ok()],
    [3, [], presetsReply(3, ['', '', '', ''])]
  ]);
  const result = await activatePreset(device, 3);
  assert.equal(result.activePreset, 3);
  device.done();
  await assert.rejects(
    activatePreset(transcript([[6, [1], ok()], [3, [], presetsReply(0, ['', '', '', ''])]]), 1),
    /生效预设.*不一致/
  );
});

test('restores one key then verifies the target is default', async () => {
  const device = transcript([
    [7, [1, 0, 16], ok()],
    [4, [1, 0], bindingsReply(1, layersWithDefault(0, 16))]
  ]);
  const result = await restoreKey(device, 1, 0, 16);
  assert.deepEqual(result.layers[0][16], {type: 0, keyUsage: 0});
  device.done();
});

test('rejects a key restore when the target readback is non-default', async () => {
  const layers = blank();
  layers[0][16] = {type: 1, keyUsage: 74};
  const device = transcript([
    [7, [1, 0, 16], ok()],
    [4, [1, 0], bindingsReply(1, layers)]
  ]);
  await assert.rejects(restoreKey(device, 1, 0, 16), /恢复按键后读回不一致/);
  device.done();
});

test('rejects invalid preset, layer, and key arguments before exchange', async () => {
  const device = transcript([]);
  await assert.rejects(restoreKey(device, 4, 0, 0), /预设编号/);
  await assert.rejects(restoreKey(device, 0, 2, 0), /层/);
  await assert.rejects(restoreKey(device, 0, 0, 80), /键/);
  device.done();
});

test('restores a preset and rereads its summary and bindings', async () => {
  const layers = blank();
  const device = transcript([
    [8, [2], ok()],
    [3, [], presetsReply(2, ['', '', '', ''])],
    [4, [2, 0], Uint8Array.of(0, 2, 2, 0, ...encodeBindings(layers))]
  ]);
  const result = await restorePreset(device, 2);
  assert.equal(result.presets[2].name, '');
  assert.equal(result.presetId, 2);
  assert.deepEqual(result.layers, layers);
  device.done();
});

test('rejects preset restore when the name readback is non-empty', async () => {
  const device = transcript([
    [8, [2], ok()],
    [3, [], presetsReply(2, ['', '', '保留名称', ''])]
  ]);
  await assert.rejects(restorePreset(device, 2), /恢复预设后名称读回不一致/);
  device.done();
});

test('rejects preset restore when any binding readback is non-default', async () => {
  const layers = blank();
  layers[1][20] = {type: 2, macroIndex: 3};
  const device = transcript([
    [8, [2], ok()],
    [3, [], presetsReply(2, ['', '', '', ''])],
    [4, [2, 0], Uint8Array.of(0, 2, 2, 0, ...encodeBindings(layers))]
  ]);
  await assert.rejects(restorePreset(device, 2), /恢复预设后绑定读回不一致/);
  device.done();
});

test('restores all presets and verifies the device-selected active preset is zero', async () => {
  const device = transcript([
    [9, [], ok()],
    [3, [], presetsReply(0, ['', '', '', ''])]
  ]);
  const result = await restoreAll(device);
  assert.equal(result.activePreset, 0);
  device.done();
  await assert.rejects(
    restoreAll(transcript([[9, [], ok()], [3, [], presetsReply(1, ['', '', '', ''])]])),
    /当前预设.*0/
  );
});

test('invokes restore-all success callback before a summary readback failure', async () => {
  const events = [];
  const device = transcript([
    [9, [], ok()],
    [3, [], Uint8Array.of(0)]
  ]);

  await assert.rejects(
    restoreAll(device, () => events.push('restored')),
    /K380 预设列表无效/
  );
  assert.deepEqual(events, ['restored']);
  device.done();
});
