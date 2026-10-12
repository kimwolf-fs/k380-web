export const MAX_BACKUP_BYTES = 262144;
const encoder = new TextEncoder();
const placeholderName = name => /^宏\s*(?:[1-9]|1[0-6])$/.test(name);

function validate(entry) {
  if (!entry || entry.format !== 'k380-macro-source' || entry.version !== 1) {
    throw new Error('不支持的宏备份文件格式或版本');
  }
  if (typeof entry.source !== 'string' || encoder.encode(entry.source).length > 32768) {
    throw new Error('宏源码必须为文本且不能超过 32768 字节');
  }
  if (typeof entry.name !== 'string' || encoder.encode(entry.name).length > 32) {
    throw new Error('宏名称不能超过 32 个 UTF-8 字节');
  }
  if (!Number.isInteger(entry.trigger) || entry.trigger < 0 || entry.trigger > 3 ||
      !Number.isInteger(entry.repeatCount) ||
      (entry.trigger === 3 ? entry.repeatCount < 1 || entry.repeatCount > 65535 : entry.repeatCount !== 1)) {
    throw new Error('宏触发方式或执行次数无效');
  }
  return {source: entry.source, name: entry.name, trigger: entry.trigger, repeatCount: entry.repeatCount};
}

export function createBackup(draft, savedName, preset, slot) {
  const entry = {format: 'k380-macro-source', version: 1, preset, slot,
    source: draft.source, name: draft.name, trigger: draft.trigger, repeatCount: draft.repeatCount};
  validate(entry);
  const base = (savedName || `宏${slot + 1}`).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '') || `宏${slot + 1}`;
  const safeBase = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? `_${base}` : base;
  return {filename: `${safeBase}.json`, text: JSON.stringify(entry, null, 2) + '\n'};
}

export function parseBackup(text, filename) {
  if (encoder.encode(text).length > MAX_BACKUP_BYTES) throw new Error('宏备份文件过大');
  let entry;
  try { entry = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('宏备份文件不是有效的 JSON'); }
  const draft = validate(entry);
  const base = filename.replace(/\.json$/i, '');
  if (placeholderName(base) || placeholderName(draft.name)) draft.name = '';
  return draft;
}
