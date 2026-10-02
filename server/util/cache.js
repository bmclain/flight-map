// In-memory TTL cache that can be persisted to a JSON file between restarts.
import fs from 'node:fs/promises';
import path from 'node:path';

export class TtlCache {
  constructor({ file = null, maxEntries = 20_000 } = {}) {
    this.file = file;
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.dirty = false;
  }

  get size() {
    return this.map.size;
  }

  /** Returns { value } when present and fresh, otherwise undefined. */
  lookup(key, now = Date.now()) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= now) {
      this.map.delete(key);
      return undefined;
    }
    return { value: e.value };
  }

  set(key, value, ttlMs, now = Date.now()) {
    this.map.delete(key);
    this.map.set(key, { value, expires: now + ttlMs });
    this.dirty = true;
    if (this.map.size > this.maxEntries) {
      // Map iteration order is insertion order: drop the oldest entries.
      const excess = this.map.size - this.maxEntries;
      let i = 0;
      for (const k of this.map.keys()) {
        if (i++ >= excess) break;
        this.map.delete(k);
      }
    }
  }

  async load() {
    if (!this.file) return;
    try {
      const entries = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const now = Date.now();
      for (const [k, e] of entries) if (e.expires > now) this.map.set(k, e);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async save() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...this.map]));
    await fs.rename(tmp, this.file);
  }
}
