import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import {createGenerationGate} from './ui-model.mjs';
import {runOutcome} from './macro-trace.mjs';
import {restorePreset} from './presets.mjs';

const appSource = await readFile(new URL('./app.mjs', import.meta.url), 'utf8');

test('restore all invalidates macro context before binding readback can fail', () => {
  const handlerStart = appSource.indexOf("$('#restore-all').addEventListener('click'");
  const handlerEnd = appSource.indexOf("function bindingSummary", handlerStart);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);

  const handler = appSource.slice(handlerStart, handlerEnd);
  const invalidateAt = handler.indexOf('restoreAll(connection, invalidateMacroSelection)');
  const loadBindingsAt = handler.indexOf('await loadBindings(summary.activePreset);');

  assert.notEqual(invalidateAt, -1);
  assert.notEqual(loadBindingsAt, -1);
  assert.ok(
    invalidateAt < loadBindingsAt,
    'macro context must be invalidated after restoreAll succeeds and before loadBindings'
  );
});

for (const failure of ['summary', 'bindings', 'command']) {
test(`restore preset clears old macro state before ${failure} failure only after command success`, async () => {
  const handlerStart = appSource.indexOf("$('#restore-preset').addEventListener('click'");
  const handlerEnd = appSource.indexOf("$('#restore-all').addEventListener('click'", handlerStart);
  const elements = new Map();
  const context = {
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, {value: '', textContent: '',
        addEventListener(type, handler) { this.handler = handler; }});
      return elements.get(selector);
    },
    restorePreset, confirmDiscard: () => true, setControls() {}, setStatus() {},
    describeError: error => error.message, renderMacroTargetOptions() {}, renderMacroSlots() {},
    stopMacroRecording() {},
    connection: {async exchange(command) {
      if (command === 8) {
        assert.equal(context.snapshot().slot, 3);
        if (failure === 'command') throw new Error('restore rejected');
        return Uint8Array.of(0);
      }
      if (failure === 'bindings' && command === 3) {
        const reply = new Uint8Array(134);
        for (let id = 0; id < 4; id++) reply[2 + id * 33] = id;
        return reply;
      }
      throw new Error(`${failure} read failed`);
    }}
  };
  const clearStart = appSource.indexOf('function clearMacroDetails()');
  const clearEnd = appSource.indexOf('async function loadMacro', clearStart);
  const invalidateStart = appSource.indexOf('function invalidateMacroSelection()');
  const invalidateEnd = appSource.indexOf('function renderPresets', invalidateStart);
  vm.runInNewContext(`
    let selectedPreset = 0, selectedMacroSlot = 3, busy = false;
    let macroRun = null, macroRecording = null;
    let macroBaseline = {source: 'old source'}, macroSourceUnavailable = true, macroClearRequested = true;
    let macroNames = Array(16).fill('old name'), macroEditor = {source: 'old source'};
    function destroyMacroEditor() { macroEditor = null; }
    ${appSource.slice(clearStart, clearEnd)}
    ${appSource.slice(invalidateStart, invalidateEnd)}
    ${appSource.slice(handlerStart, handlerEnd)}
    globalThis.snapshot = () => ({slot: selectedMacroSlot, baseline: macroBaseline,
      editor: macroEditor, names: macroNames, unavailable: macroSourceUnavailable});
  `, context);
  await elements.get('#restore-preset').handler();
  const state = context.snapshot();
  if (failure === 'command') {
    assert.equal(state.slot, 3);
    assert.equal(state.baseline.source, 'old source');
    assert.equal(state.editor.source, 'old source');
  } else {
    assert.equal(state.slot, null);
    assert.equal(state.baseline, null);
    assert.equal(state.editor, null);
    assert.ok(state.names.every(name => name === ''));
    assert.equal(state.unavailable, false);
  }
});
}

for (const selection of ['preset', 'slot']) {
for (const response of ['terminated', 'warning', 'read failure', 'stop failure', 'terminal read failure']) {
test(`old macro ${response} cannot overwrite status after ${selection} changes`, async () => {
  let resolveRead;
  let rejectRead;
  let stopCalls = 0;
  let readCalls = 0;
  const status = {textContent: '', classList: {toggle() {}}};
  const gate = createGenerationGate();
  const currentContext = {source: 'old'};
  const context = {
    $: selector => selector === '#macro-run-status' ? status : {classList: {toggle() {}}, textContent: ''},
    macroGate: gate,
    readMacroEditorSource: () => currentContext.source,
    readRunState: () => {
      readCalls++;
      if (response === 'terminal read failure' && readCalls === 1) {
        return Promise.resolve({state: 2, events: [{}], nextCursor: 1});
      }
      return new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; });
    },
    stopMacro: async () => { stopCalls++; if (response === 'stop failure') throw new Error('STOP failed'); },
    describeError: error => error.message,
    runOutcome,
    accumulateLineResult: () => null,
    setControls() {},
    setTimeout,
    clearTimeout
  };
  const monitorStart = appSource.indexOf('function setMacroRunStatus');
  const monitorEnd = appSource.indexOf("$('#test-macro').addEventListener", monitorStart);
  const monitor = appSource.slice(monitorStart, monitorEnd);

  vm.runInNewContext(`
    let macroRun = null;
    let selectedPreset = 0;
    let selectedMacroSlot = 0;
    let macroEditor = {cm: {lineCount: () => 1}};
    ${monitor}
    globalThis.test = {
      start(run) { macroRun = run; return monitorMacroRun(run); },
      switchContext(selection) {
        if (selection === 'preset') selectedPreset = 1;
        if (selection === 'slot') selectedMacroSlot = 1;
        macroGate.invalidate();
        invalidateMacroRun();
        invalidateMacroRun();
      },
      setStatus(message) { setMacroRunStatus(message); },
      status() { return $('#macro-run-status').textContent; }
    };
  `, context);

  const run = {...gate.capture({presetId: 0, slot: 0, source: 'old'}),
    runId: 7, cursor: 0, counts: new Map(), pcToLine: new Map(),
    connection: {}, stopRequested: false, stopSent: false, warning: ''};
  const monitoring = context.test.start(run);
  if (response === 'terminal read failure') await new Promise(resolve => setImmediate(resolve));
  if (selection === 'source') currentContext.source = 'new';
  context.test.switchContext(selection);
  context.test.setStatus('新槽位正在读取');
  if (response === 'read failure' || response === 'terminal read failure') rejectRead(new Error('read failed'));
  else resolveRead({state: 2, events: [], nextCursor: 0,
    traceLost: response === 'warning', dropped: response === 'warning' ? 2 : 0});
  await monitoring;
  await run.stopPromise.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(context.test.status(), '新槽位正在读取');
  assert.equal(stopCalls, 1);
});
}
}

test('clearing macro details removes the stop status before the next slot context', async () => {
  const elements = new Map();
  const status = {textContent: '', classList: {toggle() {}}};
  let stopCalls = 0;
  for (const selector of ['#macro-name', '#macro-target', '#macro-trigger', '#macro-count',
    '#macro-count-field', '#macro-source-status', '#macro-source-notice', '#compile-status']) {
    elements.set(selector, {value: '', textContent: '', hidden: false,
      classList: {toggle() {}}});
  }
  elements.set('#macro-run-status', status);
  const context = {
    $: selector => elements.get(selector),
    macroGate: createGenerationGate(),
    macroEditor: {destroy() {}},
    macroRun: {presetId: 0, slot: 0, runId: 9, pendingRead: Promise.resolve(),
      stopRequested: false, stopSent: false, connection: {}},
    selectedPreset: 0,
    selectedMacroSlot: 0,
    macroBaseline: {source: 'old'},
    macroSourceUnavailable: true,
    macroClearRequested: true,
    compileTimer: null,
    stopMacroRecording() {},
    renderMacroTargetOptions() {},
    setControls() {},
    describeError: error => error.message,
    clearTimeout,
    stopMacro: async () => { stopCalls++; throw new Error('STOP failed'); }
  };
  const destroyStart = appSource.indexOf('function destroyMacroEditor()');
  const destroyEnd = appSource.indexOf('\nfunction macroSourceChanged', destroyStart);
  const clearStart = appSource.indexOf('function clearMacroDetails()');
  const clearEnd = appSource.indexOf('\nasync function loadMacro', clearStart);
  const stopStart = appSource.indexOf('function setMacroRunStatus');
  const stopEnd = appSource.indexOf('\nfunction renderTraceEvent', stopStart);
  assert.notEqual(destroyStart, -1);
  assert.notEqual(clearStart, -1);
  assert.notEqual(stopStart, -1);
  const vmContext = {...context, initialEditor: context.macroEditor, initialRun: context.macroRun};
  vm.runInNewContext(`
    let macroEditor = globalThis.initialEditor;
    let macroRun = globalThis.initialRun;
    let selectedPreset = 0;
    let selectedMacroSlot = 0;
    let macroBaseline = {source: 'old'};
    let macroSourceUnavailable = true;
    let macroClearRequested = true;
    let compileTimer = null;
    ${appSource.slice(stopStart, stopEnd)}
    ${appSource.slice(destroyStart, destroyEnd)}
    ${appSource.slice(clearStart, clearEnd)}
    globalThis.test = {
      clear() { clearMacroDetails(); },
      setSlot(slot) { selectedMacroSlot = slot; },
      setStatus(message) { setMacroRunStatus(message); },
      status() { return $('#macro-run-status').textContent; },
      stopPromise() { return macroRun.stopPromise; }
    };
  `, vmContext);

  vmContext.test.clear();
  assert.equal(vmContext.test.status(), '', 'context teardown must remove synchronous stop status');
  vmContext.test.setSlot(1);
  vmContext.test.setStatus('新槽位正在读取');
  await vmContext.test.stopPromise().catch(() => {});
  assert.equal(vmContext.test.status(), '新槽位正在读取');
  assert.equal(stopCalls, 1);
});

test('recording locks macro authoring controls but keeps stop recording available', () => {
  const controlsStart = appSource.indexOf('function setControls()');
  const controlsEnd = appSource.indexOf('\nfunction showDetails', controlsStart);
  const controls = appSource.slice(controlsStart, controlsEnd);

  assert.match(controls, /const macroBlocked = blocked \|\| Boolean\(macroRecording\);/);
  assert.match(controls, /macroBlocked \|\| !macroBaseline/);
  assert.match(controls, /#macro-insert-tools button:not\(#record-macro\), #clear-macro/);
  assert.match(controls, /recordButton\.disabled = \(!macroRecording && blocked\) \|\| !macroBaseline;/);
  assert.match(appSource, /button\.disabled = macroBlocked \|\| !connection;/);
});

test('recording locks page context even when busy and keeps its stop control enabled', () => {
  const controlsStart = appSource.indexOf('function setControls()');
  const controlsEnd = appSource.indexOf('\nfunction showDetails', controlsStart);
  const controls = appSource.slice(controlsStart, controlsEnd);
  const renderKeyDetailsStart = appSource.indexOf('function renderKeyDetails()');
  const renderKeyDetailsEnd = appSource.indexOf('\nfunction renderEditor', renderKeyDetailsStart);
  const renderKeyDetails = appSource.slice(renderKeyDetailsStart, renderKeyDetailsEnd);
  const renderEditorStart = appSource.indexOf('function renderEditor()');
  const renderEditorEnd = appSource.indexOf('\nfunction renderBindingOptions', renderEditorStart);
  const renderEditor = appSource.slice(renderEditorStart, renderEditorEnd);

  assert.match(controls, /connectButton\.disabled = macroBlocked/);
  assert.match(controls, /disconnectButton\.disabled = macroBlocked/);
  assert.match(controls, /#presets button.*navigationBlocked/);
  assert.match(controls, /#editor input, #editor select, #editor button[\s\S]*macroBlocked/);
  assert.match(controls, /recordButton\.disabled = \(!macroRecording && blocked\) \|\| !macroBaseline;/);
  assert.match(appSource, /tab\.disabled = macroBlocked \|\| !connection;/);
  assert.match(renderKeyDetails, /const blocked = busy \|\| Boolean\(macroRun\) \|\| Boolean\(macroRecording\);/);
  assert.match(renderEditor, /button\.disabled = busy \|\| Boolean\(macroRun\) \|\| Boolean\(macroRecording\) \|\| isReserved\(index, level\);/);
  assert.match(appSource, /if \(!connection \|\| busy \|\| macroRun \|\| macroRecording\)/);
});

test('recording blocks generated key handlers and clears capture before the next key', () => {
  const renderStart = appSource.indexOf('function renderEditor()');
  const renderEnd = appSource.indexOf('\nfunction renderBindingOptions', renderStart);
  const renderEditor = appSource.slice(renderStart, renderEnd);
  const captureStart = appSource.indexOf('function handleKeyCaptureEvent(');
  const captureEnd = appSource.indexOf("\ndocument.addEventListener('keydown', handleKeyCaptureEvent", captureStart);
  const captureHandler = appSource.slice(captureStart, captureEnd);
  const stopStart = appSource.indexOf('function stopMacroRecording(');
  const stopEnd = appSource.indexOf('\nfunction handleMacroRecordingEvent', stopStart);
  const stopHandler = appSource.slice(stopStart, stopEnd);

  assert.notEqual(captureStart, -1, 'key capture must be a named handler for direct regression coverage');
  assert.notEqual(stopStart, -1);

  const elements = new Map();
  const buttons = [];
  const makeElement = tag => {
    const handlers = {};
    const element = {
      tagName: tag,
      hidden: false,
      value: '',
      textContent: '',
      disabled: false,
      dataset: {},
      style: {setProperty() {}},
      classList: {toggle() {}},
      setAttribute() {},
      append() {},
      addEventListener(type, handler) { handlers[type] = handler; },
      handlers
    };
    if (tag === 'button') buttons.push(element);
    return element;
  };
  const rows = {
    replaceChildren() {},
    append() {},
    querySelectorAll() { return []; }
  };
  elements.set('#editor', makeElement('section'));
  elements.set('#key-filter', makeElement('input'));
  elements.set('#keyboard-layout', rows);
  elements.set('#key-filter-status', makeElement('span'));

  const context = {
    document: {createElement: makeElement},
    $: selector => elements.get(selector),
    keyRows: [[{index: 0, width: 1}]],
    draft: [[{type: 0, keyUsage: 0}]],
    original: [[{type: 0, keyUsage: 0}]],
    selectedKey: 7,
    capturing: false,
    macroRecording: {anchor: {line: 0}, lastEventAt: 0},
    busy: false,
    macroRun: null,
    layer: () => 0,
    macroPreviewLayers: () => context.draft,
    bindingVisualState: () => ({savedType: 'default', dirty: false}),
    matchesKeyQuery: () => true,
    physicalKeys: ['A'],
    defaultLabel: () => '',
    bindingLabel: () => '',
    isReserved: () => false,
    renderKeyDetails() {},
    setStatus() {},
    setMacroRunStatus() {},
    setControls() {},
    usageFromCode: () => 4,
    usageLabel: () => 'A'
  };

  vm.runInNewContext(`${renderEditor}\nrenderEditor();`, context);
  assert.equal(buttons.length, 1);
  buttons[0].handlers.click();
  buttons[0].handlers.dblclick();
  assert.equal(context.selectedKey, 7);
  assert.equal(context.capturing, false);

  context.capturing = true;
  vm.runInNewContext(`${stopHandler}\nstopMacroRecording(false);`, context);
  assert.equal(context.macroRecording, null);
  assert.equal(context.capturing, false);
  const before = JSON.stringify(context.draft);
  vm.runInNewContext(`${captureHandler}\nhandleKeyCaptureEvent({code: 'KeyB'});`, context);
  assert.equal(JSON.stringify(context.draft), before);
});
