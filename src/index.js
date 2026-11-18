#!/usr/bin/env node
// Avvio del server. Configurazione tramite variabili d'ambiente (vedi README).

import path from 'node:path';
import { createServer } from './server.js';

const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '0.0.0.0';
const dataDir = process.env.DATA_DIR === 'memory' ? null : path.resolve(process.env.DATA_DIR || 'data/rooms');
const ttlDays = Number(process.env.ROOM_TTL_DAYS) || 30;

const server = createServer({
  dataDir,
  allowedOrigins: process.env.ALLOWED_ORIGINS || '*',
  roomTtlMs: ttlDays * 24 * 3600 * 1000,
  allowRoomCreation: process.env.ALLOW_ROOM_CREATION !== 'false'
});

server.httpServer.listen(port, host, () => {
  console.log(`dnd-web-server-screen in ascolto su http://${host}:${port} (ws: /ws)`);
  console.log(dataDir ? `Stanze salvate in ${dataDir} (${server.manager.rooms.size} caricate)` : 'Stanze solo in memoria');
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log('Arresto in corso, salvataggio delle stanze…');
  server.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
