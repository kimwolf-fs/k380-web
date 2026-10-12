import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {compileMacro, prepareMacroDraft} from './macro-compiler.mjs';

const vector = JSON.parse(readFileSync(new URL('./tests/fixtures/macro_vm_v1_vectors.json', import.meta.url), 'utf8')).vectors[0];
const hex = bytes => Buffer.from(bytes).toString('hex');

test('canonical 600000 ms vector exactly matches Python and firmware contract', () => {
  const result = compileMacro(vector.source);
  assert.equal(hex(result.code), vector.code_hex);
  assert.equal(hex(result.package), vector.package_hex);
  assert.equal(result.packageCrc32, Number.parseInt(vector.package_crc32, 16));
  assert.deepEqual(result.pcToLine, {0: 1, 3: 2, 8: 3});
});

test('emits condition, random wait, loops and function table with patched targets', () => {
  const result = compileMacro(`重置计时器 1
循环次数 2:
    如果 计时器 1 小于等于 300:
        随机等待 100 300
定义 动作():
    按下 LEFT_ALT
    点击 A
    弹起 LEFT_ALT
调用 动作
`);
  assert.equal(result.package[6], 1);
  assert.equal(result.code[0], 0x20);
  assert.ok(hex(result.code).includes('11640000002c010000'));
  assert.ok(hex(result.code).includes('22012c010000'));
  assert.ok(hex(result.code).includes('3002000000'));
  assert.ok(hex(result.code).includes('4000'));
  assert.equal(result.code.at(-1), 0x41);
  assert.equal(result.package.length, 16 + 4 + result.code.length);
});

test('rejects invalid values with a source location and stable codes', () => {
  const cases = [
    ['按下 NOT_A_KEY\n', 'INVALID_KEYCODE'],
    ['等待 0\n', 'INTEGER_OUT_OF_RANGE'],
    ['等待 4294967296\n', 'INTEGER_OUT_OF_RANGE'],
    ['随机等待 300 100\n', 'RANDOM_RANGE_REVERSED'],
    ['重置计时器 4\n', 'INTEGER_OUT_OF_RANGE'],
    ['如果 计时器 1 大于等于 5:\n', 'EMPTY_BLOCK'],
    ['调用 不存在\n', 'UNKNOWN_FUNCTION'],
    ['定义 动作():\n    调用 动作\n', 'RECURSION'],
    ['定义 动作():\n    点击 A\n定义 动作():\n    点击 B\n', 'DUPLICATE_FUNCTION']
  ];
  for (const [source, code] of cases) {
    assert.throws(() => compileMacro(source), error => error.code === code && error.line > 0 && error.column > 0, code);
  }
});

test('empty source cannot produce an executable VM package', () => {
  assert.throws(() => compileMacro('  # 空宏\n'), error => error.code === 'EMPTY_MACRO');
});

test('blank and comment-only drafts prepare an empty slot without weakening compilation', () => {
  for (const source of ['', ' \t\n# 只有注释\n']) {
    const draft = prepareMacroDraft(source);
    assert.equal(draft.empty, true);
    assert.deepEqual(draft.package, new Uint8Array());
    assert.deepEqual(draft.code, new Uint8Array());
    assert.equal(draft.packageCrc32, 0);
    assert.deepEqual(draft.pcToLine, {});
  }
  const compiled = prepareMacroDraft('点击 A');
  assert.equal(compiled.empty, false);
  assert.deepEqual(compiled.package, compileMacro('点击 A').package);
  assert.throws(() => prepareMacroDraft('坏源码'), error => error.code === 'UNKNOWN_INSTRUCTION');
  assert.throws(() => prepareMacroDraft('定义 动作():\n    点击 A\n'), error => error.code === 'EMPTY_MACRO');
});

test('enforces loop, block and code size limits', () => {
  const loops = Array.from({length: 4}, (_, depth) => `${'    '.repeat(depth)}循环次数 1:`).join('\n') + '\n                点击 A\n';
  assert.throws(() => compileMacro(loops), error => error.code === 'LOOP_DEPTH');
  const conditions = Array.from({length: 9}, (_, depth) => `${'    '.repeat(depth)}如果 计时器 1 大于等于 0:`).join('\n') + '\n' + '    '.repeat(9) + '点击 A\n';
  assert.throws(() => compileMacro(conditions), error => error.code === 'BLOCK_DEPTH');
  assert.throws(() => compileMacro('点击 A\n'.repeat(342)), error => error.code === 'CODE_TOO_LARGE');
});
