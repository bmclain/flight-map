// Speech to text with a whisper.cpp server (see whisper/Dockerfile).
import { wavFile } from './segmenter.js';

// What Whisper "hears" in static, hiss and keying clicks.
const NOISE = [
  /^\s*[[(].*[\])]\s*$/, // [BLANK_AUDIO], (static), (buzzing)
  /^\s*(thank you|thanks for watching|you|bye|okay|uh|um|hmm)[.!]?\s*$/i,
];

const wordsOf = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * Clean up a transcript; '' when it's only noise. Over static, Whisper also
 * repeats one word over and over ("Roar, Roar, Roar…") or reads back the
 * names it was primed with ("Saskatoon Tower, Saskatoon Ground, Saskatoon…"):
 * a transcript that's mostly that is dropped too.
 */
export function cleanTranscript(text, prompt = '') {
  const t = String(text ?? '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/^\s*>>\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || NOISE.some((re) => re.test(t))) return '';
  const words = wordsOf(t);
  // One word four or more times in a row.
  let run = 1;
  for (let i = 1; i < words.length; i++) {
    run = words[i] === words[i - 1] ? run + 1 : 1;
    if (run >= 4) return '';
  }
  // Mostly the priming names.
  const primed = new Set(wordsOf(prompt));
  if (primed.size && words.length >= 3) {
    const own = words.filter((w) => !primed.has(w));
    if (own.length / words.length < 0.3) return '';
  }
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
    return cleanTranscript(json.text, prompt);
  }
}
