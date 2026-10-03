# Look Up: "what plane is that?"

An outdoor display for a home ADS-B receiver. Look up, see a plane, glance at the screen and find out what it is,
where it's going and where to look. It cycles through the aircraft nearby, one at a time:

- **the type**, big enough to read across the garden ("Boeing 737 MAX 8")
- **a photo** of that exact aircraft, or a consistent per-type photo, or a silhouette
- **where it's from and where it's going** (San Francisco → Seattle)
- **an arrow that points at it** from where you stand, plus how high to look ("Ahead, to the left · 32° up")
- **distance, altitude (climbing/descending), speed, heading and typical seats** (or "Cargo" for freight airlines)
- **estimated take-off time, landing time and flight duration**, worked out from the route and the plane's live
  position and speed
- a **map overview** every few aircraft, or always alongside in the split layout

A **control panel** sets the cycle time, ranges, altitude filters, the screen's direction (with a "tap the plane you can
see" calibration), the map, units, theme and photo sources.

| Landscape tablet (dark)                    | Daylight theme                          |
| ------------------------------------------ | --------------------------------------- |
| ![](docs/screenshots/display-dark.png)     | ![](docs/screenshots/display-light.png) |
| **Split layout (aircraft + map)**          | **Map overview**                        |
| ![](docs/screenshots/display-split.png)    | ![](docs/screenshots/map.png)           |
| **Portrait**                               | **Control panel: screen direction**     |
| ![](docs/screenshots/display-portrait.png) | ![](docs/screenshots/admin-facing.png)  |

_Screenshots use the built-in traffic simulator with no internet access, so silhouettes stand in for photos and the map has
no background tiles._

## How it fits together

```
AirNav FlightStick ─USB─▶ Raspberry Pi 4 ─────────────▶ homelab server ───────────────▶ tablet / screen
                          readsb + tar1090              look-up (this repo)             any browser, full screen
                          serves aircraft.json          polls aircraft.json, adds       /display  (the screen)
                                                        types, routes, photos;          /admin    (control panel)
                                                        pushes updates live (SSE)
```

- **Pi:** decodes ADS-B and serves `aircraft.json`. See **[docs/raspberry-pi.md](docs/raspberry-pi.md)**.
- **Homelab:** runs Look Up (Node.js, Docker-friendly). It enriches each aircraft and streams the list to every open
  display. Its only npm dependencies are Leaflet and two fonts; there is no build step.
- **Display:** a web page. Start with a tablet in full-screen mode; later point a Pi-attached screen at the same URL.

## Quick start

With Docker on the homelab:

```bash
git clone https://github.com/bmclain/look-up.git && cd look-up
mkdir -p data            # so the container (uid 1000) can write its config and caches
docker compose up -d --build
```

Without Docker (Node 20+):

```bash
npm ci
npm start                # http://localhost:8080
```

Then:

1. Open **`http://HOMELAB:8080/admin`**.
2. **Receiver location:** click your house on the map (or type latitude/longitude) and save.
3. **Aircraft data:** it starts on the **Simulator** so you can see the display straight away. When the Pi is ready,
   switch to **My receiver** and enter `http://<pi-ip>/tar1090/data/aircraft.json`. Before the Pi is up you can use
   **Online feed** (adsb.lol) to see real traffic around you.
4. **Which way the screen faces:** see [Aiming the arrow](#aiming-the-arrow).
5. Open **`http://HOMELAB:8080/display`** on the tablet.

On first start the server downloads the open [tar1090 aircraft database](https://github.com/wiedehopf/tar1090-db)
(~8 MB, refreshed weekly) for types, registrations and airline names.

## The display

Each aircraft within the **cycle range** gets a card for _N_ seconds (default 10 s, within 15 mi). The order is
least-recently-shown first, ties going to the closest aircraft, so new arrivals come up quickly and nothing gets
skipped. Every few cards (default 5) the **map** is shown for a while. When nothing is in range the screen shows the
map (or a clock) with the nearest traffic.

- **Tap the right side** (or swipe left, or press →) for the next aircraft. **Tap the left side** (or ←) goes back.
- **Tap a plane on the map** for a pop-up with everything on its card and a small photo (its route and photo are looked
  up even if it's far away). _Show full card_ switches to its card; the map stays up while the pop-up is open.
- **Tap anywhere** to bring up controls: hold on this aircraft (space), stay on the map until pressed again (M), light /
  dark / auto (T), full screen (F), settings.
- **Spotlight** (off by default): when an aircraft is very close and low, probably the one you're staring at, the
  display stays on it instead of cycling. Leave it off or keep the radius small if you live under an approach path.
- The theme switches automatically between light (daylight, best in sun) and dark (night), unless you pick one with the
  theme button; each screen remembers its own choice.
- The page reconnects by itself, and reloads itself when the server is restarted or upgraded.

**Per-screen settings.** URL parameters override the saved settings for one screen, which is handy when the tablet and a
Pi screen face different ways:

```
/display?facing=135&layout=split&theme=dark&units=metric
```

### The map

- Each plane is drawn in its airline's colour (the brand colour for airlines listed in `shared/airlines.js`, a steady
  colour of its own for the rest), special aircraft in their kind's colour and private planes in grey, and sized by the
  aircraft, so a light plane is clearly smaller than an airliner.
- Its path covers the last `map.trailMinutes`, thinning towards the old end. The server keeps every plane's track since
  it was first heard (and across restarts), so paths are there as soon as a screen opens.
- The selected plane (on the card, or tapped) gets an outline, and its path is coloured by altitude, orange near the
  ground through yellow, green and blue to purple at 40,000 ft and up, with a key in the corner.
- Labels show the flight number and model, then the airline (or private, police, air ambulance…), altitude and speed.
- The summary in the corner counts the planes per airline, then police, air ambulance, government, military and private.

**Flight numbers.** Planes broadcast an ICAO callsign such as `WJA347`; the display shows the flight number as sold,
`WS347`. Two-letter airline codes come from `shared/airlines.js` (regional airlines such as WestJet Encore use their
brand's code) or, for other airlines, adsbdb. Callsigns that aren't a plain number (`ASA12B`) and military or other
special flights keep their callsign.

**The whole flight.** The card's mini map draws the flight since take-off from [adsb.lol](https://adsb.lol)'s open data
(ODbL) where it has it, joined to your own receiver's track.

### Aiming the arrow

The arrow points from the viewer to the aircraft. Straight up on the dial means **beyond the screen**: the direction a
person faces while looking at it. The display needs that compass direction, so set it in the control panel:

- **Dial / presets:** a screen hung on a south-facing wall means you face **north** to read it.
- **Calibrate with a plane you can see** (the easiest way): stand at the screen, spot a plane roughly straight ahead,
  and tap **Straight ahead** next to it in the list. Its bearing becomes the facing direction.
- **Phone compass:** works where the browser allows it (HTTPS pages only on iPhone).

The **map** can also be rotated so that the way you face is up (`Map orientation`), which makes it match the sky.

### Tablet tips

- **Android:** [Fully Kiosk Browser](https://www.fully-kiosk.com/) works over plain `http://`. Set _Web Content
  Settings → Start URL_ to `http://HOMELAB:8080/display`; for full screen turn off _Toolbars and Appearance → Show
  Status Bar_ and _Show Navigation Bar_; and turn on _Device Management → Keep Screen On_ and _Launch on Boot_. These are
  all free (locking the tablet to the page is a paid PLUS feature). Chrome only installs the display as a full-screen
  app over **HTTPS**: over plain `http://`, _Add to Home screen_ just adds a bookmark that opens in a browser tab.
- **iPad:** Safari → _Share → Add to Home Screen_ opens it full-screen. Set _Auto-Lock: Never_ and use _Guided
  Access_ to keep it on the page.
- Browsers only allow the "keep screen awake" API on HTTPS, so over plain `http://` on your LAN rely on the tablet's own
  stay-awake setting or a kiosk app. Putting Look Up behind your existing HTTPS reverse proxy also works, but put a
  password in front of it: the display shows where you live, and `/admin` is open unless `ADMIN_PASSWORD` is set. Don't
  rely on an IP allowlist alone: many routers make forwarded connections from the internet look like they come from
  the router's own LAN address.
- The display needs a reasonably modern browser (it uses CSS container queries: Chrome/Android WebView 105+,
  Safari/iPadOS 16+).

## Photos

Choose in **Photos & routes**:

| Mode                          | What you get                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Actual aircraft** (default) | A photo of that exact airframe in its livery from [planespotters.net](https://www.planespotters.net), credited to the photographer. Falls back to the type photo. |
| **One photo per type**        | A consistent library: the lead image of each type's Wikipedia article (Wikimedia Commons, freely licensed), downloaded once.                                      |
| **Silhouettes only**          | No network lookups.                                                                                                                                               |

**Your own library always wins.** Put images in the data directory:

```
data/images/types/B38M.jpg          # by ICAO type designator
data/images/airframes/N12345.jpg    # by registration…
data/images/airframes/a1b2c3.jpg    # …or by ICAO hex
```

New files are picked up within a minute, so you can build a matching set (same angle, same background, whatever you like)
over time. To pre-fill the Wikipedia library for ~230 common types in one go:

```bash
npm run fetch-images                   # or: docker compose exec look-up npm run fetch-images
npm run fetch-images -- B38M A21N      # just some types
```

Credits (photographer / Commons author and licence) are shown on the photo.

## Routes

Origin and destination come from the free community route database at [adsb.im](https://adsb.im) (the same data
tar1090 shows), batched, with [adsbdb.com](https://www.adsbdb.com) as a fallback (it also supplies airline names and
IATA flight numbers). Results are cached for 12 hours. These databases are crowd-sourced and occasionally out of date,
and airlines reuse flight numbers, so by default a route is hidden when it plainly doesn't match where the plane is.
Private, charter and general-aviation flights usually have no published route. (adsb.lol serves the same API but
currently answers with an empty response; it's still selectable.)

**Times are estimates.** The free databases have no schedules, so take-off and landing times are calculated from the
distance flown and remaining at the aircraft's speed (typical cruise speed for the part we didn't see). Landing times
are usually within about 15 minutes; take-off times are rougher. Exact times would need a paid flight-status API such
as FlightAware AeroAPI.

## Special aircraft

Police, air ambulance, firefighting, search & rescue, military and government aircraft get a coloured badge on the card,
the pop-up, the map and the traffic page. Many are recognised automatically from the aircraft database (its military flag
and the operator's name). Add your own under **Settings → Special aircraft** by registration (`C-FSPS`), callsign or hex
code (`STAR*` matches callsigns starting with STAR), and tick **Alert** to show a notice in the top corner of the display
whenever that aircraft is in range. Emergency squawks (7500, 7600, 7700) always show a notice.

## Your local airport

Set **Settings → Daily traffic → Local airport** (code, position and elevation) and the traffic page shows where its
departures go and where its arrivals come from, as shares of each day or the last 30 days. A flight counts when it's seen
low near the airport (by default lower than 5,000 ft above it, within 30 km); its far end comes from its route. Flights
that came low near the airport although their route doesn't use it, such as diversions, are listed separately.

## Map background

OpenStreetMap's volunteer-run tile servers block apps like this, and CARTO now watermarks tiles requested without a
key. Use a provider with a free key:

1. **Stadia Maps** (recommended, free for non-commercial use): sign up at <https://client.stadiamaps.com/signup/>,
   create a _property_, and copy its API key.
2. Or **MapTiler**: sign up at <https://cloud.maptiler.com/> and copy a key from _API keys_.
3. Or **CARTO**: request a key at <https://carto.com/basemaps/apikey/> (no account needed; it arrives by email).
4. In `/admin` → **Map overview** → _Background map_, choose the provider, paste the key into **Map API key**, and Save.

The key travels with every map image the tablet downloads, so treat it as public (all three providers let you restrict
a key to your own domains). Without a key the map simply has no background. Without internet, choose _None_.

## Configuration

Everything is editable in `/admin` and stored in `data/config.json`. Changes reach open displays immediately.

| Setting                                | Default                                               | Notes                                                                                      |
| -------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `receiver.lat/lon/altitudeM`           | Seattle                                               | Where the antenna and screen are. Altitude is ground elevation, used for "look up" angles. |
| `source.type`                          | `simulator`                                           | `aircraft-json` (your Pi), `adsb-api` (online), `simulator`                                |
| `source.url`                           | `http://raspberrypi.local/tar1090/data/aircraft.json` | readsb / dump1090-fa / tar1090 `aircraft.json`                                             |
| `source.apiUrl`                        | adsb.lol `/v2/point/{lat}/{lon}/{radiusNm}`           | any readsb-style API                                                                       |
| `display.cycleSeconds`                 | 10                                                    | time per aircraft                                                                          |
| `display.cycleRangeKm`                 | 24.14 (15 mi)                                         | only aircraft this close are cycled through                                                |
| `display.min/maxAltitudeFt`            | 0 / 50,000                                            | e.g. skip high overflights you can't see                                                   |
| `display.hideGround`                   | true                                                  |                                                                                            |
| `display.spotlight.*`                  | off, 2 mi, below 8,000 ft                             | stick to very close aircraft                                                               |
| `display.facingDeg`                    | 0                                                     | compass direction you face while looking at the screen                                     |
| `display.units`                        | `imperial`                                            | `imperial` (mi, mph), `aviation` (nm, kt), `metric`                                        |
| `display.theme`                        | `auto`                                                | `auto` follows sunrise/sunset at the receiver                                              |
| `display.layout`                       | `card`                                                | `card` (map in between) or `split` (map always alongside)                                  |
| `map.everyCards` / `map.seconds`       | 5 / 15                                                | 0 = never interleave the map                                                               |
| `map.rangeKm`                          | 64.37 (40 mi)                                         | aircraft shown on the map                                                                  |
| `map.orientation`                      | `north-up`                                            | or `facing-up`                                                                             |
| `map.trailMinutes`                     | 30                                                    | how much of each plane's path to draw (0 = none, up to 180)                                |
| `map.tiles` / `map.tileApiKey`         | `stadia` / empty                                      | `stadia`, `maptiler` or `carto` (free key needed), `osm`, `none` (offline), `custom`       |
| `enrichment.photoMode`                 | `airframe`                                            | `airframe`, `type`, `off`                                                                  |
| `enrichment.routes` / `routeProviders` | on / adsb.im, adsbdb                                  |                                                                                            |
| `enrichment.flightTracks`              | on                                                    | whole flight since take-off on the mini map, from adsb.lol                                 |

Environment variables: `PORT` (8080), `DATA_DIR` (`./data`), `ADMIN_PASSWORD` (if set, needed to change settings),
and first-run seeds `RECEIVER_LAT`, `RECEIVER_LON`, `RECEIVER_ALT_M`, `SOURCE_URL` (ignored once `config.json` exists).

## API

| Endpoint                       | Purpose                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `GET /api/stream`              | Server-Sent Events: `hello`, then `aircraft` every second, `config` on change  |
| `GET /api/aircraft`            | enriched aircraft in range, nearest first (`?trails` for position history)     |
| `GET /api/aircraft/:hex/track` | the flight since take-off (adsb.lol) for an aircraft being tracked             |
| `GET /api/config` / `PUT`      | read / update settings (PUT accepts partial objects; 400 lists invalid fields) |
| `GET /api/status`              | receiver feed, databases, lookup caches, connected displays                    |
| `POST /api/source/test`        | try a source config once, without saving it                                    |

## Development

```bash
npm run dev      # restart on changes
npm test         # unit + API tests (node:test, no network needed)
```

Layout: `server/` (sources, tracker, enrichment, HTTP), `shared/` (geometry, units and cycling logic used by both server
and browser), `public/` (display and control panel, plain ES modules), `test/`.

## Credits

- Aircraft, type and operator data: [tar1090-db](https://github.com/wiedehopf/tar1090-db) by wiedehopf.
- Routes: [adsb.im](https://adsb.im) and [adsbdb](https://www.adsbdb.com).
- Photos: [planespotters.net](https://www.planespotters.net) photographers and Wikimedia Commons contributors (credited on
  screen).
- Map: [Leaflet](https://leafletjs.com), © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, © CARTO.
