// HTTP API, live event stream and static files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDayKey } from './traffic.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = path.join(ROOT, 'node_modules');

const STATIC_MOUNTS = [
  ['/shared/', path.join(ROOT, 'shared'), false],
  ['/css/', path.join(ROOT, 'public', 'css'), false],
  ['/js/', path.join(ROOT, 'public', 'js'), false],
  ['/img/', path.join(ROOT, 'public', 'img'), true],
  ['/vendor/leaflet/', path.join(MODULES, 'leaflet', 'dist'), true],
  ['/vendor/fonts/barlow-condensed/', path.join(MODULES, '@fontsource', 'barlow-condensed', 'files'), true],
  ['/vendor/fonts/inter/', path.join(MODULES, '@fontsource', 'inter', 'files'), true],
];

const PAGES = {
  '/display': path.join(ROOT, 'public', 'display.html'),
  '/admin': path.join(ROOT, 'public', 'admin.html'),
  '/traffic': path.join(ROOT, 'public', 'traffic.html'),
  '/manifest.webmanifest': path.join(ROOT, 'public', 'manifest.webmanifest'),
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
  '.wav': 'audio/wav',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}

function sendFile(res, file, { immutable = false } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': st.size,
      'cache-control': immutable ? 'public, max-age=86400' : 'no-cache',
      'last-modified': st.mtime.toUTCString(),
    });
    fs.createReadStream(file).pipe(res);
  });
}

async function readJsonBody(req, limit = 100_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function safeJoin(base, rel) {
  const target = path.resolve(base, `.${path.posix.normalize(`/${rel}`)}`);
  return target.startsWith(base + path.sep) ? target : null;
}

export function createHttpServer(app, { adminPassword = '' } = {}) {
  const checkAuth = (req) => {
    if (!adminPassword) return true;
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(adminPassword);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  };

  const routes = {
    'GET /api/config': (req, res) => sendJson(res, 200, { config: app.getConfig(), authRequired: !!adminPassword }),

    'PUT /api/config': async (req, res) => {
      if (!checkAuth(req)) return sendJson(res, 401, { error: 'Admin password required' });
      const body = await readJsonBody(req);
      try {
        const config = await app.configStore.update(body);
        sendJson(res, 200, { config });
      } catch (err) {
        if (err.errors) return sendJson(res, 400, { error: err.message, errors: err.errors });
        throw err;
      }
    },

    'GET /api/auth': (req, res) => sendJson(res, checkAuth(req) ? 200 : 401, { authRequired: !!adminPassword }),

    'GET /api/aircraft': (req, res, url) =>
      sendJson(res, 200, {
        serverTime: Date.now(),
        aircraft: app.tracker.snapshot({ trails: url.searchParams.has('trails') }),
      }),

    'GET /api/status': (req, res) => sendJson(res, 200, app.status()),

    'GET /api/atc/recent': (req, res) => sendJson(res, 200, { transmissions: app.atc.recent() }),

    'GET /api/traffic': async (req, res, url) => {
      const date = url.searchParams.get('date');
      if (date && !isDayKey(date)) return sendJson(res, 400, { error: 'date must be YYYY-MM-DD' });
      sendJson(res, 200, await app.traffic.summary(date || undefined));
    },

    'POST /api/source/test': async (req, res) => {
      if (!checkAuth(req)) return sendJson(res, 401, { error: 'Admin password required' });
      const body = await readJsonBody(req);
      const cfg = { ...app.getConfig().source, ...body, pollSeconds: 1 };
      if (cfg.type === 'simulator') return sendJson(res, 200, { ok: true, aircraft: 16, withPosition: 16 });
      const source = app.createSource(cfg);
      try {
        const data = await source.pollOnce();
        sendJson(res, 200, {
          ok: true,
          url: source.status().url,
          aircraft: data.aircraft.length,
          withPosition: data.aircraft.filter((a) => a.lat != null).length,
          hasTypes: data.aircraft.some((a) => a.type),
          // With the online fill-in: what the online feed has too.
          ...(cfg.type === 'aircraft-json' && cfg.supplement
            ? {
                online: data.online
                  ? {
                      aircraft: data.online.aircraft.length,
                      withPosition: data.online.aircraft.filter((a) => a.lat != null).length,
                    }
                  : null,
                onlineError: data.onlineError ?? null,
              }
            : {}),
        });
      } catch (err) {
        sendJson(res, 200, { ok: false, url: source.status().url, error: err.message });
      }
    },

    'GET /api/stream': (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      app.addClient(res);
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      const handler = routes[`${req.method} ${pathname}`];
      if (handler) return await handler(req, res, url);

      const lookup = /^\/api\/aircraft\/([0-9a-f]{6})\/lookup$/.exec(pathname);
      if (lookup && req.method === 'POST') return sendJson(res, app.tracker.want(lookup[1]) ? 202 : 404, {});

      // The whole flight so far (adsb.lol), for aircraft we're tracking. For a
      // plane someone tapped (?tapped), a missing start may come from FlightAware.
      const track = /^\/api\/aircraft\/([0-9a-f]{6})\/track$/.exec(pathname);
      if (track && req.method === 'GET') {
        const hex = track[1];
        if (!app.tracker.planes.has(hex)) return sendJson(res, 404, { error: 'Not tracking that aircraft' });
        if (url.searchParams.has('tapped')) app.tracker.want(hex);
        const ac = app.tracker.snapshot({ radio: false }).find((a) => a.hex === hex) ?? { hex };
        const tapped = app.tracker.wanted.has(hex);
        return sendJson(res, 200, { track: await app.enricher.trackFor(ac, { tapped }) });
      }

      // What it's been saying on the radio (and being told).
      const radio = /^\/api\/aircraft\/([0-9a-f]{6})\/radio$/.exec(pathname);
      if (radio && req.method === 'GET') return sendJson(res, 200, app.atc.detail(radio[1]));

      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });

      if (pathname === '/') {
        res.writeHead(302, { location: '/display' });
        return res.end();
      }
      if (PAGES[pathname]) return sendFile(res, PAGES[pathname]);
      if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
        return sendFile(res, path.join(ROOT, 'public', 'img', 'favicon.svg'), { immutable: true });
      }

      const clip = /^\/atc\/clips\/([^/]+)$/.exec(pathname);
      if (clip) {
        const file = app.atc.clipPath(clip[1]);
        return file ? sendFile(res, file, { immutable: true }) : sendJson(res, 404, { error: 'Not found' });
      }

      const typeImg = /^\/images\/types\/([A-Za-z0-9]{2,4})$/.exec(pathname);
      if (typeImg) {
        const file = app.enricher.photos.typeImagePath(typeImg[1]);
        return file ? sendFile(res, file, { immutable: true }) : sendJson(res, 404, { error: 'No photo' });
      }
      const airframeImg = /^\/images\/airframes\/([^/]+)$/.exec(pathname);
      if (airframeImg) {
        const file = app.enricher.photos.airframeImagePath(airframeImg[1]);
        return file ? sendFile(res, file, { immutable: true }) : sendJson(res, 404, { error: 'No photo' });
      }

      for (const [prefix, dir, immutable] of STATIC_MOUNTS) {
        if (pathname.startsWith(prefix)) {
          const file = safeJoin(dir, pathname.slice(prefix.length));
          return file ? sendFile(res, file, { immutable }) : sendJson(res, 404, { error: 'Not found' });
        }
      }
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!err.status) app.log.error(err);
      if (!res.headersSent) sendJson(res, err.status ?? 500, { error: err.message });
      else res.end();
    }
  });
  return server;
}
