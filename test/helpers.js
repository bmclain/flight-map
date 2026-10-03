import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const quietLog = { info() {}, warn() {}, error() {} };

export async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'look-up-test-'));
}

/**
 * A fake `fetch`: `routes` maps a predicate or URL prefix to a handler
 * returning { status, body } (body is JSON-encoded unless it is a Buffer).
 */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, handler] of routes) {
      const hit = typeof match === 'function' ? match(String(url), init) : String(url).startsWith(match);
      if (!hit) continue;
      const { status = 200, body = {}, headers = {} } = await handler(String(url), init);
      const payload = Buffer.isBuffer(body) ? body : JSON.stringify(body);
      return new Response(payload, { status, headers });
    }
    return new Response(JSON.stringify({ error: 'no route' }), { status: 599 });
  };
  fn.calls = calls;
  return fn;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Call `fn` until it returns a truthy value (or time out). */
export async function waitFor(fn, { timeoutMs = 4000, intervalMs = 20 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: timed out');
    await sleep(intervalMs);
  }
}
