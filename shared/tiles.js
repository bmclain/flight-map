// Background map tile providers. Stadia Maps, MapTiler and CARTO need a (free)
// API key (CARTO watermarks tiles requested without one); OpenStreetMap's own
// servers no longer allow use by apps like this one without arrangement.
//
// `darkFilter` is a CSS filter for the tiles in the dark theme. CARTO's own dark
// style draws land almost black, so at night we invert its Voyager style
// instead: roads, rivers, lakes and coastlines stay visible.

const INVERT = 'invert(1) hue-rotate(180deg)';

export const TILE_PROVIDERS = {
  stadia: {
    label: 'Stadia Maps (free key)',
    needsKey: true,
    dark: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png?api_key={key}',
    light: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key={key}',
    attribution: '© Stadia Maps © OpenMapTiles © OpenStreetMap contributors',
  },
  maptiler: {
    label: 'MapTiler (free key)',
    needsKey: true,
    dark: 'https://api.maptiler.com/maps/dataviz-dark/256/{z}/{x}/{y}{r}.png?key={key}',
    light: 'https://api.maptiler.com/maps/dataviz/256/{z}/{x}/{y}{r}.png?key={key}',
    attribution: '© MapTiler © OpenStreetMap contributors',
  },
  carto: {
    label: 'CARTO (free key)',
    needsKey: true,
    dark: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key={key}',
    light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key={key}',
    darkFilter: `${INVERT} saturate(0.8) brightness(1.3) contrast(0.95)`,
    attribution: '© OpenStreetMap contributors © CARTO',
    subdomains: 'abcd',
  },
  osm: {
    label: 'OpenStreetMap',
    needsKey: false,
    dark: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    light: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    darkFilter: `${INVERT} brightness(0.85) contrast(0.9)`,
    attribution: '© OpenStreetMap contributors',
  },
};

/**
 * Tile URL + options for the map config and theme, or null for no background
 * (tiles 'none', or a provider that needs a key that hasn't been entered).
 */
export function tileSpec(mapCfg, theme) {
  if (mapCfg.tiles === 'custom') {
    return mapCfg.customTileUrl ? { url: mapCfg.customTileUrl, attribution: '', subdomains: 'abc' } : null;
  }
  const p = TILE_PROVIDERS[mapCfg.tiles];
  if (!p) return null;
  const key = (mapCfg.tileApiKey ?? '').trim();
  if (p.needsKey && !key) return null;
  const url = (theme === 'light' ? p.light : p.dark).replace('{key}', encodeURIComponent(key));
  const filter = theme === 'dark' ? (p.darkFilter ?? '') : '';
  return { url, attribution: p.attribution, subdomains: p.subdomains ?? 'abc', filter };
}
