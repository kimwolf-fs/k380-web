import {compileMacro} from './macro-compiler.mjs';

const key = (preset, slot, crc) => `k380-macro-source-v1:${preset}:${slot}:${crc}`;

export function saveSource(storage, preset, slot, crc, source) {
  storage.setItem(key(preset, slot, crc), JSON.stringify({version: 1, source}));
}

export function clearSourceSlot(storage, preset, slot) {
  const prefix = `k380-macro-source-v1:${preset}:${slot}:`;
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const candidate = storage.key(index);
    if (candidate?.startsWith(prefix)) storage.removeItem(candidate);
  }
}

export function resolveSource(storage, preset, slot, crc, packageBytes) {
  try {
    const entry = JSON.parse(storage.getItem(key(preset, slot, crc)));
    if (entry?.version !== 1 || typeof entry.source !== 'string') return null;
    const compiled = compileMacro(entry.source);
    if (compiled.packageCrc32 !== crc || compiled.package.length !== packageBytes.length ||
        !compiled.package.every((byte, index) => byte === packageBytes[index])) return null;
    return entry.source;
  } catch {
    return null;
  }
}
