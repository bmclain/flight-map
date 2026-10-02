#!/usr/bin/env node
// Pre-download one photo per aircraft type from Wikipedia into
// data/cache/type-images, so the display has a consistent library before the
// first plane flies over. The server also does this lazily as types appear.
//
//   npm run fetch-images                 # all curated types (~230)
//   npm run fetch-images -- B38M A21N    # just these
//   npm run fetch-images -- --force      # re-download existing ones
import fs from 'node:fs/promises';
import path from 'node:path';
import { CURATED_TYPES } from '../server/enrich/curatedTypes.js';
import { TypeDb } from '../server/enrich/types.js';
import { PhotoResolver } from '../server/enrich/photos.js';
import { DEFAULT_CONFIG } from '../server/config.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase());
const dataDir = path.resolve(process.env.DATA_DIR || 'data');

const types = new TypeDb();
const photos = new PhotoResolver({ dataDir, getConfig: () => DEFAULT_CONFIG, log: console });
await photos.init();
photos.stop();

const codes = only.length ? only : Object.keys(CURATED_TYPES);
const byArticle = new Map(); // wiki title → code already downloaded in this run
let ok = 0;
let missing = 0;
let failed = 0;

for (const code of codes) {
  const info = types.describe(code);
  if (!info) {
    console.log(`${code.padEnd(5)} unknown type, skipped`);
    continue;
  }
  const existing = photos.wiki.get(code);
  if (existing && !existing.missing && !force) {
    console.log(`${code.padEnd(5)} already have it`);
    ok++;
    continue;
  }
  try {
    // Many types share an article (737-700/800/900…): copy instead of refetching.
    const twin = info.wiki && byArticle.get(info.wiki);
    if (twin) {
      const src = photos.wiki.get(twin);
      const file = `${code}${path.extname(src.file)}`;
      await fs.copyFile(path.join(photos.wikiDir, src.file), path.join(photos.wikiDir, file));
      const meta = { ...src, file, checkedAt: Date.now() };
      await fs.writeFile(path.join(photos.wikiDir, `${code}.json`), JSON.stringify(meta, null, 2));
      console.log(`${code.padEnd(5)} same photo as ${twin}`);
      ok++;
      continue;
    }
    const meta = await photos.fetchTypeImage(code, info);
    if (meta) {
      if (info.wiki) byArticle.set(info.wiki, code);
      console.log(
        `${code.padEnd(5)} ✓ ${meta.article} — ${meta.artist ?? 'unknown author'} (${meta.license ?? 'licence?'})`,
      );
      ok++;
    } else {
      console.log(`${code.padEnd(5)} no suitable photo found`);
      missing++;
    }
  } catch (err) {
    console.log(`${code.padEnd(5)} failed: ${err.message}`);
    failed++;
  }
  await new Promise((r) => setTimeout(r, 750)); // be polite to Wikipedia
}

console.log(`\n${ok} with photos, ${missing} without, ${failed} failed. Saved in ${photos.wikiDir}`);
console.log('To use your own photo for a type, put e.g. B38M.jpg in', path.join(dataDir, 'images', 'types'));
