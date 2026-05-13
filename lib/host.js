'use strict';

const net    = require('net');
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { MSG, encode, FrameParser, makeChallenge, verifyChallenge } = require('./protocol');

let log; // injected by CLI

// ─── Host ────────────────────────────────────────────────────────────────────
class Host {
  constructor(opts) {
    this.password   = opts.password || '';
    this.tunnelPort = opts.tunnelPort || 7700;
    this.ports      = opts.ports || [];          // ports to share
    this.tlsCert    = opts.cert || null;
    this.tlsKey     = opts.key  || null;
    this._clients   = new Set();
  }

  start(logger) {
    log = logger;
    this._startTunnelServer();
  }

  // ── Tunnel WS server ──────────────────────────────────────────────────────
  _startTunnelServer() {
    let server;
    const usesTLS = this.tlsCert && this.tlsKey;

    if (usesTLS) {
      const ctx = {
        cert: fs.readFileSync(this.tlsCert),
        key:  fs.readFileSync(this.tlsKey),
      };
      server = https.createServer(ctx);
    } else {
      server = http.createServer();
    }

    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => this._handleClient(ws));

    server.listen(this.tunnelPort, () => {
      log.info(`Tunnel server listening on :${this.tunnelPort} (${usesTLS ? 'TLS' : 'plain'})`);
      log.info(`Sharing ports: ${this.ports.join(', ')}`);
    });
  }

  // ── Per-client handler ────────────────────────────────────────────────────
  _handleClient(ws) {
    const id = crypto.randomBytes(4).toString('hex');
    log.info(`[${id}] Client connected`);

    const state = {
      id,
      ws,
      authed     : !this.password,  // skip auth if no password set
      streams    : new Map(),        // streamId → net.Socket (to local port)
      parser     : null,
    };

    // Auth flow
    if (this.password) {
      const challenge = makeChallenge();
      state.challenge = challenge;
      ws.send(encode(MSG.AUTH_CHALLENGE, 0, challenge));
    } else {
      // No password - announce ports immediately
      this._announceports(state);
    }

    state.parser = new FrameParser((frame) => this._onFrame(state, frame));

    ws.on('message', (data) => state.parser.push(Buffer.from(data)));
    ws.on('close',   ()     => this._onClientClose(state));
    ws.on('error',   (e)    => log.warn(`[${id}] WS error: ${e.message}`));

    this._clients.add(state);
  }

  _announceports(state) {
    const payload = Buffer.from(JSON.stringify(this.ports));
    state.ws.send(encode(MSG.PORT_ANNOUNCE, 0, payload));
    log.info(`[${state.id}] Auth OK → announced ports ${this.ports.join(', ')}`);
  }

  // ── Frame dispatch ────────────────────────────────────────────────────────
  _onFrame(state, frame) {
    switch (frame.type) {

      case MSG.AUTH_RESPONSE: {
        if (!this.password) break;
        const ok = verifyChallenge(state.challenge, frame.payload, this.password);
        if (ok) {
          state.authed = true;
          state.ws.send(encode(MSG.AUTH_OK, 0));
          this._announceports(state);
        } else {
          log.warn(`[${state.id}] Auth failed`);
          state.ws.send(encode(MSG.AUTH_FAIL, 0, 'bad password'));
          state.ws.close();
        }
        break;
      }

      case MSG.CONNECT_ACK: {
        // client opened its local socket; now open one to the real local service
        if (!state.authed) break;
        const { streamId, payload } = frame;
        const port = payload.readUInt16BE(0);
        log.debug?.(`[${state.id}] Opening stream ${streamId} → localhost:${port}`);
        this._openLocalStream(state, streamId, port);
        break;
      }

      case MSG.CONNECT_FAIL: {
        const sock = state.streams.get(frame.streamId);
        sock?.destroy();
        state.streams.delete(frame.streamId);
        break;
      }

      case MSG.DATA: {
        if (!state.authed) break;
        const sock = state.streams.get(frame.streamId);
        if (sock && !sock.destroyed) sock.write(frame.payload);
        break;
      }

      case MSG.FIN: {
        const sock = state.streams.get(frame.streamId);
        if (sock && !sock.destroyed) sock.end();
        break;
      }

      case MSG.PING:
        state.ws.send(encode(MSG.PONG, 0));
        break;
    }
  }

  // ── Local TCP server per shared port ────────────────────────────────────
  // Instead of host initiating connections, the host accepts them on the real
  // service and signals client to open a matching socket. Then we pipe.
  //
  // Flow:
  //   [Browser on Client]──►[local listener on Client]──►[WS tunnel]──►[Host opens conn to real service]
  //
  // The client listens locally; when it gets a connection it picks a new streamId,
  // sends CONNECT_ACK(streamId, port) to host; host opens to localhost:port, acks back,
  // and data flows bidirectionally.
  //
  // BUT: host needs to tell client WHICH ports to expose (PORT_ANNOUNCE).
  // The actual TCP accept happens on the CLIENT side for those ports.

  _openLocalStream(state, streamId, port) {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      log.debug?.(`[${state.id}] stream ${streamId} connected to :${port}`);
    });

    state.streams.set(streamId, sock);

    sock.on('data', (chunk) => {
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(encode(MSG.DATA, streamId, chunk));
      }
    });

    sock.on('end', () => {
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(encode(MSG.FIN, streamId));
      }
    });

    sock.on('error', (e) => {
      log.warn(`[${state.id}] Local stream ${streamId} error: ${e.message}`);
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(encode(MSG.CONNECT_FAIL, streamId));
      }
      state.streams.delete(streamId);
    });

    sock.on('close', () => {
      state.streams.delete(streamId);
    });
  }

  _onClientClose(state) {
    log.info(`[${state.id}] Client disconnected`);
    for (const sock of state.streams.values()) sock.destroy();
    state.streams.clear();
    this._clients.delete(state);
  }
}

module.exports = { Host };
