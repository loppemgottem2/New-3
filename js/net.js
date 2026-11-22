// =====================================================================
//  NET.JS — peer-to-peer multiplayer using PeerJS (WebRTC).
//
//  How it works:
//   * The player who creates a server becomes the HOST. The host's
//     browser runs the authoritative game (bots, rounds, hits).
//   * Public servers use fixed ids: PREFIX + 'pub-1' ... 'pub-N'.
//     The server browser probes each slot to list running servers.
//   * Private servers use PREFIX + 'priv-' + CODE.
//   * Add ?local=1 to the URL to use a fake in-browser network
//     (BroadcastChannel) — handy for testing with two tabs offline.
// =====================================================================
import { CONFIG } from './config.js?v=1030';
import { Emitter } from './util.js?v=1030';

const params = new URLSearchParams(location.search);
export const LOCAL_MODE = params.has('local');

export const publicId = (slot) => `${CONFIG.NET.PEER_PREFIX}pub-${slot}`;
export const privateId = (code) => `${CONFIG.NET.PEER_PREFIX}priv-${code.toUpperCase()}`;

export function netAvailable() {
  return LOCAL_MODE || typeof window.Peer === 'function';
}

function peerOptions() {
  return { debug: 0, config: { iceServers: CONFIG.NET.ICE_SERVERS } };
}

// Create a Peer and wait until it's registered with the signaling server.
function createPeer(id) {
  const Ctor = LOCAL_MODE ? LocalPeer : window.Peer;
  return new Promise((resolve, reject) => {
    if (!Ctor) { reject({ type: 'no-peerjs', message: 'Networking library failed to load' }); return; }
    let peer;
    try { peer = id ? new Ctor(id, peerOptions()) : new Ctor(peerOptions()); } catch (e) { reject(e); return; }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return; done = true;
      try { peer.destroy(); } catch { /* */ }
      reject({ type: 'timeout', message: 'Could not reach the matchmaking server' });
    }, 12000);
    peer.on('open', () => { if (done) return; done = true; clearTimeout(timer); resolve(peer); });
    peer.on('error', (err) => {
      if (done) return; done = true; clearTimeout(timer);
      try { peer.destroy(); } catch { /* */ }
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------
//  HOST
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
//  Big messages are split into small pieces. PeerJS refuses to send any JSON message of ~16 KB or more
//  (it errors and the connection drops: the joining player saw "host disconnected"). The welcome for a
//  player joining mid-round easily passes that (all the furniture + the round's blood), so anything over
//  4000 characters goes out in 4000-character pieces (< 12 KB even with 3-byte characters) and is put
//  back together on the other side (the channel is reliable and ordered).
// ---------------------------------------------------------------------
const PIECE = 4000;
let pieceId = 1;
function sendPacked(conn, msg, str = null) {
  if (!conn || !conn.open) return;
  const s = str || JSON.stringify(msg);
  try {
    if (s.length <= PIECE) { conn.send(msg); return; }
    const k = pieceId++, n = Math.ceil(s.length / PIECE);
    for (let i = 0; i < n; i++) conn.send({ t: '_pc', k, i, n, d: s.slice(i * PIECE, (i + 1) * PIECE) });
  } catch { /* channel closing */ }
}
// returns the whole message once every piece is in (null while waiting), or the message itself
function unpack(store, d) {
  if (!d || d.t !== '_pc') return d;
  let e = store.get(d.k);
  if (!e) { e = { parts: new Array(d.n), got: 0 }; store.set(d.k, e); }
  if (e.parts[d.i] === undefined) { e.parts[d.i] = d.d; e.got++; }
  if (e.got < d.n) return null;
  store.delete(d.k);
  try { return JSON.parse(e.parts.join('')); } catch { return null; }
}

export class NetHost extends Emitter {
  static async create(peerId) {
    const peer = await createPeer(peerId);
    return new NetHost(peer, peerId);
  }

  constructor(peer, id) {
    super();
    this.peer = peer;
    this.id = id;
    this.conns = new Map(); // cid -> { conn, last }
    this.nextCid = 1;
    this.closed = false;
    peer.on('connection', (conn) => this._accept(conn));
    peer.on('disconnected', () => { if (!this.closed) { try { peer.reconnect(); } catch { /* */ } } });
    peer.on('error', (err) => console.warn('[host] peer error', err?.type, err?.message));
    this.timer = setInterval(() => {
      const now = performance.now();
      for (const [cid, e] of this.conns) {
        if (now - e.last > CONFIG.NET.CLIENT_TIMEOUT) this.kick(cid);
        else this.send(cid, { t: 'hb' });          // heartbeat: "I'm still here" even if the game loop is paused
      }
    }, 2000);
  }

  _accept(conn) {
    const setup = () => {
      const cid = this.nextCid++;
      const entry = { conn, last: performance.now(), pieces: new Map() };
      this.conns.set(cid, entry);
      conn.on('data', (d) => {
        entry.last = performance.now();
        const m = d && typeof d === 'object' ? unpack(entry.pieces, d) : null;
        if (m && typeof m === 'object') this.emit('message', cid, m);
      });
      const drop = () => {
        if (!this.conns.has(cid)) return;
        this.conns.delete(cid);
        this.emit('leave', cid);
      };
      conn.on('close', drop);
      conn.on('error', drop);
      this.emit('join', cid);
    };
    if (conn.open) setup(); else conn.on('open', setup);
  }

  send(cid, msg, str = null) {
    const e = this.conns.get(cid);
    if (!e || !e.conn.open) return;
    sendPacked(e.conn, msg, str);
  }

  broadcast(msg, exceptCid = null) {
    if (!this.conns.size) return;
    const str = JSON.stringify(msg);
    for (const [cid] of this.conns) if (cid !== exceptCid) this.send(cid, msg, str);
  }

  kick(cid) {
    const e = this.conns.get(cid);
    if (!e) return;
    this.conns.delete(cid);
    try { e.conn.close(); } catch { /* */ }
    this.emit('leave', cid);
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const [, e] of this.conns) { try { e.conn.close(); } catch { /* */ } }
    this.conns.clear();
    try { this.peer.destroy(); } catch { /* */ }
  }
}

// ---------------------------------------------------------------------
//  CLIENT
// ---------------------------------------------------------------------
export class NetClient extends Emitter {
  // Connect to a host id. Rejects with {type:'unavailable'} if nobody hosts it.
  static async connect(hostId) {
    const peer = await createPeer(null);
    const conn = await connectWith(peer, hostId).catch((e) => { try { peer.destroy(); } catch { /* */ } throw e; });
    return new NetClient(peer, conn);
  }

  constructor(peer, conn) {
    super();
    this.peer = peer;
    this.conn = conn;
    this.closed = false;
    this.last = performance.now();
    this.pieces = new Map();
    conn.on('data', (d) => {
      this.last = performance.now();
      const m = d && typeof d === 'object' ? unpack(this.pieces, d) : null;
      if (m && typeof m === 'object') this.emit('message', m);
    });
    const lost = (why) => { if (this.closed) return; this.closed = true; this.emit('close', why); };
    conn.on('close', () => lost('closed'));
    conn.on('error', () => lost('error'));
    // heartbeat once a second, whatever the game is doing (spectating, dead, blindfolded seekers send no
    // movement; without this the host thought they had left after 12 s and dropped them)
    this.timer = setInterval(() => {
      if (performance.now() - this.last > CONFIG.NET.HOST_TIMEOUT) lost('timeout');
      else this.send({ t: 'hb' });
    }, 1000);
  }

  send(msg) {
    if (this.closed || !this.conn.open) return;
    sendPacked(this.conn, msg);
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    try { this.conn.close(); } catch { /* */ }
    try { this.peer.destroy(); } catch { /* */ }
  }
}

// Open a data connection from an existing peer, with timeout + "no such host" detection
function connectWith(peer, hostId, timeout = CONFIG.NET.CONNECT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let done = false;
    const conn = peer.connect(hostId, { reliable: true, serialization: 'json' });
    const finish = (err) => {
      if (done) return; done = true;
      clearTimeout(timer);
      peer.off?.('error', onErr);
      if (err) { try { conn.close(); } catch { /* */ } reject(err); } else resolve(conn);
    };
    const onErr = (err) => {
      const msg = String(err?.message || '');
      if (err?.type === 'peer-unavailable' && (!msg || msg.includes(hostId))) finish({ type: 'unavailable', message: 'Server not found' });
      else if (err?.type === 'network' || err?.type === 'server-error' || err?.type === 'socket-error') finish({ type: 'network', message: msg });
    };
    const timer = setTimeout(() => finish({ type: 'unavailable', message: 'Server did not answer' }), timeout);
    peer.on('error', onErr);
    conn.on('open', () => finish(null));
    conn.on('error', () => finish({ type: 'unavailable', message: 'Connection failed' }));
  });
}

// Ask every public slot for its info. Returns [{slot, id, info|null}]
export async function probePublicServers(onProgress) {
  const peer = await createPeer(null);
  const slots = [];
  for (let i = 1; i <= CONFIG.NET.PUBLIC_SLOTS; i++) slots.push(i);
  const results = await Promise.all(slots.map(async (slot) => {
    const id = publicId(slot);
    try {
      const conn = await connectWith(peer, id, 4000);
      const info = await new Promise((res) => {
        const t = setTimeout(() => res(null), 2000);
        conn.on('data', (d) => { if (d && d.t === 'info') { clearTimeout(t); res(d); } });
        conn.send({ t: 'info' });
      });
      try { conn.close(); } catch { /* */ }
      const r = { slot, id, info };
      onProgress?.(r);
      return r;
    } catch {
      const r = { slot, id, info: null };
      onProgress?.(r);
      return r;
    }
  }));
  setTimeout(() => { try { peer.destroy(); } catch { /* */ } }, 500);
  return results;
}

// =====================================================================
//  LocalPeer — tiny PeerJS look-alike over BroadcastChannel (?local=1)
//  Lets you test multiplayer with several tabs on one computer, offline.
// =====================================================================
class LocalPeer extends Emitter {
  constructor(id) {
    super();
    if (typeof id !== 'string') id = null;
    this.id = id || 'local-' + Math.random().toString(36).slice(2, 10);
    this.bc = new BroadcastChannel('gmm-local-net');
    this.conns = new Map();
    this.open = false;
    this.nonce = Math.random();
    this.bc.onmessage = (e) => this._msg(e.data);
    this.bc.postMessage({ k: 'claim', id: this.id, nonce: this.nonce });
    this._claim = setTimeout(() => { this.open = true; this.emit('open', this.id); }, 150);
  }
  _msg(m) {
    if (!m) return;
    switch (m.k) {
      case 'claim': if (m.id === this.id && this.open) this.bc.postMessage({ k: 'taken', id: m.id, nonce: m.nonce }); break;
      case 'taken': if (m.nonce === this.nonce && !this.open) { clearTimeout(this._claim); this.emit('error', { type: 'unavailable-id', message: 'ID taken' }); } break;
      case 'req': if (m.to === this.id && this.open) {
        const c = new LocalConn(this, m.from, m.cid);
        this.conns.set(m.cid, c);
        this.emit('connection', c);
        this.bc.postMessage({ k: 'ack', to: m.from, cid: m.cid });
        setTimeout(() => c._open(), 0);
      } break;
      case 'ack': if (m.to === this.id) this.conns.get(m.cid)?._open(); break;
      case 'data': if (m.to === this.id) { const c = this.conns.get(m.cid); if (c && c.open) c.emit('data', m.d); } break;
      case 'close': if (m.to === this.id) this.conns.get(m.cid)?._closed(); break;
      default: break;
    }
  }
  connect(id) {
    const cid = Math.random().toString(36).slice(2);
    const c = new LocalConn(this, id, cid);
    this.conns.set(cid, c);
    this.bc.postMessage({ k: 'req', to: id, from: this.id, cid });
    c._timer = setTimeout(() => {
      if (!c.open) { this.conns.delete(cid); this.emit('error', { type: 'peer-unavailable', message: 'Could not connect to peer ' + id }); }
    }, 500);
    return c;
  }
  reconnect() {}
  destroy() {
    for (const c of [...this.conns.values()]) c.close();
    try { this.bc.close(); } catch { /* */ }
  }
}

class LocalConn extends Emitter {
  constructor(peer, remote, cid) { super(); this.peer = peer; this.remote = remote; this.cid = cid; this.open = false; }
  _open() { if (!this.open) { this.open = true; clearTimeout(this._timer); this.emit('open'); } }
  send(d) {
    if (!this.open) return;
    // JSON round trip so local mode behaves like the real network (no shared object references)
    this.peer.bc.postMessage({ k: 'data', to: this.remote, cid: this.cid, d: JSON.parse(JSON.stringify(d)) });
  }
  close() {
    if (this.open) { try { this.peer.bc.postMessage({ k: 'close', to: this.remote, cid: this.cid }); } catch { /* */ } }
    this._closed();
  }
  _closed() {
    this.peer.conns.delete(this.cid);
    if (this.open) { this.open = false; this.emit('close'); }
  }
}
