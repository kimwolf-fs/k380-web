const MAX_PACKAGE = 1104;
const CHUNK_SIZE = 384;
const UPLOAD_DEADLINE_MS = 5000;
const MACRO_RECORD_VERSION = 2;
import {crc32} from './protocol.mjs';

const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function response(payload, size, label, allowTraceLoss = false) {
  if (payload.length !== size || (payload[0] !== 0 && !(allowTraceLoss && payload[0] === 15))) {
    throw new Error(`${label}：设备响应无效`);
  }
  return viewOf(payload);
}

function requireRunId(runId) {
  if (!Number.isInteger(runId) || runId <= 0 || runId > 0xffffffff) throw new Error('无效的宏运行编号');
}

async function uploadMacro(connection, preset, slot, compiled, operation, settings, {onProgress = () => {}} = {}) {
  if (!Number.isInteger(preset) || preset < 0 || preset > 3) throw new Error('预设编号无效');
  if (!Number.isInteger(slot) || slot < 0 || slot >= 16) throw new Error('宏槽位无效');
  const bytes = compiled.package;
  if (operation === 1 && bytes instanceof Uint8Array && !bytes.length && compiled.packageCrc32 === 0) {
    throw new Error('空宏没有可执行动作');
  }
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_PACKAGE ||
      !Number.isInteger(compiled.packageCrc32) || compiled.packageCrc32 < 0 || compiled.packageCrc32 > 0xffffffff ||
      (!bytes.length && (operation !== 0 || compiled.packageCrc32 !== 0))) {
    throw new Error('宏程序包无效');
  }
  const deadline = Date.now() + UPLOAD_DEADLINE_MS;
  const checkTime = () => { if (Date.now() >= deadline) throw new Error('宏上传超过 5 秒，测试未开始'); };
  const begin = new Uint8Array(50);
  const header = viewOf(begin);
  begin[0] = operation;
  begin[1] = preset;
  begin[2] = slot;
  begin[3] = settings.trigger;
  const name = new TextEncoder().encode(settings.name);
  if (name.length > 32) throw new Error('宏名称最多 32 个 UTF-8 字节');
  if (settings.trigger < 0 || settings.trigger > 3 || !Number.isInteger(settings.trigger) ||
      !Number.isInteger(settings.repeatCount) ||
      (settings.trigger === 3 ? settings.repeatCount < 1 || settings.repeatCount > 65535 : settings.repeatCount !== 1)) {
    throw new Error('宏触发方式或次数无效');
  }
  begin[4] = name.length;
  begin.set(name, 18);
  header.setUint32(6, settings.repeatCount, true);
  header.setUint16(10, bytes.length, true);
  header.setUint32(14, compiled.packageCrc32, true);
  let sessionId = 0;
  try {
    checkTime();
    const start = response(await connection.exchange(13, begin), 7, '开始宏测试');
    sessionId = start.getUint32(1, true);
    if (!sessionId || start.getUint16(5, true) !== CHUNK_SIZE) throw new Error('设备返回的上传会话参数无效');
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      checkTime();
      const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
      const request = new Uint8Array(8 + chunk.length);
      const header = viewOf(request);
      header.setUint32(0, sessionId, true);
      header.setUint16(4, offset, true);
      header.setUint16(6, chunk.length, true);
      request.set(chunk, 8);
      const progress = response(await connection.exchange(14, request), 7, '上传宏分块');
      checkTime();
      if (progress.getUint32(1, true) !== sessionId || progress.getUint16(5, true) !== offset + chunk.length) {
        throw new Error('设备返回的上传偏移不匹配');
      }
      onProgress(offset + chunk.length, bytes.length);
    }
    checkTime();
    const commit = new Uint8Array(4);
    viewOf(commit).setUint32(0, sessionId, true);
    const result = response(await connection.exchange(15, commit), 9, '提交宏测试');
    checkTime();
    if (result.getUint32(1, true) !== sessionId) throw new Error('设备返回的上传会话编号不匹配');
    const runId = result.getUint32(5, true);
    if (operation === 1) requireRunId(runId);
    else if (runId !== 0) throw new Error('保存宏时设备返回了运行编号');
    return runId;
  } catch (error) {
    if (sessionId) {
      const abort = new Uint8Array(4);
      viewOf(abort).setUint32(0, sessionId, true);
      await connection.exchange(16, abort).catch(() => {});
    }
    throw error;
  }
}

export function testMacro(connection, preset, compiled, options) {
  return uploadMacro(connection, preset, options?.slot ?? 0, compiled, 1,
    {name: '', trigger: 0, repeatCount: 1}, options);
}

export async function readMacro(connection, preset, slot) {
  if (!Number.isInteger(preset) || preset < 0 || preset > 3 ||
      !Number.isInteger(slot) || slot < 0 || slot >= 16) throw new Error('预设或宏槽位无效');
  const meta = await connection.exchange(11, Uint8Array.of(preset, slot));
  const view = response(meta, 49, '宏元数据');
  if (meta[1] !== preset || meta[2] !== slot) throw new Error('设备返回了其他宏槽位的元数据');
  const nameLength = meta[5];
  if (meta[6] !== 0 || nameLength > 32 || meta.subarray(17 + nameLength).some(Boolean)) {
    throw new Error('宏元数据名称无效');
  }
  const recordVersion = meta[3];
  const trigger = meta[4];
  const repeatCount = view.getUint32(7, true);
  if (recordVersion !== MACRO_RECORD_VERSION) throw new Error('宏记录版本不支持');
  if (trigger > 3 || (trigger === 3 ? repeatCount < 1 || repeatCount > 65535 : repeatCount !== 1)) {
    throw new Error('设备宏触发方式或次数无效');
  }
  const name = new TextDecoder('utf-8', {fatal: true}).decode(meta.subarray(17, 17 + nameLength));
  const length = view.getUint16(11, true);
  const packageCrc32 = view.getUint32(13, true);
  if (length > MAX_PACKAGE) throw new Error('宏程序包长度超限');
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length;) {
    const request = new Uint8Array(6);
    const requestView = viewOf(request);
    request[0] = preset;
    request[1] = slot;
    requestView.setUint16(2, offset, true);
    requestView.setUint16(4, Math.min(CHUNK_SIZE, length - offset), true);
    const reply = await connection.exchange(12, request);
    if (reply.length < 7 || reply[0] !== 0) throw new Error('宏数据块响应无效');
    const chunkView = viewOf(reply);
    const size = chunkView.getUint16(5, true);
    if (reply[1] !== preset || reply[2] !== slot || chunkView.getUint16(3, true) !== offset ||
        !size || size > CHUNK_SIZE || size > length - offset || reply.length !== 7 + size) {
      throw new Error('宏数据块偏移或长度无效');
    }
    bytes.set(reply.subarray(7), offset);
    offset += size;
  }
  if (length === 0 ? packageCrc32 !== 0 :
      length < 16 || bytes[0] !== 75 || bytes[1] !== 86 || bytes[2] !== 77 || bytes[3] !== 49 ||
      viewOf(bytes).getUint32(12, true) !== packageCrc32 ||
      crc32(Uint8Array.from(bytes, (_, i) => i >= 12 && i < 16 ? 0 : bytes[i])) !== packageCrc32) {
    throw new Error('设备宏程序包校验失败');
  }
  return {preset, slot, recordVersion, trigger, name, repeatCount, packageCrc32, package: bytes};
}

export async function saveMacro(connection, preset, slot, compiled, settings, options) {
  await uploadMacro(connection, preset, slot, compiled, 0, settings, options);
  const stored = await readMacro(connection, preset, slot);
  if (stored.name !== settings.name || stored.trigger !== settings.trigger ||
      stored.repeatCount !== settings.repeatCount || stored.packageCrc32 !== compiled.packageCrc32 ||
      stored.package.length !== compiled.package.length ||
      !stored.package.every((byte, index) => byte === compiled.package[index])) {
    throw new Error('保存后设备读回校验不一致；请重新读取槽位确认');
  }
  return stored;
}

export async function readRunState(connection, runId, cursor) {
  requireRunId(runId);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > 0xffffffff) throw new Error('日志游标无效');
  const request = new Uint8Array(12);
  const view = viewOf(request);
  view.setUint32(0, runId, true);
  view.setUint32(4, cursor, true);
  request[8] = 30;
  const payload = await connection.exchange(17, request);
  if (payload.length < 21) throw new Error('宏运行状态响应过短');
  const viewResponse = viewOf(payload);
  const count = payload[17];
  response(payload, 21 + count * 16, '宏运行状态', true);
  if (count > 30 || viewResponse.getUint16(7, true) !== 0 || payload[18] || payload[19] || payload[20]) {
    throw new Error('宏运行状态格式无效');
  }
  if (viewResponse.getUint32(1, true) !== runId) throw new Error('设备返回了其他宏运行编号');
  const nextCursor = viewResponse.getUint32(9, true);
  if (payload[0] === 0 && nextCursor < cursor) throw new Error('宏日志游标倒退');
  const events = [];
  for (let offset = 21; offset < payload.length; offset += 16) {
    events.push({
      sequence: viewResponse.getUint32(offset, true),
      pc: viewResponse.getUint16(offset + 4, true),
      type: payload[offset + 6], result: payload[offset + 7],
      value: viewResponse.getUint32(offset + 8, true),
      elapsedMs: viewResponse.getUint32(offset + 12, true)
    });
  }
  return {runId, state: payload[5], vmError: payload[6], nextCursor,
    dropped: viewResponse.getUint32(13, true), traceLost: payload[0] === 15, events};
}

export async function stopMacro(connection, runId) {
  requireRunId(runId);
  const request = new Uint8Array(4);
  viewOf(request).setUint32(0, runId, true);
  response(await connection.exchange(18, request), 1, '停止宏测试');
}
