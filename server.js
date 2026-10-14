'use strict';
// Buzz Off Garden: tiny live-room server. Serves the game and relays class rooms over WebSocket.
// Run: TEACHER_PIN=yourpin node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PIN = String(process.env.TEACHER_PIN || '');
// Normally the game files live in ./public. If they were uploaded flat (no public folder), serve just those two files from here.
const HAS_PUBLIC = fs.existsSync(path.join(__dirname, 'public', 'index.html'));
const PUB = HAS_PUBLIC ? path.join(__dirname, 'public') : __dirname;
const FLAT_OK = new Set(['/index.html', '/shim.js']);
const TICK_MS = 200;          // how often changes are batched and sent
const MAX_ROOM = 120;         // players per class code
const MAX_CLIENTS = 600;      // whole server
const MAX_PRES_BYTES = 700;

if (!PIN) console.warn('WARNING: TEACHER_PIN is not set. Nobody can use teacher mode until you set it.');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  if (p === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  if (!HAS_PUBLIC && !FLAT_OK.has(p)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  const f = path.normalize(path.join(PUB, p));
  if (!f.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
const rooms = new Map(); // code -> { clients:Set, dirty:Map(id->pres), left:Set(id) }
let total = 0;

function pinOk(given) {
  if (!PIN) return false;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(PIN).digest();
  return crypto.timingSafeEqual(a, b);
}
function send(ws, obj) { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} } }
function sendRoom(room, obj) { const s = JSON.stringify(obj); room.clients.forEach(c => { if (c.readyState === 1) { try { c.send(s); } catch (e) {} } }); }
function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws);
  room.dirty.delete(ws.id);
  room.left.add(ws.id);
  ws.room = null;
  total = Math.max(0, total - 1);
  if (!room.clients.size) rooms.delete(room.code);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.lastPres = 0;
  ws.pend = null;
  ws.evCount = 0;
  ws.evWin = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'join') {
      if (ws.room) return;
      const code = String(m.room || '');
      if (!/^[a-z0-9]{1,12}$/.test(code)) { send(ws, { t: 'err', c: 'bad_room' }); return; }
      if (total >= MAX_CLIENTS) { send(ws, { t: 'err', c: 'server_full' }); return; }
      let room = rooms.get(code);
      if (!room) { room = { code, clients: new Set(), dirty: new Map(), left: new Set() }; rooms.set(code, room); }
      if (room.clients.size >= MAX_ROOM) { send(ws, { t: 'err', c: 'room_full' }); return; }
      ws.id = crypto.randomBytes(5).toString('hex');
      ws.admin = !!m.pin && pinOk(m.pin);
      ws.room = room;
      room.clients.add(ws);
      total++;
      const full = [];
      room.clients.forEach(c => { if (c !== ws && c.pres) full.push([c.id, c.pres]); });
      send(ws, { t: 'welcome', id: ws.id, admin: ws.admin, wantedAdmin: !!m.pin });
      send(ws, { t: 'full', u: full });
      return;
    }
    if (!ws.room) return;
    if (m.t === 'pres') {
      if (!m.d || typeof m.d !== 'object' || Array.isArray(m.d)) return;
      const s = JSON.stringify(m.d);
      if (s.length > MAX_PRES_BYTES) return;
      ws.pres = m.d;
      ws.room.dirty.set(ws.id, m.d); // newest wins; sent on the next tick
      return;
    }
    if (m.t === 'ev') {
      if (!ws.admin) { send(ws, { t: 'err', c: 'not_permitted', topic: m.topic }); return; }
      const now = Date.now();
      if (now - ws.evWin > 1000) { ws.evWin = now; ws.evCount = 0; }
      if (++ws.evCount > 6) return;
      if (m.topic === 'say') {
        const t = String(m.data && m.data.t || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 140);
        if (t) sendRoom(ws.room, { t: 'ev', topic: 'say', data: { t }, from: ws.id });
      } else if (m.topic === 'goal') {
        const g = Math.round(+(m.data && m.data.per));
        if (g >= 20 && g <= 300) sendRoom(ws.room, { t: 'ev', topic: 'goal', data: { per: g }, from: ws.id });
      }
    }
  });
  ws.on('close', () => leave(ws));
});

// batch presence changes: one small message per room per tick
setInterval(() => {
  rooms.forEach((room) => {
    if (!room.dirty.size && !room.left.size) return;
    const u = [];
    room.dirty.forEach((d, id) => u.push([id, d]));
    const l = Array.from(room.left);
    room.dirty.clear();
    room.left.clear();
    sendRoom(room, { t: 'd', u, l });
  });
}, TICK_MS);

// drop dead connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 25000);

server.listen(PORT, () => console.log('Buzz Off Garden running on port ' + PORT));
