// How much each outside service has been used: requests, errors and "slow
// down" refusals per service per day (every outgoing request goes through
// meteredFetch), plus money and tokens for the paid ones (FlightAware,
// Anthropic) as they report them. Kept for 120 days in data/cache/usage.json,
// for the API usage card on Settings → Overview.
import fs from 'node:fs/promises';
import path from 'node:path';

const KEEP_DAYS = 120;
const SAVE_MS = 5 * 60_000;

const pad = (n) => String(n).padStart(2, '0');
/** Local calendar date, like the traffic log: "2026-10-10". */
export const usageDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Which service a URL belongs to, or null for things on your own network (the Pi, Whisper). */
export function serviceOf(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (/(^|\.)adsb\.lol$/.test(host)) return 'adsb.lol';
  if (host === 'aeroapi.flightaware.com') return 'flightaware';
  if (host === 'api.anthropic.com') return 'anthropic';
  if (/(^|\.)adsb\.im$/.test(host)) return 'adsb.im';
  if (/(^|\.)adsbdb\.com$/.test(host)) return 'adsbdb';
  if (/(^|\.)planespotters\.net$/.test(host)) return 'planespotters';
  if (/(^|\.)(wikipedia|wikimedia)\.org$/.test(host)) return 'wikipedia';
  if (host.endsWith('github.io') || host.endsWith('githubusercontent.com')) return 'databases';
  if (host.endsWith('huggingface.co')) return 'databases';
  // Map tiles are fetched by the browser, not here. Anything else on a public name:
  const local =
    !host.includes('.') ||
    host.endsWith('.local') ||
    /^(10|127)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return local ? null : host;
}

const empty = () => ({ requests: 0, errors: 0, rateLimited: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });

export class UsageLog {
  constructor({ file, log = console }) {
    this.file = file;
    this.log = log;
    this.days = {}; // date → service → counts
    this.since = null; // first day recorded
    this.dirty = false;
  }

  async load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.days = saved.days ?? {};
      this.since = saved.since ?? null;
    } catch {
      // Nothing yet.
    }
    this.timer = setInterval(() => this.save(), SAVE_MS);
    this.timer.unref?.();
  }

  async stop() {
    clearInterval(this.timer);
    await this.save();
  }

  /** Add to a service's counts for today. */
  record(service, counts = {}, now = Date.now()) {
    if (!service) return;
    const day = usageDay(now);
    this.since ??= day;
    const d = (this.days[day] ??= {});
    const c = (d[service] ??= empty());
    for (const [k, v] of Object.entries(counts)) if (k in c && Number.isFinite(v)) c[k] += v;
    this.dirty = true;
  }

  /** A fetch that counts each request (and its outcome) against its service. */
  meter(fetchImpl) {
    return async (url, init) => {
      const service = serviceOf(String(url));
      try {
        const res = await fetchImpl(url, init);
        if (service) {
          this.record(service, {
            requests: 1,
            errors: res.ok || res.status === 404 ? 0 : 1,
            rateLimited: res.status === 429 ? 1 : 0,
          });
        }
        return res;
      } catch (err) {
        if (service) this.record(service, { requests: 1, errors: 1 });
        throw err;
      }
    };
  }

  /**
   * Per service: today, this calendar month, everything kept, and the last
   * `days` days (oldest first) for the charts.
   */
  summary(now = Date.now(), days = 30) {
    const today = usageDay(now);
    const month = today.slice(0, 7);
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dates.push(usageDay(d.getTime()));
    }
    const services = new Set(Object.values(this.days).flatMap((d) => Object.keys(d)));
    const sum = (filter, svc) => {
      const out = empty();
      for (const [day, d] of Object.entries(this.days)) {
        if (!filter(day) || !d[svc]) continue;
        for (const k of Object.keys(out)) out[k] += d[svc][k];
      }
      out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
      return out;
    };
    const out = {};
    for (const svc of services) {
      out[svc] = {
        today: sum((d) => d === today, svc),
        month: sum((d) => d.startsWith(month), svc),
        kept: sum(() => true, svc),
        daily: dates.map((date) => ({ date, ...(this.days[date]?.[svc] ?? empty()) })),
      };
    }
    return { since: this.since, today, services: out };
  }

  async save(now = Date.now()) {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
    const oldest = usageDay(cutoff.getTime());
    for (const day of Object.keys(this.days)) if (day < oldest) delete this.days[day];
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(`${this.file}.tmp`, JSON.stringify({ since: this.since, days: this.days }));
      await fs.rename(`${this.file}.tmp`, this.file);
    } catch (err) {
      this.log.warn(`usage: ${err.message}`);
    }
  }
}
