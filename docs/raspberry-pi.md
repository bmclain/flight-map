# Raspberry Pi setup

This guide covers two jobs for the Pi:

1. **Receiver.** Turn the AirNav FlightStick's raw signal into an `aircraft.json` that flight-map can poll.
2. **Display (later).** Run the display full-screen on a screen attached to the Pi.

flight-map itself runs on your homelab server, not on the Pi. The Pi only has to decode ADS-B and serve one JSON file.

```
FlightStick ──USB──▶ Raspberry Pi 4 (readsb + tar1090) ──HTTP──▶ homelab (flight-map) ──▶ tablet / screen
```

---

## 1. Receiver

### Hardware notes

- The **AirNav FlightStick** is an RTL-SDR dongle with a 1090 MHz filter and amplifier built in, powered over USB, so you don't need a bias-tee or extra filter.
- Use a **short USB extension cable** to keep the stick away from the Pi's own radio noise, and plug it into one of the black USB2 ports. The blue USB3 ports can add noise.
- **Antenna placement matters far more than anything else.** Get it as high as you can, outside, with a clear view of the horizon. A 1090 MHz antenna with a short, good-quality coax run beats the stock whip almost everywhere.
- Outdoors, keep the Pi in a ventilated, shaded enclosure. A Pi 4 throttles in direct sun.

### Install the decoder (readsb) and web interface (tar1090)

Start from **Raspberry Pi OS Lite (64-bit)** using Raspberry Pi Imager. In the imager's settings, set a hostname (e.g. `adsb`), enable SSH and add your Wi-Fi if needed. Then SSH in and run:

```bash
# readsb decoder (wiedehopf's install script)
sudo bash -c "$(wget -O - https://github.com/wiedehopf/adsb-scripts/raw/master/readsb-install.sh)"

# tell it where the antenna is (latitude longitude)
sudo readsb-set-location 47.6062 -122.3321

# tar1090 web map, which also serves aircraft.json over HTTP
sudo bash -c "$(wget -nv -O - https://github.com/wiedehopf/tar1090/raw/master/install.sh)"
```

Check that it works:

- Open `http://adsb.local/tar1090/` in a browser. You should see a map with aircraft on it within a minute or two.
- `http://adsb.local/tar1090/data/aircraft.json` is the URL flight-map needs.

The install scripts' defaults are a good start. To tune the gain later, see the [readsb install script README](https://github.com/wiedehopf/adsb-scripts/wiki/Automatic-installation-for-readsb).

### Point flight-map at it

In the flight-map control panel (`http://HOMELAB:8080/admin`) → **Aircraft data**:

- choose **My receiver**
- URL: `http://<pi-ip>/tar1090/data/aircraft.json`
- press **Test connection**

> **Use the Pi's IP address, not `adsb.local`, when flight-map runs in Docker.** Containers usually can't resolve
> mDNS `.local` names. Give the Pi a DHCP reservation on your router so its address doesn't change.

From the homelab you can sanity-check with:

```bash
curl -s http://<pi-ip>/tar1090/data/aircraft.json | head -c 400
```

If you run dump1090-fa (FlightAware/PiAware) instead, the URL is `http://<pi-ip>:8080/data/aircraft.json` (or `/skyaware/data/aircraft.json`). Any readsb/dump1090-style `aircraft.json` works.

### Optional: also feed AirNav RadarBox

If you want the FlightStick to keep feeding AirNav, install their feeder (`rbfeeder`) and have it read from readsb rather than opening the stick itself. Only one program can own the dongle. AirNav documents this as using an "existing dump1090". In `/etc/rbfeeder.ini` that means network mode, reading Beast data from readsb on port 30005:

```ini
[client]
network_mode=true

[network]
mode=beast
external_host=127.0.0.1
external_port=30005
```

Check AirNav's current instructions before relying on this snippet. Their installer and settings change from time to time.

---

## 2. A dedicated screen on the Pi (later)

The display is just a web page, so a screen on the Pi only needs a browser in kiosk mode pointed at the homelab.

1. Use **Raspberry Pi OS with desktop** (64-bit), or add the desktop to your Lite install.
2. `sudo raspi-config` → _Display Options_ → _Screen Blanking_ → **No**.
3. Start Chromium full-screen at login. On current Raspberry Pi OS (Wayland with the labwc compositor), add this to `~/.config/labwc/autostart`:

   ```bash
   chromium-browser --kiosk --noerrdialogs --disable-infobars --no-first-run \
     --password-store=basic --ozone-platform=wayland \
     "http://HOMELAB:8080/display" &
   ```

   On newer images the binary may be called `chromium`. On the older X11 desktop, put the same command in `~/.config/lxsession/LXDE-pi/autostart` (prefixed with `@`) instead.

4. Reboot. The display reloads itself whenever the flight-map server restarts, so you shouldn't need to touch it again.

**Screens for outdoors.** Ordinary monitors and tablets are hard to read in direct sun. Look for a "high brightness" panel (1000+ nits), keep it in shade if you can, and leave the theme on _Automatic_, which uses the high-contrast light theme in daylight.

The screen on the Pi can have its own settings via URL parameters, for example `http://HOMELAB:8080/display?facing=200&layout=split`. See the main README.
