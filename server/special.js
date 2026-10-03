// Special aircraft: police, air ambulance, firefighting, search & rescue,
// military and government. Your own list (Settings) comes first, then the
// aircraft database's military flag, then keywords in the operator's name.

export { SPECIAL_KINDS } from '../shared/special-kinds.js';

const KEYWORDS = [
  [
    'police',
    /\b(police|polizei|politi\w*|policia|polizia|sheriff'?s?|state patrol|highway patrol|mounted police|rcmp|gendarmerie|carabinieri|constabulary)\b/i,
  ],
  [
    'ambulance',
    /\b(ambulance|air ?ambulance|medevac|lifeguard|life ?flight|air ?med|medical air|shock trauma|ornge|care ?flight|hems)\b/i,
  ],
  ['firefighting', /\b(fire|wildfire|forest protection|public safety agency|bomber)\b/i],
  ['rescue', /\b(search and rescue|sar|coast ?guard|air rescue)\b/i],
  ['military', /\b(air force|armed forces|navy|army|marine corps|national guard|defen[cs]e force)\b/i],
  [
    'government',
    /\b(government|ministry|department|transport canada|nav canada|national research council|federal aviation administration|customs|border|provincial)\b/i,
  ],
];

/** "C-FSPS" → "CFSPS": registrations compared without dashes or spaces. */
const norm = (s) =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '');

/** Does a list entry's `match` ("C-FSPS", "STAR*", "c03121") fit this aircraft? */
export function matchesEntry(match, { hex, reg, callsign }) {
  const m = norm(match);
  if (!m) return false;
  const ids = [norm(hex), norm(reg), norm(callsign)].filter(Boolean);
  if (m.endsWith('*')) return ids.some((id) => id.startsWith(m.slice(0, -1)));
  return ids.includes(m);
}

/**
 * What's special about an aircraft, or null.
 * @param {object} ac       { hex, reg, callsign }
 * @param {object} info     { ownOp, airlineName, military }
 * @param {object[]} list   [{ match, kind, name, alert }]
 * @returns {{ kind: string, name: string|null, alert: boolean } | null}
 */
export function classifySpecial(ac, info = {}, list = []) {
  for (const e of list) {
    if (matchesEntry(e.match, ac)) return { kind: e.kind, name: e.name || null, alert: !!e.alert };
  }
  const operator = info.ownOp || info.airlineName || null;
  if (info.military) return { kind: 'military', name: operator, alert: false };
  for (const [kind, re] of KEYWORDS) {
    for (const text of [info.ownOp, info.airlineName]) {
      if (text && re.test(text)) return { kind, name: titleCase(text), alert: false };
    }
  }
  return null;
}

/** The database shouts ("SHOCK TRAUMA AIR RESCUE SERVICE"); tone it down for the screen. */
function titleCase(s) {
  if (s !== s.toUpperCase()) return s;
  const small = new Set(['of', 'and', 'the', 'for', 'in', 'de', 'du']);
  return s
    .toLowerCase()
    .replace(/\b[a-z][a-z']*/g, (w, i) => (i > 0 && small.has(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .replace(/\b(Rcmp|Nav|Sar)\b/g, (w) => w.toUpperCase());
}
