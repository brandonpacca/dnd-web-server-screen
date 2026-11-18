# dnd-web-server-screen

Companion **server-side** dello [Schermo del Game Master](https://github.com/brandonpacca/dnd-web-gamemaster-screen) e dello [Schermo del Giocatore](https://github.com/brandonpacca/dnd-web-player-screen): gestisce in tempo reale il combattimento condiviso fra il GM e i giocatori, ognuno sul proprio dispositivo.

Il server tiene lo stato del combattimento e lo applica secondo le regole 5e. Ogni modifica arriva subito a tutti i client collegati via WebSocket. Lo stato usa **gli stessi campi dello Schermo del GM** (`round`, `time`, `party`, `npcs`, `initiative.activeId`), così il GM può sincronizzare il proprio `localStorage` senza conversioni.

## Funzionalità

- **Stanze di gioco**: il GM crea una stanza e riceve un codice di 6 caratteri (es. `K7QX2M`) da comunicare ai giocatori, più un token segreto. Ogni giocatore che entra riceve un proprio token, salvato nel browser, che gli permette di rientrare dopo un ricaricamento.
- **Ordine di iniziativa condiviso**, con lo stesso ordinamento del GM (iniziativa decrescente, poi nome). Avanti/indietro, round che avanza da solo, combattenti morti o sconfitti saltati, evento "tocca a te" per il giocatore di turno. Il giocatore può passare il turno quando tocca al suo PG.
- **Punti ferita**:
  - danni, cure e PF temporanei (i temporanei assorbono i danni per primi e non si sommano);
  - un PG che arriva a 0 PF diventa *Privo di sensi* e inizia i tiri salvezza contro la morte;
  - morte istantanea per danno massiccio;
  - danni subiti a 0 PF contano come fallimenti (2 se critico);
  - le cure da 0 PF azzerano i tiri contro la morte.
- **Tiri salvezza contro la morte**: 10+ è un successo, 1 conta come due fallimenti, 20 naturale riporta a 1 PF, con stabilizzazione e morte automatiche.
- **Concentrazione**: a ogni danno viene inviato l'avviso di TS Costituzione con la CD corretta (10 o metà del danno, il valore più alto). La concentrazione si perde da sola a 0 PF.
- **Condizioni**: le 14 condizioni 5e (stesse chiavi del GM: `blinded`, `prone`, …), più Sfinimento 0–6.
- **Informazioni nascoste ai giocatori**:
  - PNG nascosti (imboscate), rivelati dal GM quando vuole;
  - PF e CA esatti dei nemici, sostituiti da uno stato qualitativo (`illeso`, `ferito`, `sanguinante`, `critico`, `a terra`);
  - tiri e messaggi privati del GM.
- **Permessi**: il GM può fare tutto. Il giocatore agisce solo sul proprio PG (iniziativa, danni/cure, condizioni, concentrazione, TS contro la morte) e può passare il turno. Il GM può disattivare ciascuna di queste possibilità dalle impostazioni.
- **Log degli eventi** (ultimi 200) con tiri annunciati, messaggi e tutto ciò che succede in combattimento.
- **Presenza**: chi è collegato, GM incluso.
- **Persistenza** su disco (un file JSON per stanza, scrittura atomica). Dei token viene salvato solo l'hash SHA-256. Le stanze inattive vengono eliminate dopo `ROOM_TTL_DAYS` giorni.
- **Ogni azione è transazionale**: un'azione non valida o non permessa non lascia mai lo stato a metà.

## Avvio

Serve Node.js ≥ 18.17.

```bash
npm install
npm start          # http://localhost:8787  (WebSocket su ws://localhost:8787/ws)
npm test
```

Con Docker:

```bash
docker build -t dnd-web-server-screen .
docker run -p 8787:8787 -v dnd-data:/app/data dnd-web-server-screen
```

### Configurazione (variabili d'ambiente)

| Variabile | Default | Descrizione |
|---|---|---|
| `PORT` | `8787` | Porta HTTP/WebSocket |
| `HOST` | `0.0.0.0` | Interfaccia di ascolto |
| `DATA_DIR` | `data/rooms` | Cartella dove salvare le stanze (`memory` = nessuna persistenza) |
| `ALLOWED_ORIGINS` | `*` | Origini ammesse per CORS e WebSocket, separate da virgola (es. `https://brandonpacca.github.io`) |
| `ROOM_TTL_DAYS` | `30` | Giorni di inattività dopo cui una stanza viene eliminata |
| `ALLOW_ROOM_CREATION` | `true` | `false` per impedire la creazione di nuove stanze |

Gli schermi sono pubblicati su GitHub Pages in HTTPS, quindi in produzione il server deve essere raggiungibile in **HTTPS/WSS**, ad esempio dietro un reverse proxy (Caddy, nginx) o su un servizio che fornisce TLS.

## Integrazione negli schermi

Il server pubblica uno SDK browser senza dipendenze, in ES5 come gli schermi:

```html
<script src="https://il-tuo-server.example/client.js"></script>
```

### Schermo del GM

```js
// crea la stanza partendo dallo stato attuale dello schermo
DndCombatClient.createRoom(SERVER, { name: 'Campagna', state: state }).then(function (r) {
  // r.code va comunicato ai giocatori; r.gmToken resta al GM
  var client = new DndCombatClient({ server: SERVER, room: r.code, token: r.gmToken });
  client.on('state', function (view) {
    Object.assign(state, DndCombatClient.toGmState(view)); // stesso formato del localStorage
    saveState();
    renderAll();
  });
  client.on('event', function (ev) { console.log(ev.text); });
  client.connect();

  // esempi di azioni
  client.nextTurn();
  client.damage('png-' + npc.id, 8, { critical: true });
  client.toggleCondition('pg-' + pc.id, 'prone');
  client.pushGmState(state); // risincronizza tutto lo stato locale
});
```

### Schermo del Giocatore

```js
// `party` è l'oggetto già prodotto dall'export del PG ({ name, race, className, ac, hpCur, hpMax, init })
var client = new DndCombatClient({ server: SERVER, room: 'K7QX2M', name: 'Marta', party: exportPg.party });
client.on('state', function (view) {
  state.combat = DndCombatClient.toPlayerCombat(view); // stesso formato di state.combat
  renderInitiative();
});
client.on('event', function (ev) {
  if (ev.type === 'turn' && ev.data.playerId === client.playerId) toast('Tocca a te!');
});
client.connect();

var myCid = function () { return client.state.me.pcIds[0]; };
client.setInitiative(myCid(), 17);
client.announceRoll('Attacco con spada lunga', 19, 'd20 (14) +5');
client.endTurn();
```

## Riferimento

### Identificativi dei combattenti

Le azioni indicano un combattente con il `cid`, nello stesso formato di `initiative.activeId` del GM:
- `pg-<id>` per un membro del party;
- `png-<id>` per un PNG.

### Azioni

Ogni azione è un oggetto `{ type, ...parametri }`. Nella colonna *Chi*, **GM** indica un'azione riservata al GM e **GM/PG** un'azione permessa anche al giocatore sul proprio PG.

| Azione | Chi | Parametri | Effetto |
|---|---|---|---|
| `combat.start` | GM | `startTimer?` | Avvia il combattimento dal primo in iniziativa (round ≥ 1) |
| `combat.end` | GM | | Termina il combattimento e mette in pausa il cronometro |
| `combat.reset` | GM | `keepNpcs?` | "Nuovo combattimento": rimuove i PNG e azzera round, tempo e stati del party |
| `round.set` | GM | `round` | Imposta il round |
| `turn.next` / `turn.prev` | GM | | Turno successivo/precedente |
| `turn.end` | GM, giocatore di turno | | Fine del turno |
| `turn.set` | GM | `cid` (o `null`) | Assegna il turno a un combattente |
| `time.start` / `time.pause` / `time.reset` | GM | | Cronometro |
| `time.config` | GM | `secPerRound` | Secondi di gioco per round |
| `combatant.add` | GM | `kind: 'pc'\|'npc'`, `data`, `count?` | Aggiunge un PG o uno o più PNG (`data.hidden` per nasconderli) |
| `combatant.update` | GM/PG | `cid`, `patch` | Modifica i campi; il giocatore solo `name`, `race`, `className`, `ac`, `hpMax`, `init` |
| `combatant.remove` | GM | `cid` | Rimuove un combattente |
| `initiative.set` | GM/PG | `cid`, `init` | Imposta l'iniziativa |
| `hp.damage` | GM/PG | `cid`, `amount`, `critical?`, `damageType?` | Applica danni |
| `hp.heal` | GM/PG | `cid`, `amount` | Applica cure |
| `hp.temp` | GM/PG | `cid`, `amount`, `replace?` | PF temporanei |
| `condition.set` | GM/PG | `cid`, `condition`, `value?` | Attiva/disattiva una condizione (senza `value` la inverte) |
| `exhaustion.set` | GM/PG | `cid`, `level` | Sfinimento 0–6 |
| `concentration.set` | GM/PG | `cid`, `active`, `spell?` | Concentrazione |
| `deathSave.roll` | GM/PG | `cid`, `roll?` | Registra un TS contro la morte (senza `roll` tira il server) |
| `deathSave.set` | GM | `cid`, `success`, `failure` | Imposta i TS contro la morte |
| `log.roll` | tutti | `label`, `total`, `detail?`, `private?` | Annuncia un tiro (`private` solo per il GM) |
| `log.message` | tutti | `text`, `private?` | Messaggio nel log |
| `settings.update` | GM | `settings` | `showEnemyHp`, `playersEditHp`, `playersCreatePc`, `playersEndTurn` |
| `state.import` | GM | `state` | Importa lo stato dello Schermo del GM (oggetto del localStorage o export JSON con `combatState`) |
| `pc.claim` | giocatore | `party` o `cid` | Collega il proprio PG cercandolo per nome; se non esiste lo crea |
| `pc.release` | GM/PG | `cid` | Scollega il PG dal giocatore |

### WebSocket (`/ws`)

Tutti i messaggi sono in JSON.

**Messaggi del client**

| Messaggio | Uso |
|---|---|
| `{ "type": "hello", "room": "K7QX2M", "token": "…" }` | Rientro come GM o giocatore già registrato |
| `{ "type": "hello", "room": "K7QX2M", "name": "Marta", "party": { … } }` | Ingresso di un nuovo giocatore (riceve un token) |
| `{ "type": "action", "id": 1, "action": { "type": "hp.damage", "cid": "png-x", "amount": 7 } }` | Esegue un'azione |
| `{ "type": "sync" }` | Chiede di nuovo lo stato |
| `{ "type": "ping" }` | Keep-alive |

**Messaggi del server**

| Messaggio | Contenuto |
|---|---|
| `welcome` | `role` (`gm`/`player`), `room`, `playerId` e `token` (solo al primo ingresso) |
| `state` | Vista dello stato filtrata per ruolo, inviata dopo ogni modifica |
| `events` | Nuovi eventi del log (`history: true` per lo storico inviato all'ingresso) |
| `ack` | Esito di un'azione: `{ id, ok, error?, message? }` |
| `error` | Errore non legato a un'azione |
| `pong` | Risposta al ping |

Codici di chiusura: `4001` token non valido o `hello` mancante, `4003` giocatore rimosso dal GM, `4004` stanza inesistente o eliminata.

La vista `state` contiene `round`, `active`, `time` (con `elapsedMs` già calcolato), `initiative.activeId`, `order` (ordine di turno pronto da mostrare), `party`, `npcs`, `settings`, `players` (con presenza) e `gmOnline`. Per i giocatori contiene anche `me: { playerId, pcIds }`.

**Eventi del log**

Ogni evento ha la forma `{ id, ts, type, text, data, actor }`. I tipi possibili sono: `turn`, `combat-start`, `combat-end`, `combat-reset`, `round`, `damage`, `heal`, `temp-hp`, `down`, `dead`, `stable`, `revived`, `death-save`, `concentration`, `concentration-check`, `concentration-lost`, `condition`, `initiative`, `combatant-add`, `combatant-remove`, `roll`, `message`, `sync`, `pc-claim`, `player-join`, `player-leave`.

### REST

Tutte le chiamate autenticate usano `Authorization: Bearer <token>`.

| Metodo e percorso | Descrizione |
|---|---|
| `GET /health` | Stato del server ed elenco delle azioni |
| `GET /client.js` | SDK browser |
| `POST /api/rooms` `{ name?, state? }` | Crea una stanza e restituisce `{ code, gmToken }` |
| `GET /api/rooms/:code` | Informazioni pubbliche sulla stanza |
| `DELETE /api/rooms/:code` | Elimina la stanza (GM) |
| `POST /api/rooms/:code/players` `{ name, party? }` | Ingresso di un giocatore; restituisce `{ token, playerId }` |
| `DELETE /api/rooms/:code/players/:playerId` | Il GM rimuove un giocatore |
| `GET /api/rooms/:code/state` | Vista dello stato per il ruolo del token |
| `GET /api/rooms/:code/log` | Ultimi eventi visibili |
| `POST /api/rooms/:code/actions` `{ type, … }` | Esegue un'azione, in alternativa al WebSocket |

## Struttura

```
src/combat.js              Regole e azioni di combattimento (logica pura, testabile)
src/views.js               Viste dello stato filtrate per ruolo (GM / giocatore)
src/rooms.js               Stanze, token, log eventi e persistenza su disco
src/server.js              Server HTTP (REST + CORS) e WebSocket
src/index.js               Avvio e configurazione da variabili d'ambiente
public/dnd-combat-client.js  SDK browser per gli schermi
test/                      Test (node --test)
```
