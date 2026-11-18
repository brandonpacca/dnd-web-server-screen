// Server HTTP + WebSocket.
//
//   REST  /api/...   creazione stanze, ingresso giocatori, lettura stato, azioni
//   WS    /ws        canale in tempo reale (stato + eventi di combattimento)
//   GET   /client.js SDK per browser da includere negli schermi GM e giocatore

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ActionError, ACTION_TYPES } from './combat.js';
import { RoomManager } from './rooms.js';
import { buildView, visibleEvents } from './views.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_JS = path.join(__dirname, '..', 'public', 'dnd-combat-client.js');
const MAX_BODY = 512 * 1024;
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function parseOrigins(value) {
  if (!value || value === '*') return '*';
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function originAllowed(allowed, origin) {
  if (allowed === '*' || !origin) return true;
  return allowed.includes(origin);
}

function bearer(req, url) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return url.searchParams.get('token');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ActionError('too_large', 'Richiesta troppo grande'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ActionError('invalid', 'JSON non valido')); }
    });
    req.on('error', reject);
  });
}

const STATUS = { invalid: 400, unknown_action: 400, too_large: 413, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, limit: 429 };

export function createServer({
  dataDir = null,
  allowedOrigins = '*',
  roomTtlMs = 30 * 24 * 3600 * 1000,
  heartbeatMs = 30000,
  allowRoomCreation = true
} = {}) {
  const origins = parseOrigins(allowedOrigins);
  const manager = new RoomManager({ dataDir, ttlMs: roomTtlMs });

  // ---------- broadcast ----------

  function sendTo(client, room, events) {
    const evts = visibleEvents(events, client.role);
    client.send({ type: 'state', state: buildView(room, client.role, client.playerId) });
    if (evts.length) client.send({ type: 'events', events: evts });
  }

  manager.onRoomChange((room, events) => {
    for (const client of room.clients) sendTo(client, room, events);
  });

  // ---------- HTTP ----------

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origins === '*') res.setHeader('Access-Control-Allow-Origin', '*');
    else if (origin && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function fail(res, err) {
    if (err instanceof ActionError) return json(res, STATUS[err.code] || 400, { ok: false, error: err.code, message: err.message });
    console.error(err);
    return json(res, 500, { ok: false, error: 'internal', message: 'Errore interno' });
  }

  function auth(room, req, url) {
    const actor = room.authenticate(bearer(req, url));
    if (!actor) throw new ActionError('unauthorized', 'Token mancante o non valido');
    return actor;
  }

  async function handle(req, res) {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json(res, 200, { ok: true, name: PKG.name, version: PKG.version, rooms: manager.rooms.size, actions: ACTION_TYPES });
    }
    if (req.method === 'GET' && (url.pathname === '/client.js' || url.pathname === '/dnd-combat-client.js')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return fs.createReadStream(CLIENT_JS).pipe(res);
    }

    if (parts[0] !== 'api' || parts[1] !== 'rooms') return json(res, 404, { ok: false, error: 'not_found', message: 'Risorsa non trovata' });

    // POST /api/rooms  -> crea una stanza (GM)
    if (parts.length === 2 && req.method === 'POST') {
      if (!allowRoomCreation) throw new ActionError('forbidden', 'Creazione stanze disabilitata');
      const body = await readJson(req);
      const { room, gmToken } = manager.create(body.name);
      if (body.state) room.dispatch({ type: 'state.import', state: body.state }, { role: 'gm' });
      return json(res, 201, { ok: true, code: room.code, name: room.name, gmToken });
    }

    const room = manager.get(parts[2]);
    if (!room) throw new ActionError('not_found', 'Stanza inesistente');

    // GET /api/rooms/:code -> info pubbliche
    if (parts.length === 3 && req.method === 'GET') {
      return json(res, 200, { ok: true, code: room.code, name: room.name, players: room.players.size, gmOnline: room.isOnline('gm') });
    }
    // DELETE /api/rooms/:code -> elimina (GM)
    if (parts.length === 3 && req.method === 'DELETE') {
      if (auth(room, req, url).role !== 'gm') throw new ActionError('forbidden', 'Solo il GM può eliminare la stanza');
      manager.delete(room.code);
      return json(res, 200, { ok: true });
    }
    // POST /api/rooms/:code/players -> un giocatore entra al tavolo
    if (parts.length === 4 && parts[3] === 'players' && req.method === 'POST') {
      const body = await readJson(req);
      const { token, player } = room.addPlayer(body.name);
      let events = [];
      if (body.party) {
        events = room.dispatch({ type: 'pc.claim', party: body.party }, { role: 'player', playerId: player.id, name: player.name });
      }
      return json(res, 201, { ok: true, token, playerId: player.id, events });
    }
    // DELETE /api/rooms/:code/players/:id -> il GM rimuove un giocatore
    if (parts.length === 5 && parts[3] === 'players' && req.method === 'DELETE') {
      if (auth(room, req, url).role !== 'gm') throw new ActionError('forbidden', 'Azione riservata al GM');
      if (!room.removePlayer(parts[4])) throw new ActionError('not_found', 'Giocatore inesistente');
      return json(res, 200, { ok: true });
    }
    // GET /api/rooms/:code/state -> vista dello stato per il ruolo del token
    if (parts.length === 4 && parts[3] === 'state' && req.method === 'GET') {
      const actor = auth(room, req, url);
      return json(res, 200, { ok: true, role: actor.role, state: buildView(room, actor.role, actor.playerId) });
    }
    // GET /api/rooms/:code/log -> ultimi eventi
    if (parts.length === 4 && parts[3] === 'log' && req.method === 'GET') {
      const actor = auth(room, req, url);
      return json(res, 200, { ok: true, events: visibleEvents(room.log, actor.role) });
    }
    // POST /api/rooms/:code/actions -> esegue un'azione (alternativa al WebSocket)
    if (parts.length === 4 && parts[3] === 'actions' && req.method === 'POST') {
      const actor = auth(room, req, url);
      const action = await readJson(req);
      const events = room.dispatch(action, actor);
      return json(res, 200, { ok: true, version: room.version, events: visibleEvents(events, actor.role) });
    }
    return json(res, 404, { ok: false, error: 'not_found', message: 'Risorsa non trovata' });
  }

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((err) => fail(res, err));
  });

  // ---------- WebSocket ----------
  //
  // Protocollo (JSON):
  //   client -> { type: 'hello', room, token }                  riconnessione con token
  //   client -> { type: 'hello', room, name, party? }           nuovo giocatore
  //   client -> { type: 'action', id?, action: { type, ... } }  esegue un'azione
  //   client -> { type: 'ping' }
  //   server -> { type: 'welcome', role, room, playerId?, token? }
  //   server -> { type: 'state', state }                        dopo ogni modifica
  //   server -> { type: 'events', events }                      eventi del log
  //   server -> { type: 'ack', id, ok, error?, message? }
  //   server -> { type: 'error', error, message }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BODY
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws' || !originAllowed(origins, req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let room = null;
    let client = null;
    const send = (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
    const error = (code, message, id) => send(id !== undefined ? { type: 'ack', id, ok: false, error: code, message } : { type: 'error', error: code, message });

    const helloTimer = setTimeout(() => { if (!client) ws.close(4001, 'hello mancante'); }, 15000);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return error('invalid', 'JSON non valido'); }
      if (!msg || typeof msg !== 'object') return error('invalid', 'Messaggio non valido');

      if (msg.type === 'ping') return send({ type: 'pong', serverTime: Date.now() });

      if (msg.type === 'hello') {
        if (client) return error('invalid', 'Già autenticato');
        const r = manager.get(msg.room);
        if (!r) { error('not_found', 'Stanza inesistente'); return ws.close(4004, 'Stanza inesistente'); }
        let actor = null;
        let newToken = null;
        try {
          if (msg.token) {
            actor = r.authenticate(msg.token);
            if (!actor) { error('unauthorized', 'Token non valido'); return ws.close(4001, 'Token non valido'); }
          } else {
            const { token, player } = r.addPlayer(msg.name);
            actor = { role: 'player', playerId: player.id, name: player.name };
            newToken = token;
          }
        } catch (err) {
          error(err.code || 'invalid', err.message);
          return ws.close(4000, 'hello non valido');
        }
        clearTimeout(helloTimer);
        room = r;
        client = { ...actor, send, close: (code, reason) => ws.close(code, reason) };
        room.clients.add(client);
        send({ type: 'welcome', role: actor.role, room: { code: room.code, name: room.name }, playerId: actor.playerId, ...(newToken ? { token: newToken } : {}) });
        send({ type: 'events', events: visibleEvents(room.log.slice(-50), actor.role), history: true });
        if (msg.party && actor.role === 'player') {
          try { room.dispatch({ type: 'pc.claim', party: msg.party }, actor); } catch (err) { error(err.code || 'invalid', err.message); }
        }
        // presenza aggiornata per tutti (incluso il nuovo client)
        for (const c of room.clients) c.send({ type: 'state', state: buildView(room, c.role, c.playerId) });
        return;
      }

      if (!client) return error('unauthorized', 'Invia prima un messaggio hello');

      if (msg.type === 'action') {
        try {
          const events = room.dispatch(msg.action, client);
          if (msg.id !== undefined) send({ type: 'ack', id: msg.id, ok: true, version: room.version });
          return events;
        } catch (err) {
          if (!(err instanceof ActionError)) console.error(err);
          return error(err.code || 'internal', err instanceof ActionError ? err.message : 'Errore interno', msg.id);
        }
      }

      if (msg.type === 'sync') return send({ type: 'state', state: buildView(room, client.role, client.playerId) });

      return error('invalid', `Tipo di messaggio sconosciuto: ${msg.type}`, msg.id);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (room && client) {
        room.clients.delete(client);
        for (const c of room.clients) c.send({ type: 'state', state: buildView(room, c.role, c.playerId) });
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  const sweeper = setInterval(() => manager.sweep(), 3600 * 1000);
  heartbeat.unref();
  sweeper.unref();

  function close() {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    for (const ws of wss.clients) ws.terminate();
    manager.flush();
    return new Promise((resolve) => wss.close(() => httpServer.close(() => resolve())));
  }

  return { httpServer, wss, manager, close };
}
