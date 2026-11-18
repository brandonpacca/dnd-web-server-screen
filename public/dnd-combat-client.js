/*
 * dnd-combat-client.js — SDK browser per dnd-web-server-screen.
 *
 * Da includere nello Schermo del GM e nello Schermo del Giocatore:
 *
 *   <script src="https://IL-TUO-SERVER/client.js"></script>
 *
 * GM:
 *   DndCombatClient.createRoom('https://server', { name: 'Campagna', state: stateDelGm })
 *     .then(function (r) {
 *       var client = new DndCombatClient({ server: 'https://server', room: r.code, token: r.gmToken });
 *       client.on('state', function (view) { ... });
 *       client.connect();
 *     });
 *
 * Giocatore:
 *   var client = new DndCombatClient({ server: 'https://server', room: 'ABC123', name: 'Marta', party: exportPg.party });
 *   client.on('state', function (view) { ... });
 *   client.connect();
 *   client.act('initiative.set', { cid: view.me.pcIds[0], init: 17 });
 *
 * Il token ricevuto viene salvato nel localStorage, così ricaricando la pagina il
 * giocatore rientra come la stessa persona.
 *
 * Nessuna dipendenza; JavaScript ES5 come gli schermi.
 */
(function (root) {
  'use strict';

  function trimSlash(s) { return String(s || '').replace(/\/+$/, ''); }

  function wsUrl(server) {
    return trimSlash(server).replace(/^http(s?):\/\//i, function (m, s) { return 'ws' + s + '://'; }) + '/ws';
  }

  function request(method, url, body, token) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok || data.ok === false) {
            var err = new Error(data.message || ('HTTP ' + res.status));
            err.code = data.error;
            throw err;
          }
          return data;
        });
      });
  }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try {
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    } catch (e) { /* ignore */ }
  }

  function DndCombatClient(opts) {
    if (!opts || !opts.server || !opts.room) throw new Error('server e room sono obbligatori');
    this.server = trimSlash(opts.server);
    this.room = String(opts.room).toUpperCase();
    this.name = opts.name || '';
    this.party = opts.party || null;
    this.storageKey = opts.storageKey || ('dnd-combat-client:' + this.server + ':' + this.room);
    this.token = opts.token || storageGet(this.storageKey);
    if (opts.token) storageSet(this.storageKey, opts.token);
    this.role = null;
    this.playerId = null;
    this.state = null;
    this.status = 'idle'; // idle | connecting | open | closed
    this._listeners = {};
    this._pending = {};
    this._seq = 0;
    this._retry = 0;
    this._ws = null;
    this._closedByUser = false;
    this._timer = null;
    this._ping = null;
  }

  DndCombatClient.prototype.on = function (event, fn) {
    (this._listeners[event] = this._listeners[event] || []).push(fn);
    return this;
  };

  DndCombatClient.prototype.off = function (event, fn) {
    var l = this._listeners[event] || [];
    this._listeners[event] = l.filter(function (f) { return f !== fn; });
    return this;
  };

  DndCombatClient.prototype._emit = function (event, payload) {
    (this._listeners[event] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { if (root.console) root.console.error(e); }
    });
  };

  DndCombatClient.prototype._setStatus = function (s) {
    this.status = s;
    this._emit('status', s);
  };

  DndCombatClient.prototype.connect = function () {
    var self = this;
    if (self._ws && (self._ws.readyState === 0 || self._ws.readyState === 1)) return self;
    self._closedByUser = false;
    self._setStatus('connecting');
    var ws = new WebSocket(wsUrl(self.server));
    self._ws = ws;

    ws.onopen = function () {
      var hello = { type: 'hello', room: self.room };
      if (self.token) hello.token = self.token;
      else hello.name = self.name || 'Giocatore';
      if (self.party) hello.party = self.party;
      ws.send(JSON.stringify(hello));
      clearInterval(self._ping);
      self._ping = setInterval(function () {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
      }, 25000);
    };

    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      switch (msg.type) {
        case 'welcome':
          self._retry = 0;
          self.role = msg.role;
          self.playerId = msg.playerId || null;
          if (msg.token) {
            self.token = msg.token;
            storageSet(self.storageKey, msg.token);
          }
          self.party = null; // il PG viene reclamato solo al primo ingresso
          self._setStatus('open');
          self._emit('welcome', msg);
          break;
        case 'state':
          self.state = msg.state;
          self._emit('state', msg.state);
          break;
        case 'events':
          self._emit('events', msg.events);
          if (!msg.history) msg.events.forEach(function (ev) { self._emit('event', ev); });
          break;
        case 'ack': {
          var p = self._pending[msg.id];
          if (p) {
            delete self._pending[msg.id];
            if (msg.ok) p.resolve(msg);
            else {
              var err = new Error(msg.message);
              err.code = msg.error;
              p.reject(err);
              self._emit('error', err);
            }
          }
          break;
        }
        case 'error': {
          var e2 = new Error(msg.message);
          e2.code = msg.error;
          if (msg.error === 'unauthorized') {
            // token non più valido: lo dimentichiamo per poter rientrare come nuovo giocatore
            self.token = null;
            storageSet(self.storageKey, null);
          }
          self._emit('error', e2);
          break;
        }
        default:
          break;
      }
    };

    ws.onclose = function (e) {
      clearInterval(self._ping);
      Object.keys(self._pending).forEach(function (id) {
        var err = new Error('Connessione chiusa');
        err.code = 'disconnected';
        self._pending[id].reject(err);
      });
      self._pending = {};
      self._setStatus('closed');
      // 4001 token non valido, 4003 rimosso dal GM, 4004 stanza inesistente: non riprovare
      if (self._closedByUser || e.code === 4001 || e.code === 4003 || e.code === 4004) return;
      var delay = Math.min(15000, 500 * Math.pow(2, self._retry++));
      self._timer = setTimeout(function () { self.connect(); }, delay);
    };

    ws.onerror = function () { /* onclose gestisce la riconnessione */ };
    return self;
  };

  DndCombatClient.prototype.disconnect = function () {
    this._closedByUser = true;
    clearTimeout(this._timer);
    clearInterval(this._ping);
    if (this._ws) this._ws.close();
    return this;
  };

  // Esce dal tavolo dimenticando il token salvato.
  DndCombatClient.prototype.forget = function () {
    this.disconnect();
    this.token = null;
    storageSet(this.storageKey, null);
  };

  // Esegue un'azione sul server. Restituisce una Promise risolta all'ack.
  DndCombatClient.prototype.act = function (type, params) {
    var self = this;
    var action = { type: type };
    Object.keys(params || {}).forEach(function (k) { action[k] = params[k]; });
    return new Promise(function (resolve, reject) {
      if (!self._ws || self._ws.readyState !== 1 || self.status !== 'open') {
        var err = new Error('Non connesso al server');
        err.code = 'disconnected';
        return reject(err);
      }
      var id = ++self._seq;
      self._pending[id] = { resolve: resolve, reject: reject };
      self._ws.send(JSON.stringify({ type: 'action', id: id, action: action }));
    });
  };

  // Scorciatoie per le azioni più comuni
  DndCombatClient.prototype.nextTurn = function () { return this.act('turn.next'); };
  DndCombatClient.prototype.prevTurn = function () { return this.act('turn.prev'); };
  DndCombatClient.prototype.endTurn = function () { return this.act('turn.end'); };
  DndCombatClient.prototype.damage = function (cid, amount, opts) {
    return this.act('hp.damage', { cid: cid, amount: amount, critical: !!(opts && opts.critical), damageType: opts && opts.damageType });
  };
  DndCombatClient.prototype.heal = function (cid, amount) { return this.act('hp.heal', { cid: cid, amount: amount }); };
  DndCombatClient.prototype.setInitiative = function (cid, init) { return this.act('initiative.set', { cid: cid, init: init }); };
  DndCombatClient.prototype.toggleCondition = function (cid, condition, value) {
    return this.act('condition.set', { cid: cid, condition: condition, value: value });
  };
  DndCombatClient.prototype.announceRoll = function (label, total, detail) {
    return this.act('log.roll', { label: label, total: total, detail: detail });
  };
  // GM: invia l'intero stato dello Schermo del GM (localStorage 'dnd-combat-tracker-state-v1')
  DndCombatClient.prototype.pushGmState = function (gmState) { return this.act('state.import', { state: gmState }); };

  // ---------- statici ----------

  DndCombatClient.createRoom = function (server, opts) {
    opts = opts || {};
    return request('POST', trimSlash(server) + '/api/rooms', { name: opts.name, state: opts.state });
  };

  DndCombatClient.roomInfo = function (server, code) {
    return request('GET', trimSlash(server) + '/api/rooms/' + encodeURIComponent(code));
  };

  // Converte la vista del server nel formato di stato dello Schermo del GM, da unire
  // al proprio stato locale: Object.assign(state, DndCombatClient.toGmState(view)).
  DndCombatClient.toGmState = function (view) {
    function strip(e) {
      var o = {};
      Object.keys(e).forEach(function (k) { if (k !== 'cid' && k !== 'mine') o[k] = e[k]; });
      return o;
    }
    return {
      round: view.round,
      time: {
        running: view.time.running,
        startedAt: view.time.running ? Date.now() - (view.time.elapsedMs - view.time.accumulatedMs) : null,
        accumulatedMs: view.time.accumulatedMs,
        secPerRound: view.time.secPerRound
      },
      party: view.party.map(strip),
      npcs: view.npcs.map(strip),
      initiative: { activeId: view.initiative.activeId }
    };
  };

  // Converte la vista nel formato `combat` dello Schermo del Giocatore
  // ({ round, currentId, list: [{ id, pcId, name, init, tie, enemy }] }).
  // pcIdForCid(cid) può restituire l'id locale del PG corrispondente.
  DndCombatClient.toPlayerCombat = function (view, pcIdForCid) {
    return {
      round: Math.max(1, view.round),
      currentId: view.initiative.activeId,
      list: view.order.map(function (c) {
        var item = { id: c.cid, name: c.name, init: c.init, tie: 0, enemy: c.side === 'enemy' };
        if (c.mine) item.pcId = pcIdForCid ? pcIdForCid(c.cid) : c.cid;
        return item;
      })
    };
  };

  DndCombatClient.CONDITIONS = [
    'blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible',
    'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious'
  ];

  if (typeof module === 'object' && module.exports) module.exports = DndCombatClient;
  else root.DndCombatClient = DndCombatClient;
})(typeof window !== 'undefined' ? window : this);
