import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';

let server;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-srv-'));
  server = createServer({ dataDir });
  await new Promise((r) => server.httpServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
});

after(async () => {
  await server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function api(method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

// Client WS minimale che accoda i messaggi e permette di attenderne uno.
function connect(hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    const queue = [];
    const waiters = [];
    let seq = 0;
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
    });
    const c = {
      ws,
      next(pred, ms = 2000) {
        const i = queue.findIndex(pred);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const w = { pred, resolve: (m) => { clearTimeout(t); res(m); } };
          const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout waiting for ' + pred.toString())); }, ms);
          waiters.push(w);
        });
      },
      async act(action) {
        const id = ++seq;
        ws.send(JSON.stringify({ type: 'action', id, action }));
        return c.next((m) => m.type === 'ack' && m.id === id);
      },
      // ultimo stato ricevuto dopo aver svuotato la coda
      async latestState(pred = () => true) {
        try { return (await c.next((m) => m.type === 'state' && pred(m.state))).state; } catch (e) { throw new Error('nessuno stato con ' + pred.toString()); }
      },
      close() { ws.close(); }
    };
    ws.on('open', () => { ws.send(JSON.stringify(hello)); resolve(c); });
    ws.on('error', reject);
  });
}

test('health e SDK client', async () => {
  const h = await api('GET', '/health');
  assert.equal(h.status, 200);
  assert.ok(h.body.actions.includes('hp.damage'));
  const js = await fetch(base + '/client.js');
  assert.equal(js.status, 200);
  assert.match(await js.text(), /DndCombatClient/);
});

test('flusso completo GM + giocatori in tempo reale', async () => {
  const created = await api('POST', '/api/rooms', {
    name: 'Tavolo del giovedì',
    state: {
      round: 0,
      party: [{ id: 'aria', name: 'Aria', ac: 15, hpCur: 20, hpMax: 20, init: 15 }],
      npcs: [
        { id: 'gob', name: 'Goblin', side: 'enemy', ac: 13, hpCur: 7, hpMax: 7, init: 12 },
        { id: 'amb', name: 'Assassino', side: 'enemy', ac: 15, hpCur: 30, hpMax: 30, init: 20, hidden: true }
      ]
    }
  });
  assert.equal(created.status, 201);
  const { code, gmToken } = created.body;
  assert.match(code, /^[A-Z0-9]{6}$/);

  const gm = await connect({ type: 'hello', room: code, token: gmToken });
  const gmWelcome = await gm.next((m) => m.type === 'welcome');
  assert.equal(gmWelcome.role, 'gm');

  // il giocatore entra col PG esportato dallo Schermo del Giocatore
  const pl = await connect({ type: 'hello', room: code.toLowerCase(), name: 'Marta', party: { name: 'Aria', ac: 16, hpMax: 22 } });
  const plWelcome = await pl.next((m) => m.type === 'welcome');
  assert.equal(plWelcome.role, 'player');
  assert.ok(plWelcome.token);

  let pv = await pl.latestState((s) => s.me.pcIds.length === 1);
  assert.deepEqual(pv.me.pcIds, ['pg-aria']);
  assert.equal(pv.party[0].ac, 16);
  // il PNG nascosto non è visibile, e i PF dei nemici sono qualitativi
  assert.equal(pv.npcs.length, 1);
  assert.equal(pv.npcs[0].hpCur, undefined);
  assert.equal(pv.npcs[0].hpStatus, 'illeso');
  assert.ok(!pv.order.some((o) => o.name === 'Assassino'));

  const gv = await gm.latestState((s) => s.players.length === 1 && s.players[0].online);
  assert.equal(gv.players[0].online, true);
  assert.equal(gv.npcs.length, 2);

  // il giocatore imposta l'iniziativa, il GM la vede
  assert.equal((await pl.act({ type: 'initiative.set', cid: 'pg-aria', init: 18 })).ok, true);
  await gm.latestState((s) => s.party[0].init === 18);

  // il giocatore non può toccare i PNG
  const denied = await pl.act({ type: 'hp.damage', cid: 'png-gob', amount: 3 });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'forbidden');

  // inizio combattimento: il primo turno (Assassino nascosto, init 20) non viene rivelato al giocatore
  await gm.act({ type: 'combat.start' });
  const gStart = await gm.latestState((s) => s.active);
  assert.equal(gStart.initiative.activeId, 'png-amb');
  const pStart = await pl.latestState((s) => s.active);
  assert.equal(pStart.initiative.activeId, null);

  await gm.act({ type: 'turn.next' });
  pv = await pl.latestState((s) => s.initiative.activeId === 'pg-aria');
  assert.equal(pv.order.find((o) => o.mine).active, true);
  const turnEv = await pl.next((m) => m.type === 'events' && m.events.some((e) => e.type === 'turn' && e.data.cid === 'pg-aria'));
  assert.ok(turnEv);

  // il giocatore passa il turno
  assert.equal((await pl.act({ type: 'turn.end' })).ok, true);
  await gm.latestState((s) => s.initiative.activeId === 'png-gob');

  // danni del GM al goblin: il giocatore vede solo lo stato
  await gm.act({ type: 'hp.damage', cid: 'png-gob', amount: 5 });
  pv = await pl.latestState((s) => s.npcs[0].hpStatus === 'sanguinante');
  assert.equal(pv.npcs[0].hpCur, undefined);

  // i danni al PNG nascosto non arrivano nel log del giocatore
  await gm.act({ type: 'hp.damage', cid: 'png-amb', amount: 4 });
  await gm.act({ type: 'log.message', text: 'checkpoint' });
  const evs = await pl.next((m) => m.type === 'events' && m.events.some((e) => e.text === 'checkpoint'));
  assert.ok(evs);
  const plLog = await api('GET', `/api/rooms/${code}/log`, null, plWelcome.token);
  assert.ok(!plLog.body.events.some((e) => /Assassino/.test(e.text)));
  const gmLog = await api('GET', `/api/rooms/${code}/log`, null, gmToken);
  assert.ok(gmLog.body.events.some((e) => /Assassino/.test(e.text)));

  // il GM rivela l'assassino
  await gm.act({ type: 'combatant.update', cid: 'png-amb', patch: { hidden: false } });
  pv = await pl.latestState((s) => s.npcs.length === 2);

  // riconnessione del giocatore col token salvato
  pl.close();
  await gm.latestState((s) => s.players[0]?.online === false);
  const pl2 = await connect({ type: 'hello', room: code, token: plWelcome.token });
  const w2 = await pl2.next((m) => m.type === 'welcome');
  assert.equal(w2.playerId, plWelcome.playerId);
  assert.equal(w2.token, undefined);
  pl2.close();
  gm.close();
});

test('API REST: azioni, token non valido, ingresso giocatore', async () => {
  const { body: { code, gmToken } } = await api('POST', '/api/rooms', { name: 'REST' });
  const add = await api('POST', `/api/rooms/${code}/actions`, { type: 'combatant.add', kind: 'npc', count: 3, data: { name: 'Coboldo', hpMax: 5, init: 10 } }, gmToken);
  assert.equal(add.status, 200);
  assert.equal(add.body.events.length, 3);

  const bad = await api('POST', `/api/rooms/${code}/actions`, { type: 'turn.next' }, 'nope');
  assert.equal(bad.status, 401);

  const join = await api('POST', `/api/rooms/${code}/players`, { name: 'Luca', party: { name: 'Bram', hpMax: 12 } });
  assert.equal(join.status, 201);
  const st = await api('GET', `/api/rooms/${code}/state`, null, join.body.token);
  assert.equal(st.body.role, 'player');
  assert.deepEqual(st.body.state.npcs.map((n) => n.name), ['Coboldo 1', 'Coboldo 2', 'Coboldo 3']);
  assert.equal(st.body.state.party[0].mine, true);

  const forbidden = await api('POST', `/api/rooms/${code}/actions`, { type: 'combat.start' }, join.body.token);
  assert.equal(forbidden.status, 403);

  // la stanza sopravvive al riavvio (persistenza su disco)
  server.manager.flush();
  const file = path.join(dataDir, `${code}.json`);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.state.npcs.length, 3);
  assert.ok(!JSON.stringify(saved).includes(gmToken)); // solo l'hash del token

  const other = createServer({ dataDir });
  assert.equal(other.manager.get(code).state.party[0].name, 'Bram');
  assert.ok(other.manager.get(code).authenticate(gmToken));
  await other.close();

  const del = await api('DELETE', `/api/rooms/${code}`, null, gmToken);
  assert.equal(del.status, 200);
  assert.equal((await api('GET', `/api/rooms/${code}`)).status, 404);
});

test('stanza inesistente via WebSocket', async () => {
  const c = await connect({ type: 'hello', room: 'ZZZZZZ', name: 'x' });
  const err = await c.next((m) => m.type === 'error');
  assert.equal(err.error, 'not_found');
  c.close();
});
