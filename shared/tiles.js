// Background map tile providers. Stadia Maps, MapTiler and CARTO need a (free)
// API key (CARTO watermarks tiles requested without one); OpenStreetMap's own
// servers no longer allow use by apps like this one without arrangement.
//
// Each provider offers a few styles; the settings pick one for the daytime
// theme and one for night (empty = the provider's default). A style's
// `filter` is a CSS filter for its tiles, which is how a daytime map becomes a
// night one: CARTO's own dark style draws land almost black, so by default
// the night map is its Voyager style inverted, where roads, rivers, lakes and
// coastlines stay visible.

const INVERT = 'invert(1) hue-rotate(180deg)';
const NIGHT = `${INVERT} saturate(0.8) brightness(1.3) contrast(0.95)`;
const NIGHT_MUTED = `${INVERT} saturate(0.25) brightness(1.3) contrast(0.95)`;
const BRIGHTER = 'brightness(2.1) contrast(0.95)';

const carto = (style) => `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png?key={key}`;
const stadia = (style) => `https://tiles.stadiamaps.com/tiles/${style}/{z}/{x}/{y}{r}.png?api_key={key}`;
const maptiler = (style) => `https://api.maptiler.com/maps/${style}/256/{z}/{x}/{y}{r}.png?key={key}`;
const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const TILE_PROVIDERS = {
  stadia: {
    label: 'Stadia Maps (free key)',
    needsKey: true,
    attribution: '© Stadia Maps © OpenMapTiles © OpenStreetMap contributors',
    day: 'smooth',
    night: 'smooth-dark',
    styles: {
      smooth: { label: 'Alidade Smooth (light)', url: stadia('alidade_smooth') },
      'smooth-dark': { label: 'Alidade Smooth Dark', url: stadia('alidade_smooth_dark') },
      'smooth-night': { label: 'Alidade Smooth, inverted for night', url: stadia('alidade_smooth'), filter: NIGHT },
      'smooth-dark-bright': {
        label: 'Alidade Smooth Dark, brightened',
        url: stadia('alidade_smooth_dark'),
        filter: BRIGHTER,
      },
    },
  },
  maptiler: {
    label: 'MapTiler (free key)',
    needsKey: true,
    attribution: '© MapTiler © OpenStreetMap contributors',
    day: 'dataviz',
    night: 'dataviz-dark',
    styles: {
      dataviz: { label: 'Dataviz (light)', url: maptiler('dataviz') },
      'dataviz-dark': { label: 'Dataviz Dark', url: maptiler('dataviz-dark') },
      'dataviz-night': { label: 'Dataviz, inverted for night', url: maptiler('dataviz'), filter: NIGHT },
      'dataviz-dark-bright': { label: 'Dataviz Dark, brightened', url: maptiler('dataviz-dark'), filter: BRIGHTER },
    },
  },
  carto: {
    label: 'CARTO (free key)',
    needsKey: true,
    attribution: '© OpenStreetMap contributors © CARTO',
    subdomains: 'abcd',
    day: 'voyager',
    night: 'voyager-night',
    styles: {
      voyager: { label: 'Voyager (colourful)', url: carto('rastertiles/voyager') },
      positron: { label: 'Positron (light grey)', url: carto('light_all') },
      'voyager-night': {
        label: 'Voyager inverted (amber roads, teal water)',
        url: carto('rastertiles/voyager'),
        filter: NIGHT,
      },
      'voyager-night-muted': {
        label: 'Voyager inverted, muted colours',
        url: carto('rastertiles/voyager'),
        filter: NIGHT_MUTED,
      },
      'dark-matter': { label: 'Dark Matter (black)', url: carto('dark_all') },
      'dark-matter-bright': { label: 'Dark Matter, brightened (dark grey)', url: carto('dark_all'), filter: BRIGHTER },
    },
  },
  osm: {
    label: 'OpenStreetMap',
    needsKey: false,
    attribution: '© OpenStreetMap contributors',
    day: 'standard',
    night: 'standard-night',
    styles: {
      standard: { label: 'Standard', url: OSM },
      'standard-night': {
        label: 'Standard, inverted for night',
        url: OSM,
        filter: `${INVERT} brightness(0.85) contrast(0.9)`,
      },
    },
  },
};

/** The style used in a theme ('light' = daytime): the chosen one, or the provider's default. */
export function mapStyle(mapCfg, theme) {
  const p = TILE_PROVIDERS[mapCfg.tiles];
  if (!p) return null;
  const chosen = theme === 'light' ? mapCfg.dayStyle : mapCfg.nightStyle;
  const id = chosen && p.styles[chosen] ? chosen : theme === 'light' ? p.day : p.night;
  return { id, ...p.styles[id] };
}

/**
 * Tile URL + options for the map config and theme, or null for no background
 * (tiles 'none', or a provider that needs a key that hasn't been entered).
 */
export function tileSpec(mapCfg, theme) {
  if (mapCfg.tiles === 'custom') {
    return mapCfg.customTileUrl ? { url: mapCfg.customTileUrl, attribution: '', subdomains: 'abc', filter: '' } : null;
  }
  const p = TILE_PROVIDERS[mapCfg.tiles];
  if (!p) return null;
  const key = (mapCfg.tileApiKey ?? '').trim();
  if (p.needsKey && !key) return null;
  const style = mapStyle(mapCfg, theme);
  const url = style.url.replace('{key}', encodeURIComponent(key));
  return { url, attribution: p.attribution, subdomains: p.subdomains ?? 'abc', filter: style.filter ?? '' };
}
