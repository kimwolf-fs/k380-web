import {isReserved} from './keymap.mjs';

export function bindingEqual(left, right) {
  if (!left || !right || left.type !== right.type) return false;
  return left.type === 2
    ? left.macroIndex === right.macroIndex
    : left.keyUsage === right.keyUsage;
}

export function cloneLayers(layers) {
  return layers.map(layer => layer.map(binding => ({...binding})));
}

export function countBindingChanges(current, saved) {
  let count = 0;
  for (let layer = 0; layer < current.length; layer += 1) {
    for (let keyIndex = 0; keyIndex < current[layer].length; keyIndex += 1) {
      if (!bindingEqual(current[layer][keyIndex], saved[layer][keyIndex])) count += 1;
    }
  }
  return count;
}

export function bindingVisualState(saved, current) {
  return {
    savedType: saved.type === 2 ? 'macro' : saved.type === 1 ? 'key' : 'default',
    dirty: !bindingEqual(saved, current)
  };
}

export function mergeConfirmedBindingsPreservingDraft(originalLayers, draftLayers, verifiedLayers) {
  const original = cloneLayers(verifiedLayers);
  const draft = cloneLayers(verifiedLayers);
  for (let layer = 0; layer < draftLayers.length; layer += 1) {
    for (let keyIndex = 0; keyIndex < draftLayers[layer].length; keyIndex += 1) {
      if (!bindingEqual(draftLayers[layer][keyIndex], originalLayers[layer][keyIndex])) {
        draft[layer][keyIndex] = {...draftLayers[layer][keyIndex]};
      }
    }
  }
  return {original, draft};
}

export function macroBindingConflicts(originalLayers, draftLayers, slot, target) {
  const conflicts = [];
  for (let layer = 0; layer < originalLayers.length; layer += 1) {
    for (let keyIndex = 0; keyIndex < originalLayers[layer].length; keyIndex += 1) {
      const saved = originalLayers[layer][keyIndex];
      const affected = (saved.type === 2 && saved.macroIndex === slot) ||
        (target && target.layer === layer && target.keyIndex === keyIndex);
      if (affected && !bindingEqual(saved, draftLayers[layer][keyIndex])) {
        conflicts.push({layer, keyIndex});
      }
    }
  }
  return conflicts;
}

export function presetSavePlan(baselineName, draftName, originalLayers, draftLayers) {
  return {
    saveName: baselineName !== draftName,
    saveBindings: countBindingChanges(draftLayers, originalLayers) > 0
  };
}

export function restoreDraftKey(layers, target) {
  const draft = cloneLayers(layers);
  draft[target.layer][target.keyIndex] = {type: 0, keyUsage: 0};
  return draft;
}

export function restoreKeyScope(savedMacroTarget, currentMacroTarget, keyTarget) {
  return currentMacroTarget === keyTarget && currentMacroTarget !== savedMacroTarget
    ? 'macro'
    : 'bindings';
}

export async function saveMacroStages(saveMacro, saveBindings) {
  try {
    const macro = await saveMacro();
    try {
      await saveBindings();
      return {macroSaved: true, bindingsSaved: true, macro};
    } catch (error) {
      return {macroSaved: true, bindingsSaved: false, macro, error};
    }
  } catch (error) {
    return {macroSaved: false, bindingsSaved: false, error};
  }
}

export function matchesKeyQuery({physical, defaultOutput, currentOutput}, query) {
  const token = query.trim().toLocaleLowerCase('zh-CN');
  if (!token) return true;
  return [physical, defaultOutput, currentOutput].some(value =>
    String(value).toLocaleLowerCase('zh-CN').includes(token));
}

export function filterUsageOptions(options, query) {
  const token = query.trim().toLocaleLowerCase('zh-CN');
  if (!token) return options;
  return options.filter(item => item.label.toLocaleLowerCase('zh-CN').includes(token) ||
    String(item.value) === token);
}

export function createGenerationGate() {
  let generation = 0;
  return {
    capture: context => Object.freeze({generation, ...context}),
    invalidate: () => ++generation,
    isCurrent: (captured, current) => captured.generation === generation &&
      Object.keys(current).every(key => captured[key] === current[key])
  };
}

export function buildMacroBindings(layers, slot, target) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 15) {
    throw new RangeError('宏槽位必须是 0 至 15 的整数');
  }
  if (target !== null && (!Number.isInteger(target.layer) || target.layer < 0 || target.layer > 1)) {
    throw new RangeError('目标层必须是 0 至 1 的整数');
  }
  if (target !== null && (!Number.isInteger(target.keyIndex) || target.keyIndex < 0 || target.keyIndex > 79)) {
    throw new RangeError('目标键索引必须是 0 至 79 的整数');
  }
  if (target !== null && isReserved(target.keyIndex, target.layer)) throw new RangeError('系统保留键不可修改');
  const next = cloneLayers(layers);
  for (const layer of next) {
    for (let keyIndex = 0; keyIndex < layer.length; keyIndex += 1) {
      if (layer[keyIndex].type === 2 && layer[keyIndex].macroIndex === slot) {
        layer[keyIndex] = {type: 0, keyUsage: 0};
      }
    }
  }
  if (target !== null) next[target.layer][target.keyIndex] = {type: 2, macroIndex: slot};
  return next;
}
