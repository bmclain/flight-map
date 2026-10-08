// Splits continuous radio audio into separate transmissions. Airband receivers
// (rtl_airband, LiveATC's feeds) are squelched: when nobody's transmitting the
// audio is digital silence, while a pause in someone's speech still carries
// radio hiss. So a fifth of a second of true silence ends a call, even when
// the answer comes straight after. For audio that isn't squelched we also
// follow the background level and cut after a longer quiet spell.

export const SAMPLE_RATE = 16_000;
const FRAME = 320; // 20 ms

/**
 * @param {object} opts
 * @param {(seg: {pcm: Int16Array, startSample: number}) => void} opts.onSegment
 * @param {number} [opts.startDb]  how far above the background a call must rise
 * @param {number} [opts.hangMs]   quiet time (above the background, unsquelched audio) that ends a call
 * @param {number} [opts.squelchDb]     below this is the squelch closed: nobody transmitting
 * @param {number} [opts.squelchGapMs]  that long with the squelch closed ends a call
 * @param {number} [opts.minMs]    calls with less sound than this are dropped (clicks, blips)
 * @param {number} [opts.maxMs]    longer calls are cut into pieces
 */
export class Segmenter {
  constructor({
    onSegment,
    startDb = 10,
    endDb = 6,
    hangMs = 900,
    squelchDb = -70,
    squelchGapMs = 200,
    minMs = 400,
    // Whisper is run with a 15 s window (--audio-ctx 768): longer calls are cut.
    maxMs = 15_000,
    preRollMs = 200,
  }) {
    this.onSegment = onSegment;
    this.startDb = startDb;
    this.endDb = endDb;
    this.hangFrames = Math.round(hangMs / 20);
    this.squelchDb = squelchDb;
    this.squelchFrames = Math.round(squelchGapMs / 20);
    this.minLoudFrames = Math.round(minMs / 20);
    this.maxSamples = (maxMs / 1000) * SAMPLE_RATE;
    this.preRollFrames = Math.round(preRollMs / 20);
    this.floorDb = -60;
    this.carry = new Int16Array(0);
    this.preRoll = []; // recent quiet frames, so the first syllable isn't clipped
    this.active = null; // { frames: Int16Array[], startSample, quiet }
    this.samples = 0; // position of the next frame in the whole stream
  }

  /** Feed signed 16-bit mono samples at 16 kHz. */
  push(samples) {
    let buf = samples;
    if (this.carry.length) {
      buf = new Int16Array(this.carry.length + samples.length);
      buf.set(this.carry);
      buf.set(samples, this.carry.length);
    }
    let i = 0;
    for (; i + FRAME <= buf.length; i += FRAME) this.#frame(buf.subarray(i, i + FRAME));
    this.carry = buf.slice(i);
  }

  /** End of input: finish any call in progress. */
  flush() {
    if (this.active) this.#close();
  }

  #frame(frame) {
    let sum = 0;
    for (let k = 0; k < frame.length; k++) sum += frame[k] * frame[k];
    const rms = Math.sqrt(sum / frame.length) / 32768;
    const db = 20 * Math.log10(rms + 1e-9);
    const copy = frame.slice();
    const pos = this.samples;
    this.samples += frame.length;

    if (!this.active) {
      if (db > Math.max(this.floorDb + this.startDb, -50)) {
        const pre = this.preRoll;
        this.active = { frames: [...pre, copy], startSample: pos - pre.length * FRAME, quiet: 0, silent: 0, loud: 1 };
        this.preRoll = [];
        return;
      }
      // Background level: falls straight away, rises slowly (≈ 3 dB a second).
      this.floorDb = db < this.floorDb ? db : this.floorDb + 0.06;
      this.preRoll.push(copy);
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      return;
    }
    const a = this.active;
    a.frames.push(copy);
    const quiet = db < this.floorDb + this.endDb;
    a.quiet = quiet ? a.quiet + 1 : 0;
    a.silent = db < this.squelchDb ? a.silent + 1 : 0;
    if (!quiet) a.loud++;
    if (a.silent >= this.squelchFrames) this.#close(a.silent);
    else if (a.quiet >= this.hangFrames) this.#close(a.quiet);
    else if (a.frames.length * FRAME >= this.maxSamples) this.#close();
  }

  #close(trailingQuiet = 0) {
    const a = this.active;
    this.active = null;
    // Keep a little of the quiet tail, not all of it.
    const keep = a.frames.length - Math.max(0, trailingQuiet - 10);
    const frames = a.frames.slice(0, keep);
    if (a.loud < this.minLoudFrames) return;
    const n = frames.length * FRAME;
    const pcm = new Int16Array(n);
    frames.forEach((f, k) => pcm.set(f, k * FRAME));
    this.onSegment({ pcm, startSample: a.startSample });
  }
}

/** A 16 kHz mono 16-bit WAV file for these samples. */
export function wavFile(pcm) {
  const header = Buffer.alloc(44);
  const dataBytes = pcm.length * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes)]);
}
