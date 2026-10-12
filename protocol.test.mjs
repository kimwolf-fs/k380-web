import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  FrameDecoder, K380Connection, decodeBindings, decodeInfo, decodePresets, encodeFrame
} from './protocol.mjs';

const hex = value => Buffer.from(value).toString('hex');
const bytes = value => Uint8Array.from(Buffer.from(value, 'hex'));

test('HELLO frame matches the Python protocol byte for byte', () => {
  assert.equal(hex(encodeFrame(1, 7)), '4b33383043464731020107000000e22cf047');
  assert.equal(hex(encodeFrame(4, 3, bytes('0200'))), '4b3338304346473102040300020002003a6fdf4e');
});

test('preset list decodes UTF-8 names and rejects duplicate slots', () => {
  const response = new Uint8Array(2 + 4 * 33);
  response[1] = 2;
  const encoder = new TextEncoder();
  for (let i = 0; i < 4; i += 1) response[2 + i * 33] = i;
  response.set(encoder.encode('游戏'), 2 + 33 + 1);
  assert.deepEqual(decodePresets(response), {
    activePreset: 2,
    presets: [
      {id: 0, name: ''}, {id: 1, name: '游戏'},
      {id: 2, name: ''}, {id: 3, name: ''}
    ]
  });
  response[2 + 2 * 33] = 1;
  assert.throws(() => decodePresets(response), /预设/);
});

test('480-byte binding payload maps both layers and validates section', () => {
  const response = new Uint8Array(4 + 480);
  response[2] = 2;
  response[4 + 30 * 3] = 1;
  response[4 + 30 * 3 + 1] = 74;
  response[4 + (80 + 31) * 3] = 2;
  response[4 + (80 + 31) * 3 + 1] = 15;
  const decoded = decodeBindings(response, 2);
  assert.equal(decoded.activePreset, 0);
  assert.equal(decoded.layers[0][30].keyUsage, 74);
  assert.equal(decoded.layers[1][31].macroIndex, 15);
  assert.equal(decoded.layers[1].length, 80);
  response[3] = 1;
  assert.throws(() => decodeBindings(response, 2), /绑定/);
});

test('decoder reassembles a maximum-size bindings response across USB chunks', () => {
  const payload = new Uint8Array(484);
  payload[2] = 3;
  const frame = encodeFrame(0x84, 9, payload);
  const decoder = new FrameDecoder();
  let decoded = [];
  for (let offset = 0; offset < frame.length; offset += 64) {
    decoded.push(...decoder.feed(frame.subarray(offset, offset + 64)));
  }
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].payload.length, 484);
  assert.equal(decodeBindings(decoded[0].payload, 3).layers[0].length, 80);
});

test('decoder reassembles fragments, ignores leading noise, and checks CRC', () => {
  const frame = bytes('4b33383043464731028208000f00000202040250104050040004800140e1e398d4');
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.feed(bytes('00ff')), []);
  assert.deepEqual(decoder.feed(frame.slice(0, 11)), []);
  const result = decoder.feed(frame.slice(11));
  assert.equal(result.length, 1);
  assert.equal(result[0].command, 0x82);
  assert.equal(result[0].sequence, 8);
  assert.equal(decodeInfo(result[0].payload).macroMaxPackageBytes, 1104);
  const corrupt = frame.slice();
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => new FrameDecoder().feed(corrupt), /CRC/);
});

test('connection exchanges HELLO and GET_INFO without changing device state', async () => {
  const writes = [];
  const responses = [
    encodeFrame(0x81, 1, bytes('00')),
    encodeFrame(0x82, 2, bytes('000202040250104050040004800140'))
  ];
  let closed = false;
  const port = {
    async open(options) { assert.equal(options.baudRate, 115200); },
    readable: {getReader() { return {
      async read() { return {value: responses.shift(), done: false}; },
      async cancel() {},
      releaseLock() {}
    }; }},
    writable: {getWriter() { return {
      async write(data) { writes.push(hex(data)); },
      releaseLock() {}
    }; }},
    async close() { closed = true; }
  };
  const connection = new K380Connection(port);
  await connection.open();
  assert.equal((await connection.exchange(1))[0], 0);
  assert.equal(decodeInfo(await connection.exchange(2)).keyCount, 80);
  await connection.close();
  assert.equal(closed, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].slice(0, 28), '4b33383043464731020101000000');
  assert.equal(writes[1].slice(0, 28), '4b33383043464731020202000000');
});

test('connection transmits preset request payload', async () => {
  let sent;
  const port = {
    async open() {},
    readable: {getReader() { return {
      async read() { return {value: encodeFrame(0x84, 1, bytes('00000200')), done: false}; },
      async cancel() {}, releaseLock() {}
    }; }},
    writable: {getWriter() { return {async write(data) { sent = data; }, releaseLock() {}}; }},
    async close() {}
  };
  const connection = new K380Connection(port);
  await connection.open();
  const response = await connection.exchange(4, bytes('0200'));
  assert.equal(response[2], 2);
  assert.equal(hex(sent.slice(14, 16)), '0200');
  await connection.close();
});

test('connection permits trace cursor loss only for run state responses', async () => {
  let replyCommand = 0x91;
  const port = {
    async open() {},
    readable: {getReader() { return {
      async read() { return {value: encodeFrame(replyCommand, replyCommand === 0x91 ? 1 : 2, bytes('0f')), done: false}; },
      async cancel() {}, releaseLock() {}
    }; }},
    writable: {getWriter() { return {async write() {}, releaseLock() {}}; }},
    async close() {}
  };
  const connection = new K380Connection(port);
  await connection.open();
  assert.equal((await connection.exchange(17))[0], 15);
  replyCommand = 0x92;
  await assert.rejects(connection.exchange(18), /错误码 15/);
  await connection.close();
});

test('connection rejects wrong response sequence and releases the port', async () => {
  let closed = false;
  let first = true;
  const port = {
    async open() {},
    readable: {getReader() { return {
      async read() {
        if (first) {
          first = false;
          return {value: encodeFrame(0x81, 9, bytes('00')), done: false};
        }
        return new Promise(() => {});
      },
      async cancel() {}, releaseLock() {}
    }; }},
    writable: {getWriter() { return {async write() {}, releaseLock() {}}; }},
    async close() { closed = true; }
  };
  const connection = new K380Connection(port, {timeoutMs: 25});
  await connection.open();
  await assert.rejects(connection.exchange(1), /超时/);
  await connection.close();
  assert.equal(closed, true);
});

test('a timed-out read does not consume the following STOP response', async () => {
  const reads = [];
  const writes = [];
  const port = {
    async open() {},
    readable: {getReader() { return {
      read() { return new Promise(resolve => reads.push(resolve)); },
      async cancel() {}, releaseLock() {}
    }; }},
    writable: {getWriter() { return {
      async write(data) { writes.push(data[9]); }, releaseLock() {}
    }; }},
    async close() {}
  };
  const connection = new K380Connection(port, {timeoutMs: 50});
  await connection.open();
  await assert.rejects(connection.exchange(17), /超时/);
  const stopping = connection.exchange(18, bytes('2a000000'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [17, 18]);
  reads.shift()({value: encodeFrame(0x92, 2, bytes('00')), done: false});
  assert.equal((await stopping)[0], 0);
  await connection.close();
});

test('concurrent page requests share one serial exchange at a time', async () => {
  const writes = [];
  const reads = [];
  const port = {
    async open() {},
    readable: {getReader() { return {
      read() { return new Promise(resolve => reads.push(resolve)); },
      async cancel() {}, releaseLock() {}
    }; }},
    writable: {getWriter() { return {
      async write(data) { writes.push(data[9]); }, releaseLock() {}
    }; }},
    async close() {}
  };
  const connection = new K380Connection(port);
  await connection.open();
  const first = connection.exchange(17);
  const second = connection.exchange(12);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [17]);
  reads.shift()({value: encodeFrame(0x91, 1, bytes('00')), done: false});
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [17, 12]);
  reads.shift()({value: encodeFrame(0x8c, 2, bytes('00')), done: false});
  await second;
  await connection.close();
});
