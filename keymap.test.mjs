import assert from 'node:assert/strict';
import {test} from 'node:test';

import {compileMacro} from './macro-compiler.mjs';
import {
  defaultLabel,
  isReserved,
  keyRows,
  physicalKeys,
  recordedInstructions,
  sourceUsageToken,
  usageFromCode,
  usageLabel,
  usageOptions
} from './keymap.mjs';

test('keyboard rows describe each of the 80 physical keys once', () => {
  assert.equal(physicalKeys.length, 80);
  assert.deepEqual(keyRows.flat().map(key => key.index).sort((a, b) => a - b), Array.from({length: 80}, (_, i) => i));
  assert.equal(physicalKeys[16], '1');
  assert.equal(physicalKeys[70], 'Fn');
});

test('default and reserved keys distinguish ordinary output from firmware shortcuts', () => {
  assert.equal(defaultLabel(16, 0), '1');
  assert.equal(defaultLabel(16, 1), '切换预设 1');
  assert.equal(defaultLabel(70, 0), 'Fn 层切换');
  assert.equal(isReserved(16, 1), true);
  assert.equal(isReserved(16, 0), false);
  assert.equal(usageLabel(74), 'Home');
  assert.equal(usageLabel(83), 'Keypad Num Lock');
  assert.equal(usageLabel(89), 'Keypad 1');
  assert.equal(usageLabel(98), 'Keypad 0');
});

test('physical keyboard capture maps code values including absent keys', () => {
  assert.equal(usageFromCode('KeyA'), 4);
  assert.equal(usageFromCode('Digit0'), 39);
  assert.equal(usageFromCode('Home'), 74);
  assert.equal(usageFromCode('F12'), 69);
  assert.equal(usageFromCode('F13'), 104);
  assert.equal(usageFromCode('F24'), 115);
  assert.equal(usageFromCode('Unidentified'), 0);
});

test('usage options expose the complete searchable HID keyboard range', () => {
  assert.equal(usageOptions.length, 228);
  assert.deepEqual(usageOptions[0], {value: 4, label: 'A'});
  assert.deepEqual(usageOptions.find(option => option.value === 74), {value: 74, label: 'Home'});
  assert.deepEqual(usageOptions.at(-1), {value: 231, label: 'Right GUI'});
});

test('recording maps key events to compiler tokens and inserts measured waits', () => {
  assert.equal(sourceUsageToken(74), 'HOME');
  assert.equal(sourceUsageToken(79), 'RIGHT_ARROW');
  assert.equal(sourceUsageToken(224), 'LEFT_CTRL');
  assert.deepEqual(recordedInstructions({type: 'keyup', usage: 4, now: 260, lastEventAt: 10}),
    {lines: ['等待 250', '弹起 A'], lastEventAt: 260});
});

test('recording emits canonical tokens that compile for every recordable usage', () => {
  const usages = [
    ...Array.from({length: 46}, (_, index) => index + 4),
    ...Array.from({length: 51}, (_, index) => index + 51),
    ...Array.from({length: 13}, (_, index) => index + 103),
    224, 225, 226, 227, 228, 229, 230, 231
  ];
  for (const usage of usages) {
    const token = sourceUsageToken(usage);
    const result = recordedInstructions({type: 'keydown', usage, now: 1, lastEventAt: 0});
    assert.deepEqual(result.lines, [`按下 ${token}`], String(usage));
    assert.doesNotThrow(() => compileMacro(`${result.lines[0]}\n`), String(usage));
  }
});

test('recording omits short waits and ignores unsupported usages', () => {
  assert.deepEqual(recordedInstructions({type: 'keydown', usage: 4, now: 39, lastEventAt: 10}),
    {lines: ['按下 A'], lastEventAt: 39});
  assert.deepEqual(recordedInstructions({type: 'keydown', usage: 102, now: 100, lastEventAt: 39}),
    {lines: [], lastEventAt: 39});
});

test('recording compares high precision intervals at the 30 ms threshold', () => {
  assert.deepEqual(recordedInstructions({type: 'keyup', usage: 4, now: 39.6, lastEventAt: 10}),
    {lines: ['弹起 A'], lastEventAt: 39.6});
  assert.deepEqual(recordedInstructions({type: 'keyup', usage: 4, now: 40.2, lastEventAt: 10}),
    {lines: ['等待 30', '弹起 A'], lastEventAt: 40.2});
  assert.deepEqual(recordedInstructions({type: 'keyup', usage: 4, now: 40.6, lastEventAt: 10}),
    {lines: ['等待 31', '弹起 A'], lastEventAt: 40.6});
  assert.deepEqual(recordedInstructions({type: 'keyup', usage: 4, now: 40, lastEventAt: 10}),
    {lines: ['等待 30', '弹起 A'], lastEventAt: 40});
});
