// Picks a photo for each aircraft from (in an order set by config):
//   - your own library:  data/images/airframes/<hex or registration>.jpg
//                        data/images/types/<ICAO type>.jpg      (e.g. B38M.jpg)
//   - planespotters.net: a photo of the exact airframe (hotlinked thumbnail, credited)
//   - Wikipedia:         one photo per type, downloaded once to data/cache/type-images
// When nothing is found the display falls back to a silhouette.
import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadFile, fetchJson, RateLimiter } from '../util/fetch.js';
import { TtlCache } from '../util/cache.js';
import { findTypeImage } from './wikipedia.js';

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];
const DAY = 24 * 3600_000;
const RESCAN_MS = 60_000;
const WIKI_RETRY_MS = 7 * DAY;

/** planespotters `/pub/photos/hex/…` response → photo (or null). */
export function normalizePlanespotters(json) {
  const p = json?.photos?.[0];
  const img = p?.thumbnail_large ?? p?.thumbnail;
  if (!img?.src) return null;
  return {
    url: img.src,
    width: img.size?.width ?? null,
    height: img.size?.height ?? null,
    credit: p.photographer ? `© ${p.photographer} · planespotters.net` : 'planespotters.net',
    link: p.link ?? null,
    source: 'planespotters',
    scope: 'airframe',
  };
}

async function indexDir(dir) {
  const index = new Map();
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXT.includes(ext)) continue;
    index.set(path.basename(name, path.extname(name)).toUpperCase(), name);
  }
  return index;
}

export class PhotoResolver {
  constructor({ dataDir, getConfig, log = console, fetchImpl = fetch }) {
    this.getConfig = getConfig;
    this.log = log;
    this.fetch = fetchImpl;
    this.userTypeDir = path.join(dataDir, 'images', 'types');
    this.userAirframeDir = path.join(dataDir, 'images', 'airframes');
    this.wikiDir = path.join(dataDir, 'cache', 'type-images');
    this.userTypes = new Map();
    this.userAirframes = new Map();
    this.wiki = new Map(); // CODE → meta (with .missing for failed lookups)
    this.wikiPending = new Set();
    this.airframe = new TtlCache({ file: path.join(dataDir, 'cache', 'planespotters.json') });
    this.airframePending = new Set();
    this.psLimiter = new RateLimiter({ concurrency: 2, minIntervalMs: 300 });
    this.wikiLimiter = new RateLimiter({ concurrency: 1, minIntervalMs: 1000 });
    this.wikiFailedAt = new Map();
    this.loggedAt = new Map();
    this.stats = { errors: 0, lastError: null };
  }

  async init() {
    await fs.mkdir(this.userTypeDir, { recursive: true });
    await fs.mkdir(this.userAirframeDir, { recursive: true });
    await fs.mkdir(this.wikiDir, { recursive: true });
    await this.rescan();
    for (const name of await fs.readdir(this.wikiDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(this.wikiDir, name), 'utf8'));
        this.wiki.set(path.basename(name, '.json'), meta);
      } catch {
        /* ignore corrupt entries; they will be refetched */
      }
    }
    try {
      await this.airframe.load();
    } catch (err) {
      this.log.warn(`photos: cache unreadable (${err.message})`);
    }
    this.rescanTimer = setInterval(() => this.rescan().catch(() => {}), RESCAN_MS);
    this.rescanTimer.unref?.();
  }

  stop() {
    clearInterval(this.rescanTimer);
  }

  async rescan() {
    this.userTypes = await indexDir(this.userTypeDir);
    this.userAirframes = await indexDir(this.userAirframeDir);
  }

  save() {
    return this.airframe.save();
  }

  /**
   * Photo for an aircraft, or null if none is available (yet).
   * @param {{hex: string, reg?: string|null, typeInfo?: object|null}} ac
   */
  get(ac) {
    const mode = this.getConfig().enrichment.photoMode;
    if (mode === 'off') return null;
    const order =
      mode === 'type'
        ? ['userType', 'wikiType', 'userAirframe', 'planespotters']
        : ['userAirframe', 'planespotters', 'userType', 'wikiType'];
    for (const provider of order) {
      const r = this.#try(provider, ac);
      if (r === 'pending') return null;
      if (r) return r;
    }
    return null;
  }

  #try(provider, ac) {
    const code = ac.typeInfo?.code;
    switch (provider) {
      case 'userAirframe': {
        const file =
          this.userAirframes.get(ac.hex.toUpperCase()) ?? (ac.reg && this.userAirframes.get(ac.reg.toUpperCase()));
        return file
          ? { url: `/images/airframes/${encodeURIComponent(file)}`, credit: null, source: 'local', scope: 'airframe' }
          : null;
      }
      case 'userType': {
        if (!code || !this.userTypes.has(code)) return null;
        return { url: `/images/types/${code}`, credit: null, source: 'local', scope: 'type' };
      }
      case 'planespotters':
        return this.#planespotters(ac);
      case 'wikiType':
        return this.#wikiType(ac.typeInfo);
      default:
        return null;
    }
  }

  #planespotters(ac) {
    const hit = this.airframe.lookup(ac.hex);
    if (hit) return hit.value;
    if (this.airframePending.has(ac.hex)) return 'pending';
    this.airframePending.add(ac.hex);
    this.psLimiter
      .run(async () => {
        const base = 'https://api.planespotters.net/pub/photos';
        let photo = normalizePlanespotters(
          await fetchJson(`${base}/hex/${ac.hex.toUpperCase()}`, { fetchImpl: this.fetch }),
        );
        if (!photo && ac.reg) {
          photo = normalizePlanespotters(
            await fetchJson(`${base}/reg/${encodeURIComponent(ac.reg)}`, { fetchImpl: this.fetch }),
          );
        }
        this.airframe.set(ac.hex, photo, photo ? 3 * DAY : DAY);
      })
      .catch((err) => {
        if (err.status === 404) return this.airframe.set(ac.hex, null, DAY);
        this.#error('planespotters', err);
        this.airframe.set(ac.hex, null, 15 * 60_000);
      })
      .finally(() => this.airframePending.delete(ac.hex));
    return 'pending';
  }

  #wikiType(typeInfo) {
    const code = typeInfo?.code;
    if (!code || !/^[A-Z0-9]{2,4}$/.test(code)) return null;
    const meta = this.wiki.get(code);
    if (meta && !meta.missing) return this.#wikiPhoto(code, meta);
    if (meta?.missing && Date.now() - meta.checkedAt < WIKI_RETRY_MS) return null;
    if (!typeInfo.wiki && !typeInfo.name) return null;
    if (Date.now() - (this.wikiFailedAt.get(code) ?? 0) < 15 * 60_000) return null;
    if (!this.wikiPending.has(code)) {
      this.wikiPending.add(code);
      this.wikiLimiter
        .run(() => this.fetchTypeImage(code, typeInfo))
        .catch((err) => {
          this.wikiFailedAt.set(code, Date.now());
          this.#error('wikipedia', err);
        })
        .finally(() => this.wikiPending.delete(code));
    }
    return 'pending';
  }

  #wikiPhoto(code, meta) {
    const credit = ['Wikimedia Commons', meta.artist, meta.license].filter(Boolean).join(' · ');
    return {
      url: `/images/types/${code}?v=${meta.checkedAt}`,
      credit,
      link: meta.descriptionUrl ?? null,
      source: 'wikipedia',
      scope: 'type',
    };
  }

  /** Download the Wikipedia photo for a type. Also used by scripts/fetch-type-images.js. */
  async fetchTypeImage(code, typeInfo) {
    const found = await findTypeImage(
      { title: typeInfo.wiki, query: typeInfo.wiki ? null : typeInfo.name },
      { fetchImpl: this.fetch },
    );
    const metaFile = path.join(this.wikiDir, `${code}.json`);
    if (!found) {
      const meta = { missing: true, checkedAt: Date.now() };
      await fs.writeFile(metaFile, JSON.stringify(meta));
      this.wiki.set(code, meta);
      return null;
    }
    const ext = path.extname(new URL(found.imageUrl).pathname).toLowerCase() || '.jpg';
    const imageFile = `${code}${IMAGE_EXT.includes(ext) ? ext : '.jpg'}`;
    await downloadFile(found.imageUrl, path.join(this.wikiDir, imageFile), { fetchImpl: this.fetch });
    const meta = {
      file: imageFile,
      article: found.article,
      articleUrl: found.articleUrl,
      descriptionUrl: found.descriptionUrl,
      artist: found.artist,
      license: found.license,
      checkedAt: Date.now(),
    };
    await fs.writeFile(metaFile, JSON.stringify(meta, null, 2));
    this.wiki.set(code, meta);
    return meta;
  }

  /** Absolute path of the image to serve for /images/types/<code>, or null. */
  typeImagePath(code) {
    const c = code.toUpperCase();
    const user = this.userTypes.get(c);
    if (user) return path.join(this.userTypeDir, user);
    const meta = this.wiki.get(c);
    if (meta?.file) return path.join(this.wikiDir, meta.file);
    return null;
  }

  airframeImagePath(file) {
    const name = path.basename(file);
    return [...this.userAirframes.values()].includes(name) ? path.join(this.userAirframeDir, name) : null;
  }

  #error(provider, err) {
    const now = Date.now();
    this.stats.errors++;
    const msg = `${provider}: ${err.message}`;
    // one log line per provider per minute is plenty
    if (now - (this.loggedAt.get(provider) ?? 0) > 60_000) {
      this.log.warn(`photos: ${msg}`);
      this.loggedAt.set(provider, now);
    }
    this.stats.lastError = { message: msg, at: now };
  }

  status() {
    return {
      airframeCached: this.airframe.size,
      typePhotos: [...this.wiki.values()].filter((m) => !m.missing).length,
      userTypePhotos: this.userTypes.size,
      userAirframePhotos: this.userAirframes.size,
      pending: this.airframePending.size + this.wikiPending.size,
      ...this.stats,
    };
  }
}
