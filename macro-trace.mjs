import {usageLabel} from './keymap.mjs';

export function formatTraceResult(event) {
  const key = () => usageLabel(event.value);
  const descriptions = {
    1: () => `按下 ${key()}`,
    2: () => `弹起 ${key()}`,
    3: () => `点击 ${key()}`,
    4: () => '释放全部按键',
    5: () => `等待 ${event.value} ms`,
    6: () => `随机等待实际采用 ${event.value} ms`,
    7: () => `重置计时器 ${event.value}`,
    8: () => `计时器经过 ${event.value} ms`,
    9: () => `开始第 ${event.value} 次循环`,
    10: () => `结束第 ${event.value} 次循环`,
    11: () => `调用函数 ${event.value + 1}`,
    12: () => '函数返回'
  };
  return `${(descriptions[event.type] || (() => `事件 ${event.type}`))()}${event.result ? ` · 错误 ${event.result}` : ''}`;
}

export function accumulateLineResult(counts, event, pcToLine) {
  const line = pcToLine[event.pc];
  if (!Number.isInteger(line) || line < 1) return null;
  const lineIndex = line - 1;
  const count = (counts.get(lineIndex) || 0) + 1;
  counts.set(lineIndex, count);
  return {lineIndex, text: `已执行${count > 1 ? ` ${count} 次` : ''}：${formatTraceResult(event)}`};
}

export function runOutcome(state) {
  if (state.state === 1) return null;
  if (state.state === 3) return {message: '设备确认宏测试已停止', error: false};
  if (state.vmError || state.state === 4) return {message: `宏执行失败，VM 错误码 ${state.vmError}`, error: true};
  if (state.state === 2) return {message: '设备确认宏测试完成', error: false};
  return {message: `设备返回未知运行状态 ${state.state}`, error: true};
}
