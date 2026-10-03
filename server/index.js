// Entry point: `node server/index.js`
//
// Environment:
//   PORT            HTTP port (default 8080)
//   DATA_DIR        where config.json, caches and your photo library live (default ./data)
//   ADMIN_PASSWORD  if set, required to change settings from the control panel
//   RECEIVER_LAT / RECEIVER_LON / RECEIVER_ALT_M / SOURCE_URL
//                   first-run defaults (only used when data/config.json doesn't exist yet)
import path from 'node:path';
import { App } from './app.js';
import { createHttpServer } from './http.js';

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), 'WARN', ...a),
  error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a),
};

const port = Number(process.env.PORT) || 8080;
const dataDir = path.resolve(process.env.DATA_DIR || 'data');

const app = new App({ dataDir, log });
await app.start({ loadDatabases: process.env.SKIP_AIRCRAFT_DB !== '1' });

const server = createHttpServer(app, { adminPassword: process.env.ADMIN_PASSWORD || '' });
server.listen(port, () => {
  log.info(`Look Up listening on http://0.0.0.0:${port}`);
  log.info(`  display:       http://<this-host>:${port}/display`);
  log.info(`  control panel: http://<this-host>:${port}/admin`);
  log.info(`  data dir:      ${dataDir}`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info(`${signal} received, shutting down`);
  server.close();
  await app.stop();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
