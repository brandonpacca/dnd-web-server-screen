// Logica di combattimento autorevole lato server.
//
// Lo stato ricalca volutamente quello dello Schermo del GM (dnd-web-gamemaster-screen):
// stessi nomi di campo per round, time, party, npcs e initiative.activeId, così il GM può
// sincronizzare il proprio localStorage con il server senza conversioni.
//
// Ogni azione è una funzione pura sullo stato (lo muta in place) che restituisce
// l'elenco degli eventi da registrare nel log e inviare ai client.

export const CONDITIONS = [
  'blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible',
  'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious'
];

export const CONDITION_LABELS = {
  blinded: 'Accecato', charmed: 'Affascinato', deafened: 'Assordato', frightened: 'Spaventato',
  grappled: 'Afferrato', incapacitated: 'Incapacitato', invisible: 'Invisibile',
  paralyzed: 'Paralizzato', petrified: 'Pietrificato', poisoned: 'Avvelenato', prone: 'Prono',
  restrained: 'Trattenuto', stunned: 'Stordito', unconscious: 'Privo di sensi'
};

export class ActionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const MAX_NAME = 80;
const MAX_TEXT = 500;
const MAX_COMBATANTS = 100;

// ---------------- helpers ----------------

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function str(v, max = MAX_NAME) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function int(v, { min = -9999, max = 9999, fallback = 0 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function requireInt(v, name, opts) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) {
    throw new ActionError('invalid', `Valore numerico mancante o non valido: ${name}`);
  }
  return int(n, opts);
}

export function defaultCombatState() {
  return {
    round: 0,
    active: false,
    time: { running: false, startedAt: null, accumulatedMs: 0, secPerRound: 6 },
    party: [],
    npcs: [],
    initiative: { activeId: null },
    settings: {
      showEnemyHp: false,      // i giocatori vedono i PF esatti dei PNG?
      playersEditHp: true,     // i giocatori possono applicare danni/cure al proprio PG?
      playersCreatePc: true,   // un giocatore può creare un PG non presente nel party?
      playersEndTurn: true     // un giocatore può passare il turno quando tocca al suo PG?
    }
  };
}

function baseEntity(data) {
  const hpMax = int(data.hpMax, { min: 0, max: 99999 });
  const hpCur = data.hpCur === undefined || data.hpCur === null || data.hpCur === ''
    ? hpMax : int(data.hpCur, { min: 0, max: 99999 });
  const conditions = Array.isArray(data.conditions)
    ? [...new Set(data.conditions.filter((c) => CONDITIONS.includes(c)))] : [];
  // compatibilità con i vecchi salvataggi del GM (prone/restrained booleani)
  if (data.prone && !conditions.includes('prone')) conditions.push('prone');
  if (data.restrained && !conditions.includes('restrained')) conditions.push('restrained');
  const conc = data.concentration || {};
  return {
    id: str(data.id, 40) || uid(),
    name: str(data.name) || 'Senza nome',
    ac: int(data.ac, { min: 0, max: 99 }),
    hpCur,
    hpMax,
    hpTemp: int(data.hpTemp, { min: 0, max: 99999 }),
    init: int(data.init, { min: -99, max: 99 }),
    damage: int(data.damage, { min: 0, max: 999999 }),
    conditions,
    exhaustion: int(data.exhaustion, { min: 0, max: 6 }),
    concentration: { active: !!conc.active, spell: str(conc.spell) }
  };
}

export function makePc(data = {}) {
  const ds = data.deathSaves || {};
  return {
    ...baseEntity(data),
    race: str(data.race),
    className: str(data.className),
    deathSaves: { success: int(ds.success, { min: 0, max: 3 }), failure: int(ds.failure, { min: 0, max: 3 }) },
    playerId: data.playerId ? str(data.playerId, 40) : null
  };
}

export function makeNpc(data = {}) {
  return {
    ...baseEntity(data),
    side: data.side === 'ally' ? 'ally' : 'enemy',
    hidden: !!data.hidden
  };
}

export function cidOf(kind, entity) {
  return (kind === 'pc' ? 'pg-' : 'png-') + entity.id;
}

export function findCombatant(state, cid) {
  if (typeof cid !== 'string') return null;
  if (cid.startsWith('pg-')) {
    const e = state.party.find((p) => p.id === cid.slice(3));
    return e ? { kind: 'pc', entity: e, cid } : null;
  }
  if (cid.startsWith('png-')) {
    const e = state.npcs.find((n) => n.id === cid.slice(4));
    return e ? { kind: 'npc', entity: e, cid } : null;
  }
  return null;
}

function target(state, cid) {
  const t = findCombatant(state, cid);
  if (!t) throw new ActionError('not_found', `Combattente non trovato: ${cid}`);
  return t;
}

// Stesso ordinamento dello Schermo del GM: iniziativa decrescente, poi nome.
export function initiativeOrder(state) {
  const list = [];
  state.party.forEach((pc) => list.push({ cid: cidOf('pc', pc), kind: 'pc', entity: pc }));
  state.npcs.forEach((npc) => list.push({ cid: cidOf('npc', npc), kind: 'npc', entity: npc }));
  list.sort((a, b) => (b.entity.init - a.entity.init) || a.entity.name.localeCompare(b.entity.name));
  return list;
}

export function elapsedMs(time, now = Date.now()) {
  return time.accumulatedMs + (time.running && time.startedAt ? now - time.startedAt : 0);
}

function isDead(t) {
  if (t.kind === 'pc') return t.entity.deathSaves.failure >= 3;
  return t.entity.hpCur <= 0;
}

function ev(type, text, data = {}) {
  return { type, text, data };
}

function addCondition(entity, key) {
  if (!entity.conditions.includes(key)) entity.conditions.push(key);
}

function removeCondition(entity, key) {
  entity.conditions = entity.conditions.filter((c) => c !== key);
}

// ---------------- permessi ----------------

// actor: { role: 'gm' } | { role: 'player', playerId }
function isGm(actor) {
  return actor.role === 'gm';
}

function ownsCombatant(actor, t) {
  return actor.role === 'player' && t.kind === 'pc' && t.entity.playerId === actor.playerId;
}

function requireGm(actor) {
  if (!isGm(actor)) throw new ActionError('forbidden', 'Azione riservata al GM');
}

function requireGmOrOwner(actor, t) {
  if (!isGm(actor) && !ownsCombatant(actor, t)) {
    throw new ActionError('forbidden', 'Puoi agire solo sul tuo personaggio');
  }
}

// ---------------- meccaniche 5e ----------------

function applyDamage(t, amount, { critical = false } = {}) {
  const e = t.entity;
  const events = [];
  if (amount <= 0) return events;
  const wasAtZero = e.hpCur <= 0;

  let rest = amount;
  if (e.hpTemp > 0) {
    const absorbed = Math.min(e.hpTemp, rest);
    e.hpTemp -= absorbed;
    rest -= absorbed;
  }
  e.damage += amount;

  if (wasAtZero) {
    if (t.kind === 'pc' && e.deathSaves.failure < 3) {
      // 5e: danni a 0 PF = un fallimento (due se critico); danni ≥ PF massimi = morte.
      if (rest >= e.hpMax && e.hpMax > 0) {
        e.deathSaves.failure = 3;
      } else if (rest > 0) {
        e.deathSaves.failure = Math.min(3, e.deathSaves.failure + (critical ? 2 : 1));
      }
      if (rest > 0) {
        events.push(ev('death-save', `${e.name} subisce danni a 0 PF: ${e.deathSaves.failure} fallimenti`, {
          cid: t.cid, success: e.deathSaves.success, failure: e.deathSaves.failure
        }));
      }
      if (e.deathSaves.failure >= 3) events.push(ev('dead', `☠️ ${e.name} è morto`, { cid: t.cid }));
    }
  } else {
    const before = e.hpCur;
    e.hpCur = Math.max(0, e.hpCur - rest);
    const overflow = rest - before;
    if (e.hpCur === 0) {
      if (t.kind === 'pc') {
        if (overflow >= e.hpMax && e.hpMax > 0) {
          e.deathSaves = { success: 0, failure: 3 };
          events.push(ev('dead', `☠️ ${e.name} muore sul colpo (danno massiccio)`, { cid: t.cid }));
        } else {
          e.deathSaves = { success: 0, failure: 0 };
          addCondition(e, 'unconscious');
          events.push(ev('down', `${e.name} crolla a 0 PF e inizia i tiri salvezza contro la morte`, { cid: t.cid }));
        }
      } else {
        events.push(ev('down', `${e.name} è sconfitto`, { cid: t.cid }));
      }
    }
  }

  if (e.concentration.active) {
    if (e.hpCur <= 0) {
      const spell = e.concentration.spell;
      e.concentration = { active: false, spell: '' };
      events.push(ev('concentration-lost', `${e.name} perde la concentrazione${spell ? ' su ' + spell : ''}`, { cid: t.cid }));
    } else {
      const dc = Math.max(10, Math.floor(amount / 2));
      events.push(ev('concentration-check',
        `${e.name} deve superare un TS Costituzione CD ${dc} per mantenere la concentrazione` +
        (e.concentration.spell ? ` (${e.concentration.spell})` : ''),
        { cid: t.cid, dc }));
    }
  }
  return events;
}

function applyHeal(t, amount) {
  const e = t.entity;
  if (amount <= 0) return [];
  if (t.kind === 'pc' && e.deathSaves.failure >= 3) {
    throw new ActionError('invalid', `${e.name} è morto: le cure normali non hanno effetto`);
  }
  const wasAtZero = e.hpCur <= 0;
  e.hpCur = e.hpMax > 0 ? Math.min(e.hpMax, e.hpCur + amount) : e.hpCur + amount;
  const events = [];
  if (wasAtZero && e.hpCur > 0) {
    if (t.kind === 'pc') {
      e.deathSaves = { success: 0, failure: 0 };
      removeCondition(e, 'unconscious');
    }
    events.push(ev('revived', `${e.name} torna in piedi con ${e.hpCur} PF`, { cid: t.cid }));
  }
  return events;
}

function recordDeathSave(t, roll) {
  const e = t.entity;
  if (t.kind !== 'pc') throw new ActionError('invalid', 'Solo i PG tirano salvezza contro la morte');
  if (e.hpCur > 0) throw new ActionError('invalid', `${e.name} non è a 0 PF`);
  const ds = e.deathSaves;
  if (ds.failure >= 3) throw new ActionError('invalid', `${e.name} è già morto`);
  if (ds.success >= 3) throw new ActionError('invalid', `${e.name} è già stabilizzato`);

  if (roll === 20) {
    e.hpCur = 1;
    e.deathSaves = { success: 0, failure: 0 };
    removeCondition(e, 'unconscious');
    return [ev('revived', `${e.name} tira un 20 naturale e torna in sé con 1 PF!`, { cid: t.cid, roll })];
  }
  if (roll === 1) ds.failure = Math.min(3, ds.failure + 2);
  else if (roll >= 10) ds.success += 1;
  else ds.failure += 1;

  const events = [ev('death-save', `${e.name} tira ${roll} sul TS contro la morte: ${ds.success} successi, ${ds.failure} fallimenti`, {
    cid: t.cid, roll, success: ds.success, failure: ds.failure
  })];
  if (ds.failure >= 3) events.push(ev('dead', `☠️ ${e.name} è morto`, { cid: t.cid }));
  else if (ds.success >= 3) events.push(ev('stable', `✔ ${e.name} è stabilizzato`, { cid: t.cid }));
  return events;
}

function turnEvents(state) {
  const t = findCombatant(state, state.initiative.activeId);
  if (!t) return [];
  return [ev('turn', `Round ${state.round} — tocca a ${t.entity.name}`, {
    cid: t.cid, round: state.round, playerId: t.kind === 'pc' ? t.entity.playerId : null,
    gmOnly: t.kind === 'npc' && t.entity.hidden
  })];
}

function advanceTurn(state, direction) {
  const order = initiativeOrder(state);
  if (order.length === 0) throw new ActionError('invalid', 'Nessun combattente in iniziativa');
  let idx = order.findIndex((c) => c.cid === state.initiative.activeId);
  if (idx === -1) {
    idx = direction > 0 ? 0 : order.length - 1;
    if (state.round === 0) state.round = 1;
  } else {
    // Salta i combattenti morti/sconfitti, ma al massimo un giro completo.
    for (let i = 0; i < order.length; i++) {
      idx += direction;
      if (idx >= order.length) { idx = 0; state.round++; }
      else if (idx < 0) { idx = order.length - 1; state.round = Math.max(1, state.round - 1); }
      if (!isDead(order[idx])) break;
    }
  }
  state.initiative.activeId = order[idx].cid;
  state.active = true;
  return turnEvents(state);
}

// ---------------- campi modificabili ----------------

const PC_GM_FIELDS = ['name', 'race', 'className', 'ac', 'hpCur', 'hpMax', 'hpTemp', 'init', 'damage', 'exhaustion', 'playerId'];
const PC_PLAYER_FIELDS = ['name', 'race', 'className', 'ac', 'hpMax', 'init'];
const NPC_GM_FIELDS = ['name', 'side', 'ac', 'hpCur', 'hpMax', 'hpTemp', 'init', 'damage', 'exhaustion', 'hidden'];

function applyPatch(t, patch, fields) {
  const e = t.entity;
  const changed = [];
  for (const key of Object.keys(patch || {})) {
    if (!fields.includes(key)) throw new ActionError('forbidden', `Campo non modificabile: ${key}`);
    const v = patch[key];
    switch (key) {
      case 'name': e.name = str(v) || e.name; break;
      case 'race': case 'className': e[key] = str(v); break;
      case 'side': e.side = v === 'ally' ? 'ally' : 'enemy'; break;
      case 'hidden': e.hidden = !!v; break;
      case 'playerId': e.playerId = v ? str(v, 40) : null; break;
      case 'ac': e.ac = int(v, { min: 0, max: 99 }); break;
      case 'init': e.init = int(v, { min: -99, max: 99 }); break;
      case 'exhaustion': e.exhaustion = int(v, { min: 0, max: 6 }); break;
      case 'damage': e.damage = int(v, { min: 0, max: 999999 }); break;
      case 'hpTemp': e.hpTemp = int(v, { min: 0, max: 99999 }); break;
      case 'hpMax': e.hpMax = int(v, { min: 0, max: 99999 }); break;
      case 'hpCur': {
        e.hpCur = int(v, { min: 0, max: 99999 });
        if (t.kind === 'pc' && e.hpCur > 0) {
          e.deathSaves = { success: 0, failure: 0 };
          removeCondition(e, 'unconscious');
        }
        break;
      }
      default: break;
    }
    changed.push(key);
  }
  return changed;
}

// ---------------- azioni ----------------

const handlers = {
  // ----- ciclo del combattimento -----
  'combat.start'(state, a, actor) {
    requireGm(actor);
    const order = initiativeOrder(state);
    if (order.length === 0) throw new ActionError('invalid', 'Aggiungi almeno un combattente');
    state.active = true;
    state.round = Math.max(1, state.round);
    state.initiative.activeId = order[0].cid;
    if (a.startTimer !== false && !state.time.running) {
      state.time.running = true;
      state.time.startedAt = Date.now();
    }
    return [ev('combat-start', `⚔️ Inizia il combattimento!`), ...turnEvents(state)];
  },

  'combat.end'(state, a, actor) {
    requireGm(actor);
    state.active = false;
    state.initiative.activeId = null;
    if (state.time.running) {
      state.time.accumulatedMs = elapsedMs(state.time);
      state.time.running = false;
      state.time.startedAt = null;
    }
    return [ev('combat-end', `Il combattimento termina dopo ${state.round} round`)];
  },

  // Equivalente di "Nuovo Combattimento": rimuove i PNG e azzera round, tempo e stati,
  // ma mantiene il party (e i collegamenti con i giocatori).
  'combat.reset'(state, a, actor) {
    requireGm(actor);
    const fresh = defaultCombatState();
    state.round = 0;
    state.active = false;
    state.time = { ...fresh.time, secPerRound: state.time.secPerRound };
    state.initiative = fresh.initiative;
    if (a.keepNpcs !== true) state.npcs = [];
    state.party.forEach((pc) => {
      pc.damage = 0;
      pc.hpTemp = 0;
      pc.conditions = [];
      pc.concentration = { active: false, spell: '' };
      pc.deathSaves = { success: 0, failure: 0 };
      pc.init = 0;
    });
    return [ev('combat-reset', 'Nuovo combattimento: tracciamento azzerato')];
  },

  'round.set'(state, a, actor) {
    requireGm(actor);
    state.round = requireInt(a.round, 'round', { min: 0, max: 99999 });
    return [ev('round', `Round impostato a ${state.round}`, { round: state.round })];
  },

  'turn.next'(state, a, actor) {
    requireGm(actor);
    return advanceTurn(state, 1);
  },

  'turn.prev'(state, a, actor) {
    requireGm(actor);
    return advanceTurn(state, -1);
  },

  // Il giocatore dichiara la fine del proprio turno.
  'turn.end'(state, a, actor) {
    const current = findCombatant(state, state.initiative.activeId);
    if (!isGm(actor)) {
      if (!state.settings.playersEndTurn) throw new ActionError('forbidden', 'Il GM gestisce i turni');
      if (!current || !ownsCombatant(actor, current)) throw new ActionError('forbidden', 'Non è il tuo turno');
    }
    return advanceTurn(state, 1);
  },

  'turn.set'(state, a, actor) {
    requireGm(actor);
    if (a.cid === null) {
      state.initiative.activeId = null;
      return [];
    }
    const t = target(state, a.cid);
    state.initiative.activeId = t.cid;
    if (state.round === 0) state.round = 1;
    return turnEvents(state);
  },

  // ----- cronometro -----
  'time.start'(state, a, actor) {
    requireGm(actor);
    if (!state.time.running) {
      state.time.running = true;
      state.time.startedAt = Date.now();
    }
    return [];
  },

  'time.pause'(state, a, actor) {
    requireGm(actor);
    if (state.time.running) {
      state.time.accumulatedMs = elapsedMs(state.time);
      state.time.running = false;
      state.time.startedAt = null;
    }
    return [];
  },

  'time.reset'(state, a, actor) {
    requireGm(actor);
    state.time.running = false;
    state.time.startedAt = null;
    state.time.accumulatedMs = 0;
    return [];
  },

  'time.config'(state, a, actor) {
    requireGm(actor);
    state.time.secPerRound = requireInt(a.secPerRound, 'secPerRound', { min: 1, max: 3600 });
    return [];
  },

  // ----- combattenti -----
  'combatant.add'(state, a, actor) {
    requireGm(actor);
    if (state.party.length + state.npcs.length >= MAX_COMBATANTS) {
      throw new ActionError('limit', `Massimo ${MAX_COMBATANTS} combattenti`);
    }
    const data = { ...(a.data || {}) };
    delete data.id;
    if (a.kind === 'pc') {
      const pc = makePc(data);
      state.party.push(pc);
      return [ev('combatant-add', `${pc.name} si unisce al party`, { cid: cidOf('pc', pc) })];
    }
    if (a.kind === 'npc') {
      const count = Math.max(1, Math.min(20, int(a.count, { min: 1, max: 20, fallback: 1 })));
      const events = [];
      for (let i = 0; i < count; i++) {
        const npc = makeNpc({ ...data, name: count > 1 ? `${str(data.name) || 'PNG'} ${i + 1}` : data.name });
        state.npcs.push(npc);
        if (!npc.hidden) {
          events.push(ev('combatant-add', `${npc.name} entra in combattimento (${npc.side === 'ally' ? 'alleato' : 'nemico'})`, { cid: cidOf('npc', npc) }));
        } else {
          events.push(ev('combatant-add', `${npc.name} aggiunto (nascosto)`, { cid: cidOf('npc', npc), gmOnly: true }));
        }
      }
      return events;
    }
    throw new ActionError('invalid', 'kind deve essere "pc" o "npc"');
  },

  'combatant.update'(state, a, actor) {
    const t = target(state, a.cid);
    let fields;
    if (isGm(actor)) fields = t.kind === 'pc' ? PC_GM_FIELDS : NPC_GM_FIELDS;
    else if (ownsCombatant(actor, t)) fields = PC_PLAYER_FIELDS;
    else throw new ActionError('forbidden', 'Puoi modificare solo il tuo personaggio');
    const wasHidden = t.kind === 'npc' && t.entity.hidden;
    const changed = applyPatch(t, a.patch, fields);
    if (wasHidden && !t.entity.hidden) {
      return [ev('combatant-add', `${t.entity.name} si rivela!`, { cid: t.cid })];
    }
    if (changed.includes('init')) {
      return [ev('initiative', `${t.entity.name} ha iniziativa ${t.entity.init}`, { cid: t.cid, init: t.entity.init, gmOnly: t.kind === 'npc' && t.entity.hidden })];
    }
    return [];
  },

  'combatant.remove'(state, a, actor) {
    requireGm(actor);
    const t = target(state, a.cid);
    if (state.initiative.activeId === t.cid) {
      // passa il turno al successivo prima di rimuovere
      const order = initiativeOrder(state);
      const idx = order.findIndex((c) => c.cid === t.cid);
      const next = order.length > 1 ? order[(idx + 1) % order.length] : null;
      state.initiative.activeId = next ? next.cid : null;
    }
    if (t.kind === 'pc') state.party = state.party.filter((p) => p !== t.entity);
    else state.npcs = state.npcs.filter((n) => n !== t.entity);
    return [ev('combatant-remove', `${t.entity.name} lascia il combattimento`, { cid: t.cid, gmOnly: t.kind === 'npc' && t.entity.hidden })];
  },

  'initiative.set'(state, a, actor) {
    const t = target(state, a.cid);
    requireGmOrOwner(actor, t);
    t.entity.init = requireInt(a.init, 'init', { min: -99, max: 99 });
    return [ev('initiative', `${t.entity.name} ha iniziativa ${t.entity.init}`, {
      cid: t.cid, init: t.entity.init, gmOnly: t.kind === 'npc' && t.entity.hidden
    })];
  },

  // ----- punti ferita -----
  'hp.damage'(state, a, actor) {
    const t = target(state, a.cid);
    if (!isGm(actor)) {
      requireGmOrOwner(actor, t);
      if (!state.settings.playersEditHp) throw new ActionError('forbidden', 'Il GM gestisce i PF');
    }
    const amount = requireInt(a.amount, 'amount', { min: 0, max: 99999 });
    const label = str(a.damageType, 30);
    const hidden = t.kind === 'npc' && t.entity.hidden;
    const events = [ev('damage', `${t.entity.name} subisce ${amount} danni${label ? ' da ' + label : ''}${a.critical ? ' (critico)' : ''}`, {
      cid: t.cid, amount, gmOnly: hidden
    })];
    return events.concat(applyDamage(t, amount, { critical: !!a.critical }).map((e) => (hidden ? { ...e, data: { ...e.data, gmOnly: true } } : e)));
  },

  'hp.heal'(state, a, actor) {
    const t = target(state, a.cid);
    if (!isGm(actor)) {
      requireGmOrOwner(actor, t);
      if (!state.settings.playersEditHp) throw new ActionError('forbidden', 'Il GM gestisce i PF');
    }
    const amount = requireInt(a.amount, 'amount', { min: 0, max: 99999 });
    const hidden = t.kind === 'npc' && t.entity.hidden;
    return [ev('heal', `${t.entity.name} recupera ${amount} PF`, { cid: t.cid, amount, gmOnly: hidden }), ...applyHeal(t, amount)];
  },

  'hp.temp'(state, a, actor) {
    const t = target(state, a.cid);
    if (!isGm(actor)) {
      requireGmOrOwner(actor, t);
      if (!state.settings.playersEditHp) throw new ActionError('forbidden', 'Il GM gestisce i PF');
    }
    const amount = requireInt(a.amount, 'amount', { min: 0, max: 99999 });
    // 5e: i PF temporanei non si sommano, si tiene il valore più alto (a meno di replace esplicito)
    t.entity.hpTemp = a.replace ? amount : Math.max(t.entity.hpTemp, amount);
    return [ev('temp-hp', `${t.entity.name} ha ${t.entity.hpTemp} PF temporanei`, { cid: t.cid, gmOnly: t.kind === 'npc' && t.entity.hidden })];
  },

  // ----- condizioni -----
  'condition.set'(state, a, actor) {
    const t = target(state, a.cid);
    requireGmOrOwner(actor, t);
    if (!CONDITIONS.includes(a.condition)) throw new ActionError('invalid', `Condizione sconosciuta: ${a.condition}`);
    const has = t.entity.conditions.includes(a.condition);
    const on = a.value === undefined ? !has : !!a.value;
    if (on === has) return [];
    if (on) addCondition(t.entity, a.condition); else removeCondition(t.entity, a.condition);
    const label = CONDITION_LABELS[a.condition];
    return [ev('condition', `${t.entity.name} ${on ? 'è ora' : 'non è più'} ${label}`, {
      cid: t.cid, condition: a.condition, value: on, gmOnly: t.kind === 'npc' && t.entity.hidden
    })];
  },

  'exhaustion.set'(state, a, actor) {
    const t = target(state, a.cid);
    requireGmOrOwner(actor, t);
    t.entity.exhaustion = requireInt(a.level, 'level', { min: 0, max: 6 });
    return [ev('condition', `${t.entity.name}: Sfinimento ${t.entity.exhaustion}`, { cid: t.cid, gmOnly: t.kind === 'npc' && t.entity.hidden })];
  },

  'concentration.set'(state, a, actor) {
    const t = target(state, a.cid);
    requireGmOrOwner(actor, t);
    const active = !!a.active;
    const spell = active ? str(a.spell) : '';
    const prev = t.entity.concentration;
    t.entity.concentration = { active, spell };
    const gmOnly = t.kind === 'npc' && t.entity.hidden;
    if (active) {
      return [ev('concentration', `${t.entity.name} si concentra${spell ? ' su ' + spell : ''}`, { cid: t.cid, gmOnly })];
    }
    if (prev.active) {
      return [ev('concentration-lost', `${t.entity.name} interrompe la concentrazione${prev.spell ? ' su ' + prev.spell : ''}`, { cid: t.cid, gmOnly })];
    }
    return [];
  },

  // ----- tiri salvezza contro la morte -----
  'deathSave.roll'(state, a, actor) {
    const t = target(state, a.cid);
    requireGmOrOwner(actor, t);
    const roll = a.roll === undefined ? 1 + Math.floor(Math.random() * 20) : requireInt(a.roll, 'roll', { min: 1, max: 20 });
    return recordDeathSave(t, roll);
  },

  'deathSave.set'(state, a, actor) {
    requireGm(actor);
    const t = target(state, a.cid);
    if (t.kind !== 'pc') throw new ActionError('invalid', 'Solo i PG hanno tiri salvezza contro la morte');
    t.entity.deathSaves = {
      success: int(a.success, { min: 0, max: 3 }),
      failure: int(a.failure, { min: 0, max: 3 })
    };
    return [];
  },

  // ----- tiri e messaggi condivisi -----
  'log.roll'(state, a, actor) {
    const label = str(a.label) || 'Tiro';
    const total = requireInt(a.total, 'total', { min: -9999, max: 9999 });
    const detail = str(a.detail, 200);
    const priv = isGm(actor) && !!a.private;
    return [ev('roll', `${label}: ${total}${detail ? ' (' + detail + ')' : ''}`, { label, total, detail, gmOnly: priv })];
  },

  'log.message'(state, a, actor) {
    const text = str(a.text, MAX_TEXT);
    if (!text) throw new ActionError('invalid', 'Messaggio vuoto');
    return [ev('message', text, { gmOnly: isGm(actor) && !!a.private })];
  },

  // ----- impostazioni e sincronizzazione -----
  'settings.update'(state, a, actor) {
    requireGm(actor);
    for (const key of Object.keys(a.settings || {})) {
      if (!(key in state.settings)) throw new ActionError('invalid', `Impostazione sconosciuta: ${key}`);
      state.settings[key] = !!a.settings[key];
    }
    return [];
  },

  // Importa lo stato di combattimento dello Schermo del GM (il suo localStorage
  // 'dnd-combat-tracker-state-v1' o il blocco combatState dell'export JSON).
  'state.import'(state, a, actor) {
    requireGm(actor);
    const src = a.state && a.state.combatState ? a.state.combatState : a.state;
    if (!src || typeof src !== 'object') throw new ActionError('invalid', 'Stato da importare mancante');
    const party = Array.isArray(src.party) ? src.party : [];
    const npcs = Array.isArray(src.npcs) ? src.npcs : [];
    if (party.length + npcs.length > MAX_COMBATANTS) throw new ActionError('limit', `Massimo ${MAX_COMBATANTS} combattenti`);

    // conserva i collegamenti giocatore↔PG esistenti (per id o, in mancanza, per nome)
    const links = new Map();
    state.party.forEach((pc) => {
      if (pc.playerId) {
        links.set('id:' + pc.id, pc.playerId);
        links.set('name:' + pc.name.toLowerCase(), pc.playerId);
      }
    });
    state.party = party.map((p) => {
      const pc = makePc(p);
      pc.playerId = links.get('id:' + pc.id) || links.get('name:' + pc.name.toLowerCase()) || pc.playerId;
      return pc;
    });
    state.npcs = npcs.map((n) => makeNpc(n));
    state.round = int(src.round, { min: 0, max: 99999 });
    if (src.time && typeof src.time === 'object') {
      state.time = {
        running: !!src.time.running,
        startedAt: src.time.running ? int(src.time.startedAt, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: Date.now() }) : null,
        accumulatedMs: int(src.time.accumulatedMs, { min: 0, max: Number.MAX_SAFE_INTEGER }),
        secPerRound: int(src.time.secPerRound, { min: 1, max: 3600, fallback: 6 })
      };
    }
    const activeId = src.initiative && src.initiative.activeId;
    state.initiative.activeId = findCombatant(state, activeId) ? activeId : null;
    state.active = !!state.initiative.activeId;
    return [ev('sync', `Il GM ha sincronizzato il combattimento (${state.party.length} PG, ${state.npcs.filter((n) => !n.hidden).length} PNG)`)];
  },

  // Il giocatore collega il proprio PG. `party` è l'oggetto omonimo esportato dallo
  // Schermo del Giocatore ({ name, race, className, ac, hpCur, hpMax, init }).
  'pc.claim'(state, a, actor) {
    if (actor.role !== 'player') throw new ActionError('forbidden', 'Solo un giocatore può reclamare un PG');
    const data = a.party || {};
    let pc = null;
    if (a.cid) {
      const t = target(state, a.cid);
      if (t.kind !== 'pc') throw new ActionError('invalid', 'Puoi reclamare solo un PG');
      pc = t.entity;
    } else {
      const name = str(data.name).toLowerCase();
      if (!name) throw new ActionError('invalid', 'Nome del PG mancante');
      pc = state.party.find((p) => p.name.toLowerCase() === name) || null;
    }
    if (pc && pc.playerId && pc.playerId !== actor.playerId) {
      throw new ActionError('conflict', `${pc.name} è già controllato da un altro giocatore`);
    }
    if (!pc) {
      if (!state.settings.playersCreatePc) throw new ActionError('forbidden', 'Il GM non consente di creare nuovi PG');
      if (state.party.length + state.npcs.length >= MAX_COMBATANTS) throw new ActionError('limit', `Massimo ${MAX_COMBATANTS} combattenti`);
      pc = makePc({ ...data, id: undefined, playerId: actor.playerId });
      state.party.push(pc);
      return [ev('pc-claim', `${pc.name} si unisce al party`, { cid: cidOf('pc', pc), playerId: actor.playerId })];
    }
    pc.playerId = actor.playerId;
    // aggiorna le statistiche col foglio del giocatore, se fornite
    const patch = {};
    ['race', 'className', 'ac', 'hpMax', 'init'].forEach((k) => {
      if (data[k] !== undefined && data[k] !== null && data[k] !== '') patch[k] = data[k];
    });
    applyPatch({ kind: 'pc', entity: pc }, patch, PC_PLAYER_FIELDS);
    return [ev('pc-claim', `${pc.name} è ora controllato dal suo giocatore`, { cid: cidOf('pc', pc), playerId: actor.playerId })];
  },

  'pc.release'(state, a, actor) {
    const t = target(state, a.cid);
    requireGmOrOwner(actor, t);
    if (t.kind !== 'pc') throw new ActionError('invalid', 'Solo i PG hanno un giocatore');
    t.entity.playerId = null;
    return [];
  }
};

export const ACTION_TYPES = Object.keys(handlers);

// Applica un'azione allo stato. Lancia ActionError se non valida o non permessa:
// in quel caso lo stato potrebbe essere stato modificato parzialmente, per cui
// il chiamante lavora su una copia (vedi Room.dispatch).
export function applyAction(state, action, actor) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
    throw new ActionError('invalid', 'Azione non valida');
  }
  const handler = Object.prototype.hasOwnProperty.call(handlers, action.type) ? handlers[action.type] : null;
  if (!handler) throw new ActionError('unknown_action', `Azione sconosciuta: ${action.type}`);
  return handler(state, action, actor) || [];
}
