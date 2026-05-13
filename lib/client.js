'use strict';

const net = require('net');
const { WebSocket } = require('ws');
const { MSG, encode, FrameParser, signChallenge } = require('./protocol');

let log;

const RECONNECT_BASE  = 1000;
const RECONNECT_MAX   = 30000;
const PING_INTERVAL   = 20000;

class Client {
  constructor(opts) {
    this.host       = opts.host || 'localhost';
    this.port       = opts.port || 7700;
    this.password   = opts.password || '';
    this.tls        = opts.tls || false;
    this.rejectUnauthorized = opts.rejectUnauthorized !== false;
    this._listeners = new Map();  // localPort → net.Server
    this._streams   = new Map();  // streamId → net.Socket
    this._streamSeq = 1;
    this._ws        = null;
    this._pingTimer = null;
    this._reconnectAttempt = 0;
    this._stopping  = false;
  }

  start(logger) {
    log = logger;
    this._connect();
  }

  stop() {
    this._stopping = true;
    this._ws?.close();
    for (const srv of this._listeners.values()) srv.close();
  }

  // ── WebSocket connection ───────────────────────────────────────────────────
  _connect() {
    const scheme = this.tls ? 'wss' : 'ws';
    const url    = `${scheme}://${this.host}:${this.port}`;
    log.info(`Connecting to ${url}…`);

    const wsOpts = this.tls ? { rejectUnauthorized: this.rejectUnauthorized } : {};
    const ws = new WebSocket(url, wsOpts);
    this._ws = ws;

    const parser = new FrameParser((frame) => this._onFrame(frame));

    ws.on('open',    ()    => { this._reconnectAttempt = 0; this._startPing(); log.info('Tunnel connected'); });
    ws.on('message',(data) => parser.push(Buffer.from(data)));
    ws.on('close',  ()    => { this._onDisconnect(); });
    ws.on('error',  (e)   => log.warn(`WS error: ${e.message}`));
  }

  _startPing() {
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(encode(MSG.PING, 0));
      }
    }, PING_INTERVAL);
  }

  _onDisconnect() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;

    // Destroy all active streams
    for (const sock of this._streams.values()) sock.destroy();
    this._streams.clear();

    if (this._stopping) return;

    const delay = Math.min(RECONNECT_BASE * 2 ** this._reconnectAttempt, RECONNECT_MAX)
                + Math.random() * 1000;
    this._reconnectAttempt++;
    log.warn(`Disconnected. Reconnecting in ${(delay / 1000).toFixed(1)}s…`);
    setTimeout(() => this._connect(), delay);
  }

  // ── Frame dispatch ────────────────────────────────────────────────────────
  _onFrame(frame) {
    switch (frame.type) {

      case MSG.AUTH_CHALLENGE: {
        const response = signChallenge(frame.payload, this.password);
        this._ws.send(encode(MSG.AUTH_RESPONSE, 0, response));
        break;
      }

      case MSG.AUTH_OK:
        log.info('Authenticated ✓');
        break;

      case MSG.AUTH_FAIL:
        log.error('Authentication failed — wrong password');
        this._stopping = true;
        this._ws.close();
        process.exit(1);
        break;

      case MSG.PORT_ANNOUNCE: {
        const ports = JSON.parse(frame.payload.toString('utf8'));
        log.info(`Host sharing ports: ${ports.join(', ')}`);
        this._setupListeners(ports);
        break;
      }

      case MSG.DATA: {
        const sock = this._streams.get(frame.streamId);
        if (sock && !sock.destroyed) sock.write(frame.payload);
        break;
      }

      case MSG.FIN: {
        const sock = this._streams.get(frame.streamId);
        if (sock && !sock.destroyed) sock.end();
        break;
      }

      case MSG.CONNECT_FAIL: {
        const sock = this._streams.get(frame.streamId);
        sock?.destroy();
        this._streams.delete(frame.streamId);
        break;
      }

      case MSG.PONG:
        break;
    }
  }

  // ── Local port listeners ──────────────────────────────────────────────────
  _setupListeners(ports) {
    // Close any listeners for ports no longer shared
    for (const [p, srv] of this._listeners) {
      if (!ports.includes(p)) { srv.close(); this._listeners.delete(p); }
    }

    for (const port of ports) {
      if (this._listeners.has(port)) continue;
      this._startListener(port);
    }
  }

  _startListener(port) {
    const server = net.createServer((sock) => this._handleLocalConn(sock, port));

    server.listen(port, '127.0.0.1', () => {
      log.info(`  → localhost:${port} mirrored`);
    });

    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        log.error(`Port ${port} already in use locally — cannot mirror`);
      } else {
        log.error(`Listener :${port} error: ${e.message}`);
      }
    });

    this._listeners.set(port, server);
  }

  // ── Per-connection stream ─────────────────────────────────────────────────
  _handleLocalConn(sock, port) {
    if (this._ws?.readyState !== WebSocket.OPEN) {
      sock.destroy();
      return;
    }

    const streamId = this._streamSeq++ & 0xFFFFFFFF;
    this._streams.set(streamId, sock);
    log.debug?.(`New local conn on :${port} → stream ${streamId}`);

    // Tell host to open a connection on its side
    const portBuf = Buffer.allocUnsafe(2);
    portBuf.writeUInt16BE(port, 0);
    this._ws.send(encode(MSG.CONNECT_ACK, streamId, portBuf));

    sock.on('data', (chunk) => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(encode(MSG.DATA, streamId, chunk));
      }
    });

    sock.on('end', () => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(encode(MSG.FIN, streamId));
      }
    });

    sock.on('error', (e) => {
      log.warn(`Stream ${streamId} local socket error: ${e.message}`);
      this._streams.delete(streamId);
    });

    sock.on('close', () => {
      this._streams.delete(streamId);
    });
  }
}

module.exports = { Client };
