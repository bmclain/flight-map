// Turns an ICAO type designator ("B38M") into something a person recognises
// ("Boeing" / "737 MAX 8") plus a silhouette category for the icon.
import { CURATED_TYPES } from './curatedTypes.js';

const BIZJET_HINTS =
  /citation|gulfstream|learjet|falcon|challenger|global|phenom|praetor|legacy|hawker|honda|premier|beechjet|eclipse|vision|pc-24|sabreliner|westwind|astra|jetstream 41/i;

function titleCaseWord(w) {
  if (!/^[A-Z][A-Z.&'-]*$/.test(w)) return w;
  return w
    .toLowerCase()
    .replace(/(^|[-'])([a-z])/g, (_, sep, c) => sep + c.toUpperCase())
    .replace(/^Mc([a-z])/, (_, c) => `Mc${c.toUpperCase()}`);
}

/**
 * Split an ICAO type name such as "BOEING 737 MAX 8" or
 * "AIRBUS HELICOPTERS EC-135/635" into manufacturer and model.
 */
export function splitIcaoName(name) {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { manufacturer: '', model: '' };
  let i = 0;
  while (i < tokens.length && /^[A-Z][A-Z.&'-]*$/.test(tokens[i]) && tokens[i].length > 1) i++;
  if (i === 0) return { manufacturer: '', model: tokens.join(' ') };
  if (i === tokens.length) i = 1;
  return {
    manufacturer: tokens.slice(0, i).map(titleCaseWord).join(' '),
    model: tokens.slice(i).join(' '),
  };
}

/**
 * Silhouette category from the ICAO description code ("L2J" = landplane,
 * two engines, jet), wake category and name.
 */
export function categoryFromDesc(desc, wtc, name = '') {
  if (!desc) return null;
  const kind = desc[0];
  const engines = Number.parseInt(desc[1], 10);
  const engine = desc[2];
  if (kind === 'H' || kind === 'G') return 'helicopter';
  if (kind === 'T') return 'turboprop';
  if (kind === 'B') return 'balloon';
  if (engines === 0) return 'glider';
  if (engine === 'J') {
    if (engines >= 4 || (engines === 3 && wtc === 'H')) return 'heavy4';
    if (wtc === 'H' || wtc === 'J') return 'widebody';
    if (BIZJET_HINTS.test(name) || wtc === 'L') return 'bizjet';
    return 'narrowbody';
  }
  if (engine === 'T') return engines >= 2 ? 'turboprop' : 'light';
  if (engine === 'P' || engine === 'E') return engines >= 2 ? 'turboprop' : 'light';
  return null;
}

/** Fallback category from the ADS-B emitter category (A1…B7). */
export function categoryFromAdsb(cat) {
  switch (cat) {
    case 'A1':
      return 'light';
    case 'A2':
      return 'bizjet';
    case 'A3':
    case 'A4':
      return 'narrowbody';
    case 'A5':
      return 'widebody';
    case 'A6':
      return 'fighter';
    case 'A7':
      return 'helicopter';
    case 'B1':
      return 'glider';
    case 'B2':
      return 'balloon';
    case 'B4':
    case 'B6':
      return 'light';
    default:
      return null;
  }
}

export class TypeDb {
  constructor() {
    /** code → [name, desc, wtc] from tar1090-db */
    this.icao = {};
  }

  setIcaoTable(table) {
    this.icao = table && typeof table === 'object' ? table : {};
  }

  get size() {
    return Object.keys(this.icao).length;
  }

  /**
   * @param {string|null} code   ICAO type designator
   * @param {string|null} desc   free-text description from readsb/db ("BOEING 737 MAX 8")
   * @param {string|null} adsbCategory  emitter category (A3 etc.)
   */
  describe(code, desc, adsbCategory) {
    const c = code?.toUpperCase() ?? null;
    const curated = c ? CURATED_TYPES[c] : null;
    const icao = c ? this.icao[c] : null;
    if (curated) {
      const [manufacturer, model, category, wiki] = curated;
      return {
        code: c,
        manufacturer,
        model,
        name: [manufacturer, model].filter(Boolean).join(' '),
        category,
        wiki,
        wtc: icao?.[2] ?? null,
      };
    }
    const name = icao?.[0] || desc || null;
    if (!name && !c) {
      const category = categoryFromAdsb(adsbCategory);
      return category ? { code: null, manufacturer: '', model: '', name: null, category, wiki: null, wtc: null } : null;
    }
    const { manufacturer, model } = name ? splitIcaoName(name) : { manufacturer: '', model: c };
    return {
      code: c,
      manufacturer,
      model: model || c,
      name: [manufacturer, model || c].filter(Boolean).join(' '),
      category: categoryFromDesc(icao?.[1], icao?.[2], name ?? '') ?? categoryFromAdsb(adsbCategory) ?? 'narrowbody',
      wiki: null,
      wtc: icao?.[2] ?? null,
    };
  }
}
