import test from 'node:test';
import assert from 'node:assert/strict';
import {testMacro, readRunState, stopMacro, readMacro, saveMacro} from './macro-device.mjs';
import {compileMacro, prepareMacroDraft} from './macro-compiler.mjs';

const u16 = n => [n & 255, n >>> 8 & 255];
const u32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const connection = responses => {
  const calls = [];
  return {calls, async exchange(command, payload) {
    calls.push([command, [...payload]]);
    const reply = responses.shift();
    if (reply instanceof Error) throw reply;
    return Uint8Array.from(reply);
  }};
};

test('uploads an unsaved package to preset 2 slot 0 and commits a real run ID', async () => {
  const device = connection([
    [0, ...u32(42), ...u16(384)],
    [0, ...u32(42), ...u16(3)],
    [0, ...u32(42), ...u32(71)]
  ]);
  const runId = await testMacro(device, 2, {package: Uint8Array.from([1, 2, 3]), packageCrc32: 0x12345678});
  assert.equal(runId, 71);
  assert.deepEqual(device.calls, [
    [13, [1, 2, 0, 0, 0, 0, ...u32(1), ...u16(3), 0, 0, ...u32(0x12345678), ...Array(32).fill(0)]],
    [14, [...u32(42), ...u16(0), ...u16(3), 1, 2, 3]],
    [15, u32(42)]
  ]);
});

test('splits a large package and aborts when device offset does not match', async () => {
  const device = connection([[0, ...u32(42), ...u16(384)], [0, ...u32(42), ...u16(383)], [0]]);
  await assert.rejects(testMacro(device, 0, {package: new Uint8Array(385), packageCrc32: 1}), /偏移/);
  assert.deepEqual(device.calls.map(([command]) => command), [13, 14, 16]);
  assert.equal(device.calls[1][1].length, 8 + 384);
});

test('rejects zero run ID and never reports upload as execution', async () => {
  const device = connection([[0, ...u32(42), ...u16(384)], [0, ...u32(42), ...u16(1)], [0, ...u32(42), ...u32(0)], [0]]);
  await assert.rejects(testMacro(device, 0, {package: Uint8Array.of(0), packageCrc32: 1}), /运行编号/);
});

test('reads only the matching run and decodes real trace events', async () => {
  const event = [...u32(5), ...u16(3), 6, 0, ...u32(234), ...u32(250)];
  const device = connection([[0, ...u32(71), 1, 0, 0, 0, ...u32(6), ...u32(0), 1, 0, 0, 0, ...event]]);
  const result = await readRunState(device, 71, 5);
  assert.deepEqual(device.calls, [[17, [...u32(71), ...u32(5), 30, 0, 0, 0]]]);
  assert.equal(result.state, 1);
  assert.equal(result.nextCursor, 6);
  assert.deepEqual(result.events, [{sequence: 5, pc: 3, type: 6, result: 0, value: 234, elapsedMs: 250}]);
});

test('rejects stale run responses and acknowledges trace loss', async () => {
  const header = [...u32(72), 2, 0, 0, 0, ...u32(6), ...u32(2), 0, 0, 0, 0];
  await assert.rejects(readRunState(connection([[0, ...header]]), 71, 5), /运行编号/);
  header.splice(0, 4, ...u32(71));
  const result = await readRunState(connection([[15, ...header]]), 71, 5);
  assert.equal(result.traceLost, true);
  assert.equal(result.dropped, 2);
});

test('stop targets the committed run ID only', async () => {
  const device = connection([[0]]);
  await stopMacro(device, 71);
  assert.deepEqual(device.calls, [[18, u32(71)]]);
});

function metadata(preset, slot, compiled, {name = '示例', trigger = 0, repeat = 1} = {}) {
  const bytes = new Uint8Array(49);
  const view = new DataView(bytes.buffer);
  bytes[1] = preset;
  bytes[2] = slot;
  bytes[3] = 2;
  bytes[4] = trigger;
  const encoded = new TextEncoder().encode(name);
  bytes[5] = encoded.length;
  view.setUint32(7, repeat, true);
  view.setUint16(11, compiled.package.length, true);
  view.setUint32(13, compiled.packageCrc32, true);
  bytes.set(encoded, 17);
  return bytes;
}

function chunk(preset, slot, offset, data) {
  return [0, preset, slot, ...u16(offset), ...u16(data.length), ...data];
}

test('reads selected slot metadata and full VM package in chunks', async () => {
  const compiled = compileMacro('按下 A\n等待 200\n弹起 A');
  const device = connection([
    metadata(2, 3, compiled),
    chunk(2, 3, 0, compiled.package)
  ]);
  const result = await readMacro(device, 2, 3);
  assert.equal(result.recordVersion, 2);
  assert.equal(result.name, '示例');
  assert.deepEqual(result.package, compiled.package);
  assert.deepEqual(device.calls.map(([command]) => command), [11, 12]);
  assert.deepEqual(device.calls[1][1], [2, 3, 0, 0, ...u16(compiled.package.length)]);
});

test('reads a large package across multiple validated offsets', async () => {
  const compiled = compileMacro('点击 A\n'.repeat(130));
  assert.ok(compiled.package.length > 384);
  const device = connection([
    metadata(0, 0, compiled),
    chunk(0, 0, 0, compiled.package.slice(0, 384)),
    chunk(0, 0, 384, compiled.package.slice(384))
  ]);
  const result = await readMacro(device, 0, 0);
  assert.deepEqual(result.package, compiled.package);
  assert.deepEqual(device.calls[2][1], [0, 0, ...u16(384), ...u16(compiled.package.length - 384)]);
});

test('rejects wrong slot and mismatched package CRC', async () => {
  const compiled = compileMacro('点击 A');
  const wrong = metadata(0, 2, compiled);
  await assert.rejects(readMacro(connection([wrong]), 0, 1), /槽位/);
  await assert.rejects(readMacro(connection([metadata(0, 1, compiled), chunk(0, 1, 2, compiled.package)]), 0, 1), /偏移/);
  const damaged = compiled.package.slice();
  damaged[17] ^= 1;
  await assert.rejects(readMacro(connection([metadata(0, 1, compiled), chunk(0, 1, 0, damaged)]), 0, 1), /校验/);
});

test('rejects invalid trigger and repeat metadata', async () => {
  const compiled = compileMacro('点击 A');
  await assert.rejects(
    readMacro(connection([metadata(0, 1, compiled, {trigger: 4})]), 0, 1),
    /触发方式|次数/
  );
  await assert.rejects(
    readMacro(connection([metadata(0, 1, compiled, {trigger: 3, repeat: 0})]), 0, 1),
    /触发方式|次数/
  );
});

test('saves only after operation 0 upload and exact readback', async () => {
  const compiled = compileMacro('点击 B');
  const device = connection([
    [0, ...u32(9), ...u16(384)],
    [0, ...u32(9), ...u16(compiled.package.length)],
    [0, ...u32(9), ...u32(0)],
    metadata(1, 5, compiled, {name: '新宏', trigger: 3, repeat: 100}),
    chunk(1, 5, 0, compiled.package)
  ]);
  const saved = await saveMacro(device, 1, 5, compiled, {name: '新宏', trigger: 3, repeatCount: 100});
  assert.equal(saved.name, '新宏');
  assert.deepEqual(device.calls.map(([command]) => command), [13, 14, 15, 11, 12]);
  assert.deepEqual(device.calls[0][1].slice(0, 10), [0, 1, 5, 3, 6, 0, ...u32(100)]);
});

test('save accepts a zero-length empty slot and verifies zero metadata', async () => {
  const empty = prepareMacroDraft('# 只有注释\n');
  const device = connection([
    [0, ...u32(9), ...u16(384)], [0, ...u32(9), ...u32(0)],
    metadata(0, 1, empty, {name: '', trigger: 0, repeat: 1})
  ]);
  const stored = await saveMacro(device, 0, 1, empty, {name: '', trigger: 0, repeatCount: 1});
  assert.equal(stored.package.length, 0);
  assert.equal(stored.packageCrc32, 0);
  assert.deepEqual(device.calls.map(([command]) => command), [13, 15, 11]);
  assert.deepEqual(device.calls[0][1].slice(10, 18), [0, 0, 0, 0, ...u32(0)]);
});

test('test upload rejects empty package before any exchange', async () => {
  const device = connection([]);
  await assert.rejects(testMacro(device, 0, prepareMacroDraft(''), {slot: 1}), /空宏没有可执行动作/);
  assert.equal(device.calls.length, 0);
});

test('zero-length save rejects nonzero CRC before device exchange', async () => {
  const device = connection([]);
  await assert.rejects(saveMacro(device, 0, 1, {package: new Uint8Array(), packageCrc32: 1},
    {name: '', trigger: 0, repeatCount: 1}), /无效/);
  assert.equal(device.calls.length, 0);
});

test('failed readback cannot claim save success', async () => {
  const compiled = compileMacro('点击 B');
  const other = compileMacro('点击 C');
  const device = connection([
    [0, ...u32(9), ...u16(384)],
    [0, ...u32(9), ...u16(compiled.package.length)],
    [0, ...u32(9), ...u32(0)],
    metadata(1, 5, other),
    chunk(1, 5, 0, other.package)
  ]);
  await assert.rejects(saveMacro(device, 1, 5, compiled, {name: '新宏', trigger: 0, repeatCount: 1}), /读回|校验/);
});

test('rejects a macro name over 32 UTF-8 bytes before device I/O', async () => {
  const compiled = compileMacro('点击 B');
  const device = connection([]);
  await assert.rejects(
    saveMacro(device, 1, 5, compiled, {name: '中'.repeat(11), trigger: 0, repeatCount: 1}),
    /32 个 UTF-8 字节/
  );
  assert.deepEqual(device.calls, []);
});
