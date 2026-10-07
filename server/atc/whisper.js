// Speech to text with a whisper.cpp server (see whisper/Dockerfile).
import { wavFile } from './segmenter.js';

// What Whisper "hears" in static, hiss and keying clicks.
const NOISE = [
  /^\s*[[(].*[\])]\s*$/, // [BLANK_AUDIO], (static), (buzzing)
  /^\s*(thank you|thanks for watching|you|bye|okay|uh|um|hmm)[.!]?\s*$/i,
];

/** Clean up a transcript; '' when it's only noise. */
export function cleanTranscript(text) {
  const t = String(text ?? '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || NOISE.some((re) => re.test(t))) return '';
  return t;
}

export class WhisperClient {
  constructor({ url, fetchImpl = fetch, timeoutMs = 60_000 }) {
    this.url = url.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {Int16Array} pcm  16 kHz mono
   * @param {string} prompt   names to listen out for ("Saskatoon Tower. WestJet 347, …")
   */
  async transcribe(pcm, prompt = '') {
    const form = new FormData();
    form.append('file', new Blob([wavFile(pcm)], { type: 'audio/wav' }), 'call.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (prompt) form.append('prompt', prompt);
    const res = await this.fetch(`${this.url}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`whisper: HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`whisper: ${json.error}`);
    return cleanTranscript(json.text);
  }
}
