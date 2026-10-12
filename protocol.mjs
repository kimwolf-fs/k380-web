const MAGIC = new TextEncoder().encode('K380CFG1');
const VERSION = 2;
const HEADER_SIZE = 14;
const MAX_PAYLOAD = 512;

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeFrame(command, sequence, payload = new Uint8Array()) {
  if (!Number.isInteger(command) || command < 0 || command > 255 ||
      !Number.isInteger(sequence) || sequence < 0 || sequence > 65535 ||
      payload.length > MAX_PAYLOAD) {
    throw new RangeError('协议帧参数无效');
  }
  const frame = new Uint8Array(HEADER_SIZE + payload.length + 4);
  frame.set(MAGIC);
  const view = new DataView(frame.buffer);
  view.setUint8(8, VERSION);
  view.setUint8(9, command);
  view.setUint16(10, sequence, true);
  view.setUint16(12, payload.length, true);
  frame.set(payload, HEADER_SIZE);
  view.setUint32(frame.length - 4, crc32(frame.subarray(0, -4)), true);
  return frame;
}

export class FrameDecoder {
  constructor() {
    this.buffer = new Uint8Array();
  }

  feed(chunk) {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    this.buffer = joined;
    const frames = [];
    while (this.buffer.length >= HEADER_SIZE) {
      let start = -1;
      for (let i = 0; i <= this.buffer.length - MAGIC.length; i += 1) {
        if (MAGIC.every((byte, index) => this.buffer[i + index] === byte)) {
          start = i;
          break;
        }
      }
      if (start < 0) {
        this.buffer = this.buffer.slice(-(MAGIC.length - 1));
        break;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      if (this.buffer.length < HEADER_SIZE) break;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset);
      if (view.getUint8(8) !== VERSION) throw new Error('K380 协议版本不匹配');
      const length = view.getUint16(12, true);
      if (length > MAX_PAYLOAD) throw new Error('K380 响应长度超限');
      const size = HEADER_SIZE + length + 4;
      if (this.buffer.length < size) break;
      if (view.getUint32(size - 4, true) !== crc32(this.buffer.subarray(0, size - 4))) {
        throw new Error('K380 响应 CRC 错误');
      }
      frames.push({
        command: view.getUint8(9),
        sequence: view.getUint16(10, true),
        payload: this.buffer.slice(HEADER_SIZE, size - 4)
      });
      this.buffer = this.buffer.slice(size);
    }
    return frames;
  }
}

export function decodeInfo(payload) {
  if (payload.length !== 15 || payload[0] !== 0) throw new Error('K380 设备信息无效');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    protocolVersion: payload[1],
    configVersion: payload[2],
    presetCount: payload[3],
    layerCount: payload[4],
    keyCount: payload[5],
    macroSlotCount: payload[6],
    macroMaxPackageBytes: view.getUint16(8, true),
    macroMaxCodeBytes: view.getUint16(10, true),
    macroChunkMax: view.getUint16(12, true),
    macroTraceCapacity: payload[14]
  };
}

export function decodePresets(payload) {
  if (payload.length !== 134 || payload[0] !== 0 || payload[1] >= 4) {
    throw new Error('K380 预设列表无效');
  }
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const presets = [];
  const seen = new Set();
  for (let index = 0; index < 4; index += 1) {
    const offset = 2 + index * 33;
    const id = payload[offset];
    if (id >= 4 || seen.has(id)) throw new Error('K380 预设编号无效');
    seen.add(id);
    const nameBytes = payload.subarray(offset + 1, offset + 33);
    const end = nameBytes.indexOf(0);
    presets.push({id, name: decoder.decode(end < 0 ? nameBytes : nameBytes.subarray(0, end))});
  }
  return {activePreset: payload[1], presets};
}

export function decodeBindings(payload, expectedPreset) {
  if (payload.length !== 484 || payload[0] !== 0 || payload[2] !== expectedPreset || payload[3] !== 0) {
    throw new Error('K380 预设绑定数据无效');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const layers = Array.from({length: 2}, (_, layer) => Array.from({length: 80}, (_, key) => {
    const offset = 4 + (layer * 80 + key) * 3;
    const type = payload[offset];
    const value = view.getUint16(offset + 1, true);
    if (type > 2) throw new Error('K380 预设绑定类型无效');
    return type === 2 ? {type, macroIndex: value} : {type, keyUsage: value};
  }));
  return {activePreset: payload[1], presetId: payload[2], layers};
}

export class K380Connection {
  constructor(port, {timeoutMs = 2500} = {}) {
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.decoder = new FrameDecoder();
    this.pending = [];
    this.sequence = 0;
    this.reader = null;
    this.writer = null;
    this.reading = null;
    this.exchangeQueue = Promise.resolve();
  }

  async open() {
    await this.port.open({baudRate: 115200});
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
  }

  exchange(command, payload = new Uint8Array()) {
    const result = this.exchangeQueue.then(() => this.exchangeFrame(command, payload));
    this.exchangeQueue = result.catch(() => {});
    return result;
  }

  async exchangeFrame(command, payload) {
    this.sequence = (this.sequence + 1) & 0xffff;
    const sequence = this.sequence;
    await this.writer.write(encodeFrame(command, sequence, payload));
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      while (this.pending.length) {
        const frame = this.pending.shift();
        if (frame.command === (command | 0x80) && frame.sequence === sequence) {
          if (!frame.payload.length) throw new Error('K380 响应缺少结果码');
          if (frame.payload[0] !== 0 && !(command === 17 && frame.payload[0] === 15)) {
            throw new Error(`K380 拒绝请求，错误码 ${frame.payload[0]}`);
          }
          return frame.payload;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('等待 K380 响应超时');
      let timer;
      if (!this.reading) {
        this.reading = this.reader.read().then(result => {
          if (result.done) throw new Error('设备串口已关闭');
          this.pending.push(...this.decoder.feed(result.value));
        }).finally(() => { this.reading = null; });
      }
      await Promise.race([
        this.reading,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('等待 K380 响应超时')), remaining);
        })
      ]).finally(() => clearTimeout(timer));
    }
  }

  async close() {
    if (this.reader) {
      await this.reader.cancel().catch(() => {});
      this.reader.releaseLock();
      this.reader = null;
    }
    if (this.writer) {
      this.writer.releaseLock();
      this.writer = null;
    }
    await this.port.close();
  }
}
