/* ============================================================
   relay-server/server.js
   - A simple WebSocket server (Node.js + ws)
   - Joins 2 parties (extension + editor-app) into one "room"
     keyed by the pairing code
   - Every message arriving from one party is forwarded only to the
     other party in the same room
   ============================================================ */

const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

/* ============================================================
   ONE SINGLE SERVICE — the page (editor-app) + the WebSocket
   ------------------------------------------------------------
   The same server serves both the editor-app files and the
   WebSocket connection. That way you have ONLY ONE domain on Railway,
   and editor-app connects by itself to that same address —
   there is no URL to write down anywhere.
   ============================================================ */

const STATIC_DIR = path.join(__dirname, '..', 'editor-app');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
};

const server = http.createServer((req, res) => {
    // service health (Railway uses it for its check)
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    // never allow escaping the folder (security)
    const filePath = path.join(STATIC_DIR, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ''));
    if (!filePath.startsWith(STATIC_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

// The WebSocket rides on THE SAME server (same port, same domain)
const wss = new WebSocketServer({ server });

// rooms: Map<code, { extension: ws|null, editor: ws|null, pendingExtension: [], pendingEditor: [] }>
const rooms = new Map();

function getOrCreateRoom(code) {
    if (!rooms.has(code)) {
        rooms.set(code, {
            extension: null,
            editor: null,
            extensionOwner: null, // clientId of the device that took this seat
            editorOwner: null,
            pendingExtension: [],
            pendingEditor: [],
        });
    }
    return rooms.get(code);
}

function pendingKeyFor(role) {
    return role === 'extension' ? 'pendingExtension' : 'pendingEditor';
}

function removeFromRoom(code, role) {
    const room = rooms.get(code);
    if (!room) return;

    room[role] = null;
    room[role === 'extension' ? 'extensionOwner' : 'editorOwner'] = null; // the seat is fully released

    // tell the other party (if still there) that the link dropped
    const otherRole = role === 'extension' ? 'editor' : 'extension';
    if (room[otherRole] && room[otherRole].readyState === room[otherRole].OPEN) {
        room[otherRole].send(JSON.stringify({ type: 'peerDisconnected' }));
    }

    // drop the room entirely if nothing is left in it
    if (!room.extension && !room.editor) {
        rooms.delete(code);
    }
}

wss.on('connection', (ws) => {
    let joinedCode = null;
    let joinedRole = null; // 'extension' or 'editor'

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return; // malformed message, ignore it
        }

        /* ---------- REGISTER: join a room ---------- */
        if (msg.type === 'register') {
            const { code, role, clientId } = msg;

            if (!code || (role !== 'extension' && role !== 'editor')) {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid register payload' }));
                return;
            }

            const room = getOrCreateRoom(code);
            const ownerKey = role === 'extension' ? 'extensionOwner' : 'editorOwner';
            const existing = room[role];
            const existingOwner = room[ownerKey];

            // Is this REALLY another device, or just the same one reconnecting?
            // - same clientId   -> a normal refresh/reconnect, replace it
            // - other clientId  -> someone else is using the same code: REFUSE,
            //                      so they cannot take the other one's seat (and page)
            const isOccupiedByOther =
                existing &&
                existing !== ws &&
                existing.readyState === existing.OPEN &&
                existingOwner &&
                clientId &&
                existingOwner !== clientId;

            if (isOccupiedByOther) {
                ws.send(JSON.stringify({
                    type: 'codeTaken',
                    code,
                    role,
                    message: 'This code is already in use by another device',
                }));
                console.log(`Code taken: ${code} (${role}) — another device was refused`);
                return;
            }

            // the same device is reconnecting — close the old link and carry on
            if (existing && existing !== ws && existing.readyState === existing.OPEN) {
                existing.close();
            }

            room[role] = ws;
            room[ownerKey] = clientId || null;
            joinedCode = code;
            joinedRole = role;

            ws.send(JSON.stringify({ type: 'registered', code, role }));

            // send every message that was waiting (stored because this party was
            // still disconnected/waking up when it first tried to arrive)
            const pendingKey = pendingKeyFor(role);
            room[pendingKey].forEach((queuedRaw) => ws.send(queuedRaw));
            room[pendingKey] = [];

            // tell the other party (if present) that the link is up
            const otherRole = role === 'extension' ? 'editor' : 'extension';
            if (room[otherRole]) {
                room[otherRole].send(JSON.stringify({ type: 'peerConnected' }));
                ws.send(JSON.stringify({ type: 'peerConnected' }));
            }

            return;
        }

        /* ---------- FORWARD: send the message to the other party ---------- */
        if (!joinedCode || !joinedRole) {
            ws.send(JSON.stringify({ type: 'error', message: 'Not registered yet' }));
            return;
        }

        const room = rooms.get(joinedCode);
        if (!room) return;

        const targetRole = joinedRole === 'extension' ? 'editor' : 'extension';
        const target = room[targetRole];

        if (target && target.readyState === target.OPEN) {
            target.send(raw.toString());
        } else {
            // the other party is not ready (e.g. a service worker waking up) —
            // store the message, it will be sent automatically once it registers
            room[pendingKeyFor(targetRole)].push(raw.toString());
        }
    });

    ws.on('close', () => {
        if (joinedCode && joinedRole) {
            removeFromRoom(joinedCode, joinedRole);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Infuse — page + WebSocket on port ${PORT}`);
    console.log(`   locally:   http://127.0.0.1:${PORT}`);
});