// What each plane on the map counts as, for its colour and the map's summary:
// police, air ambulance and the other special aircraft by kind; airliners by
// airline, in the airline's brand colour (see shared/airlines.js); everything
// else is private.
import { SPECIAL_LABELS } from './special-kinds.js';
import { colorFromName, mapColor } from './colors.js';

export const KIND_LABELS = { ...SPECIAL_LABELS, private: 'Private' };

/** Kinds the summary always lists, even when there are none of them. */
export const ALWAYS_LISTED = ['police', 'ambulance', 'government', 'military', 'private'];

/** Summary order after the airlines; firefighting, rescue and other special aircraft only show up when there are some. */
export const KIND_ORDER = [
  'police',
  'ambulance',
  'government',
  'military',
  'firefighting',
  'rescue',
  'other',
  'private',
];

/**
 * { key, kind, label, brandColor } — kind is 'airline', a special kind or
 * 'private'. Airlines are grouped by the brand they fly as, so WestJet Encore
 * counts as WestJet.
 */
export function planeGroup(ac) {
  const kind = ac.special?.kind ?? (ac.military ? 'military' : null);
  if (kind) return { key: kind, kind, label: KIND_LABELS[kind] ?? kind, brandColor: null };
  const a = ac.airline;
  if (a?.icao || a?.name) {
    const brand = a.brand;
    return {
      key: `airline:${brand?.icao ?? a.icao ?? a.name}`,
      kind: 'airline',
      label: brand?.name ?? a.name ?? a.icao,
      brandColor: brand?.color ?? null,
    };
  }
  return { key: 'private', kind: 'private', label: KIND_LABELS.private, brandColor: null };
}

/**
 * An airline's colour on this theme's map: its brand colour, lightened or
 * darkened to show up, or a steady colour of its own if we don't know it.
 * Other kinds use their CSS tokens (--pg-police, …), so this returns null.
 */
export function airlineColor(group, theme) {
  if (group.kind !== 'airline') return null;
  return group.brandColor ? mapColor(group.brandColor, theme) : colorFromName(group.key, theme);
}

/**
 * Counts for the summary: every airline present (most planes first), then
 * the special kinds and private, always including ALWAYS_LISTED.
 * @returns {{ group, count }[]}
 */
export function summarize(groups) {
  const byKey = new Map();
  for (const g of groups) {
    const row = byKey.get(g.key);
    if (row) row.count++;
    else byKey.set(g.key, { group: g, count: 1 });
  }
  const airlines = [...byKey.values()]
    .filter((r) => r.group.kind === 'airline')
    .sort((a, b) => b.count - a.count || a.group.label.localeCompare(b.group.label));
  const kinds = KIND_ORDER.filter((k) => byKey.has(k) || ALWAYS_LISTED.includes(k)).map(
    (k) => byKey.get(k) ?? { group: { key: k, kind: k, label: KIND_LABELS[k], brandColor: null }, count: 0 },
  );
  return [...airlines, ...kinds];
}
