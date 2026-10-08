// Air traffic control radio: takes transmissions from a folder or stream,
// transcribes them, works out which aircraft each one is to or from, keeps the
// audio for a while, and keeps a plain-English line about each aircraft's
// latest exchange for the display.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SAMPLE_RATE, wavFile } from './segmenter.js';
import { FolderSource, StreamSource } from './sources.js';
import { WhisperClient } from './whisper.js';
import { Summarizer } from './summarizer.js';
import { findCallsign, hintPhrases, normalize, radioNames, speakerRole, tokenize } from './speech.js';
import { intents, ruleSummary } from './phrases.js';

const MAX_QUEUE = 20;
const SUMMARY_DELAY_MS = 4000; // wait for the readback before summing up an exchange
const SUMMARY_WINDOW_MS = 10 * 60_000;
const MAX_CLIPS_ON_CARD = 4;
const MAX_LOG_ON_CARD = 20; // lines of the conversation sent to displays

export class AtcService {
  /**
   * @param {object} opts
   * @param {() => object[]} opts.candidates  aircraft that could be on frequency:
   *   { hex, callsign, reg, telephony, typeName, airline, altFt, onGround, … }
   */
  constructor({ dataDir, getConfig, candidates, log = console, fetchImpl = fetch, summarizer = null, env }) {
    this.dataDir = dataDir;
    this.clipDir = path.join(dataDir, 'atc', 'clips');
    this.getConfig = getConfig;
    this.candidates = candidates;
    this.log = log;
    this.fetch = fetchImpl;
    this.summarizer =
      summarizer ??
      new Summarizer({
        log,
        env,
        dataDir,
        limits: () => ({ budget: this.cfg.summaryBudgetUsd, perHour: this.cfg.summariesPerHour }),
      });
    this.transmissions = []; // oldest first
    this.summaries = new Map(); // hex → { text, at, source }
    this.summaryTimers = new Map();
    this.queue = [];
    this.working = false;
    this.source = null;
    this.state = { heard: 0, transcribed: 0, attributed: 0, dropped: 0, lastError: null };
  }

  get cfg() {
    return this.getConfig().atc;
  }

  async start() {
    await fs.mkdir(this.clipDir, { recursive: true });
    await this.summarizer.init?.();
    this.restart();
    this.pruneTimer = setInterval(() => this.prune(), 60_000);
    this.pruneTimer.unref?.();
  }

  /** (Re)start the audio source after a settings change. */
  restart() {
    this.source?.stop();
    this.source = null;
    const cfg = this.cfg;
    if (!cfg.enabled) return;
    const onTransmission = (t) => this.#enqueue(t);
    if (cfg.source === 'stream') {
      if (!cfg.streamUrl) return;
      this.source = new StreamSource({ url: cfg.streamUrl, onTransmission, log: this.log });
    } else {
      const dir = cfg.folder || path.join(this.dataDir, 'atc', 'inbox');
      this.source = new FolderSource({ dir, onTransmission, log: this.log });
    }
    this.whisper = new WhisperClient({ url: cfg.whisperUrl, fetchImpl: this.fetch });
    this.log.info(`atc: listening to ${cfg.source === 'stream' ? cfg.streamUrl : cfg.folder || 'data/atc/inbox'}`);
    this.source.start();
  }

  stop() {
    this.source?.stop();
    clearInterval(this.pruneTimer);
    for (const t of this.summaryTimers.values()) clearTimeout(t);
  }

  /**
   * Queue a transmission; resolves once it's been handled. Calls from a live
   * stream that has fallen behind (whisper down or slow) are dropped oldest
   * first — they're stale anyway; calls from a file wait their turn (the
   * folder source feeds them one at a time).
   */
  #enqueue(t) {
    this.state.heard++;
    return new Promise((resolve) => {
      this.queue.push({ t, resolve });
      const live = () => this.queue.filter((q) => !q.t.fromFile);
      while (live().length > MAX_QUEUE) {
        const drop = live()[0];
        this.queue.splice(this.queue.indexOf(drop), 1);
        drop.resolve(null);
        this.state.dropped++;
      }
      this.#work();
    });
  }

  async #work() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const { t, resolve } = this.queue.shift();
        resolve(await this.handle(t).catch(() => null));
      }
    } finally {
      this.working = false;
    }
  }

  /** Who could be talking: nearest first, so the recogniser's hints favour them. */
  #nearby() {
    try {
      return this.candidates() ?? [];
    } catch (err) {
      this.log.warn(`atc: ${err.message}`);
      return [];
    }
  }

  /**
   * Names to prime the recogniser with: the local facilities and the planes
   * nearby. Kept short: on static, Whisper tends to read the prompt back.
   */
  hintPrompt(aircraft) {
    const place = this.cfg.facility || 'the airport';
    return `${place} Tower, ${place} Ground. ${hintPhrases(aircraft).join(', ')}.`;
  }

  /** Transcribe one transmission and file it under its aircraft. */
  async handle({ pcm, at, label }, now = Date.now()) {
    const aircraft = this.#nearby();
    let text;
    try {
      text = await this.whisper.transcribe(pcm, this.hintPrompt(aircraft));
    } catch (err) {
      this.state.lastError = { message: err.message, at: Date.now() };
      this.log.warn(`atc: ${err.message}`);
      return null;
    }
    if (!text) return null;
    this.state.transcribed++;
    const record = this.ingest({ text, at, durationMs: (pcm.length / SAMPLE_RATE) * 1000, label, aircraft, now });
    record.file = `${Math.round(at)}-${crypto.randomBytes(3).toString('hex')}.wav`;
    await fs.writeFile(path.join(this.clipDir, record.file), wavFile(pcm));
    return record;
  }

  /** File a transcript (exported for tests: no audio needed). */
  ingest({ text, at, durationMs = 0, label = '', aircraft = this.#nearby(), now = Date.now() }) {
    const names = radioNames(aircraft);
    const tokens = tokenize(text, names);
    const normalized = normalize(text, names);
    const match = findCallsign(tokens, aircraft);
    const record = {
      id: crypto.randomUUID(),
      at,
      durationMs: Math.round(durationMs),
      label,
      text,
      hex: match?.hex ?? null,
      role: match ? speakerRole(tokens, match) : null,
      intents: intents(normalized),
      file: null,
    };
    this.transmissions.push(record);
    this.transmissions.sort((a, b) => a.at - b.at);
    if (record.hex) {
      this.state.attributed++;
      const rules = ruleSummary(this.#forAircraft(record.hex, now));
      const prev = this.summaries.get(record.hex);
      // A fresh line from Claude stands until the next one is ready; otherwise the rules fill the gap.
      if (rules && (!prev || prev.source !== 'claude' || now - prev.at > 30_000)) {
        this.summaries.set(record.hex, { text: rules, at: now, source: 'rules' });
      }
      this.#scheduleSummary(record.hex);
    }
    return record;
  }

  #forAircraft(hex, now = Date.now(), windowMs = SUMMARY_WINDOW_MS) {
    return this.transmissions.filter((t) => t.hex === hex && now - t.at <= windowMs);
  }

  #scheduleSummary(hex) {
    if (!this.cfg.summaries || !this.summarizer.available) return;
    clearTimeout(this.summaryTimers.get(hex));
    const timer = setTimeout(() => {
      this.summaryTimers.delete(hex);
      this.summarize(hex);
    }, SUMMARY_DELAY_MS);
    timer.unref?.();
    this.summaryTimers.set(hex, timer);
  }

  async summarize(hex, now = Date.now()) {
    const transmissions = this.#forAircraft(hex, now).slice(-8);
    if (!transmissions.length) return null;
    const aircraft = this.#nearby().find((a) => a.hex === hex);
    // Only for planes close enough to come up on a card: no paying for lines nobody sees.
    const cardKm = this.getConfig().display.cycleRangeKm * 1.5;
    if (aircraft?.distanceKm != null && aircraft.distanceKm > cardKm) return null;
    const text = await this.summarizer.summarize({ aircraft, transmissions, facility: this.cfg.facility, now });
    if (text) this.summaries.set(hex, { text, at: Date.now(), source: 'claude' });
    return text;
  }

  /**
   * What the display needs for one aircraft, or null if it hasn't been heard:
   * the conversation so far (`log`, everything kept), and the summary and
   * audio of the last few minutes (`summary`/`clips`; `recent` says if there
   * are any).
   */
  brief(hex, now = Date.now()) {
    const all = this.transmissions.filter((t) => t.hex === hex);
    if (!all.length) return null;
    const recentMs = this.cfg.recentMinutes * 60_000;
    const recent = all.filter((t) => now - t.at <= recentMs);
    return {
      recent: recent.length > 0,
      summary: recent.length ? (this.summaries.get(hex)?.text ?? null) : null,
      lastAt: all[all.length - 1].at,
      clips: recent
        .filter((t) => t.file)
        .slice(-MAX_CLIPS_ON_CARD)
        .map((t) => ({ id: t.id, url: `/atc/clips/${t.file}`, at: t.at, role: t.role })),
      log: all.slice(-MAX_LOG_ON_CARD).map((t) => ({ id: t.id, at: t.at, role: t.role, text: t.text })),
    };
  }

  /** Everything heard lately for one aircraft (the API and the admin page). */
  detail(hex, now = Date.now()) {
    return {
      summary: this.summaries.get(hex) ?? null,
      transmissions: this.#forAircraft(hex, now, this.cfg.keepMinutes * 60_000).map(publicRecord),
    };
  }

  recent(limit = 50) {
    return this.transmissions.slice(-limit).reverse().map(publicRecord);
  }

  /** Forget transmissions (and delete their audio) older than keepMinutes. */
  async prune(now = Date.now()) {
    const keepMs = this.cfg.keepMinutes * 60_000;
    const old = this.transmissions.filter((t) => now - t.at > keepMs);
    if (old.length) this.transmissions = this.transmissions.filter((t) => now - t.at <= keepMs);
    for (const t of old) if (t.file) await fs.rm(path.join(this.clipDir, t.file), { force: true });
    for (const [hex, s] of this.summaries) {
      if (!this.transmissions.some((t) => t.hex === hex)) this.summaries.delete(hex);
      else if (now - s.at > keepMs) this.summaries.delete(hex);
    }
    // Audio left behind by a restart.
    try {
      for (const name of await fs.readdir(this.clipDir)) {
        const at = Number.parseInt(name, 10);
        if (Number.isFinite(at) && now - at > keepMs) await fs.rm(path.join(this.clipDir, name), { force: true });
      }
    } catch {
      // No clips yet.
    }
  }

  clipPath(name) {
    return /^\d+-[0-9a-f]{6}\.wav$/.test(name) ? path.join(this.clipDir, name) : null;
  }

  status() {
    return {
      enabled: this.cfg.enabled,
      source: this.source?.status() ?? null,
      queue: this.queue.length,
      kept: this.transmissions.length,
      ...this.state,
      summaries: this.summarizer.status(),
    };
  }
}

const publicRecord = (t) => ({
  id: t.id,
  at: t.at,
  durationMs: t.durationMs,
  label: t.label,
  text: t.text,
  hex: t.hex,
  role: t.role,
  intents: t.intents,
  url: t.file ? `/atc/clips/${t.file}` : null,
});
