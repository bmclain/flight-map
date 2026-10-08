// Where radio audio comes from. Both kinds end up as separate transmissions
// (16 kHz mono samples plus the time each started):
//
//   FolderSource — audio files dropped into a folder: one file per call (what
//                  an SDR running rtl_airband with split_on_transmission writes),
//                  or longer recordings, which are split into calls.
//   StreamSource — a live audio stream (Icecast / HTTP MP3), e.g. rtl_airband's
//                  Icecast output, split into calls as it plays.
//
// Decoding is done by ffmpeg, which must be installed (it is in the Docker image).
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SAMPLE_RATE, Segmenter } from './segmenter.js';

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|opus|flac)$/i;
const msOf = (samples) => (samples / SAMPLE_RATE) * 1000;

/** Run ffmpeg to decode `input` (file path or URL) to 16 kHz mono s16le on stdout. */
export function decode(input, { live = false, ffmpeg = 'ffmpeg' } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (live) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '30');
  args.push('-i', input, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1');
  return spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Feed a child process's stdout to a segmenter, two bytes per sample. */
function pipeSamples(child, segmenter) {
  let odd = null;
  child.stdout.on('data', (chunk) => {
    let buf = chunk;
    if (odd) {
      buf = Buffer.concat([odd, chunk]);
      odd = null;
    }
    if (buf.length % 2) {
      odd = buf.subarray(buf.length - 1);
      buf = buf.subarray(0, buf.length - 1);
    }
    // Copy into an aligned buffer: Int16Array needs an even byte offset.
    const aligned = new Int16Array(buf.length / 2);
    Buffer.from(aligned.buffer).set(buf);
    segmenter.push(aligned);
  });
}

function stderrTail(child) {
  let tail = '';
  child.stderr.on('data', (d) => {
    tail = (tail + d).slice(-500);
  });
  return () => tail.trim().split('\n').pop() ?? '';
}

export class FolderSource {
  /**
   * @param {object} opts
   * @param {string} opts.dir
   * @param {(t: {pcm: Int16Array, at: number, label: string}) => void} opts.onTransmission
   */
  constructor({ dir, onTransmission, log = console, pollMs = 2000, ffmpeg = 'ffmpeg' }) {
    this.dir = dir;
    this.doneDir = path.join(dir, 'done');
    this.onTransmission = onTransmission;
    this.log = log;
    this.pollMs = pollMs;
    this.ffmpeg = ffmpeg;
    this.sizes = new Map(); // file → size at the last look, to wait until it's fully written
    this.busy = false;
    this.state = { type: 'folder', dir, files: 0, lastError: null, lastAt: null };
  }

  start() {
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref?.();
    this.poll();
  }

  stop() {
    clearInterval(this.timer);
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      await fs.mkdir(this.doneDir, { recursive: true });
      const names = (await fs.readdir(this.dir)).filter((n) => AUDIO_EXT.test(n)).sort();
      for (const name of names) {
        const file = path.join(this.dir, name);
        const st = await fs.stat(file).catch(() => null);
        if (!st?.isFile()) continue;
        // Still being written (or copied in)? Look again next time.
        if (this.sizes.get(name) !== st.size || Date.now() - st.mtimeMs < 1000) {
          this.sizes.set(name, st.size);
          continue;
        }
        this.sizes.delete(name);
        await this.#process(file, st.mtimeMs);
        await fs.rename(file, path.join(this.doneDir, name)).catch(() => fs.rm(file, { force: true }));
      }
    } catch (err) {
      this.#error(err);
    } finally {
      this.busy = false;
    }
  }

  async #process(file, mtimeMs) {
    const found = [];
    const seg = new Segmenter({ onSegment: (s) => found.push(s) });
    const child = decode(file, { ffmpeg: this.ffmpeg });
    const lastError = stderrTail(child);
    pipeSamples(child, seg);
    const code = await new Promise((resolve) => {
      child.on('close', resolve);
      child.on('error', (err) => {
        this.#error(err);
        resolve(-1);
      });
    });
    seg.flush();
    if (code !== 0) return this.#error(new Error(`ffmpeg couldn't read ${path.basename(file)}: ${lastError()}`));
    // The file was finished when it was last written: count back from then.
    const startedAt = mtimeMs - msOf(seg.samples);
    this.state.files++;
    this.state.lastAt = Date.now();
    const label = path.basename(file).replace(AUDIO_EXT, '');
    // One at a time: a long recording can hold hundreds of calls.
    for (const s of found)
      await this.onTransmission({ pcm: s.pcm, at: startedAt + msOf(s.startSample), label, fromFile: true });
  }

  #error(err) {
    this.state.lastError = { message: err.message, at: Date.now() };
    this.log.warn(`atc folder: ${err.message}`);
  }

  status() {
    return { ...this.state };
  }
}

export class StreamSource {
  constructor({ url, onTransmission, log = console, ffmpeg = 'ffmpeg', label = 'stream' }) {
    this.url = url;
    this.onTransmission = onTransmission;
    this.log = log;
    this.ffmpeg = ffmpeg;
    this.label = label;
    this.retryMs = 5000;
    this.state = { type: 'stream', url, connected: false, lastError: null, lastAt: null, transmissions: 0 };
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.child?.kill('SIGTERM');
  }

  #connect() {
    const startedAt = Date.now();
    const seg = new Segmenter({
      onSegment: (s) => {
        this.state.transmissions++;
        this.state.lastAt = Date.now();
        this.onTransmission({ pcm: s.pcm, at: startedAt + msOf(s.startSample), label: this.label });
      },
    });
    const child = decode(this.url, { live: true, ffmpeg: this.ffmpeg });
    this.child = child;
    const lastError = stderrTail(child);
    child.stdout.once('data', () => {
      this.state.connected = true;
      this.retryMs = 5000;
    });
    pipeSamples(child, seg);
    let ended = false;
    const retry = (why) => {
      if (ended) return; // 'error' and 'close' can both fire
      ended = true;
      this.state.connected = false;
      if (this.stopped) return;
      this.state.lastError = { message: why, at: Date.now() };
      this.log.warn(`atc stream: ${why}; retrying in ${Math.round(this.retryMs / 1000)} s`);
      this.retryTimer = setTimeout(() => this.#connect(), this.retryMs);
      this.retryTimer.unref?.();
      this.retryMs = Math.min(this.retryMs * 2, 5 * 60_000);
    };
    child.on('error', (err) => retry(err.message));
    child.on('close', (code) => {
      seg.flush();
      if (!this.stopped) retry(`stream ended (${lastError() || `ffmpeg exit ${code}`})`);
    });
  }

  status() {
    return { ...this.state };
  }
}
