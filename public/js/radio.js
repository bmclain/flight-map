// Plays an aircraft's recent air traffic control calls while its card is up:
// the latest few when the card comes up, then any new ones as they're heard.
//
// Browsers only play sound after someone has touched the page (kiosk browsers
// such as Fully Kiosk can be set to allow it). Until then `blocked` is true and
// the card shows a "tap for sound" hint; the first tap anywhere unlocks it.

const MAX_ON_SHOW = 2; // calls replayed when a card comes up
const MAX_AGE_ON_SHOW_MS = 5 * 60_000;

export class RadioPlayer {
  constructor({ onChange = () => {} } = {}) {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.onChange = onChange;
    this.enabled = true;
    this.blocked = false;
    this.playing = false;
    this.hex = null;
    this.queue = [];
    this.heard = new Set(); // clip ids already played (or skipped) for this showing
    this.audio.addEventListener('ended', () => this.#next());
    this.audio.addEventListener('error', () => this.#next());
    const unlock = () => {
      if (!this.blocked) return;
      this.blocked = false;
      this.#next();
      this.onChange();
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
  }

  setEnabled(on) {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) this.stop();
    this.onChange();
  }

  /** A card is showing this aircraft with these clips (oldest first). */
  show(hex, clips = [], now = Date.now()) {
    if (hex !== this.hex) {
      this.stop();
      this.hex = hex;
      this.heard.clear();
      // Replay the last couple of calls, if they're recent; skip the rest.
      const recent = clips.filter((c) => now - c.at <= MAX_AGE_ON_SHOW_MS).slice(-MAX_ON_SHOW);
      for (const c of clips) if (!recent.includes(c)) this.heard.add(c.id);
    }
    for (const c of clips) {
      if (this.heard.has(c.id)) continue;
      this.heard.add(c.id);
      this.queue.push(c);
    }
    if (!this.playing) this.#next();
  }

  /** The card moved on: stop talking. */
  stop() {
    this.queue = [];
    this.hex = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    if (this.playing) {
      this.playing = false;
      this.onChange();
    }
  }

  #next() {
    const clip = this.enabled && !this.blocked ? this.queue.shift() : null;
    const was = this.playing;
    this.playing = !!clip;
    if (clip) {
      this.audio.src = clip.url;
      this.audio.play().catch((err) => {
        if (err.name === 'NotAllowedError') {
          // Not allowed to make sound yet: keep the clip for after the first tap.
          this.queue.unshift(clip);
          this.blocked = true;
        }
        this.playing = false;
        this.onChange();
      });
    }
    if (was !== this.playing) this.onChange();
  }
}
