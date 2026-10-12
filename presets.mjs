import {decodeBindings, decodePresets} from './protocol.mjs';

const COMMAND = Object.freeze({
  GET_PRESETS: 3,
  GET_PRESET: 4,
  SAVE_PRESET: 5,
  SET_ACTIVE_PRESET: 6,
  RESTORE_KEY: 7,
  RESTORE_PRESET: 8,
  RESTORE_ALL: 9
});

const reservedFn = new Set([1, 2, 3, 4, 14, 16, 17, 18, 19, 28, 79]);

export function isReserved(index, layer) {
  return (layer === 0 && index === 70) || (layer === 1 && reservedFn.has(index));
}

function requirePreset(presetId) {
  if (!Number.isInteger(presetId) || presetId < 0 || presetId > 3) throw new RangeError('预设编号无效');
}

function requireKey(layer, keyIndex) {
  if (!Number.isInteger(layer) || layer < 0 || layer > 1) throw new RangeError('层编号无效');
  if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex > 79) throw new RangeError('键编号无效');
}

async function readPresetBindings(connection, presetId) {
  return decodeBindings(await connection.exchange(COMMAND.GET_PRESET, Uint8Array.of(presetId, 0)), presetId);
}

export function encodePresetName(name) {
  if (typeof name !== 'string') throw new TypeError('预设名称必须是字符串');
  const encoded = new TextEncoder().encode(name);
  if (encoded.length > 32) throw new RangeError('预设名称最多 32 个 UTF-8 字节');
  const fixed = new Uint8Array(32);
  fixed.set(encoded);
  return fixed;
}

export async function readPresetSummary(connection) {
  return decodePresets(await connection.exchange(COMMAND.GET_PRESETS));
}

export async function savePresetName(connection, presetId, name) {
  requirePreset(presetId);
  const payload = new Uint8Array(34);
  payload.set([presetId, 2]);
  payload.set(encodePresetName(name), 2);
  await connection.exchange(COMMAND.SAVE_PRESET, payload);
  const summary = await readPresetSummary(connection);
  if (summary.presets.find(item => item.id === presetId)?.name !== name) {
    throw new Error('预设名称保存后读回不一致');
  }
  return summary;
}

export async function activatePreset(connection, presetId) {
  requirePreset(presetId);
  await connection.exchange(COMMAND.SET_ACTIVE_PRESET, Uint8Array.of(presetId));
  const summary = await readPresetSummary(connection);
  if (summary.activePreset !== presetId) throw new Error('生效预设读回不一致');
  return summary;
}

export async function restoreKey(connection, presetId, layer, keyIndex) {
  requirePreset(presetId);
  requireKey(layer, keyIndex);
  await connection.exchange(COMMAND.RESTORE_KEY, Uint8Array.of(presetId, layer, keyIndex));
  const result = await readPresetBindings(connection, presetId);
  if (result.layers[layer][keyIndex].type !== 0 || result.layers[layer][keyIndex].keyUsage !== 0) {
    throw new Error('恢复按键后读回不一致');
  }
  return result;
}

export async function restorePreset(connection, presetId, onRestored = () => {}) {
  requirePreset(presetId);
  await connection.exchange(COMMAND.RESTORE_PRESET, Uint8Array.of(presetId));
  onRestored();
  const summary = await readPresetSummary(connection);
  if (summary.presets.find(item => item.id === presetId)?.name !== '') {
    throw new Error('恢复预设后名称读回不一致');
  }
  const bindings = await readPresetBindings(connection, presetId);
  if (bindings.layers.some(layer => layer.some(binding => binding.type !== 0 || binding.keyUsage !== 0))) {
    throw new Error('恢复预设后绑定读回不一致');
  }
  return {...summary, ...bindings};
}

export async function restoreAll(connection, onRestored = () => {}) {
  await connection.exchange(COMMAND.RESTORE_ALL);
  onRestored();
  const summary = await readPresetSummary(connection);
  if (summary.activePreset !== 0) throw new Error('全部恢复后当前预设必须为 0');
  return summary;
}

export function encodeBindings(layers) {
  if (!Array.isArray(layers) || layers.length !== 2 || layers.some(layer => !Array.isArray(layer) || layer.length !== 80)) {
    throw new RangeError('绑定数据必须包含两层，每层 80 键');
  }
  const bytes = new Uint8Array(480);
  const view = new DataView(bytes.buffer);
  for (let layer = 0; layer < 2; layer += 1) {
    for (let index = 0; index < 80; index += 1) {
      const binding = layers[layer][index];
      if (!binding || !Number.isInteger(binding.type) || binding.type < 0 || binding.type > 2) {
        throw new RangeError('无效的绑定类型');
      }
      if (isReserved(index, layer) && binding.type !== 0) throw new RangeError('系统保留键不可修改');
      const value = binding.type === 2 ? binding.macroIndex : binding.keyUsage;
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new RangeError('绑定值无效');
      if (binding.type === 1 && (value < 4 || value > 231)) throw new RangeError('HID 键值必须在 4 至 231 之间');
      if (binding.type === 2 && value > 15) throw new RangeError('宏槽位必须在 0 至 15 之间');
      const offset = (layer * 80 + index) * 3;
      bytes[offset] = binding.type;
      view.setUint16(offset + 1, value, true);
    }
  }
  return bytes;
}

export async function saveBindings(connection, presetId, layers) {
  if (!Number.isInteger(presetId) || presetId < 0 || presetId > 3) throw new RangeError('预设编号无效');
  const expected = encodeBindings(layers);
  const request = new Uint8Array(2 + expected.length);
  request[0] = presetId;
  request.set(expected, 2);
  await connection.exchange(5, request);
  const readback = decodeBindings(await connection.exchange(4, Uint8Array.of(presetId, 0)), presetId);
  const actual = encodeBindings(readback.layers);
  if (!expected.every((value, index) => value === actual[index])) {
    throw new Error('保存后读回与编辑内容不一致，请重新读取设备状态');
  }
  return readback;
}
