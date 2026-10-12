import {isReserved} from './presets.mjs';
import {macroSourceToken} from './macro-compiler.mjs';

export {isReserved};

export const physicalKeys = [
  'Esc','F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12','Insert','Del',
  '`','1','2','3','4','5','6','7','8','9','0','-','=','Backspace',
  'Tab','Q','W','E','R','T','Y','U','I','O','P','[',']','\\',
  'Caps','A','S','D','F','G','H','J','K','L',';',"'",'Enter',
  'Left Shift','Non-US \\','Z','X','C','V','B','N','M',',','.','/','Right Shift',
  'Left Ctrl','Fn','Left GUI','Left Alt','Space','Right Alt','Right Ctrl','Left Arrow','Up Arrow','Down Arrow','Right Arrow'
];

const rowWidths = [
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1.15,1.15],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,2],
  [1.5,1,1,1,1,1,1,1,1,1,1,1,1,1.5],
  [1.75,1,1,1,1,1,1,1,1,1,1,1,2.25],
  [1.8,1,1,1,1,1,1,1,1,1,1,1,1.95],
  [1.25,1,1.25,1.25,5,1.25,1.25,1,1,1,1]
];
let nextIndex = 0;
export const keyRows = rowWidths.map(row => row.map(width => ({index: nextIndex++, width})));

const normal = [41,58,59,60,61,62,63,64,65,66,67,68,69,73,76,53,30,31,32,33,34,35,36,37,38,39,45,46,42,43,20,26,8,21,23,28,24,12,18,19,47,48,49,57,4,22,7,9,10,11,13,14,15,51,52,40,225,100,29,27,6,25,5,17,16,54,55,56,229,224,null,227,226,44,230,228,80,82,81,79];
const fn = normal.slice();
for (const index of [1,2,3,4,14,16,17,18,19,28,79]) fn[index] = null;
Object.assign(fn, {70:227,71:226,72:44,73:230,74:228,75:80,76:82,77:81,78:79});
const special = new Map([
  [1,'蓝牙 1'],[2,'蓝牙 2'],[3,'蓝牙 3'],[4,'透传'],[14,'进入烧录模式'],
  [16,'切换预设 1'],[17,'切换预设 2'],[18,'切换预设 3'],[19,'切换预设 4'],
  [28,'解锁配置'],[79,'透传']
]);

const names = new Map([
  [40,'Enter'],[41,'Esc'],[42,'Backspace'],[43,'Tab'],[44,'Space'],[45,'-'],[46,'='],
  [47,'['],[48,']'],[49,'\\'],[50,'Non-US #'],[51,';'],[52,"'"],[53,'`'],
  [54,','],[55,'.'],[56,'/'],[57,'Caps Lock'],[70,'Print Screen'],[71,'Scroll Lock'],
  [72,'Pause'],[73,'Insert'],[74,'Home'],[75,'Page Up'],[76,'Delete'],[77,'End'],
  [78,'Page Down'],[79,'Right Arrow'],[80,'Left Arrow'],[81,'Down Arrow'],[82,'Up Arrow'],
  [83,'Keypad Num Lock'],[84,'Keypad /'],[85,'Keypad *'],[86,'Keypad -'],
  [87,'Keypad +'],[88,'Keypad Enter'],[100,'Non-US \\'],[101,'Application'],[103,'Keypad ='],
  [224,'Left Ctrl'],[225,'Left Shift'],
  [226,'Left Alt'],[227,'Left GUI'],[228,'Right Ctrl'],[229,'Right Shift'],
  [230,'Right Alt'],[231,'Right GUI']
]);
for (let i = 4; i <= 29; i += 1) names.set(i, String.fromCharCode(65 + i - 4));
for (let i = 30; i <= 39; i += 1) names.set(i, String((i - 29) % 10));
for (let i = 58; i <= 69; i += 1) names.set(i, `F${i - 57}`);
for (let i = 89; i <= 97; i += 1) names.set(i, `Keypad ${i - 88}`);
names.set(98, 'Keypad 0');
names.set(99, 'Keypad .');
for (let i = 104; i <= 115; i += 1) names.set(i, `F${i - 91}`);

export function usageLabel(usage) {
  return names.get(usage) || `HID ${usage}`;
}

export function defaultLabel(index, layer) {
  if (layer === 1 && special.has(index)) return special.get(index);
  if (layer === 0 && index === 70) return 'Fn 层切换';
  const usage = (layer === 1 ? fn : normal)[index];
  return usage == null ? '未绑定' : usageLabel(usage);
}

const codeUsages = new Map([
  ['Backspace',42],['Tab',43],['Enter',40],['Escape',41],['Space',44],['Minus',45],['Equal',46],
  ['BracketLeft',47],['BracketRight',48],['Backslash',49],['Semicolon',51],['Quote',52],['Backquote',53],
  ['Comma',54],['Period',55],['Slash',56],['CapsLock',57],['Insert',73],['Home',74],['PageUp',75],
  ['Delete',76],['End',77],['PageDown',78],['ArrowRight',79],['ArrowLeft',80],['ArrowDown',81],
  ['ArrowUp',82],['ControlLeft',224],['ShiftLeft',225],['AltLeft',226],['MetaLeft',227],
  ['ControlRight',228],['ShiftRight',229],['AltRight',230],['MetaRight',231]
]);

export function usageFromCode(code) {
  if (codeUsages.has(code)) return codeUsages.get(code);
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) - 61;
  if (/^Digit[0-9]$/.test(code)) return code === 'Digit0' ? 39 : 29 + Number(code.slice(5));
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    const number = Number(code.slice(1));
    return number <= 12 ? 57 + number : 104 + number - 13;
  }
  return 0;
}

export const usageOptions = Array.from({length: 228}, (_, index) => ({value: index + 4, label: usageLabel(index + 4)}));

export function sourceUsageToken(usage) {
  return macroSourceToken(usage);
}

export const MACRO_RECORD_WAIT_THRESHOLD_MS = 30;

export function recordedInstructions({type, usage, now, lastEventAt}) {
  const token = sourceUsageToken(usage);
  if (!token) return {lines: [], lastEventAt};
  const lines = [];
  const delta = now - lastEventAt;
  if (lastEventAt && delta >= MACRO_RECORD_WAIT_THRESHOLD_MS) {
    lines.push(`等待 ${Math.round(delta)}`);
  }
  lines.push(`${type === 'keydown' ? '按下' : '弹起'} ${token}`);
  return {lines, lastEventAt: now};
}
