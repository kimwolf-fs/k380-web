import {crc32} from './protocol.mjs';

const MAX_U32 = 0xffffffff;
const MAX_SOURCE_BYTES = 32768;
const identifier = /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u;

const keys = new Map([
  ['ENTER',40],['ESC',41],['BACKSPACE',42],['TAB',43],['SPACE',44],['MINUS',45],
  ['EQUAL',46],['LEFT_BRACKET',47],['RIGHT_BRACKET',48],['BACKSLASH',49],
  ['NON_US_BACKSLASH',100],['SEMICOLON',51],['APOSTROPHE',52],['GRAVE',53],
  ['COMMA',54],['PERIOD',55],['SLASH',56],['CAPS_LOCK',57],['PRINT_SCREEN',70],
  ['SCROLL_LOCK',71],['PAUSE',72],['INSERT',73],['HOME',74],['PAGE_UP',75],
  ['DELETE',76],['END',77],['PAGE_DOWN',78],['RIGHT_ARROW',79],['LEFT_ARROW',80],
  ['DOWN_ARROW',81],['UP_ARROW',82],['NUM_LOCK',83],['KP_DIVIDE',84],
  ['KP_MULTIPLY',85],['KP_MINUS',86],['KP_PLUS',87],['KP_ENTER',88],
  ['KP_0',98],['KP_DOT',99],['APPLICATION',101],['KP_EQUAL',103],
  ['LEFT_CTRL',224],['LEFT_SHIFT',225],['LEFT_ALT',226],['LEFT_GUI',227],
  ['RIGHT_CTRL',228],['RIGHT_SHIFT',229],['RIGHT_ALT',230],['RIGHT_GUI',231]
]);
for (let index = 0; index < 26; index += 1) keys.set(String.fromCharCode(65 + index), 4 + index);
for (let index = 1; index <= 9; index += 1) keys.set(String(index), 29 + index);
keys.set('0', 39);
for (let index = 1; index <= 24; index += 1) keys.set(`F${index}`, index <= 12 ? 57 + index : 104 + index - 13);
for (let index = 1; index <= 9; index += 1) keys.set(`KP_${index}`, 88 + index);

const usageTokens = new Map([...keys].map(([token, usage]) => [usage, token]));

export function macroSourceToken(usage) {
  return usageTokens.get(usage) || '';
}

export class MacroCompileError extends Error {
  constructor(code, message, line = 1, column = 1) {
    super(`${message} (第 ${line} 行，第 ${column} 列)`);
    this.name = 'MacroCompileError';
    this.code = code;
    this.line = line;
    this.column = column;
  }
}

function fail(code, message, span = {line: 1, column: 1}) {
  throw new MacroCompileError(code, message, span.line, span.column);
}

function integer(token, min, max, span) {
  if (!/^[0-9]+$/.test(token)) fail('INVALID_INTEGER', `无效整数：${token}`, span);
  const value = Number(token);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INTEGER_OUT_OF_RANGE', `整数必须在 ${min} 到 ${max} 之间`, span);
  }
  return value;
}

function statement(text, span) {
  for (const [word, kind] of [['按下','press'],['弹起','release'],['点击','tap']]) {
    if (text === word || text.startsWith(`${word} `)) {
      const tokens = text.split(/\s+/);
      if (tokens.length !== 2) fail('PARAMETER_COUNT', `${word} 需要一个按键名称`, span);
      return {kind, key: tokens[1], span};
    }
  }
  if (text === '释放全部') return {kind: 'releaseAll', span};
  if (text.startsWith('释放全部')) fail('PARAMETER_COUNT', '释放全部不接受参数', span);

  if (text === '等待' || text.startsWith('等待 ')) {
    const tokens = text.split(/\s+/);
    if (tokens.length !== 2) fail('PARAMETER_COUNT', '等待需要一个毫秒数', span);
    const value = integer(tokens[1], 1, MAX_U32, {line: span.line, column: span.column + 3});
    return {kind: 'wait', minimum: value, maximum: value, span};
  }
  if (text === '随机等待' || text.startsWith('随机等待 ')) {
    const tokens = text.split(/\s+/);
    if (tokens.length !== 3) fail('PARAMETER_COUNT', '随机等待需要两个毫秒数', span);
    const minimum = integer(tokens[1], 1, MAX_U32, {line: span.line, column: span.column + '随机等待 '.length});
    const maximum = integer(tokens[2], 1, MAX_U32, {line: span.line, column: span.column + '随机等待 '.length + tokens[1].length + 1});
    if (minimum > maximum) fail('RANDOM_RANGE_REVERSED', '随机等待的最小值不能大于最大值', span);
    return {kind: 'randomWait', minimum, maximum, span};
  }
  if (text === '重置计时器' || text.startsWith('重置计时器 ')) {
    const tokens = text.split(/\s+/);
    if (tokens.length !== 2) fail('PARAMETER_COUNT', '重置计时器需要一个计时器编号', span);
    return {kind: 'timerReset', timer: integer(tokens[1], 1, 3, {line: span.line, column: span.column + '重置计时器 '.length}), span};
  }
  if (text.startsWith('如果')) {
    if (!text.endsWith(':')) fail('MISSING_COLON', '条件语句必须以冒号结尾', span);
    const match = /^如果 计时器 ([^ ]+) (大于等于|小于等于) ([^ ]+):$/.exec(text);
    if (!match) fail('PARAMETER_COUNT', '条件格式应为：如果 计时器 N 大于等于/小于等于 毫秒:', span);
    return {kind: 'timerIf', timer: integer(match[1], 1, 3, {line: span.line, column: span.column + '如果 计时器 '.length}),
      operator: match[2] === '大于等于' ? 'ge' : 'le',
      threshold: integer(match[3], 0, MAX_U32, {line: span.line, column: span.column + text.indexOf(match[3])}), body: [], span};
  }
  for (const [word, kind] of [['循环次数','countLoop'],['循环时长','timeLoop']]) {
    if (text === word || text.startsWith(`${word} `)) {
      if (!text.endsWith(':')) fail('MISSING_COLON', '循环语句必须以冒号结尾', span);
      const match = new RegExp(`^${word} ([^ ]+):$`).exec(text);
      if (!match) fail('PARAMETER_COUNT', `${word}需要一个限制值`, span);
      return {kind, limit: integer(match[1], 1, MAX_U32, {line: span.line, column: span.column + word.length + 1}), body: [], span};
    }
  }
  if (text.startsWith('定义')) {
    if (!text.endsWith(':')) fail('MISSING_COLON', '函数定义必须以冒号结尾', span);
    const match = /^定义 ([^ ]+)\(\):$/.exec(text);
    if (!match) fail('INVALID_FUNCTION_NAME', '函数名必须是 Python 标识符', span);
    if (!identifier.test(match[1])) fail('INVALID_FUNCTION_NAME', '函数名必须是 Python 标识符', {line: span.line, column: span.column + '定义 '.length});
    if (new TextEncoder().encode(match[1]).length > 32) fail('FUNCTION_NAME_TOO_LONG', '函数名最多 32 个 UTF-8 字节', {line: span.line, column: span.column + '定义 '.length});
    return {kind: 'function', name: match[1], body: [], span};
  }
  if (text === '调用' || text.startsWith('调用 ')) {
    const tokens = text.split(/\s+/);
    if (tokens.length !== 2 || !identifier.test(tokens[1])) fail('INVALID_FUNCTION_NAME', '调用目标必须是 Python 标识符', span);
    return {kind: 'call', name: tokens[1], span};
  }
  fail('UNKNOWN_INSTRUCTION', `未知指令：${text.split(/\s+/)[0]}`, span);
}

function parse(source) {
  const entry = [];
  const functions = [];
  const stack = [{indent: 0, body: entry}];
  let pending = null;
  const lines = source.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].split('#', 1)[0];
    if (!raw.trim()) continue;
    const leading = /^[ \t]*/.exec(raw)[0];
    if (leading.includes('\t')) fail('TAB_INDENT', '缩进不能使用 Tab', {line: index + 1, column: leading.indexOf('\t') + 1});
    if (leading.length % 4) fail('INDENTATION', '缩进必须是 4 个空格的整数倍', {line: index + 1, column: 1});
    const indent = leading.length / 4;
    const span = {line: index + 1, column: leading.length + 1};
    const text = raw.slice(leading.length).trim();
    if (pending) {
      if (indent !== pending.indent + 1) {
        if (indent <= pending.indent) fail('EMPTY_BLOCK', '代码块必须包含至少一条缩进指令', span);
        fail('UNEXPECTED_INDENT', '代码块缩进必须恰好增加 4 个空格', span);
      }
      stack.push({indent, body: pending.node.body});
      pending = null;
    }
    while (stack.length > 1 && indent < stack.at(-1).indent) stack.pop();
    if (indent !== stack.at(-1).indent) fail('UNEXPECTED_INDENT', '出现了没有对应代码块的缩进', span);
    if (indent && text.startsWith('定义')) fail('NESTED_FUNCTION', '函数只能定义在顶层', span);
    const node = statement(text, span);
    if (node.kind === 'function') functions.push(node);
    else stack.at(-1).body.push(node);
    if (node.body) pending = {indent, node};
  }
  if (pending) fail('EMPTY_BLOCK', '代码块必须包含至少一条缩进指令', pending.node.span);
  return {entry, functions};
}

function walk(nodes) {
  return nodes.flatMap(node => [node, ...(node.body ? walk(node.body) : [])]);
}

function validate(program) {
  if (program.functions.length > 16) fail('FUNCTION_COUNT', '每个宏最多定义 16 个函数', program.functions.at(-1).span);
  const ids = new Map();
  for (const [index, fn] of program.functions.entries()) {
    if (ids.has(fn.name)) fail('DUPLICATE_FUNCTION', `函数重复定义：${fn.name}`, fn.span);
    ids.set(fn.name, index);
  }
  function visit(nodes, depth) {
    for (const node of nodes) {
      if (['press','release','tap'].includes(node.kind) && !keys.has(node.key)) {
        fail('INVALID_KEYCODE', `不支持的按键：${node.key}`, node.span);
      }
      if (node.kind === 'call' && !ids.has(node.name)) fail('UNKNOWN_FUNCTION', `未知函数：${node.name}`, node.span);
      if (node.body) {
        if (depth >= 8) fail('BLOCK_DEPTH', '条件和循环的总嵌套深度不能超过 8', node.span);
        visit(node.body, depth + 1);
      }
    }
  }
  visit(program.entry, 0);
  for (const fn of program.functions) visit(fn.body, 0);

  const visiting = new Set();
  const depths = new Map();
  function functionDepth(name) {
    if (visiting.has(name)) fail('RECURSION', `函数调用不能递归：${name}`, program.functions[ids.get(name)].span);
    if (depths.has(name)) return depths.get(name);
    visiting.add(name);
    let maximum = 0;
    for (const call of walk(program.functions[ids.get(name)].body).filter(node => node.kind === 'call')) {
      maximum = Math.max(maximum, 1 + functionDepth(call.name));
    }
    visiting.delete(name);
    depths.set(name, maximum);
    return maximum;
  }
  const entryCalls = walk(program.entry).filter(node => node.kind === 'call');
  if (Math.max(0, ...entryCalls.map(node => 1 + functionDepth(node.name))) > 8) {
    fail('CALL_DEPTH', '函数调用深度不能超过 8', program.entry[0]?.span);
  }
  for (const fn of program.functions) {
    if (functionDepth(fn.name) >= 8) fail('CALL_DEPTH', '函数调用深度不能超过 8', fn.span);
  }
  function checkLoops(nodes, active) {
    for (const node of nodes) {
      if (node.kind === 'timerIf') checkLoops(node.body, active);
      if (node.kind === 'countLoop' || node.kind === 'timeLoop') {
        if (active >= 3) fail('LOOP_DEPTH', '动态循环嵌套深度不能超过 3', node.span);
        checkLoops(node.body, active + 1);
      }
      if (node.kind === 'call') checkLoops(program.functions[ids.get(node.name)].body, active);
    }
  }
  checkLoops(program.entry, 0);
  for (const fn of program.functions) checkLoops(fn.body, 0);
  return ids;
}

function emitProgram(program, ids) {
  const code = [];
  const pcToLine = {};
  const patches = [];
  const labels = new Map();
  let nextLabel = 1;
  const label = () => nextLabel++;
  const mark = name => labels.set(name, code.length);
  function emit(bytes, node) {
    const offset = code.length;
    code.push(...bytes);
    if (node) pcToLine[offset] = node.span.line;
    return offset;
  }
  const u16 = value => [value & 255, (value >>> 8) & 255];
  const u32 = value => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
  function statements(nodes) {
    for (const node of nodes) {
      switch (node.kind) {
        case 'press': case 'release': case 'tap':
          emit([({press: 1, release: 2, tap: 3})[node.kind], ...u16(keys.get(node.key))], node); break;
        case 'releaseAll': emit([4], node); break;
        case 'wait': emit([0x10, ...u32(node.minimum)], node); break;
        case 'randomWait': emit([0x11, ...u32(node.minimum), ...u32(node.maximum)], node); break;
        case 'timerReset': emit([0x20, node.timer], node); break;
        case 'timerIf': {
          const end = label();
          const offset = emit([node.operator === 'ge' ? 0x21 : 0x22, node.timer, ...u32(node.threshold), 0, 0], node);
          patches.push([offset + 6, end]);
          statements(node.body);
          mark(end);
          break;
        }
        case 'countLoop': case 'timeLoop': {
          const body = label();
          const end = label();
          const offset = emit([node.kind === 'countLoop' ? 0x30 : 0x31, ...u32(node.limit), 0, 0], node);
          patches.push([offset + 5, end]);
          mark(body);
          statements(node.body);
          patches.push([emit([0x32, 0, 0], node) + 1, body]);
          mark(end);
          break;
        }
        case 'call': emit([0x40, ids.get(node.name)], node); break;
        default: throw new Error(`Unhandled macro node ${node.kind}`);
      }
    }
  }
  statements(program.entry);
  emit([0]);
  const functions = [];
  for (const fn of program.functions) {
    const start = code.length;
    statements(fn.body);
    emit([0x41]);
    functions.push([start, code.length]);
  }
  for (const [position, target] of patches) {
    const bytes = u16(labels.get(target));
    code.splice(position, 2, ...bytes);
  }
  if (code.length > 1024) {
    fail('CODE_TOO_LARGE', 'VM code 区不能超过 1024 字节',
      (program.entry.at(-1) || program.functions.at(-1))?.span);
  }
  const packageBytes = new Uint8Array(16 + functions.length * 4 + code.length);
  packageBytes.set(new TextEncoder().encode('KVM1'));
  packageBytes[4] = 1;
  packageBytes[6] = functions.length;
  const view = new DataView(packageBytes.buffer);
  view.setUint16(8, code.length, true);
  for (const [index, [start, end]] of functions.entries()) {
    view.setUint16(16 + index * 4, start, true);
    view.setUint16(18 + index * 4, end, true);
  }
  packageBytes.set(code, 16 + functions.length * 4);
  const packageCrc32 = crc32(packageBytes);
  view.setUint32(12, packageCrc32, true);
  return {package: packageBytes, code: Uint8Array.from(code), packageCrc32, pcToLine};
}

export function compileMacro(source) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  if (new TextEncoder().encode(source).length > MAX_SOURCE_BYTES) {
    fail('SOURCE_TOO_LARGE', `源码不能超过 ${MAX_SOURCE_BYTES} 个 UTF-8 字节`);
  }
  const program = parse(source);
  const ids = validate(program);
  if (!program.entry.length) fail('EMPTY_MACRO', '空宏不能编译为可执行程序');
  return emitProgram(program, ids);
}

export function prepareMacroDraft(source) {
  try {
    return {...compileMacro(source), empty: false};
  } catch (error) {
    if (error?.code !== 'EMPTY_MACRO' ||
        !source.split(/\r\n|\r|\n/).every(line => !line.split('#', 1)[0].trim())) throw error;
    return {empty: true, package: new Uint8Array(), code: new Uint8Array(), packageCrc32: 0, pcToLine: {}};
  }
}
