// language: JavaScript, file: server.js, runtime: Node.js 18+
// DVD Arena — сервер лобби. Без зависимостей.
// Запуск: node server.js  (PORT из env, по умолчанию 3000)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const ROLES = ['semyon', 'gleb', 'vanya', 'danya', 'matvey'];
const MAX_PLAYERS = 8;
const MAX_FRAME = 1024 * 1024;
const CLIENT_IDLE_MS = 90000;   // нет никакой активности от клиента 90 сек -> принудительно закрыть
const PING_EVERY_MS = 25000;

/* ---------- статические файлы ---------- */
const MIME = {
    '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml'
};

const httpServer = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    const name = url === '/' ? 'index.html' : path.basename(url);
    const ext = path.extname(name).toLowerCase();
    if (!MIME[ext]) { res.writeHead(404); return res.end('Not found'); }
    fs.readFile(path.join(ROOT, name), (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-cache' });
        res.end(data);
    });
});

/* ---------- минимальный WebSocket (RFC 6455) ---------- */
function encodeFrame(str, opcode = 0x1) {
    const payload = Buffer.from(str);
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([header, payload]);
}

httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true);
    onConnect(socket);
});

/* ---------- лобби ---------- */
const clients = new Map();   // id -> client
const lobbies = new Map();   // code -> lobby
let nextClientId = 1;

function makeCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (;;) {
        let c = '';
        for (let i = 0; i < 4; i++) c += abc[Math.floor(Math.random() * abc.length)];
        if (!lobbies.has(c)) return c;
    }
}
const cleanName = n => String(n || '').replace(/[<>&"']/g, '').trim().slice(0, 16) || 'Игрок';

function send(c, obj) {
    if (!c || c.closed) return;
    try { c.socket.write(encodeFrame(typeof obj === 'string' ? obj : JSON.stringify(obj))); } catch (e) { /* ignore */ }
}

function lobbyState(l) {
    const roles = {};
    ROLES.forEach(r => { roles[r] = null; });
    l.players.forEach(p => { if (p.role) roles[p.role] = p.id; });
    return {
        t: 'lobby', code: l.code, host: l.host.id, started: l.started,
        players: [...l.players.values()].map(p => ({ id: p.id, name: p.name })),
        roles
    };
}
function broadcastLobby(l) {
    const st = lobbyState(l);
    l.players.forEach(p => send(p, st));
}

function leaveLobby(c) {
    const l = c.lobby;
    if (!l) return;
    c.lobby = null;
    c.role = null;
    if (l.host === c) {
        l.players.forEach(p => { if (p !== c) { p.lobby = null; p.role = null; send(p, { t: 'closed' }); } });
        lobbies.delete(l.code);
    } else {
        l.players.delete(c.id);
        broadcastLobby(l);
    }
}

function handle(c, text) {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    const l = c.lobby;
    switch (m.t) {
        case 'ping': break;
        case 'create': {
            if (l) leaveLobby(c);
            c.name = cleanName(m.name);
            const lobby = { code: makeCode(), host: c, players: new Map(), started: false };
            lobby.players.set(c.id, c); c.lobby = lobby; c.role = null;
            lobbies.set(lobby.code, lobby);
            send(c, { t: 'joined', id: c.id, code: lobby.code, host: true });
            broadcastLobby(lobby);
            break;
        }
        case 'join': {
            if (l) leaveLobby(c);
            const lobby = lobbies.get(String(m.code || '').toUpperCase().trim());
            if (!lobby) return send(c, { t: 'err', m: 'Лобби с таким кодом не найдено' });
            if (lobby.started) return send(c, { t: 'err', m: 'Игра в этом лобби уже идёт' });
            if (lobby.players.size >= MAX_PLAYERS) return send(c, { t: 'err', m: 'Лобби заполнено' });
            c.name = cleanName(m.name);
            lobby.players.set(c.id, c); c.lobby = lobby; c.role = null;
            send(c, { t: 'joined', id: c.id, code: lobby.code, host: false });
            broadcastLobby(lobby);
            break;
        }
        case 'role': {
            if (!l) return;
            const r = m.role;
            if (r === null || r === undefined) c.role = null;
            else if (ROLES.includes(r) && ![...l.players.values()].some(p => p.role === r && p !== c)) c.role = r;
            broadcastLobby(l);
            break;
        }
        case 'start': {
            if (!l || l.host !== c) return;
            l.started = true;
            const st = lobbyState(l);
            l.players.forEach(p => send(p, { t: 'start', roles: st.roles }));
            break;
        }
        case 'input':
            if (l && l.host !== c) send(l.host, { t: 'input', from: c.id, k: m.k });
            break;
        case 'restart':
            if (l && l.host !== c) send(l.host, { t: 'restart' });
            break;
        case 'snap':
            if (l && l.host === c) l.players.forEach(p => { if (p !== c) send(p, text); });
            break;
        case 'leave':
            leaveLobby(c);
            break;
    }
}

function onConnect(socket) {
    const c = {
        id: 'p' + (nextClientId++),
        socket,
        buf: Buffer.alloc(0),
        frag: [],
        name: 'Игрок',
        lobby: null,
        role: null,
        closed: false,
        lastSeen: Date.now()     // heartbeat timestamp
    };
    clients.set(c.id, c);

    const close = () => {
        if (c.closed) return;
        c.closed = true;
        leaveLobby(c);
        clients.delete(c.id);
        try { socket.destroy(); } catch (e) { /* ignore */ }
    };
    socket.on('error', close);
    socket.on('end', close);   // важно: half-close (peer shutdown write)
    socket.on('close', close);
    socket.on('data', chunk => {
        c.lastSeen = Date.now();
        c.buf = Buffer.concat([c.buf, chunk]);
        for (;;) {
            const b = c.buf;
            if (b.length < 2) return;
            const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
            let len = b[1] & 0x7f, off = 2;
            if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
            if (len > MAX_FRAME) return close();
            const total = off + (masked ? 4 : 0) + len;
            if (b.length < total) return;
            const mask = masked ? b.subarray(off, off + 4) : null;
            const start = off + (masked ? 4 : 0);
            const payload = Buffer.from(b.subarray(start, start + len));
            if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
            c.buf = b.subarray(total);

            if (op === 0x8) return close();
            if (op === 0x9) { try { socket.write(encodeFrame(payload.toString(), 0xA)); } catch (e) { /* ignore */ } continue; }
            if (op === 0xA) continue;
            if (op === 0x1 || op === 0x0) {
                c.frag.push(payload);
                if (fin) {
                    const text = Buffer.concat(c.frag).toString('utf8');
                    c.frag = [];
                    try { handle(c, text); } catch (err) { console.error('[handle]', err); }
                }
            }
        }
    });
}

// ping раз в 25 сек + отвал мёртвых клиентов (90 сек без единого фрейма -> закрыть)
setInterval(() => {
    const now = Date.now();
    clients.forEach(c => {
        if (c.closed) return;
        try { c.socket.write(encodeFrame('', 0x9)); } catch (e) { /* ignore */ }
        if (now - c.lastSeen > CLIENT_IDLE_MS) {
            console.warn('[timeout] closing idle client', c.id, 'age', now - c.lastSeen, 'ms');
            c.closed = true;
            leaveLobby(c);
            clients.delete(c.id);
            try { c.socket.destroy(); } catch (e) { /* ignore */ }
        }
    });
}, PING_EVERY_MS);

httpServer.listen(PORT, () => console.log('DVD Arena server: http://localhost:' + PORT));
