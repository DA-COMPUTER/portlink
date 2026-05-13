'use strict';

const crypto = require('crypto');

// ─── Message Types ───────────────────────────────────────────────────────────
const MSG = {
  AUTH_CHALLENGE : 0x01,
  AUTH_RESPONSE  : 0x02,
  AUTH_OK        : 0x03,
  AUTH_FAIL      : 0x04,
  PORT_ANNOUNCE  : 0x05,
  PORT_ACK       : 0x06,
  CONNECT        : 0x10,  // new inbound TCP conn on host
  CONNECT_ACK    : 0x11,  // client opened local socket
  CONNECT_FAIL   : 0x12,
  DATA           : 0x20,  // payload bytes
  FIN            : 0x21,  // half-close
  PING           : 0x30,
  PONG           : 0x31,
};

// ─── Frame layout ────────────────────────────────────────────────────────────
// [ type:1 | streamId:4 | payloadLen:4 | payload:N ]
const HEADER_SIZE = 9;

function encode(type, streamId, payload = Buffer.alloc(0)) {
  if (typeof payload === 'string') payload = Buffer.from(payload, 'utf8');
  const buf = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(streamId, 1);
  buf.writeUInt32BE(payload.length, 5);
  payload.copy(buf, HEADER_SIZE);
  return buf;
}

function decode(buf) {
  if (buf.length < HEADER_SIZE) return null;
  const type      = buf.readUInt8(0);
  const streamId  = buf.readUInt32BE(1);
  const payloadLen = buf.readUInt32BE(5);
  if (buf.length < HEADER_SIZE + payloadLen) return null;
  const payload = buf.slice(HEADER_SIZE, HEADER_SIZE + payloadLen);
  return { type, streamId, payload, totalLen: HEADER_SIZE + payloadLen };
}

// ─── Frame stream splitter ────────────────────────────────────────────────────
class FrameParser {
  constructor(onFrame) {
    this._buf = Buffer.alloc(0);
    this._onFrame = onFrame;
  }
  push(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    let frame;
    while ((frame = decode(this._buf)) !== null) {
      this._buf = this._buf.slice(frame.totalLen);
      this._onFrame(frame);
    }
  }
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function makeChallenge() {
  return crypto.randomBytes(32);
}

function signChallenge(challenge, password) {
  return crypto.createHmac('sha256', password).update(challenge).digest();
}

function verifyChallenge(challenge, response, password) {
  const expected = signChallenge(challenge, password);
  if (expected.length !== response.length) return false;
  return crypto.timingSafeEqual(expected, response);
}

module.exports = { MSG, encode, decode, FrameParser, makeChallenge, signChallenge, verifyChallenge, HEADER_SIZE };
