// Normalise aircraft records from readsb / dump1090-fa / tar1090 aircraft.json
// and readsb-style online APIs (adsb.lol, airplanes.live: `{ ac: [...] }`).

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Parse a whole aircraft.json payload. `now` is returned in milliseconds. */
export function parseAircraftJson(json, receivedAt = Date.now()) {
  if (!json || typeof json !== 'object') throw new Error('aircraft.json: not an object');
  const list = Array.isArray(json.aircraft) ? json.aircraft : Array.isArray(json.ac) ? json.ac : null;
  if (!list) throw new Error('aircraft.json: no "aircraft" or "ac" array');
  let now = num(json.now);
  // readsb writes seconds; the v2 APIs write milliseconds.
  if (now != null && now < 1e11) now *= 1000;
  const aircraft = [];
  for (const rec of list) {
    const ac = normalizeAircraft(rec);
    if (ac) aircraft.push(ac);
  }
  return { now: now ?? receivedAt, messages: num(json.messages), aircraft };
}

export function normalizeAircraft(rec) {
  if (!rec || typeof rec.hex !== 'string') return null;
  const nonIcao = rec.hex.startsWith('~');
  const hex = rec.hex.replace(/^~/, '').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return null;

  // dump1090-mutability used "altitude"/"speed"/"vert_rate"
  const altRaw = rec.alt_baro ?? rec.altitude;
  const onGround = altRaw === 'ground' || rec.ground === true;
  const lat = num(rec.lat);
  const lon = num(rec.lon);

  return {
    hex,
    nonIcao,
    callsign: text(rec.flight)?.toUpperCase() ?? null,
    reg: text(rec.r),
    type: text(rec.t)?.toUpperCase() ?? null,
    desc: text(rec.desc),
    ownOp: text(rec.ownOp),
    year: text(rec.year) ?? (num(rec.year) != null ? String(rec.year) : null),
    category: text(rec.category),
    military: typeof rec.dbFlags === 'number' ? (rec.dbFlags & 1) === 1 : false,
    lat: lat != null && lon != null ? lat : null,
    lon: lat != null && lon != null ? lon : null,
    onGround,
    altFt: onGround ? 0 : num(altRaw),
    altGeomFt: num(rec.alt_geom),
    gsKt: num(rec.gs) ?? num(rec.speed),
    trackDeg: num(rec.track) ?? num(rec.true_heading) ?? num(rec.mag_heading),
    vertRateFpm: num(rec.baro_rate) ?? num(rec.geom_rate) ?? num(rec.vert_rate),
    squawk: text(rec.squawk),
    emergency: rec.emergency && rec.emergency !== 'none' ? String(rec.emergency) : null,
    seen: num(rec.seen) ?? 0,
    seenPos: num(rec.seen_pos) ?? (lat != null ? (num(rec.seen) ?? 0) : null),
    mlat: Array.isArray(rec.mlat) && rec.mlat.includes('lat'),
    tisb: Array.isArray(rec.tisb) && rec.tisb.includes('lat'),
    rssi: num(rec.rssi),
  };
}
