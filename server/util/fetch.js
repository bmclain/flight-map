// Small HTTP helpers for the enrichment providers.
import fs from 'node:fs/promises';
import path from 'node:path';

export const USER_AGENT = 'look-up/0.1 (personal ADS-B display; https://github.com/bmclain/look-up)';

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} from ${hostOf(url)}`);
    this.status = status;
    this.url = url;
  }
}

export async function fetchJson(url, { fetchImpl = fetch, timeoutMs = 10_000, ...init } = {}) {
  const res = await fetchImpl(url, {
    ...init,
    headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = new HttpError(res.status, url);
    // adsbdb answers 404 with a JSON body for unknown callsigns/aircraft
    try {
      err.body = await res.json();
    } catch {
      /* not JSON */
    }
    throw err;
  }
  return res.json();
}

/** Download `url` to `file` atomically. Returns the response content-type. */
export async function downloadFile(url, file, { fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.download`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, file);
  return res.headers.get('content-type') || '';
}

/** Age of a file in ms, or Infinity if it does not exist. */
export async function fileAgeMs(file) {
  try {
    const st = await fs.stat(file);
    return Date.now() - st.mtimeMs;
  } catch {
    return Infinity;
  }
}

/**
 * Runs async jobs with limited concurrency and a minimum gap between job
 * starts, so we stay polite to free community APIs.
 */
export class RateLimiter {
  constructor({ concurrency = 1, minIntervalMs = 0 } = {}) {
    this.concurrency = concurrency;
    this.minIntervalMs = minIntervalMs;
    this.queue = [];
    this.active = 0;
    this.lastStart = 0;
    this.timer = null;
  }

  get pending() {
    return this.queue.length + this.active;
  }

  run(job) {
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    if (this.timer || this.active >= this.concurrency || !this.queue.length) return;
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.#pump();
      }, wait);
      return;
    }
    const { job, resolve, reject } = this.queue.shift();
    this.active++;
    this.lastStart = Date.now();
    Promise.resolve()
      .then(job)
      .then(resolve, reject)
      .finally(() => {
        this.active--;
        this.#pump();
      });
    this.#pump();
  }
}
