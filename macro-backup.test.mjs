import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createBackup, parseBackup, MAX_BACKUP_BYTES} from './macro-backup.mjs';

const draft = {source: '# 注释\n按下 A\n弹起 A\n', name: '草稿名', trigger: 3, repeatCount: 100};
test('export preserves exact source and settings but names file from saved name', () => {
  const file = createBackup(draft, '随机按键', 1, 0);
  assert.equal(file.filename, '随机按键.json');
  assert.deepEqual(parseBackup(file.text, file.filename), draft);
  assert.equal(createBackup({...draft, name: ''}, '', 0, 1).filename, '宏2.json');
});
test('slot filenames and placeholder names import as empty names', () => {
  const file = createBackup(draft, '', 0, 0);
  assert.equal(parseBackup(file.text, '宏1.json').name, '');
  assert.equal(parseBackup(file.text, '宏 16.json').name, '');
  const placeholder = createBackup({...draft, name: '宏 2'}, '宏 2', 0, 1);
  assert.equal(parseBackup(placeholder.text, '备份.json').name, '');
  assert.equal(parseBackup(createBackup({...draft, name: '宏1测试'}, '宏1测试', 0, 0).text, '宏1测试.json').name, '宏1测试');
});
test('invalid source drafts can be backed up without compiling or losing comments', () => {
  const incomplete = {...draft, source: '# 尚未写完\n定义 动作():\n'};
  assert.deepEqual(parseBackup(createBackup(incomplete, '工作', 0, 0).text, '工作.json'), incomplete);
});
test('rejects malformed or excessive backup before replacing editor', () => {
  assert.throws(() => parseBackup('{', 'a.json'));
  const object = JSON.parse(createBackup(draft, 'a', 0, 0).text);
  for (const change of [{version: 2}, {format: 'other'}, {source: 1}, {source: 'a'.repeat(32769)}, {trigger: 4}, {repeatCount: 65536}, {name: 'a'.repeat(33)}]) {
    assert.throws(() => parseBackup(JSON.stringify({...object, ...change}), 'a.json'));
  }
  assert.throws(() => parseBackup(' '.repeat(262145), 'a.json'));
});
test('export sanitizes filenames without modifying macro name', () => {
  const file = createBackup({...draft, name: 'A/B'}, 'A/B', 0, 0);
  assert.equal(file.filename, 'A_B.json');
  assert.equal(parseBackup(file.text, file.filename).name, 'A/B');
});

const app = readFileSync(new URL('./app.mjs', import.meta.url), 'utf8');
function importPage() {
  const start = app.indexOf('async function importMacroBackup(file)');
  const end = app.indexOf('\nfunction exportMacroBackup()', start);
  assert.ok(start >= 0 && end > start, 'page must expose the guarded import handler');
  const elements = new Map(['#macro-name', '#macro-trigger', '#macro-count', '#macro-count-field', '#macro-source-status', '#macro-source-notice'].map(id => [id, {value: '', hidden: false, textContent: ''}]));
  const page = {connection: {}, busy: false, macroRun: null, macroRecording: null, macroBaseline: {source: 'saved'},
    macroEditor: {}, macroClearRequested: false, macroSourceUnavailable: true,
    selectedPreset: 0, selectedMacroSlot: 1, macroGate: {capture: c => c, isCurrent: c => c.slot === page.selectedMacroSlot},
    $: id => elements.get(id), parseBackup, MAX_BACKUP_BYTES, macroDirty: () => true,
    window: {confirm: () => true}, createMacroEditor: source => {page.source = source;},
    compileMacroSource() {}, setControls() {}, setMacroRunStatus: message => {page.message = message;}, describeError: e => e.message};
  vm.runInNewContext(app.slice(start, end) + '\nglobalThis.importBackup = importMacroBackup;', page);
  return {page, elements};
}
test('import changes editor draft without replacing baseline or writing device', async () => {
  const {page, elements} = importPage();
  const baseline = page.macroBaseline;
  const file = createBackup(draft, '工作', 0, 0);
  await page.importBackup({size: file.text.length, name: file.filename, text: async () => file.text});
  assert.equal(page.source, draft.source);
  assert.equal(elements.get('#macro-name').value, draft.name);
  assert.equal(page.macroBaseline, baseline);
  assert.equal(page.macroSourceUnavailable, false);
  assert.match(page.message, /未写入键盘/);
});
test('cancelled, stale and invalid imports leave editor unchanged', async () => {
  const {page} = importPage();
  const file = createBackup(draft, '工作', 0, 0);
  page.window.confirm = () => false;
  await page.importBackup({size: 1, name: '工作.json', text: async () => file.text});
  assert.equal(page.source, undefined);
  page.window.confirm = () => true;
  await page.importBackup({size: 1, name: '工作.json', text: async () => {page.selectedMacroSlot = 2; return file.text;}});
  assert.equal(page.source, undefined);
  await page.importBackup({size: 1, name: '工作.json', text: async () => '{'});
  assert.equal(page.source, undefined);
});

test('export blocks missing device source but permits newly authored drafts', () => {
  const start = app.indexOf('function macroBackupUnavailable()');
  const end = app.indexOf('\nasync function importMacroBackup', start);
  assert.ok(start >= 0 && end > start);
  const page = {macroSourceUnavailable: true, macroClearRequested: false, readMacroEditorSource: () => ''};
  vm.runInNewContext(app.slice(start, end) + '\nglobalThis.unavailable = macroBackupUnavailable;', page);
  assert.equal(page.unavailable(), true);
  page.readMacroEditorSource = () => '# draft\n按下 A';
  assert.equal(page.unavailable(), false);
  page.readMacroEditorSource = () => '';
  page.macroClearRequested = true;
  assert.equal(page.unavailable(), false);
});
