import test from 'node:test';
import assert from 'node:assert/strict';
import {accumulateLineResult, formatTraceResult, runOutcome} from './macro-trace.mjs';

test('repeated trace events update one source line with a count and actual delay', () => {
  const counts = new Map();
  assert.deepEqual(accumulateLineResult(counts, {pc: 3, type: 6, value: 217}, {3: 4}),
    {lineIndex: 3, text: '已执行：随机等待实际采用 217 ms'});
  assert.deepEqual(accumulateLineResult(counts, {pc: 3, type: 6, value: 201}, {3: 4}),
    {lineIndex: 3, text: '已执行 2 次：随机等待实际采用 201 ms'});
  assert.equal(counts.get(3), 2);
});

test('unmapped events cannot decorate a source line', () => {
  assert.equal(accumulateLineResult(new Map(), {pc: 99, type: 3, value: 4}, {3: 4}), null);
  assert.equal(formatTraceResult({type: 6, value: 234}), '随机等待实际采用 234 ms');
  assert.match(formatTraceResult({type: 3, value: 4, result: 7}), /错误 7/);
});

test('run completion is successful only with a confirmed terminal state and no VM error', () => {
  assert.equal(runOutcome({state: 1, vmError: 0}), null);
  assert.deepEqual(runOutcome({state: 2, vmError: 0}), {message: '设备确认宏测试完成', error: false});
  assert.deepEqual(runOutcome({state: 2, vmError: 3}), {message: '宏执行失败，VM 错误码 3', error: true});
  assert.deepEqual(runOutcome({state: 3, vmError: 0}), {message: '设备确认宏测试已停止', error: false});
  assert.deepEqual(runOutcome({state: 3, vmError: 29}), {message: '设备确认宏测试已停止', error: false});
  assert.deepEqual(runOutcome({state: 4, vmError: 7}), {message: '宏执行失败，VM 错误码 7', error: true});
  assert.deepEqual(runOutcome({state: 9, vmError: 0}), {message: '设备返回未知运行状态 9', error: true});
});
