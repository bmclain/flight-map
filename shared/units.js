// Unit systems for the display. Internally everything is stored as:
// distance → km, speed → knots, altitude → feet, vertical rate → ft/min.

export const UNIT_SYSTEMS = {
  imperial: {
    label: 'Imperial (mi, mph, ft)',
    distance: { unit: 'mi', perKm: 0.621371 },
    speed: { unit: 'mph', perKt: 1.150779 },
    altitude: { unit: 'ft', perFt: 1, step: 100 },
  },
  aviation: {
    label: 'Aviation (nm, kt, ft)',
    distance: { unit: 'nm', perKm: 0.539957 },
    speed: { unit: 'kt', perKt: 1 },
    altitude: { unit: 'ft', perFt: 1, step: 100 },
  },
  metric: {
    label: 'Metric (km, km/h, m)',
    distance: { unit: 'km', perKm: 1 },
    speed: { unit: 'km/h', perKt: 1.852 },
    altitude: { unit: 'm', perFt: 0.3048, step: 25 },
  },
};

export function unitSystem(name) {
  return UNIT_SYSTEMS[name] || UNIT_SYSTEMS.imperial;
}

const numberFmt = new Intl.NumberFormat('en-US');

/** km → value in the system's distance unit. */
export function kmToUnit(km, system) {
  return km * unitSystem(system).distance.perKm;
}

/** Value in the system's distance unit → km. */
export function unitToKm(value, system) {
  return value / unitSystem(system).distance.perKm;
}

export function distanceUnit(system) {
  return unitSystem(system).distance.unit;
}

/** { value: '4.2', unit: 'mi' } — one decimal below 10, whole numbers above. */
export function formatDistance(km, system) {
  if (km == null || !Number.isFinite(km)) return { value: '—', unit: '' };
  const { unit } = unitSystem(system).distance;
  const v = kmToUnit(km, system);
  const value = v < 10 ? v.toFixed(1) : numberFmt.format(Math.round(v));
  return { value, unit };
}

export function formatSpeed(kt, system) {
  if (kt == null || !Number.isFinite(kt)) return { value: '—', unit: '' };
  const { unit, perKt } = unitSystem(system).speed;
  return { value: numberFmt.format(Math.round(kt * perKt)), unit };
}

export function formatAltitude(ft, system) {
  if (ft == null || !Number.isFinite(ft)) return { value: '—', unit: '' };
  const { unit, perFt, step } = unitSystem(system).altitude;
  const v = Math.round((ft * perFt) / step) * step;
  return { value: numberFmt.format(v), unit };
}

/** Joins a formatted { value, unit } pair. */
export function joinUnit({ value, unit }) {
  return unit ? `${value} ${unit}` : value;
}
