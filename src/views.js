// Viste dello stato filtrate per ruolo.
//
// Il GM riceve tutto. I giocatori non vedono i PNG nascosti, gli eventi riservati al GM
// e, salvo diversa impostazione, i PF esatti e la CA dei PNG: al loro posto ricevono
// una descrizione qualitativa (hpStatus).

import { cidOf, elapsedMs, findCombatant, initiativeOrder } from './combat.js';

export function hpStatus(entity) {
  if (entity.hpCur <= 0) return 'a terra';
  if (!entity.hpMax) return 'sconosciuto';
  const pct = entity.hpCur / entity.hpMax;
  if (pct <= 0.25) return 'critico';
  if (pct <= 0.5) return 'sanguinante';
  if (pct < 1) return 'ferito';
  return 'illeso';
}

function orderEntry(c, state, role, playerId) {
  const e = c.entity;
  return {
    cid: c.cid,
    kind: c.kind,
    side: c.kind === 'pc' ? 'party' : e.side,
    name: e.name,
    init: e.init,
    active: state.initiative.activeId === c.cid,
    hpStatus: hpStatus(e),
    playerId: c.kind === 'pc' ? e.playerId : null,
    mine: role === 'player' && c.kind === 'pc' && e.playerId === playerId,
    ...(role === 'gm' && c.kind === 'npc' ? { hidden: e.hidden } : {})
  };
}

function publicNpc(npc, showHp) {
  const out = {
    id: npc.id,
    cid: cidOf('npc', npc),
    name: npc.name,
    side: npc.side,
    init: npc.init,
    conditions: npc.conditions.slice(),
    exhaustion: npc.exhaustion,
    concentration: { ...npc.concentration },
    hpStatus: hpStatus(npc)
  };
  if (showHp) {
    Object.assign(out, { ac: npc.ac, hpCur: npc.hpCur, hpMax: npc.hpMax, hpTemp: npc.hpTemp, damage: npc.damage });
  }
  return out;
}

export function buildView(room, role, playerId = null, now = Date.now()) {
  const state = room.state;
  const isGm = role === 'gm';
  const visibleOrder = initiativeOrder(state).filter((c) => isGm || c.kind === 'pc' || !c.entity.hidden);
  const active = findCombatant(state, state.initiative.activeId);
  let activeId = state.initiative.activeId;
  if (!isGm && active && active.kind === 'npc' && active.entity.hidden) activeId = null;

  const players = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, online: room.isOnline(p.id) }));

  const view = {
    room: { code: room.code, name: room.name },
    version: room.version,
    serverTime: now,
    round: state.round,
    active: state.active,
    time: { ...state.time, elapsedMs: elapsedMs(state.time, now) },
    initiative: { activeId },
    order: visibleOrder.map((c) => orderEntry(c, state, role, playerId)),
    party: state.party.map((pc) => ({ ...pc, cid: cidOf('pc', pc), mine: !isGm && pc.playerId === playerId })),
    npcs: isGm
      ? state.npcs.map((n) => ({ ...n, cid: cidOf('npc', n) }))
      : state.npcs.filter((n) => !n.hidden).map((n) => publicNpc(n, state.settings.showEnemyHp || n.side === 'ally')),
    settings: { ...state.settings },
    players,
    gmOnline: room.isOnline('gm')
  };
  if (!isGm) view.me = { playerId, pcIds: state.party.filter((p) => p.playerId === playerId).map((p) => cidOf('pc', p)) };
  return view;
}

export function visibleEvents(events, role) {
  return role === 'gm' ? events : events.filter((e) => !(e.data && e.data.gmOnly));
}
