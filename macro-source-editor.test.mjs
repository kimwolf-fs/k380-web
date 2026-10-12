import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {prepareMacroDraft} from './macro-compiler.mjs';
import {readRunState, stopMacro} from './macro-device.mjs';
import {accumulateLineResult, runOutcome} from './macro-trace.mjs';
import {createGenerationGate, filterUsageOptions} from './ui-model.mjs';

const require = createRequire(import.meta.url);
const editorApi = require('./macro-source-editor.js');
const appSource = await readFile(new URL('./app.mjs', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('./index.html', import.meta.url), 'utf8');

test('continues indentation after a block header', () => {
  assert.equal(editorApi.continuationIndent('如果 计时器 1 大于等于 5:'), '    ');
});

test('inserts a recorded line after the recording anchor', () => {
  assert.equal(editorApi.testing.planRecordedLineInsertion(
    '点击 A\n点击 C',
    {line: 0, indent: '', replaceEmpty: false},
    '等待 20',
  ).value, '点击 A\n等待 20\n点击 C');
});

test('recording anchors preserve source at empty, first, middle, and last lines', () => {
  const cases = [
    ['', {line: 0, indent: '', replaceEmpty: true}, '按下 A', '按下 A'],
    ['点击 A', {line: 0, indent: '', replaceEmpty: true}, '弹起 A', '点击 A\n弹起 A'],
    ['点击 A\n点击 C', {line: 0, indent: '', replaceEmpty: false}, '等待 20', '点击 A\n等待 20\n点击 C'],
    ['点击 A\n点击 C\n点击 D', {line: 1, indent: '', replaceEmpty: false}, '等待 20', '点击 A\n点击 C\n等待 20\n点击 D'],
    ['点击 A\n点击 C', {line: 1, indent: '', replaceEmpty: false}, '弹起 C', '点击 A\n点击 C\n弹起 C']
  ];
  for (const [source, anchor, text, expected] of cases) {
    assert.equal(editorApi.testing.planRecordedLineInsertion(source, anchor, text).value, expected);
  }
});

test('page exposes all macro authoring templates and draft-only controls', () => {
  for (const text of [
    '按下 A', '弹起 A', '点击 A', '等待 200', '随机等待 100 300', '释放全部',
    '重置计时器 1', '如果 计时器 1 大于等于 300000:', '循环次数 10:',
    '循环时长 300000:', '定义 动作():', '调用 动作'
  ]) {
    assert.ok(appSource.includes(`text: '${text}'`), text);
  }
  assert.match(appSource, /event\.preventDefault\(\)/);
  assert.match(appSource, /event\.stopPropagation\(\)/);
  assert.match(appSource, /macroEditor\.clear\(\)/);
  assert.match(appSource, /buildMacroBindings\(/);
  assert.match(appSource, /empty\.value = ''/);
  assert.doesNotMatch(appSource, /Math\.round\(performance\.now\(\)\)/);
});

test('empty test clears decorations before any upload and old polls cannot decorate lines', () => {
  assert.match(appSource, /if \(compiled\.empty\) \{\s*macroEditor\.clearLineResults\(\)/);
  assert.doesNotMatch(pageSource, /id="macro-events"/);
});

test('source changes debounce compilation and diagnostics use readonly line results', () => {
  assert.match(appSource, /setTimeout\(.*300\)/);
  assert.match(appSource, /prepareMacroDraft\(source\)/);
  assert.match(appSource, /macroEditor\.setLineResult\(error\.line - 1,/);
});

function pageHarness(source) {
  const elements = new Map();
  const node = () => ({
    value: '', textContent: '', children: [], style: {setProperty() {}},
    classList: {classes: new Set(), toggle(name, enabled) {
      if (enabled) this.classes.add(name);
      else this.classes.delete(name);
    }, add(name) { this.classes.add(name); }, remove(name) { this.classes.delete(name); },
    contains(name) { return this.classes.has(name); }},
    listeners: {}, setAttribute() {}, addEventListener(type, callback) { this.listeners[type] = callback; },
    append(child) { this.children.push(child); },
    replaceChildren() { this.children = []; }
  });
  const document = {
    querySelector(selector) {
      if (selector === '.macro-settings') return null;
      if (!elements.has(selector)) elements.set(selector, node());
      return elements.get(selector);
    },
    querySelectorAll(selector) {
      if (selector === '#presets button') return this.querySelector('#presets').children;
      return [];
    }, createElement: node, addEventListener() {}
  };
  document.querySelector('#stop-macro').textContent = '停止测试';
  document.querySelector('#retry-macro-state').textContent = '重新确认状态';
  document.querySelector('#retry-macro-state').hidden = true;
  let currentSource = source;
  const lineResults = [];
  let readOnly = false;
  const editor = {
    getValue: () => currentSource, clearLineResults() { lineResults.length = 0; },
    destroy() {},
    setLineResult(...args) { lineResults.push(args); }, cm: {setOption(key, value) {
      if (key === 'readOnly') readOnly = value;
    }, lineCount: () => 2}
  };
  let uploaded = 0;
  let stopped = 0;
  const reads = [];
  const cursors = [];
  let stopFailure = null;
  let scheduled;
  const connection = {exchange(command, request) {
    if (command === 17) {
      cursors.push(new DataView(request.buffer).getUint32(4, true));
      return new Promise((resolve, reject) => reads.push({resolve, reject}));
    }
    if (command === 18) {
      assert.equal(new DataView(request.buffer).getUint32(0, true), 42);
      stopped += 1;
      return stopFailure ? Promise.reject(stopFailure) : Promise.resolve(Uint8Array.of(0));
    }
    throw new Error(`unexpected protocol command ${command}`);
  }};
  const context = vm.createContext({
    document, window: {addEventListener() {}, confirm: () => true}, navigator: {serial: {}}, isSecureContext: true,
    setTimeout(callback, delay) { scheduled = {callback, delay}; return 1; },
    clearTimeout() { scheduled = null; },
    createGenerationGate, filterUsageOptions, prepareMacroDraft, accumulateLineResult, runOutcome,
    usageOptions: [], K380Connection: class {},
    uploadTestMacro: async () => { uploaded += 1; return 42; },
    readRunState, stopMacro, readMacro: () => new Promise(() => {})
  });
  vm.runInContext(appSource.replace(/^import[\s\S]*?from '[^']+';\r?\n/gm, ''), context);
  context.editorForTest = editor;
  context.connectionForTest = connection;
  vm.runInContext('connection = connectionForTest; selectedPreset = 0; selectedMacroSlot = 0; macroBaseline = {}; macroEditor = editorForTest', context);
  const resolveRead = (value) => {
    const payload = new Uint8Array(21 + value.events.length * 16);
    const view = new DataView(payload.buffer);
    payload[0] = value.traceLost ? 15 : 0;
    view.setUint32(1, value.runId, true);
    payload[5] = value.state;
    payload[6] = value.vmError;
    view.setUint32(9, value.nextCursor, true);
    view.setUint32(13, value.dropped, true);
    payload[17] = value.events.length;
    value.events.forEach((event, index) => {
      const offset = 21 + index * 16;
      view.setUint32(offset, event.sequence ?? index + 1, true);
      view.setUint16(offset + 4, event.pc, true);
      payload[offset + 6] = event.type;
      payload[offset + 7] = event.result;
      view.setUint32(offset + 8, event.value, true);
    });
    assert.ok(reads.length, 'expected a pending device read');
    reads.shift().resolve(payload);
  };
  return {
    context, elements, lineResults,
    click: () => elements.get('#test-macro').listeners.click(),
    changeSource(next) { if (readOnly) return false; currentSource = next; vm.runInContext('macroSourceChanged()', context); return true; },
    stop() { return elements.get('#stop-macro').listeners.click(); },
    retry() { return elements.get('#retry-macro-state').listeners.click(); },
    failStop(error) { stopFailure = error; },
    rejectRead(error) { assert.ok(reads.length); reads.shift().reject(error); },
    flushTimer() { const timer = scheduled; scheduled = null; timer.callback(); return timer.delay; },
    resolveRead, renderSlots() { vm.runInContext('renderMacroSlots()', context); },
    renderPresets() {
      vm.runInContext('presetData = {activePreset: 0, presets: [{id: 0, name: "A"}, {id: 1, name: "B"}]}; renderPresets()', context);
    },
    get cursors() { return cursors; }, get pendingReads() { return reads.length; },
    get editable() { return !readOnly; },
    get uploaded() { return uploaded; }, get stopped() { return stopped; }
  };
}

test('blank macro never uploads and clears stale line decorations', async () => {
  const page = pageHarness('   # empty');
  page.lineResults.push([0, 'old', 'success']);
  await page.click();
  assert.equal(page.uploaded, 0);
  assert.deepEqual(page.lineResults, []);
  assert.match(page.elements.get('#macro-run-status').textContent, /空宏没有可执行动作/);
});

test('source change stops the real run once and rejects late trace', async () => {
  const page = pageHarness('点击 A');
  await page.click();
  assert.equal(page.uploaded, 1);
  assert.match(page.elements.get('#macro-run-status').textContent, /运行 42/);
  page.changeSource('点击 B');
  page.changeSource('点击 C');
  page.resolveRead({runId: 42, state: 2, vmError: 0, nextCursor: 1, dropped: 0,
    traceLost: false, events: [{pc: 0, type: 3, value: 4, result: 0}]});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.stopped, 1);
  assert.deepEqual(page.lineResults, []);
});

test('context loss keeps a rejected stop visible and blocks another test until a terminal read', async () => {
  const page = pageHarness('点击 A');
  await page.click();
  page.failStop(new Error('设备拒绝停止'));
  page.changeSource('点击 B');
  page.rejectRead(new Error('读取超时'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.stopped, 1);
  assert.match(page.elements.get('#macro-run-status').textContent, /设备拒绝停止/);
  assert.equal(page.elements.get('#test-macro').disabled, true);
  assert.equal(page.elements.get('#save-macro').disabled, true);
  await page.click();
  assert.equal(page.uploaded, 1);
  page.retry();
  assert.equal(page.stopped, 1);
  assert.deepEqual(page.cursors, [0, 0]);
  page.resolveRead({runId: 42, state: 3, vmError: 0, nextCursor: 0, dropped: 0,
    traceLost: false, events: []});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.elements.get('#test-macro').disabled, false);
  assert.deepEqual(page.lineResults, []);
});

test('manual stop queues behind a failing read and is sent without a successful poll', async () => {
  const page = pageHarness('点击 A');
  await page.click();
  page.stop();
  page.rejectRead(new Error('读取超时'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.stopped, 1);
  assert.equal(page.elements.get('#test-macro').disabled, true);
  assert.match(page.elements.get('#macro-run-status').textContent, /无法确认/);
  page.retry();
  assert.equal(page.stopped, 1);
  page.resolveRead({runId: 42, state: 3, vmError: 0, nextCursor: 0, dropped: 0,
    traceLost: false, events: []});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.elements.get('#test-macro').disabled, false);
});

test('a failed read still exposes a stable STOP action with visible rejection and one real run ID', async () => {
  const page = pageHarness('点击 A');
  await page.click();
  page.rejectRead(new Error('读取超时'));
  await new Promise(resolve => setImmediate(resolve));
  page.failStop(new Error('设备拒绝停止'));
  const stopButton = page.elements.get('#stop-macro');
  assert.equal(stopButton.textContent, '停止测试');
  assert.equal(stopButton.disabled, false);
  page.stop();
  page.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.stopped, 1);
  assert.match(page.elements.get('#macro-run-status').textContent, /设备拒绝停止/);
  assert.equal(page.elements.get('#test-macro').disabled, true);
  assert.equal(page.elements.get('#save-macro').disabled, true);
});

test('rapid state retries never STOP and cannot duplicate an in-flight read', async () => {
  assert.match(pageSource, /id="stop-macro"[^>]*>停止测试<\/button>/);
  assert.match(pageSource, /id="retry-macro-state"[^>]*>重新确认状态<\/button>/);
  const page = pageHarness('点击 A');
  await page.click();
  page.rejectRead(new Error('读取超时'));
  await new Promise(resolve => setImmediate(resolve));
  const retryButton = page.elements.get('#retry-macro-state');
  assert.equal(retryButton.disabled, false);
  page.retry();
  page.retry();
  assert.equal(page.pendingReads, 1);
  assert.equal(page.stopped, 0);
  assert.equal(retryButton.disabled, true);
  assert.equal(page.elements.get('#stop-macro').textContent, '停止测试');
  page.resolveRead({runId: 42, state: 1, vmError: 0, nextCursor: 0, dropped: 0,
    traceLost: false, events: []});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.stopped, 0);
  assert.equal(page.elements.get('#stop-macro').textContent, '停止测试');
  page.stop();
  page.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.stopped, 1);
});

test('an unrecognized device state stays occupied and offers confirmation retry', async () => {
  const page = pageHarness('点击 A');
  await page.click();
  page.resolveRead({runId: 42, state: 9, vmError: 0, nextCursor: 0, dropped: 0,
    traceLost: false, events: []});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.elements.get('#test-macro').disabled, true);
  assert.match(page.elements.get('#macro-run-status').textContent, /未知运行状态/);
  assert.equal(page.elements.get('#retry-macro-state').hidden, false);
  assert.equal(page.elements.get('#stop-macro').textContent, '停止测试');
  page.retry();
  page.resolveRead({runId: 42, state: 3, vmError: 0, nextCursor: 0, dropped: 0,
    traceLost: false, events: []});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.elements.get('#test-macro').disabled, false);
});

test('real trace aggregates repeated PCs inline and reports loss globally', async () => {
  const page = pageHarness('随机等待 100 300');
  await page.click();
  page.resolveRead({runId: 42, state: 2, vmError: 0, nextCursor: 2, dropped: 1,
    traceLost: true, events: [
      {pc: 0, type: 6, value: 217, result: 0},
      {pc: 0, type: 6, value: 201, result: 0}
    ]});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.lineResults.length, 2);
  assert.deepEqual(Array.from(page.lineResults.at(-1)),
    [0, '已执行 2 次：随机等待实际采用 201 ms', 'success']);
  assert.match(page.elements.get('#macro-run-status').textContent, /部分执行日志丢失（1 条）/);
  assert.equal(page.elements.get('#macro-run-status').classList.contains('warning'), true);
  assert.equal(page.elements.get('#macro-run-status').classList.contains('error'), false);
});

test('terminal run drains more than one protocol page before reporting completion', async () => {
  const page = pageHarness('随机等待 100 300');
  await page.click();
  page.resolveRead({runId: 42, state: 2, vmError: 0, nextCursor: 30, dropped: 0,
    traceLost: false, events: Array.from({length: 30}, (_, index) =>
      ({sequence: index + 1, pc: 0, type: 6, value: 100 + index, result: 0}))});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.cursors, [0, 30]);
  assert.doesNotMatch(page.elements.get('#macro-run-status').textContent, /已完成/);
  page.resolveRead({runId: 42, state: 2, vmError: 0, nextCursor: 35, dropped: 0,
    traceLost: false, events: Array.from({length: 5}, (_, index) =>
      ({sequence: index + 31, pc: 0, type: 6, value: 200 + index, result: 0}))});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.cursors, [0, 30, 35]);
  page.resolveRead({runId: 42, state: 2, vmError: 0, nextCursor: 35, dropped: 0,
    traceLost: false, events: []});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.lineResults.length, 35);
  assert.deepEqual(Array.from(page.lineResults.at(-1)),
    [0, '已执行 35 次：随机等待实际采用 204 ms', 'success']);
  assert.match(page.elements.get('#macro-run-status').textContent, /测试完成/);
});

test('terminal drain keeps loss warnings from later protocol pages', async () => {
  const page = pageHarness('点击 A');
  await page.click();
  page.resolveRead({runId: 42, state: 2, vmError: 0, nextCursor: 1, dropped: 0,
    traceLost: false, events: [{sequence: 1, pc: 0, type: 3, value: 4, result: 0}]});
  await new Promise(resolve => setImmediate(resolve));
  page.resolveRead({runId: 42, state: 2, vmError: 0, nextCursor: 4, dropped: 2,
    traceLost: true, events: [{sequence: 4, pc: 0, type: 3, value: 4, result: 0}]});
  await new Promise(resolve => setImmediate(resolve));
  page.resolveRead({runId: 42, state: 2, vmError: 0, nextCursor: 4, dropped: 2,
    traceLost: false, events: []});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.lineResults.length, 2);
  assert.match(page.elements.get('#macro-run-status').textContent, /部分执行日志丢失（2 条）/);
  assert.equal(page.elements.get('#macro-run-status').classList.contains('warning'), true);
});

test('terminal confirmation releases the run when later trace draining fails', async () => {
  const page = pageHarness('点击 A');
  await page.click();
  page.resolveRead({runId: 42, state: 2, vmError: 0, nextCursor: 1, dropped: 0,
    traceLost: false, events: [{pc: 0, type: 3, value: 4, result: 0}]});
  await new Promise(resolve => setImmediate(resolve));
  page.rejectRead(new Error('读取超时'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(page.elements.get('#macro-run-status').textContent, /已结束，但执行日志未能完整读取/);
  assert.equal(page.elements.get('#test-macro').disabled, false);
});

test('terminal drain stops on a nonadvancing cursor without claiming complete logs', async () => {
  const page = pageHarness('点击 A');
  await page.click();
  page.resolveRead({runId: 42, state: 2, vmError: 0, nextCursor: 1, dropped: 0,
    traceLost: false, events: [{sequence: 1, pc: 0, type: 3, value: 4, result: 0}]});
  await new Promise(resolve => setImmediate(resolve));
  page.resolveRead({runId: 42, state: 2, vmError: 0, nextCursor: 1, dropped: 0,
    traceLost: false, events: [{sequence: 1, pc: 0, type: 3, value: 4, result: 0}]});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(page.cursors, [0, 1]);
  assert.equal(page.pendingReads, 0);
  assert.match(page.elements.get('#macro-run-status').textContent, /日志未能完整读取/);
});

test('editing through the active editor stops once and ignores an old protocol response', async () => {
  const page = pageHarness('点击 A');
  await page.click();
  assert.equal(page.editable, true);
  assert.equal(page.elements.get('#save-macro').disabled, true);
  assert.equal(page.elements.get('#restore-all').disabled, true);
  assert.equal(page.changeSource('点击 B'), true);
  page.changeSource('点击 C');
  page.resolveRead({runId: 42, state: 2, vmError: 0, nextCursor: 1, dropped: 0,
    traceLost: false, events: [{pc: 0, type: 3, value: 4, result: 0}]});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.stopped, 1);
  assert.deepEqual(page.lineResults, []);
});

test('active slot and preset tabs interrupt the run without rendering a late trace', async () => {
  for (const choice of ['slot', 'preset']) {
    const page = pageHarness('点击 A');
    await page.click();
    if (choice === 'slot') {
      page.renderSlots();
      const tab = page.elements.get('#macro-slots-list').children[1];
      assert.equal(tab.disabled, false);
      void tab.listeners.click();
    } else {
      page.renderPresets();
      vm.runInContext('loadBindings = async id => { selectedPreset = id; }', page.context);
      const tab = page.elements.get('#presets').children[1];
      assert.equal(tab.disabled, false);
      await tab.listeners.click();
    }
    page.resolveRead({runId: 42, state: 2, vmError: 0, nextCursor: 1, dropped: 0,
      traceLost: false, events: [{pc: 0, type: 3, value: 4, result: 0}]});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.stopped, 1, choice);
    assert.deepEqual(page.lineResults, [], choice);
  }
});

test('changed source compiles after 300 ms and marks the error line without editing text', () => {
  const page = pageHarness('点击 A');
  page.changeSource('点击 A\n点击 UNKNOWN');
  assert.equal(page.flushTimer(), 300);
  assert.equal(page.lineResults.length, 1);
  assert.equal(page.lineResults[0][0], 1);
  assert.equal(page.lineResults[0][2], 'error');
  assert.match(page.elements.get('#compile-status').textContent, /第 2 行/);
});
