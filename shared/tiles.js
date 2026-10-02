// Background map tile providers. Stadia Maps and MapTiler need a (free) API key;
// CARTO's free basemaps and OpenStreetMap's own servers no longer allow use by
// apps like this one without arrangement.

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
    label: 'CARTO',
    needsKey: false,
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
    subdomains: 'abcd',
  },
  osm: {
    label: 'OpenStreetMap',
    needsKey: false,
    dark: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    light: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
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
  return { url, attribution: p.attribution, subdomains: p.subdomains ?? 'abc', invertForDark: mapCfg.tiles === 'osm' };
}
