'use strict';
// Zero-dependency RFC6455 WebSocket server side. Loopback only, so no
// permessage-deflate, no fragmentation on send, no extensions.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function accept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.allocUnsafe(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.allocUnsafe(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.allocUnsafe(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

class WS extends EventEmitter {
  constructor(sock) {
    super();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.fragOp = 0;
    this.open = true;
    sock.setNoDelay(true);
    sock.on('data', (c) => this._data(c));
    sock.on('close', () => this._gone());
    sock.on('error', () => this._gone());
  }

  _gone() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _data(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > 268435456n) return this.close(1009); // 256MB sanity cap
        len = Number(big);
        off = 10;
      }
      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.subarray(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return;
      let body = this.buf.subarray(off, off + len);
      if (masked) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = body[i] ^ mask[i & 3];
        body = out;
      } else {
        body = Buffer.from(body);
      }
      this.buf = Buffer.from(this.buf.subarray(off + len));
      this._frame(fin, opcode, body);
    }
  }

  _frame(fin, opcode, body) {
    if (opcode === 0x8) return this.close();
    if (opcode === 0x9) return this._raw(0xa, body);
    if (opcode === 0xa) return void this.emit('pong');
    if (opcode === 0x0) this.frag.push(body);
    else { this.fragOp = opcode; this.frag = [body]; }
    if (!fin) return;
    const data = this.frag.length === 1 ? this.frag[0] : Buffer.concat(this.frag);
    this.frag = [];
    this.emit('message', this.fragOp === 0x1 ? data.toString('utf8') : data);
  }

  _raw(opcode, payload) {
    if (!this.open) return false;
    try { return this.sock.write(frame(opcode, payload)); }
    catch { this._gone(); return false; }
  }

  send(str) { return this._raw(0x1, Buffer.from(str, 'utf8')); }
  ping() { return this._raw(0x9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.allocUnsafe(2);
    p.writeUInt16BE(code, 0);
    this._raw(0x8, p);
    try { this.sock.end(); } catch {}
    this._gone();
  }
}

// Attach to an http server's 'upgrade' event.
function handleUpgrade(req, sock, head, verify) {
  const key = req.headers['sec-websocket-key'];
  const reject = (code, why) => {
    try { sock.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`); sock.destroy(); } catch {}
    return null;
  };
  if (!key || req.headers['sec-websocket-version'] !== '13') return reject(400, 'Bad Request');
  if (verify && !verify(req)) return reject(403, 'Forbidden');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`
  );
  const ws = new WS(sock);
  if (head && head.length) ws._data(head);
  return ws;
}

module.exports = { WS, handleUpgrade };
