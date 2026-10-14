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
const ADMIN_PIN = String(process.env.ADMIN_PIN || ''); // optional: only this PIN may change the question bank
// Normally the game files live in ./public. If they were uploaded flat (no public folder), serve just those two files from here.
const HAS_PUBLIC = fs.existsSync(path.join(__dirname, 'public', 'index.html'));
const PUB = HAS_PUBLIC ? path.join(__dirname, 'public') : __dirname;
const FLAT_OK = new Set(['/index.html', '/shim.js']);
const TICK_MS = 200;          // how often changes are batched and sent
const MAX_ROOM = 120;         // players per class code
const MAX_CLIENTS = 600;      // whole server
const MAX_PRES_BYTES = 700;
const MAX_BANK_BYTES = 250000;
// Optional free online store (Upstash Redis REST) so the teacher's questions survive restarts and work on any computer.
const UP_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const STORE = !!(UP_URL && UP_TOKEN);
let globalBank = null;
async function upstash(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('store answered ' + r.status);
  return (await r.json()).result;
}
async function loadStore() {
  if (!STORE) return;
  try {
    const v = await upstash(['GET', 'bz:bank']);
    if (v) { const b = JSON.parse(v); if (b && typeof b === 'object') { globalBank = b; console.log('Question bank loaded from the online store'); } }
    else console.log('Online store connected (no saved questions yet)');
  } catch (e) { console.warn('Could not read the online store:', e.message); }
}
async function saveStore(b) {
  if (!STORE) return false;
  try { await upstash(['SET', 'bz:bank', JSON.stringify(b)]); return true; }
  catch (e) { console.warn('Could not save to the online store:', e.message); return false; }
}

if (!PIN && !ADMIN_PIN) console.warn('WARNING: TEACHER_PIN is not set. Nobody can use teacher mode until you set it.');
if (!ADMIN_PIN) console.warn('Note: ADMIN_PIN is not set, so anyone with the teacher PIN can also change the question bank.');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && String(req.url).split('?')[0] === '/auth') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      let pin = '';
      try { pin = String(JSON.parse(body).pin || ''); } catch (e) {}
      const r = checkPin(ipOf(req), pin);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ teacher: r.admin, owner: r.owner, wait: r.wait }));
    });
    return;
  }
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  if (p === '/bank') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ bank: globalBank })); }
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

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 262144 });
const rooms = new Map(); // code -> { clients:Set, dirty:Map(id->pres), left:Set(id) }
let total = 0;

function eqPin(given, secret) {
  if (!secret) return false;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}
// Slow down PIN guessing: after 5 wrong tries from one address, only one try per 15 seconds.
const tries = new Map();
function ipOf(req) { const f = req.headers['x-forwarded-for']; return (f ? String(f).split(',')[0].trim() : req.socket.remoteAddress) || '?'; }
function checkPin(ip, given) {
  const none = { admin: false, owner: false, wait: false };
  if (!given) return none;
  const now = Date.now();
  let t = tries.get(ip);
  if (t && now - t.first > 300000) { tries.delete(ip); t = null; }
  if (t && t.fails >= 5 && now - t.last < 15000) return { admin: false, owner: false, wait: true };
  const isOwnerPin = eqPin(given, ADMIN_PIN);
  const isTeacherPin = eqPin(given, PIN);
  if (!isOwnerPin && !isTeacherPin) {
    if (!t) { t = { fails: 0, first: now, last: now }; tries.set(ip, t); }
    t.fails++; t.last = now;
    return none;
  }
  tries.delete(ip);
  return { admin: true, owner: ADMIN_PIN ? isOwnerPin : true, wait: false };
}
setInterval(() => { const now = Date.now(); tries.forEach((v, k) => { if (now - v.first > 300000) tries.delete(k); }); }, 60000);
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

wss.on('connection', (ws, req) => {
  ws.ip = ipOf(req);
  ws.isAlive = true;
  ws.room = null;
  ws.lastPres = 0;
  ws.pend = null;
  ws.evCount = 0;
  ws.evWin = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    if (raw.length > 2048 && !ws.admin) return; // only the teacher may send big messages (question bank)
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'join') {
      if (ws.room) return;
      const code = String(m.room || '');
      if (!/^[a-z0-9]{1,12}$/.test(code)) { send(ws, { t: 'err', c: 'bad_room' }); return; }
      if (total >= MAX_CLIENTS) { send(ws, { t: 'err', c: 'server_full' }); return; }
      let room = rooms.get(code);
      if (!room) { room = { code, clients: new Set(), dirty: new Map(), left: new Set(), round: '', bank: globalBank }; rooms.set(code, room); }
      if (room.clients.size >= MAX_ROOM) { send(ws, { t: 'err', c: 'room_full' }); return; }
      ws.id = crypto.randomBytes(5).toString('hex');
      const rl = checkPin(ws.ip, m.pin);
      ws.admin = rl.admin;
      ws.owner = rl.owner;
      ws.room = room;
      room.clients.add(ws);
      total++;
      const full = [];
      room.clients.forEach(c => { if (c !== ws && c.pres) full.push([c.id, c.pres]); });
      send(ws, { t: 'welcome', id: ws.id, admin: ws.admin, wantedAdmin: !!m.pin, wait: rl.wait, owner: ws.owner, round: room.round, bank: room.bank, store: STORE });
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
    if (m.t === 'kick' || m.t === 'kickall') {
      if (!ws.admin) { send(ws, { t: 'err', c: 'not_permitted', topic: m.t }); return; }
      const targets = [];
      ws.room.clients.forEach((c) => { if (c !== ws && !c.admin && (m.t === 'kickall' || c.id === String(m.id))) targets.push(c); });
      targets.forEach((c) => {
        send(c, { t: 'kicked', reason: m.t === 'kickall' ? 'end' : 'kick' });
        setTimeout(() => { try { c.close(4001, 'removed by teacher'); } catch (e) {} }, 200);
      });
      send(ws, { t: 'kickok', n: targets.length });
      return;
    }
    if (m.t === 'bank') {
      if (!ws.owner) { send(ws, { t: 'err', c: 'not_permitted', topic: 'bank' }); return; }
      const nowb = Date.now();
      if (ws.lastBank && nowb - ws.lastBank < 1500) return;
      ws.lastBank = nowb;
      if (!m.b || typeof m.b !== 'object' || JSON.stringify(m.b).length > MAX_BANK_BYTES) return;
      globalBank = m.b;
      rooms.forEach((rm) => { rm.bank = m.b; sendRoom(rm, { t: 'bank', b: m.b }); });
      saveStore(m.b).then((ok) => send(ws, { t: 'bankok', ok, store: STORE }));
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
      } else if (m.topic === 'round') {
        const id = String(m.data && m.data.id || '');
        if (/^[a-z0-9]{1,24}$/.test(id)) { ws.room.round = id; sendRoom(ws.room, { t: 'ev', topic: 'round', data: { id }, from: ws.id }); }
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

loadStore().then(() => server.listen(PORT, () => console.log('Buzz Off Garden running on port ' + PORT + (STORE ? ' (online question store on)' : ' (no online store)'))));
