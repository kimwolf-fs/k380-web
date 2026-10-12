import {K380Connection, decodeBindings, decodeInfo, decodePresets} from './protocol.mjs';
import {
  defaultLabel,
  isReserved,
  keyRows,
  MACRO_RECORD_WAIT_THRESHOLD_MS,
  physicalKeys,
  recordedInstructions,
  sourceUsageToken,
  usageFromCode,
  usageLabel,
  usageOptions
} from './keymap.mjs';
import {activatePreset, restoreAll, restorePreset, saveBindings, savePresetName} from './presets.mjs';
import {
  bindingEqual,
  bindingVisualState,
  cloneLayers,
  countBindingChanges,
  createGenerationGate,
  filterUsageOptions,
  buildMacroBindings,
  macroBindingConflicts,
  matchesKeyQuery,
  mergeConfirmedBindingsPreservingDraft,
  restoreKeyScope,
  restoreDraftKey,
  saveMacroStages
} from './ui-model.mjs';
import {prepareMacroDraft} from './macro-compiler.mjs';
import {testMacro as uploadTestMacro, readRunState, stopMacro, readMacro, saveMacro} from './macro-device.mjs';
import {accumulateLineResult, runOutcome} from './macro-trace.mjs';
import {clearSourceSlot, resolveSource, saveSource} from './macro-source-store.mjs';
import {createBackup, parseBackup, MAX_BACKUP_BYTES} from './macro-backup.mjs';

const connectButton = document.querySelector('#connect');
const disconnectButton = document.querySelector('#disconnect');
const status = document.querySelector('#status');
const presetGate = createGenerationGate();
const macroGate = createGenerationGate();
let connection = null;
let busy = false;
let presetData = null;
let selectedPreset = null;
let original = null;
let draft = null;
let baselineName = '';
let selectedKey = 16;
let capturing = false;
let macroRun = null;
let selectedMacroSlot = null;
let macroBaseline = null;
let macroSourceUnavailable = false;
let macroClearRequested = false;
let macroNames = Array(16).fill('');
let macroEditor = null;
let macroRecording = null;
let compileTimer = null;

const MACRO_INSERTIONS = Object.freeze([
  {text: '按下 A', label: '添加按下', selectText: 'A'},
  {text: '弹起 A', label: '添加弹起', selectText: 'A'},
  {text: '点击 A', label: '添加点击', selectText: 'A'},
  {text: '等待 200', label: '添加等待', selectText: '200'},
  {text: '随机等待 100 300', label: '添加随机等待', selectText: '100 300'},
  {text: '释放全部', label: '添加释放全部'},
  {text: '重置计时器 1', label: '添加计时器', selectText: '1'},
  {text: '如果 计时器 1 大于等于 300000:', label: '添加条件', block: true},
  {text: '循环次数 10:', label: '添加次数循环', block: true},
  {text: '循环时长 300000:', label: '添加时长循环', block: true},
  {text: '定义 动作():', label: '添加函数', block: true},
  {text: '调用 动作', label: '添加调用', selectText: '动作'}
]);

const $ = selector => document.querySelector(selector);
const layer = () => Number($('#layer-select').value);

function bindingLabel(binding, index, level) {
  if (binding.type === 1) return usageLabel(binding.keyUsage);
  if (binding.type === 2) return `宏 ${binding.macroIndex + 1}`;
  return defaultLabel(index, level);
}

function changedCount() {
  return draft && original ? countBindingChanges(draft, original) : 0;
}

const nameDirty = () => Boolean(draft) && baselineName !== $('#preset-name').value;
const bindingsDirty = () => changedCount() > 0;

function confirmDiscard() {
  return (!nameDirty() && !bindingsDirty() && !macroDirty()) ||
    window.confirm('有未保存的修改，确定继续吗？');
}

function macroSnapshot() {
  const trigger = Number($('#macro-trigger').value);
  return {source: readMacroEditorSource(), name: $('#macro-name').value,
    trigger, repeatCount: trigger === 3 ? Number($('#macro-count').value) : 1,
    target: $('#macro-target').value};
}

function readMacroEditorSource() {
  return macroEditor ? macroEditor.getValue() : '';
}

function destroyMacroEditor() {
  invalidateMacroRun();
  macroGate.invalidate();
  clearTimeout(compileTimer);
  compileTimer = null;
  if (macroEditor) macroEditor.destroy();
  macroEditor = null;
}

function macroSourceChanged() {
  invalidateMacroRun();
  macroGate.invalidate();
  macroEditor.clearLineResults();
  $('#compile-status').textContent = '';
  $('#compile-status').classList.remove('error');
  clearTimeout(compileTimer);
  const source = readMacroEditorSource();
  const context = macroGate.capture({presetId: selectedPreset, slot: selectedMacroSlot, source});
  compileTimer = setTimeout(() => {
    compileTimer = null;
    if (macroGate.isCurrent(context, {presetId: selectedPreset, slot: selectedMacroSlot,
      source: readMacroEditorSource()})) compileMacroSource(source);
  }, 300);
  setControls();
}

function createMacroEditor(source) {
  destroyMacroEditor();
  macroEditor = window.K380MacroSourceEditor.create(
    document.querySelector('.macro-source-editor-host'),
    {value: source, onChange: macroSourceChanged}
  );
}

function findMacroTarget(slot) {
  if (!draft) return '';
  for (let layerIndex = 0; layerIndex < draft.length; layerIndex += 1) {
    for (let keyIndex = 0; keyIndex < draft[layerIndex].length; keyIndex += 1) {
      const binding = draft[layerIndex][keyIndex];
      if (binding.type === 2 && binding.macroIndex === slot) return `${layerIndex}:${keyIndex}`;
    }
  }
  return '';
}

function parseMacroTarget(value = $('#macro-target').value) {
  if (!value) return null;
  const [targetLayer, keyIndex] = value.split(':').map(Number);
  return {layer: targetLayer, keyIndex};
}

function macroPreviewLayers() {
  if (!draft || !original || selectedMacroSlot === null || !macroBaseline) return draft;
  const preview = cloneLayers(draft);
  const macroLayers = buildMacroBindings(original, selectedMacroSlot, parseMacroTarget());
  for (let targetLayer = 0; targetLayer < preview.length; targetLayer += 1) {
    for (let keyIndex = 0; keyIndex < preview[targetLayer].length; keyIndex += 1) {
      if (bindingEqual(draft[targetLayer][keyIndex], original[targetLayer][keyIndex])) {
        preview[targetLayer][keyIndex] = {...macroLayers[targetLayer][keyIndex]};
      }
    }
  }
  return preview;
}

function renderMacroTargetOptions() {
  const select = $('#macro-target');
  if (!select) return;
  const selected = select.value;
  select.replaceChildren();
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '不绑定按键';
  select.append(empty);
  if (!draft) return;
  for (let layerIndex = 0; layerIndex < draft.length; layerIndex += 1) {
    for (let keyIndex = 0; keyIndex < draft[layerIndex].length; keyIndex += 1) {
      if (isReserved(keyIndex, layerIndex)) continue;
      const option = document.createElement('option');
      option.value = `${layerIndex}:${keyIndex}`;
      option.textContent = layerIndex ? `Fn+${physicalKeys[keyIndex]}` : physicalKeys[keyIndex];
      select.append(option);
    }
  }
  select.value = Array.from(select.children).some(option => option.value === selected) ? selected : '';
}

function applyMacroTarget() {
  if (!draft || selectedMacroSlot === null || macroRecording) return;
  renderMacroTargetOptions();
  renderEditor();
  setControls();
}

function ensureMacroAuthoringControls() {
  const settings = document.querySelector('.macro-settings');
  if (!settings || $('#macro-target')) return;
  const label = document.createElement('label');
  label.textContent = '绑定按键';
  const select = document.createElement('select');
  select.id = 'macro-target';
  select.addEventListener('change', applyMacroTarget);
  label.append(select);
  settings.insertBefore(label, settings.children[1] || null);

  const tools = document.createElement('div');
  tools.id = 'macro-insert-tools';
  tools.className = 'macro-insert-tools';
  tools.setAttribute('aria-label', '添加宏指令');
  for (const [index, spec] of MACRO_INSERTIONS.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.index = String(index);
    button.textContent = spec.label;
    button.addEventListener('click', () => {
      if (macroEditor && !macroRecording) macroEditor.insertInstruction(spec);
    });
    tools.append(button);
  }
  const record = document.createElement('button');
  record.id = 'record-macro';
  record.type = 'button';
  record.textContent = '开始录制';
  record.addEventListener('click', toggleMacroRecording);
  tools.append(record);
  document.querySelector('.macro-test-layout').before(tools);

  const clear = document.createElement('button');
  clear.id = 'clear-macro';
  clear.type = 'button';
  clear.className = 'danger';
  clear.textContent = '清空当前宏';
  clear.addEventListener('click', clearMacroDraft);
  document.querySelector('.macro-actions').insertBefore(clear, document.querySelector('#save-macro'));
}

function macroDirty() {
  if (!macroBaseline) return false;
  const current = macroSnapshot();
  return macroClearRequested || Object.keys(current).some(key => current[key] !== macroBaseline[key]);
}

function renderMacroSlots() {
  const list = $('#macro-slots-list');
  const macroBlocked = busy || Boolean(macroRecording);
  list.replaceChildren();
  for (let slot = 0; slot < 16; slot += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'tab';
    button.textContent = `宏 ${slot + 1} · ${macroNames[slot] || (slot === selectedMacroSlot ? '' : '点击读取')}`;
    button.title = `宏 ${slot + 1}${macroNames[slot] ? ` · ${macroNames[slot]}` : ''}`;
    button.classList.toggle('is-selected', slot === selectedMacroSlot);
    button.setAttribute('aria-selected', String(slot === selectedMacroSlot));
    button.disabled = macroBlocked || !connection;
    button.addEventListener('click', async () => {
      if (!connection || busy || macroRecording || !confirmDiscard()) return;
      clearMacroDetails();
      selectedMacroSlot = slot;
      busy = true;
      setControls();
      let current = false;
      try {
        current = await loadMacro(slot);
        if (!current) return;
        setStatus('已连接');
      } catch (error) {
        current = true;
        clearMacroDetails();
        selectedMacroSlot = null;
        setStatus(describeError(error), true);
      } finally {
        if (!current) return;
        busy = false;
        setControls();
      }
    });
    list.append(button);
  }
}

function clearMacroDetails() {
  stopMacroRecording(false);
  destroyMacroEditor();
  macroBaseline = null;
  macroSourceUnavailable = false;
  macroClearRequested = false;
  $('#macro-name').value = '';
  $('#macro-target').value = '';
  $('#macro-trigger').value = '0';
  $('#macro-count').value = '1';
  $('#macro-count-field').hidden = true;
  $('#macro-source-status').textContent = '';
  $('#macro-source-notice').hidden = true;
  $('#macro-run-status').textContent = '';
  $('#compile-status').textContent = '';
  renderMacroTargetOptions();
}

async function loadMacro(slot) {
  const context = macroGate.capture({presetId: selectedPreset, slot});
  setStatus(`正在读取预设 ${context.presetId + 1} 的宏 ${context.slot + 1}...`);
  let stored;
  try {
    stored = await readMacro(connection, context.presetId, context.slot);
  } catch (error) {
    if (!macroGate.isCurrent(context, {presetId: selectedPreset, slot: selectedMacroSlot})) return false;
    throw error;
  }
  if (!macroGate.isCurrent(context, {presetId: selectedPreset, slot: selectedMacroSlot})) return false;
  macroNames[slot] = stored.name;
  let source = null;
  if (stored.package.length) {
    try { source = resolveSource(localStorage, context.presetId, context.slot, stored.packageCrc32, stored.package); }
    catch { source = null; }
  }
  macroSourceUnavailable = stored.package.length > 0 && source === null;
  macroClearRequested = false;
  createMacroEditor(source ?? '');
  macroEditor.cm.setOption('readOnly', busy || Boolean(macroRun) || Boolean(macroRecording));
  $('#macro-name').value = stored.name;
  renderMacroTargetOptions();
  $('#macro-target').value = findMacroTarget(slot);
  $('#macro-trigger').value = String(stored.trigger);
  $('#macro-count').value = String(stored.repeatCount || 1);
  $('#macro-count-field').hidden = stored.trigger !== 3;
  $('#macro-source-status').textContent = !stored.package.length ? '空宏槽位' :
    source !== null ? '已从本机恢复与设备匹配的源码' : '设备中有宏程序，本机没有匹配的源码';
  const notice = $('#macro-source-notice');
  notice.hidden = !macroSourceUnavailable;
  notice.textContent = macroSourceUnavailable
    ? `设备已有宏（程序包 ${stored.package.length} 字节），此槽位不是空宏。当前浏览器本机没有匹配源码，因此编辑框为空。请点击“导入宏”恢复 JSON 源码备份，或重新编辑；只有点击“保存宏”才会替换设备中的宏。`
    : '';
  macroBaseline = macroSnapshot();
  renderMacroSlots();
  return true;
}

function renderKeyDetails() {
  const blocked = busy || Boolean(macroRun) || Boolean(macroRecording);
  const level = layer();
  const binding = macroPreviewLayers()[level][selectedKey];
  $('#physical-key').textContent = level ? `Fn+${physicalKeys[selectedKey]}` : physicalKeys[selectedKey];
  $('#default-key').textContent = defaultLabel(selectedKey, level);
  $('#current-key').textContent = bindingLabel(binding, selectedKey, level);
  const select = $('#binding-select');
  renderBindingOptions(binding);
  select.value = binding.type === 2 ? `macro:${binding.macroIndex}` : binding.type === 1 ? `key:${binding.keyUsage}` : 'default';
  select.disabled = blocked || !connection || isReserved(selectedKey, level);
  $('#restore-key').disabled = blocked || !connection || isReserved(selectedKey, level) || binding.type === 0;
  $('#capture').disabled = blocked || !connection || isReserved(selectedKey, level);
  $('#capture').textContent = capturing ? '等待按键...' : '按实体键选择';
  const changes = changedCount();
  $('#change-count').textContent = changes ? `未保存 ${changes} 处按键` : '没有未保存按键';
  $('#name-change-status').textContent = nameDirty() ? '名称未保存' : '';
  $('#save-name').disabled = blocked || !connection || !nameDirty();
  $('#save-bindings').disabled = blocked || !connection || !bindingsDirty();
  $('#discard').disabled = blocked || !bindingsDirty();
}

function renderEditor() {
  $('#editor').hidden = !draft;
  if (!draft) return;
  const level = layer();
  const query = $('#key-filter').value;
  const rows = $('#keyboard-layout');
  const preview = macroPreviewLayers();
  rows.replaceChildren();
  let matchCount = 0;
  for (const keys of keyRows) {
    const row = document.createElement('div');
    row.className = 'keyboard-row';
    for (const {index, width} of keys) {
      const binding = preview[level][index];
      const visual = bindingVisualState(original[level][index], binding);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'keycap';
      button.style.setProperty('--u', width);
      button.classList.toggle('is-saved-key', visual.savedType === 'key');
      button.classList.toggle('is-saved-macro', visual.savedType === 'macro');
      button.classList.toggle('is-dirty', visual.dirty);
      button.classList.toggle('is-selected', selectedKey === index);
      button.classList.toggle('is-reserved', isReserved(index, level));
      const matches = matchesKeyQuery({
        physical: level ? `Fn+${physicalKeys[index]}` : physicalKeys[index],
        defaultOutput: defaultLabel(index, level),
        currentOutput: bindingLabel(binding, index, level)
      }, query);
      button.classList.toggle('is-filtered-out', !matches);
      if (matches) matchCount += 1;
      button.dataset.index = String(index);
      button.disabled = busy || Boolean(macroRun) || Boolean(macroRecording) || isReserved(index, level);
      button.setAttribute('aria-label', `${physicalKeys[index]}，当前 ${bindingLabel(binding, index, level)}，默认 ${defaultLabel(index, level)}`);
      const physical = document.createElement('span');
      physical.className = 'key-physical';
      physical.textContent = physicalKeys[index];
      const output = document.createElement('span');
      output.className = 'key-current';
      output.textContent = bindingLabel(binding, index, level);
      button.append(physical, output);
      button.addEventListener('click', () => {
        if (macroRecording) return;
        selectedKey = index;
        capturing = false;
        for (const key of rows.querySelectorAll('.keycap')) {
          key.classList.toggle('is-selected', key.dataset.index === String(index));
        }
        renderKeyDetails();
      });
      button.addEventListener('dblclick', () => {
        if (macroRecording) return;
        selectedKey = index;
        capturing = true;
        renderKeyDetails();
        setStatus('请按下要绑定的实体键');
      });
      row.append(button);
    }
    rows.append(row);
  }
  $('#key-filter-status').textContent = query.trim() ? `匹配 ${matchCount} 个按键` : '';
  renderKeyDetails();
}

function renderBindingOptions(binding = null) {
  const select = $('#binding-select');
  select.replaceChildren();
  const add = (value, label) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  };
  add('default', '使用默认');
  const selectedUsage = binding?.type === 1 ? binding.keyUsage : null;
  const filtered = filterUsageOptions(usageOptions, $('#usage-search').value);
  const visible = selectedUsage === null || filtered.some(item => item.value === selectedUsage)
    ? filtered
    : [...filtered, usageOptions.find(item => item.value === selectedUsage)].filter(Boolean);
  for (const usage of visible) add(`key:${usage.value}`, `${usage.label} (${usage.value})`);
  for (let slot = 0; slot < 16; slot += 1) add(`macro:${slot}`, `宏 ${slot + 1}`);
}

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function setControls() {
  const blocked = busy || Boolean(macroRun);
  const macroBlocked = blocked || Boolean(macroRecording);
  const navigationBlocked = busy || Boolean(macroRecording);
  connectButton.disabled = macroBlocked || Boolean(connection) || !('serial' in navigator) || !isSecureContext;
  disconnectButton.disabled = macroBlocked || !connection;
  for (const tab of document.querySelectorAll('#presets button')) tab.disabled = navigationBlocked || !connection;
  $('#preset-name').disabled = macroBlocked || !connection || !draft;
  $('#layer-select').disabled = macroBlocked || !connection || !draft;
  $('#save-name').disabled = macroBlocked || !connection || !draft || !nameDirty();
  $('#save-bindings').disabled = macroBlocked || !connection || !draft || !bindingsDirty();
  $('#discard').disabled = macroBlocked || !connection || !draft || !bindingsDirty();
  $('#switch-preset').disabled = macroBlocked || !connection || selectedPreset === null ||
    selectedPreset === presetData?.activePreset;
  $('#restore-preset').disabled = macroBlocked || !connection || selectedPreset === null;
  $('#restore-all').disabled = macroBlocked || !connection;
  for (const control of document.querySelectorAll('#editor input, #editor select, #editor button')) {
    control.disabled = macroBlocked || !connection;
  }
  if (macroEditor) macroEditor.cm.setOption('readOnly', navigationBlocked);
  $('#compile-macro').disabled = macroBlocked || !macroEditor;
  $('#test-macro').disabled = macroBlocked || !connection || selectedPreset === null;
  $('#test-macro').disabled ||= !macroBaseline;
  $('#stop-macro').disabled = !macroRun || busy || macroRun.stopRequested;
  $('#retry-macro-state').hidden = !macroRun?.unknown;
  $('#retry-macro-state').disabled = !macroRun?.unknown || busy || Boolean(macroRun.monitoring || macroRun.stopPending);
  $('#save-macro').disabled = macroBlocked || !connection || !macroBaseline || !macroDirty();
  $('#import-macro').disabled = macroBlocked || !macroBaseline || !macroEditor;
  $('#export-macro').disabled = macroBlocked || !macroBaseline || !macroEditor || macroBackupUnavailable();
  for (const control of document.querySelectorAll('.macro-settings input, .macro-settings select')) control.disabled = macroBlocked || !macroBaseline;
  for (const button of document.querySelectorAll('#macro-insert-tools button:not(#record-macro), #clear-macro')) {
    button.disabled = macroBlocked || !macroBaseline;
  }
  const recordButton = $('#record-macro');
  if (recordButton) {
    recordButton.disabled = (!macroRecording && blocked) || !macroBaseline;
    recordButton.classList.toggle('is-recording', Boolean(macroRecording));
    recordButton.textContent = macroRecording ? '停止录制' : '开始录制';
  }
  renderMacroSlots();
  if (draft) renderEditor();
}

function showDetails(port, info) {
  const {usbVendorId, usbProductId} = port.getInfo();
  const usb = `${usbVendorId.toString(16).padStart(4, '0').toUpperCase()}:${usbProductId.toString(16).padStart(4, '0').toUpperCase()}`;
  document.querySelector('#usb-id').textContent = usb;
  document.querySelector('#protocol-version').textContent = String(info.protocolVersion);
  document.querySelector('#preset-count').textContent = String(info.presetCount);
  document.querySelector('#layer-count').textContent = String(info.layerCount);
  document.querySelector('#key-count').textContent = String(info.keyCount);
  document.querySelector('#macro-slots').textContent = String(info.macroSlotCount);
  document.querySelector('#macro-limit').textContent = `${info.macroMaxPackageBytes} 字节`;
}

function clearDetails() {
  for (const entry of document.querySelectorAll('#details dd')) entry.textContent = '-';
  document.querySelector('#usb-id').textContent = '未连接';
}

function clearPresets() {
  presetGate.invalidate();
  presetData = null;
  selectedPreset = null;
  original = null;
  draft = null;
  baselineName = '';
  $('#preset-name').value = '';
  capturing = false;
  macroNames = Array(16).fill('');
  selectedMacroSlot = null;
  clearMacroDetails();
  document.querySelector('#presets').replaceChildren();
  document.querySelector('#default-bindings').textContent = '-';
  document.querySelector('#fn-bindings').textContent = '-';
  renderEditor();
  renderMacroSlots();
}

function invalidateMacroSelection() {
  macroNames = Array(16).fill('');
  selectedMacroSlot = null;
  clearMacroDetails();
  renderMacroSlots();
}

function renderPresets() {
  const tabs = document.querySelector('#presets');
  const macroBlocked = busy || Boolean(macroRecording);
  tabs.replaceChildren();
  for (const preset of presetData.presets) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.role = 'tab';
    tab.textContent = `${preset.name || `预设 ${preset.id + 1}`}${preset.id === presetData.activePreset ? '（当前）' : ''}`;
    tab.setAttribute('aria-selected', String(preset.id === selectedPreset));
    tab.classList.toggle('is-selected', preset.id === selectedPreset);
    tab.disabled = macroBlocked || !connection;
    tab.addEventListener('click', async () => {
      if (busy || macroRecording || !connection) return;
      if (preset.id === selectedPreset || !confirmDiscard()) return;
      capturing = false;
      busy = true;
      setControls();
      try {
        invalidateMacroSelection();
        await loadBindings(preset.id);
        setStatus('已连接');
      } catch (error) {
        setStatus(describeError(error), true);
      } finally {
        busy = false;
        setControls();
      }
    });
    tabs.append(tab);
  }
}

$('#switch-preset').addEventListener('click', async () => {
  if (!connection || busy || macroRun || macroRecording || selectedPreset === null ||
      selectedPreset === presetData?.activePreset || !confirmDiscard()) return;
  const target = selectedPreset;
  invalidateMacroSelection();
  busy = true;
  setControls();
  setStatus(`正在切换到预设 ${target + 1}...`);
  try {
    presetData = await activatePreset(connection, target);
    renderPresets();
    setStatus(`预设 ${target + 1} 已生效并读回校验通过`);
  } catch (error) {
    setStatus(describeError(error), true);
  } finally {
    busy = false;
    setControls();
  }
});

$('#restore-preset').addEventListener('click', async () => {
  if (!connection || busy || macroRun || macroRecording || selectedPreset === null || !confirmDiscard()) return;
  const target = selectedPreset;
  busy = true;
  setControls();
  setStatus(`正在恢复预设 ${target + 1}...`);
  try {
    const result = await restorePreset(connection, target, invalidateMacroSelection);
    if (selectedPreset !== target) return;
    presetData = result;
    baselineName = '';
    $('#preset-name').value = '';
    applyBindingReadback(result);
    renderPresets();
    setStatus('当前预设已恢复默认并读回校验通过');
  } catch (error) {
    setStatus(describeError(error), true);
  } finally {
    busy = false;
    setControls();
  }
});

$('#restore-all').addEventListener('click', async () => {
  if (!connection || busy || macroRun || macroRecording || !confirmDiscard() ||
      !window.confirm('确认将 4 个预设全部恢复为出厂默认配置？')) return;
  busy = true;
  setControls();
  setStatus('正在恢复全部预设...');
  try {
    const summary = await restoreAll(connection, invalidateMacroSelection);
    presetData = summary;
    await loadBindings(summary.activePreset);
    renderPresets();
    setStatus('全部预设已恢复，当前生效为预设 1');
  } catch (error) {
    setStatus(describeError(error), true);
  } finally {
    busy = false;
    setControls();
  }
});

function bindingSummary(layer) {
  const counts = [0, 0, 0];
  for (const binding of layer) counts[binding.type] += 1;
  return `默认 ${counts[0]} · 改键 ${counts[1]} · 宏 ${counts[2]}`;
}

async function loadBindings(id) {
  presetGate.invalidate();
  setStatus(`正在读取预设 ${id + 1}...`);
  const data = decodeBindings(await connection.exchange(4, new Uint8Array([id, 0])), id);
  selectedPreset = id;
  original = cloneLayers(data.layers);
  draft = cloneLayers(data.layers);
  baselineName = presetData.presets.find(preset => preset.id === id)?.name || '';
  $('#preset-name').value = baselineName;
  document.querySelector('#default-bindings').textContent = bindingSummary(data.layers[0]);
  document.querySelector('#fn-bindings').textContent = bindingSummary(data.layers[1]);
  renderPresets();
  renderEditor();
}

function applyBindingReadback(data) {
  original = cloneLayers(data.layers);
  draft = cloneLayers(data.layers);
  $('#default-bindings').textContent = bindingSummary(data.layers[0]);
  $('#fn-bindings').textContent = bindingSummary(data.layers[1]);
  renderEditor();
}

function describeError(error) {
  if (error.name === 'NotFoundError') return '未选择设备。';
  if (error.name === 'InvalidStateError' || error.name === 'NetworkError') {
    return '串口无法打开；请先断开旧网页或其他串口软件。';
  }
  if (/错误码 1$/.test(error.message)) return '键盘配置尚未解锁，请按 Fn+Back。';
  if (/错误码 7$/.test(error.message)) return '设备忙，请稍后重试。';
  return error.message || '设备连接失败。';
}

$('#layer-select').addEventListener('change', () => { if (!macroRecording) { capturing = false; renderEditor(); } });
$('#key-filter').addEventListener('input', () => { if (!macroRecording) renderEditor(); });
$('#usage-search').addEventListener('input', () => { if (!macroRecording) renderKeyDetails(); });
$('#preset-name').addEventListener('input', renderKeyDetails);
$('#binding-select').addEventListener('change', event => {
  if (!draft || busy || macroRun || macroRecording || isReserved(selectedKey, layer())) return;
  const value = event.target.value;
  draft[layer()][selectedKey] = value === 'default' ? {type: 0, keyUsage: 0} :
    value.startsWith('macro:') ? {type: 2, macroIndex: Number(value.slice(6))} :
      {type: 1, keyUsage: Number(value.slice(4))};
  capturing = false;
  renderEditor();
});
$('#restore-key').addEventListener('click', () => {
  if (!connection || !draft || busy || macroRun || macroRecording || isReserved(selectedKey, layer())) return;
  const target = Object.freeze({layer: layer(), keyIndex: selectedKey});
  capturing = false;
  const keyTarget = `${target.layer}:${target.keyIndex}`;
  const currentMacroTarget = macroBaseline ? $('#macro-target').value : '';
  const savedMacroTarget = macroBaseline?.target ?? currentMacroTarget;
  if (restoreKeyScope(savedMacroTarget, currentMacroTarget, keyTarget) === 'macro') {
    $('#macro-target').value = '';
    applyMacroTarget();
    setStatus(macroDirty()
      ? `已取消宏 ${selectedMacroSlot + 1} 的按键绑定草稿，请点击保存宏`
      : '已取消未保存的宏按键绑定');
    return;
  }
  draft = restoreDraftKey(draft, target);
  renderEditor();
  setControls();
  setStatus('此键已恢复为默认草稿，请点击保存按键修改');
});
$('#capture').addEventListener('click', () => {
  if (!draft || busy || macroRun || macroRecording || isReserved(selectedKey, layer())) return;
  capturing = true;
  renderEditor();
  setStatus('请按下要绑定的实体键');
});
function handleKeyCaptureEvent(event) {
  if (!capturing || !draft || busy || macroRun || macroRecording) return;
  if (event.code === 'Escape') { capturing = false; renderEditor(); setStatus('已取消按键捕获'); return; }
  const usage = usageFromCode(event.code);
  if (!usage) return;
  event.preventDefault();
  event.stopPropagation();
  draft[layer()][selectedKey] = {type: 1, keyUsage: usage};
  capturing = false;
  renderEditor();
  setStatus(`已选择 ${usageLabel(usage)}，点击保存按键修改写入键盘`);
}

document.addEventListener('keydown', handleKeyCaptureEvent, true);

function appendRecordedMacroLine(text) {
  if (!macroRecording || !macroEditor) return;
  const inserted = macroEditor.appendRecordedLine(macroRecording.anchor, text);
  macroRecording.anchor = inserted.anchor;
}

function toggleMacroRecording() {
  if (macroRecording) stopMacroRecording();
  else startMacroRecording();
}

function startMacroRecording() {
  if (selectedMacroSlot === null || macroRun || busy || !macroEditor) return;
  capturing = false;
  macroRecording = {anchor: macroEditor.createRecordingAnchor(), lastEventAt: 0};
  setControls();
  setMacroRunStatus(`录制中，间隔达到 ${MACRO_RECORD_WAIT_THRESHOLD_MS} ms 时插入等待；按 Esc 停止。`);
}

function stopMacroRecording(showMessage = true) {
  capturing = false;
  if (!macroRecording) return;
  macroRecording = null;
  if (showMessage) setMacroRunStatus('录制已停止。');
  setControls();
}

function handleMacroRecordingEvent(event) {
  if (!macroRecording) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') {
    stopMacroRecording();
    return;
  }
  if (event.type === 'keydown' && event.repeat) return;
  const usage = usageFromCode(event.code);
  if (!usage) return;
  const now = performance.now();
  const result = recordedInstructions({
    type: event.type,
    usage,
    now,
    lastEventAt: macroRecording.lastEventAt
  });
  if (!result.lines.length) {
    if (!sourceUsageToken(usage)) setMacroRunStatus(`无法录制 ${usageLabel(usage)}：宏语言不支持此按键。`, true);
    return;
  }
  for (const line of result.lines) appendRecordedMacroLine(line);
  macroRecording.lastEventAt = result.lastEventAt;
}

function clearMacroDraft() {
  if (macroRecording || !window.confirm('确认清空当前宏的所有指令？')) return;
  stopMacroRecording(false);
  if (!macroEditor) return;
  macroEditor.clear();
  macroClearRequested = true;
  macroEditor.focus();
  setMacroRunStatus('当前宏指令已清空，点击“保存宏”后写入键盘。');
  setControls();
}

$('#discard').addEventListener('click', () => {
  if (!draft || busy || macroRun || macroRecording) return;
  draft = cloneLayers(original);
  capturing = false;
  renderEditor();
  setStatus('已放弃未保存的按键修改');
});
$('#save-name').addEventListener('click', async () => {
  if (!connection || busy || macroRun || macroRecording || !draft || !original) return;
  const token = presetGate.capture({presetId: selectedPreset});
  const context = Object.freeze({presetId: selectedPreset, name: $('#preset-name').value, token});
  if (baselineName === context.name) return;
  busy = true;
  setControls();
  setStatus('正在保存名称并从设备读回校验...');
  try {
    const summary = await savePresetName(connection, context.presetId, context.name);
    if (!presetGate.isCurrent(context.token, {presetId: selectedPreset})) return;
    presetData = summary;
    baselineName = context.name;
    renderPresets();
    setStatus('名称已保存并校验通过');
  } catch (error) {
    if (!presetGate.isCurrent(context.token, {presetId: selectedPreset})) return;
    setStatus(describeError(error), true);
  } finally {
    busy = false;
    setControls();
  }
});

$('#save-bindings').addEventListener('click', async () => {
  if (!connection || busy || macroRun || macroRecording || !draft || !original || !bindingsDirty()) return;
  if (selectedMacroSlot !== null && macroDirty()) {
    const referencesDirtyMacro = draft.some((bindings, targetLayer) => bindings.some((binding, keyIndex) =>
      binding.type === 2 && binding.macroIndex === selectedMacroSlot &&
      !bindingEqual(binding, original[targetLayer][keyIndex])));
    if (referencesDirtyMacro) {
      setStatus(`按键修改引用了尚未保存的宏 ${selectedMacroSlot + 1}，请先保存宏 ${selectedMacroSlot + 1}`, true);
      return;
    }
  }
  const token = presetGate.capture({presetId: selectedPreset});
  const context = Object.freeze({presetId: selectedPreset, layers: cloneLayers(draft), token});
  const loadedMacroWasClean = Boolean(macroBaseline) && !macroDirty();
  busy = true;
  setControls();
  setStatus('正在保存按键修改并从设备读回校验...');
  try {
    const verified = await saveBindings(connection, context.presetId, context.layers);
    if (!presetGate.isCurrent(context.token, {presetId: selectedPreset})) return;
    applyBindingReadback(verified);
    if (loadedMacroWasClean && selectedMacroSlot !== null) {
      renderMacroTargetOptions();
      $('#macro-target').value = findMacroTarget(selectedMacroSlot);
      macroBaseline = macroSnapshot();
    }
    setStatus('按键修改已保存并校验通过');
  } catch (error) {
    if (!presetGate.isCurrent(context.token, {presetId: selectedPreset})) return;
    setStatus(describeError(error), true);
  } finally {
    busy = false;
    setControls();
  }
});

connectButton.addEventListener('click', async () => {
  if (busy || macroRun || macroRecording || connection || !navigator.serial) return;
  busy = true;
  setControls();
  setStatus('等待选择键盘...');
  let candidate;
  try {
    const port = await navigator.serial.requestPort({
      filters: [{usbVendorId: 0x1d50, usbProductId: 0x615e}]
    });
    candidate = new K380Connection(port);
    setStatus('正在读取设备信息...');
    await candidate.open();
    await candidate.exchange(1);
    const info = decodeInfo(await candidate.exchange(2));
    if (info.protocolVersion !== 2 || info.presetCount !== 4 || info.layerCount !== 2 || info.keyCount !== 80) {
      throw new Error('设备配置规格与此网页不兼容，已取消连接');
    }
    presetData = decodePresets(await candidate.exchange(3));
    connection = candidate;
    showDetails(port, info);
    await loadBindings(presetData.activePreset);
    selectedMacroSlot = null;
    setStatus('已连接');
  } catch (error) {
    if (candidate) await candidate.close().catch(() => {});
    connection = null;
    clearDetails();
    clearPresets();
    setStatus(describeError(error), true);
  } finally {
    busy = false;
    setControls();
  }
});

disconnectButton.addEventListener('click', async () => {
  if (!connection || busy || macroRun || macroRecording) return;
  if (!confirmDiscard()) return;
  busy = true;
  setControls();
  try {
    await connection.close();
    setStatus('已断开');
  } catch (error) {
    setStatus(describeError(error), true);
  } finally {
    connection = null;
    busy = false;
    clearDetails();
    clearPresets();
    setControls();
  }
});

window.addEventListener('beforeunload', event => {
  if (!changedCount() && !macroDirty() && !macroRun && !busy) return;
  event.preventDefault();
  event.returnValue = '';
});

ensureMacroAuthoringControls();
document.addEventListener('keydown', handleMacroRecordingEvent, true);
document.addEventListener('keyup', handleMacroRecordingEvent, true);
renderMacroTargetOptions();
renderBindingOptions();

function macroBackupUnavailable() {
  return macroSourceUnavailable && !macroClearRequested && !readMacroEditorSource().trim();
}

async function importMacroBackup(file) {
  if (!file || !connection || busy || macroRun || macroRecording || !macroBaseline || !macroEditor) return;
  const context = macroGate.capture({presetId: selectedPreset, slot: selectedMacroSlot});
  const editor = macroEditor;
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('宏备份文件过大');
    const imported = parseBackup(await file.text(), file.name);
    if (!macroGate.isCurrent(context, {presetId: selectedPreset, slot: selectedMacroSlot}) ||
        macroEditor !== editor || busy || macroRun || macroRecording || !connection) return;
    if (macroDirty() && !window.confirm('当前宏有未保存的修改，确认用导入文件替换编辑草稿？')) return;
    createMacroEditor(imported.source);
    $('#macro-name').value = imported.name;
    $('#macro-trigger').value = String(imported.trigger);
    $('#macro-count').value = String(imported.repeatCount);
    $('#macro-count-field').hidden = imported.trigger !== 3;
    macroSourceUnavailable = false;
    macroClearRequested = true;
    $('#macro-source-status').textContent = '已导入源码备份';
    $('#macro-source-notice').hidden = true;
    compileMacroSource(imported.source);
    setControls();
    setMacroRunStatus('宏文件已导入为编辑草稿，未写入键盘；点击保存宏后写入。');
  } catch (error) {
    if (macroGate.isCurrent(context, {presetId: selectedPreset, slot: selectedMacroSlot})) {
      setMacroRunStatus(`导入失败：${describeError(error)}`, true);
    }
  }
}

function exportMacroBackup() {
  if (busy || macroRun || macroRecording || !macroBaseline || !macroEditor || macroBackupUnavailable()) return;
  try {
    const file = createBackup(macroSnapshot(), macroBaseline.name, selectedPreset, selectedMacroSlot);
    const url = URL.createObjectURL(new Blob([file.text], {type: 'application/json;charset=utf-8'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    document.body.append(link);
    try { link.click(); }
    finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    setMacroRunStatus(`已发起源码备份下载：${file.filename}；未修改键盘。`);
  } catch (error) { setMacroRunStatus(`导出失败：${describeError(error)}`, true); }
}

$('#import-macro').addEventListener('click', () => {
  if (!busy && !macroRun && !macroRecording && macroBaseline) $('#macro-file').click();
});
$('#macro-file').addEventListener('change', event => {
  const file = event.target.files[0];
  event.target.value = '';
  void importMacroBackup(file);
});
$('#export-macro').addEventListener('click', exportMacroBackup);

$('#compile-macro').addEventListener('click', () => {
  if (macroRecording) return;
  clearTimeout(compileTimer);
  compileTimer = null;
  if (macroEditor) macroEditor.clearLineResults();
  compileMacroSource(readMacroEditorSource());
});

function compileMacroSource(source) {
  const output = $('#compile-status');
  try {
    const result = prepareMacroDraft(source);
    output.textContent = result.empty ? '空宏没有可执行动作' :
      `编译成功：代码 ${result.code.length} 字节，程序包 ${result.package.length} 字节，CRC ${result.packageCrc32.toString(16).padStart(8, '0').toUpperCase()}`;
    output.classList.remove('error');
  } catch (error) {
    output.textContent = error.message || '宏编译失败';
    output.classList.add('error');
    if (macroEditor && Number.isInteger(error.line) && error.line > 0 &&
        error.line <= macroEditor.cm.lineCount()) {
      macroEditor.setLineResult(error.line - 1, output.textContent, 'error');
    }
  }
}
for (const id of ['macro-name', 'macro-count', 'macro-trigger']) {
  $(`#${id}`).addEventListener('input', () => {
    if (macroRecording) return;
    $('#macro-count-field').hidden = $('#macro-trigger').value !== '3';
    setControls();
  });
}

$('#save-macro').addEventListener('click', async () => {
  if (!connection || busy || macroRun || macroRecording || !macroBaseline || !macroDirty()) return;
  const {source, name, trigger, repeatCount} = macroSnapshot();
  const target = parseMacroTarget();
  const conflicts = macroBindingConflicts(original, draft, selectedMacroSlot, target);
  if (conflicts.length) {
    const labels = conflicts.map(item => item.layer ? `Fn+${physicalKeys[item.keyIndex]}` : physicalKeys[item.keyIndex]);
    setMacroRunStatus(`宏绑定与未保存的按键修改冲突：${labels.join('、')}。请先保存或放弃按键修改。`, true);
    return;
  }
  let compiled;
  try { compiled = prepareMacroDraft(source); }
  catch (error) { setMacroRunStatus(error.message, true); return; }
  if (compiled.empty && macroSourceUnavailable && !macroClearRequested) {
    setMacroRunStatus('设备宏源码不可恢复；请重新编辑有效宏，或点击“清空当前宏”后显式清空。', true);
    return;
  }
  busy = true;
  setControls();
  setMacroRunStatus('正在保存宏到设备并读回校验...');
  try {
    const layers = buildMacroBindings(original, selectedMacroSlot, target);
    const bindingsChanged = countBindingChanges(layers, original) > 0;
    const result = await saveMacroStages(
      () => saveMacro(connection, selectedPreset, selectedMacroSlot, compiled,
        {name, trigger, repeatCount},
        {onProgress: (written, total) => setMacroRunStatus(`正在保存 ${written}/${total} 字节...`)}),
      async () => {
        if (!bindingsChanged) return;
        const verified = await saveBindings(connection, selectedPreset, layers);
        ({original, draft} = mergeConfirmedBindingsPreservingDraft(original, draft, verified.layers));
        $('#default-bindings').textContent = bindingSummary(original[0]);
        $('#fn-bindings').textContent = bindingSummary(original[1]);
        renderEditor();
      }
    );
    if (result.error) {
      setMacroRunStatus(result.macroSaved
        ? `宏已保存并读回校验通过，但按键绑定保存失败：${describeError(result.error)}`
        : `保存未获确认：${describeError(result.error)}`, true);
      return;
    }
    let warning = '';
    try {
      if (compiled.empty) clearSourceSlot(localStorage, selectedPreset, selectedMacroSlot);
      else saveSource(localStorage, selectedPreset, selectedMacroSlot, result.macro.packageCrc32, source);
    }
    catch { warning = '；但本机源码保存失败，请保留当前编辑内容'; }
    macroNames[selectedMacroSlot] = name;
    macroSourceUnavailable = false;
    macroClearRequested = false;
    $('#macro-source-notice').hidden = true;
    macroBaseline = macroSnapshot();
    $('#macro-source-status').textContent = warning ? '本机源码未保存' :
      compiled.empty ? '空宏槽位' : '已从本机恢复与设备匹配的源码';
    setMacroRunStatus(`设备已保存并读回校验通过${warning}`, Boolean(warning));
  } catch (error) {
    setMacroRunStatus(`保存未获确认：${describeError(error)}`, true);
  } finally {
    busy = false;
    setControls();
  }
});

function setMacroRunStatus(message, tone = false) {
  $('#macro-run-status').textContent = message;
  $('#macro-run-status').classList.toggle('error', tone === true);
  $('#macro-run-status').classList.toggle('warning', tone === 'warning');
}

function isCurrentRun(run) {
  return macroRun === run && macroGate.isCurrent(run, {presetId: selectedPreset,
    slot: selectedMacroSlot, source: readMacroEditorSource()});
}

function isCurrentRunSelection(run) {
  return macroRun === run && run.presetId === selectedPreset && run.slot === selectedMacroSlot;
}

function setCurrentRunStatus(run, message, tone = false) {
  if (isCurrentRun(run)) setMacroRunStatus(message, tone);
}

function sendStopOnce(run) {
  if (run.stopSent) return Promise.resolve();
  run.stopSent = true;
  return stopMacro(run.connection, run.runId);
}

function requestMacroStop(run) {
  if (run.stopRequested) return;
  run.stopRequested = true;
  run.stopPending = true;
  run.stopPromise = Promise.resolve(run.pendingRead).catch(() => {}).then(() => sendStopOnce(run))
    .finally(() => {
      run.stopPending = false;
      if (macroRun === run) setControls();
    });
  run.stopPromise.catch(error => {
    run.stopError = error;
    if (isCurrentRunSelection(run)) {
      setMacroRunStatus(`运行 ${run.runId} 停止请求失败：${describeError(error)}；尚未确认设备停止`, true);
      setControls();
    }
  });
  if (isCurrentRunSelection(run)) setMacroRunStatus(`正在停止运行 ${run.runId}...`);
  setControls();
}

function invalidateMacroRun() {
  if (!macroRun) return;
  requestMacroStop(macroRun);
}

function renderTraceEvent(run, event) {
  if (!isCurrentRun(run)) return;
  const result = accumulateLineResult(run.counts, event, run.pcToLine);
  if (result && result.lineIndex < macroEditor.cm.lineCount()) {
    macroEditor.setLineResult(result.lineIndex, result.text, event.result ? 'error' : 'success');
  }
}

async function monitorMacroRun(run) {
  if (run.monitoring) return;
  run.monitoring = true;
  let terminalOutcome = null;
  let terminalPages = 0;
  run.unknown = false;
  setControls();
  try {
    while (macroRun === run) {
      run.pendingRead = readRunState(run.connection, run.runId, run.cursor);
      const state = await run.pendingRead;
      run.pendingRead = null;
      if (macroRun !== run) return;
      const previousCursor = run.cursor;
      run.cursor = state.nextCursor;
      if (state.traceLost || state.dropped) {
        run.warning = `部分执行日志丢失（${state.dropped} 条）`;
      }
      for (const event of state.events) {
        renderTraceEvent(run, event);
      }
      if (state.state !== 1 && state.state !== 2 && state.state !== 3 && state.state !== 4) {
        throw new Error(`设备返回未知运行状态 ${state.state}`);
      }
      if (state.state === 2 || state.state === 3 || state.state === 4) terminalOutcome ||= runOutcome(state);
      if (terminalOutcome) {
        terminalPages += 1;
        if (state.events.length && (state.nextCursor === previousCursor || terminalPages >= 128)) {
          setCurrentRunStatus(run, `运行 ${run.runId} 已结束，但执行日志未能完整读取${run.warning ? `；${run.warning}` : ''}`, 'warning');
          macroRun = null;
          break;
        }
        if (!state.events.length) {
          setCurrentRunStatus(run, `${terminalOutcome.message}${run.warning ? `；${run.warning}` : ''}`,
            terminalOutcome.error ? true : run.warning ? 'warning' : false);
          macroRun = null;
          break;
        }
        setCurrentRunStatus(run, `运行 ${run.runId} 已结束，正在读取剩余日志${run.warning ? `；${run.warning}` : '...'}`,
          run.warning ? 'warning' : false);
        continue;
      }
      setCurrentRunStatus(run, `${run.stopError ? `运行 ${run.runId} 停止请求失败：${describeError(run.stopError)}；尚未确认设备停止` : run.stopRequested ? `运行 ${run.runId} 正在停止` : `运行 ${run.runId} 正在设备上执行`}${run.warning ? `；${run.warning}` : '...'}`, run.stopError ? true : run.warning ? 'warning' : false);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  } catch (error) {
    run.pendingRead = null;
    if (run.stopPromise) await run.stopPromise.catch(() => {});
    if (macroRun === run) {
      if (terminalOutcome) {
        if (isCurrentRun(run)) setCurrentRunStatus(run,
          `运行 ${run.runId} 已结束，但执行日志未能完整读取：${describeError(error)}`, 'warning');
        macroRun = null;
      } else {
        run.unknown = true;
        if (isCurrentRun(run)) setCurrentRunStatus(run,
          `无法确认运行 ${run.runId} 的设备状态：${describeError(error)}${run.stopError ? `；停止请求失败：${describeError(run.stopError)}` : ''}；请重新确认状态`, true);
      }
    }
  } finally {
    run.monitoring = false;
    setControls();
  }
}

$('#test-macro').addEventListener('click', async () => {
  if (!connection || selectedPreset === null || busy || macroRun || macroRecording) return;
  clearTimeout(compileTimer);
  compileTimer = null;
  macroEditor.clearLineResults();
  const source = readMacroEditorSource();
  let compiled;
  try {
    compiled = prepareMacroDraft(source);
  } catch (error) {
    setMacroRunStatus(error.message, true);
    compileMacroSource(source);
    return;
  }
  if (compiled.empty) {
    macroEditor.clearLineResults();
    setMacroRunStatus('空宏没有可执行动作，未向设备发送测试命令。');
    return;
  }
  const context = macroGate.capture({presetId: selectedPreset, slot: selectedMacroSlot, source});
  const runConnection = connection;
  busy = true;
  setControls();
  setMacroRunStatus('正在上传未保存的宏用于测试...');
  try {
    const runId = await uploadTestMacro(runConnection, context.presetId, compiled, {slot: context.slot,
      onProgress: (written, total) => {
        if (macroGate.isCurrent(context, {presetId: selectedPreset, slot: selectedMacroSlot,
          source: readMacroEditorSource()})) setMacroRunStatus(`正在上传 ${written}/${total} 字节...`);
      }
    });
    if (!macroGate.isCurrent(context, {presetId: selectedPreset, slot: selectedMacroSlot,
      source: readMacroEditorSource()})) {
      const staleRun = {...context, runId, connection: runConnection, cursor: 0, counts: new Map(),
        warning: '', pcToLine: compiled.pcToLine, stopRequested: false, stopSent: false};
      macroRun = staleRun;
      requestMacroStop(staleRun);
      void monitorMacroRun(staleRun);
      return;
    }
    const run = {...context, runId, connection: runConnection, cursor: 0, counts: new Map(),
      warning: '', pcToLine: compiled.pcToLine, stopRequested: false, stopSent: false};
    macroRun = run;
    setMacroRunStatus(`设备已启动运行 ${runId}，正在读取执行日志...`);
    busy = false;
    setControls();
    void monitorMacroRun(run);
  } catch (error) {
    if (macroGate.isCurrent(context, {presetId: selectedPreset, slot: selectedMacroSlot,
      source: readMacroEditorSource()})) setMacroRunStatus(`测试未获设备确认：${describeError(error)}`, true);
  } finally {
    busy = false;
    setControls();
  }
});

$('#stop-macro').addEventListener('click', () => {
  if (macroRun) requestMacroStop(macroRun);
});

$('#retry-macro-state').addEventListener('click', () => {
  if (macroRun?.unknown && !macroRun.monitoring && !macroRun.stopPending && !busy) {
    void monitorMacroRun(macroRun);
  }
});

if (!('serial' in navigator)) {
  setStatus('当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge。', true);
} else if (!isSecureContext) {
  setStatus('Web Serial 需要 HTTPS 或 localhost。', true);
} else {
  setStatus('未连接');
}
setControls();
