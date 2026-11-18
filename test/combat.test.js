import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, defaultCombatState, initiativeOrder, makeNpc, makePc } from '../src/combat.js';

const GM = { role: 'gm' };
const P1 = { role: 'player', playerId: 'p1', name: 'Marta' };
const P2 = { role: 'player', playerId: 'p2', name: 'Luca' };

function setup() {
  const s = defaultCombatState();
  s.party.push(makePc({ id: 'a', name: 'Aria', hpMax: 20, init: 15, playerId: 'p1' }));
  s.party.push(makePc({ id: 'b', name: 'Bram', hpMax: 30, init: 8 }));
  s.npcs.push(makeNpc({ id: 'g', name: 'Goblin', hpMax: 7, init: 12, side: 'enemy' }));
  return s;
}

test('ordine di iniziativa come nello Schermo del GM', () => {
  const s = setup();
  assert.deepEqual(initiativeOrder(s).map((c) => c.cid), ['pg-a', 'png-g', 'pg-b']);
});

test('inizio combattimento, avanzamento turni e round', () => {
  const s = setup();
  applyAction(s, { type: 'combat.start', startTimer: false }, GM);
  assert.equal(s.round, 1);
  assert.equal(s.initiative.activeId, 'pg-a');
  applyAction(s, { type: 'turn.next' }, GM);
  applyAction(s, { type: 'turn.next' }, GM);
  assert.equal(s.initiative.activeId, 'pg-b');
  const ev = applyAction(s, { type: 'turn.next' }, GM);
  assert.equal(s.round, 2);
  assert.equal(s.initiative.activeId, 'pg-a');
  assert.equal(ev[0].type, 'turn');
  applyAction(s, { type: 'turn.prev' }, GM);
  assert.equal(s.round, 1);
  assert.equal(s.initiative.activeId, 'pg-b');
});

test('i PNG sconfitti vengono saltati', () => {
  const s = setup();
  applyAction(s, { type: 'combat.start', startTimer: false }, GM);
  applyAction(s, { type: 'hp.damage', cid: 'png-g', amount: 10 }, GM);
  applyAction(s, { type: 'turn.next' }, GM);
  assert.equal(s.initiative.activeId, 'pg-b');
});

test('il giocatore può passare il turno solo quando tocca a lui', () => {
  const s = setup();
  applyAction(s, { type: 'combat.start', startTimer: false }, GM);
  assert.throws(() => applyAction(s, { type: 'turn.end' }, P2), { code: 'forbidden' });
  applyAction(s, { type: 'turn.end' }, P1);
  assert.equal(s.initiative.activeId, 'png-g');
  assert.throws(() => applyAction(s, { type: 'turn.end' }, P1), { code: 'forbidden' });
  assert.throws(() => applyAction(s, { type: 'turn.next' }, P1), { code: 'forbidden' });
});

test('i PF temporanei assorbono i danni', () => {
  const s = setup();
  applyAction(s, { type: 'hp.temp', cid: 'pg-a', amount: 5 }, P1);
  applyAction(s, { type: 'hp.temp', cid: 'pg-a', amount: 3 }, P1); // non si sommano
  assert.equal(s.party[0].hpTemp, 5);
  applyAction(s, { type: 'hp.damage', cid: 'pg-a', amount: 8 }, GM);
  assert.equal(s.party[0].hpTemp, 0);
  assert.equal(s.party[0].hpCur, 17);
  assert.equal(s.party[0].damage, 8);
});

test('PG a 0 PF: privo di sensi, tiri contro la morte, cura', () => {
  const s = setup();
  const ev = applyAction(s, { type: 'hp.damage', cid: 'pg-a', amount: 25 }, GM);
  const pc = s.party[0];
  assert.equal(pc.hpCur, 0);
  assert.ok(pc.conditions.includes('unconscious'));
  assert.ok(ev.some((e) => e.type === 'down'));

  applyAction(s, { type: 'deathSave.roll', cid: 'pg-a', roll: 12 }, P1);
  applyAction(s, { type: 'deathSave.roll', cid: 'pg-a', roll: 5 }, P1);
  assert.deepEqual(pc.deathSaves, { success: 1, failure: 1 });
  applyAction(s, { type: 'hp.damage', cid: 'pg-a', amount: 3, critical: true }, GM);
  assert.equal(pc.deathSaves.failure, 3);
  assert.throws(() => applyAction(s, { type: 'hp.heal', cid: 'pg-a', amount: 5 }, GM), { code: 'invalid' });
});

test('20 naturale al tiro contro la morte riporta a 1 PF', () => {
  const s = setup();
  applyAction(s, { type: 'hp.damage', cid: 'pg-a', amount: 20 }, GM);
  applyAction(s, { type: 'deathSave.roll', cid: 'pg-a', roll: 20 }, P1);
  assert.equal(s.party[0].hpCur, 1);
  assert.ok(!s.party[0].conditions.includes('unconscious'));
});

test('danno massiccio uccide sul colpo', () => {
  const s = setup();
  const ev = applyAction(s, { type: 'hp.damage', cid: 'pg-a', amount: 40 }, GM);
  assert.equal(s.party[0].deathSaves.failure, 3);
  assert.ok(ev.some((e) => e.type === 'dead'));
});

test('la cura da 0 PF azzera i tiri contro la morte', () => {
  const s = setup();
  applyAction(s, { type: 'hp.damage', cid: 'pg-a', amount: 20 }, GM);
  applyAction(s, { type: 'deathSave.roll', cid: 'pg-a', roll: 3 }, P1);
  applyAction(s, { type: 'hp.heal', cid: 'pg-a', amount: 4 }, GM);
  assert.equal(s.party[0].hpCur, 4);
  assert.deepEqual(s.party[0].deathSaves, { success: 0, failure: 0 });
});

test('prova di concentrazione con CD corretta, persa a 0 PF', () => {
  const s = setup();
  applyAction(s, { type: 'concentration.set', cid: 'pg-a', active: true, spell: 'Benedizione' }, P1);
  let ev = applyAction(s, { type: 'hp.damage', cid: 'pg-a', amount: 6 }, GM);
  assert.equal(ev.find((e) => e.type === 'concentration-check').data.dc, 10);
  ev = applyAction(s, { type: 'hp.damage', cid: 'pg-b', amount: 0 }, GM);
  s.party[1].concentration = { active: true, spell: 'x' };
  ev = applyAction(s, { type: 'hp.damage', cid: 'pg-b', amount: 24 }, GM);
  assert.equal(ev.find((e) => e.type === 'concentration-check').data.dc, 12);
  ev = applyAction(s, { type: 'hp.damage', cid: 'pg-a', amount: 50 }, GM);
  assert.equal(s.party[0].concentration.active, false);
});

test('permessi dei giocatori', () => {
  const s = setup();
  assert.throws(() => applyAction(s, { type: 'hp.damage', cid: 'pg-b', amount: 3 }, P1), { code: 'forbidden' });
  assert.throws(() => applyAction(s, { type: 'condition.set', cid: 'png-g', condition: 'prone' }, P1), { code: 'forbidden' });
  assert.throws(() => applyAction(s, { type: 'combatant.update', cid: 'pg-a', patch: { hpCur: 99 } }, P1), { code: 'forbidden' });
  applyAction(s, { type: 'combatant.update', cid: 'pg-a', patch: { ac: 17 } }, P1);
  assert.equal(s.party[0].ac, 17);
  s.settings.playersEditHp = false;
  assert.throws(() => applyAction(s, { type: 'hp.damage', cid: 'pg-a', amount: 3 }, P1), { code: 'forbidden' });
});

test('condizioni: toggle e valore esplicito', () => {
  const s = setup();
  applyAction(s, { type: 'condition.set', cid: 'png-g', condition: 'prone' }, GM);
  assert.deepEqual(s.npcs[0].conditions, ['prone']);
  assert.deepEqual(applyAction(s, { type: 'condition.set', cid: 'png-g', condition: 'prone', value: true }, GM), []);
  applyAction(s, { type: 'condition.set', cid: 'png-g', condition: 'prone' }, GM);
  assert.deepEqual(s.npcs[0].conditions, []);
  assert.throws(() => applyAction(s, { type: 'condition.set', cid: 'png-g', condition: 'flying' }, GM), { code: 'invalid' });
});

test('import dello stato del GM con migrazione e conservazione dei collegamenti', () => {
  const s = setup();
  const gmState = {
    round: 3,
    time: { running: false, startedAt: null, accumulatedMs: 60000, secPerRound: 6 },
    party: [{ id: 'zz', name: 'aria', ac: 15, hpCur: 10, hpMax: 20, init: 14, damage: 10, prone: true }],
    npcs: [{ id: 'o1', name: 'Orco', side: 'enemy', ac: 13, hpCur: 15, hpMax: 15, init: 9, damage: 0, conditions: [] }],
    initiative: { activeId: 'png-o1' }
  };
  applyAction(s, { type: 'state.import', state: { combatState: gmState } }, GM);
  assert.equal(s.round, 3);
  assert.equal(s.party[0].playerId, 'p1'); // collegato per nome
  assert.deepEqual(s.party[0].conditions, ['prone']);
  assert.equal(s.initiative.activeId, 'png-o1');
  assert.equal(s.active, true);
});

test('pc.claim collega un PG esistente o ne crea uno nuovo', () => {
  const s = setup();
  applyAction(s, { type: 'pc.claim', party: { name: 'BRAM', ac: 16, hpMax: 31 } }, P2);
  assert.equal(s.party[1].playerId, 'p2');
  assert.equal(s.party[1].ac, 16);
  assert.throws(() => applyAction(s, { type: 'pc.claim', party: { name: 'Aria' } }, P2), { code: 'conflict' });
  applyAction(s, { type: 'pc.claim', party: { name: 'Nuovo', hpMax: 9 } }, P2);
  assert.equal(s.party.length, 3);
  assert.equal(s.party[2].hpCur, 9);
});

test('combat.reset mantiene il party e rimuove i PNG', () => {
  const s = setup();
  applyAction(s, { type: 'combat.start' }, GM);
  applyAction(s, { type: 'hp.damage', cid: 'pg-a', amount: 5 }, GM);
  applyAction(s, { type: 'combat.reset' }, GM);
  assert.equal(s.npcs.length, 0);
  assert.equal(s.party.length, 2);
  assert.equal(s.round, 0);
  assert.equal(s.time.running, false);
  assert.equal(s.party[0].playerId, 'p1');
});

test('azioni sconosciute o malformate', () => {
  const s = setup();
  assert.throws(() => applyAction(s, { type: 'constructor' }, GM), { code: 'unknown_action' });
  assert.throws(() => applyAction(s, null, GM), { code: 'invalid' });
  assert.throws(() => applyAction(s, { type: 'hp.damage', cid: 'pg-a' }, GM), { code: 'invalid' });
  assert.throws(() => applyAction(s, { type: 'hp.damage', cid: 'pg-x', amount: 1 }, GM), { code: 'not_found' });
});
