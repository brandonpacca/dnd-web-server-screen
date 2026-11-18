// Stanze di gioco: una per tavolo. Ogni stanza ha un codice breve da comunicare ai
// giocatori, un token segreto del GM e un token per ogni giocatore. Lo stato viene
// salvato su disco in JSON (un file per stanza) così sopravvive ai riavvii.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ActionError, applyAction, defaultCombatState, makeNpc, makePc } from './combat.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // senza 0/O/1/I
const LOG_LIMIT = 200;
const MAX_PLAYERS = 30;

export function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function newCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export class Room {
  constructor({ code, name, gmTokenHash, createdAt, updatedAt, version, state, log, players }) {
    this.code = code;
    this.name = name || '';
    this.gmTokenHash = gmTokenHash;
    this.createdAt = createdAt || Date.now();
    this.updatedAt = updatedAt || this.createdAt;
    this.version = version || 0;
    this.state = state || defaultCombatState();
    this.log = log || [];
    // tokenHash -> { id, name, tokenHash }
    this.players = new Map((players || []).map((p) => [p.tokenHash, p]));
    // connessioni attive: Set di { role, playerId, send(msg) }
    this.clients = new Set();
    this.onChange = null;
  }

  static restore(json) {
    const def = defaultCombatState();
    const s = json.state || {};
    const state = {
      ...def,
      ...s,
      time: { ...def.time, ...(s.time || {}) },
      settings: { ...def.settings, ...(s.settings || {}) },
      initiative: { ...def.initiative, ...(s.initiative || {}) },
      party: (s.party || []).map(makePc),
      npcs: (s.npcs || []).map(makeNpc)
    };
    return new Room({ ...json, state });
  }

  toJSON() {
    return {
      code: this.code,
      name: this.name,
      gmTokenHash: this.gmTokenHash,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      version: this.version,
      state: this.state,
      log: this.log,
      players: [...this.players.values()]
    };
  }

  // Restituisce l'attore corrispondente al token, o null.
  authenticate(token) {
    if (!token) return null;
    const h = hashToken(token);
    if (safeEqualHex(h, this.gmTokenHash)) return { role: 'gm', playerId: null };
    const p = this.players.get(h);
    return p ? { role: 'player', playerId: p.id, name: p.name } : null;
  }

  addPlayer(name) {
    if (this.players.size >= MAX_PLAYERS) throw new ActionError('limit', `Massimo ${MAX_PLAYERS} giocatori per stanza`);
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) throw new ActionError('invalid', 'Nome del giocatore mancante');
    const token = newToken();
    const player = { id: 'p' + crypto.randomBytes(6).toString('hex'), name: clean, tokenHash: hashToken(token) };
    this.players.set(player.tokenHash, player);
    this.touch([{ type: 'player-join', text: `${clean} si è unito al tavolo`, data: { playerId: player.id } }]);
    return { token, player };
  }

  removePlayer(playerId) {
    for (const [h, p] of this.players) {
      if (p.id === playerId) {
        this.players.delete(h);
        this.state.party.forEach((pc) => { if (pc.playerId === playerId) pc.playerId = null; });
        for (const c of this.clients) if (c.playerId === playerId) c.close?.(4003, 'Rimosso dal GM');
        this.touch([{ type: 'player-leave', text: `${p.name} è stato rimosso dal tavolo`, data: { playerId } }]);
        return true;
      }
    }
    return false;
  }

  isOnline(id) {
    for (const c of this.clients) {
      if (id === 'gm' ? c.role === 'gm' : c.playerId === id) return true;
    }
    return false;
  }

  // Esegue un'azione in modo transazionale: se fallisce lo stato resta invariato.
  dispatch(action, actor) {
    const draft = structuredClone(this.state);
    const raw = applyAction(draft, action, actor);
    this.state = draft;
    const actorName = actor.role === 'gm' ? 'GM' : (actor.name || 'Giocatore');
    const events = raw.map((e) => ({ ...e, actor: { role: actor.role, playerId: actor.playerId || null, name: actorName } }));
    this.touch(events);
    return events;
  }

  touch(rawEvents = []) {
    const now = Date.now();
    this.version++;
    this.updatedAt = now;
    const events = rawEvents.map((e) => ({ id: crypto.randomBytes(6).toString('hex'), ts: now, data: {}, ...e }));
    this.log.push(...events);
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    if (this.onChange) this.onChange(this, events);
    return events;
  }
}

export class RoomManager {
  constructor({ dataDir = null, ttlMs = 30 * 24 * 3600 * 1000, saveDelayMs = 300 } = {}) {
    this.rooms = new Map();
    this.dataDir = dataDir;
    this.ttlMs = ttlMs;
    this.saveDelayMs = saveDelayMs;
    this.pendingSaves = new Map();
    this.listeners = new Set();
    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      this.loadAll();
    }
  }

  onRoomChange(fn) {
    this.listeners.add(fn);
  }

  attach(room) {
    room.onChange = (r, events) => {
      this.scheduleSave(r);
      for (const fn of this.listeners) fn(r, events);
    };
    this.rooms.set(room.code, room);
    return room;
  }

  create(name) {
    let code;
    do { code = newCode(); } while (this.rooms.has(code));
    const gmToken = newToken();
    const room = this.attach(new Room({ code, name: String(name || '').trim().slice(0, 80), gmTokenHash: hashToken(gmToken) }));
    this.scheduleSave(room);
    return { room, gmToken };
  }

  get(code) {
    return this.rooms.get(String(code || '').toUpperCase()) || null;
  }

  delete(code) {
    const room = this.get(code);
    if (!room) return false;
    for (const c of room.clients) c.close?.(4004, 'Stanza eliminata');
    this.rooms.delete(room.code);
    if (this.dataDir) {
      clearTimeout(this.pendingSaves.get(room.code));
      this.pendingSaves.delete(room.code);
      fs.rmSync(this.fileFor(room.code), { force: true });
    }
    return true;
  }

  fileFor(code) {
    return path.join(this.dataDir, `${code}.json`);
  }

  loadAll() {
    for (const f of fs.readdirSync(this.dataDir)) {
      if (!/^[A-Z0-9]+\.json$/.test(f)) continue;
      try {
        const json = JSON.parse(fs.readFileSync(path.join(this.dataDir, f), 'utf8'));
        this.attach(Room.restore(json));
      } catch (err) {
        console.error(`Impossibile caricare la stanza ${f}:`, err.message);
      }
    }
  }

  scheduleSave(room) {
    if (!this.dataDir) return;
    clearTimeout(this.pendingSaves.get(room.code));
    this.pendingSaves.set(room.code, setTimeout(() => this.saveNow(room), this.saveDelayMs));
  }

  saveNow(room) {
    if (!this.dataDir || !this.rooms.has(room.code)) return;
    this.pendingSaves.delete(room.code);
    const file = this.fileFor(room.code);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(room));
    fs.renameSync(tmp, file);
  }

  flush() {
    for (const [code, timer] of this.pendingSaves) {
      clearTimeout(timer);
      const room = this.rooms.get(code);
      if (room) this.saveNow(room);
    }
    this.pendingSaves.clear();
  }

  // Elimina le stanze inattive da più di ttlMs e senza client collegati.
  sweep(now = Date.now()) {
    let removed = 0;
    for (const room of [...this.rooms.values()]) {
      if (room.clients.size === 0 && now - room.updatedAt > this.ttlMs) {
        this.delete(room.code);
        removed++;
      }
    }
    return removed;
  }
}
